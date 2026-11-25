// Pure helpers of the AI delivery flow: stages, markers, handoff comments, and the chaining decision.

export const STAGES = ['business-refinement', 'technical-refinement', 'readiness-review', 'orchestrate', 'implement', 'pr-fix'];

export const DEFAULT_STAGE_WORKFLOWS = {
  'business-refinement': 'ai-business-refinement.yml',
  'technical-refinement': 'ai-technical-refinement.yml',
  'readiness-review': 'ai-readiness-review.yml',
  orchestrate: 'ai-orchestrate.yml',
  implement: 'ai-implement.yml',
  'pr-fix': 'pr-fix.yml'
};

// What the flow does on its own once the stage is resumed.
export const NEXT_STEP = {
  'business-refinement': 'technical-refinement',
  'technical-refinement': 'readiness-review',
  'readiness-review': 'orchestrate',
  orchestrate: 'implement',
  implement: 'pull request review and merge decision',
  'pr-fix': 'merge decision'
};

// workflow_dispatch inputs each stage caller declares. Only these are sent.
// `instructions` is only sent by a resume; chained dispatches never set it.
export const STAGE_INPUTS = {
  'business-refinement': ['milestone', 'jira_key', 'requested_by', 'instructions'],
  'technical-refinement': ['milestone', 'issue', 'requested_by', 'instructions'],
  'readiness-review': ['milestone', 'issue', 'requested_by', 'instructions'],
  orchestrate: ['milestone', 'requested_by', 'instructions'],
  implement: ['issue', 'branch', 'base_branch', 'requested_by', 'instructions'],
  'pr-fix': ['pr_number', 'instructions']
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

// Blocked state -> the stage that answers it when resumed.
export const BLOCKED_STAGE = {
  'business-blocked': 'business-refinement',
  'technical-blocked': 'technical-refinement'
};

const WORKFLOW_FILE = /^[A-Za-z0-9_.-]+\.ya?ml$/;
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;

export const lines = (value = '') => value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
export const words = (value = '') => value.split(/\s+/).filter(Boolean);

export const isBotLogin = (login = '') => !login || /\[bot\]$/i.test(login) || login.toLowerCase() === 'github-actions';
export const isLogin = (login = '') => LOGIN.test(login);
export const humanLogin = (login = '') => (login && !isBotLogin(login) && isLogin(login) ? login : '');
export const isWorkflowFile = (value = '') => WORKFLOW_FILE.test(value);

export function isGitBranch(value) {
  return /^[A-Za-z0-9._/-]+$/.test(value)
    && !value.startsWith('/') && !value.startsWith('-') && !value.endsWith('/') && !value.endsWith('.')
    && !value.endsWith('.lock') && !value.includes('..') && !value.includes('//') && !value.includes('/.');
}

function parsePairs(text, name, check) {
  const values = {};
  const errors = [];
  for (const line of lines(text)) {
    const match = /^([a-z-]+)\s*=\s*(\S(?:.*\S)?)$/.exec(line);
    if (!match) {
      errors.push(`'${name}' lines must be 'key=value', got '${line}'.`);
      continue;
    }
    const error = check(match[1], match[2]);
    if (error) errors.push(error);
    else values[match[1]] = match[2];
  }
  return { values, errors };
}

export function parseStageWorkflows(text = '') {
  const { values, errors } = parsePairs(text, 'stage-workflows', (stage, file) => {
    if (!STAGES.includes(stage)) return `Unknown stage '${stage}' in 'stage-workflows'. Use one of: ${STAGES.join(', ')}.`;
    if (!isWorkflowFile(file)) return `'stage-workflows' value for ${stage} must be a workflow file name, got '${file}'.`;
    return '';
  });
  return { workflows: { ...DEFAULT_STAGE_WORKFLOWS, ...values }, overrides: values, errors };
}

export function parseStatusLabels(text = '') {
  const { values, errors } = parsePairs(text, 'status-labels', (state) =>
    (STATES.includes(state) ? '' : `Unknown state '${state}' in 'status-labels'. Use one of: ${STATES.join(', ')}.`));
  const labels = Object.fromEntries(STATES.map((state) => [state, values[state] ?? `status:${state}`]));
  return { labels, errors };
}

export function issueStates(labelNames, statusLabels) {
  const names = new Set(labelNames);
  return new Set(STATES.filter((state) => names.has(statusLabels[state])));
}

// Marker values are percent-encoded so titles with spaces or "-->" cannot break the comment.
export const encodeValue = (value = '') => encodeURIComponent(String(value)).replace(/%3A/gi, ':').replace(/%2F/gi, '/').replace(/%40/gi, '@');
export function decodeValue(value = '') {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function parseFields(text) {
  const fields = {};
  for (const token of words(text)) {
    const index = token.indexOf('=');
    if (index <= 0) continue;
    fields[token.slice(0, index)] = decodeValue(token.slice(index + 1));
  }
  return fields;
}

// <!-- ai-delivery requested-by=<login> --> in the milestone description.
const REQUESTED_BY = /<!-- ai-delivery requested-by=([^\s>]*) -->/;
export function parseRequestedBy(description = '') {
  return humanLogin(REQUESTED_BY.exec(description ?? '')?.[1] ?? '');
}
export function upsertRequestedBy(description = '', login) {
  const marker = `<!-- ai-delivery requested-by=${login} -->`;
  const text = description ?? '';
  if (REQUESTED_BY.test(text)) return text.replace(REQUESTED_BY, marker);
  return text ? `${text.replace(/\s+$/, '')}\n\n${marker}` : marker;
}

// <!-- ai-delivery-dispatches stage=N ... --> in the milestone description: the loop guard counters.
const DISPATCHES = /\n*<!-- ai-delivery-dispatches([^>]*?) -->/;
export function parseDispatchCounts(description = '') {
  const match = DISPATCHES.exec(description ?? '');
  if (!match) return {};
  const counts = {};
  for (const [stage, value] of Object.entries(parseFields(match[1]))) {
    if (STAGES.includes(stage) && /^[0-9]+$/.test(value)) counts[stage] = Number(value);
  }
  return counts;
}
export function upsertDispatchCounts(description = '', counts = {}) {
  const text = (description ?? '').replace(DISPATCHES, '');
  const entries = Object.entries(counts).filter(([, count]) => count > 0);
  if (entries.length === 0) return text;
  const marker = `<!-- ai-delivery-dispatches ${entries.map(([stage, count]) => `${stage}=${count}`).join(' ')} -->`;
  return text ? `${text.replace(/\s+$/, '')}\n\n${marker}` : marker;
}

export const MARKER_FIELDS = ['stage', 'milestone', 'issue', 'pr', 'requested-by', 'branch', 'base', 'jira', 'label', 'workflow', 'state'];
const RESUME_MARKER = /<!-- ai-resume ([^>]*?) -->/;

export function formatResumeMarker(fields) {
  return `<!-- ai-resume ${MARKER_FIELDS.map((name) => `${name}=${encodeValue(fields[name] ?? '')}`).join(' ')} -->`;
}

export function parseResumeMarker(body = '') {
  const match = RESUME_MARKER.exec(body ?? '');
  if (!match) return null;
  const parsed = parseFields(match[1]);
  return Object.fromEntries(MARKER_FIELDS.map((name) => [name, (parsed[name] ?? '').trim()]));
}

// Handoffs posted before the slash command offered a checkbox instead of the reply line; both still resume.
export const UNCHECKED_BOX = /^[ \t]*[-*] \[ \] Resume:.*$/m;
export const RESUME_LINE = /^(?:Reply `\/ai-resume`.*|[ \t]*[-*] \[[ xX]\] Resume:.*)$/m;

// A handoff is open while its marker says so; legacy markers without a state are open while the box is unchecked.
export function isOpenHandoff(body = '') {
  const fields = parseResumeMarker(body);
  if (!fields) return false;
  return fields.state ? fields.state === 'open' : UNCHECKED_BOX.test(body ?? '');
}

export function setHandoffState(body, state, line) {
  const fields = parseResumeMarker(body);
  if (!fields) return body;
  const next = body.replace(RESUME_MARKER, formatResumeMarker({ ...fields, state }));
  return line ? next.replace(RESUME_LINE, line) : next;
}

// `/ai-resume [stage] [instructions]` on the first line; the following lines are more instructions.
export function parseResumeCommand(body = '') {
  const [first = '', ...rest] = (body ?? '').replace(/^\s+/, '').split(/\r?\n/);
  const match = /^\/ai-resume(?:\s+(.*))?$/.exec(first.trim());
  if (!match) return null;
  let tail = (match[1] ?? '').trim();
  let stage = '';
  const [word] = words(tail);
  if (word && STAGES.includes(word)) {
    stage = word;
    tail = tail.slice(word.length).trim();
  }
  const instructions = [tail, ...rest].join('\n').trim();
  return { stage, instructions };
}

// The milestone title -> Jira key, from a template such as `JIRA:{key}`.
export function keyFromMilestone(title = '', template = '') {
  if (!title || !template || !template.includes('{key}')) return '';
  const [before, after] = template.split('{key}');
  const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`^${escape(before)}([A-Z][A-Z0-9_]*-[0-9]+)${escape(after ?? '')}$`).exec(title);
  return match ? match[1] : '';
}

export function milestoneFromKey(key = '', template = '') {
  if (!key || !template || !template.includes('{key}')) return '';
  return template.replace('{key}', key);
}

export function jiraKeyOf(source = '') {
  return /(?:^|[/=])([A-Z][A-Z0-9_]*-[0-9]+)(?:$|[?#/])/.exec(source.trim())?.[1] ?? '';
}

export function dispatchInputs(stage, values) {
  const inputs = {};
  for (const name of STAGE_INPUTS[stage] ?? []) {
    const value = values[name];
    if (value !== undefined && value !== null && String(value) !== '') inputs[name] = String(value);
  }
  return inputs;
}

const shellQuote = (value) => (/^[A-Za-z0-9_./:@-]+$/.test(value) ? value : `'${String(value).replaceAll("'", "'\\''")}'`);

export function resumeCommand(workflow, inputs, { removeLabel = '', pr = '' } = {}) {
  const run = [`gh workflow run ${workflow}`, ...Object.entries(inputs).map(([name, value]) => `-f ${name}=${shellQuote(value)}`)].join(' ');
  return removeLabel && pr ? `gh pr edit ${pr} --remove-label ${shellQuote(removeLabel)} && ${run}` : run;
}

// Values the marker and the dispatch share, from the handoff fields.
export function resumeValues(fields, requestedBy = fields['requested-by'], instructions = '') {
  return {
    milestone: fields.milestone,
    issue: fields.issue,
    jira_key: fields.jira,
    branch: fields.branch,
    base_branch: fields.base,
    pr_number: fields.pr,
    requested_by: requestedBy,
    instructions
  };
}

export function buildHandoff({
  stage,
  milestone = '',
  issue = '',
  pr = '',
  requestedBy = '',
  branch = '',
  base = '',
  jira = '',
  label = '',
  workflow,
  blocker = '',
  links = [],
  markers = []
}) {
  const fields = { stage, milestone, issue: String(issue || ''), pr: String(pr || ''), 'requested-by': humanLogin(requestedBy), branch, base, jira, label, workflow, state: 'open' };
  const where = [milestone && `milestone \`${milestone}\``, pr ? `pull request #${pr}` : issue && `issue #${issue}`].filter(Boolean).join(', ');
  const mention = fields['requested-by'] ? `@${fields['requested-by']} ` : '';
  const command = resumeCommand(workflow, dispatchInputs(stage, resumeValues(fields)), { removeLabel: stage === 'pr-fix' ? label : '', pr });
  const body = [
    ...markers,
    `${mention}the AI delivery flow stopped at **${stage}**${where ? ` (${where})` : ''} and needs a human.`,
    '',
    ...lines(blocker).slice(0, 3),
    ...(links.length > 0 ? ['', `Questions and details: ${links.join(', ')}`] : []),
    '',
    'Answer where the questions are, then resume.',
    `Reply \`/ai-resume\` (optionally with instructions on the next lines) to continue: ${stage} -> ${NEXT_STEP[stage]}.`,
    formatResumeMarker(fields),
    '',
    '<details>',
    '<summary>Resume from the command line</summary>',
    '',
    '```bash',
    command,
    '```',
    '',
    '</details>'
  ];
  return `${body.join('\n')}\n`;
}

export function hasOpenHandoff(comments, stage) {
  return comments.some((comment) => comment.user?.type === 'Bot'
    && isOpenHandoff(comment.body)
    && parseResumeMarker(comment.body)?.stage === stage);
}

const statesOf = (issues, state) => issues.filter((issue) => issue.states.has(state));

function blockedHandoffs(issues, states) {
  const handoffs = [];
  for (const state of states) {
    for (const issue of statesOf(issues, state)) {
      handoffs.push({ issue: issue.number, stage: BLOCKED_STAGE[state], reason: `blocked:${state}` });
    }
  }
  return handoffs;
}

// What to do after a successful stage run, from the status labels of the issues in scope.
export function decideSuccess({ task, issues, pr = null, escalated = false }) {
  const decision = { handoffs: [], dispatch: null, release: [] };
  const dispatch = (stage, state) => {
    decision.dispatch = { stage, issues: statesOf(issues, state).map((issue) => issue.number) };
  };
  const any = (state) => statesOf(issues, state).length > 0;

  if (task === 'business-refinement') {
    decision.handoffs = blockedHandoffs(issues, ['business-blocked']);
    if (decision.handoffs.length === 0 && any('needs-technical-refinement')) dispatch('technical-refinement', 'needs-technical-refinement');
  } else if (task === 'technical-refinement') {
    decision.handoffs = blockedHandoffs(issues, ['technical-blocked']);
    if (decision.handoffs.length > 0) return decision;
    if (any('needs-business-refinement')) dispatch('business-refinement', 'needs-business-refinement');
    else if (any('needs-review')) dispatch('readiness-review', 'needs-review');
  } else if (task === 'readiness-review') {
    decision.handoffs = blockedHandoffs(issues, ['business-blocked', 'technical-blocked']);
    if (decision.handoffs.length > 0) return decision;
    if (any('needs-business-refinement')) dispatch('business-refinement', 'needs-business-refinement');
    else if (any('needs-technical-refinement')) dispatch('technical-refinement', 'needs-technical-refinement');
    else if (any('ready')) dispatch('orchestrate', 'ready');
  } else if (task === 'implement') {
    const [issue] = issues;
    if (!issue) return decision;
    decision.handoffs = blockedHandoffs(issues, ['business-blocked', 'technical-blocked']);
    if (decision.handoffs.length > 0) return decision;
    if (escalated) {
      decision.handoffs.push({ issue: issue.number, stage: pr ? 'pr-fix' : 'implement', reason: 'escalated' });
    } else if (issue.states.has('in-progress') && !pr) {
      decision.handoffs.push({ issue: issue.number, stage: 'implement', reason: 'no-pr' });
      decision.release.push(issue.number);
    }
  }
  return decision;
}

// What to do after a failed or cancelled run: hand off the same stage (pr-fix once a PR exists) and free the slot.
export function decideFailure({ task, issues, pr = null }) {
  const decision = { handoffs: [], dispatch: null, release: [] };
  const stage = task === 'implement' && pr ? 'pr-fix' : task;
  decision.handoffs.push({ issue: issues[0]?.number ?? null, stage, reason: 'failed' });
  if (task === 'implement' && !pr) {
    decision.release.push(...issues.filter((issue) => issue.states.has('in-progress')).map((issue) => issue.number));
  }
  return decision;
}

export function blockerText(reason, { stage, task, issue, labels, runUrl, limit, count, error, failedStage, result }) {
  if (reason === 'failed') return `The ${task} run ${result === 'cancelled' ? 'was cancelled or timed out' : 'failed'}: ${runUrl}`;
  if (reason.startsWith('blocked:')) {
    const state = reason.slice('blocked:'.length);
    return `Issue #${issue} is labeled \`${labels[state]}\`: ${stage} needs answers before the flow can continue.`;
  }
  if (reason === 'escalated') return `The implementation of issue #${issue} was escalated to a human (${runUrl}).`;
  if (reason === 'no-pr') return `The implement run of issue #${issue} ended without a pull request (${runUrl}); the issue was moved back to \`${labels.ready}\`.`;
  if (reason === 'loop') return `The flow already dispatched ${stage} automatically ${count} times for this milestone (limit ${limit}); check the issues before resuming.`;
  if (reason === 'dispatch-failed') return `The flow could not dispatch ${failedStage}: ${error}`;
  return reason;
}
