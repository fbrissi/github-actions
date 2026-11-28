import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  parseProfileProject,
  parseProject,
  parseProjectStatusOptions,
  DEFAULT_STAGE_WORKFLOWS,
  buildHandoff,
  decideFailure,
  decideSuccess,
  dispatchInputs,
  hasOpenHandoff,
  humanLogin,
  issueStates,
  jiraKeyOf,
  keyFromMilestone,
  milestoneFromKey,
  parseDispatchCounts,
  parseRequestedBy,
  parseResumeMarker,
  parseStageWorkflows,
  parseStatusLabels,
  parseResumeCommand,
  resumeCommand,
  setHandoffState,
  upsertDispatchCounts,
  upsertRequestedBy
} from './delivery.mjs';

const { labels } = parseStatusLabels('');
const issue = (number, ...states) => ({ number, states: new Set(states) });

describe('settings', () => {
  it('merges stage workflow overrides into the defaults', () => {
    const result = parseStageWorkflows('implement = ai-build.yml\npr-fix=fix.yaml');
    assert.deepEqual(result.errors, []);
    assert.equal(result.workflows.implement, 'ai-build.yml');
    assert.equal(result.workflows['pr-fix'], 'fix.yaml');
    assert.equal(result.workflows.orchestrate, DEFAULT_STAGE_WORKFLOWS.orchestrate);
    assert.deepEqual(result.overrides, { implement: 'ai-build.yml', 'pr-fix': 'fix.yaml' });
  });

  it('resumes the code review and QA of a pull request on their own workflows', () => {
    for (const [stage, workflow] of [['code-review', 'code-review.yml'], ['qa', 'qa.yml']]) {
      assert.equal(DEFAULT_STAGE_WORKFLOWS[stage], workflow);
      assert.deepEqual(dispatchInputs(stage, { pr_number: '7', instructions: 'focus', issue: '3' }), { pr_number: '7', instructions: 'focus' });
    }
  });

  it('rejects unknown stages and non-workflow values', () => {
    assert.deepEqual(parseStageWorkflows('deploy=x.yml\nimplement=../x.yml\nbroken').errors, [
      "Unknown stage 'deploy' in 'stage-workflows'. Use one of: business-refinement, technical-refinement, readiness-review, orchestrate, implement, pr-fix, merge-decision, issue-intake, issue-resolve, dependency-update, code-review, qa.",
      "'stage-workflows' value for implement must be a workflow file name, got '../x.yml'.",
      "'stage-workflows' lines must be 'key=value', got 'broken'."
    ]);
  });

  it('maps status labels with overrides and reads issue states', () => {
    const custom = parseStatusLabels('ready=state: ready').labels;
    assert.equal(custom.ready, 'state: ready');
    assert.equal(custom['in-progress'], 'status:in-progress');
    assert.deepEqual([...issueStates(['state: ready', 'bug', 'status:in-progress'], custom)], ['ready', 'in-progress']);
  });
});

describe('logins and keys', () => {
  it('never treats bots as requesters', () => {
    assert.equal(humanLogin('alice'), 'alice');
    assert.equal(humanLogin('my-app[bot]'), '');
    assert.equal(humanLogin('github-actions'), '');
    assert.equal(humanLogin('bad login'), '');
  });

  it('maps Jira keys and milestone titles through the template', () => {
    assert.equal(jiraKeyOf('DEV-12'), 'DEV-12');
    assert.equal(jiraKeyOf('https://example.atlassian.net/browse/DEV-12'), 'DEV-12');
    assert.equal(jiraKeyOf('42'), '');
    assert.equal(milestoneFromKey('DEV-12', 'JIRA:{key}'), 'JIRA:DEV-12');
    assert.equal(keyFromMilestone('JIRA:DEV-12', 'JIRA:{key}'), 'DEV-12');
    assert.equal(keyFromMilestone('Sprint 3', 'JIRA:{key}'), '');
    assert.equal(keyFromMilestone('JIRA:DEV-12', ''), '');
  });
});

describe('milestone markers', () => {
  it('stores and replaces the requester', () => {
    const once = upsertRequestedBy('Goal.', 'alice');
    assert.equal(once, 'Goal.\n\n<!-- ai-delivery requested-by=alice -->');
    assert.equal(parseRequestedBy(once), 'alice');
    assert.equal(upsertRequestedBy(once, 'bob'), 'Goal.\n\n<!-- ai-delivery requested-by=bob -->');
    assert.equal(parseRequestedBy('<!-- ai-delivery requested-by=app[bot] -->'), '');
    assert.equal(upsertRequestedBy('', 'alice'), '<!-- ai-delivery requested-by=alice -->');
  });

  it('keeps and resets the dispatch counters', () => {
    const text = upsertDispatchCounts('Goal.', { 'technical-refinement': 2, orchestrate: 0 });
    assert.equal(text, 'Goal.\n\n<!-- ai-delivery-dispatches technical-refinement=2 -->');
    assert.deepEqual(parseDispatchCounts(text), { 'technical-refinement': 2 });
    assert.equal(upsertDispatchCounts(text, {}), 'Goal.');
    assert.deepEqual(parseDispatchCounts('none'), {});
  });
});

describe('handoff', () => {
  const body = buildHandoff({
    stage: 'technical-refinement',
    milestone: 'JIRA:DEV-1 phase 2',
    issue: 12,
    requestedBy: 'alice',
    workflow: 'ai-technical-refinement.yml',
    blocker: 'Issue #12 is blocked.\nSecond line.\nThird.\nFourth is dropped.',
    links: ['https://github.com/octo/app/issues/12#issuecomment-1']
  });

  it('mentions the requester, explains the blocker, and offers the slash command and a command line', () => {
    assert.match(body, /^@alice the AI delivery flow stopped at \*\*technical-refinement\*\* \(milestone `JIRA:DEV-1 phase 2`, issue #12\)/);
    assert.match(body, /Second line\.\nThird\.\n/);
    assert.doesNotMatch(body, /Fourth/);
    assert.match(body, /Reply `\/ai-resume` \(optionally with instructions on the next lines\) to continue: technical-refinement -> readiness-review\.\n<!-- ai-resume .* state=open -->/);
    assert.doesNotMatch(body, /\[ \]/);
    assert.match(body, /gh workflow run ai-technical-refinement\.yml -f milestone='JIRA:DEV-1 phase 2' -f issue=12 -f requested_by=alice/);
  });

  it('round-trips the marker fields', () => {
    assert.deepEqual(parseResumeMarker(body), {
      stage: 'technical-refinement',
      milestone: 'JIRA:DEV-1 phase 2',
      issue: '12',
      pr: '',
      'requested-by': 'alice',
      branch: '',
      base: '',
      jira: '',
      label: '',
      workflow: 'ai-technical-refinement.yml',
      state: 'open'
    });
  });

  it('cannot be closed early by a milestone title', () => {
    const tricky = buildHandoff({ stage: 'orchestrate', milestone: 'x --> <!-- ai-resume stage=implement', workflow: 'ai-orchestrate.yml' });
    assert.equal(parseResumeMarker(tricky).milestone, 'x --> <!-- ai-resume stage=implement');
    assert.equal(parseResumeMarker(tricky).stage, 'orchestrate');
  });

  it('never mentions bots and removes the escalation label in the pr-fix command', () => {
    const fix = buildHandoff({ stage: 'pr-fix', pr: 7, requestedBy: 'app[bot]', label: 'ai:needs-human', workflow: 'pr-fix.yml', markers: ['<!-- pr-fix escalated -->'] });
    assert.match(fix, /^<!-- pr-fix escalated -->\nthe AI delivery flow stopped at \*\*pr-fix\*\* \(pull request #7\)/);
    assert.match(fix, /gh pr edit 7 --remove-label ai:needs-human && gh workflow run pr-fix\.yml -f pr_number=7/);
    assert.match(fix, /continue: pr-fix -> merge decision\./);
  });

  it('detects an open handoff for the same stage from a bot only', () => {
    const comment = { user: { type: 'Bot' }, body };
    assert.equal(hasOpenHandoff([comment], 'technical-refinement'), true);
    assert.equal(hasOpenHandoff([comment], 'readiness-review'), false);
    assert.equal(hasOpenHandoff([{ ...comment, user: { type: 'User' } }], 'technical-refinement'), false);
    assert.equal(hasOpenHandoff([{ ...comment, body: setHandoffState(body, 'resumed', 'Resumed by @bob') }], 'technical-refinement'), false);
    const legacy = body.replace(/Reply `[^\n]*\n/, '- [ ] Resume: technical-refinement\n').replace(' state=open', '');
    assert.equal(hasOpenHandoff([{ ...comment, body: legacy }], 'technical-refinement'), true);
    assert.equal(hasOpenHandoff([{ ...comment, body: legacy.replace('- [ ] Resume', '- [x] Resume') }], 'technical-refinement'), false);
  });

  it('only sends the inputs a stage caller declares', () => {
    const values = { milestone: 'M1', issue: '3', jira_key: '', branch: 'feat/m1-3', base_branch: 'feat/m1', pr_number: '9', requested_by: 'alice' };
    assert.deepEqual(dispatchInputs('business-refinement', values), { milestone: 'M1', requested_by: 'alice' });
    assert.deepEqual(dispatchInputs('readiness-review', values), { milestone: 'M1', issue: '3', requested_by: 'alice' });
    assert.deepEqual(dispatchInputs('orchestrate', values), { milestone: 'M1', requested_by: 'alice' });
    assert.deepEqual(dispatchInputs('implement', values), { issue: '3', branch: 'feat/m1-3', base_branch: 'feat/m1', requested_by: 'alice' });
    assert.deepEqual(dispatchInputs('pr-fix', values), { pr_number: '9' });
    assert.deepEqual(dispatchInputs('pr-fix', { ...values, instructions: 'Be brief.' }), { pr_number: '9', instructions: 'Be brief.' });
    assert.equal(resumeCommand('ai-orchestrate.yml', { milestone: "it's" }), "gh workflow run ai-orchestrate.yml -f milestone='it'\\''s'");
  });
});

describe('parseResumeCommand', () => {
  it('reads the optional stage and the instructions', () => {
    assert.deepEqual(parseResumeCommand('/ai-resume'), { stage: '', instructions: '' });
    assert.deepEqual(parseResumeCommand('  /ai-resume implement use the v2 API\r\nand keep it small'), { stage: 'implement', instructions: 'use the v2 API\nand keep it small' });
    assert.deepEqual(parseResumeCommand('/ai-resume deploy now'), { stage: '', instructions: 'deploy now' });
    assert.deepEqual(parseResumeCommand('/ai-resume quality-cycle'), { stage: 'implement', instructions: '' });
    assert.equal(parseResumeCommand('/ai-resume delivery-orchestration').stage, 'orchestrate');
    assert.equal(parseResumeCommand('/ai-resume issue-resolver').stage, 'issue-resolve');
    assert.equal(parseResumeCommand('/ai-resume dependency-updater').stage, 'dependency-update');
    assert.deepEqual(parseResumeCommand('/ai-resume deploy-now please'), { stage: '', instructions: 'deploy-now please', unknownStage: 'deploy-now' });
    assert.equal(parseResumeCommand('/ai-resumes'), null);
    assert.equal(parseResumeCommand('Thanks!\n/ai-resume'), null);
  });
});

describe('decideSuccess', () => {
  it('business refinement hands off blocked issues, else dispatches technical refinement', () => {
    const blocked = decideSuccess({ task: 'business-refinement', issues: [issue(1, 'business-blocked'), issue(2, 'needs-technical-refinement')] });
    assert.deepEqual(blocked.handoffs, [{ issue: 1, stage: 'business-refinement', reason: 'blocked:business-blocked' }]);
    assert.equal(blocked.dispatch, null);
    const next = decideSuccess({ task: 'business-refinement', issues: [issue(2, 'needs-technical-refinement')] });
    assert.deepEqual(next.dispatch, { stage: 'technical-refinement', issues: [2] });
  });

  it('technical refinement goes back to business, then forward to readiness', () => {
    assert.equal(decideSuccess({ task: 'technical-refinement', issues: [issue(1, 'technical-blocked'), issue(2, 'needs-review')] }).dispatch, null);
    assert.equal(decideSuccess({ task: 'technical-refinement', issues: [issue(1, 'needs-business-refinement'), issue(2, 'needs-review')] }).dispatch.stage, 'business-refinement');
    assert.equal(decideSuccess({ task: 'technical-refinement', issues: [issue(2, 'needs-review')] }).dispatch.stage, 'readiness-review');
    assert.equal(decideSuccess({ task: 'technical-refinement', issues: [issue(2, 'ready')] }).dispatch, null);
  });

  it('readiness review hands off, sends back, or starts orchestration', () => {
    const blocked = decideSuccess({ task: 'readiness-review', issues: [issue(1, 'technical-blocked'), issue(2, 'business-blocked')] });
    assert.deepEqual(blocked.handoffs.map((item) => item.stage), ['business-refinement', 'technical-refinement']);
    assert.equal(decideSuccess({ task: 'readiness-review', issues: [issue(1, 'needs-business-refinement'), issue(2, 'needs-technical-refinement')] }).dispatch.stage, 'business-refinement');
    assert.equal(decideSuccess({ task: 'readiness-review', issues: [issue(1, 'needs-technical-refinement'), issue(2, 'ready')] }).dispatch.stage, 'technical-refinement');
    assert.deepEqual(decideSuccess({ task: 'readiness-review', issues: [issue(1, 'ready'), issue(2, 'in-progress')] }).dispatch, { stage: 'orchestrate', issues: [1] });
    assert.equal(decideSuccess({ task: 'readiness-review', issues: [issue(1, 'done')] }).dispatch, null);
  });

  it('orchestrate needs no chaining', () => {
    assert.deepEqual(decideSuccess({ task: 'orchestrate', issues: [issue(1, 'ready')] }), { handoffs: [], dispatch: null, release: [] });
  });

  it('implement hands off escalations and runs that opened no pull request', () => {
    assert.deepEqual(decideSuccess({ task: 'implement', issues: [issue(5, 'in-review')], pr: { number: 9 } }).handoffs, []);
    assert.deepEqual(decideSuccess({ task: 'implement', issues: [issue(5, 'in-review')], pr: { number: 9 }, escalated: true }).handoffs,
      [{ issue: 5, stage: 'pr-fix', reason: 'escalated' }]);
    assert.deepEqual(decideSuccess({ task: 'implement', issues: [issue(5, 'in-progress')], escalated: true }).handoffs,
      [{ issue: 5, stage: 'implement', reason: 'escalated' }]);
    const stuck = decideSuccess({ task: 'implement', issues: [issue(5, 'in-progress')] });
    assert.deepEqual(stuck.handoffs, [{ issue: 5, stage: 'implement', reason: 'no-pr' }]);
    assert.deepEqual(stuck.release, [5]);
  });
});

describe('decideFailure', () => {
  it('hands off the failed stage and frees the in-progress slot', () => {
    assert.deepEqual(decideFailure({ task: 'implement', issues: [issue(5, 'in-progress')] }),
      { handoffs: [{ issue: 5, stage: 'implement', reason: 'failed' }], dispatch: null, release: [5] });
  });

  it('resumes pr-fix and keeps the label once the pull request exists', () => {
    assert.deepEqual(decideFailure({ task: 'implement', issues: [issue(5, 'in-progress')], pr: { number: 9 } }),
      { handoffs: [{ issue: 5, stage: 'pr-fix', reason: 'failed' }], dispatch: null, release: [] });
  });

  it('targets no issue when the milestone has none', () => {
    assert.deepEqual(decideFailure({ task: 'business-refinement', issues: [] }).handoffs, [{ issue: null, stage: 'business-refinement', reason: 'failed' }]);
  });
});

describe('project status options', () => {
  it('maps states to options, defaulting to sentence case', () => {
    const { options, errors } = parseProjectStatusOptions('business-blocked=Blocked\nneeds-review=Readiness Review');
    assert.deepEqual(errors, []);
    assert.equal(options['business-blocked'], 'Blocked');
    assert.equal(options['needs-review'], 'Readiness Review');
    assert.equal(options['in-review'], 'In review');
    assert.match(parseProjectStatusOptions('shipped=Done').errors[0], /Unknown state 'shipped' in 'project-status-options'/);
  });

  it('parses owner/number projects', () => {
    assert.deepEqual(parseProject('oliblish-dev/1'), { owner: 'oliblish-dev', number: 1 });
    assert.equal(parseProject('octo'), null);
  });
});

describe('profile project', () => {
  it('reads the project, field, and indented options of a delivery profile', () => {
    const text = ['## Status', '- Status labels: defaults', '- Project: oliblish-dev/1', '- Project status field: Status', '- Project status options:',
      '    - needs-business-refinement=Backlog', '  - in-review=In review', '', '## Triage', '- Priority field: Priority'].join('\n');
    assert.deepEqual(parseProfileProject(text), { project: 'oliblish-dev/1', field: 'Status', options: 'needs-business-refinement=Backlog\nin-review=In review' });
  });

  it('ignores template placeholders', () => {
    assert.deepEqual(parseProfileProject('- Project: <owner/number | none>\n- Project status field: <Status>\n- Project status options: <state=Option name lines>'),
      { project: '', field: '', options: '' });
  });
});
