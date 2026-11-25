import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildHandoff } from './delivery.mjs';
import { createClient } from './github.mjs';
import { dispatchWorkflow, envName, followUp, handoff, parseResumeEvent, readContext, requestReview, resume } from './main.mjs';

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
    assert.match(body, /- \[ \] Resume: pr-fix -> continues automatically to merge decision/);
    assert.match(body, /gh pr edit 7 --remove-label ai:needs-human && gh workflow run pr-fix\.yml -f pr_number=7/);
  });

  it('rejects markers that are not HTML comments', async () => {
    await assert.rejects(handoff(ctxFor({ task: 'pr-fix', pr: '7', marker: 'hello' }), fakeApi([]), silent), /must be HTML comments/);
  });
});

describe('resume', () => {
  const handoffBody = buildHandoff({ stage: 'pr-fix', pr: 7, milestone: 'M1', requestedBy: 'alice', label: 'ai:needs-human', workflow: 'pr-fix.yml' });
  const eventFor = (overrides = {}) => ({
    action: 'edited',
    comment: { id: 99, user: { login: 'agent[bot]' }, body: handoffBody.replace('- [ ] Resume', '- [x] Resume') },
    changes: { body: { from: handoffBody } },
    sender: { login: 'bob' },
    issue: { number: 7 },
    repository: { default_branch: 'main' },
    ...overrides
  });

  it('acts only on a newly checked box of a trusted bot, edited by a person', () => {
    assert.equal(parseResumeEvent(eventFor(), ['agent[bot]']).fields.stage, 'pr-fix');
    assert.match(parseResumeEvent(eventFor(), ['other[bot]']).skip, /not a trusted bot/);
    assert.match(parseResumeEvent(eventFor({ sender: { login: 'agent[bot]' } }), ['agent[bot]']).skip, /not a person/);
    assert.match(parseResumeEvent(eventFor({ changes: {} }), ['agent[bot]']).skip, /not just checked/);
    assert.match(parseResumeEvent(eventFor({ changes: { body: { from: handoffBody.replace('- [ ] Resume', '- [x] Resume') } } }), ['agent[bot]']).skip, /not just checked/);
    const forged = eventFor();
    forged.comment.body = forged.comment.body.replace('workflow=pr-fix.yml', 'workflow=../evil.yml');
    assert.match(parseResumeEvent(forged, ['agent[bot]']).skip, /invalid workflow/);
  });

  it('checks the permission, removes the escalation label, dispatches, and rewrites the box', async () => {
    const api = fakeApi([
      ['GET', /collaborators\/bob\/permission$/, { permission: 'write', role_name: 'write' }],
      ['DELETE', /issues\/7\/labels\/ai%3Aneeds-human$/, []],
      ['GET', /milestones\?state=all$/, [{ number: 1, title: 'M1', description: 'x\n\n<!-- ai-delivery-dispatches orchestrate=3 -->' }]],
      ['PATCH', /milestones\/1$/, {}],
      ['GET', /issues\/comments\/99$/, { body: eventFor().comment.body }],
      ['POST', /pr-fix\.yml\/dispatches$/, { html_url: 'https://github.com/octo/app/actions/runs/5' }],
      ['PATCH', /issues\/comments\/99$/, {}]
    ]);
    await resume(ctxFor({ 'bot-login': 'agent[bot]' }), api, silent, eventFor());
    assert.deepEqual(api.calls.find((call) => call.path.endsWith('/dispatches')).body.inputs, { pr_number: '7' });
    assert.equal(api.calls.find((call) => call.path.endsWith('milestones/1')).body.description, 'x');
    const edited = api.calls.filter((call) => call.method === 'PATCH').at(-1).body.body;
    assert.match(edited, /^Resumed by @bob -> https:\/\/github\.com\/octo\/app\/actions\/runs\/5$/m);
    assert.doesNotMatch(edited, /\[[ xX]\] Resume/);
  });

  it('refuses people without write permission', async () => {
    const api = fakeApi([['GET', /permission$/, { permission: 'read', role_name: 'triage' }]]);
    const summary = await resume(ctxFor({ 'bot-login': 'agent[bot]' }), api, silent, eventFor());
    assert.match(summary[0], /has triage permission/);
    assert.equal(api.calls.length, 1);
  });

  it('unchecks the box and fails when the dispatch fails', async () => {
    const api = fakeApi([
      ['GET', /permission$/, { permission: 'admin', role_name: 'admin' }],
      ['DELETE', /labels/, []],
      ['GET', /milestones\?state=all$/, []],
      ['GET', /issues\/comments\/99$/, { body: eventFor().comment.body }],
      ['POST', /dispatches$/, () => { throw Object.assign(new Error('boom'), { status: 500 }); }],
      ['PATCH', /issues\/comments\/99$/, {}]
    ]);
    await assert.rejects(resume(ctxFor({ 'bot-login': 'agent[bot]' }), api, silent, eventFor()), /boom/);
    const edited = api.calls.filter((call) => call.method === 'PATCH').at(-1).body.body;
    assert.match(edited, /- \[ \] Resume: pr-fix/);
    assert.match(edited, /Resume by @bob failed/);
  });
});

describe('requestReview', () => {
  const routes = (comments = []) => [
    ['GET', /pulls\/8$/, { number: 8, user: { login: 'agent[bot]' }, base: { ref: 'main' }, milestone: null }],
    ['GET', /issues\/8\/comments$/, comments],
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
