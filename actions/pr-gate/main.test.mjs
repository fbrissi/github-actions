import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { envName, fixFinish, fixGate, fixRecord, mergeGate, mergeRecord, readContext } from './main.mjs';

const REPO = 'octo/app';
const HEAD = 'a'.repeat(40);
const OLD = 'b'.repeat(40);

function fakeApi(routes, threads = []) {
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
    },
    async graphql() {
      return { repository: { pullRequest: { reviewThreads: { nodes: threads, pageInfo: { hasNextPage: false, endCursor: null } } } } };
    }
  };
  return api;
}

const ctxFor = (values) => readContext({
  ...Object.fromEntries(Object.entries(values).map(([name, value]) => [envName(name), value])),
  GITHUB_REPOSITORY: REPO,
  GITHUB_RUN_ID: '42'
});

const pull = (overrides = {}) => ({
  number: 7,
  state: 'open',
  draft: false,
  labels: [],
  mergeable: true,
  mergeable_state: 'clean',
  user: { login: 'agent[bot]', type: 'Bot' },
  head: { ref: 'feat/jira-dev-1-login', sha: HEAD, repo: { full_name: REPO } },
  base: { ref: 'feat/jira-dev-1', sha: OLD },
  ...overrides
});
const bot = (body, at = '2026-01-02T00:00:00Z') => ({ user: { login: 'fixer[bot]', type: 'Bot' }, body, created_at: at });

function fixRepo({ pr = pull(), comments = [], reviews = [], reviewComments = [] } = {}) {
  return fakeApi([
    ['GET', /^\/repos\/octo\/app\/pulls\/7$/, pr],
    ['GET', /^\/repos\/octo\/app\/issues\/7\/comments$/, comments],
    ['GET', /^\/repos\/octo\/app\/pulls\/7\/reviews$/, reviews],
    ['GET', /^\/repos\/octo\/app\/pulls\/7\/comments$/, reviewComments],
    ['POST', /^\/repos\/octo\/app\/check-runs$/, { id: 99 }],
    ['PATCH', /^\/repos\/octo\/app\/check-runs\/99$/, {}],
    ['POST', /^\/repos\/octo\/app\/issues\/7\/comments$/, {}]
  ]);
}

describe('fix-gate', () => {
  const base = { 'pr-number': '7', 'branch-prefixes': 'feat/', 'max-rounds': '3', 'escalation-label': 'ai:needs-human', 'opt-in-label': 'ai:auto-fix' };

  it('starts a pass and a check run on an opted-in pull request', async () => {
    const api = fixRepo();
    const result = await fixGate(ctxFor(base), api);
    assert.equal(result.outputs.action, 'fix');
    assert.equal(result.outputs.round, '1');
    assert.equal(result.outputs.check_run_id, '99');
    assert.equal(result.outputs.head_ref, 'feat/jira-dev-1-login');
    assert.match(api.calls.find((call) => call.method === 'POST').body.details_url, /actions\/runs\/42$/);
  });

  it('skips pull requests that are not opted in, drafts, and forks', async () => {
    assert.equal((await fixGate(ctxFor({ ...base, 'branch-prefixes': 'ai/' }), fixRepo())).outputs.action, 'skip');
    assert.equal((await fixGate(ctxFor(base), fixRepo({ pr: pull({ draft: true }) }))).outputs.action, 'skip');
    const fork = pull({ head: { ref: 'feat/x', sha: HEAD, repo: { full_name: 'other/app' } } });
    assert.equal((await fixGate(ctxFor(base), fixRepo({ pr: fork }))).outputs.action, 'skip');
  });

  it('skips while the escalation label is present', async () => {
    const result = await fixGate(ctxFor(base), fixRepo({ pr: pull({ labels: [{ name: 'ai:needs-human' }] }) }));
    assert.equal(result.outputs.action, 'skip');
    assert.match(result.summary[0], /ai:needs-human/);
  });

  it('skips a second pass on the same head without new feedback', async () => {
    const comments = [bot(`<!-- pr-fix round=1 head=${HEAD} -->`)];
    const result = await fixGate(ctxFor(base), fixRepo({ comments }));
    assert.equal(result.outputs.action, 'skip');
    assert.match(result.summary[0], /no new feedback/);
  });

  it('runs again on the same head when someone else commented since', async () => {
    const comments = [bot(`<!-- pr-fix round=1 head=${HEAD} -->`)];
    const reviews = [{ user: { login: 'alice' }, submitted_at: '2026-01-03T00:00:00Z' }];
    const result = await fixGate(ctxFor(base), fixRepo({ comments, reviews }));
    assert.equal(result.outputs.action, 'fix');
    assert.equal(result.outputs.round, '2');
  });

  it('escalates after max-rounds and ignores markers people posted', async () => {
    const comments = [
      bot(`<!-- pr-fix round=1 head=${OLD} -->`),
      bot(`<!-- pr-fix round=2 head=${OLD} -->`),
      bot(`<!-- pr-fix round=3 head=${OLD} -->`),
      { user: { login: 'mallory', type: 'User' }, body: `<!-- pr-fix escalated -->`, created_at: '2026-01-05T00:00:00Z' }
    ];
    const result = await fixGate(ctxFor(base), fixRepo({ comments }));
    assert.equal(result.outputs.action, 'escalate');
    assert.equal(result.outputs.round, '4');
  });

  it('counts rounds again after a bot escalation', async () => {
    const comments = [
      bot(`<!-- pr-fix round=1 head=${OLD} -->`, '2026-01-01T00:00:00Z'),
      bot('<!-- pr-fix escalated -->\nhandoff', '2026-01-02T00:00:00Z')
    ];
    const result = await fixGate(ctxFor(base), fixRepo({ comments }));
    assert.equal(result.outputs.action, 'fix');
    assert.equal(result.outputs.round, '1');
  });

  it('rejects an invalid pull request number', async () => {
    await assert.rejects(fixGate(ctxFor({ ...base, 'pr-number': 'x' }), fixRepo()), /Invalid pull request number/);
  });
});

describe('fix-record and fix-finish', () => {
  it('records the round marker the gate counts', async () => {
    const api = fixRepo();
    await fixRecord(ctxFor({ 'pr-number': '7', round: '2', 'max-rounds': '3', 'start-sha': HEAD, outcome: 'success' }), api);
    const body = api.calls.at(-1).body.body;
    assert.match(body, new RegExp(`<!-- pr-fix round=2 head=${HEAD} -->`));
    assert.match(body, /round 2 of 3/);
  });

  it('refuses a start sha that is not a commit', async () => {
    await assert.rejects(fixRecord(ctxFor({ 'pr-number': '7', 'start-sha': 'main' }), fixRepo()), /full commit SHA/);
  });

  it('completes the check run from the fix result', async () => {
    const api = fixRepo();
    await fixFinish(ctxFor({ result: 'failure', 'check-run-id': '99', 'check-name': 'PR Fix' }), api);
    assert.equal(api.calls.at(-1).body.conclusion, 'failure');
    await fixFinish(ctxFor({ result: 'success', 'check-run-id': '99' }), api);
    assert.equal(api.calls.at(-1).body.conclusion, 'success');
  });
});

function mergeRepo({ pr = pull(), runs = [], checks = [], status = { total_count: 0, state: 'pending' }, reviews = [], comments = [], threads = [] } = {}) {
  return fakeApi([
    ['GET', /^\/repos\/octo\/app\/pulls\/7$/, pr],
    ['GET', /^\/repos\/octo\/app\/actions\/runs\?head_sha=/, { workflow_runs: runs }],
    ['GET', /^\/repos\/octo\/app\/commits\/[0-9a-f]+\/check-runs/, { check_runs: checks }],
    ['GET', /^\/repos\/octo\/app\/commits\/[0-9a-f]+\/status$/, status],
    ['GET', /^\/repos\/octo\/app\/pulls\/7\/reviews$/, reviews],
    ['GET', /^\/repos\/octo\/app\/issues\/7\/comments$/, comments],
    ['POST', /^\/repos\/octo\/app\/issues\/7\/comments$/, {}]
  ], threads);
}

const approval = (login, type = 'User', commit = HEAD) => ({ user: { login, type }, state: 'APPROVED', commit_id: commit });
const noSleep = async () => {};

describe('merge-gate', () => {
  const base = { 'pr-number': '7', 'branch-prefixes': 'feat/', 'required-human-approvals': '1', 'hold-labels': 'hold' };

  it('decides on a task pull request into an exempt base without human approvals', async () => {
    const result = await mergeGate(ctxFor({ ...base, 'human-approval-exempt-base-prefixes': 'feat/' }), mergeRepo(), noSleep);
    assert.equal(result.outputs.action, 'decide');
    assert.equal(result.outputs.required_approvals, '0');
    assert.equal(result.outputs.head_sha, HEAD);
    assert.equal(result.outputs.base_sha, OLD);
  });

  it('keeps human approval for a person, or an author not listed, into an exempt base', async () => {
    const human = pull({ user: { login: 'alice', type: 'User' } });
    const ctx = ctxFor({ ...base, 'human-approval-exempt-base-prefixes': 'feat/' });
    assert.equal((await mergeGate(ctx, mergeRepo({ pr: human }), noSleep)).outputs.required_approvals, '1');
    const listed = ctxFor({ ...base, 'human-approval-exempt-base-prefixes': 'feat/', 'human-approval-exempt-authors': 'other[bot]' });
    assert.equal((await mergeGate(listed, mergeRepo(), noSleep)).outputs.required_approvals, '1');
    const agent = ctxFor({ ...base, 'human-approval-exempt-base-prefixes': 'feat/', 'human-approval-exempt-authors': 'Agent[bot]' });
    assert.equal((await mergeGate(agent, mergeRepo(), noSleep)).outputs.required_approvals, '0');
  });

  it('requests a review when a pull request into the default branch lacks a human approval', async () => {
    const pr = pull({ head: { ref: 'feat/jira-dev-1', sha: HEAD, repo: { full_name: REPO } }, base: { ref: 'master', sha: OLD } });
    const result = await mergeGate(ctxFor({ ...base, 'human-approval-exempt-base-prefixes': 'feat/' }), mergeRepo({ pr, reviews: [approval('agent[bot]', 'Bot')] }), noSleep);
    assert.equal(result.outputs.action, 'skip');
    assert.equal(result.outputs.request_review, 'true');
    assert.equal(result.outputs.required_approvals, '1');
  });

  it('decides once a human approved the head commit', async () => {
    const pr = pull({ base: { ref: 'master', sha: OLD } });
    const result = await mergeGate(ctxFor(base), mergeRepo({ pr, reviews: [approval('alice')] }), noSleep);
    assert.equal(result.outputs.action, 'decide');
  });

  it('ignores an approval of an older commit', async () => {
    const pr = pull({ base: { ref: 'master', sha: OLD } });
    const result = await mergeGate(ctxFor(base), mergeRepo({ pr, reviews: [approval('alice', 'User', OLD)] }), noSleep);
    assert.equal(result.outputs.request_review, 'true');
  });

  it('skips on hold labels, foreign prefixes, conflicts, and changes requested', async () => {
    assert.equal((await mergeGate(ctxFor(base), mergeRepo({ pr: pull({ labels: [{ name: 'hold' }] }) }), noSleep)).outputs.action, 'skip');
    assert.equal((await mergeGate(ctxFor({ ...base, 'branch-prefixes': 'ai/' }), mergeRepo(), noSleep)).outputs.action, 'skip');
    assert.equal((await mergeGate(ctxFor(base), mergeRepo({ pr: pull({ mergeable: false }) }), noSleep)).outputs.action, 'skip');
    const reviews = [{ user: { login: 'alice', type: 'User' }, state: 'CHANGES_REQUESTED', commit_id: HEAD }];
    const result = await mergeGate(ctxFor({ ...base, 'human-approval-exempt-base-prefixes': 'feat/' }), mergeRepo({ reviews }), noSleep);
    assert.match(result.summary[0], /changes requested by alice/);
  });

  it('waits for checks but ignores those of dispatcher runs', async () => {
    const ctx = ctxFor({ ...base, 'human-approval-exempt-base-prefixes': 'feat/' });
    const pending = await mergeGate(ctx, mergeRepo({ checks: [{ name: 'CI', status: 'in_progress', check_suite: { id: 1 } }] }), noSleep);
    assert.match(pending.summary[0], /checks still running/);
    const dispatcher = await mergeGate(ctx, mergeRepo({
      runs: [{ event: 'pull_request_review', check_suite_id: 2 }],
      checks: [{ name: 'PR Feedback', status: 'in_progress', check_suite: { id: 2 } }, { name: 'CI', status: 'completed', conclusion: 'success', check_suite: { id: 1 } }]
    }), noSleep);
    assert.equal(dispatcher.outputs.action, 'decide');
    const failed = await mergeGate(ctx, mergeRepo({ checks: [{ name: 'CI', status: 'completed', conclusion: 'failure', check_suite: { id: 1 } }] }), noSleep);
    assert.match(failed.summary[0], /CI \(failure\)/);
  });

  it('skips with unresolved threads or a decision already recorded for the head', async () => {
    const ctx = ctxFor({ ...base, 'human-approval-exempt-base-prefixes': 'feat/' });
    assert.match((await mergeGate(ctx, mergeRepo({ threads: [{ isResolved: false }] }), noSleep)).summary[0], /1 unresolved/);
    const comments = [bot(`<!-- merge-decision head=${HEAD} -->`)];
    assert.match((await mergeGate(ctx, mergeRepo({ comments }), noSleep)).summary[0], /already made/);
  });

  it('retries while GitHub computes mergeability', async () => {
    let calls = 0;
    const api = fakeApi([
      ['GET', /^\/repos\/octo\/app\/pulls\/7$/, () => (++calls < 3 ? pull({ mergeable: null }) : pull())],
      ['GET', /^\/repos\/octo\/app\/actions\/runs\?head_sha=/, { workflow_runs: [] }],
      ['GET', /^\/repos\/octo\/app\/commits\/[0-9a-f]+\/check-runs/, { check_runs: [] }],
      ['GET', /^\/repos\/octo\/app\/commits\/[0-9a-f]+\/status$/, { total_count: 0 }],
      ['GET', /^\/repos\/octo\/app\/pulls\/7\/reviews$/, []],
      ['GET', /^\/repos\/octo\/app\/issues\/7\/comments$/, []]
    ]);
    const result = await mergeGate(ctxFor({ ...base, 'human-approval-exempt-base-prefixes': 'feat/' }), api, noSleep);
    assert.equal(calls, 3);
    assert.equal(result.outputs.action, 'decide');
  });

  it('records the decision marker for the head', async () => {
    const api = mergeRepo();
    await mergeRecord(ctxFor({ 'pr-number': '7', 'head-sha': HEAD }), api);
    assert.match(api.calls.at(-1).body.body, new RegExp(`<!-- merge-decision head=${HEAD} -->`));
  });
});
