#!/usr/bin/env node
// Deterministic steps of the AI delivery flow: follow-up (chain or hand off after a stage run), handoff, resume,
// and request-review. Every GitHub call goes through the injected client so the commands are testable.
import { appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
  NEXT_STEP,
  STAGES,
  blockerText,
  buildHandoff,
  decideFailure,
  decideSuccess,
  dispatchInputs,
  hasOpenHandoff,
  humanLogin,
  isSendBack,
  isGitBranch,
  isWorkflowFile,
  isOpenHandoff,
  issueStates,
  jiraKeyOf,
  keyFromMilestone,
  lines,
  milestoneFromKey,
  parseDispatchCounts,
  parseRequestedBy,
  parseResumeCommand,
  parseResumeMarker,
  parseStageWorkflows,
  parseStatusLabels,
  resumeValues,
  SEND_BACKS,
  setHandoffState,
  upsertDispatchCounts,
  upsertRequestedBy,
  words
} from './delivery.mjs';
import { createClient } from './github.mjs';

const TASKS = ['business-refinement', 'technical-refinement', 'readiness-review', 'orchestrate', 'implement', 'issue-intake', 'issue-resolve'];
// Issue tasks are not part of a milestone's delivery: their follow-up only hands off a failed run.
const ISSUE_TASKS = ['issue-intake', 'issue-resolve'];
const NAMES = [
  'command', 'task', 'result', 'milestone', 'result-milestone', 'issue', 'pr', 'branch', 'base-branch', 'source',
  'milestone-template', 'requested-by', 'blocker', 'marker', 'status-labels', 'stage-workflows', 'max-auto-dispatches',
  'max-send-backs', 'chain', 'escalation-label', 'trusted-bots', 'bot-login', 'jira-base-url', 'required-approvals'
];

export const envName = (name) => `AI_DELIVERY_${name.toUpperCase().replaceAll('-', '_')}`;

export function readContext(env = process.env) {
  const ctx = Object.fromEntries(NAMES.map((name) => [name, (env[envName(name)] ?? '').trim()]));
  ctx.repo = env.GITHUB_REPOSITORY ?? '';
  ctx.serverUrl = env.GITHUB_SERVER_URL || 'https://github.com';
  ctx.runUrl = env.GITHUB_RUN_ID ? `${ctx.serverUrl}/${ctx.repo}/actions/runs/${env.GITHUB_RUN_ID}` : '';
  ctx.ownWorkflow = /\/\.github\/workflows\/([^@/]+)@/.exec(env.GITHUB_WORKFLOW_REF ?? '')?.[1] ?? '';
  ctx.issue = ctx.issue.replace(/^#/, '');
  ctx.pr = ctx.pr.replace(/^#/, '');
  return ctx;
}

const number = (value) => (/^[1-9][0-9]*$/.test(String(value ?? '')) ? Number(value) : null);

function settings(ctx) {
  const errors = [];
  const stageWorkflows = parseStageWorkflows(ctx['stage-workflows']);
  const statusLabels = parseStatusLabels(ctx['status-labels']);
  errors.push(...stageWorkflows.errors, ...statusLabels.errors);
  for (const name of ['issue', 'pr']) {
    if (ctx[name] && !number(ctx[name])) errors.push(`'${name}' must be a number, got '${ctx[name]}'.`);
  }
  for (const name of ['branch', 'base-branch']) {
    if (ctx[name] && !isGitBranch(ctx[name])) errors.push(`'${name}' is not a valid branch name: '${ctx[name]}'.`);
  }
  for (const name of ['milestone', 'result-milestone', 'source', 'requested-by']) {
    if (/[\r\n]/.test(ctx[name])) errors.push(`'${name}' must be a single line.`);
  }
  const rawLimit = ctx['max-auto-dispatches'];
  const limit = rawLimit === '' ? 3 : /^[0-9]+$/.test(rawLimit) ? Number(rawLimit) : NaN;
  if (Number.isNaN(limit)) errors.push(`'max-auto-dispatches' must be a non-negative integer, got '${ctx['max-auto-dispatches']}'.`);
  const rawSendBacks = ctx['max-send-backs'];
  const sendBackLimit = rawSendBacks === '' ? 3 : /^[0-9]+$/.test(rawSendBacks) ? Number(rawSendBacks) : NaN;
  if (Number.isNaN(sendBackLimit)) errors.push(`'max-send-backs' must be a non-negative integer, got '${ctx['max-send-backs']}'.`);
  if (errors.length > 0) throw new Error(errors.join('\n'));
  const workflowFor = (stage) => stageWorkflows.overrides[stage]
    || (stage === ctx.task && isWorkflowFile(ctx.ownWorkflow) ? ctx.ownWorkflow : '')
    || stageWorkflows.workflows[stage];
  return { workflows: stageWorkflows.workflows, workflowFor, labels: statusLabels.labels, limit, sendBackLimit };
}

async function findMilestone(api, repo, title) {
  if (!title) return null;
  const milestones = await api.paginate(`/repos/${repo}/milestones?state=all`);
  return milestones.find((milestone) => milestone.title === title) ?? null;
}

async function setMilestoneDescription(api, repo, milestone, description) {
  if (!milestone || description === (milestone.description ?? '')) return;
  await api.request('PATCH', `/repos/${repo}/milestones/${milestone.number}`, { description });
  milestone.description = description;
}

async function openPullRequest(api, repo, branch) {
  if (!branch) return null;
  const owner = repo.split('/')[0];
  const pulls = await api.paginate(`/repos/${repo}/pulls?state=open&head=${encodeURIComponent(`${owner}:${branch}`)}`);
  return pulls[0] ?? null;
}

const CLOSING_ISSUES = `query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      closingIssuesReferences(first: 10) { nodes { milestone { title description } } }
    }
  }
}`;

// The requester of a pull request's flow: its milestone marker, then the markers of the milestones of the issues it closes.
export async function pullRequestContext(api, repo, prNumber) {
  const { data: pr } = await api.request('GET', `/repos/${repo}/pulls/${prNumber}`);
  const candidates = pr.milestone ? [pr.milestone] : [];
  if (!parseRequestedBy(pr.milestone?.description)) {
    const [owner, name] = repo.split('/');
    try {
      const data = await api.graphql(CLOSING_ISSUES, { owner, repo: name, number: Number(prNumber) });
      candidates.push(...data.repository.pullRequest.closingIssuesReferences.nodes.map((node) => node.milestone).filter(Boolean));
    } catch {
      // Without closing issues, the milestone of the pull request is all there is.
    }
  }
  const withRequester = candidates.find((milestone) => parseRequestedBy(milestone.description));
  return {
    pr,
    milestone: (withRequester ?? candidates[0])?.title ?? '',
    requestedBy: parseRequestedBy(withRequester?.description)
  };
}

export async function dispatchWorkflow(api, repo, workflow, ref, inputs, log) {
  const current = { ...inputs };
  let runDetails = true;
  let dropped = false;
  for (;;) {
    try {
      const { data } = await api.request('POST', `/repos/${repo}/actions/workflows/${workflow}/dispatches`, {
        ref,
        inputs: current,
        ...(runDetails ? { return_run_details: true } : {})
      });
      return { inputs: current, url: data?.html_url ?? '' };
    } catch (error) {
      // Servers without run details reject the key; the dispatch works without the run link.
      if (runDetails && error.status === 422 && /return_run_details/.test(error.message ?? '')) {
        runDetails = false;
        continue;
      }
      // Callers that predate an input reject it; send the rest instead of failing the flow.
      const unexpected = /Unexpected inputs provided: (\[[^\]]*\])/.exec(error.message ?? '');
      if (!dropped && error.status === 422 && unexpected) {
        dropped = true;
        let names = [];
        try {
          names = JSON.parse(unexpected[1]);
        } catch {
          throw error;
        }
        for (const name of names) delete current[name];
        log.warning(`${workflow} does not declare ${names.join(', ')}; dispatching without them.`);
        continue;
      }
      throw error;
    }
  }
}

function writeSummary(env, text) {
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${text}\n`);
}

export async function followUp(ctx, api, log) {
  const { repo } = ctx;
  if (!TASKS.includes(ctx.task)) throw new Error(`Unsupported task '${ctx.task}'. Use one of: ${TASKS.join(', ')}.`);
  const config = settings(ctx);
  const result = ctx.result || 'success';
  const summary = [];
  const { data: repository } = await api.request('GET', `/repos/${repo}`);
  const ref = repository.default_branch;

  const scopeIssue = number(ctx.issue)
    ? (await api.request('GET', `/repos/${repo}/issues/${ctx.issue}`)).data
    : null;
  const sourceKey = jiraKeyOf(ctx.source);
  const title = ctx.milestone || ctx['result-milestone'] || scopeIssue?.milestone?.title || milestoneFromKey(sourceKey, ctx['milestone-template']);
  const milestone = await findMilestone(api, repo, title);
  const milestoneTitle = milestone?.title ?? (ctx.milestone || ctx['result-milestone'] || '');
  const jiraKey = sourceKey || keyFromMilestone(milestoneTitle, ctx['milestone-template']);

  const given = humanLogin(ctx['requested-by']);
  const requestedBy = given || parseRequestedBy(milestone?.description);
  if (milestone && given && !ISSUE_TASKS.includes(ctx.task)) {
    await setMilestoneDescription(api, repo, milestone, upsertRequestedBy(milestone.description, given));
  }

  let rawIssues = [];
  if (scopeIssue) rawIssues = [scopeIssue];
  else if (milestone) {
    rawIssues = (await api.paginate(`/repos/${repo}/issues?milestone=${milestone.number}&state=open`))
      .filter((issue) => !issue.pull_request);
  }
  const issues = rawIssues
    .map((issue) => ({ number: issue.number, labels: (issue.labels ?? []).map((label) => (typeof label === 'string' ? label : label.name)) }))
    .map((issue) => ({ ...issue, states: issueStates(issue.labels, config.labels) }))
    .sort((a, b) => a.number - b.number);

  const pr = ctx.task === 'implement' ? await openPullRequest(api, repo, ctx.branch) : null;
  const escalationLabel = ctx['escalation-label'];
  const escalated = Boolean(escalationLabel) && ctx.task === 'implement'
    && [...(issues[0]?.labels ?? []), ...(pr?.labels ?? []).map((label) => label.name)].includes(escalationLabel);

  const decision = result === 'success'
    ? decideSuccess({ task: ctx.task, issues, pr, escalated })
    : decideFailure({ task: ctx.task, issues, pr });

  for (const issueNumber of decision.release) {
    const issue = issues.find((item) => item.number === issueNumber);
    if (!issue?.labels.includes(config.labels['in-progress'])) continue;
    try {
      await api.request('DELETE', `/repos/${repo}/issues/${issueNumber}/labels/${encodeURIComponent(config.labels['in-progress'])}`);
    } catch (error) {
      if (error.status !== 404) throw error;
    }
    await api.request('POST', `/repos/${repo}/issues/${issueNumber}/labels`, { labels: [config.labels.ready] });
    summary.push(`Moved #${issueNumber} from ${config.labels['in-progress']} back to ${config.labels.ready}.`);
  }

  let trackingNumber = null;
  async function trackingIssue() {
    if (trackingNumber) return trackingNumber;
    const name = `${milestoneTitle || ctx.source || 'AI delivery'} - ${ctx.task}`;
    const open = await api.paginate(`/repos/${repo}/issues?state=open${milestone ? `&milestone=${milestone.number}` : ''}`);
    const existing = open.find((issue) => !issue.pull_request && issue.title === name);
    if (existing) {
      trackingNumber = existing.number;
    } else {
      const { data } = await api.request('POST', `/repos/${repo}/issues`, {
        title: name,
        body: `Tracks the AI delivery flow of ${milestoneTitle ? `milestone \`${milestoneTitle}\`` : `\`${ctx.source}\``} while it needs a human.`,
        ...(milestone ? { milestone: milestone.number } : {})
      });
      trackingNumber = data.number;
      summary.push(`Created tracking issue #${trackingNumber}.`);
    }
    return trackingNumber;
  }

  async function handOff({ issue, stage, reason, resumeIssue, ...details }) {
    const target = issue ?? (await trackingIssue());
    const comments = await api.paginate(`/repos/${repo}/issues/${target}/comments`);
    if (hasOpenHandoff(comments, stage)) {
      summary.push(`#${target} already has an open ${stage} handoff.`);
      return;
    }
    const links = [];
    if (reason.startsWith('blocked:')) {
      const question = comments.filter((comment) => !parseResumeMarker(comment.body)).at(-1);
      if (question?.html_url) links.push(question.html_url);
      if (stage === 'business-refinement' && jiraKey && ctx['jira-base-url']) {
        links.push(`${ctx['jira-base-url'].replace(/\/$/, '')}/browse/${jiraKey}`);
      }
    }
    const blocker = blockerText(reason, {
      stage, task: ctx.task, issue: target, labels: config.labels, runUrl: ctx.runUrl, limit: config.limit, result, ...details
    });
    const body = buildHandoff({
      stage,
      milestone: milestoneTitle,
      issue: resumeIssue === undefined ? target : resumeIssue,
      pr: stage === 'pr-fix' ? pr?.number : '',
      requestedBy,
      branch: stage === 'implement' ? ctx.branch : '',
      base: stage === 'implement' ? ctx['base-branch'] : '',
      jira: stage === 'business-refinement' ? jiraKey : '',
      label: stage === 'pr-fix' ? escalationLabel : '',
      workflow: config.workflowFor(stage),
      blocker,
      links
    });
    await api.request('POST', `/repos/${repo}/issues/${target}/comments`, { body });
    summary.push(`Handed ${stage} off on #${target} (${reason}).`);
  }

  for (const item of decision.handoffs) {
    // Milestone-wide stages resume the whole milestone unless this run was scoped to one issue.
    const resumeIssue = item.reason === 'failed' && !scopeIssue ? '' : undefined;
    await handOff({ ...item, resumeIssue });
  }

  if (decision.dispatch) {
    const { stage } = decision.dispatch;
    const firstIssue = decision.dispatch.issues[0] ?? issues[0]?.number ?? null;
    const scoped = scopeIssue ? String(scopeIssue.number) : '';
    if (ctx.chain === 'false') {
      summary.push(`Chaining is off; ${stage} was not dispatched.`);
    } else if (!milestone) {
      summary.push(`No milestone found; ${stage} was not dispatched.`);
    } else {
      const counts = parseDispatchCounts(milestone.description);
      const count = counts[stage] ?? 0;
      const sendBack = isSendBack(ctx.task, stage);
      const sendBacks = counts[SEND_BACKS] ?? 0;
      if (sendBack && sendBacks >= config.sendBackLimit) {
        await handOff({ issue: firstIssue, stage, reason: 'send-back', resumeIssue: scoped, count: sendBacks, limit: config.sendBackLimit });
      } else if (count >= config.limit) {
        await handOff({ issue: firstIssue, stage, reason: 'loop', resumeIssue: scoped, count });
      } else {
        const workflow = config.workflows[stage];
        const inputs = dispatchInputs(stage, {
          milestone: milestone.title,
          issue: scoped,
          jira_key: jiraKey,
          requested_by: requestedBy
        });
        try {
          const dispatched = await dispatchWorkflow(api, repo, workflow, ref, inputs, log);
          counts[stage] = count + 1;
          if (sendBack) counts[SEND_BACKS] = sendBacks + 1;
          await setMilestoneDescription(api, repo, milestone, upsertDispatchCounts(milestone.description, counts));
          summary.push(`Dispatched ${workflow} (${stage}) with ${JSON.stringify(dispatched.inputs)}${dispatched.url ? `: ${dispatched.url}` : ''}.`);
        } catch (error) {
          log.warning(`Could not dispatch ${workflow}: ${error.message}`);
          await handOff({ issue: firstIssue, stage, reason: 'dispatch-failed', resumeIssue: scoped, error: error.message, failedStage: workflow });
        }
      }
    }
  }

  if (summary.length === 0) summary.push(`Nothing to do after ${ctx.task} (${result}).`);
  return summary;
}

export async function handoff(ctx, api) {
  const { repo } = ctx;
  if (!STAGES.includes(ctx.task)) throw new Error(`Unsupported stage '${ctx.task}'. Use one of: ${STAGES.join(', ')}.`);
  const config = settings(ctx);
  const target = number(ctx.pr) ?? number(ctx.issue);
  if (!target) throw new Error("The handoff command requires 'pr' or 'issue'.");
  const markers = lines(ctx.marker);
  for (const marker of markers) {
    if (!/^<!-- [A-Za-z0-9 =_.:/-]+ -->$/.test(marker)) throw new Error(`'marker' lines must be HTML comments, got '${marker}'.`);
  }
  let { milestone } = ctx;
  let requestedBy = humanLogin(ctx['requested-by']);
  if (number(ctx.pr)) {
    const context = await pullRequestContext(api, repo, ctx.pr);
    milestone ||= context.milestone;
    requestedBy ||= context.requestedBy;
  }
  const comments = await api.paginate(`/repos/${repo}/issues/${target}/comments`);
  if (hasOpenHandoff(comments, ctx.task)) return [`#${target} already has an open ${ctx.task} handoff.`];
  const body = buildHandoff({
    stage: ctx.task,
    milestone,
    issue: ctx.issue,
    pr: ctx.pr,
    requestedBy,
    branch: ctx.branch,
    base: ctx['base-branch'],
    label: ctx['escalation-label'],
    workflow: config.workflowFor(ctx.task),
    blocker: ctx.blocker || `The ${ctx.task} stage needs a human.`,
    links: ctx.runUrl ? [ctx.runUrl] : [],
    markers
  });
  await api.request('POST', `/repos/${repo}/issues/${target}/comments`, { body });
  return [`Handed ${ctx.task} off on #${target}${requestedBy ? ` to @${requestedBy}` : ''}.`];
}

const REQUIRED = {
  'business-refinement': [['milestone', 'jira']],
  'technical-refinement': [['milestone', 'issue']],
  'readiness-review': [['milestone', 'issue']],
  orchestrate: [['milestone']],
  implement: [['issue'], ['branch']],
  'pr-fix': [['pr']],
  'issue-intake': [],
  'issue-resolve': [['issue']]
};

// Decides from the issue_comment event alone whether it is an `/ai-resume` command written by a person.
export function parseResumeEvent(event) {
  const skip = (reason) => ({ skip: reason });
  const comment = event?.comment;
  if (event?.action !== 'created' || !comment) return skip('not a new comment');
  const command = parseResumeCommand(comment.body);
  if (!command) return skip('not an /ai-resume command');
  const sender = comment.user?.login ?? '';
  if (comment.user?.type === 'Bot' || !humanLogin(sender)) return skip(`written by ${sender || 'unknown'}, not a person`);
  const number = event.issue?.number;
  if (!number) return skip('no issue or pull request');
  return {
    ...command,
    sender,
    commentId: comment.id,
    number,
    isPullRequest: Boolean(event.issue.pull_request),
    milestone: event.issue.milestone?.title ?? '',
    defaultBranch: event.repository?.default_branch ?? ''
  };
}

export function checkFields(fields) {
  const errors = [];
  if (!STAGES.includes(fields.stage)) errors.push(`unknown stage '${fields.stage}'`);
  for (const name of ['issue', 'pr']) if (fields[name] && !number(fields[name])) errors.push(`invalid ${name} '${fields[name]}'`);
  for (const name of ['branch', 'base']) if (fields[name] && !isGitBranch(fields[name])) errors.push(`invalid ${name} '${fields[name]}'`);
  if (fields.workflow && !isWorkflowFile(fields.workflow)) errors.push(`invalid workflow '${fields.workflow}'`);
  if (fields.jira && !/^[A-Z][A-Z0-9_]*-[0-9]+$/.test(fields.jira)) errors.push(`invalid jira key '${fields.jira}'`);
  if (fields.label && !/^[^\r\n,]{1,50}$/.test(fields.label)) errors.push(`invalid label '${fields.label}'`);
  if (/[\r\n]/.test(fields.milestone ?? '')) errors.push('invalid milestone');
  for (const group of REQUIRED[fields.stage] ?? []) {
    if (!group.some((name) => fields[name])) errors.push(`${fields.stage} needs ${group.join(' or ')}`);
  }
  return errors;
}

// The handoff a command resumes: the newest open one (of the named stage), else, for a named stage, the newest one
// of that stage for its values. Only comments of the trusted bots count.
export function findHandoff(comments, botLogins, stage) {
  const trusted = new Set(botLogins.map((login) => login.toLowerCase()));
  const handoffs = comments
    .filter((comment) => trusted.has(comment.user?.login?.toLowerCase() ?? '') && parseResumeMarker(comment.body))
    .filter((comment) => !stage || parseResumeMarker(comment.body).stage === stage);
  const open = handoffs.filter((comment) => isOpenHandoff(comment.body)).at(-1);
  if (open) return { comment: open, open: true };
  const last = stage ? handoffs.at(-1) : null;
  return last ? { comment: last, open: false } : null;
}

const STAGE_LIST = STAGES.map((stage) => `\`${stage}\``).join(', ');

export async function resume(ctx, api, log, event) {
  const { repo } = ctx;
  const config = settings(ctx);
  const botLogins = [ctx['bot-login'], ...words(ctx['trusted-bots'])].filter(Boolean);
  const parsed = parseResumeEvent(event);
  if (parsed.skip) return [`Skipped: ${parsed.skip}.`];
  const { sender, commentId, stage: named, instructions } = parsed;
  const target = parsed.number;

  const react = async (content) => {
    try {
      await api.request('POST', `/repos/${repo}/issues/comments/${commentId}/reactions`, { content });
    } catch (error) {
      log.warning(`Could not react with ${content}: ${error.message}`);
    }
  };
  const reply = async (text) => {
    await api.request('POST', `/repos/${repo}/issues/${target}/comments`, { body: `@${sender} ${text}\n` });
  };
  const reject = async (text) => {
    await reply(text);
    return [`Rejected: ${text}`];
  };

  await react('eyes');
  if (parsed.unknownStage) return reject(`\`${parsed.unknownStage}\` is not a stage. Use one of ${STAGE_LIST}.`);
  const { data: permission } = await api.request('GET', `/repos/${repo}/collaborators/${encodeURIComponent(sender)}/permission`);
  const role = permission?.role_name ?? permission?.permission ?? 'none';
  if (!['admin', 'maintain', 'write'].includes(role) && !['admin', 'write'].includes(permission?.permission)) {
    return reject(`resuming needs write, maintain, or admin permission; you have ${role}.`);
  }

  const comments = await api.paginate(`/repos/${repo}/issues/${target}/comments`);
  const found = findHandoff(comments, botLogins, named);
  if (!found && !named) {
    return reject(`there is no open handoff to resume here. Name the stage to run it anyway: \`/ai-resume <stage>\` with one of ${STAGE_LIST}.`);
  }
  const fields = found
    ? parseResumeMarker(found.comment.body)
    : {
      stage: named,
      milestone: parsed.milestone,
      issue: parsed.isPullRequest ? '' : String(target),
      pr: parsed.isPullRequest ? String(target) : '',
      'requested-by': '',
      branch: '',
      base: '',
      jira: '',
      label: named === 'pr-fix' ? ctx['escalation-label'] : '',
      workflow: ''
    };
  if (fields['requested-by'] && !humanLogin(fields['requested-by'])) fields['requested-by'] = '';
  const errors = checkFields(fields);
  if (errors.length > 0) return reject(`cannot resume ${fields.stage || 'this stage'}: ${errors.join('; ')}.`);

  // Mark the handoff resumed before dispatching, so a second command finds it closed.
  const handoff = found?.open ? found.comment : null;
  const originalBody = handoff?.body ?? '';
  if (handoff) {
    await api.request('PATCH', `/repos/${repo}/issues/comments/${handoff.id}`, {
      body: setHandoffState(originalBody, 'resumed', `Resumed by @${sender}.`)
    });
  }

  const summary = [];
  if (fields.stage === 'pr-fix' && fields.label && fields.pr) {
    try {
      await api.request('DELETE', `/repos/${repo}/issues/${fields.pr}/labels/${encodeURIComponent(fields.label)}`);
      summary.push(`Removed ${fields.label} from #${fields.pr}.`);
    } catch (error) {
      if (error.status !== 404) throw error;
    }
  }
  if (fields.milestone) {
    const milestone = await findMilestone(api, repo, fields.milestone);
    if (milestone && Object.keys(parseDispatchCounts(milestone.description)).length > 0) {
      await setMilestoneDescription(api, repo, milestone, upsertDispatchCounts(milestone.description, {}));
      summary.push(`Reset the automatic dispatch counters of ${milestone.title}.`);
    }
  }

  const ref = parsed.defaultBranch || (await api.request('GET', `/repos/${repo}`)).data.default_branch;
  const workflow = fields.workflow || config.workflows[fields.stage];
  const inputs = dispatchInputs(fields.stage, resumeValues(fields, fields['requested-by'] || sender, instructions));
  try {
    const dispatched = await dispatchWorkflow(api, repo, workflow, ref, inputs, log);
    const link = dispatched.url || `${ctx.serverUrl}/${repo}/actions/workflows/${workflow}`;
    if (handoff) {
      await api.request('PATCH', `/repos/${repo}/issues/comments/${handoff.id}`, {
        body: setHandoffState(originalBody, 'resumed', `Resumed by @${sender} -> ${link}`)
      });
    }
    await react('rocket');
    await reply(`resumed **${fields.stage}** -> ${link}${NEXT_STEP[fields.stage] ? ` (then ${NEXT_STEP[fields.stage]})` : ''}.`);
    summary.push(`Dispatched ${workflow} (${fields.stage}) with ${JSON.stringify(dispatched.inputs)} for @${sender}.`);
    return summary;
  } catch (error) {
    if (handoff) {
      await api.request('PATCH', `/repos/${repo}/issues/comments/${handoff.id}`, { body: originalBody });
    }
    await reply(`could not dispatch ${workflow} (${error.status ?? 'error'}); the handoff is still open. Reply \`/ai-resume\` again to retry.`);
    throw error;
  }
}

export async function requestReview(ctx, api) {
  const { repo } = ctx;
  if (!number(ctx.pr)) throw new Error("The request-review command requires 'pr'.");
  const { pr, requestedBy } = await pullRequestContext(api, repo, ctx.pr);
  const login = humanLogin(ctx['requested-by']) || requestedBy;
  if (!login) return [`No requester found for PR #${ctx.pr}; nobody was asked to review.`];
  const comments = await api.paginate(`/repos/${repo}/issues/${ctx.pr}/comments`);
  if (comments.some((comment) => comment.user?.type === 'Bot' && comment.body?.includes('<!-- merge-decision review-requested'))) {
    return [`@${login} was already asked to review PR #${ctx.pr}.`];
  }
  const summary = [];
  if (pr.user?.login?.toLowerCase() !== login.toLowerCase()) {
    try {
      await api.request('POST', `/repos/${repo}/pulls/${ctx.pr}/requested_reviewers`, { reviewers: [login] });
      summary.push(`Requested a review from @${login}.`);
    } catch (error) {
      summary.push(`Could not request a review from @${login}: ${error.message}`);
    }
  }
  const required = number(ctx['required-approvals']) ?? 1;
  const body = [
    `<!-- merge-decision review-requested=${login} -->`,
    `@${login} this pull request into \`${pr.base.ref}\` needs ${required} human approval${required === 1 ? '' : 's'} on its latest commit before the merge decision can run. Approve it to continue: the approval dispatches the merge decision again.`
  ].join('\n');
  await api.request('POST', `/repos/${repo}/issues/${ctx.pr}/comments`, { body: `${body}\n` });
  summary.push(`Mentioned @${login} on PR #${ctx.pr}.`);
  return summary;
}

export const log = {
  info: (message) => console.log(message),
  notice: (message) => console.log(`::notice::${message}`),
  warning: (message) => console.log(`::warning::${message.replace(/\r?\n/g, ' ')}`)
};

export async function main(env = process.env, api = null) {
  const ctx = readContext(env);
  const client = api ?? createClient({ token: env.GITHUB_TOKEN ?? '', apiUrl: env.GITHUB_API_URL || undefined, graphqlUrl: env.GITHUB_GRAPHQL_URL || '' });
  let summary;
  if (ctx.command === 'follow-up') summary = await followUp(ctx, client, log);
  else if (ctx.command === 'handoff') summary = await handoff(ctx, client, log);
  else if (ctx.command === 'request-review') summary = await requestReview(ctx, client, log);
  else if (ctx.command === 'resume') {
    const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8'));
    summary = await resume(ctx, client, log, event);
  } else {
    throw new Error(`Unsupported command '${ctx.command}'. Use follow-up, handoff, resume, or request-review.`);
  }
  for (const line of summary) log.info(line);
  writeSummary(env, summary.join('\n\n'));
  return summary;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.log(`::error::${String(error.message).replace(/\r?\n/g, '%0A')}`);
    process.exitCode = 1;
  });
}
