import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { adjustReport, envName, gate, main, matrix, newManifests, openReview, pending, prompt, readContext, report, saveState, target } from './main.mjs';
import { bodyOf, header, manifestOf, marker } from './test-helpers.mjs';

const REPO = 'octo/app';
const silent = { info() {}, notice() {}, warning() {} };
const here = fileURLToPath(new URL('.', import.meta.url));

// A fake GitHub API: routes are [method, path regex, handler(match, body)] and every call is recorded.
function fakeApi(routes) {
  const calls = [];
  const api = {
    calls,
    async request(method, path, body) {
      calls.push({ method, path, body });
      for (const [routeMethod, pattern, handler] of routes) {
        const match = routeMethod === method && pattern.exec(path);
        if (match) {
          const data = typeof handler === 'function' ? await handler(match, body) : handler;
          return { status: 200, data, headers: new Headers() };
        }
      }
      throw Object.assign(new Error(`${method} ${path} failed with 404: Not Found`), { status: 404 });
    },
    async paginate(path) {
      return (await api.request('GET', path)).data;
    }
  };
  return api;
}

const ctxFor = (values, extra = {}) => readContext({
  ...Object.fromEntries(Object.entries(values).map(([name, value]) => [envName(name), value])),
  GITHUB_REPOSITORY: REPO,
  GITHUB_SERVER_URL: 'https://github.com',
  GITHUB_RUN_ID: '99',
  ...extra
});

const posted = (api, pattern = /\/comments$/) => api.calls.filter((call) => call.method === 'POST' && pattern.test(call.path));

describe('matrix and prompt', () => {
  it('returns the platforms as JSON', () => {
    assert.deepEqual(matrix(ctxFor({ platforms: 'facebook youtube' })), { platforms: '["facebook","youtube"]' });
    assert.throws(() => matrix(ctxFor({ platforms: 'myspace' })), /Unknown platform/);
  });

  it('defaults the profile and label and keeps multiline instructions', () => {
    const result = prompt(ctxFor({ mode: 'generate', platform: 'instagram', instructions: 'line one\nline two' }));
    assert.equal(result.prompt, 'generate profile docs/ai/social-content.md');
    assert.match(result.instructions, /Review issue label: marketing-content/);
    assert.match(result.instructions, /line one\nline two$/);
    assert.throws(() => prompt(ctxFor({ mode: 'adjust', platform: 'instagram' })), /issue number/);
  });

  it('writes multiline outputs with a delimiter', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'social-out-'));
    const output = join(dir, 'out');
    writeFileSync(output, '');
    await main({ [envName('command')]: 'prompt', [envName('mode')]: 'generate', [envName('platform')]: 'youtube', GITHUB_OUTPUT: output }, fakeApi([]));
    const text = readFileSync(output, 'utf8');
    assert.match(text, /^prompt=generate profile docs\/ai\/social-content\.md$/m);
    assert.match(text, /^instructions<<EOF_[0-9a-f]+\nRun: non-interactive/m);
  });

  it('rejects unknown commands', async () => {
    await assert.rejects(main({ [envName('command')]: 'publish' }, fakeApi([])), /Unsupported command 'publish'/);
  });
});

describe('gate', () => {
  const manifest = manifestOf();
  const issue = { number: 7, state: 'open', labels: [{ name: 'marketing-content' }], body: bodyOf(manifest) };
  const commentOf = (login, body = '/aprove', type = 'User') => ({ id: 55, body, user: { login, type }, issue_url: `https://api.github.com/repos/${REPO}/issues/7` });
  const routes = ({ comment = commentOf('ana'), role = 'write', issueData = issue } = {}) => [
    ['GET', /\/issues\/comments\/55$/, comment],
    ['GET', /\/collaborators\/ana\/permission$/, { role_name: role, permission: role }],
    ['GET', /\/issues\/7$/, issueData],
    ['POST', /\/reactions$/, {}],
    ['POST', /\/issues\/7\/comments$/, {}]
  ];
  const ctx = ctxFor({ issue: '7', 'comment-id': '55', 'slash-command': '/aprove' });

  it('allows a writer and reacts to the comment', async () => {
    const api = fakeApi(routes());
    const result = await gate(ctx, api, silent);
    assert.deepEqual(result, { allowed: 'true', reason: '', platform: 'instagram', batch: '2026-11-30-instagram', revision: '1', actor: 'ana' });
    assert.equal(posted(api, /\/reactions$/)[0].body.content, 'eyes');
  });

  for (const role of ['admin', 'maintain']) {
    it(`allows ${role}`, async () => {
      assert.equal((await gate(ctx, fakeApi(routes({ role })), silent)).allowed, 'true');
    });
  }

  for (const role of ['read', 'triage', 'none']) {
    it(`refuses ${role} silently`, async () => {
      const api = fakeApi(routes({ role }));
      const result = await gate(ctx, api, silent);
      assert.equal(result.allowed, 'false');
      assert.match(result.reason, /no write/);
      assert.equal(posted(api).length, 0);
    });
  }

  it('refuses a non-collaborator (404) silently', async () => {
    const api = fakeApi(routes().filter(([, pattern]) => !String(pattern).includes('collaborators')));
    assert.equal((await gate(ctx, api, silent)).allowed, 'false');
    assert.equal(posted(api).length, 0);
  });

  it('refuses bots without checking their permission', async () => {
    const api = fakeApi(routes({ comment: commentOf('helper[bot]', '/aprove', 'Bot') }));
    const result = await gate(ctx, api, silent);
    assert.equal(result.allowed, 'false');
    assert.match(result.reason, /Bots cannot/);
    assert.equal(api.calls.some((call) => call.path.includes('collaborators')), false);
  });

  it('answers a writer when the review issue cannot take the command', async () => {
    const api = fakeApi(routes({ issueData: { ...issue, state: 'closed' } }));
    const result = await gate(ctx, api, silent);
    assert.equal(result.allowed, 'false');
    const [reply] = posted(api, /\/issues\/7\/comments$/);
    assert.match(reply.body.body, /`\/aprove` was not run: Issue #7 is closed\./);
    assert.match(reply.body.body, /actions\/runs\/99/);
  });

  it('stays quiet on an unrelated issue', async () => {
    const api = fakeApi(routes({ issueData: { ...issue, labels: [], body: 'Feature request' } }));
    assert.equal((await gate(ctx, api, silent)).allowed, 'false');
    assert.equal(posted(api).length, 0);
  });

  it('validates its inputs', async () => {
    await assert.rejects(gate(ctxFor({ issue: 'x', 'comment-id': '55', 'slash-command': '/aprove' }), fakeApi([]), silent), /issue number/);
    await assert.rejects(gate(ctxFor({ issue: '7', 'comment-id': 'x', 'slash-command': '/aprove' }), fakeApi([]), silent), /comment-id/);
    await assert.rejects(gate(ctxFor({ issue: '7', 'comment-id': '55', 'slash-command': 'aprove' }), fakeApi([]), silent), /slash-command/);
  });
});

describe('target', () => {
  it('accepts a review issue and refuses others without a comment', async () => {
    const issue = { number: 7, state: 'open', labels: ['marketing-content'], body: bodyOf(manifestOf({ platform: 'youtube', batch_id: 'y' })) };
    let api = fakeApi([['GET', /\/issues\/7$/, issue]]);
    assert.deepEqual(await target(ctxFor({ issue: '7' }), api, silent), { allowed: 'true', reason: '', platform: 'youtube', batch: 'y', revision: '1' });
    api = fakeApi([['GET', /\/issues\/7$/, { ...issue, state: 'closed' }]]);
    const refused = await target(ctxFor({ issue: '7' }), api, silent);
    assert.equal(refused.allowed, 'false');
    assert.match(refused.reason, /is closed/);
    assert.equal(api.calls.length, 1);
  });
});

describe('pending', () => {
  it('lists approved Instagram issues with items left', async () => {
    const approved = manifestOf({ approval: { status: 'approved', revision: 1 } });
    const api = fakeApi([['GET', /\/issues\?state=open&labels=marketing-content$/, [
      { number: 12, state: 'open', labels: ['marketing-content'], body: bodyOf(approved) },
      { number: 11, state: 'open', labels: ['marketing-content'], body: bodyOf(manifestOf()) }
    ]]]);
    assert.deepEqual(await pending(ctxFor({ platform: 'instagram' }), api, silent), { issues: '[12]', count: '1' });
    await assert.rejects(pending(ctxFor({ platform: 'x' }), api, silent), /Unknown platform/);
  });
});

describe('report', () => {
  const dir = mkdtempSync(join(tmpdir(), 'social-report-'));
  const write = (name, value) => {
    const path = join(dir, name);
    writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value));
    return path;
  };
  const routes = [['POST', /\/issues\/7\/comments$/, {}], ['PATCH', /\/issues\/7$/, {}]];
  const facebook = manifestOf({ platform: 'facebook', items: [{ id: 'a', type: 'post', publish_at: '2026-12-01T09:00:00-03:00' }, { id: 'b', type: 'photo', publish_at: '2026-11-01T09:00:00-03:00' }] });

  it('comments and closes when every item is scheduled or stale', async () => {
    const api = fakeApi(routes);
    const manifest = write('done.json', { ...facebook, state: { a: { status: 'scheduled', remote_id: '1' } } });
    const result = await report(ctxFor({ issue: '7', manifest, before: write('before.json', facebook), log: write('log', 'scheduled: a\nstale: b x\n'), 'always-comment': 'true' }), api, silent);
    assert.deepEqual(result, { complete: 'true', commented: 'true' });
    assert.match(posted(api)[0].body.body, /### Facebook publishing/);
    assert.deepEqual(api.calls.find((call) => call.method === 'PATCH').body, { state: 'closed', state_reason: 'completed' });
  });

  it('keeps quiet on a scheduled run with nothing new', async () => {
    const api = fakeApi(routes);
    const manifest = write('same.json', facebook);
    const result = await report(ctxFor({ issue: '7', manifest, before: manifest, log: write('quiet', 'nothing due: every approved item is published or waits for its date\n') }), api, silent);
    assert.deepEqual(result, { complete: 'false', commented: 'false' });
    assert.equal(api.calls.length, 0);
  });

  it('comments a failure without closing', async () => {
    const api = fakeApi(routes);
    const manifest = write('failed.json', { ...facebook, state: { a: { status: 'failed', error: 'OAuthException' } } });
    const result = await report(ctxFor({ issue: '7', manifest, before: write('failed-before.json', facebook), log: write('err', ''), outcome: 'failure' }), api, silent);
    assert.equal(result.complete, 'false');
    assert.match(posted(api)[0].body.body, /publishing failed/);
    assert.doesNotMatch(posted(api)[0].body.body, /```text/);
    assert.equal(api.calls.some((call) => call.method === 'PATCH'), false);
  });

  it('stays quiet when a scheduled run fails the same way again', async () => {
    const api = fakeApi(routes);
    const manifest = write('again.json', { ...facebook, state: { a: { status: 'failed', error: 'OAuthException', attempts: 3, at: '2026-12-01T12:00:00Z' } } });
    const before = write('again-before.json', { ...facebook, state: { a: { status: 'failed', error: 'OAuthException', attempts: 2, at: '2026-12-01T09:00:00Z' } } });
    const result = await report(ctxFor({ issue: '7', manifest, before, log: write('again.log', ''), outcome: 'failure' }), api, silent);
    assert.equal(result.commented, 'false');
    assert.equal(api.calls.length, 0);
  });

  it('warns instead of confirming or closing when the state was not saved', async () => {
    const api = fakeApi(routes);
    const manifest = write('unsaved.json', { ...facebook, state: { a: { status: 'scheduled' }, b: { status: 'scheduled' } } });
    const result = await report(ctxFor({ issue: '7', manifest, before: write('unsaved-before.json', facebook), log: write('unsaved.log', 'issue body has 70000 characters\n'), 'save-outcome': 'failure', mode: 'approved' }), api, silent);
    assert.deepEqual(result, { complete: 'false', commented: 'true' });
    assert.match(posted(api)[0].body.body, /### State not saved/);
    assert.equal(api.calls.some((call) => call.method === 'PATCH'), false);
  });

  it('quotes the publisher error on a failed run', async () => {
    const api = fakeApi(routes);
    const manifest = write('quoted.json', facebook);
    await report(ctxFor({ issue: '7', manifest, before: manifest, log: write('quoted.log', 'invalid manifest:\n- batch is not approved\n'), outcome: 'failure' }), api, silent);
    assert.match(posted(api)[0].body.body, /```text\ninvalid manifest:\n- batch is not approved\n```/);
  });

  it('reports a batch that could not be restored', async () => {
    const api = fakeApi(routes);
    await report(ctxFor({ issue: '7', manifest: join(dir, 'missing.json') }), api, silent);
    assert.match(posted(api)[0].body.body, /was not restored, so nothing was published/);
  });

  it('confirms an Instagram approval or its failure', async () => {
    const approved = write('ig.json', manifestOf({ approval: { status: 'approved', by: 'ana', revision: 2 } }));
    let api = fakeApi(routes);
    await report(ctxFor({ issue: '7', manifest: approved, mode: 'approved' }), api, silent);
    assert.match(posted(api)[0].body.body, /Revision 2 was approved by ana/);
    api = fakeApi(routes);
    await report(ctxFor({ issue: '7', manifest: join(dir, 'none.json'), mode: 'approved', outcome: 'failure', log: write('approve.err', 'comment 55 predates revision 2; approve the current revision\n') }), api, silent);
    assert.match(posted(api)[0].body.body, /Approval not recorded/);
    assert.match(posted(api)[0].body.body, /```text\ncomment 55 predates revision 2/);
  });
});

describe('adjustReport', () => {
  const issueAt = (revision) => [['GET', /\/issues\/7$/, { body: `${header('youtube', 'b', revision)}\n` }], ['POST', /\/issues\/7\/comments$/, {}]];

  it('reports a new revision, no revision, or a failure', async () => {
    let api = fakeApi(issueAt(3));
    assert.deepEqual(await adjustReport(ctxFor({ issue: '7', 'before-revision': '2' }), api), { revision: '3', changed: 'true' });
    assert.match(posted(api)[0].body.body, /now at revision 3/);
    api = fakeApi(issueAt(2));
    await adjustReport(ctxFor({ issue: '7', 'before-revision': '2' }), api);
    assert.match(posted(api)[0].body.body, /without a new revision/);
    api = fakeApi(issueAt(2));
    await adjustReport(ctxFor({ issue: '7', 'before-revision': '2', outcome: 'failure' }), api);
    assert.match(posted(api)[0].body.body, /Adjust failed/);
  });
});

describe('openReview', () => {
  function workspace() {
    const root = mkdtempSync(join(tmpdir(), 'social-open-'));
    mkdirSync(join(root, 'docs/ai'), { recursive: true });
    writeFileSync(join(root, 'docs/ai/social-content.md'), '# profile\n');
    const write = (platform, batch, manifest, mtime = null) => {
      const dir = join(root, 'out/batches', platform, batch);
      mkdirSync(dir, { recursive: true });
      const path = join(dir, 'manifest.json');
      writeFileSync(path, JSON.stringify(manifest));
      if (mtime) utimesSync(path, mtime, mtime);
      return path;
    };
    return { root, write };
  }

  // A fake runner for the ai-skills scripts: answers by script name and records each call.
  function fakeRun(overrides = {}) {
    const calls = [];
    const run = (args) => {
      calls.push(args);
      const name = `${args[0].split('/').at(-1)} ${args[1]}`;
      if (overrides[name]) return overrides[name](args);
      if (name === 'social-manifest.mjs config') return { code: 0, stdout: 'out/batches\n', stderr: '' };
      if (name === 'review-batch.mjs issue-body') return { code: 0, stdout: 'BODY', stderr: '' };
      return { code: 0, stdout: 'ok\n', stderr: '' };
    };
    return { run, calls };
  }

  const baseCtx = (root, extra = {}) => ({ ...ctxFor({ platform: 'youtube', 'skills-dir': '/skills', since: '1000', 'drive-root': 'Brand', ...extra }), cwd: root });
  const manifest = manifestOf({ platform: 'youtube', batch_id: '2026-12-01-youtube', publication_date: '2026-12-01', review: { revision: 1 } });

  it('opens, labels, and records a batch the agent left without an issue', async () => {
    const { root, write } = workspace();
    write('youtube', '2026-12-01-youtube', manifest);
    write('youtube', 'old', { ...manifest, batch_id: 'old' }, 500);
    const api = fakeApi([
      ['GET', /\/issues\?state=open&labels=marketing-content$/, []],
      ['POST', /\/labels$/, {}],
      ['POST', /\/issues$/, { number: 21, html_url: 'https://github.com/octo/app/issues/21' }],
      ['PATCH', /\/issues\/21$/, {}]
    ]);
    const { run, calls } = fakeRun();
    const result = await openReview(baseCtx(root), api, silent, { run });
    assert.deepEqual(result, { opened: '[21]', tracked: '[]' });
    const scripts = calls.map((args) => `${args[0].split('/').at(-1)} ${args[1]}`);
    assert.deepEqual(scripts, ['social-manifest.mjs config', 'copy-guard.mjs --manifest', 'social-manifest.mjs validate', 'review-batch.mjs upload', 'review-batch.mjs issue-body', 'review-batch.mjs set-issue', 'review-batch.mjs issue-body']);
    assert.deepEqual(calls[3].slice(-2), ['--root', 'Brand']);
    assert.deepEqual(calls[5].slice(-4), ['--issue', '21', '--url', 'https://github.com/octo/app/issues/21']);
    const created = api.calls.find((call) => call.method === 'POST' && call.path.endsWith('/issues'));
    assert.deepEqual(created.body, { title: 'YouTube: 2026-12-01 (2 items)', body: 'BODY', labels: ['marketing-content'] });
    assert.equal(api.calls.find((call) => call.path.endsWith('/labels')).body.name, 'marketing-content');
  });

  it('leaves a batch alone when an open issue already tracks it', async () => {
    const { root, write } = workspace();
    write('youtube', '2026-12-01-youtube', { ...manifest, review: { issue_number: 30, revision: 1 } });
    const api = fakeApi([['GET', /\/issues\/30$/, { number: 30, state: 'open', body: header('youtube', '2026-12-01-youtube') }]]);
    const { run, calls } = fakeRun();
    assert.deepEqual(await openReview(baseCtx(root), api, silent, { run }), { opened: '[]', tracked: '[30]' });
    assert.equal(calls.length, 1);
  });

  it('finds an issue the agent opened but did not record', async () => {
    const { root, write } = workspace();
    write('youtube', '2026-12-01-youtube', manifest);
    const api = fakeApi([['GET', /\/issues\?state=open/, [{ number: 31, state: 'open', body: header('youtube', '2026-12-01-youtube') }]]]);
    assert.deepEqual(await openReview(baseCtx(root), api, silent, { run: fakeRun().run }), { opened: '[]', tracked: '[31]' });
  });

  it('never opens a batch that fails the copy guard', async () => {
    const { root, write } = workspace();
    write('youtube', '2026-12-01-youtube', manifest);
    const api = fakeApi([['GET', /\/issues\?state=open/, []]]);
    const { run } = fakeRun({ 'copy-guard.mjs --manifest': () => ({ code: 1, stdout: 'ERROR em-dash in a\n', stderr: '' }) });
    await assert.rejects(openReview(baseCtx(root), api, silent, { run }), /copy guard failed \(ERROR em-dash in a\)/);
    assert.equal(api.calls.some((call) => call.method === 'POST'), false);
  });

  it('fails when the agent failed and left no batch, and only notes it otherwise', async () => {
    const { root } = workspace();
    await assert.rejects(openReview(baseCtx(root, { 'agent-outcome': 'failure' }), fakeApi([]), silent, { run: fakeRun().run }), /agent failed and wrote no batch/);
    assert.deepEqual(await openReview(baseCtx(root), fakeApi([]), silent, { run: fakeRun().run }), { opened: '[]', tracked: '[]' });
  });

  it('rejects an unsafe batches directory from the profile', async () => {
    const { root } = workspace();
    const { run } = fakeRun({ 'social-manifest.mjs config': () => ({ code: 0, stdout: '../outside\n', stderr: '' }) });
    await assert.rejects(openReview(baseCtx(root), fakeApi([]), silent, { run }), /batches_dir must be a relative path/);
  });

  it('selects only manifests written since the start', () => {
    const { root, write } = workspace();
    write('youtube', 'new', manifest);
    write('youtube', 'old', manifest, 500);
    assert.deepEqual(newManifests(root, 'out/batches', 'youtube', 1000 * 1000).map((path) => path.split('/').at(-2)), ['new']);
    assert.deepEqual(newManifests(root, 'missing', 'youtube', 0), []);
  });
});

describe('fetch-skills.sh', () => {
  it('extracts only the named skills from the pinned archive', () => {
    const dir = mkdtempSync(join(tmpdir(), 'social-fetch-'));
    const source = join(dir, 'src/ai-skills-v1');
    for (const skill of ['social-review', 'other']) {
      mkdirSync(join(source, '.rulesync/skills', skill, 'scripts'), { recursive: true });
      writeFileSync(join(source, '.rulesync/skills', skill, 'SKILL.md'), `# ${skill}\n`);
    }
    const archive = join(dir, 'archive/owner/repo/tar.gz');
    mkdirSync(archive, { recursive: true });
    assert.equal(spawnSync('tar', ['-czf', join(archive, 'v1'), '-C', join(dir, 'src'), 'ai-skills-v1']).status, 0);
    const env = { ...process.env, SKILLS_REPOSITORY: 'owner/repo', SKILLS_REF: 'v1', SKILLS: 'social-review', SKILLS_TARGET: join(dir, 'out'), SKILLS_BASE_URL: `file://${join(dir, 'archive')}`, GITHUB_OUTPUT: join(dir, 'output') };
    const ok = spawnSync('bash', [join(here, 'fetch-skills.sh')], { env, encoding: 'utf8' });
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(readFileSync(join(dir, 'out/social-review/SKILL.md'), 'utf8'), '# social-review\n');
    assert.match(readFileSync(join(dir, 'output'), 'utf8'), /^skills-dir=.*\/out$/m);
    const missing = spawnSync('bash', [join(here, 'fetch-skills.sh')], { env: { ...env, SKILLS: 'youtube-publish' }, encoding: 'utf8' });
    assert.equal(missing.status, 1);
    assert.match(missing.stdout, /Skill 'youtube-publish' was not found/);
    const branch = spawnSync('bash', [join(here, 'fetch-skills.sh')], { env: { ...env, SKILLS_REF: 'feat/x' }, encoding: 'utf8' });
    assert.equal(branch.status, 1);
    assert.match(branch.stdout, /Invalid skills-ref/);
  });
});

describe('saveState', () => {
  const dir = mkdtempSync(join(tmpdir(), 'social-save-'));
  const approved = manifestOf({ approval: { status: 'approved', by: 'ana', revision: 1 } });
  const files = (name, ours, before = approved) => {
    const folder = join(dir, name);
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, 'manifest.json'), JSON.stringify(ours));
    writeFileSync(join(folder, 'before.json'), JSON.stringify(before));
    return { manifest: join(folder, 'manifest.json'), before: join(folder, 'before.json'), folder };
  };
  const runner = () => {
    const calls = [];
    return { calls, run: (args) => { calls.push(args); return { code: 0, stdout: `BODY ${readFileSync(args[2], 'utf8').length}`, stderr: '' }; } };
  };
  const ctx = (paths) => ({ ...ctxFor({ issue: '7', 'skills-dir': '/skills', ...paths }), cwd: dir });

  it('merges this run into the body a concurrent run wrote', async () => {
    const ours = { ...approved, state: { a: { status: 'published', remote_id: '1' } } };
    const live = { ...approved, state: { b: { status: 'failed', error: 'x' } } };
    const paths = files('merge', ours);
    const api = fakeApi([['GET', /\/issues\/7$/, { body: bodyOf(live) }], ['PATCH', /\/issues\/7$/, {}]]);
    const { run, calls } = runner();
    assert.deepEqual(await saveState(ctx(paths), api, silent, { run }), { saved: 'true', reason: '' });
    const merged = JSON.parse(readFileSync(join(paths.folder, 'merged.json'), 'utf8'));
    assert.deepEqual(Object.keys(merged.state).sort(), ['a', 'b']);
    assert.deepEqual(calls[0].slice(1), ['issue-body', join(paths.folder, 'merged.json')]);
    assert.match(api.calls.find((call) => call.method === 'PATCH').body.body, /^BODY \d+$/);
  });

  it('writes nothing when an adjust moved the batch to another revision', async () => {
    const ours = { ...approved, state: { a: { status: 'published', remote_id: '1' } } };
    const live = { ...approved, approval: { status: 'pending' }, review: { issue_number: 7, revision: 2 } };
    const api = fakeApi([['GET', /\/issues\/7$/, { body: bodyOf(live) }]]);
    const result = await saveState(ctx(files('conflict', ours)), api, silent, { run: runner().run });
    assert.equal(result.saved, 'conflict');
    assert.match(result.reason, /revision 2/);
    assert.equal(api.calls.some((call) => call.method === 'PATCH'), false);
  });

  it('writes nothing while the header and marker disagree', async () => {
    const api = fakeApi([['GET', /\/issues\/7$/, { body: `${header('instagram', approved.batch_id, 2)}\n${marker(approved)}` }]]);
    assert.equal((await saveState(ctx(files('midway', approved)), api, silent, { run: runner().run })).saved, 'conflict');
  });

  it('skips a batch that was never restored and an unchanged state', async () => {
    assert.equal((await saveState(ctx({ manifest: join(dir, 'none.json') }), fakeApi([]), silent)).saved, 'skipped');
    const api = fakeApi([['GET', /\/issues\/7$/, { body: bodyOf(approved) }]]);
    assert.equal((await saveState(ctx(files('same', approved)), api, silent, { run: runner().run })).saved, 'unchanged');
    assert.equal(api.calls.length, 1);
  });

  it('fails when the body cannot be rendered', async () => {
    const ours = { ...approved, state: { a: { status: 'published' } } };
    const api = fakeApi([['GET', /\/issues\/7$/, { body: bodyOf(approved) }]]);
    const run = () => ({ code: 1, stdout: '', stderr: 'issue body has 70000 characters' });
    await assert.rejects(saveState(ctx(files('big', ours)), api, silent, { run }), /70000 characters/);
  });
});

describe('report after a save conflict', () => {
  it('leaves this run\'s results as a note and does not close', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'social-note-'));
    const manifest = join(dir, 'm.json');
    writeFileSync(manifest, JSON.stringify(manifestOf({ state: { a: { status: 'published', remote_id: '9' }, b: { status: 'published' } } })));
    const api = fakeApi([['POST', /\/issues\/7\/comments$/, {}], ['PATCH', /\/issues\/7$/, {}]]);
    const result = await report(ctxFor({ issue: '7', manifest, 'save-outcome': 'conflict', 'save-reason': 'the batch moved to revision 2' }), api, silent);
    assert.deepEqual(result, { complete: 'false', commented: 'true' });
    const body = api.calls[0].body.body;
    assert.match(body, /State not saved: the batch changed/);
    assert.match(body, /because the batch moved to revision 2/);
    assert.match(body, /\| `a` \| photo \| published/);
    assert.doesNotMatch(body, /this issue is closed/);
    assert.equal(api.calls.some((call) => call.method === 'PATCH'), false);
  });
});
