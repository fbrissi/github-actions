import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { envName, feedbackDispatch, qualityJoinCommand, reviewOutcome, fixFinish, fixGate, fixRecord, isCleanGrade, mergeDispatch, mergeGate, mergeOutcome, mergeRecord, parseMergeOutcome, readContext } from './main.mjs';

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

  it('keeps fixing while only an approval label is present', async () => {
    const result = await fixGate(ctxFor(base), fixRepo({ pr: pull({ labels: [{ name: 'ai:needs-approval' }] }) }));
    assert.equal(result.outputs.action, 'fix');
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

describe('quality-join', () => {
  const check = (id, name, conclusion, overrides = {}) => ({
    id, name, status: conclusion ? 'completed' : 'in_progress', conclusion, started_at: `2026-01-0${id % 9 || 1}T00:00:00Z`,
    external_id: String(id), details_url: `https://github.com/octo/app/runs/${id + 900}`, html_url: `https://qa/${id}`, ...overrides
  });
  const runs = {
    11: { path: '.github/workflows/code-review.yml', head_branch: 'main', event: 'workflow_dispatch', repository: { full_name: REPO } },
    21: { path: '.github/workflows/qa.yml', head_branch: 'main', event: 'workflow_dispatch', repository: { full_name: REPO } },
    22: { path: '.github/workflows/qa.yml', head_branch: 'main', event: 'workflow_dispatch', repository: { full_name: REPO } },
    31: { path: '.github/workflows/forged.yml', head_branch: 'feat/x', event: 'pull_request', repository: { full_name: REPO } }
  };
  const joinRepo = ({ pr = pull(), reviewCheck = check(11, 'Code Review', 'success'), qa = [check(21, 'AI QA', 'success')], reviews = [], reviewComments = {}, comments = [], dispatch = {} } = {}) => fakeApi([
    ['GET', /^\/repos\/octo\/app\/pulls\/7$/, pr],
    ['GET', /^\/repos\/octo\/app$/, { default_branch: 'main' }],
    ['GET', /^\/repos\/octo\/app\/commits\/a{40}\/check-runs\?check_name=Code%20Review/, { check_runs: reviewCheck ? [reviewCheck] : [] }],
    ['GET', /^\/repos\/octo\/app\/commits\/a{40}\/check-runs\?check_name=AI%20QA/, { check_runs: qa }],
    ['GET', /^\/repos\/octo\/app\/actions\/runs\/(\d+)$/, (match) => {
      if (!runs[match[1]]) throw Object.assign(new Error('not found'), { status: 404 });
      return runs[match[1]];
    }],
    ['GET', /^\/repos\/octo\/app\/pulls\/7\/reviews$/, reviews],
    ['GET', /^\/repos\/octo\/app\/pulls\/7\/reviews\/(\d+)\/comments$/, (match) => reviewComments[match[1]] ?? []],
    ['GET', /^\/repos\/octo\/app\/issues\/7\/comments$/, comments],
    ['POST', /^\/repos\/octo\/app\/issues\/7\/comments$/, {}],
    ['POST', /^\/repos\/octo\/app\/actions\/workflows\/[^/]+\/dispatches$/, dispatch]
  ]);
  const values = { 'qa-check-name': 'AI QA', 'fix-workflow': 'pr-fix.yml', 'merge-workflow': 'merge-decision.yml', 'ignore-authors': 'fixer[bot]', 'pr-number': '7' };
  const review = (id, state, body = '', overrides = {}) => ({ id, state, body, commit_id: HEAD, submitted_at: `2026-01-0${id}T00:00:00Z`, user: { login: 'agent[bot]' }, ...overrides });
  const targets = (api) => api.calls.filter((call) => call.path.endsWith('/dispatches')).map((call) => call.path.split('/').at(-2));
  const markers = (api) => api.calls.filter((call) => call.method === 'POST' && call.path.endsWith('/comments')).map((call) => call.body.body);
  const join = async (options) => {
    const api = joinRepo(options);
    const result = await qualityJoinCommand(ctxFor(values), api);
    return { api, result, targets: targets(api) };
  };

  it('waits until both the code review and QA checks of the head have completed', async () => {
    const reviewRunning = await join({ reviewCheck: check(11, 'Code Review', null), reviews: [review(1, 'APPROVED')] });
    assert.deepEqual(reviewRunning.targets, []);
    assert.match(reviewRunning.result.summary[0], /Waiting for Code Review/);
    const qaRunning = await join({ qa: [check(21, 'AI QA', null)], reviews: [review(1, 'APPROVED')] });
    assert.deepEqual(qaRunning.targets, []);
    assert.match(qaRunning.result.summary[0], /Waiting for AI QA/);
    assert.deepEqual((await join({ qa: [], reviews: [review(1, 'APPROVED')] })).targets, []);
  });

  it('finds the creating run from the external id, since GitHub rewrites the details url of Actions-token checks', async () => {
    const legacy = check(11, 'Code Review', 'success', { external_id: null, details_url: 'https://github.com/octo/app/actions/runs/11' });
    assert.deepEqual((await join({ reviewCheck: legacy, reviews: [review(1, 'APPROVED')] })).targets, ['merge-decision.yml']);
    const rewritten = check(11, 'Code Review', 'success', { external_id: null });
    const untrusted = await join({ reviewCheck: rewritten, reviews: [review(1, 'APPROVED')] });
    assert.deepEqual(untrusted.targets, []);
    assert.match(untrusted.result.summary[0], /Waiting for Code Review/);
  });

  it('dispatches the merge only when the review side and QA both approve', async () => {
    const both = await join({ reviews: [review(1, 'APPROVED')] });
    assert.deepEqual(both.targets, ['merge-decision.yml']);
    assert.match(markers(both.api)[0], new RegExp(`<!-- quality-join head=${HEAD} review-check=11 qa-check=21 reviews=1 -->`));
    assert.deepEqual((await join({ reviews: [review(1, 'COMMENTED', '★★★★★')] })).targets, ['merge-decision.yml']);
  });

  it('approves the review side when the reviewer published nothing new on the head', async () => {
    const { api, targets: sent } = await join({ reviews: [review(1, 'CHANGES_REQUESTED', '', { commit_id: OLD })] });
    assert.deepEqual(sent, ['merge-decision.yml']);
    assert.match(markers(api)[0], /reviews=0 -->/);
  });

  it('dispatches one fix when either side asks for changes', async () => {
    const qaFailed = await join({ qa: [check(21, 'AI QA', 'failure')], reviews: [review(1, 'APPROVED')] });
    assert.deepEqual(qaFailed.targets, ['pr-fix.yml']);
    assert.match(markers(qaFailed.api)[0], /findings of AI QA/);
    const reviewFailed = await join({ reviews: [review(1, 'CHANGES_REQUESTED')] });
    assert.deepEqual(reviewFailed.targets, ['pr-fix.yml']);
    assert.match(markers(reviewFailed.api)[0], /changes requested by agent\[bot\]/);
    const bothFailed = await join({ qa: [check(21, 'AI QA', 'failure')], reviews: [review(1, 'COMMENTED', '★★★☆☆\nfix x')] });
    assert.match(markers(bothFailed.api)[0], /the review and AI QA/);
  });

  it('never lets replies or a later approval hide a request for changes', async () => {
    const replies = await join({
      reviews: [review(1, 'APPROVED'), review(2, 'COMMENTED', '', { user: { login: 'person' } })],
      reviewComments: { 2: [{ in_reply_to_id: 9 }] }
    });
    assert.deepEqual(replies.targets, ['merge-decision.yml'], 'a reply resolving a thread is not a request for changes');
    const overridden = await join({ reviews: [review(1, 'CHANGES_REQUESTED'), review(2, 'APPROVED', '', { user: { login: 'person' } })] });
    assert.deepEqual(overridden.targets, ['pr-fix.yml'], "another reviewer's approval never hides a request for changes");
    const changedMind = await join({ reviews: [review(1, 'CHANGES_REQUESTED', '', { user: { login: 'person' } }), review(2, 'APPROVED', '', { user: { login: 'person' } })] });
    assert.deepEqual(changedMind.targets, ['merge-decision.yml'], 'the same reviewer approving the head later withdraws its request');
    const askedAgain = await join({ reviews: [review(1, 'APPROVED'), review(2, 'CHANGES_REQUESTED')] });
    assert.deepEqual(askedAgain.targets, ['pr-fix.yml']);
    assert.deepEqual((await join({ reviews: [review(1, 'COMMENTED', 'nit', { user: { login: 'fixer[bot]' } })] })).targets, ['merge-decision.yml']);
  });

  it('trusts only check runs of the QA and review workflows dispatched on the default branch', async () => {
    const forged = check(31, 'AI QA', 'success', { started_at: '2026-02-01T00:00:00Z' });
    const result = await join({ qa: [forged, check(21, 'AI QA', 'failure')], reviews: [review(1, 'APPROVED')] });
    assert.deepEqual(result.targets, ['pr-fix.yml']);
    assert.deepEqual((await join({ qa: [check(99, 'AI QA', 'success')], reviews: [review(1, 'APPROVED')] })).targets, []);
    assert.deepEqual((await join({ reviewCheck: check(31, 'Code Review', 'success'), reviews: [review(1, 'APPROVED')] })).targets, []);
  });

  it('decides once per state, again after a QA rerun or a new review, and ignores markers people post', async () => {
    const marker = `<!-- quality-join head=${HEAD} review-check=11 qa-check=21 reviews=1 -->`;
    const repeated = await join({ reviews: [review(1, 'APPROVED')], comments: [{ body: marker, user: { type: 'Bot' } }] });
    assert.deepEqual(repeated.targets, []);
    assert.match(repeated.result.summary[0], /Already joined/);
    assert.deepEqual((await join({ reviews: [review(1, 'APPROVED')], comments: [{ body: marker, user: { type: 'User' } }] })).targets, ['merge-decision.yml']);
    const rerun = await join({ qa: [check(22, 'AI QA', 'success')], reviews: [review(1, 'APPROVED')], comments: [{ body: marker, user: { type: 'Bot' } }] });
    assert.deepEqual(rerun.targets, ['merge-decision.yml']);
    const newer = await join({ reviews: [review(1, 'APPROVED'), review(2, 'CHANGES_REQUESTED', '', { user: { login: 'person' } })], comments: [{ body: marker, user: { type: 'Bot' } }] });
    assert.deepEqual(newer.targets, ['pr-fix.yml']);
  });

  it('records nothing when the dispatch fails, so the next join retries it', async () => {
    const api = joinRepo({ reviews: [review(1, 'APPROVED')], dispatch: () => { throw Object.assign(new Error('boom'), { status: 500 }); } });
    await assert.rejects(qualityJoinCommand(ctxFor(values), api), /boom/);
    assert.deepEqual(markers(api), []);
  });

  it('stops on a check without a verdict, and on a closed or fork pull request', async () => {
    const neutral = await join({ qa: [check(21, 'AI QA', 'neutral')], reviews: [review(1, 'APPROVED')] });
    assert.deepEqual(neutral.targets, []);
    assert.match(neutral.result.notice, /without a verdict/);
    const reviewFailed = await join({ reviewCheck: check(11, 'Code Review', 'failure') });
    assert.match(reviewFailed.result.notice, /ended failure/);
    assert.deepEqual((await join({ pr: pull({ state: 'closed' }) })).targets, []);
    assert.deepEqual((await join({ pr: pull({ head: { ref: 'x', sha: HEAD, repo: { full_name: 'evil/app' } } }) })).targets, []);
  });

  it('joins from every review event instead of dispatching directly', async () => {
    const ctx = {
      ...ctxFor(values),
      eventName: 'pull_request_review',
      event: {
        repository: { default_branch: 'main' },
        review: review(5, 'APPROVED'),
        pull_request: { number: 7, head: { repo: { full_name: REPO } } }
      }
    };
    const qaFailed = joinRepo({ qa: [check(21, 'AI QA', 'failure')], reviews: [review(5, 'APPROVED')] });
    await feedbackDispatch(ctx, qaFailed);
    assert.deepEqual(targets(qaFailed), ['pr-fix.yml']);
    const reviewRunning = joinRepo({ reviewCheck: check(11, 'Code Review', null), reviews: [review(5, 'APPROVED')] });
    await feedbackDispatch(ctx, reviewRunning);
    assert.deepEqual(targets(reviewRunning), []);
  });

  it('classifies reviews the same way with or without the join', () => {
    assert.equal(reviewOutcome({ state: 'APPROVED' }).outcome, 'merge');
    assert.equal(reviewOutcome({ state: 'commented', body: '★★★★★' }).outcome, 'merge');
    assert.equal(reviewOutcome({ state: 'commented', body: '★★★★☆' }).outcome, 'fix');
    assert.equal(reviewOutcome({ state: 'commented', body: '' }).outcome, null);
    assert.equal(reviewOutcome({ state: 'commented', body: '' }, [{ in_reply_to_id: 1 }]).outcome, 'fix');
    assert.equal(reviewOutcome({ state: 'commented', body: '' }, [{ in_reply_to_id: 1 }], { allReplies: true }).outcome, null);
    assert.equal(reviewOutcome({ state: 'dismissed' }).outcome, null);
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

function mergeRepo({ pr = pull(), runs = [], checks = [], status = { total_count: 0, state: 'pending' }, reviews = [], comments = [], threads = [], fixRuns = null, reviewComments = [] } = {}) {
  return fakeApi([
    ['GET', /^\/repos\/octo\/app\/pulls\/7\/comments$/, reviewComments],
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

  it('needs a human approval of the head commit when an approval label cancels the exemption', async () => {
    const ctx = ctxFor({ ...base, 'human-approval-exempt-base-prefixes': 'feat/', 'approval-labels': 'ai:needs-approval legal' });
    const labelled = pull({ labels: [{ name: 'ai:needs-approval' }] });
    const waiting = await mergeGate(ctx, mergeRepo({ pr: labelled, reviews: [approval('agent[bot]', 'Bot')] }), noSleep);
    assert.equal(waiting.outputs.action, 'skip');
    assert.equal(waiting.outputs.request_review, 'true');
    assert.equal(waiting.outputs.required_approvals, '1');
    assert.match(waiting.summary[0], /the ai:needs-approval label needs one/);
    const stale = await mergeGate(ctx, mergeRepo({ pr: labelled, reviews: [approval('alice', 'User', OLD)] }), noSleep);
    assert.equal(stale.outputs.action, 'skip');
    const approved = await mergeGate(ctx, mergeRepo({ pr: labelled, reviews: [approval('alice')] }), noSleep);
    assert.equal(approved.outputs.action, 'decide');
    const zero = ctxFor({ ...base, 'required-human-approvals': '0', 'approval-labels': 'legal' });
    const legal = await mergeGate(zero, mergeRepo({ pr: pull({ labels: [{ name: 'legal' }] }) }), noSleep);
    assert.equal(legal.outputs.required_approvals, '1');
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

  it('routes a pull request with conflicts to a fix pass, or to a person when no pass can run', async () => {
    const conflicted = pull({ mergeable: false, mergeable_state: 'dirty', labels: [{ name: 'ai:auto-fix' }] });
    const fixCtx = ctxFor({ ...base, 'fix-workflow': 'pr-fix.yml', 'opt-in-label': 'ai:auto-fix', 'escalation-label': 'ai:needs-human' });
    const fix = await mergeGate(fixCtx, mergeRepo({ pr: conflicted, fixRuns: [] }), noSleep);
    assert.equal(fix.outputs.action, 'skip');
    assert.equal(fix.outputs.conflicts, 'fix');
    const queued = await mergeGate(fixCtx, mergeRepo({ pr: conflicted, fixRuns: [{ status: 'in_progress' }] }), noSleep);
    assert.equal(queued.outputs.conflicts, undefined);
    assert.match(queued.summary[0], /pr-fix\.yml run is queued/);
    const fixedHere = [{ user: { type: 'Bot', login: 'fixer[bot]' }, created_at: '2026-01-01T00:00:00Z', body: `<!-- pr-fix round=1 head=${HEAD} -->` }];
    assert.equal((await mergeGate(fixCtx, mergeRepo({ pr: conflicted, comments: fixedHere, fixRuns: [] }), noSleep)).outputs.conflicts, 'handoff');
    const escalated = pull({ mergeable: false, labels: [{ name: 'ai:auto-fix' }, { name: 'ai:needs-human' }] });
    assert.equal((await mergeGate(fixCtx, mergeRepo({ pr: escalated, fixRuns: [] }), noSleep)).outputs.conflicts, 'handoff');
    const optedOut = await mergeGate(fixCtx, mergeRepo({ pr: pull({ mergeable: false }), fixRuns: [] }), noSleep);
    assert.equal(optedOut.outputs.conflicts, 'handoff');
    assert.match(optedOut.notice, /has merge conflicts/);
    assert.equal((await mergeGate(ctxFor(base), mergeRepo({ pr: conflicted }), noSleep)).outputs.conflicts, 'handoff');
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

  it('keeps only the newest check run of a workflow: cancelled then success, same name', async () => {
    const ctx = ctxFor({ ...base, 'human-approval-exempt-base-prefixes': 'feat/' });
    const check = (id, conclusion, at, suite) => ({ id, name: 'Quality Checks', status: 'completed', conclusion, started_at: at, app: { id: 15368 }, check_suite: { id: suite } });
    const runs = [{ event: 'pull_request', check_suite_id: 1, path: '.github/workflows/ci.yml' }, { event: 'pull_request', check_suite_id: 2, path: '.github/workflows/ci.yml' }];
    const cancelledThenSuccess = [check(10, 'cancelled', '2026-01-01T00:00:00Z', 1), check(11, 'success', '2026-01-01T00:01:00Z', 2)];
    assert.equal((await mergeGate(ctx, mergeRepo({ runs, checks: cancelledThenSuccess }), noSleep)).outputs.action, 'decide');
    assert.equal((await mergeGate(ctx, mergeRepo({ runs, checks: [...cancelledThenSuccess].reverse() }), noSleep)).outputs.action, 'decide');
    const successThenFailure = [check(10, 'success', '2026-01-01T00:00:00Z', 1), check(11, 'failure', '2026-01-01T00:01:00Z', 2)];
    assert.match((await mergeGate(ctx, mergeRepo({ runs, checks: successThenFailure }), noSleep)).summary[0], /Quality Checks \(failure\)/);
    const sameStart = [check(12, 'success', '2026-01-01T00:00:00Z', 1), check(13, 'cancelled', '2026-01-01T00:00:00Z', 2)];
    assert.match((await mergeGate(ctx, mergeRepo({ runs, checks: sameStart }), noSleep)).summary[0], /cancelled/);
  });

  it('keeps same-named jobs of different workflows apart', async () => {
    const ctx = ctxFor({ ...base, 'human-approval-exempt-base-prefixes': 'feat/' });
    const check = (id, conclusion, at, suite) => ({ id, name: 'build', status: 'completed', conclusion, started_at: at, app: { id: 15368 }, check_suite: { id: suite } });
    const runs = [{ event: 'pull_request', check_suite_id: 1, path: '.github/workflows/lint.yml' }, { event: 'pull_request', check_suite_id: 2, path: '.github/workflows/test.yml' }];
    const checks = [check(10, 'failure', '2026-01-01T00:00:00Z', 1), check(11, 'success', '2026-01-01T00:01:00Z', 2)];
    assert.match((await mergeGate(ctx, mergeRepo({ runs, checks }), noSleep)).summary[0], /build \(failure\)/);
    // Suites without a known workflow run, or of another App, are never merged with each other.
    assert.match((await mergeGate(ctx, mergeRepo({ checks }), noSleep)).summary[0], /build \(failure\)/);
    const otherApp = [check(10, 'failure', '2026-01-01T00:00:00Z', 1), { ...check(11, 'success', '2026-01-01T00:01:00Z', 1), app: { id: 99 } }];
    assert.match((await mergeGate(ctx, mergeRepo({ runs, checks: otherApp }), noSleep)).summary[0], /build \(failure\)/);
  });

  it('hands off unresolved threads unless a fix run is queued for new feedback', async () => {
    const values = { ...base, 'human-approval-exempt-base-prefixes': 'feat/', 'fix-workflow': 'pr-fix.yml', 'opt-in-label': 'ai:auto-fix', 'fix-branch-prefixes': 'feat/', 'max-rounds': '3', 'escalation-label': 'ai:needs-human' };
    const ctx = ctxFor(values);
    const threads = [{ isResolved: false }];
    const round = (n, at = '2026-01-02T00:00:00Z') => bot(`<!-- pr-fix round=${n} head=${OLD} -->`, at);
    const newer = [{ user: { login: 'reviewer[bot]' }, created_at: '2026-01-03T00:00:00Z' }];
    const older = [{ user: { login: 'reviewer[bot]' }, created_at: '2026-01-01T00:00:00Z' }];
    const fixerReply = [{ user: { login: 'fixer[bot]' }, created_at: '2026-01-03T00:00:00Z' }];
    const repo = (options) => mergeRepo({ threads, comments: [round(1)], ...options });
    const idle = await mergeGate(ctx, repo({ reviewComments: newer, fixRuns: [{ status: 'completed' }, { status: 'in_progress' }] }), noSleep);
    assert.equal(idle.outputs.action, 'skip');
    assert.equal(idle.outputs.handoff, 'true');
    assert.match(idle.summary[0], /1 unresolved/);
    for (const status of ['queued', 'pending', 'waiting']) {
      const queued = await mergeGate(ctx, repo({ reviewComments: newer, fixRuns: [{ status }] }), noSleep);
      assert.equal(queued.outputs.handoff, undefined);
      assert.match(queued.summary[0], /pr-fix\.yml run is queued/);
    }
    // A queued run for another pull request: this one has nothing new since its last round.
    for (const reviewComments of [older, fixerReply]) {
      assert.equal((await mergeGate(ctx, repo({ reviewComments, fixRuns: [{ status: 'queued' }] }), noSleep)).outputs.handoff, 'true');
    }
    const missing = await mergeGate(ctx, repo({ reviewComments: newer }), noSleep);
    assert.equal(missing.outputs.handoff, 'true');
    const noFixWorkflow = await mergeGate(ctxFor({ ...values, 'fix-workflow': '' }), repo({ reviewComments: newer }), noSleep);
    assert.equal(noFixWorkflow.outputs.handoff, 'true');
  });

  it('hands off when this pull request could not get the queued fix pass', async () => {
    const values = { ...base, 'human-approval-exempt-base-prefixes': 'feat/', 'fix-workflow': 'pr-fix.yml', 'opt-in-label': 'ai:auto-fix', 'fix-branch-prefixes': 'feat/', 'max-rounds': '3', 'escalation-label': 'ai:needs-human' };
    const threads = [{ isResolved: false }];
    const newer = [{ user: { login: 'reviewer[bot]' }, created_at: '2026-01-09T00:00:00Z' }];
    const fixRuns = [{ status: 'queued' }];
    const round = (n) => bot(`<!-- pr-fix round=${n} head=${OLD} -->`, `2026-01-0${n}T00:00:00Z`);
    const handoff = async (ctxValues, options) => (await mergeGate(ctxFor({ ...values, ...ctxValues }), mergeRepo({ threads, fixRuns, reviewComments: newer, ...options }), noSleep)).outputs.handoff;
    assert.equal(await handoff({}, { comments: [round(1), round(2), round(3)] }), 'true');
    assert.equal(await handoff({}, { pr: pull({ labels: [{ name: 'ai:needs-human' }] }) }), 'true');
    assert.equal(await handoff({ 'fix-branch-prefixes': 'ai/' }), 'true');
    assert.equal(await handoff({ 'ignore-authors': 'reviewer[bot]' }), 'true');
    assert.equal(await handoff({}, { comments: [round(1)] }), undefined);
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
