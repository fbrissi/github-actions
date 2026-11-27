import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const script = join(here, 'publish.sh');

// Stub ai-skills scripts and gh: each records its arguments, and STUB_* variables choose their results.
const STUB = `#!/usr/bin/env node
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
const [name, ...args] = [process.argv[1].split('/').slice(-3).join('/'), ...process.argv.slice(2)];
appendFileSync(process.env.STUB_CALLS, JSON.stringify([name, ...args]) + '\\n');
const flag = (key) => args[args.indexOf(key) + 1];
const fail = (process.env.STUB_FAIL ?? '').split(',');
if (fail.includes(args[0]) || fail.includes(name.split('/')[0])) { process.stderr.write(\`\${args[0]} failed: reason\\n\`); process.exit(1); }
const manifest = { platform: process.env.STUB_PLATFORM, items: [{ id: 'a' }], state: {} };
if (args[0] === 'approve') writeFileSync(flag('--out'), JSON.stringify({ ...manifest, approval: { status: 'approved' } }));
if (args[0] === 'issue-body') console.log('BODY ' + args[1]);
if (args[0] === 'marker') { readFileSync(args[1], 'utf8'); writeFileSync(flag('--out'), JSON.stringify(manifest)); }
if (name.includes('-publish/')) { console.log('scheduled: a 1'); appendFileSync(process.env.STUB_CALLS + '.env', JSON.stringify({ prefix: process.env.INSTAGRAM_MEDIA_PREFIX ?? null, limit: process.env.YOUTUBE_DAILY_UPLOAD_LIMIT ?? null }) + '\\n'); process.exit(Number(process.env.STUB_PUBLISH ?? 0)); }
`;

function setup(platform) {
  const dir = mkdtempSync(join(tmpdir(), 'social-publish-'));
  const skills = join(dir, 'skills');
  const files = ['social-review/scripts/review-batch.mjs', 'social-review/scripts/social-manifest.mjs', 'facebook-publish/scripts/publish-facebook.mjs', 'instagram-publish/scripts/publish-instagram.mjs', 'youtube-publish/scripts/publish-youtube.mjs'];
  for (const file of files) {
    mkdirSync(join(skills, file, '..'), { recursive: true });
    writeFileSync(join(skills, file), STUB);
  }
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'gh'), `#!/usr/bin/env bash\necho "gh $*" >> "$STUB_CALLS.gh"\necho 'issue body'\n`);
  chmodSync(join(bin, 'gh'), 0o755);
  const calls = join(dir, 'calls');
  writeFileSync(calls, '');
  const run = (env, file = script) => {
    const result = spawnSync('bash', [file], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, STUB_CALLS: calls, STUB_PLATFORM: platform, SOCIAL_PLATFORM: platform, SOCIAL_ISSUE: '7', SOCIAL_SKILLS_DIR: skills, SOCIAL_WORK_DIR: join(dir, 'work'), GITHUB_OUTPUT: join(dir, 'output'), ...env }
    });
    const lines = readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
    return { ...result, calls: lines, work: join(dir, 'work', '7') };
  };
  return { dir, run };
}

describe('publish.sh', () => {
  it('approves and publishes a YouTube batch right away', () => {
    const { run } = setup('youtube');
    const result = run({ SOCIAL_MODE: 'approve', SOCIAL_COMMENT_ID: '55', INSTAGRAM_MEDIA_PREFIX: '', YOUTUBE_DAILY_UPLOAD_LIMIT: '' });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.calls.map(([name, command]) => `${name} ${command}`), [
      'social-review/scripts/review-batch.mjs approve',
      'social-review/scripts/review-batch.mjs fetch',
      'youtube-publish/scripts/publish-youtube.mjs ' + join(result.work, 'manifest.json')
    ]);
    assert.deepEqual(result.calls[2].slice(2), ['--execute']);
    assert.deepEqual(JSON.parse(readFileSync(join(result.work, '..', '..', 'calls.env'), 'utf8')), { prefix: null, limit: null });
    assert.match(readFileSync(join(result.work, 'publisher.log'), 'utf8'), /scheduled: a 1/);
    assert.equal(JSON.parse(readFileSync(join(result.work, 'before.json'), 'utf8')).approval.status, 'approved');
  });

  it('only validates and records an Instagram approval', () => {
    const { run } = setup('instagram');
    const result = run({ SOCIAL_MODE: 'approve', SOCIAL_COMMENT_ID: '55' });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.calls.map(([name, command]) => `${name} ${command}`), ['social-review/scripts/review-batch.mjs approve', 'social-review/scripts/social-manifest.mjs validate']);
    assert.deepEqual(result.calls[1].slice(3), ['--for-publish', '--no-files']);
    assert.equal(existsSync(join(result.work, 'manifest.json')), true);
  });

  it('does not record an Instagram approval that fails validation', () => {
    const { run } = setup('instagram');
    const result = run({ SOCIAL_MODE: 'approve', SOCIAL_COMMENT_ID: '55', STUB_FAIL: 'validate' });
    assert.equal(result.status, 1);
    assert.equal(existsSync(join(result.work, 'manifest.json')), false);
    assert.match(readFileSync(join(result.work, 'publisher.log'), 'utf8'), /validate failed: reason/);
  });

  it('logs a refused approval for the issue report', () => {
    const { run } = setup('facebook');
    const result = run({ SOCIAL_MODE: 'approve', SOCIAL_COMMENT_ID: '55', STUB_FAIL: 'approve' });
    assert.equal(result.status, 1);
    assert.equal(existsSync(join(result.work, 'manifest.json')), false);
    assert.match(readFileSync(join(result.work, 'publisher.log'), 'utf8'), /approve failed: reason/);
    assert.match(readFileSync(join(result.work, '..', '..', 'output'), 'utf8'), /^manifest=.*\/7\/manifest\.json$/m);
  });

  it('restores the marker and publishes one Instagram item per sweep', () => {
    const { run } = setup('instagram');
    const result = run({ SOCIAL_MODE: 'sweep', SOCIAL_INSTAGRAM_MAX: '2', SOCIAL_RETRY: 'a' });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.calls.map(([name, command]) => `${name} ${command}`).slice(0, 2), ['social-review/scripts/review-batch.mjs marker', 'social-review/scripts/review-batch.mjs fetch']);
    assert.deepEqual(result.calls[2].slice(2), ['--execute', '--max', '2']);
    assert.match(result.stdout, /retry is ignored/);
  });

  it('passes retry ids to Facebook and keeps the publisher exit code', () => {
    const { run } = setup('facebook');
    const result = run({ SOCIAL_MODE: 'resume', SOCIAL_RETRY: 'a,b', STUB_PUBLISH: '1' });
    assert.equal(result.status, 1);
    assert.deepEqual(result.calls[2].slice(2), ['--execute', '--retry', 'a,b']);
    assert.equal(existsSync(join(result.work, 'manifest.json')), true);
  });

  it('rejects unsafe values before doing anything', () => {
    const { run } = setup('facebook');
    for (const env of [{ SOCIAL_MODE: 'publish' }, { SOCIAL_MODE: 'resume', SOCIAL_RETRY: 'a;b' }, { SOCIAL_MODE: 'resume', SOCIAL_ISSUE: '7x' }, { SOCIAL_MODE: 'approve', SOCIAL_COMMENT_ID: 'x' }, { SOCIAL_MODE: 'sweep', SOCIAL_INSTAGRAM_MAX: '0' }]) {
      const result = run(env);
      assert.equal(result.status, 1, JSON.stringify(env));
      assert.equal(result.calls.length, 0);
    }
  });

  it('saves the state into the issue body, and skips a batch that was never restored', () => {
    const { dir, run } = setup('youtube');
    const saveScript = join(here, 'save-state.sh');
    const manifest = join(dir, 'manifest.json');
    writeFileSync(manifest, '{}');
    const saved = run({ SOCIAL_MANIFEST: manifest }, saveScript);
    assert.equal(saved.status, 0, saved.stderr);
    assert.deepEqual(saved.calls[0].slice(1), ['issue-body', manifest]);
    assert.equal(readFileSync(join(dir, 'issue-body.md'), 'utf8'), `BODY ${manifest}\n`);
    assert.match(readFileSync(join(dir, 'calls.gh'), 'utf8'), /gh issue edit 7 --body-file .*issue-body\.md/);
    const skipped = run({ SOCIAL_MANIFEST: join(dir, 'missing.json') }, saveScript);
    assert.equal(skipped.status, 0);
    assert.match(skipped.stdout, /issue body is unchanged/);
    assert.equal(skipped.calls.length, 1);
  });
});
