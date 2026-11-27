import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  adjustLock,
  buildPrompt,
  canWrite,
  decodeMarker,
  gateDecision,
  isCommand,
  isDate,
  isPublishable,
  isRepoPath,
  oauthHint,
  loggedIds,
  mergeState,
  parseHeader,
  parsePlatforms,
  pendingIssues,
  summarize
} from './social-content.mjs';
import { bodyOf, header, manifestOf, marker } from './test-helpers.mjs';

describe('parsePlatforms', () => {
  it('accepts spaces and commas, lowercases, and removes duplicates', () => {
    assert.deepEqual(parsePlatforms('YouTube, facebook  instagram,facebook'), { platforms: ['youtube', 'facebook', 'instagram'], errors: [] });
  });

  it('accepts linkedin', () => {
    assert.deepEqual(parsePlatforms('linkedin facebook'), { platforms: ['linkedin', 'facebook'], errors: [] });
  });

  it('rejects unknown and empty lists', () => {
    assert.match(parsePlatforms('facebook tiktok').errors[0], /Unknown platform 'tiktok'/);
    assert.match(parsePlatforms(' ').errors[0], /No platform given/);
  });
});

describe('isCommand', () => {
  it('needs the command followed by whitespace or the end', () => {
    assert.equal(isCommand('/aprove', '/aprove'), true);
    assert.equal(isCommand('  /APROVE\nthanks', '/aprove'), true);
    assert.equal(isCommand('/adjust a: shorter title', '/adjust'), true);
    assert.equal(isCommand('/aproved', '/aprove'), false);
    assert.equal(isCommand('please /aprove', '/aprove'), false);
    assert.equal(isCommand('', '/aprove'), false);
    assert.equal(isCommand('/aprove', ''), false);
  });
});

describe('markers', () => {
  it('parses the batch header', () => {
    assert.deepEqual(parseHeader(`x\n${header('youtube', '2026-12-01-youtube', 3)}`), { platform: 'youtube', batch: '2026-12-01-youtube', revision: 3 });
    assert.equal(parseHeader('no header'), null);
  });

  it('decodes the last manifest marker and survives corrupt ones', () => {
    const first = manifestOf({ batch_id: 'old' });
    const last = manifestOf({ batch_id: 'new' });
    assert.equal(decodeMarker(`${marker(first)}\n${marker(last)}`).batch_id, 'new');
    assert.equal(decodeMarker('<!-- social-content-manifest:v1:bm90Z3ppcA== -->'), null);
    assert.equal(decodeMarker('nothing'), null);
  });
});

describe('canWrite', () => {
  it('accepts write, maintain, and admin from role_name, then permission', () => {
    assert.equal(canWrite({ role_name: 'maintain', permission: 'write' }), true);
    assert.equal(canWrite({ permission: 'admin' }), true);
    assert.equal(canWrite({ role_name: 'triage', permission: 'read' }), false);
    assert.equal(canWrite(null), false);
  });
});

describe('gateDecision', () => {
  const manifest = manifestOf();
  const issue = { number: 7, state: 'open', labels: [{ name: 'marketing-content' }], body: bodyOf(manifest) };
  const comment = { body: '/aprove', user: { login: 'ana', type: 'User' }, issue_url: 'https://api.github.com/repos/o/r/issues/7' };
  const base = { comment, issue, permission: { role_name: 'write' }, command: '/aprove', label: 'marketing-content', issueNumber: 7 };

  it('allows a writer on a labeled review issue', () => {
    assert.deepEqual(gateDecision(base), { allowed: true, kind: '', reason: '', platform: 'instagram', batch: '2026-11-30-instagram', revision: 1 });
  });

  it('refuses bots, readers, and other commands as commenter problems', () => {
    assert.equal(gateDecision({ ...base, comment: { ...comment, user: { login: 'helper[bot]', type: 'Bot' } } }).kind, 'commenter');
    assert.equal(gateDecision({ ...base, comment: { ...comment, user: { login: 'app[bot]', type: 'User' } } }).kind, 'commenter');
    assert.match(gateDecision({ ...base, permission: { role_name: 'triage' } }).reason, /no write/);
    assert.match(gateDecision({ ...base, permission: null }).reason, /no write/);
    assert.match(gateDecision({ ...base, comment: { ...comment, body: '/adjust a: x' } }).reason, /does not start with \/aprove/);
    assert.equal(gateDecision({ ...base, comment: null }).kind, 'commenter');
  });

  it('stays quiet on unrelated issues', () => {
    assert.equal(gateDecision({ ...base, issue: { ...issue, labels: [], body: 'plain issue' } }).kind, 'unrelated');
  });

  it('refuses closed, unlabeled, headerless, and inconsistent review issues', () => {
    assert.match(gateDecision({ ...base, issue: { ...issue, state: 'closed' } }).reason, /is closed/);
    assert.match(gateDecision({ ...base, issue: { ...issue, labels: ['other'] } }).reason, /does not have the marketing-content label/);
    assert.match(gateDecision({ ...base, issue: { ...issue, body: marker(manifest) } }).reason, /no social content batch header/);
    assert.match(gateDecision({ ...base, issue: { ...issue, body: header('instagram', manifest.batch_id) } }).reason, /no readable manifest marker/);
    assert.match(gateDecision({ ...base, issue: { ...issue, body: `${header('instagram', 'other')}\n${marker(manifest)}` } }).reason, /disagree/);
    assert.match(gateDecision({ ...base, issue: { ...issue, body: `${header('tiktok', 'x')}\n${marker(manifest)}` } }).reason, /unknown platform/);
    assert.match(gateDecision({ ...base, issue: { ...issue, pull_request: {} } }).reason, /pull request/);
    assert.match(gateDecision({ ...base, comment: { ...comment, issue_url: 'https://api.github.com/repos/o/r/issues/8' } }).reason, /not on issue #7/);
    assert.match(gateDecision({ ...base, issue: null }).reason, /not found/);
  });

  it('refuses an adjust on an approved or partly published batch, and allows it otherwise', () => {
    const adjust = { ...base, command: '/adjust', comment: { ...comment, body: '/adjust a: shorter' }, adjust: true };
    assert.equal(gateDecision(adjust).allowed, true);
    const approved = manifestOf({ approval: { status: 'approved', by: 'ana', revision: 1 } });
    const refused = gateDecision({ ...adjust, issue: { ...issue, body: bodyOf(approved) } });
    assert.equal(refused.kind, 'issue');
    assert.match(refused.reason, /revision 1 is already approved by ana/);
    for (const status of ['scheduled', 'published', 'unknown']) {
      const started = manifestOf({ state: { a: { status } } });
      assert.match(gateDecision({ ...adjust, issue: { ...issue, body: bodyOf(started) } }).reason, new RegExp(`already being published \\(a \\(${status}\\)\\)`));
    }
    const failed = manifestOf({ state: { a: { status: 'failed', error: 'x' } } });
    assert.equal(gateDecision({ ...adjust, issue: { ...issue, body: bodyOf(failed) } }).allowed, true);
    assert.equal(gateDecision({ ...base, issue: { ...issue, body: bodyOf(approved) } }).allowed, true);
  });

  it('names no lock for a pending batch', () => {
    assert.equal(adjustLock(manifestOf()), null);
    assert.equal(adjustLock(null), null);
  });

  it('matches the label case-insensitively', () => {
    assert.equal(gateDecision({ ...base, issue: { ...issue, labels: ['Marketing-Content'] } }).allowed, true);
  });
});

describe('buildPrompt', () => {
  const base = { platform: 'youtube', label: 'marketing-content' };

  it('builds the generate prompt with start and profile', () => {
    const result = buildPrompt({ ...base, mode: 'generate', start: '2026-12-07', profile: 'docs/ai/social.md', driveRoot: 'Brand Media', instructions: 'Focus on reports.' });
    assert.deepEqual(result.errors, []);
    assert.equal(result.prompt, 'generate start 2026-12-07 profile docs/ai/social.md');
    assert.match(result.instructions, /non-interactive/);
    assert.match(result.instructions, /Platform: YouTube only\./);
    assert.match(result.instructions, /--root "Brand Media"/);
    assert.match(result.instructions, /Focus on reports\.$/);
  });

  it('builds the adjust prompt and ignores start', () => {
    const result = buildPrompt({ ...base, mode: 'adjust', issue: '42', start: '2026-12-07', profile: 'docs/ai/social-content.md' });
    assert.equal(result.prompt, 'adjust 42 profile docs/ai/social-content.md');
    assert.doesNotMatch(result.instructions, /Drive root/);
  });

  it('rejects unsafe values', () => {
    assert.match(buildPrompt({ ...base, mode: 'publish' }).errors[0], /Unknown mode/);
    assert.match(buildPrompt({ ...base, mode: 'generate', start: '2026-02-30' }).errors[0], /YYYY-MM-DD/);
    assert.match(buildPrompt({ ...base, mode: 'generate', profile: '../secrets.md' }).errors[0], /relative path/);
    assert.match(buildPrompt({ ...base, mode: 'generate', profile: 'docs/a b.md' }).errors[0], /relative path/);
    assert.match(buildPrompt({ ...base, mode: 'adjust', issue: 'x' }).errors[0], /issue number/);
    assert.match(buildPrompt({ ...base, mode: 'generate', driveRoot: 'a"; rm -rf /' }).errors[0], /drive-root/);
    assert.match(buildPrompt({ ...base, mode: 'generate', label: 'a\nb' }).errors[0], /label/);
    assert.match(buildPrompt({ ...base, mode: 'generate', platform: 'tiktok' }).errors[0], /Unknown platform/);
  });
});

describe('isDate and isRepoPath', () => {
  it('checks real calendar dates and safe relative paths', () => {
    assert.equal(isDate('2028-02-29'), true);
    assert.equal(isDate('2027-02-29'), false);
    assert.equal(isRepoPath('docs/ai/social-content.md'), true);
    assert.equal(isRepoPath('/etc/passwd'), false);
    assert.equal(isRepoPath('docs/../x'), false);
  });
});

describe('pendingIssues', () => {
  const approved = (overrides = {}) => manifestOf({ approval: { status: 'approved', by: 'ana', at: '2026-11-28T10:00:00Z', revision: 1 }, ...overrides });
  const issueFor = (number, manifest, extra = {}) => ({ number, state: 'open', labels: ['marketing-content'], body: bodyOf(manifest), ...extra });

  it('keeps approved batches of the platform with items left, oldest first', () => {
    const issues = [
      issueFor(9, approved()),
      issueFor(3, approved({ state: { a: { status: 'published' } } })),
      issueFor(4, approved({ state: { a: { status: 'published' }, b: { status: 'skipped' } } })),
      issueFor(5, manifestOf()),
      issueFor(6, approved({ platform: 'youtube', batch_id: 'y' })),
      issueFor(8, approved(), { labels: [] }),
      issueFor(10, approved(), { pull_request: {} })
    ];
    assert.deepEqual(pendingIssues(issues, { platform: 'instagram', label: 'marketing-content' }), [3, 9]);
  });

  it('skips an approval for another revision', () => {
    const stale = approved({ review: { revision: 2 } });
    assert.equal(isPublishable(stale, { revision: 2 }), false);
    const current = approved({ review: { revision: 2 }, approval: { status: 'approved', revision: 2 } });
    assert.equal(isPublishable(current, { revision: 2 }), true);
    assert.equal(isPublishable(current, { revision: 3 }), false);
  });
});

describe('summarize', () => {
  const manifest = manifestOf({
    platform: 'youtube',
    items: [{ id: 'a', type: 'short', publish_at: '2026-12-01T10:00:00-03:00' }, { id: 'b', type: 'short', publish_at: '2026-11-20T10:00:00-03:00' }, { id: 'c', type: 'video', publish_at: '2026-12-02T10:00:00-03:00' }],
    state: { a: { status: 'scheduled', url: 'https://youtu.be/1', remote_id: '1' }, c: { status: 'failed', error: 'quota | 403' } }
  });

  it('reports statuses, stale and manual items, and incompleteness', () => {
    const result = summarize({ manifest, before: { state: {} }, log: 'scheduled: a 1\nstale: b publish_at passed\nquota exceeded for today\n', outcome: 'failure', runUrl: 'https://run' });
    assert.deepEqual(result.items.map((item) => item.status), ['scheduled', 'stale', 'failed']);
    assert.equal(result.complete, false);
    assert.equal(result.changed, true);
    assert.deepEqual(result.stale, ['b']);
    assert.match(result.body, /### YouTube publishing failed/);
    assert.match(result.body, /\[open\]\(https:\/\/youtu\.be\/1\)/);
    assert.match(result.body, /quota \\\| 403/);
    assert.match(result.body, /- quota exceeded for today/);
    assert.match(result.body, /\[Workflow run\]\(https:\/\/run\)/);
    assert.match(result.body, /manual run of the publish workflow/);
  });

  it('is complete when every item is done or stale', () => {
    const done = { ...manifest, state: { a: { status: 'scheduled' }, c: { status: 'published' } } };
    const result = summarize({ manifest: done, before: done, log: 'stale: b x' });
    assert.equal(result.complete, true);
    assert.equal(result.changed, false);
    assert.match(result.body, /this issue is closed/);
  });

  it('flags items that need a manual check', () => {
    const unknown = { ...manifest, state: { a: { status: 'unknown' } } };
    const result = summarize({ manifest: unknown, log: 'needs a manual check: a (no response)' });
    assert.deepEqual(result.manual, ['a']);
    assert.equal(result.complete, false);
    assert.match(result.body, /Check `a` on the platform/);
  });

  it('explains an invalid_grant and keeps LinkedIn notes', () => {
    const result = summarize({ manifest: { ...manifest, platform: 'linkedin' }, log: 'LinkedIn OAuth 400: invalid_grant (expired)\ncall budget reached (run 98/100, 24 h 98/500): a waits for the next run', outcome: 'failure' });
    assert.match(result.body, /^### LinkedIn publishing failed/);
    assert.match(result.body, /The LinkedIn refresh token was rejected \(`invalid_grant`\)/);
    assert.match(result.body, /- call budget reached/);
    assert.match(result.body, /The next scheduled run retries failed items/);
    assert.equal(oauthHint('all good'), '');
  });

  it('reads ids after a log prefix', () => {
    assert.deepEqual([...loggedIds('stale: x y\nstale:\nother: z\nstale: w', 'stale:')], ['x', 'w']);
  });
});

describe('mergeState', () => {
  const base = manifestOf({ approval: { status: 'approved', by: 'ana', revision: 1 }, state: { a: { status: 'published', remote_id: '1' } } });

  it('keeps a concurrent run and takes only what this run changed', () => {
    const ours = { ...base, state: { a: base.state.a, b: { status: 'published', remote_id: '2' } } };
    const live = { ...base, state: { a: { status: 'published', remote_id: '1' }, c: { status: 'failed', error: 'x' } } };
    const result = mergeState({ ours, before: base, live });
    assert.equal(result.action, 'write');
    assert.deepEqual(result.changed, ['b']);
    assert.deepEqual(Object.keys(result.manifest.state).sort(), ['a', 'b', 'c']);
  });

  it('does not overwrite a newer entry with an untouched old one', () => {
    const live = { ...base, state: { a: { status: 'published', remote_id: '1', url: 'u' } } };
    const result = mergeState({ ours: base, before: base, live });
    assert.equal(result.action, 'unchanged');
    assert.equal(result.manifest.state.a.url, 'u');
  });

  it('records an approval this run stamped', () => {
    const pending = manifestOf();
    const ours = { ...pending, approval: { status: 'approved', by: 'ana', revision: 1 } };
    const result = mergeState({ ours, before: ours, live: pending });
    assert.equal(result.action, 'write');
    assert.equal(result.manifest.approval.by, 'ana');
  });

  it('refuses to write over another revision, batch, or a missing marker', () => {
    const bumped = { ...base, approval: { status: 'pending', revision: null }, review: { issue_number: 7, revision: 2 } };
    assert.match(mergeState({ ours: base, before: base, live: bumped }).reason, /revision 2 while this run published revision 1/);
    assert.equal(mergeState({ ours: base, before: base, live: { ...base, batch_id: 'other' } }).action, 'conflict');
    assert.equal(mergeState({ ours: base, before: base, live: null }).action, 'conflict');
  });

  it('ignores state for items the live batch no longer has', () => {
    const ours = { ...base, state: { ...base.state, gone: { status: 'published' } } };
    assert.equal(mergeState({ ours, before: base, live: base }).action, 'unchanged');
  });
});
