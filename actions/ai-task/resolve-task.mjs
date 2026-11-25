#!/usr/bin/env node
// Validates the ai-task inputs, maps the task to its agent, agents, and skills, and builds the non-interactive prompt.
import { randomUUID } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const IMPLEMENT_WORKERS = ['developer', 'code-reviewer', 'qa-tester'];

export const TASKS = {
  'business-refinement': {
    agent: 'business-analyst',
    agents: [],
    skills: ['business-refinement', 'ticket-create'],
    requires: [['source']]
  },
  'technical-refinement': {
    agent: 'tech-lead',
    agents: [],
    skills: ['technical-refinement', 'ticket-plan'],
    requires: [['milestone', 'issue']]
  },
  'readiness-review': {
    agent: 'readiness-reviewer',
    agents: [],
    skills: ['readiness-review'],
    requires: [['milestone', 'issue']]
  },
  orchestrate: {
    agent: 'delivery-orchestrator',
    agents: [],
    skills: ['delivery-orchestration', 'pr-create'],
    requires: [['milestone']]
  },
  implement: {
    agent: 'task-implementer',
    agents: IMPLEMENT_WORKERS,
    skills: ['dev', 'quality-cycle', 'pr-create', 'review-changes', 'qa-e2e', 'bdd-scenarios', 'ticket-plan'],
    requires: [['issue'], ['branch']]
  }
};

export const STATES = [
  'needs-business-refinement',
  'business-blocked',
  'needs-technical-refinement',
  'technical-blocked',
  'needs-review',
  'ready',
  'in-progress',
  'in-review',
  'done'
];

// Order of the parameters in the prompt. Multiline ones are passed as indented blocks.
export const PARAMETERS = [
  'task',
  'source',
  'source-tracker',
  'source-language',
  'milestone',
  'issue',
  'branch',
  'base-branch',
  'milestone-template',
  'output-language',
  'status-labels',
  'project',
  'project-status-field',
  'project-status-options',
  'research-sources',
  'profile',
  'implement-workflow',
  'max-parallel',
  'requested-by',
  'jira-base-url'
];

const MULTILINE = new Set(['status-labels', 'project-status-options', 'research-sources']);
const NAME = /^[A-Za-z0-9_.-]+$/;

export const envName = (input) => `AI_TASK_${input.toUpperCase().replaceAll('-', '_')}`;

// Bots never stand for the person who started the flow; the milestone marker names them instead.
export const isBotLogin = (login) => /\[bot\]$/i.test(login) || login.toLowerCase() === 'github-actions';

export function readInputs(env = process.env) {
  const inputs = {};
  for (const name of [...PARAMETERS, 'context', 'skills', 'agents', 'harness']) {
    inputs[name] = (env[envName(name)] ?? '').trim();
  }
  if (isBotLogin(inputs['requested-by'])) inputs['requested-by'] = '';
  return inputs;
}

const words = (value) => value.split(/\s+/).filter(Boolean);
const lines = (value) => value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
const unique = (values) => [...new Set(values)];

function isGitBranch(value) {
  return /^[A-Za-z0-9._/-]+$/.test(value)
    && !value.startsWith('/') && !value.startsWith('-') && !value.endsWith('/') && !value.endsWith('.')
    && !value.endsWith('.lock') && !value.includes('..') && !value.includes('//') && !value.includes('/.');
}

export function validate(inputs, credentials = {}) {
  const errors = [];
  const definition = TASKS[inputs.task];
  if (!definition) {
    errors.push(`Unsupported task '${inputs.task}'. Use one of: ${Object.keys(TASKS).join(', ')}.`);
    return errors;
  }

  for (const group of definition.requires) {
    if (!group.some((name) => inputs[name])) {
      errors.push(`The ${inputs.task} task requires ${group.map((name) => `'${name}'`).join(' or ')}.`);
    }
  }

  if (inputs.harness && inputs.harness !== 'claude') {
    errors.push(`Unsupported harness '${inputs.harness}'. ai-task runs agents, which only the 'claude' harness supports.`);
  }

  for (const name of PARAMETERS) {
    if (!MULTILINE.has(name) && /[\r\n]/.test(inputs[name])) errors.push(`'${name}' must be a single line.`);
  }

  if (inputs.issue && !/^#?[1-9][0-9]*$/.test(inputs.issue)) {
    errors.push(`'issue' must be an issue number, got '${inputs.issue}'.`);
  }
  for (const name of ['branch', 'base-branch']) {
    if (inputs[name] && !isGitBranch(inputs[name])) errors.push(`'${name}' is not a valid branch name: '${inputs[name]}'.`);
  }
  if (inputs['source-tracker'] && !['github', 'jira'].includes(inputs['source-tracker'])) {
    errors.push(`'source-tracker' must be 'github' or 'jira', got '${inputs['source-tracker']}'.`);
  }
  if (inputs.project && !/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\/[1-9][0-9]*$/.test(inputs.project)) {
    errors.push(`'project' must be 'owner/number', got '${inputs.project}'.`);
  }
  if (inputs['max-parallel'] && !/^[1-9][0-9]*$/.test(inputs['max-parallel'])) {
    errors.push(`'max-parallel' must be a positive integer, got '${inputs['max-parallel']}'.`);
  }
  if (inputs['implement-workflow'] && !/^[A-Za-z0-9_.-]+\.ya?ml$/.test(inputs['implement-workflow'])) {
    errors.push(`'implement-workflow' must be a workflow file name such as 'ai-implement.yml', got '${inputs['implement-workflow']}'.`);
  }
  if (inputs.profile && (inputs.profile.startsWith('/') || inputs.profile.split('/').includes('..'))) {
    errors.push(`'profile' must be a relative path inside the repository, got '${inputs.profile}'.`);
  }
  if (inputs['requested-by'] && !/^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/.test(inputs['requested-by'])) {
    errors.push(`'requested-by' must be a GitHub login, got '${inputs['requested-by']}'.`);
  }
  if (inputs['jira-base-url'] && !/^https:\/\/[^\s/]+(\/\S*)?$/.test(inputs['jira-base-url'])) {
    errors.push(`'jira-base-url' must be an https URL, got '${inputs['jira-base-url']}'.`);
  }

  for (const name of ['status-labels', 'project-status-options']) {
    for (const line of lines(inputs[name])) {
      const match = /^([a-z-]+)\s*=\s*(\S(?:.*\S)?)$/.exec(line);
      if (!match) {
        errors.push(`'${name}' lines must be 'state=value', got '${line}'.`);
      } else if (!STATES.includes(match[1])) {
        errors.push(`Unknown state '${match[1]}' in '${name}'. Use one of: ${STATES.join(', ')}.`);
      }
    }
  }

  for (const kind of ['skills', 'agents']) {
    for (const name of words(inputs[kind])) {
      if (!NAME.test(name)) errors.push(`Invalid name '${name}' in '${kind}'.`);
    }
  }

  const jira = ['jira-base-url', 'jira-email', 'jira-api-token'];
  const given = jira.filter((name) => (name === 'jira-base-url' ? inputs[name] : credentials[name]));
  const missing = jira.filter((name) => !given.includes(name));
  if ((credentials['jira-email'] || credentials['jira-api-token']) && missing.length > 0) {
    errors.push(`Jira needs all of ${jira.join(', ')}; missing ${missing.join(', ')}.`);
  } else if (missing.length > 0 && inputs['source-tracker'] === 'jira' && inputs.task === 'business-refinement') {
    errors.push(`The business-refinement task with source-tracker 'jira' requires ${jira.join(', ')}; missing ${missing.join(', ')}.`);
  }

  if (!credentials['github-token']) errors.push("'github-token' is required.");
  if (!credentials['anthropic-api-key'] && !credentials['claude-code-oauth-token']) {
    errors.push("The claude harness requires 'anthropic-api-key' or 'claude-code-oauth-token'.");
  }
  return errors;
}

export function resolveAssets(inputs) {
  const definition = TASKS[inputs.task];
  return {
    agent: definition.agent,
    agents: unique([definition.agent, ...definition.agents, ...words(inputs.agents)]),
    skills: unique([...definition.skills, ...words(inputs.skills)])
  };
}

function parameterLines(inputs) {
  const output = [];
  for (const name of PARAMETERS) {
    let value = inputs[name];
    if (!value) continue;
    if (name === 'issue') value = value.replace(/^#/, '');
    if (MULTILINE.has(name)) {
      output.push(`- ${name}:`, ...lines(value).map((line) => `    ${line}`));
    } else {
      output.push(`- ${name}: ${value}`);
    }
  }
  return output;
}

export function buildPrompt(inputs, { repository = '', runUrl = '', hasJira = false, resultFile = false } = {}) {
  const { agent, skills } = resolveAssets(inputs);
  const primarySkill = TASKS[inputs.task].skills[0];
  const profile = inputs.profile || 'docs/ai/delivery.md';
  const where = repository ? ` in the GitHub repository ${repository}` : '';
  const run = runUrl ? ` (run: ${runUrl})` : '';

  const rules = [
    '- This run is non-interactive: never wait for input or confirmation. When something blocks the task, write the questions where the task says (the source ticket or the GitHub issue), set the blocked status, and stop.',
    '- Use gh and git with the GitHub credentials already configured in the environment. Never print, echo, or log any token or credential.'
  ];
  if (hasJira) {
    rules.push('- Jira REST credentials are in the environment variables JIRA_BASE_URL, JIRA_EMAIL, and JIRA_API_TOKEN. Read them from the environment in your commands; never print or log their values.');
  }
  rules.push(inputs['requested-by']
    ? `- @${inputs['requested-by']} started this flow: mention them when you ask a question or stop for a human, and store \`<!-- ai-delivery requested-by=${inputs['requested-by']} -->\` in the description of a milestone you create. Never mention bots.`
    : '- When you ask a question or stop for a human, mention the login in the `<!-- ai-delivery requested-by=<login> -->` marker of the milestone description, if there is one. Never mention bots.');
  if (inputs.task === 'orchestrate') {
    rules.push('- This run is in GitHub Actions: start each ready issue by dispatching the implement workflow, never by implementing it here.');
  }
  if (inputs.task === 'implement') {
    rules.push("- Browser QA: when the profile's test environment is reachable (the caller may have started it before this run), run the BDD scenarios in a real browser. When no test environment is reachable, run QA in tests-only mode: rely on the automated tests that run as pull request checks (do not re-run them needlessly), report \"browser QA skipped: no CI environment\", and never escalate or block for that reason.");
  }
  if (resultFile && !inputs.milestone) {
    rules.push('- Before you stop, write one line `milestone=<title>` with the GitHub milestone you created or worked on to the file named by the AI_TASK_RESULT_FILE environment variable, so the flow can continue from it.');
  }

  const sections = [
    `You are the ${agent} agent running the \`${inputs.task}\` task of the AI task delivery flow${where}, non-interactively in GitHub Actions${run}.`,
    '',
    `Follow the \`${primarySkill}\` skill (available skills: ${skills.join(', ')}). The parameters below were set explicitly by the caller and override the repository profile (\`${profile}\`), which overrides the skill defaults. Any parameter not listed is unset: take it from the profile, then from the skill defaults.`,
    '',
    'Parameters:',
    ...parameterLines(inputs),
    '',
    'Rules:',
    ...rules
  ];
  if (inputs.context) {
    sections.push('', 'Additional context from the caller:', inputs.context);
  }
  return `${sections.join('\n')}\n`;
}

export function resolveTask(env = process.env) {
  const inputs = readInputs(env);
  const credentials = {
    'jira-email': env.HAS_JIRA_EMAIL === 'true',
    'jira-api-token': env.HAS_JIRA_API_TOKEN === 'true',
    'github-token': env.HAS_GITHUB_TOKEN === 'true',
    'anthropic-api-key': env.HAS_ANTHROPIC_API_KEY === 'true',
    'claude-code-oauth-token': env.HAS_CLAUDE_CODE_OAUTH_TOKEN === 'true'
  };
  const errors = validate(inputs, credentials);
  if (errors.length > 0) return { errors };
  // A Jira base URL alone (for example an organization variable) does not enable Jira.
  const hasJira = Boolean(inputs['jira-base-url'] && credentials['jira-email'] && credentials['jira-api-token']);
  if (!hasJira) inputs['jira-base-url'] = '';
  const runUrl = env.GITHUB_SERVER_URL && env.GITHUB_REPOSITORY && env.GITHUB_RUN_ID
    ? `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`
    : '';
  return {
    errors,
    ...resolveAssets(inputs),
    prompt: buildPrompt(inputs, {
      repository: env.GITHUB_REPOSITORY ?? '',
      runUrl,
      hasJira,
      resultFile: Boolean(env.AI_TASK_RESULT_FILE)
    })
  };
}

export function main(env = process.env, write = console.log) {
  const result = resolveTask(env);
  for (const error of result.errors) write(`::error::${error}`);
  if (result.errors.length > 0) return 1;

  const delimiter = `PROMPT_${randomUUID()}`;
  const output = [
    `agent=${result.agent}`,
    `agents=${result.agents.join(' ')}`,
    `skills=${result.skills.join(' ')}`,
    `prompt<<${delimiter}`,
    result.prompt.replace(/\n$/, ''),
    delimiter,
    ''
  ].join('\n');
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, output);
  write(`Task: ${env[envName('task')]}\nAgent: ${result.agent}\nAgents: ${result.agents.join(' ')}\nSkills: ${result.skills.join(' ')}`);
  write(`::group::Prompt\n${result.prompt}::endgroup::`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main();
}
