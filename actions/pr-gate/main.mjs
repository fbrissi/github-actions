#!/usr/bin/env node
// Deterministic gates and markers of the PR follow-up: whether pr-fix may run a pass or must escalate, whether a merge
// decision may run, and the bot comments that record each pass and decision. Every GitHub call goes through the
// injected client so the commands are testable.
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createClient } from '../ai-delivery/github.mjs';

const NAMES = [
  'command', 'pr-number', 'opt-in-label', 'branch-prefixes', 'max-rounds', 'escalation-label', 'check-name',
  'required-human-approvals', 'human-approval-exempt-base-prefixes', 'hold-labels', 'round', 'start-sha', 'outcome',
  'head-sha', 'result', 'check-run-id'
];

export const envName = (name) => `PR_GATE_${name.toUpperCase().replaceAll('-', '_')}`;
const words = (value = '') => value.split(/\s+/).filter(Boolean);
const FIX_MARKER = /<!-- pr-fix round=(\d+) head=([0-9a-f]{40}) -->/;
const FIX_ESCALATED = '<!-- pr-fix escalated -->';
const SHA = /^[0-9a-f]{40}$/;

export function readContext(env = process.env) {
  const ctx = Object.fromEntries(NAMES.map((name) => [name, (env[envName(name)] ?? '').trim()]));
  ctx.repo = env.GITHUB_REPOSITORY ?? '';
  ctx.runUrl = env.GITHUB_RUN_ID ? `${env.GITHUB_SERVER_URL || 'https://github.com'}/${ctx.repo}/actions/runs/${env.GITHUB_RUN_ID}` : '';
  return ctx;
}

function prNumber(ctx) {
  const value = ctx['pr-number'].replace(/^#/, '');
  if (!/^[1-9][0-9]*$/.test(value)) throw new Error(`Invalid pull request number: ${ctx['pr-number']}`);
  return Number(value);
}

// Paginates list endpoints that wrap their items in an object, such as check runs and workflow runs.
async function paginateKey(api, path, key) {
  let url = `${path}${path.includes('?') ? '&' : '?'}per_page=100`;
  const items = [];
  while (url) {
    const { data, headers } = await api.request('GET', url);
    items.push(...(data?.[key] ?? []));
    const next = /<([^>]+)>;\s*rel="next"/.exec(headers?.get?.('link') ?? '');
    url = next ? next[1] : '';
  }
  return items;
}

const skip = (reason) => ({ outputs: { action: 'skip' }, summary: [`skipped: ${reason}`], notice: reason });

export async function fixGate(ctx, api) {
  const { repo, runUrl } = ctx;
  const number = prNumber(ctx);
  const maxRounds = Number(ctx['max-rounds'] || 3);
  const { data: pr } = await api.request('GET', `/repos/${repo}/pulls/${number}`);
  const labels = pr.labels.map((label) => label.name);
  const prefixes = words(ctx['branch-prefixes']);
  const optInLabel = ctx['opt-in-label'];
  const escalationLabel = ctx['escalation-label'];

  if (pr.state !== 'open') return skip(`PR #${number} is not open.`);
  if (pr.draft) return skip(`PR #${number} is a draft.`);
  if (pr.head.repo?.full_name !== repo) return skip(`PR #${number} comes from a fork.`);
  const qualifies = (optInLabel && labels.includes(optInLabel)) || prefixes.some((prefix) => pr.head.ref.startsWith(prefix));
  if (!qualifies) return skip(`PR #${number} has no ${optInLabel || 'opt-in'} label or matching branch prefix.`);
  if (escalationLabel && labels.includes(escalationLabel)) return skip(`PR #${number} has the ${escalationLabel} label.`);

  const comments = await api.paginate(`/repos/${repo}/issues/${number}/comments`);
  // Markers only count when a bot posted them, so a person cannot fake or reset rounds.
  const botComments = comments.filter((comment) => comment.user?.type === 'Bot');
  const lastEscalation = botComments.filter((comment) => comment.body?.includes(FIX_ESCALATED)).at(-1);
  const markers = botComments.filter((comment) => FIX_MARKER.test(comment.body ?? '')
    && (!lastEscalation || new Date(comment.created_at) > new Date(lastEscalation.created_at)));
  const rounds = markers.length;
  if (lastEscalation && !escalationLabel) return skip(`PR #${number} was already escalated to a human.`);

  const sameHead = markers.filter((comment) => comment.body.match(FIX_MARKER)[2] === pr.head.sha).at(-1);
  if (sameHead) {
    const since = new Date(sameHead.created_at);
    const fixer = sameHead.user.login;
    const reviews = await api.paginate(`/repos/${repo}/pulls/${number}/reviews`);
    const reviewComments = await api.paginate(`/repos/${repo}/pulls/${number}/comments`);
    const feedback = [
      ...reviews.map((item) => ({ login: item.user?.login, at: item.submitted_at })),
      ...reviewComments.map((item) => ({ login: item.user?.login, at: item.created_at })),
      ...comments.map((item) => ({ login: item.user?.login, at: item.created_at }))
    ].filter((item) => item.login && item.login !== fixer && item.at && new Date(item.at) > since);
    if (feedback.length === 0) return skip(`no new feedback since fix round ${sameHead.body.match(FIX_MARKER)[1]} on ${pr.head.sha}.`);
  }

  const outputs = {
    action: 'skip',
    pr_number: String(pr.number),
    head_ref: pr.head.ref,
    base_sha: pr.base.sha,
    round: String(rounds + 1)
  };
  if (rounds >= maxRounds) {
    return { outputs: { ...outputs, action: 'escalate' }, summary: [`PR #${number} reached ${maxRounds} fix rounds; escalating.`], notice: `PR #${number} reached ${maxRounds} fix rounds; escalating.` };
  }

  const checkName = ctx['check-name'] || 'PR Fix';
  const { data: checkRun } = await api.request('POST', `/repos/${repo}/check-runs`, {
    name: checkName,
    head_sha: pr.head.sha,
    status: 'in_progress',
    started_at: new Date().toISOString(),
    ...(runUrl ? { details_url: runUrl } : {}),
    output: { title: `${checkName} in progress`, summary: `Fix round ${rounds + 1} of ${maxRounds} for PR #${number}.` }
  });
  return { outputs: { ...outputs, action: 'fix', check_run_id: String(checkRun.id) }, summary: [`Fix round ${rounds + 1} of ${maxRounds} for PR #${number}.`] };
}

export async function fixRecord(ctx, api) {
  const number = prNumber(ctx);
  const startSha = ctx['start-sha'];
  if (!SHA.test(startSha)) throw new Error(`'start-sha' must be a full commit SHA, got '${startSha}'.`);
  const round = ctx.round || '1';
  const body = `<!-- pr-fix round=${round} head=${startSha} -->\nAutomatic fix round ${round} of ${ctx['max-rounds'] || 3} on ${startSha}: ${ctx.outcome || 'unknown'}.`;
  await api.request('POST', `/repos/${ctx.repo}/issues/${number}/comments`, { body });
  return { outputs: {}, summary: [`Recorded fix round ${round} on PR #${number}.`] };
}

export async function fixFinish(ctx, api) {
  const id = ctx['check-run-id'];
  if (!/^[1-9][0-9]*$/.test(id)) return { outputs: {}, summary: ['No check run to finish.'] };
  const checkName = ctx['check-name'] || 'PR Fix';
  const conclusion = ctx.result === 'success' ? 'success' : 'failure';
  await api.request('PATCH', `/repos/${ctx.repo}/check-runs/${id}`, {
    status: 'completed',
    conclusion,
    completed_at: new Date().toISOString(),
    output: {
      title: conclusion === 'success' ? `${checkName} completed` : `${checkName} failed`,
      summary: conclusion === 'success'
        ? 'The AI harness completed one fix pass.'
        : 'The AI harness failed before completing the fix pass.'
    }
  });
  return { outputs: {}, summary: [`${checkName} ${conclusion}.`] };
}

const REVIEW_THREADS = `query($owner: String!, $repo: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $cursor) {
        nodes { isResolved }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
}`;

// Runs started by review or check events (such as the feedback dispatcher) are not CI; their checks are ignored.
const DISPATCHER_EVENTS = new Set(['pull_request_review', 'pull_request_review_comment', 'check_run', 'workflow_run']);

export async function mergeGate(ctx, api, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))) {
  const { repo } = ctx;
  const number = prNumber(ctx);
  let pr;
  for (let attempt = 1; attempt <= 5; attempt++) {
    ({ data: pr } = await api.request('GET', `/repos/${repo}/pulls/${number}`));
    if (pr.state !== 'open' || pr.mergeable !== null) break;
    if (attempt < 5) await sleep(3000);
  }
  const headSha = pr.head.sha;
  if (pr.state !== 'open') return skip(`PR #${number} is not open.`);
  if (pr.draft) return skip(`PR #${number} is a draft.`);
  const prefixes = words(ctx['branch-prefixes']);
  if (prefixes.length > 0 && !prefixes.some((prefix) => pr.head.ref.startsWith(prefix))) {
    return skip(`PR #${number} head branch ${pr.head.ref} matches no branch-prefixes.`);
  }
  const holdLabels = words(ctx['hold-labels']);
  const heldBy = pr.labels.map((label) => label.name).filter((name) => holdLabels.includes(name));
  if (heldBy.length > 0) return skip(`PR #${number} has the ${heldBy.join(', ')} label.`);
  if (pr.mergeable === null) return skip(`GitHub has not computed whether PR #${number} is mergeable.`);
  if (pr.mergeable === false || pr.mergeable_state === 'dirty') return skip(`PR #${number} has merge conflicts.`);

  const runs = await paginateKey(api, `/repos/${repo}/actions/runs?head_sha=${headSha}`, 'workflow_runs');
  const ignoredSuites = new Set(runs.filter((run) => DISPATCHER_EVENTS.has(run.event)).map((run) => run.check_suite_id));
  const checkRuns = (await paginateKey(api, `/repos/${repo}/commits/${headSha}/check-runs?filter=latest`, 'check_runs'))
    .filter((check) => !ignoredSuites.has(check.check_suite?.id));
  const pending = checkRuns.filter((check) => check.status !== 'completed').map((check) => check.name);
  if (pending.length > 0) return skip(`checks still running on ${headSha}: ${pending.join(', ')}.`);
  const failed = checkRuns
    .filter((check) => !['success', 'neutral', 'skipped'].includes(check.conclusion))
    .map((check) => `${check.name} (${check.conclusion})`);
  if (failed.length > 0) return skip(`checks not successful on ${headSha}: ${failed.join(', ')}.`);
  const { data: status } = await api.request('GET', `/repos/${repo}/commits/${headSha}/status`);
  if (status.total_count > 0 && status.state !== 'success') return skip(`commit statuses are ${status.state} on ${headSha}.`);

  const reviews = await api.paginate(`/repos/${repo}/pulls/${number}/reviews`);
  const latest = new Map();
  for (const review of reviews) {
    if (!review.user || !['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(review.state)) continue;
    latest.set(review.user.login, review);
  }
  const changesRequested = [...latest.values()].filter((review) => review.state === 'CHANGES_REQUESTED').map((review) => review.user.login);
  if (changesRequested.length > 0) return skip(`changes requested by ${changesRequested.join(', ')}.`);
  const approvals = [...latest.values()].filter((review) => review.state === 'APPROVED'
    && review.commit_id === headSha
    && review.user.type === 'User'
    && !review.user.login.endsWith('[bot]')).length;
  const exemptPrefixes = words(ctx['human-approval-exempt-base-prefixes']);
  const required = exemptPrefixes.some((prefix) => pr.base.ref.startsWith(prefix)) ? 0 : Number(ctx['required-human-approvals'] || 1);
  const outputs = { action: 'skip', pr_number: String(pr.number), required_approvals: String(required) };
  if (approvals < required) {
    const reason = `${approvals} of ${required} human approvals on ${headSha}.`;
    return { outputs: { ...outputs, request_review: 'true' }, summary: [`skipped: ${reason}`], notice: reason };
  }

  const [owner, name] = repo.split('/');
  let unresolved = 0;
  let cursor = null;
  do {
    const result = await api.graphql(REVIEW_THREADS, { owner, repo: name, number, cursor });
    const threads = result.repository.pullRequest.reviewThreads;
    unresolved += threads.nodes.filter((thread) => !thread.isResolved).length;
    cursor = threads.pageInfo.hasNextPage ? threads.pageInfo.endCursor : null;
  } while (cursor);
  if (unresolved > 0) return { ...skip(`${unresolved} unresolved review thread(s).`), outputs };

  const comments = await api.paginate(`/repos/${repo}/issues/${number}/comments`);
  const marker = `<!-- merge-decision head=${headSha} -->`;
  if (comments.some((comment) => comment.user?.type === 'Bot' && comment.body?.includes(marker))) {
    return { ...skip(`a merge decision was already made for ${headSha}.`), outputs };
  }

  return {
    outputs: { ...outputs, action: 'decide', head_sha: headSha, base_ref: pr.base.ref, base_sha: pr.base.sha },
    summary: [`Merge gates passed for PR #${number} on ${headSha}.`]
  };
}

export async function mergeRecord(ctx, api) {
  const number = prNumber(ctx);
  const headSha = ctx['head-sha'];
  if (!SHA.test(headSha)) throw new Error(`'head-sha' must be a full commit SHA, got '${headSha}'.`);
  const body = `<!-- merge-decision head=${headSha} -->\nMerge decision recorded for ${headSha}; a new commit triggers a new decision.`;
  await api.request('POST', `/repos/${ctx.repo}/issues/${number}/comments`, { body });
  return { outputs: {}, summary: [`Recorded the merge decision on PR #${number}.`] };
}

const COMMANDS = { 'fix-gate': fixGate, 'fix-record': fixRecord, 'fix-finish': fixFinish, 'merge-gate': mergeGate, 'merge-record': mergeRecord };

export async function main(env = process.env, api = null) {
  const ctx = readContext(env);
  const command = COMMANDS[ctx.command];
  if (!command) throw new Error(`Unsupported command '${ctx.command}'. Use ${Object.keys(COMMANDS).join(', ')}.`);
  const client = api ?? createClient({ token: env.GITHUB_TOKEN ?? '', apiUrl: env.GITHUB_API_URL || undefined, graphqlUrl: env.GITHUB_GRAPHQL_URL || '' });
  const result = await command(ctx, client);
  if (result.notice) console.log(`::notice::${result.notice.replace(/\r?\n/g, ' ')}`);
  for (const line of result.summary) console.log(line);
  if (env.GITHUB_OUTPUT) {
    appendFileSync(env.GITHUB_OUTPUT, Object.entries(result.outputs).map(([key, value]) => `${key}=${value}\n`).join(''));
  }
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${result.summary.join('\n\n')}\n`);
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.log(`::error::${String(error.message).replace(/\r?\n/g, '%0A')}`);
    process.exitCode = 1;
  });
}
