import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

export const DEFAULT_MANIFEST_PATH = 'terraform/cloudflare-token-permissions.json';
export const DEFAULT_TERRAFORM_DIRECTORY = 'terraform';
const API_BASE = 'https://api.cloudflare.com/client/v4';
const SCOPE_TAGS = { account: 'com.cloudflare.api.account', zone: 'com.cloudflare.api.account.zone' };
const AUTH_ERROR_CODES = new Set([9106, 9109, 10000]);
const MALFORMED_HEADER_CODE = 6111;
const IP_RESTRICTION = /from location|ip address|request_ip|client ip/i;
const ACCOUNT_KEY = /^com\.cloudflare\.api\.account\.([^.]+)$/;
const ZONE_KEY = /^com\.cloudflare\.api\.account\.zone\.([^.]+)$/;
const credentialNames = (manifest) => {
  const secret = manifest.credential?.githubSecret ?? 'CLOUDFLARE_API_TOKEN';
  const variable = manifest.credential?.terraformCloudVariable ?? secret;
  const sync = manifest.credential?.syncHint ?? `update the Terraform Cloud variable ${variable} with the same token`;
  return { secret, variable, sync };
};
export const liveLimits = (manifest) => {
  const { secret, variable } = credentialNames(manifest);
  return `This checks the GitHub secret ${secret}. Terraform Cloud uses its own variable ${variable}, so keep both on the same token.`;
};
const USER_KEY = /^com\.cloudflare\.api\.user\.([^.]+)$/;

// Blanks comments and heredoc bodies while keeping strings, so URLs such as "https://..." survive and
// heredoc content (shell globs, stray quotes) cannot hide the rest of the file. Unterminated constructs are reported.
export function scanHcl(text) {
  let out = '';
  let inString = false;
  const problems = [];
  const blank = (chunk) => chunk.replace(/[^\n]/g, ' ');
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (inString) {
      out += char;
      if (char === '\\') {
        out += text[i + 1] ?? '';
        i += 1;
      } else if (char === '"') {
        inString = false;
      } else if (char === '\n') {
        problems.push('a string is not closed on its line');
        inString = false;
      }
      continue;
    }
    const heredoc = char === '<' ? text.slice(i).match(/^<<-?([A-Za-z_][A-Za-z0-9_]*)[ \t]*\n/) : null;
    if (heredoc) {
      const close = new RegExp(`^[ \\t]*${heredoc[1]}[ \\t]*$`, 'm');
      const bodyStart = i + heredoc[0].length;
      const rest = text.slice(bodyStart);
      const found = rest.match(close);
      if (!found) {
        problems.push(`heredoc ${heredoc[1]} is not closed`);
        out += blank(text.slice(i));
        break;
      }
      const stop = bodyStart + found.index + found[0].length;
      out += `${heredoc[0]}${blank(text.slice(bodyStart, stop))}`;
      i = stop - 1;
    } else if (char === '"') {
      inString = true;
      out += char;
    } else if (char === '#' || (char === '/' && text[i + 1] === '/')) {
      while (i < text.length && text[i] !== '\n') i += 1;
      out += '\n';
    } else if (char === '/' && text[i + 1] === '*') {
      const close = text.indexOf('*/', i + 2);
      if (close === -1) problems.push('a /* comment is not closed');
      const stop = close === -1 ? text.length : close + 2;
      out += blank(text.slice(i, stop));
      i = stop - 1;
    } else {
      out += char;
    }
  }
  if (inString) problems.push('a string is not closed');
  return { text: out, problems };
}

export const stripComments = (text) => scanHcl(text).text;

function blockBody(text, openIndex) {
  let depth = 0;
  let inString = false;
  for (let i = openIndex; i < text.length; i += 1) {
    const char = text[i];
    if (inString) {
      if (char === '\\') i += 1;
      else if (char === '"') inString = false;
    } else if (char === '"') {
      inString = true;
    } else if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(openIndex + 1, i);
    }
  }
  return text.slice(openIndex + 1);
}

function addUse(map, key, file) {
  if (!map.has(key)) map.set(key, new Set());
  map.get(key).add(file);
}

export function collectUsage(sources) {
  const usage = { resources: new Map(), dataSources: new Map(), phases: new Map(), errors: [] };
  const header = /^[ \t]*(resource|data)[ \t]+("?)(cloudflare_[a-z0-9_]+)\2[ \t]+("?)[A-Za-z0-9_-]+\4[ \t]*\{/;
  for (const { file, text } of sources) {
    if (file.endsWith('.tf.json')) {
      usage.errors.push({ file, message: 'Terraform JSON files are not parsed by the permission check; write the configuration in .tf files.' });
      continue;
    }
    const { text: clean, problems } = scanHcl(text);
    const providerName = /([A-Za-z0-9_-]+)[ \t]*=[ \t]*\{[^{}]*source[ \t]*=[ \t]*"(?:registry\.terraform\.io\/)?cloudflare\/cloudflare"/gi;
    for (const [, name] of clean.matchAll(providerName)) {
      if (name !== 'cloudflare') usage.errors.push({ file, message: `The Cloudflare provider must use the local name "cloudflare" (found "${name}") so the permission check can find its resources.` });
    }
    for (const problem of problems) usage.errors.push({ file, message: `Cannot parse this file reliably (${problem}); the permission check refuses to pass.` });
    let offset = 0;
    for (const line of clean.split('\n')) {
      const lineStart = offset;
      offset += line.length + 1;
      if (!/^[ \t]*(resource|data|ephemeral)[ \t]+"?cloudflare_/.test(line)) continue;
      const match = line.match(header);
      if (!match) {
        usage.errors.push({ file, message: `Unrecognized Cloudflare block "${line.trim()}". Use resource "cloudflare_x" "name" { or data "cloudflare_x" "name" { on one line.` });
        continue;
      }
      const [, kind, , type] = match;
      addUse(kind === 'resource' ? usage.resources : usage.dataSources, type, file);
      if (kind === 'resource' && type === 'cloudflare_ruleset') {
        const body = blockBody(clean, lineStart + match[0].length - 1);
        const phase = body.match(/^[ \t]*phase[ \t]*=[ \t]*(.+)$/m);
        const literal = phase?.[1].trim().match(/^"([a-z0-9_]+)"$/);
        if (literal) addUse(usage.phases, literal[1], file);
        else usage.errors.push({ file, message: 'cloudflare_ruleset needs a literal phase so its permission can be checked.' });
      }
    }
  }
  return usage;
}

export function readTerraformSources(dir) {
  const sources = [];
  const walk = (path) => {
    for (const entry of readdirSync(path)) {
      if (entry.startsWith('.')) continue;
      const full = join(path, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith('.tf') || entry.endsWith('.tf.json')) sources.push({ file: relative(process.cwd(), full), text: readFileSync(full, 'utf8') });
    }
  };
  walk(dir);
  return sources;
}

export function resolveLocals(sources, manifest, manifestPath = DEFAULT_MANIFEST_PATH) {
  const errors = [];
  const find = (name) => {
    const pattern = new RegExp(`^[ \\t]*${name}[ \\t]*=[ \\t]*"([^"]+)"`, 'gm');
    const values = sources.flatMap(({ text }) => [...stripComments(text).matchAll(pattern)].map((m) => m[1]));
    if (values.length !== 1) errors.push({ file: manifestPath, message: `Expected exactly one Terraform local "${name}", found ${values.length}.` });
    return values[0];
  };
  const scopes = manifest.scopes ?? {};
  for (const [scope, key] of [['account', 'idLocal'], ['zone', 'idLocal'], ['zone', 'nameLocal']]) {
    if (typeof scopes[scope]?.[key] !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(scopes[scope][key])) {
      errors.push({ file: manifestPath, message: `The manifest needs scopes.${scope}.${key}: the name of the Terraform local that holds it.` });
    }
  }
  if (errors.length > 0) return { locals: {}, errors };
  const locals = {
    accountId: find(scopes.account.idLocal),
    zoneId: find(scopes.zone.idLocal),
    zoneName: find(scopes.zone.nameLocal)
  };
  for (const [key, value] of Object.entries({ accountId: locals.accountId, zoneId: locals.zoneId })) {
    if (value && !/^[0-9a-f]{32}$/.test(value)) errors.push({ file: manifestPath, message: `Terraform local for ${key} is not a Cloudflare ID.` });
  }
  return { locals, errors };
}

function validPermissions(list) {
  return Array.isArray(list) && list.length > 0 && list.every((p) =>
    (p.scope === 'account' || p.scope === 'zone') && typeof p.group === 'string' && p.group &&
    (p.anyOf === undefined || (Array.isArray(p.anyOf) && p.anyOf.every((g) => typeof g === 'string' && g))));
}

export function staticCheck(manifest, usage, manifestPath = DEFAULT_MANIFEST_PATH, terraformDirectory = DEFAULT_TERRAFORM_DIRECTORY) {
  const errors = [...usage.errors];
  const section = (name, used, declared, label) => {
    for (const [type, files] of used) {
      if (!Object.hasOwn(declared, type)) {
        for (const file of files) errors.push({ file, message: `${label} ${type} is not in ${manifestPath}. Add the Cloudflare permission groups it needs.` });
      }
    }
    for (const type of Object.keys(declared)) {
      if (!used.has(type)) errors.push({ file: manifestPath, message: `${label} ${type} is listed in ${name} but no longer used in ${terraformDirectory}/. Remove it.` });
    }
  };
  section('resources', usage.resources, manifest.resources ?? {}, 'Resource');
  section('dataSources', usage.dataSources, manifest.dataSources ?? {}, 'Data source');

  for (const [type, entry] of Object.entries({ ...manifest.resources, ...manifest.dataSources })) {
    if (type === 'cloudflare_ruleset') {
      const phases = entry.phases ?? {};
      for (const [phase, files] of usage.phases) {
        if (!Object.hasOwn(phases, phase)) {
          for (const file of files) errors.push({ file, message: `cloudflare_ruleset phase ${phase} is not in ${manifestPath}.` });
        }
      }
      for (const [phase, value] of Object.entries(phases)) {
        if (!usage.phases.has(phase)) errors.push({ file: manifestPath, message: `cloudflare_ruleset phase ${phase} is listed but no longer used. Remove it.` });
        if (!validPermissions(value.permissions)) errors.push({ file: manifestPath, message: `cloudflare_ruleset phase ${phase} needs a valid permissions list.` });
      }
    } else if (!validPermissions(entry.permissions)) {
      errors.push({ file: manifestPath, message: `${type} needs a non-empty permissions list with scope account or zone and a group name.` });
    }
  }
  return errors;
}

export function requiredGroups(manifest, usage) {
  const merged = new Map();
  const add = (permissions, label) => {
    for (const permission of permissions) {
      const key = `${permission.scope}\u0000${permission.group}`;
      if (!merged.has(key)) merged.set(key, { scope: permission.scope, group: permission.group, anyOf: new Set(permission.anyOf ?? []), neededBy: new Set() });
      merged.get(key).neededBy.add(label);
    }
  };
  for (const type of usage.resources.keys()) {
    const entry = manifest.resources?.[type];
    if (!entry) continue;
    if (type === 'cloudflare_ruleset') {
      for (const phase of usage.phases.keys()) {
        if (entry.phases?.[phase]) add(entry.phases[phase].permissions, `${type} (phase ${phase})`);
      }
    } else {
      add(entry.permissions, type);
    }
  }
  for (const type of usage.dataSources.keys()) {
    if (manifest.dataSources?.[type]) add(manifest.dataSources[type].permissions, `data.${type}`);
  }
  return [...merged.values()].map((r) => ({ ...r, anyOf: [...r.anyOf], neededBy: [...r.neededBy].sort() }));
}

export function classifyResponse(response) {
  const detail = `HTTP ${response.status || 'none'} / curl ${response.curlExit}`;
  if (response.curlExit !== 0) return { kind: 'unavailable', detail };
  let json;
  try {
    json = JSON.parse(response.body);
  } catch {
    json = undefined;
  }
  const errors = Array.isArray(json?.errors) ? json.errors : [];
  const messages = errors.map((e) => `${e.code ?? '?'}: ${e.message ?? ''}`.trim());
  const authCode = errors.some((e) => AUTH_ERROR_CODES.has(Number(e.code)));
  const ipRestricted = errors.some((e) => IP_RESTRICTION.test(String(e.message ?? '')));
  const chain = errors.flatMap((e) => [e, ...(Array.isArray(e.error_chain) ? e.error_chain : [])]);
  if (response.status === 400 && chain.some((e) => Number(e.code) === MALFORMED_HEADER_CODE)) {
    return { kind: 'malformed', detail, messages };
  }
  if (response.status === 401 || response.status === 403 || (authCode && response.status >= 400 && response.status < 500 && response.status !== 429)) {
    return { kind: 'refused', detail, messages, ipRestricted };
  }
  if (response.status >= 200 && response.status < 300 && json?.success === true && json.result !== undefined && json.result !== null) {
    return { kind: 'ok', result: json.result };
  }
  if (response.status === 404) return { kind: 'notFound', detail, messages };
  return { kind: 'unavailable', detail, messages };
}

function parseResources(resources) {
  if (typeof resources === 'string') {
    try {
      return JSON.parse(resources);
    } catch {
      return undefined;
    }
  }
  return resources;
}

// Returns the scopes a policy's resources cover for this account and zone.
// "unparsed" is true when any key or value is not understood; callers decide how to treat it.
export function policyScopes(resources, { accountId, zoneId }) {
  const parsed = parseResources(resources);
  const covers = { account: false, zone: false, accountWide: false, unparsed: false };
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || Object.keys(parsed).length === 0) {
    return { ...covers, unparsed: true };
  }
  const zoneMatch = (key, value) => {
    const zone = key.match(ZONE_KEY);
    if (!zone || value !== '*') return undefined;
    return zone[1] === '*' || zone[1] === zoneId;
  };
  for (const [key, value] of Object.entries(parsed)) {
    const account = key.match(ACCOUNT_KEY);
    if (account && !ZONE_KEY.test(key)) {
      const ours = account[1] === '*' || account[1] === accountId;
      if (value === '*') {
        if (ours) {
          covers.account = true;
          covers.accountWide = true;
        }
      } else if (value && typeof value === 'object' && !Array.isArray(value)) {
        for (const [nestedKey, nestedValue] of Object.entries(value)) {
          const zone = zoneMatch(nestedKey, nestedValue);
          if (zone === undefined) covers.unparsed = true;
          else if (zone && ours) covers.zone = true;
        }
      } else {
        covers.unparsed = true;
      }
      continue;
    }
    const zone = zoneMatch(key, value);
    if (zone !== undefined) {
      if (zone) covers.zone = true;
      continue;
    }
    if (USER_KEY.test(key) && value === '*') continue;
    covers.unparsed = true;
  }
  return covers;
}

export function evaluatePolicies({ policies, groups, requirements, locals }) {
  const byId = new Map(groups.map((group) => [group.id, group]));
  const groupIds = (policy) => (Array.isArray(policy.permission_groups) ? policy.permission_groups.map((g) => g?.id) : []);
  const allows = [];
  const denies = [];
  for (const policy of policies) {
    const scopes = policyScopes(policy.resources, locals);
    if (policy.effect === 'allow') {
      allows.push({ scopes, ids: groupIds(policy) });
    } else {
      // Anything that is not a clean allow is treated as a deny, so a surprise can only fail the check.
      const everything = policy.effect !== 'deny' || scopes.accountWide || scopes.unparsed || !Array.isArray(policy.permission_groups);
      denies.push({ scopes, everything, ids: groupIds(policy) });
    }
  }
  const hasGroup = (ids, name, scope, unknownMatches) => ids.some((id) => {
    const group = byId.get(id);
    if (!group) return unknownMatches;
    return group.name === name && (unknownMatches || (Array.isArray(group.scopes) && group.scopes.includes(SCOPE_TAGS[scope])));
  });
  const granted = (name, scope) => allows.some((p) => !p.scopes.unparsed && p.scopes[scope] && hasGroup(p.ids, name, scope, false));
  const denied = (name, scope) => denies.some((p) => (p.everything || p.scopes[scope]) && (p.everything && p.ids.length === 0 ? true : hasGroup(p.ids, name, scope, true)));
  return requirements.map((requirement) => {
    const names = [requirement.group, ...requirement.anyOf];
    const grantedBy = names.find((name) => granted(name, requirement.scope) && !denied(name, requirement.scope));
    return { ...requirement, ok: Boolean(grantedBy), grantedBy };
  });
}

const dashboardPath = (kind) => (kind === 'user' ? 'Cloudflare dashboard > My Profile > API Tokens' : 'Cloudflare dashboard > Manage Account > Account API Tokens');

export async function liveCheck({ request, manifest, locals, requirements, emit }) {
  const { secret, sync } = credentialNames(manifest);
  const fail = (message) => {
    emit.error(message);
    return { ok: false, results: [] };
  };
  const unavailable = (step, c) => fail(`Cloudflare API unavailable while ${step} (${c.detail}${c.messages?.length ? `; ${c.messages.join('; ')}` : ''}), token not judged. Re-run the check.`);
  const refusedMessage = (c) => (c.ipRestricted
    ? `Cloudflare refused ${secret} because of its client IP address filter (${c.detail}; ${c.messages.join('; ')}). Allow the GitHub Actions runner addresses or remove the IP filter; the token itself was not judged.`
    : `Cloudflare refused ${secret} (${c.detail}${c.messages.length ? `; ${c.messages.join('; ')}` : ''}). The token is invalid, revoked, or expired: roll it, update the GitHub secret ${secret}, and ${sync}.`);

  if (requirements.length === 0) return fail('No Cloudflare permission requirements were found; refusing to pass without checking.');

  const notFound = (step, c) => fail(`Cloudflare returned 404 while ${step} (${c.detail}${c.messages?.length ? `; ${c.messages.join('; ')}` : ''}), token not judged. A re-run will not fix this: check the Terraform local ${manifest.scopes?.account?.idLocal ?? "for the account ID"} and whether ${secret} is an account or a user token.`);
  const malformed = (c) => fail(`Cloudflare rejected the format of ${secret} (${c.detail}; ${c.messages.join('; ')}). The secret does not hold a Cloudflare API token value: replace it with the token and ${sync}.`);
  const get = async (path) => {
    const c = classifyResponse(await request(path));
    return c.kind === 'malformed' ? { ...c, stop: malformed(c) } : c;
  };
  const accountBase = `/accounts/${encodeURIComponent(locals.accountId)}/tokens`;
  let kind = 'account';
  let verify = await get(`${accountBase}/verify`);
  if (verify.stop) return verify.stop;
  if (verify.kind === 'unavailable') return unavailable('verifying the token as an account token', verify);
  if (verify.kind === 'refused' || verify.kind === 'notFound') {
    if (verify.ipRestricted) return fail(refusedMessage(verify));
    const accountVerify = verify;
    kind = 'user';
    verify = await get('/user/tokens/verify');
    if (verify.stop) return verify.stop;
    if (verify.kind === 'unavailable') return unavailable('verifying the token as a user token', verify);
    if (verify.kind === 'notFound') return notFound('verifying the token as a user token', verify);
    if (verify.kind === 'refused') {
      return accountVerify.kind === 'notFound' ? notFound('verifying the token as an account token', accountVerify) : fail(refusedMessage(verify));
    }
  }
  const token = verify.result;
  if (typeof token?.id !== 'string' || !token.id) return fail(`Cloudflare returned no token ID when verifying ${secret}, token not judged.`);
  if (token.status !== 'active') return fail(`${secret} is ${token.status ?? 'not active'}. Re-enable or roll it in ${dashboardPath(kind)}, then update the GitHub secret ${secret} and ${sync}.`);

  const base = kind === 'account' ? accountBase : '/user/tokens';
  const readGroup = kind === 'account' ? 'Account API Tokens Read (account scope)' : 'API Tokens Read (user scope)';
  const cannotRead = (c) => (c.ipRestricted
    ? fail(refusedMessage(c))
    : fail(`${secret} cannot read its own policies (${c.detail}). Add ${readGroup} to the token in ${dashboardPath(kind)}.`));

  const details = await get(`${base}/${encodeURIComponent(token.id)}`);
  if (details.stop) return details.stop;
  if (details.kind === 'unavailable') return unavailable('reading the token policies', details);
  if (details.kind === 'notFound') return notFound('reading the token policies', details);
  if (details.kind === 'refused') return cannotRead(details);
  if (!Array.isArray(details.result.policies)) return fail(`Cloudflare returned an unexpected token body (no policies array) for ${secret}, token not judged.`);

  const groupsResponse = await get(`${base}/permission_groups`);
  if (groupsResponse.stop) return groupsResponse.stop;
  if (groupsResponse.kind === 'unavailable') return unavailable('listing permission groups', groupsResponse);
  if (groupsResponse.kind === 'notFound') return notFound('listing permission groups', groupsResponse);
  if (groupsResponse.kind === 'refused') return cannotRead(groupsResponse);
  if (!Array.isArray(groupsResponse.result)) return fail('Cloudflare returned an unexpected permission group list, token not judged.');

  const ipConditions = [details.result.condition, ...details.result.policies.map((p) => p?.condition)]
    .some((condition) => condition && typeof condition === 'object' && condition.request_ip);
  if (ipConditions) emit.warning(`${secret} has a client IP address filter. This check only proves GitHub Actions can use it; make sure the filter also allows Terraform Cloud.`);
  const results = evaluatePolicies({ policies: details.result.policies, groups: groupsResponse.result, requirements, locals });
  for (const result of results.filter((r) => !r.ok)) {
    const label = manifest.dashboardLabels?.[result.group];
    const where = result.scope === 'zone' ? `zone ${locals.zoneName} (${locals.zoneId})` : `account ${locals.accountId}`;
    emit.error(`${secret} is missing "${result.group}"${label ? ` (dashboard: ${label})` : ''} on ${where}, needed by ${result.neededBy.join(', ')}. Add it to the token in ${dashboardPath(kind)}, then re-run this check.`);
  }
  return { ok: results.every((r) => r.ok), results, kind };
}

export function summaryTable({ results, locals, manifest }) {
  const rows = results.map((r) => {
    const where = r.scope === 'zone' ? `zone ${locals.zoneName}` : 'account';
    const status = r.ok ? `granted${r.grantedBy !== r.group ? ` (via ${r.grantedBy})` : ''}` : '**missing**';
    return `| ${r.ok ? '✅' : '❌'} ${status} | ${where} | ${r.group} | ${r.neededBy.join(', ')} |`;
  });
  return ['### Cloudflare token permissions', '', '| Status | Scope | Permission group | Needed by |', '| --- | --- | --- | --- |', ...rows, '', liveLimits(manifest), ''].join('\n');
}

export function curlRequest(token) {
  if (/[\r\n"\\]/.test(token)) throw new Error('The Cloudflare token contains characters that cannot be a token.');
  return async (path) => {
    const dir = mkdtempSync(join(tmpdir(), 'cf-permissions-'));
    const bodyPath = join(dir, 'body');
    try {
      const run = spawnSync('curl', [
        '--silent', '--show-error', '--connect-timeout', '10', '--max-time', '30', '--retry', '2',
        '--config', '-', '--output', bodyPath, '--write-out', '%{http_code}', `${API_BASE}${path}`
      ], { input: `header = "Authorization: Bearer ${token}"\n`, encoding: 'utf8' });
      let body = '';
      try {
        body = readFileSync(bodyPath, 'utf8');
      } catch {
        body = '';
      }
      return { curlExit: run.error ? -1 : run.status ?? -1, status: Number.parseInt(run.stdout, 10) || 0, body };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

export function githubEmitter(secretValue, write = console.log) {
  const redact = (text) => (secretValue ? String(text).split(secretValue).join('***') : String(text));
  const escape = (text) => redact(text).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
  const errors = [];
  return {
    errors,
    error: (message, file) => {
      errors.push(redact(message));
      write(`::error${file ? ` file=${file}` : ''}::${escape(message)}`);
    },
    warning: (message) => write(`::warning::${escape(message)}`),
    redact
  };
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const live = argv.includes('--live');
  const token = env.CLOUDFLARE_API_TOKEN ?? '';
  const emit = githubEmitter(token);
  const manifestPath = env.TERRAFORM_PERMISSIONS_MANIFEST || DEFAULT_MANIFEST_PATH;
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const terraformDirectory = env.TERRAFORM_DIRECTORY || DEFAULT_TERRAFORM_DIRECTORY;
  const sources = readTerraformSources(terraformDirectory);
  const usage = collectUsage(sources);
  const { locals, errors: localErrors } = resolveLocals(sources, manifest, manifestPath);
  const errors = [...staticCheck(manifest, usage, manifestPath, terraformDirectory), ...localErrors];
  for (const error of errors) emit.error(error.message, error.file);
  if (errors.length > 0) return 1;
  const requirements = requiredGroups(manifest, usage);
  console.log(`Static check passed: ${usage.resources.size} resource and ${usage.dataSources.size} data source types mapped to ${requirements.length} permission groups.`);
  if (!live) return 0;

  if (!token) {
    emit.error(`${credentialNames(manifest).secret} is empty; the live permission check cannot run.`);
    return 1;
  }
  if (/[\r\n]/.test(token)) {
    emit.error(`${credentialNames(manifest).secret} contains a line break. Re-paste the token without trailing newlines, then ${credentialNames(manifest).sync}.`);
    return 1;
  }
  if (env.GITHUB_ACTIONS === 'true') console.log(`::add-mask::${token}`);
  const outcome = await liveCheck({ request: curlRequest(token), manifest, locals, requirements, emit });
  if (env.GITHUB_STEP_SUMMARY) {
    const summary = outcome.results.length > 0
      ? summaryTable({ results: outcome.results, locals, manifest })
      : ['### Cloudflare token permissions', '', '**Not judged.**', '', ...emit.errors.map((e) => `- ${e}`), ''].join('\n');
    appendFileSync(env.GITHUB_STEP_SUMMARY, emit.redact(summary));
  }
  if (outcome.ok) console.log(`Live check passed: ${credentialNames(manifest).secret} (${outcome.kind} token) grants every required group. ${liveLimits(manifest)}`);
  return outcome.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => { process.exitCode = code; }, (error) => {
    const token = process.env.CLOUDFLARE_API_TOKEN;
    const message = token ? String(error?.message ?? error).split(token).join('***') : String(error?.message ?? error);
    console.log(`::error::Permission check crashed: ${message}`);
    process.exitCode = 1;
  });
}
