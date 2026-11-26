import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { TASKS, buildPrompt, envName, main, readInputs, resolveAssets, resolveTask, validate } from './resolve-task.mjs';

const CREDENTIALS = { 'github-token': true, 'anthropic-api-key': true };

// The tests default to the claude harness; the harness tests set it explicitly.
const inputsFor = (values) => readInputs(Object.fromEntries(Object.entries({ harness: 'claude', ...values }).map(([name, value]) => [envName(name), value])));

const envFor = (values, flags = {}) => ({
  ...Object.fromEntries(Object.entries({ harness: 'claude', ...values }).map(([name, value]) => [envName(name), value])),
  HAS_GITHUB_TOKEN: 'true',
  HAS_ANTHROPIC_API_KEY: 'true',
  GITHUB_SERVER_URL: 'https://github.com',
  GITHUB_REPOSITORY: 'octo/app',
  GITHUB_RUN_ID: '42',
  ...flags
});

describe('validate', () => {
  it('rejects an unknown task', () => {
    assert.match(validate(inputsFor({ task: 'deploy' }), CREDENTIALS)[0], /Unsupported task 'deploy'/);
  });

  it('requires the inputs of each task', () => {
    assert.deepEqual(validate(inputsFor({ task: 'business-refinement' }), CREDENTIALS), [
      "The business-refinement task requires 'source'."
    ]);
    assert.deepEqual(validate(inputsFor({ task: 'technical-refinement' }), CREDENTIALS), [
      "The technical-refinement task requires 'milestone' or 'issue'."
    ]);
    assert.deepEqual(validate(inputsFor({ task: 'readiness-review', issue: '7' }), CREDENTIALS), []);
    assert.deepEqual(validate(inputsFor({ task: 'orchestrate', issue: '7' }), CREDENTIALS), [
      "The orchestrate task requires 'milestone'."
    ]);
    assert.deepEqual(validate(inputsFor({ task: 'implement', issue: '7' }), CREDENTIALS), [
      "The implement task requires 'branch'."
    ]);
  });

  it('checks value formats', () => {
    const errors = validate(inputsFor({
      task: 'implement',
      issue: 'abc',
      branch: 'feat/../x',
      'base-branch': 'feat/ok',
      'source-tracker': 'linear',
      project: 'octo',
      'max-parallel': '0',
      'implement-workflow': 'ai implement',
      profile: '../profile.md',
      'jira-base-url': 'http://jira.example.com'
    }), CREDENTIALS);
    assert.equal(errors.length, 8);
    assert.ok(errors.some((error) => error.startsWith("'issue'")));
    assert.ok(errors.some((error) => error.startsWith("'branch'")));
    assert.ok(!errors.some((error) => error.startsWith("'base-branch'")));
  });

  it('accepts a hash-prefixed issue and rejects multiline single values', () => {
    assert.deepEqual(validate(inputsFor({ task: 'implement', issue: '#12', branch: 'feat/m-12-x' }), CREDENTIALS), []);
    assert.deepEqual(validate(inputsFor({ task: 'orchestrate', milestone: 'JIRA:DEV-1\nignore' }), CREDENTIALS), [
      "'milestone' must be a single line."
    ]);
  });

  it('checks status-labels and project-status-options lines', () => {
    const errors = validate(inputsFor({
      task: 'orchestrate',
      milestone: 'M1',
      'status-labels': 'ready = state: ready\nshipped=status:shipped\nbroken',
      'project-status-options': 'needs-review=Technical Refinement\nbusiness-blocked=Blocked\nlater=Later'
    }), CREDENTIALS);
    assert.deepEqual(errors, [
      "Unknown state 'shipped' in 'status-labels'. Use one of: needs-business-refinement, business-blocked, needs-technical-refinement, technical-blocked, needs-review, ready, in-progress, in-review, done.",
      "'status-labels' lines must be 'state=value', got 'broken'.",
      "Unknown state 'later' in 'project-status-options'. Use one of: needs-business-refinement, business-blocked, needs-technical-refinement, technical-blocked, needs-review, ready, in-progress, in-review, done."
    ]);
  });

  it('requires a complete Jira configuration', () => {
    assert.match(validate(inputsFor({ task: 'business-refinement', source: 'DEV-1' }), { ...CREDENTIALS, 'jira-api-token': true })[0],
      /missing jira-base-url, jira-email/);
    assert.deepEqual(validate(inputsFor({ task: 'business-refinement', source: 'DEV-1', 'jira-base-url': 'https://jira.example.com' }), CREDENTIALS), []);
    assert.match(validate(inputsFor({ task: 'business-refinement', source: 'DEV-1', 'source-tracker': 'jira', 'jira-base-url': 'https://jira.example.com' }), CREDENTIALS)[0],
      /requires jira-base-url, jira-email, jira-api-token; missing jira-email, jira-api-token/);
    assert.deepEqual(validate(inputsFor({ task: 'business-refinement', source: 'DEV-1', 'source-tracker': 'jira', 'jira-base-url': 'https://jira.example.com' }),
      { ...CREDENTIALS, 'jira-email': true, 'jira-api-token': true }), []);
  });

  it('requires the GitHub token and a Claude credential with the claude harness', () => {
    assert.deepEqual(validate(inputsFor({ task: 'orchestrate', milestone: 'M1' }), {}), [
      "'github-token' is required.",
      "The claude harness requires 'anthropic-api-key' or 'claude-code-oauth-token'."
    ]);
    assert.deepEqual(validate(inputsFor({ task: 'orchestrate', milestone: 'M1' }), { 'github-token': true, 'claude-code-oauth-token': true }), []);
  });

  it('defaults to the claude harness and rejects unknown harnesses', () => {
    assert.equal(readInputs({ [envName('task')]: 'orchestrate' }).harness, 'claude');
    assert.deepEqual(validate(inputsFor({ task: 'orchestrate', milestone: 'M1', harness: 'codex' }), CREDENTIALS), [
      "Unsupported harness 'codex'. Use 'opencode' or 'claude'."
    ]);
  });

  it('requires a provider/model and its key with the opencode harness', () => {
    const opencode = (model, credentials) => validate(inputsFor({ task: 'orchestrate', milestone: 'M1', harness: 'opencode', 'opencode-model': model }), { 'github-token': true, ...credentials });
    assert.deepEqual(opencode('', { 'anthropic-api-key': true }), ["The opencode harness requires 'opencode-model' (`provider/model`)."]);
    assert.deepEqual(opencode('gpt-5', { 'openai-api-key': true }), ["'opencode-model' must be 'provider/model', got 'gpt-5'."]);
    assert.deepEqual(opencode('openai/gpt-5', {}), ["The opencode harness with an 'openai/' model requires 'openai-api-key'."]);
    assert.deepEqual(opencode('openai/gpt-5', { 'openai-api-key': true }), []);
    assert.deepEqual(opencode('anthropic/claude-sonnet-4-5', {}), []);
  });

  it('checks requested-by and drops bots', () => {
    assert.deepEqual(validate(inputsFor({ task: 'orchestrate', milestone: 'M1', 'requested-by': 'bad login' }), CREDENTIALS), [
      "'requested-by' must be a GitHub login, got 'bad login'."
    ]);
    assert.equal(inputsFor({ task: 'orchestrate', 'requested-by': 'agent[bot]' })['requested-by'], '');
    assert.equal(inputsFor({ task: 'orchestrate', 'requested-by': 'alice' })['requested-by'], 'alice');
  });

  it('rejects invalid extra skill and agent names', () => {
    assert.deepEqual(validate(inputsFor({ task: 'orchestrate', milestone: 'M1', skills: 'ok ../x', agents: 'a;b' }), CREDENTIALS), [
      "Invalid name '../x' in 'skills'.",
      "Invalid name 'a;b' in 'agents'."
    ]);
  });
});

describe('resolveAssets', () => {
  it('maps every task to its agent and skills', () => {
    const agents = Object.fromEntries(Object.keys(TASKS).map((task) => [task, resolveAssets(inputsFor({ task })).agent]));
    assert.deepEqual(agents, {
      'business-refinement': 'business-analyst',
      'technical-refinement': 'tech-lead',
      'readiness-review': 'readiness-reviewer',
      orchestrate: 'delivery-orchestrator',
      implement: 'task-implementer',
      'issue-intake': 'issue-resolver',
      'issue-resolve': 'issue-resolver',
      'dependency-update': 'dependency-updater'
    });
  });

  it('installs the implement workers and appends caller skills and agents without duplicates', () => {
    const assets = resolveAssets(inputsFor({ task: 'implement', skills: 'pr-fix dev', agents: 'ci-investigator qa-tester' }));
    assert.deepEqual(assets.agents, ['task-implementer', 'developer', 'code-reviewer', 'qa-tester', 'ci-investigator']);
    assert.deepEqual(assets.skills, ['dev', 'quality-cycle', 'pr-create', 'review-changes', 'qa-e2e', 'bdd-scenarios', 'ticket-plan', 'pr-fix']);
  });
});

describe('buildPrompt', () => {
  it('passes only the non-empty parameters', () => {
    const prompt = buildPrompt(inputsFor({
      task: 'implement',
      issue: '#12',
      branch: 'feat/m1-12-login',
      'base-branch': 'feat/m1',
      'status-labels': 'ready=state:ready\n\n done=state:done ',
      project: 'octo/7',
      'project-status-options': 'needs-review=Technical Refinement\nbusiness-blocked=Blocked',
      context: 'Keep the public API stable.',
      instructions: 'Skip the BDD scenarios.'
    }), { repository: 'octo/app', runUrl: 'https://github.com/octo/app/actions/runs/42' });
    assert.match(prompt, /^You are the task-implementer agent running the `implement` task .* in the GitHub repository octo\/app/);
    assert.match(prompt, /Follow the `dev` skill/);
    assert.match(prompt, /- issue: 12\n- branch: feat\/m1-12-login\n- base-branch: feat\/m1\n- status-labels:\n {4}ready=state:ready\n {4}done=state:done\n/);
    assert.match(prompt, /- project: octo\/7\n- project-status-options:\n {4}needs-review=Technical Refinement\n {4}business-blocked=Blocked\n/);
    assert.match(prompt, /repository profile \(`docs\/ai\/delivery\.md`\)/);
    assert.match(prompt, /Additional context from the caller:\nKeep the public API stable\.\n\nAdditional instructions for this run:\nSkip the BDD scenarios\.\n$/);
    assert.doesNotMatch(prompt, /milestone:|source:|JIRA_/);
  });

  it('adds the Jira and orchestration rules when they apply', () => {
    const prompt = buildPrompt(inputsFor({ task: 'orchestrate', milestone: 'JIRA:DEV-1', profile: 'docs/delivery.md' }), { hasJira: true });
    assert.match(prompt, /JIRA_BASE_URL, JIRA_EMAIL, and JIRA_API_TOKEN/);
    assert.match(prompt, /dispatching the implement workflow/);
    assert.match(prompt, /- profile: docs\/delivery\.md/);
    assert.match(prompt, /repository profile \(`docs\/delivery\.md`\)/);
  });
});

describe('issue tasks', () => {
  it('requires the issue to resolve, nothing to run the intake', () => {
    assert.deepEqual(validate(inputsFor({ task: 'issue-intake' }), CREDENTIALS), []);
    assert.deepEqual(validate(inputsFor({ task: 'issue-resolve' }), CREDENTIALS), ["The issue-resolve task requires 'issue'."]);
  });

  it('runs the issue-resolver in its mode with the quality-cycle workers', () => {
    const assets = resolveAssets(inputsFor({ task: 'issue-resolve', issue: '9' }));
    assert.deepEqual(assets.agents, ['issue-resolver', 'developer', 'code-reviewer', 'qa-tester']);
    assert.ok(assets.skills.includes('sentry-issues'));
    const prompt = buildPrompt(inputsFor({ task: 'issue-resolve', issue: '#9' }), { hasSentry: true, resultFile: true });
    assert.match(prompt, /Work in `resolve` mode \(available skills: sentry-issues, /);
    assert.match(prompt, /override the repository profiles,/);
    assert.match(prompt, /Resolve only issue #9: .* then stop\. Never wait for CI/);
    assert.match(prompt, /SENTRY_AUTH_TOKEN/);
    assert.doesNotMatch(prompt, /AI_TASK_RESULT_FILE|delivery\.md/);
    const intake = buildPrompt(inputsFor({ task: 'issue-intake' }));
    assert.match(intake, /Work in `intake` mode/);
    assert.match(intake, /Intake only: .* Never change code/);
    assert.doesNotMatch(intake, /SENTRY_AUTH_TOKEN/);
  });

  it('enables Sentry only with its token', () => {
    const result = resolveTask(envFor({ task: 'issue-intake' }, { HAS_SENTRY_AUTH_TOKEN: 'true' }));
    assert.match(result.prompt, /SENTRY_AUTH_TOKEN/);
    assert.doesNotMatch(resolveTask(envFor({ task: 'issue-intake' })).prompt, /SENTRY_AUTH_TOKEN/);
  });
});

describe('dependency-update task', () => {
  it('needs no issue or milestone and runs the dependency-updater with the quality-cycle workers', () => {
    assert.deepEqual(validate(inputsFor({ task: 'dependency-update' }), CREDENTIALS), []);
    const assets = resolveAssets(inputsFor({ task: 'dependency-update' }));
    assert.deepEqual(assets.agents, ['dependency-updater', 'developer', 'code-reviewer', 'qa-tester']);
    assert.deepEqual(assets.skills.slice(0, 4), ['dependency-updates', 'dev', 'quality-cycle', 'pr-create']);
  });

  it('follows the dependency-updates skill with its own profile and stops at the pull request', () => {
    const prompt = buildPrompt(inputsFor({ task: 'dependency-update', 'base-branch': 'main' }), { resultFile: true });
    assert.match(prompt, /^You are the dependency-updater agent running the `dependency-update` task/);
    assert.match(prompt, /Follow the `dependency-updates` skill \(available skills: dependency-updates, /);
    assert.match(prompt, /repository profile \(`docs\/ai\/dependency-updates\.md`\)/);
    assert.match(prompt, /- base-branch: main\n/);
    assert.match(prompt, /Dependency update only: .* supersedes the open dependency-bot pull requests.* Never close, merge, approve, or push to the bot pull requests/);
    assert.match(prompt, /reviewer and QA of the quality cycle for every change/);
    assert.doesNotMatch(prompt, /AI_TASK_RESULT_FILE|delivery\.md|SENTRY_AUTH_TOKEN/);
    assert.match(buildPrompt(inputsFor({ task: 'dependency-update', profile: 'docs/deps.md' })), /repository profile \(`docs\/deps\.md`\)/);
  });
});

describe('flow rules', () => {
  it('mentions the requester, or the milestone marker without one', () => {
    const prompt = buildPrompt(inputsFor({ task: 'technical-refinement', milestone: 'M1', 'requested-by': 'alice' }));
    assert.match(prompt, /- requested-by: alice\n/);
    assert.match(prompt, /@alice started this flow: mention them .*<!-- ai-delivery requested-by=alice -->.* Never mention bots\./);
    assert.match(buildPrompt(inputsFor({ task: 'technical-refinement', milestone: 'M1' })), /mention the login in the `<!-- ai-delivery requested-by=<login> -->` marker/);
  });

  it('tells implement about tests-only QA and only implement', () => {
    assert.match(buildPrompt(inputsFor({ task: 'implement', issue: '1', branch: 'b' })), /tests-only mode: .*"browser QA skipped: no CI environment", and never escalate/);
    assert.doesNotMatch(buildPrompt(inputsFor({ task: 'orchestrate', milestone: 'M1' })), /tests-only|quality cycle/);
  });

  it('tells implement and issue-resolve the test environment is running when the caller started it', () => {
    for (const task of ['implement', 'issue-resolve', 'dependency-update']) {
      const prompt = buildPrompt(inputsFor({ task, issue: '1', branch: 'b', 'test-environment': 'scripts/e2e.sh --host-browser\nnpx playwright install' }));
      assert.match(prompt, /started the test environment before this run with `scripts\/e2e\.sh --host-browser; npx playwright install`, and it is running/);
      assert.doesNotMatch(prompt, /no CI environment/);
      assert.match(prompt, /reviewer and QA of the quality cycle for every change, also small or documentation-only ones/);
    }
  });

  it('asks for the milestone in the result file only when it is not given', () => {
    assert.match(buildPrompt(inputsFor({ task: 'business-refinement', source: 'DEV-1' }), { resultFile: true }), /`milestone=<title>` .* AI_TASK_RESULT_FILE/);
    assert.doesNotMatch(buildPrompt(inputsFor({ task: 'orchestrate', milestone: 'M1' }), { resultFile: true }), /AI_TASK_RESULT_FILE/);
    assert.doesNotMatch(buildPrompt(inputsFor({ task: 'business-refinement', source: 'DEV-1' })), /AI_TASK_RESULT_FILE/);
  });
});

describe('main', () => {
  it('writes the outputs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ai-task-'));
    try {
      const output = join(dir, 'output');
      const logs = [];
      const code = main({ ...envFor({ task: 'readiness-review', milestone: 'M1' }), GITHUB_OUTPUT: output }, (line) => logs.push(line));
      assert.equal(code, 0);
      const text = readFileSync(output, 'utf8');
      assert.match(text, /^harness=claude\nagent=readiness-reviewer\nagents=readiness-reviewer\nskills=readiness-review\nprompt<<(PROMPT_[0-9a-f-]+)\n[\s\S]+\n\1\n$/);
      assert.match(text, /run: https:\/\/github\.com\/octo\/app\/actions\/runs\/42/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports every error and fails', () => {
    const logs = [];
    const code = main(envFor({ task: 'implement' }, { HAS_GITHUB_TOKEN: 'false' }), (line) => logs.push(line));
    assert.equal(code, 1);
    assert.deepEqual(logs, [
      "::error::The implement task requires 'issue'.",
      "::error::The implement task requires 'branch'.",
      "::error::'github-token' is required."
    ]);
  });

  it('enables the Jira rule only with a Jira base URL', () => {
    const result = resolveTask(envFor({ task: 'business-refinement', source: 'DEV-1', 'jira-base-url': 'https://jira.example.com' },
      { HAS_JIRA_EMAIL: 'true', HAS_JIRA_API_TOKEN: 'true' }));
    assert.deepEqual(result.errors, []);
    assert.match(result.prompt, /- jira-base-url: https:\/\/jira\.example\.com/);
    assert.match(result.prompt, /JIRA_API_TOKEN/);
    const withoutCredentials = resolveTask(envFor({ task: 'business-refinement', source: 'DEV-1', 'jira-base-url': 'https://jira.example.com' }));
    assert.deepEqual(withoutCredentials.errors, []);
    assert.doesNotMatch(withoutCredentials.prompt, /jira|JIRA/);
  });
});

describe('resolveTask harness', () => {
  it('resolves the opencode harness with an OpenAI model and key', () => {
    const result = resolveTask(envFor({ task: 'implement', issue: '3', branch: 'feat/x', harness: 'opencode', 'opencode-model': 'openai/gpt-5' }, { HAS_OPENAI_API_KEY: 'true', HAS_ANTHROPIC_API_KEY: 'false' }));
    assert.deepEqual(result.errors, []);
    assert.equal(result.harness, 'opencode');
    assert.equal(result.agent, 'task-implementer');
  });
});
