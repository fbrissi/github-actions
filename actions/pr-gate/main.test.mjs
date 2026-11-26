import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { envName, feedbackDispatch, fixFinish, fixGate, fixRecord, isCleanGrade, mergeDispatch, mergeGate, mergeOutcome, mergeRecord, parseMergeOutcome, readContext } from './main.mjs';

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

describe('merge-dispatch', () => {
  const dispatchRepo = (dispatch = {}) => fakeApi([
    ['GET', /^\/repos\/octo\/app$/, { default_branch: 'main' }],
    ['POST', /^\/repos\/octo\/app\/actions\/workflows\/merge-decision\.yml\/dispatches$/, dispatch]
  ]);

  it('dispatches the merge workflow on the default branch', async () => {
    const api = dispatchRepo();
    const result = await mergeDispatch(ctxFor({ 'pr-number': '#7', 'merge-workflow': 'merge-decision.yml' }), api);
    assert.deepEqual(api.calls.at(-1).body, { ref: 'main', inputs: { pr_number: '7' } });
    assert.match(result.summary[0], /Dispatched merge-decision\.yml for PR #7/);
  });

  it('dispatches nothing without a merge workflow', async () => {
    const api = dispatchRepo();
    const result = await mergeDispatch(ctxFor({ 'pr-number': '7' }), api);
    assert.equal(api.calls.length, 0);
    assert.match(result.summary[0], /No merge workflow/);
  });

  it('skips with a notice when the workflow is not on the default branch', async () => {
    const api = fakeApi([['GET', /^\/repos\/octo\/app$/, { default_branch: 'main' }]]);
    const result = await mergeDispatch(ctxFor({ 'pr-number': '7', 'merge-workflow': 'merge-decision.yml' }), api);
    assert.match(result.notice, /not on main/);
  });

  it('fails on dispatch errors other than a missing workflow', async () => {
    const api = dispatchRepo(() => { throw Object.assign(new Error('boom'), { status: 500 }); });
    await assert.rejects(mergeDispatch(ctxFor({ 'pr-number': '7', 'merge-workflow': 'merge-decision.yml' }), api), /boom/);
  });

  it('refuses a workflow that is not a file name', async () => {
    await assert.rejects(mergeDispatch(ctxFor({ 'pr-number': '7', 'merge-workflow': '../x.yml' }), dispatchRepo()), /workflow file name/);
  });
});

describe('feedback-dispatch', () => {
  const feedbackRepo = ({ comments = [], threads = [], dispatch = {} } = {}) => fakeApi([
    ['GET', /^\/repos\/octo\/app\/pulls\/7\/reviews\/5\/comments$/, comments],
    ['POST', /^\/repos\/octo\/app\/actions\/workflows\/[^/]+\/dispatches$/, dispatch]
  ], threads);
  const reviewCtx = (review, values = {}) => ({
    ...ctxFor({ 'fix-workflow': 'pr-fix.yml', 'merge-workflow': 'merge-decision.yml', 'ignore-reply-authors': 'agent[bot]', ...values }),
    eventName: 'pull_request_review',
    event: {
      repository: { default_branch: 'main' },
      review: { id: 5, user: { login: 'agent[bot]' }, ...review },
      pull_request: { number: 7, head: { repo: { full_name: REPO } } }
    }
  });
  const dispatched = (api) => api.calls.filter((call) => call.method === 'POST').map((call) => call.path.split('/').at(-2));
  const route = async (review, options = {}, values = {}) => {
    const api = feedbackRepo(options);
    const result = await feedbackDispatch(reviewCtx(review, values), api);
    return { api, result, targets: dispatched(api) };
  };

  it('routes a clean grade comment to the merge workflow', async () => {
    assert.deepEqual((await route({ state: 'COMMENTED', body: '★★★★★' })).targets, ['merge-decision.yml']);
    assert.deepEqual((await route({ state: 'commented', body: '★★★★★\nTicket: not loaded' })).targets, ['merge-decision.yml']);
  });

  it('sends a clean grade with an inline comment to the fixer', async () => {
    assert.deepEqual((await route({ state: 'commented', body: '★★★★★' }, { comments: [{ id: 1 }] })).targets, ['pr-fix.yml']);
  });

  it('never dispatches a fix for clean grades while a thread is still open', async () => {
    const threads = [{ isResolved: false }];
    const first = await route({ state: 'commented', body: '★★★★★' }, { threads });
    const second = await route({ state: 'commented', body: '★★★★★' }, { threads });
    assert.deepEqual([...first.targets, ...second.targets], ['merge-decision.yml', 'merge-decision.yml']);
  });

  it('sends lower grades and partial reviews to the fixer', async () => {
    assert.deepEqual((await route({ state: 'commented', body: '★★★★☆\nfix x' })).targets, ['pr-fix.yml']);
    assert.deepEqual((await route({ state: 'commented', body: '★★★★★\nCovered: a\nNot covered: b' })).targets, ['pr-fix.yml']);
  });

  it('keeps changes requested, reply-only, empty, and approved reviews as before', async () => {
    assert.deepEqual((await route({ state: 'changes_requested', body: '' })).targets, ['pr-fix.yml']);
    assert.deepEqual((await route({ state: 'changes_requested', body: '' }, { comments: [{ in_reply_to_id: 2 }] })).targets, ['pr-fix.yml']);
    assert.deepEqual((await route({ state: 'commented', body: '' }, { comments: [{ in_reply_to_id: 2 }] })).targets, []);
    assert.deepEqual((await route({ state: 'commented', body: '' })).targets, []);
    assert.deepEqual((await route({ state: 'approved', body: '' })).targets, ['merge-decision.yml']);
    assert.deepEqual((await route({ state: 'commented', body: 'nit' }, {}, { 'ignore-authors': 'agent[bot]' })).targets, []);
  });

  it('skips forks and reports a workflow missing on the default branch', async () => {
    const api = feedbackRepo();
    const ctx = reviewCtx({ state: 'approved' });
    ctx.event.pull_request.head.repo.full_name = 'evil/app';
    assert.match((await feedbackDispatch(ctx, api)).summary[0], /fork/);
    const missing = fakeApi([], []);
    assert.match((await feedbackDispatch(reviewCtx({ state: 'approved' }), missing)).notice, /not on main/);
  });

  it('dispatches the merge workflow for a successful merge check run', async () => {
    const api = feedbackRepo();
    const ctx = {
      ...ctxFor({ 'merge-workflow': 'merge-decision.yml', 'merge-check-name': 'Code Review' }),
      eventName: 'check_run',
      event: {
        repository: { default_branch: 'main' },
        check_run: { name: 'Code Review', status: 'completed', conclusion: 'success', pull_requests: [
          { number: 7, head: { repo: { id: 1 } }, base: { repo: { id: 1 } } },
          { number: 8, head: { repo: { id: 2 } }, base: { repo: { id: 1 } } }
        ] }
      }
    };
    await feedbackDispatch(ctx, api);
    assert.deepEqual(api.calls.filter((call) => call.method === 'POST').map((call) => call.body.inputs.pr_number), ['7']);
  });

  it('recognizes only the top grade as clean', () => {
    assert.equal(isCleanGrade('★★★★★'), true);
    assert.equal(isCleanGrade('★★★★☆'), false);
    assert.equal(isCleanGrade(''), false);
  });
});

describe('merge-outcome', () => {
  it('reads the last merge-risk-result line', () => {
    assert.equal(parseMergeOutcome('PR #7: HOLD (risk 3/5)\nmerge-risk-result: held\n'), 'held');
    assert.equal(parseMergeOutcome('merge-risk-result: held\n**merge-risk-result: merged**'), 'merged');
    assert.equal(parseMergeOutcome('PR #7: NOT EVALUATED (not rated)\nmerge-risk-result: not-evaluated'), 'not-evaluated');
  });

  it('falls back to the verdict line of older skills', () => {
    assert.equal(parseMergeOutcome('**PR #7: MERGE (risk 1/5, max 2, auto-merge on)**'), 'merged');
    assert.equal(parseMergeOutcome('PR #7: HOLD (risk 4/5)'), 'held');
    assert.equal(parseMergeOutcome('I could not load the PR.'), 'not-evaluated');
  });

  it('treats a failed harness without a result as not evaluated', () => {
    assert.equal(parseMergeOutcome('PR #7: HOLD (no decision made)', 'failure'), 'not-evaluated');
    assert.equal(parseMergeOutcome('merge-risk-result: merged', 'failure'), 'merged');
  });

  it('reads the harness output file and reports missing output as not evaluated', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'merge-outcome-'));
    try {
      const file = join(dir, 'out');
      writeFileSync(file, 'merge-risk-result: held\n');
      assert.equal((await mergeOutcome(ctxFor({ 'output-file': file, outcome: 'success' }))).outputs.result, 'held');
      const missing = await mergeOutcome(ctxFor({ 'output-file': join(dir, 'none'), outcome: 'failure' }));
      assert.equal(missing.outputs.result, 'not-evaluated');
      assert.match(missing.notice, /could not be evaluated/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function mergeRepo({ pr = pull(), runs = [], checks = [], status = { total_count: 0, state: 'pending' }, reviews = [], comments = [], threads = [], fixRuns = null } = {}) {
  return fakeApi([
    ...(fixRuns ? [['GET', /^\/repos\/octo\/app\/actions\/workflows\/pr-fix\.yml\/runs\?/, { workflow_runs: fixRuns }]] : []),
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

  it('keeps only the newest check run of each name: cancelled then success, same name', async () => {
    const ctx = ctxFor({ ...base, 'human-approval-exempt-base-prefixes': 'feat/' });
    const check = (id, conclusion, at, suite) => ({ id, name: 'Quality Checks', status: 'completed', conclusion, started_at: at, check_suite: { id: suite } });
    const cancelledThenSuccess = [check(10, 'cancelled', '2026-01-01T00:00:00Z', 1), check(11, 'success', '2026-01-01T00:01:00Z', 2)];
    assert.equal((await mergeGate(ctx, mergeRepo({ checks: cancelledThenSuccess }), noSleep)).outputs.action, 'decide');
    assert.equal((await mergeGate(ctx, mergeRepo({ checks: [...cancelledThenSuccess].reverse() }), noSleep)).outputs.action, 'decide');
    const successThenFailure = [check(10, 'success', '2026-01-01T00:00:00Z', 1), check(11, 'failure', '2026-01-01T00:01:00Z', 2)];
    assert.match((await mergeGate(ctx, mergeRepo({ checks: successThenFailure }), noSleep)).summary[0], /Quality Checks \(failure\)/);
    const sameStart = [check(12, 'success', '2026-01-01T00:00:00Z', 1), check(13, 'cancelled', '2026-01-01T00:00:00Z', 2)];
    assert.match((await mergeGate(ctx, mergeRepo({ checks: sameStart }), noSleep)).summary[0], /cancelled/);
  });

  it('hands off unresolved threads unless a fix run is queued', async () => {
    const ctx = ctxFor({ ...base, 'human-approval-exempt-base-prefixes': 'feat/', 'fix-workflow': 'pr-fix.yml' });
    const threads = [{ isResolved: false }];
    const idle = await mergeGate(ctx, mergeRepo({ threads, fixRuns: [{ status: 'completed' }, { status: 'in_progress' }] }), noSleep);
    assert.equal(idle.outputs.action, 'skip');
    assert.equal(idle.outputs.handoff, 'true');
    assert.match(idle.summary[0], /1 unresolved/);
    for (const status of ['queued', 'pending', 'waiting']) {
      const queued = await mergeGate(ctx, mergeRepo({ threads, fixRuns: [{ status }] }), noSleep);
      assert.equal(queued.outputs.handoff, undefined);
      assert.match(queued.summary[0], /pr-fix\.yml run is queued/);
    }
    const missing = await mergeGate(ctx, mergeRepo({ threads }), noSleep);
    assert.equal(missing.outputs.handoff, 'true');
    const noFixWorkflow = await mergeGate(ctxFor({ ...base, 'human-approval-exempt-base-prefixes': 'feat/' }), mergeRepo({ threads }), noSleep);
    assert.equal(noFixWorkflow.outputs.handoff, 'true');
  });

  it('skips with unresolved threads or a decision already recorded for the head', async () => {
    const ctx = ctxFor({ ...base, 'human-approval-exempt-base-prefixes': 'feat/' });
    assert.match((await mergeGate(ctx, mergeRepo({ threads: [{ isResolved: false }] }), noSleep)).summary[0], /1 unresolved/);
    const comments = [bot(`<!-- merge-decision head=${HEAD} -->`)];
    assert.match((await mergeGate(ctx, mergeRepo({ comments }), noSleep)).summary[0], /already made/);
  });

  it('decides again once after a redecide marker newer than the decision', async () => {
    const ctx = ctxFor({ ...base, 'human-approval-exempt-base-prefixes': 'feat/' });
    const decision = bot(`<!-- merge-decision head=${HEAD} -->`, '2026-01-02T00:00:00Z');
    const redecide = bot('<!-- merge-decision redecide -->\n@alice resumed', '2026-01-03T00:00:00Z');
    assert.equal((await mergeGate(ctx, mergeRepo({ comments: [decision, redecide] }), noSleep)).outputs.action, 'decide');
    const again = bot(`<!-- merge-decision head=${HEAD} -->`, '2026-01-04T00:00:00Z');
    assert.match((await mergeGate(ctx, mergeRepo({ comments: [decision, redecide, again] }), noSleep)).summary[0], /already made/);
    const byPerson = { ...redecide, user: { login: 'mallory', type: 'User' } };
    assert.match((await mergeGate(ctx, mergeRepo({ comments: [decision, byPerson] }), noSleep)).summary[0], /already made/);
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
