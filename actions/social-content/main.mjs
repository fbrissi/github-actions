#!/usr/bin/env node
// Deterministic steps of the social content workflows: platform matrix, agent prompt, the /adjust and /aprove gate,
// the Instagram schedule sweep, the publishing report, the adjust report, and the review issue fallback when the
// generate agent did not open one. GitHub calls go through an injected client and ai-skills scripts through an
// injected runner, so every command is testable without network.
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createClient } from '../ai-delivery/github.mjs';
import {
  PLATFORM_NAMES,
  buildPrompt,
  decodeMarker,
  gateDecision,
  issueDecision,
  isCommandName,
  isRepoPath,
  mergeState,
  parseHeader,
  parsePlatforms,
  pendingIssues,
  summarize
} from './social-content.mjs';

const NAMES = ['command', 'platforms', 'platform', 'mode', 'start', 'profile', 'issue', 'comment-id', 'slash-command', 'label',
  'drive-root', 'instructions', 'manifest', 'before', 'log', 'outcome', 'save-outcome', 'save-reason', 'always-comment', 'before-revision', 'skills-dir', 'since',
  'agent-outcome'];

export const envName = (name) => `SOCIAL_${name.toUpperCase().replaceAll('-', '_')}`;

export function readContext(env = process.env) {
  const ctx = Object.fromEntries(NAMES.map((name) => [name, (env[envName(name)] ?? '').trim()]));
  ctx.instructions = env[envName('instructions')] ?? '';
  ctx.repo = env.GITHUB_REPOSITORY ?? '';
  ctx.issue = ctx.issue.replace(/^#/, '');
  ctx.label = ctx.label || 'marketing-content';
  ctx.profile = ctx.profile || 'docs/ai/social-content.md';
  ctx.outcome = ctx.outcome || 'success';
  ctx['agent-outcome'] = ctx['agent-outcome'] || 'success';
  ctx.cwd = env.GITHUB_WORKSPACE || process.cwd();
  const server = env.GITHUB_SERVER_URL || 'https://github.com';
  ctx.runUrl = env.GITHUB_RUN_ID && ctx.repo ? `${server}/${ctx.repo}/actions/runs/${env.GITHUB_RUN_ID}` : '';
  return ctx;
}

const issueNumber = (value) => {
  if (!/^[1-9][0-9]*$/.test(String(value ?? ''))) throw new Error(`'issue' must be an issue number, got '${value}'.`);
  return Number(value);
};

export function writeOutputs(env, outputs) {
  if (!env.GITHUB_OUTPUT) return;
  for (const [name, value] of Object.entries(outputs)) {
    const text = String(value ?? '');
    if (/[\r\n]/.test(text)) {
      const delimiter = `EOF_${Math.random().toString(16).slice(2)}${Date.now().toString(16)}`;
      appendFileSync(env.GITHUB_OUTPUT, `${name}<<${delimiter}\n${text}\n${delimiter}\n`);
    } else {
      appendFileSync(env.GITHUB_OUTPUT, `${name}=${text}\n`);
    }
  }
}

async function getOrNull(api, path) {
  try {
    return (await api.request('GET', path)).data;
  } catch (error) {
    if (error.status === 404) return null;
    throw error;
  }
}

async function comment(api, repo, issue, body) {
  await api.request('POST', `/repos/${repo}/issues/${issue}/comments`, { body });
}

export function matrix(ctx) {
  const { platforms, errors } = parsePlatforms(ctx.platforms);
  if (errors.length) throw new Error(errors.join('\n'));
  return { platforms: JSON.stringify(platforms) };
}

export function prompt(ctx) {
  const result = buildPrompt({
    mode: ctx.mode, platform: ctx.platform, start: ctx.start, profile: ctx.profile, issue: ctx.issue, label: ctx.label,
    driveRoot: ctx['drive-root'], instructions: ctx.instructions
  });
  if (result.errors.length) throw new Error(result.errors.join('\n'));
  return { prompt: result.prompt, instructions: result.instructions };
}

/**
 * Lets an /adjust or /aprove comment through only when a person with write access wrote it on an open review issue.
 * Strangers and bots are only logged; a writer whose command cannot run gets a reply with the reason.
 */
export async function gate(ctx, api, log) {
  const command = ctx['slash-command'];
  if (!isCommandName(command)) throw new Error(`'slash-command' must look like /name, got '${command}'.`);
  const issue = issueNumber(ctx.issue);
  if (!/^[1-9][0-9]*$/.test(ctx['comment-id'])) throw new Error(`'comment-id' must be a number, got '${ctx['comment-id']}'.`);
  const repo = ctx.repo;
  const data = await getOrNull(api, `/repos/${repo}/issues/comments/${ctx['comment-id']}`);
  const login = data?.user?.login ?? '';
  const permission = login && !/\[bot\]$/i.test(login)
    ? await getOrNull(api, `/repos/${repo}/collaborators/${encodeURIComponent(login)}/permission`)
    : null;
  const issueData = await getOrNull(api, `/repos/${repo}/issues/${issue}`);
  const decision = gateDecision({ comment: data, issue: issueData, permission, command, label: ctx.label, issueNumber: issue });
  if (!decision.allowed) {
    log.notice(`${command} ignored: ${decision.reason}`);
    if (decision.kind === 'issue' && issueData && !issueData.pull_request) {
      await comment(api, repo, issue, `\`${command}\` was not run: ${decision.reason}${ctx.runUrl ? ` ([run](${ctx.runUrl}))` : ''}`);
    }
    return { allowed: 'false', reason: decision.reason, platform: '', batch: '', revision: '', actor: login };
  }
  try {
    await api.request('POST', `/repos/${repo}/issues/comments/${ctx['comment-id']}/reactions`, { content: 'eyes' });
  } catch (error) {
    log.warning(`Could not react to the comment: ${error.message}`);
  }
  log.info(`${command} by ${login} on #${issue}: ${decision.platform} batch ${decision.batch}, revision ${decision.revision}.`);
  return { allowed: 'true', reason: '', platform: decision.platform, batch: decision.batch, revision: String(decision.revision), actor: login };
}

/** Checks a review issue named by a manual run (no comment): open, labeled, with a consistent batch marker. */
export async function target(ctx, api, log) {
  const issue = issueNumber(ctx.issue);
  const issueData = await getOrNull(api, `/repos/${ctx.repo}/issues/${issue}`);
  const decision = issueDecision({ issue: issueData, label: ctx.label, issueNumber: issue });
  if (!decision.allowed) {
    log.warning(decision.reason);
    return { allowed: 'false', reason: decision.reason, platform: '', batch: '', revision: '' };
  }
  return { allowed: 'true', reason: '', platform: decision.platform, batch: decision.batch, revision: String(decision.revision) };
}

export async function pending(ctx, api, log) {
  if (!PLATFORM_NAMES[ctx.platform]) throw new Error(`Unknown platform '${ctx.platform}'.`);
  const issues = await api.paginate(`/repos/${ctx.repo}/issues?state=open&labels=${encodeURIComponent(ctx.label)}`);
  const numbers = pendingIssues(issues, { platform: ctx.platform, label: ctx.label });
  log.info(numbers.length ? `Approved ${ctx.platform} batches to publish: ${numbers.map((n) => `#${n}`).join(', ')}.` : `No approved ${ctx.platform} batch has items left to publish.`);
  return { issues: JSON.stringify(numbers), count: String(numbers.length) };
}

const readJson = (path) => (path && existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null);
const readText = (path) => (path && existsSync(path) ? readFileSync(path, 'utf8') : '');

/**
 * Writes the run's manifest back to the issue body without losing what a concurrent run wrote: re-reads the body just
 * before writing and merges per item (see mergeState). When an adjust moved the batch to another revision, nothing is
 * written (`saved=conflict`) and the report leaves the run's results as a note instead.
 */
export async function saveState(ctx, api, log, { run = runNode } = {}) {
  const issue = issueNumber(ctx.issue);
  const ours = readJson(ctx.manifest);
  if (!ours) {
    log.info('No restored manifest; the issue body is unchanged.');
    return { saved: 'skipped', reason: '' };
  }
  if (!ctx['skills-dir']) throw new Error("'skills-dir' is required.");
  const before = readJson(ctx.before) ?? ours;
  const data = await getOrNull(api, `/repos/${ctx.repo}/issues/${issue}`);
  const header = parseHeader(data?.body);
  const live = decodeMarker(data?.body);
  const result = header && live && header.revision !== (live.review?.revision ?? 1)
    ? { action: 'conflict', reason: 'the issue header and marker disagree (an adjust is updating it)' }
    : mergeState({ ours, before, live });
  if (result.action === 'conflict') {
    log.warning(`State of #${issue} not saved: ${result.reason}.`);
    return { saved: 'conflict', reason: result.reason };
  }
  if (result.action === 'unchanged') {
    log.info(`The body of #${issue} already holds this state.`);
    return { saved: 'unchanged', reason: '' };
  }
  const merged = join(dirname(ctx.manifest), 'merged.json');
  writeFileSync(merged, `${JSON.stringify(result.manifest, null, 2)}\n`);
  const args = [join(ctx['skills-dir'], 'social-review', 'scripts', 'review-batch.mjs'), 'issue-body', merged];
  if (existsSync(resolve(ctx.cwd, ctx.profile))) args.push('--profile', ctx.profile);
  const body = run(args, { cwd: ctx.cwd });
  if (body.code !== 0) throw new Error(`Could not render the issue body: ${tail(body.stderr || body.stdout)}`);
  await api.request('PATCH', `/repos/${ctx.repo}/issues/${issue}`, { body: body.stdout });
  log.info(`Saved the state of ${result.changed.length ? result.changed.join(', ') : 'the approval'} in #${issue}.`);
  return { saved: 'true', reason: '' };
}

/** Comments the outcome of a publisher run and closes the issue once every item is done or stale. */
export async function report(ctx, api, log) {
  const issue = issueNumber(ctx.issue);
  const manifest = readJson(ctx.manifest);
  const outcome = ctx.outcome;
  const run = ctx.runUrl ? `\n\n[Workflow run](${ctx.runUrl})` : '';
  const detail = () => {
    const lines = readText(ctx.log).trim().split(/\r?\n/).filter(Boolean).slice(-3).map((line) => line.slice(0, 300));
    return lines.length ? `\n\n\`\`\`text\n${lines.join('\n').replaceAll('```', "'''")}\n\`\`\`` : '';
  };
  if (ctx['save-outcome'] === 'failure') {
    await comment(api, ctx.repo, issue, `### State not saved\n\nThe publishing state could not be written back to this issue body, so the issue may not show what is already scheduled or published. Fix the cause (see the run) before running or approving this batch again, or items may be published twice.${detail()}${run}\n`);
    return { complete: 'false', commented: 'true' };
  }
  if (ctx['save-outcome'] === 'conflict') {
    const results = manifest ? summarize({ manifest, log: readText(ctx.log), outcome }).body.replace(/^### .*\n\n/, '').replace(/\n(Every item|The publisher stopped)[^\n]*\n?/, '\n') : '';
    await comment(api, ctx.repo, issue, `### State not saved: the batch changed\n\nThis run's results were not written to the issue body because ${ctx['save-reason'] || 'the batch changed while it ran'}. They are listed here so they are not lost: check these items on the platform before approving the batch again.\n\n${results.trim()}${run}\n`);
    return { complete: 'false', commented: 'true' };
  }
  if (ctx.mode === 'approved') {
    const approval = manifest?.approval ?? {};
    const name = PLATFORM_NAMES[manifest?.platform] ?? 'Instagram';
    const body = outcome === 'success' && manifest
      ? `### ${name} batch approved\n\nRevision ${approval.revision ?? 1} was approved by ${approval.by ?? 'a writer'}. ${name} has no scheduling API, so each scheduled run publishes the items whose date has come.${run}\n`
      : `### Approval not recorded\n\nThe batch was not approved, so nothing will be published.${detail()}\n\nFix the batch with \`/adjust\` or approve the current revision again.${run}\n`;
    await comment(api, ctx.repo, issue, body);
    return { complete: 'false', commented: 'true' };
  }
  if (!manifest) {
    await comment(api, ctx.repo, issue, `### Publishing failed\n\nThe batch was not restored, so nothing was published.${detail()}${run}\n`);
    return { complete: 'false', commented: 'true' };
  }
  const result = summarize({ manifest, before: readJson(ctx.before), log: readText(ctx.log), outcome, runUrl: ctx.runUrl });
  const always = ctx['always-comment'] === 'true';
  // A scheduled run that fails the same way again (an Instagram item stays failed with the same error) stays quiet;
  // a failure no item records is always reported.
  const unattributed = outcome !== 'success' && !result.items.some((item) => item.error);
  const noteworthy = always || result.changed || unattributed || result.stale.length > 0 || result.manual.length > 0;
  if (noteworthy) await comment(api, ctx.repo, issue, outcome === 'success' ? result.body : `${result.body.trimEnd()}${detail()}\n`);
  if (result.complete) {
    await api.request('PATCH', `/repos/${ctx.repo}/issues/${issue}`, { state: 'closed', state_reason: 'completed' });
    log.info(`Closed #${issue}: every item is scheduled, published, or stale.`);
  }
  return { complete: String(result.complete), commented: String(noteworthy) };
}

/** Says whether an adjust run produced a new revision, so a silent agent failure is visible on the issue. */
export async function adjustReport(ctx, api) {
  const issue = issueNumber(ctx.issue);
  const before = Number(ctx['before-revision'] || 0);
  const data = await getOrNull(api, `/repos/${ctx.repo}/issues/${issue}`);
  const after = parseHeader(data?.body)?.revision ?? 0;
  const run = ctx.runUrl ? ` ([run](${ctx.runUrl}))` : '';
  let body;
  if (after > before) body = `Adjust finished: the batch is now at revision ${after}. Review it, then comment \`/adjust\` again or approve it.${run}`;
  else if (ctx.outcome === 'success') body = `Adjust finished without a new revision (still ${after || before}). The agent comment above, if any, says what was declined or missing.${run}`;
  else body = `Adjust failed; the batch stays at revision ${after || before}. Check the run, then comment \`/adjust\` again.${run}`;
  await comment(api, ctx.repo, issue, body);
  return { revision: String(after || before), changed: String(after > before) };
}

export function runNode(args, { cwd }) {
  const child = spawnSync(process.execPath, args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { code: child.status ?? 1, stdout: child.stdout ?? '', stderr: child.stderr ?? String(child.error ?? '') };
}

/** Manifests of one platform under the batches directory written at or after `since` (ms since the epoch). */
export function newManifests(root, batchesDir, platform, since) {
  const dir = join(root, batchesDir, platform);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(dir, entry.name, 'manifest.json'))
    .filter((path) => existsSync(path) && statSync(path).mtimeMs >= since)
    .sort();
}

const tail = (text) => String(text ?? '').trim().split(/\r?\n/).slice(-5).join(' | ');

async function trackingIssue(api, repo, label, manifest) {
  const recorded = manifest.review?.issue_number;
  const matches = (issue) => {
    const header = parseHeader(issue?.body);
    return issue?.state === 'open' && header?.platform === manifest.platform && header?.batch === manifest.batch_id;
  };
  if (recorded) {
    const issue = await getOrNull(api, `/repos/${repo}/issues/${recorded}`);
    if (matches(issue)) return issue.number;
  }
  const open = await api.paginate(`/repos/${repo}/issues?state=open&labels=${encodeURIComponent(label)}`);
  return open.find((issue) => !issue.pull_request && matches(issue))?.number ?? null;
}

async function ensureLabel(api, repo, label) {
  if (await getOrNull(api, `/repos/${repo}/labels/${encodeURIComponent(label)}`)) return;
  try {
    await api.request('POST', `/repos/${repo}/labels`, { name: label, color: '0e8a16', description: 'Social content batch waiting for review' });
  } catch (error) {
    if (error.status !== 422) throw error;
  }
}

/**
 * Fallback after the generate agent: each batch it wrote in this run that no open issue tracks is opened for review
 * here, but only after the copy guard and the manifest validation pass, as the agent would have done.
 */
export async function openReview(ctx, api, log, { run = runNode, now = Date.now() } = {}) {
  const platform = ctx.platform;
  if (!PLATFORM_NAMES[platform]) throw new Error(`Unknown platform '${platform}'.`);
  if (!isRepoPath(ctx.profile)) throw new Error(`profile must be a relative path inside the repository, got '${ctx.profile}'.`);
  const skills = ctx['skills-dir'];
  if (!skills) throw new Error("'skills-dir' is required.");
  const script = (skill, file) => join(skills, skill, 'scripts', file);
  const since = /^[0-9]+$/.test(ctx.since) ? Number(ctx.since) * 1000 : Date.parse(ctx.since);
  if (Number.isNaN(since)) throw new Error(`'since' must be epoch seconds or an ISO date, got '${ctx.since}'.`);
  const options = { cwd: ctx.cwd };

  let batchesDir = 'social/batches';
  if (existsSync(resolve(ctx.cwd, ctx.profile))) {
    const config = run([script('social-review', 'social-manifest.mjs'), 'config', ctx.profile, '--key', 'batches_dir'], options);
    const value = config.stdout.trim();
    if (config.code === 0 && value && value !== 'null') batchesDir = value.replace(/\/+$/, '');
  }
  if (!isRepoPath(batchesDir)) throw new Error(`batches_dir must be a relative path inside the repository, got '${batchesDir}'.`);

  const manifests = newManifests(ctx.cwd, batchesDir, platform, since);
  if (!manifests.length) {
    if (ctx['agent-outcome'] !== 'success') throw new Error(`The ${platform} agent failed and wrote no batch under ${batchesDir}/${platform}; nothing to open.`);
    log.notice(`No new ${platform} batch under ${batchesDir}/${platform}; nothing to open.`);
    return { opened: '[]', tracked: '[]' };
  }

  const opened = [];
  const tracked = [];
  const failures = [];
  for (const path of manifests) {
    const relative = path.slice(ctx.cwd.length + 1);
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(path, 'utf8'));
    } catch (error) {
      failures.push(`${relative}: unreadable manifest (${error.message})`);
      continue;
    }
    if (manifest.platform !== platform) {
      failures.push(`${relative}: platform is ${manifest.platform}, expected ${platform}`);
      continue;
    }
    const existing = await trackingIssue(api, ctx.repo, ctx.label, manifest);
    if (existing) {
      tracked.push(existing);
      log.info(`${manifest.batch_id} is tracked by #${existing}.`);
      continue;
    }
    log.warning(`The ${platform} agent did not open a review issue for ${manifest.batch_id}; opening it deterministically.`);
    const guard = run([script('copy-guard', 'copy-guard.mjs'), '--manifest', relative, '--profile', ctx.profile], options);
    if (guard.code !== 0) {
      failures.push(`${relative}: the copy guard failed (${tail(guard.stdout || guard.stderr)})`);
      continue;
    }
    const valid = run([script('social-review', 'social-manifest.mjs'), 'validate', relative, '--profile', ctx.profile], options);
    if (valid.code !== 0) {
      failures.push(`${relative}: validation failed (${tail(valid.stderr || valid.stdout)})`);
      continue;
    }
    const uploadArgs = [script('social-review', 'review-batch.mjs'), 'upload', relative, '--profile', ctx.profile];
    if (ctx['drive-root']) uploadArgs.push('--root', ctx['drive-root']);
    const upload = run(uploadArgs, options);
    if (upload.code !== 0) {
      failures.push(`${relative}: the Drive upload failed (${tail(upload.stderr || upload.stdout)})`);
      continue;
    }
    const body = run([script('social-review', 'review-batch.mjs'), 'issue-body', relative, '--profile', ctx.profile], options);
    if (body.code !== 0) {
      failures.push(`${relative}: the issue body failed (${tail(body.stderr)})`);
      continue;
    }
    await ensureLabel(api, ctx.repo, ctx.label);
    const count = manifest.items?.length ?? 0;
    const title = `${PLATFORM_NAMES[platform]}: ${manifest.publication_date} (${count} ${count === 1 ? 'item' : 'items'})`;
    const { data: created } = await api.request('POST', `/repos/${ctx.repo}/issues`, { title, body: body.stdout, labels: [ctx.label] });
    opened.push(created.number);
    const recorded = run([script('social-review', 'review-batch.mjs'), 'set-issue', relative, '--issue', String(created.number), '--url', created.html_url], options);
    const final = recorded.code === 0
      ? run([script('social-review', 'review-batch.mjs'), 'issue-body', relative, '--profile', ctx.profile], options)
      : recorded;
    if (final.code !== 0) {
      failures.push(`${relative}: opened #${created.number} but could not record it in the marker (${tail(final.stderr)})`);
      continue;
    }
    await api.request('PATCH', `/repos/${ctx.repo}/issues/${created.number}`, { body: final.stdout });
    log.info(`Opened #${created.number} for ${manifest.batch_id}.`);
  }
  if (failures.length) throw new Error(`Could not open every ${platform} review issue:\n${failures.join('\n')}`);
  return { opened: JSON.stringify(opened), tracked: JSON.stringify(tracked) };
}

export const log = {
  info: (message) => console.log(message),
  notice: (message) => console.log(`::notice::${String(message).replace(/\r?\n/g, ' ')}`),
  warning: (message) => console.log(`::warning::${String(message).replace(/\r?\n/g, ' ')}`)
};

export async function main(env = process.env, api = null, options = {}) {
  const ctx = readContext(env);
  const client = api ?? createClient({ token: env.GITHUB_TOKEN ?? '', apiUrl: env.GITHUB_API_URL || undefined });
  const commands = {
    matrix: () => matrix(ctx),
    prompt: () => prompt(ctx),
    gate: () => gate(ctx, client, log),
    target: () => target(ctx, client, log),
    'save-state': () => saveState(ctx, client, log, options),
    pending: () => pending(ctx, client, log),
    report: () => report(ctx, client, log),
    'adjust-report': () => adjustReport(ctx, client),
    'open-review': () => openReview(ctx, client, log, options)
  };
  if (!commands[ctx.command]) throw new Error(`Unsupported command '${ctx.command}'. Use ${Object.keys(commands).join(', ')}.`);
  const outputs = await commands[ctx.command]();
  writeOutputs(env, outputs);
  return outputs;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.log(`::error::${String(error.message).replace(/\r?\n/g, '%0A')}`);
    process.exitCode = 1;
  });
}
