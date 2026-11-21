import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  classifyResponse,
  collectUsage,
  evaluatePolicies,
  githubEmitter,
  liveCheck,
  liveLimits,
  main,
  resolveLocals,
  policyScopes,
  requiredGroups,
  staticCheck,
  stripComments
} from './check-terraform-permissions.mjs';

const ACCOUNT = 'a'.repeat(32);
const ZONE = 'b'.repeat(32);
const TOKEN_ID = 'c'.repeat(32);
const SECRET_VALUE = 'cf-secret-token-value-123';
const locals = { accountId: ACCOUNT, zoneId: ZONE, zoneName: 'example.com' };
const ACCOUNT_RESOURCES = { [`com.cloudflare.api.account.${ACCOUNT}`]: '*' };
const ZONE_RESOURCES = { [`com.cloudflare.api.account.zone.${ZONE}`]: '*' };

const manifest = {
  credential: { githubSecret: 'CLOUDFLARE_API_TOKEN' },
  dashboardLabels: { 'Dynamic URL Redirects Write': 'Single Redirect: Edit' },
  resources: {
    cloudflare_dns_record: { permissions: [{ scope: 'zone', group: 'DNS Write' }] },
    cloudflare_pages_project: { permissions: [{ scope: 'account', group: 'Pages Write' }] },
    cloudflare_ruleset: {
      phases: { http_request_dynamic_redirect: { permissions: [{ scope: 'zone', group: 'Dynamic URL Redirects Write' }] } }
    }
  },
  dataSources: {
    cloudflare_account_api_token_permission_groups_list: {
      permissions: [{ scope: 'account', group: 'Account API Tokens Read', anyOf: ['Account API Tokens Write'] }]
    }
  }
};

const terraform = `
resource "cloudflare_dns_record" "site" {
  zone_id = local.zone
}
resource "cloudflare_pages_project" "site" {}
resource "cloudflare_ruleset" "www_redirect" {
  phase = "http_request_dynamic_redirect"
  rules = [{ expression = "concat(\\"https://example.com\\", http.request.uri.path)" }]
}
data "cloudflare_account_api_token_permission_groups_list" "all" {}
`;

const usage = collectUsage([{ file: 'terraform/main.tf', text: terraform }]);
const requirements = requiredGroups(manifest, usage);

const groups = [
  { id: 'g-dns', name: 'DNS Write', scopes: ['com.cloudflare.api.account.zone'] },
  { id: 'g-redirect', name: 'Dynamic URL Redirects Write', scopes: ['com.cloudflare.api.account.zone'] },
  { id: 'g-pages', name: 'Pages Write', scopes: ['com.cloudflare.api.account'] },
  { id: 'g-tokens-write', name: 'Account API Tokens Write', scopes: ['com.cloudflare.api.account'] }
];

const allowAll = [
  { id: 'p1', effect: 'allow', permission_groups: [{ id: 'g-pages' }, { id: 'g-tokens-write' }], resources: ACCOUNT_RESOURCES },
  { id: 'p2', effect: 'allow', permission_groups: [{ id: 'g-dns' }, { id: 'g-redirect' }], resources: ZONE_RESOURCES }
];

const ok = (result) => ({ curlExit: 0, status: 200, body: JSON.stringify({ success: true, errors: [], result }) });
const error = (status, code, message) => ({ curlExit: 0, status, body: JSON.stringify({ success: false, errors: [{ code, message }], result: null }) });

function stub(routes) {
  const calls = [];
  const request = async (path) => {
    calls.push(path);
    if (!Object.hasOwn(routes, path)) throw new Error(`Unexpected request ${path}`);
    return routes[path];
  };
  return { request, calls };
}

const accountRoutes = (overrides = {}) => ({
  [`/accounts/${ACCOUNT}/tokens/verify`]: ok({ id: TOKEN_ID, status: 'active' }),
  [`/accounts/${ACCOUNT}/tokens/${TOKEN_ID}`]: ok({ id: TOKEN_ID, status: 'active', policies: allowAll }),
  [`/accounts/${ACCOUNT}/tokens/permission_groups`]: ok(groups),
  ...overrides
});

async function run(routes) {
  const lines = [];
  const emit = githubEmitter(SECRET_VALUE, (line) => lines.push(line));
  const { request, calls } = stub(routes);
  const outcome = await liveCheck({ request, manifest, locals, requirements, emit });
  for (const line of lines) assert.ok(!line.includes(SECRET_VALUE), 'token leaked into output');
  return { outcome, output: lines.join('\n'), calls };
}

describe('static check', () => {
  it('finds resource, data source, and ruleset phase types', () => {
    assert.deepEqual([...usage.resources.keys()].sort(), ['cloudflare_dns_record', 'cloudflare_pages_project', 'cloudflare_ruleset']);
    assert.deepEqual([...usage.dataSources.keys()], ['cloudflare_account_api_token_permission_groups_list']);
    assert.deepEqual([...usage.phases.keys()], ['http_request_dynamic_redirect']);
    assert.deepEqual(staticCheck(manifest, usage), []);
  });

  it('ignores commented resources but keeps // inside strings', () => {
    const text = '# resource "cloudflare_queue" "x" {}\n/* data "cloudflare_zone" "z" {} */\nlocals { url = "https://x" }';
    const found = collectUsage([{ file: 'a.tf', text }]);
    assert.equal(found.resources.size + found.dataSources.size, 0);
    assert.match(stripComments(text), /"https:\/\/x"/);
  });

  it('fails when a used type is missing from the manifest', () => {
    const extra = collectUsage([{ file: 'terraform/q.tf', text: `${terraform}\nresource "cloudflare_queue" "q" {}` }]);
    const errors = staticCheck(manifest, extra);
    assert.equal(errors.length, 1);
    assert.match(errors[0].message, /cloudflare_queue is not in/);
    assert.equal(errors[0].file, 'terraform/q.tf');
  });

  it('fails when the manifest lists an unused type or phase', () => {
    const fewer = collectUsage([{ file: 'a.tf', text: 'resource "cloudflare_dns_record" "x" {}\nresource "cloudflare_pages_project" "p" {}\ndata "cloudflare_account_api_token_permission_groups_list" "all" {}' }]);
    const messages = staticCheck(manifest, fewer).map((e) => e.message).join('\n');
    assert.match(messages, /Resource cloudflare_ruleset is listed in resources but no longer used/);
    assert.match(messages, /phase http_request_dynamic_redirect is listed but no longer used/);
  });

  it('fails on an unmapped or non-literal ruleset phase', () => {
    const other = collectUsage([{ file: 'a.tf', text: `${terraform}\nresource "cloudflare_ruleset" "waf" {\n  phase = "http_request_firewall_custom"\n}\nresource "cloudflare_ruleset" "dyn" {\n  phase = var.phase\n}` }]);
    const messages = staticCheck(manifest, other).map((e) => e.message).join('\n');
    assert.match(messages, /phase http_request_firewall_custom is not in/);
    assert.match(messages, /needs a literal phase/);
  });

  it('fails closed on unquoted labels, ephemeral blocks, and Terraform JSON', () => {
    const found = collectUsage([
      { file: 'a.tf', text: 'resource cloudflare_dns_record a {\n}\nephemeral "cloudflare_x" "e" {}\nresource "github_actions_secret" "cloudflare_deploy" {}' },
      { file: 'b.tf.json', text: '{}' }
    ]);
    assert.equal(found.resources.get('cloudflare_dns_record')?.has('a.tf'), true);
    const messages = found.errors.map((e) => e.message).join('\n');
    assert.match(messages, /Unrecognized Cloudflare block "ephemeral/);
    assert.match(messages, /Terraform JSON files are not parsed/);
    assert.doesNotMatch(messages, /github_actions_secret/);
  });

  it('fails when the Cloudflare provider uses another local name', () => {
    const found = collectUsage([{ file: 'v.tf', text: 'terraform {\n  required_providers {\n    cf = { source = "cloudflare/cloudflare", version = "~> 5.0" }\n  }\n}\nresource "cf_dns_record" "a" {}\n' }]);
    assert.match(found.errors.map((e) => e.message).join('\n'), /local name "cloudflare" \(found "cf"\)/);
    const ok = collectUsage([{ file: 'v.tf', text: 'terraform {\n  required_providers {\n    cloudflare = { source = "cloudflare/cloudflare" }\n  }\n}\n' }]);
    assert.deepEqual(ok.errors, []);
  });

  it('does not let heredoc content hide later resources', () => {
    const text = 'locals {\n  script = <<-EOT\n    rm -rf /tmp/* "\n  EOT\n}\nresource "cloudflare_queue" "q" {}\n';
    const found = collectUsage([{ file: 'a.tf', text }]);
    assert.deepEqual(found.errors, []);
    assert.equal(found.resources.has('cloudflare_queue'), true);
  });

  it('refuses to pass on unterminated comments or heredocs', () => {
    const found = collectUsage([{ file: 'a.tf', text: '/* open\nresource "cloudflare_queue" "q" {}\n' }, { file: 'b.tf', text: 'x = <<EOT\nnever closed\n' }]);
    assert.equal(found.errors.length, 2);
  });

  it('fails on a manifest entry without permissions', () => {
    const broken = { ...manifest, resources: { ...manifest.resources, cloudflare_dns_record: { permissions: [] } } };
    assert.match(staticCheck(broken, usage).map((e) => e.message).join('\n'), /cloudflare_dns_record needs a non-empty permissions list/);
  });
});

describe('live check', () => {
  it('passes when every group is granted', async () => {
    const { outcome, output } = await run(accountRoutes());
    assert.equal(outcome.ok, true);
    assert.equal(output, '');
    assert.equal(outcome.results.find((r) => r.group === 'Account API Tokens Read').grantedBy, 'Account API Tokens Write');
  });

  it('names Dynamic URL Redirects Write when the ruleset permission is missing', async () => {
    const policies = [allowAll[0], { ...allowAll[1], permission_groups: [{ id: 'g-dns' }] }];
    const { outcome, output } = await run(accountRoutes({ [`/accounts/${ACCOUNT}/tokens/${TOKEN_ID}`]: ok({ id: TOKEN_ID, status: 'active', policies }) }));
    assert.equal(outcome.ok, false);
    const errors = output.split('\n');
    assert.equal(errors.length, 1);
    assert.match(errors[0], /^::error::CLOUDFLARE_API_TOKEN is missing "Dynamic URL Redirects Write" \(dashboard: Single Redirect: Edit\) on zone example\.com \(b{32}\), needed by cloudflare_ruleset \(phase http_request_dynamic_redirect\)\. Add it to the token in Cloudflare dashboard > Manage Account > Account API Tokens/);
  });

  it('asks for the read permission when the token cannot read its own policies', async () => {
    const { outcome, output } = await run(accountRoutes({ [`/accounts/${ACCOUNT}/tokens/${TOKEN_ID}`]: error(403, 9109, 'Unauthorized to access requested resource') }));
    assert.equal(outcome.ok, false);
    assert.match(output, /cannot read its own policies .* Add Account API Tokens Read \(account scope\)/);
    assert.doesNotMatch(output, /roll it/);
  });

  it('asks for the read permission when permission groups cannot be listed', async () => {
    const { outcome, output } = await run(accountRoutes({ [`/accounts/${ACCOUNT}/tokens/permission_groups`]: error(403, 10000, 'Authentication error') }));
    assert.equal(outcome.ok, false);
    assert.match(output, /cannot read its own policies/);
  });

  it('fails on an inactive token', async () => {
    const { outcome, output } = await run(accountRoutes({ [`/accounts/${ACCOUNT}/tokens/verify`]: ok({ id: TOKEN_ID, status: 'disabled' }) }));
    assert.equal(outcome.ok, false);
    assert.match(output, /CLOUDFLARE_API_TOKEN is disabled/);
  });

  for (const [name, response, detail] of [
    ['a curl failure', { curlExit: 28, status: 0, body: '' }, 'HTTP none / curl 28'],
    ['HTTP 429', error(429, 971, 'Please wait and consider throttling your request speed'), 'HTTP 429 / curl 0'],
    ['HTTP 500', { curlExit: 0, status: 500, body: '<html>oops</html>' }, 'HTTP 500 / curl 0'],
    ['HTTP 503', error(503, 1, 'Service unavailable'), 'HTTP 503 / curl 0'],
    ['an unexpected 200 body', { curlExit: 0, status: 200, body: 'not json' }, 'HTTP 200 / curl 0']
  ]) {
    it(`does not judge the token on ${name}`, async () => {
      const { outcome, output, calls } = await run(accountRoutes({ [`/accounts/${ACCOUNT}/tokens/verify`]: response }));
      assert.equal(outcome.ok, false);
      assert.match(output, new RegExp(`Cloudflare API unavailable .*\\(${detail.replace(/[()/]/g, '\\$&')}.*token not judged`));
      assert.doesNotMatch(output, /roll it/);
      assert.equal(calls.length, 1);
    });
  }

  it('does not judge the token when the API fails mid-check', async () => {
    const { outcome, output } = await run(accountRoutes({ [`/accounts/${ACCOUNT}/tokens/permission_groups`]: { curlExit: 0, status: 502, body: '' } }));
    assert.equal(outcome.ok, false);
    assert.match(output, /Cloudflare API unavailable while listing permission groups \(HTTP 502/);
  });

  it('tells the owner to roll a token refused with 401', async () => {
    const { outcome, output, calls } = await run({
      [`/accounts/${ACCOUNT}/tokens/verify`]: error(401, 1000, 'Invalid API Token'),
      '/user/tokens/verify': error(401, 1000, 'Invalid API Token')
    });
    assert.equal(outcome.ok, false);
    assert.match(output, /Cloudflare refused CLOUDFLARE_API_TOKEN \(HTTP 401 .*roll it/);
    assert.deepEqual(calls, [`/accounts/${ACCOUNT}/tokens/verify`, '/user/tokens/verify']);
  });

  it('reports a malformed secret value without asking for a re-run', async () => {
    const malformed = { curlExit: 0, status: 400, body: JSON.stringify({ success: false, errors: [{ code: 6003, message: 'Invalid request headers', error_chain: [{ code: 6111, message: 'Invalid format for Authorization header' }] }] }) };
    const { outcome, output, calls } = await run({ [`/accounts/${ACCOUNT}/tokens/verify`]: malformed });
    assert.equal(outcome.ok, false);
    assert.match(output, /rejected the format of CLOUDFLARE_API_TOKEN/);
    assert.doesNotMatch(output, /unavailable/);
    assert.equal(calls.length, 1);
  });

  it('keeps the 404 advice when the account verify is not found and the user verify is refused', async () => {
    const { outcome, output } = await run({
      [`/accounts/${ACCOUNT}/tokens/verify`]: error(404, 7003, 'Could not route'),
      '/user/tokens/verify': error(401, 1000, 'Invalid API Token')
    });
    assert.equal(outcome.ok, false);
    assert.match(output, /returned 404 while verifying the token as an account token/);
    assert.doesNotMatch(output, /roll it/);
  });

  it('gives a persistent 404 its own message instead of re-run advice', async () => {
    const { outcome, output } = await run(accountRoutes({ [`/accounts/${ACCOUNT}/tokens/permission_groups`]: error(404, 7003, 'Could not route') }));
    assert.equal(outcome.ok, false);
    assert.match(output, /returned 404 while listing permission groups.*A re-run will not fix this/);
  });

  it('warns that an IP filter must also allow Terraform Cloud', async () => {
    const { outcome, output } = await run(accountRoutes({ [`/accounts/${ACCOUNT}/tokens/${TOKEN_ID}`]: ok({ id: TOKEN_ID, status: 'active', policies: allowAll, condition: { request_ip: { in: ['203.0.113.0/24'] } } }) }));
    assert.equal(outcome.ok, true);
    assert.match(output, /^::warning::.*client IP address filter.*Terraform Cloud/);
  });

  it('gives an IP restriction its own message', async () => {
    const { outcome, output, calls } = await run({
      [`/accounts/${ACCOUNT}/tokens/verify`]: error(403, 9109, 'Cannot use the access token from location: 203.0.113.9')
    });
    assert.equal(outcome.ok, false);
    assert.match(output, /client IP address filter/);
    assert.doesNotMatch(output, /roll it/);
    assert.equal(calls.length, 1);
  });

  it('falls back to a user token', async () => {
    const userGroups = groups.map((g) => ({ ...g }));
    const { outcome, calls } = await run({
      [`/accounts/${ACCOUNT}/tokens/verify`]: error(401, 1000, 'Invalid API Token'),
      '/user/tokens/verify': ok({ id: TOKEN_ID, status: 'active' }),
      [`/user/tokens/${TOKEN_ID}`]: ok({ id: TOKEN_ID, status: 'active', policies: allowAll }),
      '/user/tokens/permission_groups': ok(userGroups)
    });
    assert.equal(outcome.ok, true);
    assert.equal(outcome.kind, 'user');
    assert.deepEqual(calls.slice(1), ['/user/tokens/verify', `/user/tokens/${TOKEN_ID}`, '/user/tokens/permission_groups']);
  });

  it('treats an account-wide deny as covering zones too', async () => {
    const policies = [...allowAll, { id: 'd', effect: 'deny', permission_groups: [{ id: 'g-redirect' }], resources: ACCOUNT_RESOURCES }];
    const { outcome, output } = await run(accountRoutes({ [`/accounts/${ACCOUNT}/tokens/${TOKEN_ID}`]: ok({ id: TOKEN_ID, status: 'active', policies }) }));
    assert.equal(outcome.ok, false);
    assert.match(output, /missing "Dynamic URL Redirects Write"/);
    assert.equal(outcome.results.filter((r) => !r.ok).length, 1);
  });

  it('treats a deny with unparseable resources as denying every scope', async () => {
    const policies = [...allowAll, { id: 'd', effect: 'deny', permission_groups: [{ id: 'g-pages' }, { id: 'g-dns' }], resources: 'not json' }];
    const { outcome } = await run(accountRoutes({ [`/accounts/${ACCOUNT}/tokens/${TOKEN_ID}`]: ok({ id: TOKEN_ID, status: 'active', policies }) }));
    assert.equal(outcome.ok, false);
    assert.deepEqual(outcome.results.filter((r) => !r.ok).map((r) => r.group).sort(), ['DNS Write', 'Pages Write']);
  });

  it('treats a deny with an unknown group as denying everything it covers', async () => {
    const policies = [...allowAll, { id: 'd', effect: 'deny', permission_groups: [{ id: 'g-unknown' }], resources: ZONE_RESOURCES }];
    const { outcome } = await run(accountRoutes({ [`/accounts/${ACCOUNT}/tokens/${TOKEN_ID}`]: ok({ id: TOKEN_ID, status: 'active', policies }) }));
    assert.deepEqual(outcome.results.filter((r) => !r.ok).map((r) => r.group).sort(), ['DNS Write', 'Dynamic URL Redirects Write']);
  });

  it('ignores a deny on another zone', async () => {
    const policies = [...allowAll, { id: 'd', effect: 'deny', permission_groups: [{ id: 'g-dns' }], resources: { [`com.cloudflare.api.account.zone.${'d'.repeat(32)}`]: '*' } }];
    const { outcome } = await run(accountRoutes({ [`/accounts/${ACCOUNT}/tokens/${TOKEN_ID}`]: ok({ id: TOKEN_ID, status: 'active', policies }) }));
    assert.equal(outcome.ok, true);
  });

  it('refuses to pass with no requirements', async () => {
    const lines = [];
    const outcome = await liveCheck({ request: stub({}).request, manifest, locals, requirements: [], emit: githubEmitter('', (l) => lines.push(l)) });
    assert.equal(outcome.ok, false);
  });

  it('redacts the token from emitted errors', () => {
    const lines = [];
    githubEmitter(SECRET_VALUE, (l) => lines.push(l)).error(`boom ${SECRET_VALUE}`);
    assert.equal(lines[0], '::error::boom ***');
  });
});

describe('policy evaluation', () => {
  it('does not grant from an allow with unparseable resources', () => {
    const results = evaluatePolicies({ policies: [{ effect: 'allow', permission_groups: [{ id: 'g-pages' }], resources: { weird: 1 } }], groups, requirements, locals });
    assert.ok(results.every((r) => !r.ok));
  });

  it('does not grant a zone group from an account-level allow or another account', () => {
    const policies = [
      { effect: 'allow', permission_groups: [{ id: 'g-dns' }], resources: ACCOUNT_RESOURCES },
      { effect: 'allow', permission_groups: [{ id: 'g-dns' }], resources: { [`com.cloudflare.api.account.${'e'.repeat(32)}`]: { 'com.cloudflare.api.account.zone.*': '*' } } }
    ];
    const results = evaluatePolicies({ policies, groups, requirements, locals });
    assert.equal(results.find((r) => r.group === 'DNS Write').ok, false);
  });

  it('grants a zone group nested under the account', () => {
    const policies = [{ effect: 'allow', permission_groups: [{ id: 'g-dns' }], resources: JSON.stringify({ [`com.cloudflare.api.account.${ACCOUNT}`]: { 'com.cloudflare.api.account.zone.*': '*' } }) }];
    const results = evaluatePolicies({ policies, groups, requirements, locals });
    assert.equal(results.find((r) => r.group === 'DNS Write').ok, true);
  });

  it('does not match a group name granted in the wrong scope', () => {
    const accountDns = [{ id: 'g-dns-account', name: 'DNS Write', scopes: ['com.cloudflare.api.account'] }];
    const policies = [{ effect: 'allow', permission_groups: [{ id: 'g-dns-account' }], resources: ZONE_RESOURCES }];
    const results = evaluatePolicies({ policies, groups: accountDns, requirements, locals });
    assert.equal(results.find((r) => r.group === 'DNS Write').ok, false);
  });

  it('reads policy scopes', () => {
    assert.deepEqual(policyScopes(ACCOUNT_RESOURCES, locals), { account: true, zone: false, accountWide: true, unparsed: false });
    assert.equal(policyScopes('[]', locals).unparsed, true);
    assert.equal(policyScopes({ [`com.cloudflare.api.account.${ACCOUNT}`]: { other: '*' } }, locals).unparsed, true);
  });
});

describe('response classification', () => {
  it('keeps curl exit codes apart from HTTP status', () => {
    assert.equal(classifyResponse({ curlExit: 7, status: 403, body: '' }).kind, 'unavailable');
    assert.equal(classifyResponse({ curlExit: 0, status: 403, body: '' }).kind, 'refused');
    assert.equal(classifyResponse({ curlExit: 0, status: 400, body: JSON.stringify({ success: false, errors: [{ code: 10000 }] }) }).kind, 'refused');
    assert.equal(classifyResponse({ curlExit: 0, status: 429, body: JSON.stringify({ success: false, errors: [{ code: 10000 }] }) }).kind, 'unavailable');
    assert.equal(classifyResponse({ curlExit: 0, status: 200, body: JSON.stringify({ success: false, errors: [] }) }).kind, 'unavailable');
  });
});

describe('reuse across repositories', () => {
  const tfLocals = `locals {\n  cloudflare_account_id = "${ACCOUNT}"\n  cloudflare_zone_id = "${ZONE}"\n  domain = "example.com"\n}\n`;
  const fullManifest = { ...manifest, scopes: { account: { idLocal: 'cloudflare_account_id' }, zone: { idLocal: 'cloudflare_zone_id', nameLocal: 'domain' } } };

  function workspace(files) {
    const dir = mkdtempSync(join(tmpdir(), 'tf-permissions-test-'));
    for (const [name, text] of Object.entries(files)) {
      mkdirSync(join(dir, name, '..'), { recursive: true });
      writeFileSync(join(dir, name), text);
    }
    return dir;
  }

  async function runMain(dir, manifestName) {
    const lines = [];
    const original = console.log;
    console.log = (line) => lines.push(String(line));
    try {
      const code = await main([], { TERRAFORM_PERMISSIONS_MANIFEST: join(dir, manifestName), TERRAFORM_DIRECTORY: join(dir, 'infra') });
      return { code, output: lines.join('\n') };
    } finally {
      console.log = original;
    }
  }

  it('runs the static check with a custom manifest path and Terraform directory', async () => {
    const dir = workspace({ 'infra/main.tf': `${tfLocals}${terraform}`, 'perm.json': JSON.stringify(fullManifest) });
    try {
      const { code, output } = await runMain(dir, 'perm.json');
      assert.equal(code, 0);
      assert.match(output, /Static check passed: 3 resource and 1 data source types/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('points static errors at the custom manifest path', async () => {
    const dir = workspace({ 'infra/main.tf': `${tfLocals}${terraform}\nresource "cloudflare_queue" "q" {}`, 'perm.json': JSON.stringify(fullManifest) });
    try {
      const { code, output } = await runMain(dir, 'perm.json');
      assert.equal(code, 1);
      assert.match(output, /cloudflare_queue is not in .*perm\.json/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('requires the scope locals in the manifest', () => {
    const { errors } = resolveLocals([{ file: 'a.tf', text: tfLocals }], { ...manifest, scopes: { account: {} } }, 'x.json');
    assert.equal(errors.length, 3);
    assert.ok(errors.every((e) => e.file === 'x.json'));
  });

  it('names the repository credential and sync hint from the manifest', async () => {
    const custom = { ...manifest, credential: { githubSecret: 'TF_CF_TOKEN', terraformCloudVariable: 'cloudflare_token', syncHint: 'run sync.yml' } };
    assert.match(liveLimits(custom), /GitHub secret TF_CF_TOKEN\. Terraform Cloud uses its own variable cloudflare_token/);
    const lines = [];
    const outcome = await liveCheck({
      request: stub({ [`/accounts/${ACCOUNT}/tokens/verify`]: error(401, 1000, 'Invalid API Token'), '/user/tokens/verify': error(401, 1000, 'Invalid API Token') }).request,
      manifest: custom, locals, requirements, emit: githubEmitter('', (l) => lines.push(l))
    });
    assert.equal(outcome.ok, false);
    assert.match(lines.join('\n'), /Cloudflare refused TF_CF_TOKEN .*update the GitHub secret TF_CF_TOKEN, and run sync\.yml\./);
  });
});
