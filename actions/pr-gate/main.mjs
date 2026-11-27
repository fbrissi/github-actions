#!/usr/bin/env node
// Deterministic gates and markers of the PR follow-up: whether pr-fix may run a pass or must escalate, whether a merge
// decision may run, the bot comments that record each pass and decision, and the merge decision dispatch after a pass. Every GitHub call goes through the
// injected client so the commands are testable.
import { appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createClient } from '../ai-delivery/github.mjs';

const NAMES = [
  'command', 'fix-branch-prefixes', 'pr-number', 'opt-in-label', 'branch-prefixes', 'max-rounds', 'escalation-label', 'check-name',
  'required-human-approvals', 'human-approval-exempt-base-prefixes', 'human-approval-exempt-authors', 'approval-labels', 'hold-labels', 'round', 'start-sha', 'outcome',
  'head-sha', 'result', 'check-run-id', 'merge-workflow', 'fix-workflow', 'ignore-authors', 'ignore-reply-authors',
  'merge-check-name', 'output-file'
];

export const envName = (name) => `PR_GATE_${name.toUpperCase().replaceAll('-', '_')}`;
const words = (value = '') => value.split(/\s+/).filter(Boolean);
const FIX_MARKER = /<!-- pr-fix round=(\d+) head=([0-9a-f]{40}) -->/;
const FIX_ESCALATED = '<!-- pr-fix escalated -->';
const SHA = /^[0-9a-f]{40}$/;
const REDECIDE_MARKER = '<!-- merge-decision redecide -->';
const WORKFLOW_FILE = /^[A-Za-z0-9_.-]+\.ya?ml$/;

export function readContext(env = process.env) {
  const ctx = Object.fromEntries(NAMES.map((name) => [name, (env[envName(name)] ?? '').trim()]));
  ctx.repo = env.GITHUB_REPOSITORY ?? '';
  ctx.eventName = env.GITHUB_EVENT_NAME ?? '';
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

// Whether pr-fix may run on the pull request at all, and its fix rounds since the last escalation. Shared by fix-gate
// and by merge-gate, which only waits for a queued fix pass the pull request could actually get.
function fixStanding(ctx, pr, comments, prefixes) {
  const number = pr.number;
  const labels = pr.labels.map((label) => label.name);
  const optInLabel = ctx['opt-in-label'];
  const escalationLabel = ctx['escalation-label'];
  if (pr.state !== 'open') return { reason: `PR #${number} is not open.` };
  if (pr.draft) return { reason: `PR #${number} is a draft.` };
  if (pr.head.repo?.full_name !== ctx.repo) return { reason: `PR #${number} comes from a fork.` };
  const qualifies = (optInLabel && labels.includes(optInLabel)) || prefixes.some((prefix) => pr.head.ref.startsWith(prefix));
  if (!qualifies) return { reason: `PR #${number} has no ${optInLabel || 'opt-in'} label or matching branch prefix.` };
  if (escalationLabel && labels.includes(escalationLabel)) return { reason: `PR #${number} has the ${escalationLabel} label.` };
  // Markers only count when a bot posted them, so a person cannot fake or reset rounds.
  const botComments = comments.filter((comment) => comment.user?.type === 'Bot');
  const lastEscalation = botComments.filter((comment) => comment.body?.includes(FIX_ESCALATED)).at(-1);
  const markers = botComments.filter((comment) => FIX_MARKER.test(comment.body ?? '')
    && (!lastEscalation || new Date(comment.created_at) > new Date(lastEscalation.created_at)));
  if (lastEscalation && !escalationLabel) return { reason: `PR #${number} was already escalated to a human.` };
  return { markers, rounds: markers.length };
}

export async function fixGate(ctx, api) {
  const { repo, runUrl } = ctx;
  const number = prNumber(ctx);
  const maxRounds = Number(ctx['max-rounds'] || 3);
  const { data: pr } = await api.request('GET', `/repos/${repo}/pulls/${number}`);
  const comments = await api.paginate(`/repos/${repo}/issues/${number}/comments`);
  const standing = fixStanding(ctx, pr, comments, words(ctx['branch-prefixes']));
  if (standing.reason) return skip(standing.reason);
  const { markers, rounds } = standing;

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

// After a successful fix pass, starts the merge decision again: a decision skipped while the pass was running is never
// retried otherwise. Bounded by the fix rounds, since a merge decision never dispatches a fix.
export async function mergeDispatch(ctx, api) {
  const { repo } = ctx;
  const number = prNumber(ctx);
  const workflow = ctx['merge-workflow'];
  if (!workflow) return { outputs: {}, summary: ['No merge workflow to dispatch.'] };
  if (!WORKFLOW_FILE.test(workflow)) throw new Error(`'merge-workflow' must be a workflow file name, got '${workflow}'.`);
  const { data: repository } = await api.request('GET', `/repos/${repo}`);
  try {
    await api.request('POST', `/repos/${repo}/actions/workflows/${workflow}/dispatches`, {
      ref: repository.default_branch,
      inputs: { pr_number: String(number) }
    });
  } catch (error) {
    if (error.status !== 404) throw error;
    const reason = `${workflow} is not on ${repository.default_branch}; PR #${number} was not dispatched.`;
    return { outputs: {}, summary: [reason], notice: reason };
  }
  return { outputs: {}, summary: [`Dispatched ${workflow} for PR #${number}.`] };
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

async function unresolvedThreads(api, repo, number) {
  const [owner, name] = repo.split('/');
  let unresolved = 0;
  let cursor = null;
  do {
    const result = await api.graphql(REVIEW_THREADS, { owner, repo: name, number, cursor });
    const threads = result.repository.pullRequest.reviewThreads;
    unresolved += threads.nodes.filter((thread) => !thread.isResolved).length;
    cursor = threads.pageInfo.hasNextPage ? threads.pageInfo.endCursor : null;
  } while (cursor);
  return unresolved;
}

// `filter=latest` is per check suite, and each workflow run has its own suite, so a cancelled run that a newer run of
// the same workflow superseded is still listed. Check runs are grouped by App, workflow file (from the run that owns
// the suite), and name, and only the newest of each group counts (latest start, then highest id). Same-named jobs of
// different workflows stay separate; a suite with no known workflow run is its own group.
export function newestPerWorkflow(checkRuns, runs = []) {
  const pathBySuite = new Map(runs.filter((run) => run.path).map((run) => [run.check_suite_id, run.path]));
  const group = (check) => {
    const suite = check.check_suite?.id;
    const source = pathBySuite.get(suite) ?? `suite:${suite ?? check.id}`;
    return JSON.stringify([check.app?.id ?? null, source, check.name]);
  };
  const order = (check) => [Date.parse(check.started_at ?? '') || 0, Number(check.id) || 0];
  const newest = new Map();
  for (const check of checkRuns) {
    const key = group(check);
    const current = newest.get(key);
    const [at, id] = order(check);
    const [currentAt, currentId] = current ? order(current) : [-1, -1];
    if (!current || at > currentAt || (at === currentAt && id > currentId)) newest.set(key, check);
  }
  return [...newest.values()];
}

// A fix pass that has not started yet (queued, waiting for the concurrency group or an environment) will answer the
// open threads, and its follow-up dispatches the decision again. A running pass shows as the running PR Fix check.
// Dispatched runs do not say which pull request they are for, so a queued run only counts when this pull request has
// review feedback newer than its last fix round (by anyone but that round's fixer), which a queued pass would answer.
const WAITING_RUN = new Set(['queued', 'pending', 'requested', 'waiting']);

async function fixQueued(ctx, api, pr, reviews, comments) {
  const { repo } = ctx;
  const workflow = ctx['fix-workflow'];
  if (!workflow) return false;
  if (!WORKFLOW_FILE.test(workflow)) throw new Error(`'fix-workflow' must be a workflow file name, got '${workflow}'.`);
  // Only a pull request that fix-gate would let run (opted in, not escalated, rounds left) can be what a run waits for.
  const standing = fixStanding(ctx, pr, comments, words(ctx['fix-branch-prefixes']));
  if (standing.reason || standing.rounds >= Number(ctx['max-rounds'] || 3)) return false;
  const lastRound = standing.markers.at(-1);
  const since = lastRound ? new Date(lastRound.created_at) : null;
  const fixer = lastRound?.user?.login;
  const ignored = new Set(words(ctx['ignore-authors']).map((login) => login.toLowerCase()));
  const reviewComments = await api.paginate(`/repos/${repo}/pulls/${pr.number}/comments`);
  const unanswered = [
    ...reviews.map((item) => ({ login: item.user?.login, at: item.submitted_at })),
    ...reviewComments.map((item) => ({ login: item.user?.login, at: item.created_at }))
  ].some((item) => item.login && item.login !== fixer && !ignored.has(item.login.toLowerCase())
    && item.at && (!since || new Date(item.at) > since));
  if (!unanswered) return false;
  try {
    const { data } = await api.request('GET', `/repos/${repo}/actions/workflows/${workflow}/runs?per_page=50`);
    return (data?.workflow_runs ?? []).some((run) => WAITING_RUN.has(run.status));
  } catch (error) {
    if (error.status === 404) return false;
    throw error;
  }
}

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
  const checkRuns = newestPerWorkflow((await paginateKey(api, `/repos/${repo}/commits/${headSha}/check-runs?filter=latest`, 'check_runs'))
    .filter((check) => !ignoredSuites.has(check.check_suite?.id)), runs);
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
  // The exemption needs both: a matching base and an exempt author (by default any GitHub App bot, never a person).
  const exemptPrefixes = words(ctx['human-approval-exempt-base-prefixes']);
  const exemptAuthors = words(ctx['human-approval-exempt-authors']).map((login) => login.toLowerCase());
  const author = pr.user?.login ?? '';
  const exemptBase = exemptPrefixes.some((prefix) => pr.base.ref.startsWith(prefix));
  const exemptAuthor = exemptAuthors.length > 0
    ? exemptAuthors.includes(author.toLowerCase())
    : pr.user?.type === 'Bot' && /\[bot\]$/i.test(author);
  // An approval label (for example legal text that needs a person's sign-off) cancels the exemption, so only a human
  // approval of the head commit lets the decision run, while the fix passes keep working on the pull request.
  const approvalLabels = words(ctx['approval-labels']);
  const approvalLabel = pr.labels.map((label) => label.name).find((name) => approvalLabels.includes(name));
  const configured = Number(ctx['required-human-approvals'] || 1);
  const required = approvalLabel ? Math.max(1, configured) : exemptBase && exemptAuthor ? 0 : configured;
  const outputs = { action: 'skip', pr_number: String(pr.number), required_approvals: String(required) };
  if (approvals < required) {
    const reason = `${approvals} of ${required} human approvals on ${headSha}${approvalLabel ? ` (the ${approvalLabel} label needs one)` : ''}.`;
    return { outputs: { ...outputs, request_review: 'true' }, summary: [`skipped: ${reason}`], notice: reason };
  }

  const unresolved = await unresolvedThreads(api, repo, number);
  const comments = await api.paginate(`/repos/${repo}/issues/${number}/comments`);
  if (unresolved > 0) {
    if (await fixQueued(ctx, api, pr, reviews, comments)) {
      return { ...skip(`${unresolved} unresolved review thread(s); a ${ctx['fix-workflow']} run is queued.`), outputs };
    }
    // Nothing else will resolve them, so a person is told instead of the pull request waiting silently.
    const reason = `${unresolved} unresolved review thread(s).`;
    return { outputs: { ...outputs, handoff: 'true' }, summary: [`skipped: ${reason}`], notice: reason };
  }

  const marker = `<!-- merge-decision head=${headSha} -->`;
  const decided = comments.filter((comment) => comment.user?.type === 'Bot' && comment.body?.includes(marker)).at(-1);
  // `/ai-resume merge-decision` leaves a redecide marker: one new decision on the current head, since the next decision
  // record is newer than it.
  const redecide = decided && comments.some((comment) => comment.user?.type === 'Bot'
    && comment.body?.includes(REDECIDE_MARKER)
    && new Date(comment.created_at) > new Date(decided.created_at));
  if (decided && !redecide) {
    return { ...skip(`a merge decision was already made for ${headSha}.`), outputs };
  }

  return {
    outputs: { ...outputs, action: 'decide', head_sha: headSha, base_ref: pr.base.ref, base_sha: pr.base.sha },
    summary: [`Merge gates passed for PR #${number} on ${headSha}.`]
  };
}

// The merge-risk skill ends its output with `merge-risk-result: merged | held | not-evaluated`. Older skills only print
// `PR #<n>: MERGE | HOLD`. Anything else, or a failed harness without a result, could not be evaluated.
export function parseMergeOutcome(text = '', harnessOutcome = 'success') {
  const results = [...text.matchAll(/^[\s>*`_]*merge-risk-result:[\s*`_]*(merged|held|not-evaluated)\b/gim)];
  if (results.length > 0) return results.at(-1)[1].toLowerCase();
  if (harnessOutcome !== 'success') return 'not-evaluated';
  const verdicts = [...text.matchAll(/PR #\d+:[\s*`_]*(MERGE|HOLD|NOT EVALUATED)\b/g)];
  const verdict = verdicts.at(-1)?.[1];
  if (verdict === 'MERGE') return 'merged';
  if (verdict === 'HOLD') return 'held';
  return 'not-evaluated';
}

export async function mergeOutcome(ctx) {
  const file = ctx['output-file'] || `${process.env.RUNNER_TEMP ?? ''}/ai-harness-output`;
  let text = '';
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    // No output: the harness did not run far enough to decide.
  }
  const result = parseMergeOutcome(text, ctx.outcome || 'success');
  const summary = [`Merge decision result: ${result}.`];
  if (result === 'not-evaluated') {
    const reason = 'the merge decision could not be evaluated; it is handed to a person and the head is not marked as decided.';
    return { outputs: { result }, summary, notice: reason };
  }
  return { outputs: { result }, summary };
}

export async function mergeRecord(ctx, api) {
  const number = prNumber(ctx);
  const headSha = ctx['head-sha'];
  if (!SHA.test(headSha)) throw new Error(`'head-sha' must be a full commit SHA, got '${headSha}'.`);
  const body = `<!-- merge-decision head=${headSha} -->\nMerge decision recorded for ${headSha}; a new commit triggers a new decision.`;
  await api.request('POST', `/repos/${ctx.repo}/issues/${number}/comments`, { body });
  return { outputs: {}, summary: [`Recorded the merge decision on PR #${number}.`] };
}

// A reviewer that cannot approve (for example on its own pull request) leaves a clean grade as a comment: the top grade
// alone, plus `Ticket:` lines.
export function isCleanGrade(body = '') {
  const lines = (body ?? '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return lines[0] === '★★★★★' && lines.slice(1).every((line) => /^Ticket:/i.test(line));
}

// Turns a review or a check run into a fix or merge workflow dispatch on the default branch, so a pull request can
// never change its own fixer or merger.
export async function feedbackDispatch(ctx, api) {
  const { repo, event = {}, eventName } = ctx;
  const ref = event.repository?.default_branch ?? '';
  const fixWorkflow = ctx['fix-workflow'];
  const mergeWorkflow = ctx['merge-workflow'];
  const mergeCheckName = ctx['merge-check-name'];
  for (const [name, value] of [['fix-workflow', fixWorkflow], ['merge-workflow', mergeWorkflow]]) {
    if (value && !WORKFLOW_FILE.test(value)) throw new Error(`'${name}' must be a workflow file name, got '${value}'.`);
  }
  const lower = (value) => words(value).map((login) => login.toLowerCase());
  const ignored = new Set(lower(ctx['ignore-authors']));
  const replyIgnored = new Set(lower(ctx['ignore-reply-authors']));
  const summary = [];
  const notices = [];

  async function dispatch(workflow, number) {
    try {
      await api.request('POST', `/repos/${repo}/actions/workflows/${workflow}/dispatches`, { ref, inputs: { pr_number: String(number) } });
      summary.push(`Dispatched ${workflow} for PR #${number}.`);
    } catch (error) {
      if (error.status !== 404) throw error;
      const reason = `${workflow} is not on ${ref}; PR #${number} was not dispatched.`;
      summary.push(reason);
      notices.push(reason);
    }
  }

  if (eventName === 'pull_request_review') {
    const { review = {}, pull_request: pullRequest = {} } = event;
    const author = review.user?.login ?? '';
    const state = String(review.state).toLowerCase();
    if (pullRequest.head?.repo?.full_name !== repo) {
      summary.push(`Skipped: PR #${pullRequest.number} comes from a fork.`);
    } else if (state === 'approved') {
      if (mergeWorkflow) await dispatch(mergeWorkflow, pullRequest.number);
      else summary.push('Skipped: merge-workflow is empty.');
    } else if (state === 'changes_requested' || state === 'commented') {
      const comments = await api.paginate(`/repos/${repo}/pulls/${pullRequest.number}/reviews/${review.id}/comments`);
      const hasBody = Boolean(review.body?.trim());
      const actionable = state === 'changes_requested' || hasBody || comments.length > 0;
      const replyOnly = state === 'commented' && !hasBody && comments.length > 0 && comments.every((comment) => comment.in_reply_to_id);
      // A clean grade asks for no change, so it never dispatches a fix, even with threads still open: the merge gate
      // hands those to a person. Two clean reviews of one head then never start two fix passes.
      const clean = state === 'commented' && comments.length === 0 && isCleanGrade(review.body);
      if (clean) {
        if (mergeWorkflow) await dispatch(mergeWorkflow, pullRequest.number);
        else summary.push('Skipped: the review is a clean grade and merge-workflow is empty.');
      } else if (!fixWorkflow) {
        summary.push('Skipped: fix-workflow is empty.');
      } else if (ignored.has(author.toLowerCase())) {
        summary.push(`Skipped: reviews by ${author} are ignored.`);
      } else if (replyOnly && replyIgnored.has(author.toLowerCase())) {
        summary.push(`Skipped: the review by ${author} only replies to existing threads.`);
      } else if (!actionable) {
        summary.push('Skipped: the review has no body and no inline comments.');
      } else {
        await dispatch(fixWorkflow, pullRequest.number);
      }
    } else {
      summary.push(`Skipped: review state ${state}.`);
    }
  } else if (eventName === 'check_run') {
    const checkRun = event.check_run ?? {};
    if (!mergeWorkflow || !mergeCheckName) {
      summary.push('Skipped: merge-workflow or merge-check-name is empty.');
    } else if (checkRun.name !== mergeCheckName || checkRun.status !== 'completed' || checkRun.conclusion !== 'success') {
      summary.push(`Skipped: check run ${checkRun.name} (${checkRun.status}/${checkRun.conclusion}) is not a successful ${mergeCheckName}.`);
    } else {
      // pull_requests only lists same-repository pull requests whose head matches the check run.
      const numbers = (checkRun.pull_requests ?? []).filter((pr) => pr.head?.repo?.id === pr.base?.repo?.id).map((pr) => pr.number);
      if (numbers.length === 0) summary.push('Skipped: the check run has no same-repository pull request.');
      for (const number of numbers) await dispatch(mergeWorkflow, number);
    }
  } else {
    summary.push(`Skipped: unsupported event ${eventName}.`);
  }
  return { outputs: {}, summary, ...(notices.length > 0 ? { notice: notices.join(' ') } : {}) };
}

const COMMANDS = {
  'fix-gate': fixGate,
  'fix-record': fixRecord,
  'feedback-dispatch': feedbackDispatch,
  'fix-finish': fixFinish,
  'merge-dispatch': mergeDispatch,
  'merge-outcome': mergeOutcome,
  'merge-gate': mergeGate,
  'merge-record': mergeRecord
};

export async function main(env = process.env, api = null) {
  const ctx = readContext(env);
  const command = COMMANDS[ctx.command];
  if (!command) throw new Error(`Unsupported command '${ctx.command}'. Use ${Object.keys(COMMANDS).join(', ')}.`);
  const client = api ?? createClient({ token: env.GITHUB_TOKEN ?? '', apiUrl: env.GITHUB_API_URL || undefined, graphqlUrl: env.GITHUB_GRAPHQL_URL || '' });
  if (ctx.command === 'feedback-dispatch') ctx.event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8'));
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
