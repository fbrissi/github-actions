import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildHandoff, setHandoffState } from './delivery.mjs';
import { createClient } from './github.mjs';
import { dispatchWorkflow, envName, findHandoff, followUp, handoff, parseResumeEvent, readContext, requestReview, resume, syncProjectStatus } from './main.mjs';

const REPO = 'octo/app';
const silent = { info() {}, notice() {}, warning() {} };

// A fake GitHub API: routes are [method, path regex, handler(match, body)] and every call is recorded.
function fakeApi(routes, graphql = { repository: { pullRequest: { closingIssuesReferences: { nodes: [] } } } }) {
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
      return graphql;
    }
  };
  return api;
}

const ctxFor = (values) => readContext({
  ...Object.fromEntries(Object.entries(values).map(([name, value]) => [envName(name), value])),
  GITHUB_REPOSITORY: REPO,
  GITHUB_SERVER_URL: 'https://github.com',
  GITHUB_RUN_ID: '42',
  GITHUB_WORKFLOW_REF: `${REPO}/.github/workflows/ai-tech.yml@refs/heads/main`
});

const label = (name) => ({ name });
const posts = (api, pattern) => api.calls.filter((call) => call.method === 'POST' && pattern.test(call.path));

function milestoneRepo({ description = '', issues = [], comments = [], extra = [] } = {}) {
  const milestone = { number: 3, title: 'JIRA:DEV-1', description };
  return fakeApi([
    ...extra,
    ['GET', /^\/repos\/octo\/app$/, { default_branch: 'main' }],
    ['GET', /^\/repos\/octo\/app\/milestones\?state=all$/, [milestone]],
    ['PATCH', /^\/repos\/octo\/app\/milestones\/3$/, (match, body) => Object.assign(milestone, body)],
    ['GET', /^\/repos\/octo\/app\/issues\?milestone=3&state=open$/, issues],
    ['GET', /^\/repos\/octo\/app\/issues\/(\d+)$/, (match) => issues.find((issue) => issue.number === Number(match[1]))],
    ['GET', /^\/repos\/octo\/app\/issues\/\d+\/comments$/, comments],
    ['POST', /^\/repos\/octo\/app\/issues\/\d+\/comments$/, {}],
    ['POST', /^\/repos\/octo\/app\/issues\/\d+\/labels$/, []],
    ['DELETE', /^\/repos\/octo\/app\/issues\/\d+\/labels\/.+$/, []],
    ['POST', /^\/repos\/octo\/app\/actions\/workflows\/[^/]+\/dispatches$/, { html_url: 'https://github.com/octo/app/actions/runs/77' }]
  ]);
}

describe('followUp', () => {
  it('stores the requester and dispatches the next stage with the counters', async () => {
    const api = milestoneRepo({
      description: 'Goal.',
      issues: [{ number: 4, labels: [label('status:needs-review')] }, { number: 5, labels: [label('status:ready')] }]
    });
    const summary = await followUp(ctxFor({ task: 'technical-refinement', result: 'success', milestone: 'JIRA:DEV-1', 'requested-by': 'alice' }), api, silent);
    const [dispatch] = posts(api, /dispatches$/);
    assert.equal(dispatch.path, '/repos/octo/app/actions/workflows/ai-readiness-review.yml/dispatches');
    assert.deepEqual(dispatch.body, { ref: 'main', inputs: { milestone: 'JIRA:DEV-1', requested_by: 'alice' }, return_run_details: true });
    const patches = api.calls.filter((call) => call.method === 'PATCH');
    assert.equal(patches.at(-1).body.description,
      'Goal.\n\n<!-- ai-delivery requested-by=alice -->\n\n<!-- ai-delivery-dispatches readiness-review=1 -->');
    assert.match(summary.join('\n'), /Dispatched ai-readiness-review\.yml/);
  });

  it('takes the requester from the milestone when the run was started by a bot', async () => {
    const api = milestoneRepo({
      description: '<!-- ai-delivery requested-by=carol -->',
      issues: [{ number: 4, labels: [label('status:needs-technical-refinement')] }]
    });
    await followUp(ctxFor({ task: 'business-refinement', 'result-milestone': 'JIRA:DEV-1', source: 'DEV-1', 'requested-by': 'agent[bot]' }), api, silent);
    assert.deepEqual(posts(api, /dispatches$/)[0].body.inputs, { milestone: 'JIRA:DEV-1', requested_by: 'carol' });
  });

  it('hands off instead of dispatching past the loop limit', async () => {
    const api = milestoneRepo({
      description: '<!-- ai-delivery-dispatches business-refinement=3 -->',
      issues: [{ number: 4, labels: [label('status:needs-business-refinement')] }]
    });
    await followUp(ctxFor({ task: 'technical-refinement', milestone: 'JIRA:DEV-1', 'requested-by': 'alice', 'milestone-template': 'JIRA:{key}' }), api, silent);
    assert.equal(posts(api, /dispatches$/).length, 0);
    const [comment] = posts(api, /issues\/4\/comments$/);
    assert.match(comment.body.body, /^@alice the AI delivery flow stopped at \*\*business-refinement\*\*/);
    assert.match(comment.body.body, /automatically 3 times for this milestone \(limit 3\)/);
    assert.match(comment.body.body, /gh workflow run ai-business-refinement\.yml -f milestone=JIRA:DEV-1 -f jira_key=DEV-1 -f requested_by=alice/);
  });

  it('allows a send-back to an earlier refinement and counts it', async () => {
    const api = milestoneRepo({
      description: '<!-- ai-delivery-dispatches technical-refinement=1 readiness-review=1 -->',
      issues: [{ number: 4, labels: [label('status:needs-technical-refinement')] }]
    });
    await followUp(ctxFor({ task: 'readiness-review', milestone: 'JIRA:DEV-1', 'requested-by': 'alice' }), api, silent);
    assert.equal(posts(api, /dispatches$/)[0].path, '/repos/octo/app/actions/workflows/ai-technical-refinement.yml/dispatches');
    const patches = api.calls.filter((call) => call.method === 'PATCH');
    assert.match(patches.at(-1).body.description, /<!-- ai-delivery-dispatches technical-refinement=2 readiness-review=1 send-backs=1 -->/);
  });

  it('hands off to the requester past max-send-backs', async () => {
    const api = milestoneRepo({
      description: '<!-- ai-delivery-dispatches technical-refinement=2 readiness-review=3 send-backs=3 -->',
      issues: [{ number: 4, labels: [label('status:needs-technical-refinement')] }]
    });
    await followUp(ctxFor({ task: 'readiness-review', milestone: 'JIRA:DEV-1', 'requested-by': 'alice' }), api, silent);
    assert.equal(posts(api, /dispatches$/).length, 0);
    const [comment] = posts(api, /issues\/4\/comments$/);
    assert.match(comment.body.body, /^@alice the AI delivery flow stopped at \*\*technical-refinement\*\*/);
    assert.match(comment.body.body, /sent the issues back to an earlier refinement stage 3 times for this milestone \(limit 3\), and readiness-review wants to send them back to technical-refinement again/);
  });

  it('does not count forward dispatches as send-backs', async () => {
    const api = milestoneRepo({
      description: '<!-- ai-delivery-dispatches send-backs=1 -->',
      issues: [{ number: 4, labels: [label('status:needs-review')] }]
    });
    await followUp(ctxFor({ task: 'technical-refinement', milestone: 'JIRA:DEV-1', 'requested-by': 'alice' }), api, silent);
    assert.equal(posts(api, /dispatches$/)[0].path, '/repos/octo/app/actions/workflows/ai-readiness-review.yml/dispatches');
  });

  it('honors max-send-backs 0', async () => {
    const api = milestoneRepo({ issues: [{ number: 4, labels: [label('status:needs-business-refinement')] }] });
    await followUp(ctxFor({ task: 'technical-refinement', milestone: 'JIRA:DEV-1', 'requested-by': 'alice', 'max-send-backs': '0' }), api, silent);
    assert.equal(posts(api, /dispatches$/).length, 0);
    assert.equal(posts(api, /issues\/4\/comments$/).length, 1);
  });

  it('hands off blocked issues once, linking the questions', async () => {
    const question = { user: { type: 'Bot' }, body: 'Which currency?', html_url: 'https://github.com/octo/app/issues/4#issuecomment-1' };
    const api = milestoneRepo({ issues: [{ number: 4, labels: [label('status:technical-blocked')] }], comments: [question] });
    await followUp(ctxFor({ task: 'technical-refinement', milestone: 'JIRA:DEV-1', 'requested-by': 'alice' }), api, silent);
    const [comment] = posts(api, /issues\/4\/comments$/);
    assert.match(comment.body.body, /Questions and details: https:\/\/github\.com\/octo\/app\/issues\/4#issuecomment-1/);
    // The run's own caller file wins for its own stage.
    assert.match(comment.body.body, /gh workflow run ai-tech\.yml -f milestone=JIRA:DEV-1 -f issue=4 -f requested_by=alice/);

    const again = milestoneRepo({
      issues: [{ number: 4, labels: [label('status:technical-blocked')] }],
      comments: [question, { user: { type: 'Bot' }, body: comment.body.body }]
    });
    await followUp(ctxFor({ task: 'technical-refinement', milestone: 'JIRA:DEV-1' }), again, silent);
    assert.equal(posts(again, /comments$/).length, 0);
  });

  it('on failure hands off the run and moves the stuck issue back to ready', async () => {
    const api = milestoneRepo({
      issues: [{ number: 6, milestone: { title: 'JIRA:DEV-1' }, labels: [label('status:in-progress')] }],
      extra: [['GET', /^\/repos\/octo\/app\/pulls\?state=open&head=octo%3Afeat%2Fdev-1-6-login$/, []]]
    });
    await followUp(ctxFor({ task: 'implement', result: 'failure', issue: '6', branch: 'feat/dev-1-6-login', 'base-branch': 'feat/dev-1' }), api, silent);
    assert.ok(api.calls.some((call) => call.method === 'DELETE' && call.path === '/repos/octo/app/issues/6/labels/status%3Ain-progress'));
    assert.deepEqual(posts(api, /issues\/6\/labels$/)[0].body, { labels: ['status:ready'] });
    const [comment] = posts(api, /issues\/6\/comments$/);
    assert.match(comment.body.body, /The implement run failed: https:\/\/github\.com\/octo\/app\/actions\/runs\/42/);
    assert.match(comment.body.body, /-f issue=6 -f branch=feat\/dev-1-6-login -f base_branch=feat\/dev-1/);
  });

  it('on failure without any issue opens a tracking issue', async () => {
    const api = fakeApi([
      ['GET', /^\/repos\/octo\/app$/, { default_branch: 'main' }],
      ['GET', /^\/repos\/octo\/app\/milestones\?state=all$/, []],
      ['GET', /^\/repos\/octo\/app\/issues\?state=open$/, []],
      ['POST', /^\/repos\/octo\/app\/issues$/, { number: 11 }],
      ['GET', /^\/repos\/octo\/app\/issues\/11\/comments$/, []],
      ['POST', /^\/repos\/octo\/app\/issues\/11\/comments$/, {}]
    ]);
    await followUp(ctxFor({ task: 'business-refinement', result: 'cancelled', source: 'DEV-9', 'requested-by': 'alice' }), api, silent);
    assert.equal(posts(api, /issues$/)[0].body.title, 'DEV-9 - business-refinement');
    assert.match(posts(api, /issues\/11\/comments$/)[0].body.body, /was cancelled or timed out/);
  });

  const resolveRuns = (timeline = [], createdAt = '2026-11-27T10:00:00Z') => [
    ['GET', /^\/repos\/octo\/app\/issues\/9\/timeline$/, timeline],
    ['GET', /^\/repos\/octo\/app\/actions\/runs\/42$/, { created_at: createdAt, run_started_at: '2026-11-27T11:00:00Z' }]
  ];
  const openPr = { event: 'cross-referenced', source: { issue: { number: 30, state: 'open', pull_request: {} } } };

  it('only hands off a failed issue-resolve run, without touching its milestone', async () => {
    const api = milestoneRepo({ issues: [{ number: 9, milestone: { title: 'JIRA:DEV-1' }, labels: [] }], extra: resolveRuns([openPr]) });
    assert.match((await followUp(ctxFor({ task: 'issue-resolve', issue: '9', 'requested-by': 'alice' }), api, silent)).join('\n'), /Nothing to do/);
    await followUp(ctxFor({ task: 'issue-resolve', result: 'failure', issue: '9', 'requested-by': 'alice' }), api, silent);
    assert.equal(api.calls.filter((call) => call.method === 'PATCH').length, 0);
    assert.equal(posts(api, /dispatches$/).length, 0);
    const [comment] = posts(api, /issues\/9\/comments$/);
    assert.match(comment.body.body, /stopped at \*\*issue-resolve\*\*/);
    assert.match(comment.body.body, /gh workflow run ai-tech\.yml -f issue=9 -f requested_by=alice/);
  });

  it('hands off a successful issue-resolve run that left no pull request or blocker comment', async () => {
    const closedPr = { event: 'cross-referenced', source: { issue: { number: 31, state: 'closed', pull_request: {} } } };
    const comments = [
      { body: '<!-- ai-delivery blocker stage=issue-resolve -->\nBlocked: earlier run', created_at: '2026-11-27T09:59:00Z' },
      { body: 'resumed **issue-resolve** -> https://github.com/octo/app/actions/runs/42', created_at: '2026-11-27T10:00:05Z' },
      { body: 'Any news?', created_at: '2026-11-27T10:30:00Z' }
    ];
    const api = milestoneRepo({ issues: [{ number: 9, state: 'open', labels: [] }], comments, extra: resolveRuns([closedPr]) });
    const summary = (await followUp(ctxFor({ task: 'issue-resolve', issue: '9', 'requested-by': 'alice' }), api, silent)).join('\n');
    assert.match(summary, /Handed issue-resolve off on #9 \(no-pr\)/);
    const [comment] = posts(api, /issues\/9\/comments$/);
    assert.match(comment.body.body, /ended without a pull request or a blocker comment/);
    assert.equal(posts(api, /dispatches$/).length, 0);
  });

  it('accepts an issue-resolve run that posted a blocker comment or closed the issue', async () => {
    // Posted after the first attempt was created and before a re-run attempt started.
    const blocker = { body: '<!-- ai-delivery blocker stage=issue-resolve -->\nBlocked: questions', created_at: '2026-11-27T10:05:00Z' };
    const commented = milestoneRepo({ issues: [{ number: 9, state: 'open', labels: [] }], comments: [blocker], extra: resolveRuns() });
    assert.match((await followUp(ctxFor({ task: 'issue-resolve', issue: '9' }), commented, silent)).join('\n'), /Nothing to do/);
    const closed = milestoneRepo({ issues: [{ number: 9, state: 'closed', labels: [] }] });
    assert.match((await followUp(ctxFor({ task: 'issue-resolve', issue: '9' }), closed, silent)).join('\n'), /Nothing to do/);
    assert.equal(posts(commented, /comments$/).length + posts(closed, /comments$/).length, 0);
  });

  it('hands off only a failed dependency-update run, on a tracking issue', async () => {
    const api = fakeApi([
      ['GET', /^\/repos\/octo\/app$/, { default_branch: 'main' }],
      ['GET', /^\/repos\/octo\/app\/milestones\?state=all$/, []],
      ['GET', /^\/repos\/octo\/app\/issues\?state=open$/, []],
      ['POST', /^\/repos\/octo\/app\/issues$/, { number: 12 }],
      ['GET', /^\/repos\/octo\/app\/issues\/12\/comments$/, []],
      ['POST', /^\/repos\/octo\/app\/issues\/12\/comments$/, {}]
    ]);
    assert.match((await followUp(ctxFor({ task: 'dependency-update', 'requested-by': 'alice' }), api, silent)).join('\n'), /Nothing to do/);
    assert.equal(posts(api, /issues$/).length, 0);
    await followUp(ctxFor({ task: 'dependency-update', result: 'failure', 'requested-by': 'alice' }), api, silent);
    assert.equal(posts(api, /dispatches$/).length, 0);
    assert.equal(posts(api, /issues$/)[0].body.title, 'AI delivery - dependency-update');
    const [comment] = posts(api, /issues\/12\/comments$/);
    assert.match(comment.body.body, /stopped at \*\*dependency-update\*\*/);
    assert.match(comment.body.body, /gh workflow run ai-tech\.yml -f requested_by=alice/);
  });

  it('does not dispatch with chaining off', async () => {
    const api = milestoneRepo({ issues: [{ number: 4, labels: [label('status:ready')] }] });
    const summary = await followUp(ctxFor({ task: 'readiness-review', milestone: 'JIRA:DEV-1', chain: 'false' }), api, silent);
    assert.equal(posts(api, /dispatches$/).length, 0);
    assert.match(summary.join('\n'), /Chaining is off/);
  });

  it('hands off when the dispatch fails', async () => {
    const api = milestoneRepo({
      issues: [{ number: 4, labels: [label('status:ready')] }],
      extra: [['POST', /dispatches$/, () => { throw Object.assign(new Error('not found'), { status: 404 }); }]]
    });
    await followUp(ctxFor({ task: 'readiness-review', milestone: 'JIRA:DEV-1' }), api, silent);
    assert.match(posts(api, /issues\/4\/comments$/)[0].body.body, /could not dispatch ai-orchestrate\.yml: not found/);
  });
});

describe('dispatchWorkflow', () => {
  it('drops inputs an older caller does not declare', async () => {
    let attempts = 0;
    const api = fakeApi([['POST', /dispatches$/, (match, body) => {
      attempts += 1;
      if (body.inputs.requested_by) throw Object.assign(new Error('failed with 422: Unexpected inputs provided: ["requested_by"]'), { status: 422 });
      return null;
    }]]);
    const result = await dispatchWorkflow(api, REPO, 'ai-orchestrate.yml', 'main', { milestone: 'M1', requested_by: 'alice' }, silent);
    assert.equal(attempts, 2);
    assert.deepEqual(result, { inputs: { milestone: 'M1' }, url: '' });
  });

  it('dispatches without run details when the server rejects them', async () => {
    const api = fakeApi([['POST', /dispatches$/, (match, body) => {
      if (body.return_run_details) throw Object.assign(new Error('failed with 422: "return_run_details" is not a permitted key.'), { status: 422 });
      if (body.inputs.requested_by) throw Object.assign(new Error('failed with 422: Unexpected inputs provided: ["requested_by"]'), { status: 422 });
      return null;
    }]]);
    const result = await dispatchWorkflow(api, REPO, 'ai-orchestrate.yml', 'main', { milestone: 'M1', requested_by: 'alice' }, silent);
    assert.deepEqual(result, { inputs: { milestone: 'M1' }, url: '' });
    assert.equal(api.calls.length, 3);
  });
});

describe('handoff', () => {
  it('escalates a pull request to the requester of its milestone', async () => {
    const api = fakeApi([
      ['GET', /^\/repos\/octo\/app\/pulls\/7$/, { number: 7, user: { login: 'agent[bot]' }, base: { ref: 'feat/m1' }, milestone: { title: 'M1', description: '<!-- ai-delivery requested-by=alice -->' } }],
      ['GET', /^\/repos\/octo\/app\/issues\/7\/comments$/, []],
      ['POST', /^\/repos\/octo\/app\/issues\/7\/comments$/, {}]
    ]);
    const ctx = ctxFor({ command: 'handoff', task: 'pr-fix', pr: '7', marker: '<!-- pr-fix escalated -->', blocker: 'Automatic fixes stopped after 3 rounds.', 'escalation-label': 'ai:needs-human' });
    ctx.ownWorkflow = 'pr-fix.yml';
    await handoff(ctx, api, silent);
    const { body } = posts(api, /comments$/)[0].body;
    assert.match(body, /^<!-- pr-fix escalated -->\n@alice the AI delivery flow stopped at \*\*pr-fix\*\* \(milestone `M1`, pull request #7\)/);
    assert.match(body, /Reply `\/ai-resume` \(optionally with instructions on the next lines\) to continue: pr-fix -> merge decision\./);
    assert.match(body, /gh pr edit 7 --remove-label ai:needs-human && gh workflow run pr-fix\.yml -f pr_number=7/);
  });

  const prRepo = (comments) => fakeApi([
    ['GET', /^\/repos\/octo\/app\/pulls\/7$/, { number: 7, user: { login: 'agent[bot]' }, base: { ref: 'feat/m1' }, milestone: null }],
    ['GET', /^\/repos\/octo\/app\/issues\/7\/comments$/, comments],
    ['POST', /^\/repos\/octo\/app\/issues\/7\/comments$/, {}],
    ['PATCH', /^\/repos\/octo\/app\/issues\/comments\/\d+$/, {}]
  ]);
  const openHandoff = (marker) => ({
    id: 60,
    user: { login: 'agent[bot]', type: 'Bot' },
    body: `${marker}\n${buildHandoff({ stage: 'pr-fix', pr: 7, label: 'ai:needs-human', workflow: 'pr-fix.yml' })}`
  });

  it('supersedes an open handoff with other markers, so the escalation is posted', async () => {
    const api = prRepo([openHandoff('<!-- pr-fix failed -->')]);
    const summary = await handoff(ctxFor({ task: 'pr-fix', pr: '7', marker: '<!-- pr-fix escalated -->', 'escalation-label': 'ai:needs-human' }), api, silent);
    const patch = api.calls.find((call) => call.method === 'PATCH');
    assert.match(patch.path, /comments\/60$/);
    assert.match(patch.body.body, /state=superseded/);
    assert.match(posts(api, /comments$/)[0].body.body, /^<!-- pr-fix escalated -->/);
    assert.match(summary.join('\n'), /Superseded/);
  });

  it('does not repeat an open handoff with the same markers', async () => {
    const api = prRepo([openHandoff('<!-- pr-fix failed -->')]);
    const summary = await handoff(ctxFor({ task: 'pr-fix', pr: '7', marker: '<!-- pr-fix failed -->' }), api, silent);
    assert.equal(posts(api, /comments$/).length, 0);
    assert.equal(api.calls.filter((call) => call.method === 'PATCH').length, 0);
    assert.match(summary[0], /already has an open pr-fix handoff/);
  });

  it('rejects markers that are not HTML comments', async () => {
    await assert.rejects(handoff(ctxFor({ task: 'pr-fix', pr: '7', marker: 'hello' }), fakeApi([]), silent), /must be HTML comments/);
  });
});

describe('resume', () => {
  const handoffBody = buildHandoff({ stage: 'pr-fix', pr: 7, milestone: 'M1', requestedBy: 'alice', label: 'ai:needs-human', workflow: 'pr-fix.yml' });
  const handoff = { id: 50, user: { login: 'agent[bot]', type: 'Bot' }, body: handoffBody };
  const eventFor = (body = '/ai-resume', overrides = {}) => ({
    action: 'created',
    comment: { id: 99, user: { login: 'bob', type: 'User' }, body },
    issue: { number: 7, pull_request: {}, milestone: { title: 'M1' } },
    repository: { default_branch: 'main' },
    ...overrides
  });
  const routes = (comments = [handoff], extra = []) => [
    ...extra,
    ['POST', /issues\/comments\/99\/reactions$/, {}],
    ['GET', /collaborators\/bob\/permission$/, { permission: 'write', role_name: 'write' }],
    ['GET', /issues\/7\/comments$/, comments],
    ['POST', /issues\/7\/comments$/, {}],
    ['PATCH', /issues\/comments\/50$/, {}],
    ['DELETE', /issues\/7\/labels\/ai%3Aneeds-human$/, []],
    ['GET', /milestones\?state=all$/, [{ number: 1, title: 'M1', description: 'x\n\n<!-- ai-delivery-dispatches orchestrate=3 -->' }]],
    ['PATCH', /milestones\/1$/, {}],
    ['POST', /dispatches$/, { html_url: 'https://github.com/octo/app/actions/runs/5' }]
  ];
  const ctx = () => ctxFor({ 'bot-login': 'agent[bot]' });

  it('acts only on a new /ai-resume comment written by a person', () => {
    assert.deepEqual(parseResumeEvent(eventFor('/ai-resume pr-fix keep the API\nand the tests')).instructions, 'keep the API\nand the tests');
    assert.equal(parseResumeEvent(eventFor('/ai-resume pr-fix')).stage, 'pr-fix');
    assert.equal(parseResumeEvent(eventFor('/ai-resume please hurry')).stage, '');
    assert.match(parseResumeEvent(eventFor('please /ai-resume')).skip, /not an \/ai-resume command/);
    assert.match(parseResumeEvent(eventFor('/ai-resumed')).skip, /not an \/ai-resume command/);
    assert.match(parseResumeEvent({ ...eventFor(), action: 'edited' }).skip, /not a new comment/);
    assert.match(parseResumeEvent(eventFor('/ai-resume', { comment: { id: 1, user: { login: 'agent[bot]', type: 'Bot' }, body: '/ai-resume' } })).skip, /not a person/);
  });

  it('leaves a redecide marker before dispatching a named merge decision', async () => {
    const api = fakeApi(routes([]));
    await resume(ctx(), api, silent, eventFor('/ai-resume merge-decision'));
    const dispatch = api.calls.find((call) => call.path.endsWith('/dispatches'));
    assert.equal(dispatch.path, '/repos/octo/app/actions/workflows/merge-decision.yml/dispatches');
    assert.deepEqual(dispatch.body.inputs, { pr_number: '7' });
    const comments = posts(api, /issues\/7\/comments$/);
    assert.match(comments[0].body.body, /^<!-- merge-decision redecide -->\n@bob asked for a new merge decision/);
    assert.ok(api.calls.indexOf(comments[0]) < api.calls.indexOf(dispatch));
    assert.match(comments[1].body.body, /resumed \*\*merge-decision\*\*/);
  });

  it('resumes a merge-decision handoff on its pull request', async () => {
    const body = buildHandoff({ stage: 'merge-decision', pr: 7, requestedBy: 'alice', workflow: 'merge-decision.yml' });
    const api = fakeApi(routes([{ ...handoff, body }]));
    await resume(ctx(), api, silent, eventFor('/ai-resume'));
    assert.ok(api.calls.some((call) => call.path === '/repos/octo/app/actions/workflows/merge-decision.yml/dispatches'));
    assert.ok(posts(api, /issues\/7\/comments$/).some((call) => call.body.body.startsWith('<!-- merge-decision redecide -->')));
    assert.match(body, /gh workflow run merge-decision\.yml -f pr_number=7/);
  });

  it('lets only its own App name the workflow a handoff resumes', async () => {
    const body = buildHandoff({ stage: 'qa', pr: 7, requestedBy: 'alice', workflow: 'deploy.yml' });
    const reviewer = { id: 50, user: { login: 'reviewer[bot]', type: 'Bot' }, body };
    const trusting = () => ctxFor({ 'bot-login': 'agent[bot]', 'trusted-bots': 'reviewer[bot]' });
    const api = fakeApi(routes([reviewer]));
    await resume(trusting(), api, silent, eventFor('/ai-resume'));
    const dispatches = api.calls.filter((call) => call.path.endsWith('/dispatches')).map((call) => call.path);
    assert.deepEqual(dispatches, ['/repos/octo/app/actions/workflows/qa.yml/dispatches']);
    const own = fakeApi(routes([{ ...reviewer, user: { login: 'agent[bot]', type: 'Bot' }, body: buildHandoff({ stage: 'qa', pr: 7, workflow: 'renamed-qa.yml' }) }]));
    await resume(trusting(), own, silent, eventFor('/ai-resume'));
    assert.ok(own.calls.some((call) => call.path === '/repos/octo/app/actions/workflows/renamed-qa.yml/dispatches'));
  });

  it('marks the open handoff resumed, removes the label, dispatches with the instructions, and replies', async () => {
    const api = fakeApi(routes());
    await resume(ctx(), api, silent, eventFor('/ai-resume\nOnly fix the lint errors.'));
    const dispatch = api.calls.find((call) => call.path.endsWith('/dispatches'));
    assert.equal(dispatch.path, '/repos/octo/app/actions/workflows/pr-fix.yml/dispatches');
    assert.deepEqual(dispatch.body.inputs, { pr_number: '7', instructions: 'Only fix the lint errors.' });
    const edits = api.calls.filter((call) => call.method === 'PATCH' && call.path.endsWith('comments/50'));
    assert.equal(edits.length, 2);
    // Closed before the dispatch, then linked to the run.
    assert.ok(api.calls.indexOf(edits[0]) < api.calls.indexOf(dispatch));
    assert.match(edits[0].body.body, /state=resumed -->/);
    assert.match(edits[1].body.body, /^Resumed by @bob -> https:\/\/github\.com\/octo\/app\/actions\/runs\/5$/m);
    assert.doesNotMatch(edits[1].body.body, /Reply `\/ai-resume`/);
    assert.ok(api.calls.some((call) => call.method === 'DELETE' && /labels\/ai%3Aneeds-human$/.test(call.path)));
    assert.equal(api.calls.find((call) => call.path.endsWith('milestones/1')).body.description, 'x');
    assert.deepEqual(posts(api, /reactions$/).map((call) => call.body.content), ['eyes', 'rocket']);
    assert.match(posts(api, /issues\/7\/comments$/)[0].body.body, /^@bob resumed \*\*pr-fix\*\* -> https:\/\/github\.com\/octo\/app\/actions\/runs\/5/);
  });

  it('ignores a handoff that was already resumed and lists the stages', async () => {
    const resumed = { ...handoff, body: setHandoffState(handoffBody, 'resumed', 'Resumed by @carol.') };
    const api = fakeApi(routes([resumed]));
    const summary = await resume(ctx(), api, silent, eventFor());
    assert.match(summary[0], /no open handoff/);
    assert.equal(posts(api, /dispatches$/).length, 0);
    assert.match(posts(api, /issues\/7\/comments$/)[0].body.body, /`\/ai-resume <stage>` with one of `business-refinement`/);
  });

  it('runs a named stage without an open handoff from the issue or pull request', async () => {
    const api = fakeApi(routes([]));
    await resume(ctx(), api, silent, eventFor('/ai-resume pr-fix'));
    assert.deepEqual(posts(api, /dispatches$/)[0].body.inputs, { pr_number: '7' });
  });

  it('ignores handoffs of untrusted authors and resumes legacy checkbox handoffs', async () => {
    const legacy = { ...handoff, body: handoffBody.replace(/Answer where[^\n]*\nReply[^\n]*\n/, '- [ ] Resume: pr-fix -> continues automatically to merge decision\n').replace(' state=open', '') };
    assert.equal(findHandoff([{ ...handoff, user: { login: 'mallory' } }], ['agent[bot]'], ''), null);
    assert.equal(findHandoff([legacy], ['agent[bot]'], '').open, true);
    const api = fakeApi(routes([legacy]));
    await resume(ctx(), api, silent, eventFor());
    const edited = api.calls.filter((call) => call.method === 'PATCH' && call.path.endsWith('comments/50')).at(-1).body.body;
    assert.match(edited, /^Resumed by @bob -> /m);
    assert.doesNotMatch(edited, /\[ \] Resume/);
  });

  it('rejects an unknown stage with the list of stages', async () => {
    const api = fakeApi(routes());
    const summary = await resume(ctx(), api, silent, eventFor('/ai-resume deploy-prod'));
    assert.match(summary[0], /`deploy-prod` is not a stage/);
    assert.equal(posts(api, /dispatches$/).length, 0);
    assert.match(posts(api, /issues\/7\/comments$/)[0].body.body, /`issue-resolve`/);
  });

  it('refuses people without write permission with a reply', async () => {
    const api = fakeApi(routes([handoff], [['GET', /permission$/, { permission: 'read', role_name: 'triage' }]]));
    const summary = await resume(ctx(), api, silent, eventFor());
    assert.match(summary[0], /you have triage/);
    assert.equal(posts(api, /dispatches$/).length, 0);
  });

  it('reopens the handoff and fails when the dispatch fails', async () => {
    const api = fakeApi(routes([handoff], [['POST', /dispatches$/, () => { throw Object.assign(new Error('boom'), { status: 500 }); }]]));
    await assert.rejects(resume(ctx(), api, silent, eventFor()), /boom/);
    const edited = api.calls.filter((call) => call.method === 'PATCH' && call.path.endsWith('comments/50')).at(-1).body.body;
    assert.equal(edited, handoffBody);
    assert.match(posts(api, /issues\/7\/comments$/).at(-1).body.body, /could not dispatch pr-fix\.yml \(500\)/);
  });
});

describe('requestReview', () => {
  const routes = (comments = [], reviews = []) => [
    ['GET', /pulls\/8$/, { number: 8, user: { login: 'agent[bot]' }, head: { sha: 'b'.repeat(40) }, base: { ref: 'main' }, milestone: null }],
    ['GET', /issues\/8\/comments$/, comments],
    ['GET', /pulls\/8\/reviews$/, reviews],
    ['POST', /pulls\/8\/requested_reviewers$/, {}],
    ['POST', /issues\/8\/comments$/, {}]
  ];
  const closing = { repository: { pullRequest: { closingIssuesReferences: { nodes: [{ milestone: { title: 'M1', description: '<!-- ai-delivery requested-by=alice -->' } }] } } } };

  it('requests a review from the requester and mentions them once', async () => {
    const api = fakeApi(routes(), closing);
    await requestReview(ctxFor({ pr: '8', 'required-approvals': '1' }), api, silent);
    assert.deepEqual(posts(api, /requested_reviewers$/)[0].body, { reviewers: ['alice'] });
    assert.match(posts(api, /comments$/)[0].body.body, /^<!-- merge-decision review-requested=alice -->\n@alice this pull request into `main` needs 1 human approval/);

    const again = fakeApi(routes([{ user: { type: 'Bot' }, body: '<!-- merge-decision review-requested=alice -->' }]), closing);
    await requestReview(ctxFor({ pr: '8' }), again, silent);
    assert.equal(posts(again, /./).length, 0);
  });

  it('mentions again when an approval after the mention is on an older commit', async () => {
    const asked = { user: { type: 'Bot' }, body: '<!-- merge-decision review-requested=alice -->', created_at: '2026-11-27T10:00:00Z' };
    const approval = (commit, at, type = 'User', login = 'alice') => ({ state: 'APPROVED', user: { login, type }, commit_id: commit, submitted_at: at });
    const stale = fakeApi(routes([asked], [approval('a'.repeat(40), '2026-11-27T11:00:00Z')]), closing);
    await requestReview(ctxFor({ pr: '8' }), stale, silent);
    assert.match(posts(stale, /comments$/)[0].body.body, /@alice your approval is on an older commit: this pull request/);

    for (const reviews of [
      [approval('b'.repeat(40), '2026-11-27T11:00:00Z')],
      [approval('a'.repeat(40), '2026-11-27T09:00:00Z')],
      [approval('a'.repeat(40), '2026-11-27T11:00:00Z', 'Bot', 'agent[bot]')]
    ]) {
      const api = fakeApi(routes([asked], reviews), closing);
      await requestReview(ctxFor({ pr: '8' }), api, silent);
      assert.equal(posts(api, /comments$/).length, 0);
    }
  });

  it('does nothing without a requester', async () => {
    const api = fakeApi(routes());
    assert.match((await requestReview(ctxFor({ pr: '8' }), api, silent))[0], /No requester found/);
  });
});

describe('createClient', () => {
  it('follows pagination links and raises API errors with the status', async () => {
    const pages = {
      'https://api.test/items?per_page=100': { body: [1, 2], link: '<https://api.test/items?page=2>; rel="next"' },
      'https://api.test/items?page=2': { body: [3], link: '' }
    };
    const fetchImpl = async (url) => {
      const page = pages[url];
      if (!page) return new Response(JSON.stringify({ message: 'Nope' }), { status: 403 });
      return new Response(JSON.stringify(page.body), { status: 200, headers: { link: page.link } });
    };
    const client = createClient({ token: 't', apiUrl: 'https://api.test', fetchImpl });
    assert.deepEqual(await client.paginate('/items'), [1, 2, 3]);
    await assert.rejects(client.request('GET', '/other'), (error) => error.status === 403 && /Nope/.test(error.message));
  });
});

describe('followUp project status', () => {
  it('mirrors the final status labels with the options from the profile', async () => {
    const profile = ['- Project: octo/1', '- Project status options:', '  - ready=Ready', '  - needs-review=Readiness Review'].join('\n');
    const api = milestoneRepo({
      issues: [{ number: 4, labels: [label('status:needs-review')] }],
      extra: [['GET', /^\/repos\/octo\/app\/contents\/docs\/ai\/delivery\.md\?ref=main$/, { content: Buffer.from(profile).toString('base64') }]]
    });
    const updates = [];
    api.graphql = async (query, variables) => {
      if (query.includes('organization(login')) return { organization: { projectV2: { id: 'P', field: { id: 'F', options: [{ id: 'o-rr', name: 'Readiness Review' }] } } } };
      if (query.includes('repository(owner')) return { repository: { issue: { id: 'N4', projectItems: { nodes: [{ id: 'I4', project: { id: 'P' }, fieldValueByName: { name: 'Backlog' } }] } } } };
      if (query.includes('updateProjectV2ItemFieldValue')) { updates.push(variables); return {}; }
      throw new Error(`unexpected ${query}`);
    };
    const summary = await followUp(ctxFor({ task: 'technical-refinement', milestone: 'JIRA:DEV-1', 'requested-by': 'alice', project: 'octo/1' }), api, silent);
    assert.deepEqual(updates, [{ project: 'P', item: 'I4', field: 'F', option: 'o-rr' }]);
    assert.match(summary.join('\n'), /Set Status of #4 to Readiness Review\./);
  });
});

describe('syncProjectStatus', () => {
  // Routes GraphQL calls by operation and records them.
  function projectApi({ items = {}, org = true } = {}) {
    const calls = [];
    const field = { id: 'F', options: [{ id: 'o-ready', name: 'Ready' }, { id: 'o-review', name: 'In review' }, { id: 'o-blocked', name: 'Blocked' }] };
    return {
      calls,
      async graphql(query, variables) {
        calls.push({ query, variables });
        if (query.includes('organization(login')) {
          if (!org) throw new Error("GraphQL failed: Could not resolve to an Organization with the login of 'alice'.");
          return { organization: { projectV2: { id: 'P', field } } };
        }
        if (query.includes('user(login')) return { user: { projectV2: { id: 'P', field } } };
        if (query.includes('repository(owner')) {
          const nodes = items[variables.number] ? [{ id: `I${variables.number}`, project: { id: 'P' }, fieldValueByName: { name: items[variables.number] } }] : [];
          return { repository: { issue: { id: `N${variables.number}`, projectItems: { nodes } } } };
        }
        if (query.includes('addProjectV2ItemById')) return { addProjectV2ItemById: { item: { id: `new-${variables.content}` } } };
        if (query.includes('updateProjectV2ItemFieldValue')) return { updateProjectV2ItemFieldValue: { projectV2Item: { id: variables.item } } };
        throw new Error(`unexpected query ${query}`);
      }
    };
  }
  const config = (options = {}) => ({
    project: { owner: 'octo', number: 1 },
    projectField: 'Status',
    projectOptions: { ready: 'Ready', 'in-review': 'In review', 'technical-blocked': 'Blocked', done: 'Done', ...options }
  });
  const warnings = [];
  const log = { ...silent, warning: (message) => warnings.push(message) };

  it('sets the option of each issue state, adding missing items and skipping matching ones', async () => {
    const api = projectApi({ items: { 4: 'Ready', 5: 'Ready' } });
    const summary = await syncProjectStatus(api, REPO, config(), [{ number: 4, state: 'ready' }, { number: 5, state: 'in-review' }, { number: 6, state: 'technical-blocked' }], log);
    const updates = api.calls.filter((call) => call.query.includes('updateProjectV2ItemFieldValue')).map((call) => call.variables);
    assert.deepEqual(updates, [
      { project: 'P', item: 'I5', field: 'F', option: 'o-review' },
      { project: 'P', item: 'new-N6', field: 'F', option: 'o-blocked' }
    ]);
    assert.deepEqual(summary, ['Set Status of #5 to In review.', 'Set Status of #6 to Blocked.']);
  });

  it('falls back to a user project and warns about a missing option without failing', async () => {
    warnings.length = 0;
    const api = projectApi({ org: false });
    const summary = await syncProjectStatus(api, REPO, config(), [{ number: 7, state: 'done' }], log);
    assert.deepEqual(summary, []);
    assert.match(warnings.join('\n'), /no option 'Done' for done; #7 not mirrored/);
    assert.ok(api.calls.some((call) => call.query.includes('user(login')));
  });

  it('does nothing without a project', async () => {
    const api = projectApi();
    assert.deepEqual(await syncProjectStatus(api, REPO, { ...config(), project: null }, [{ number: 4, state: 'ready' }], log), []);
    assert.equal(api.calls.length, 0);
  });
});
