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
  'merge-check-name', 'output-file', 'qa-check-name', 'review-check-name', 'qa-workflow', 'review-workflow'
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

// A blocked pull request gets a fix pass (which merges the base and repairs CI) when fix-gate would let one run on this
// head. The dispatch leaves a bot marker of the head, so a later decision on the same head waits for that pass (its push
// starts the checks, review, and QA again) instead of dispatching another; dispatched runs do not say which pull
// request they serve, so the marker, not the fix workflow's queue, is what ties the pass to this pull request.
// Otherwise (no fix workflow, not opted in, escalated, out of rounds, or a pass already ran on this head and left the
// block) a person is told instead of the pull request waiting silently.
const REPAIR_DISPATCHED = (head) => [`<!-- merge-decision repair-dispatched head=${head} -->`, `<!-- merge-decision conflicts-dispatched head=${head} -->`];
async function repairRoute(ctx, pr, comments) {
  const workflow = ctx['fix-workflow'];
  if (!workflow) return 'handoff';
  if (!WORKFLOW_FILE.test(workflow)) throw new Error(`'fix-workflow' must be a workflow file name, got '${workflow}'.`);
  const standing = fixStanding(ctx, pr, comments, words(ctx['fix-branch-prefixes']));
  if (standing.reason || standing.rounds >= Number(ctx['max-rounds'] || 3)) return 'handoff';
  if (standing.markers.some((comment) => comment.body.match(FIX_MARKER)[2] === pr.head.sha)) return 'handoff';
  const markers = REPAIR_DISPATCHED(pr.head.sha);
  if (comments.some((comment) => comment.user?.type === 'Bot' && markers.some((marker) => comment.body?.includes(marker)))) return 'queued';
  return 'fix';
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
  // A blocked pull request that nothing else moves (conflicts, red checks, a standing request for changes) is sent to a
  // fix pass or to a person, never left waiting silently.
  let issueComments;
  const repair = async (reason, fixable) => {
    issueComments ??= await api.paginate(`/repos/${repo}/issues/${number}/comments`);
    const route = fixable ? await repairRoute(ctx, pr, issueComments) : 'handoff';
    const outputs = { action: 'skip', pr_number: String(pr.number), head_sha: headSha };
    if (route === 'queued') return { ...skip(`${reason}; the ${ctx['fix-workflow']} pass dispatched for ${headSha} handles it.`), outputs };
    if (route === 'fix') return { outputs: { ...outputs, repair: 'fix', repair_reason: reason }, summary: [`skipped: ${reason}; dispatching ${ctx['fix-workflow']}.`] };
    return { outputs: { ...outputs, repair: 'handoff', repair_reason: reason }, summary: [`skipped: ${reason}.`], notice: `${reason}.` };
  };
  if (pr.mergeable === false || pr.mergeable_state === 'dirty') return repair(`PR #${number} has merge conflicts`, true);

  const runs = await paginateKey(api, `/repos/${repo}/actions/runs?head_sha=${headSha}`, 'workflow_runs');
  const ignoredSuites = new Set(runs.filter((run) => DISPATCHER_EVENTS.has(run.event)).map((run) => run.check_suite_id));
  const checkRuns = newestPerWorkflow((await paginateKey(api, `/repos/${repo}/commits/${headSha}/check-runs?filter=latest`, 'check_runs'))
    .filter((check) => !ignoredSuites.has(check.check_suite?.id)), runs);
  const pending = checkRuns.filter((check) => check.status !== 'completed').map((check) => check.name);
  if (pending.length > 0) return skip(`checks still running on ${headSha}: ${pending.join(', ')}.`);
  const failed = checkRuns
    .filter((check) => !['success', 'neutral', 'skipped'].includes(check.conclusion))
    .map((check) => `${check.name} (${check.conclusion})`);
  if (failed.length > 0) {
    // A fix pass can repair CI; a failed AI check (the review, QA, or a fix pass itself) needs its own rerun or a person.
    const aiChecks = new Set(['Code Review', 'AI QA', 'PR Fix', ctx['review-check-name'], ctx['qa-check-name'], ctx['check-name']].filter(Boolean));
    const fixable = checkRuns.some((check) => !['success', 'neutral', 'skipped'].includes(check.conclusion) && !aiChecks.has(check.name));
    return repair(`checks not successful on ${headSha}: ${failed.join(', ')}`, fixable);
  }
  const { data: status } = await api.request('GET', `/repos/${repo}/commits/${headSha}/status`);
  if (status.total_count > 0 && status.state === 'pending') return skip(`commit statuses are pending on ${headSha}.`);
  if (status.total_count > 0 && status.state !== 'success') return repair(`commit statuses are ${status.state} on ${headSha}`, true);

  const reviews = await api.paginate(`/repos/${repo}/pulls/${number}/reviews`);
  const latest = new Map();
  for (const review of reviews) {
    if (!review.user || !['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(review.state)) continue;
    latest.set(review.user.login, review);
  }
  // An AI reviewer publishes nothing on a head with nothing new, so its request for changes counts only on the head it
  // reviewed; the join already weighed that review. A person's request stands until that person reviews again.
  const changesRequested = [...latest.values()]
    .filter((review) => review.state === 'CHANGES_REQUESTED' && (review.user.type !== 'Bot' || review.commit_id === headSha))
    .map((review) => review.user.login);
  if (changesRequested.length > 0) return repair(`changes requested by ${changesRequested.join(', ')}`, false);
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

// What a review asks for: `merge` (an approval or a clean grade), `fix` (changes requested or actionable comments), or
// nothing, with the reason.
export function reviewOutcome(review = {}, comments = [], { ignored = new Set(), replyIgnored = new Set(), allReplies = false } = {}) {
  const author = (review.user?.login ?? '').toLowerCase();
  const state = String(review.state).toLowerCase();
  if (state === 'approved') return { outcome: 'merge', reason: 'the review approves' };
  if (state !== 'changes_requested' && state !== 'commented') return { outcome: null, reason: `review state ${state}.` };
  const hasBody = Boolean(review.body?.trim());
  const actionable = state === 'changes_requested' || hasBody || comments.length > 0;
  const replyOnly = state === 'commented' && !hasBody && comments.length > 0 && comments.every((comment) => comment.in_reply_to_id);
  // A clean grade asks for no change, so it never dispatches a fix, even with threads still open: the merge gate
  // hands those to a person. Two clean reviews of one head then never start two fix passes.
  if (state === 'commented' && comments.length === 0 && isCleanGrade(review.body)) return { outcome: 'merge', reason: 'the review is a clean grade' };
  if (ignored.has(author)) return { outcome: null, reason: `reviews by ${review.user?.login} are ignored.` };
  if (replyOnly && (allReplies || replyIgnored.has(author))) return { outcome: null, reason: `the review by ${review.user?.login} only replies to existing threads.` };
  if (!actionable) return { outcome: null, reason: 'the review has no body and no inline comments.' };
  return { outcome: 'fix', reason: 'the review asks for changes' };
}

const JOIN_MARKER = /<!-- quality-join (head=[0-9a-f]{40} review-check=\d+ qa-check=\d+ reviews=\d+) -->/;
const RUN_ID = /\/actions\/runs\/(\d+)/;

// The newest completed check run of that name on the head whose run is the given workflow, dispatched on the default
// branch of this repository. Any App with `checks: write`, or a workflow added on a pull request branch, can create a
// check run with the same name; only the run that created it tells the real one apart. GitHub replaces the
// `details_url` of a check run created with the Actions token by the check's own page, so the creating run records its
// id in `external_id`; a `details_url` that points at a run is the fallback.
async function trustedCheck(api, repo, head, name, workflow, defaultBranch) {
  const checks = (await paginateKey(api, `/repos/${repo}/commits/${head}/check-runs?check_name=${encodeURIComponent(name)}`, 'check_runs'))
    .filter((check) => check.name === name)
    .sort((a, b) => (Date.parse(b.started_at ?? '') || 0) - (Date.parse(a.started_at ?? '') || 0) || b.id - a.id);
  for (const check of checks) {
    const id = /^\d+$/.test(check.external_id ?? '') ? check.external_id : RUN_ID.exec(check.details_url ?? '')?.[1];
    if (!id) continue;
    let run;
    try {
      ({ data: run } = await api.request('GET', `/repos/${repo}/actions/runs/${id}`));
    } catch (error) {
      if (error.status === 404) continue;
      throw error;
    }
    if (String(run.path ?? '').split('@')[0] === `.github/workflows/${workflow}` && run.head_branch === defaultBranch
      && run.event === 'workflow_dispatch' && run.repository?.full_name === repo) return check;
  }
  return null;
}

// Joins the code review and the QA check of one head commit, which run as separate workflows. It runs when either
// check completes and on every review, and decides only once both checks of the head have completed: the review side
// asks for a fix when the newest substantive review of the head by any reviewer (not a reply to existing threads,
// not by `ignore-authors`) does, and otherwise approves, even with no review at all (a reviewer with nothing new publishes none; the merge gate
// still hands open threads to a person). Both approving dispatches the merge workflow; otherwise the fix workflow, which
// handles the review threads and the QA report together. Each decision is recorded with a bot marker of the head, both
// check runs, and the newest substantive review, so it is dispatched once, and a QA rerun or a new review decides again.
// Callers serialize joins per pull request with a concurrency group; every join reads the whole state, so a join the
// group drops is made up by the next one.
export async function qualityJoin(ctx, api, number) {
  const { repo } = ctx;
  const qaName = ctx['qa-check-name'];
  const reviewName = ctx['review-check-name'] || 'Code Review';
  const qaWorkflow = ctx['qa-workflow'] || 'qa.yml';
  const reviewWorkflow = ctx['review-workflow'] || 'code-review.yml';
  if (!qaName) throw new Error("'qa-check-name' is required to join the review and QA.");
  for (const name of ['fix-workflow', 'merge-workflow']) {
    if (!WORKFLOW_FILE.test(ctx[name])) throw new Error(`'${name}' must be a workflow file name, got '${ctx[name]}'.`);
  }
  for (const [name, value] of [['qa-workflow', qaWorkflow], ['review-workflow', reviewWorkflow]]) {
    if (!WORKFLOW_FILE.test(value)) throw new Error(`'${name}' must be a workflow file name, got '${value}'.`);
  }
  const lower = (value) => words(value).map((login) => login.toLowerCase());
  const { data: pr } = await api.request('GET', `/repos/${repo}/pulls/${number}`);
  if (pr.state !== 'open') return { summary: [`Skipped: PR #${number} is not open.`] };
  if (pr.head.repo?.full_name !== repo) return { summary: [`Skipped: PR #${number} comes from a fork.`] };
  const head = pr.head.sha;
  const short = head.slice(0, 7);
  const { data: repository } = await api.request('GET', `/repos/${repo}`);
  const defaultBranch = repository.default_branch;

  const review = await trustedCheck(api, repo, head, reviewName, reviewWorkflow, defaultBranch);
  if (!review || review.status !== 'completed') return { summary: [`Waiting for ${reviewName} on ${short}; its end joins ${qaName}.`] };
  if (review.conclusion !== 'success') {
    const reason = `${reviewName} on ${short} ended ${review.conclusion}; rerun it to continue.`;
    return { summary: [reason], notice: reason };
  }
  const qa = await trustedCheck(api, repo, head, qaName, qaWorkflow, defaultBranch);
  if (!qa || qa.status !== 'completed') return { summary: [`Waiting for ${qaName} on ${short}; its end joins ${reviewName}.`] };
  if (!['success', 'failure'].includes(qa.conclusion)) {
    const reason = `${qaName} on ${short} ended ${qa.conclusion} without a verdict; rerun it to continue.`;
    return { summary: [reason], notice: reason };
  }

  const options = { ignored: new Set(lower(ctx['ignore-authors'])), allReplies: true };
  const reviews = (await api.paginate(`/repos/${repo}/pulls/${number}/reviews`))
    .filter((item) => item.commit_id === head && item.submitted_at);
  // Each reviewer's newest substantive review of the head is what that reviewer asks for now: a person who requested
  // changes and then approved the same head after discussion no longer asks for a fix.
  let newest = 0;
  const latest = new Map();
  for (const item of [...reviews].sort((x, y) => Date.parse(x.submitted_at) - Date.parse(y.submitted_at) || x.id - y.id)) {
    const state = String(item.state).toLowerCase();
    const comments = ['changes_requested', 'commented'].includes(state)
      ? await api.paginate(`/repos/${repo}/pulls/${number}/reviews/${item.id}/comments`)
      : [];
    const { outcome } = reviewOutcome(item, comments, options);
    if (!outcome) continue;
    newest = Math.max(newest, Number(item.id));
    latest.set((item.user?.login ?? '').toLowerCase(), { login: item.user?.login ?? 'someone', outcome });
  }
  const askers = [...latest.values()].filter((item) => item.outcome === 'fix').map((item) => item.login);

  const key = `head=${head} review-check=${review.id} qa-check=${qa.id} reviews=${newest}`;
  const comments = await api.paginate(`/repos/${repo}/issues/${number}/comments`);
  if (comments.some((comment) => comment.user?.type === 'Bot' && JOIN_MARKER.exec(comment.body ?? '')?.[1] === key)) {
    return { summary: [`Already joined ${reviewName} and ${qaName} of ${short} with these reviews.`] };
  }

  const qaPassed = qa.conclusion === 'success';
  const merge = askers.length === 0 && qaPassed;
  const workflow = merge ? ctx['merge-workflow'] : ctx['fix-workflow'];
  // Dispatch before recording, so a failed dispatch is retried by the next join instead of being marked done.
  try {
    await api.request('POST', `/repos/${repo}/actions/workflows/${workflow}/dispatches`, { ref: defaultBranch, inputs: { pr_number: String(number) } });
  } catch (error) {
    if (error.status !== 404) throw error;
    const reason = `${workflow} is not on ${defaultBranch}; PR #${number} was not dispatched.`;
    return { summary: [reason], notice: reason };
  }
  const reviewText = askers.length > 0 ? `changes requested by ${askers.join(', ')}` : 'approved';
  const body = [
    `<!-- quality-join ${key} -->`,
    `Quality join for ${short}: code review ${reviewText}, [${qaName}](${qa.html_url ?? qa.details_url ?? ''}) ${qaPassed ? 'approved' : 'changes required'}.`,
    merge ? `Both approved: dispatched ${workflow}.` : `Dispatched ${workflow} to fix the findings of ${[askers.length > 0 && 'the review', !qaPassed && qaName].filter(Boolean).join(' and ')}.`
  ].join('\n');
  await api.request('POST', `/repos/${repo}/issues/${number}/comments`, { body });
  return { summary: [`Joined ${reviewName} and ${qaName} of ${short}: dispatched ${workflow} for PR #${number}.`] };
}

export async function qualityJoinCommand(ctx, api) {
  const result = await qualityJoin(ctx, api, prNumber(ctx));
  return { outputs: {}, ...result };
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
    if (pullRequest.head?.repo?.full_name !== repo) {
      summary.push(`Skipped: PR #${pullRequest.number} comes from a fork.`);
    } else if (ctx['qa-check-name']) {
      // Every review event joins from the pull request's state, so a join that the concurrency group dropped (it keeps
      // one pending run) is made up by the next one, whatever review triggered it.
      const joined = await qualityJoin(ctx, api, pullRequest.number);
      summary.push(...joined.summary);
      if (joined.notice) notices.push(joined.notice);
    } else {
      const comments = ['changes_requested', 'commented'].includes(String(review.state).toLowerCase())
        ? await api.paginate(`/repos/${repo}/pulls/${pullRequest.number}/reviews/${review.id}/comments`)
        : [];
      const { outcome, reason } = reviewOutcome(review, comments, { ignored, replyIgnored });
      const workflow = outcome === 'merge' ? mergeWorkflow : outcome === 'fix' ? fixWorkflow : '';
      if (!outcome) summary.push(`Skipped: ${reason}`);
      else if (!workflow) summary.push(`Skipped: ${reason}, and ${outcome === 'merge' ? 'merge' : 'fix'}-workflow is empty.`);
      else await dispatch(workflow, pullRequest.number);
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
  'quality-join': qualityJoinCommand,
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
