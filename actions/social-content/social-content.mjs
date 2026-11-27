// Pure helpers of the social content workflows: platform lists, slash-command parsing, review issue markers,
// the comment gate, the Instagram schedule sweep, and the publishing report. No I/O, so every rule is testable.
import { gunzipSync } from 'node:zlib';

export const PLATFORMS = ['facebook', 'instagram', 'youtube'];
export const PLATFORM_NAMES = { facebook: 'Facebook', instagram: 'Instagram', youtube: 'YouTube' };
export const WRITE_ROLES = ['admin', 'maintain', 'write'];
export const DONE_STATUSES = ['scheduled', 'published', 'skipped'];
export const HEADER = /<!-- social-content:batch platform=(\S+) batch=(\S+) revision=(\d+) -->/;
const MARKER = /<!-- social-content-manifest:v1:([A-Za-z0-9+/=]+) -->/g;

/** Whitespace- or comma-separated platform names, deduplicated, in the given order. */
export function parsePlatforms(text) {
  const names = String(text ?? '').split(/[\s,]+/).map((name) => name.trim().toLowerCase()).filter(Boolean);
  const errors = names.filter((name) => !PLATFORMS.includes(name)).map((name) => `Unknown platform '${name}'. Use ${PLATFORMS.join(', ')}.`);
  const platforms = [...new Set(names.filter((name) => PLATFORMS.includes(name)))];
  if (!errors.length && !platforms.length) errors.push(`No platform given. Use ${PLATFORMS.join(', ')}.`);
  return { platforms, errors };
}

/** Same rule as ai-skills review-batch.mjs: the trimmed body starts with the command, then whitespace or the end. */
export function isCommand(body, command) {
  const text = String(body ?? '').trim().toLowerCase();
  const name = String(command ?? '').trim().toLowerCase();
  if (!name) return false;
  return text.startsWith(name) && (text.length === name.length || /\s/.test(text[name.length]));
}

export function isCommandName(command) {
  return /^\/[A-Za-z0-9_-]+$/.test(String(command ?? ''));
}

export function parseHeader(body) {
  const match = HEADER.exec(String(body ?? ''));
  return match ? { platform: match[1], batch: match[2], revision: Number(match[3]) } : null;
}

/** The manifest in the last marker of a text (the last one wins), or null when there is none or it is corrupt. */
export function decodeMarker(text) {
  const matches = [...String(text ?? '').matchAll(MARKER)];
  if (!matches.length) return null;
  try {
    return JSON.parse(gunzipSync(Buffer.from(matches.at(-1)[1], 'base64')).toString('utf8'));
  } catch {
    return null;
  }
}

export const labelNames = (issue) => (issue?.labels ?? []).map((label) => (typeof label === 'string' ? label : label?.name)).filter(Boolean);

export function hasLabel(issue, label) {
  const wanted = String(label ?? '').toLowerCase();
  return labelNames(issue).some((name) => name.toLowerCase() === wanted);
}

/** `role_name` (admin, maintain, write, triage, read) from the collaborator permission endpoint, else `permission`. */
export function canWrite(permission) {
  return WRITE_ROLES.includes(permission?.role_name ?? permission?.permission);
}

export const isBot = (user) => user?.type === 'Bot' || /\[bot\]$/i.test(user?.login ?? '');

/**
 * Checks that a comment may start an adjust or an approval. `commenter` is about who wrote it: a person (never a
 * bot, since the ai-skills scripts never count bot commands) with write, maintain, or admin permission. `issue` is
 * about where: an open issue, not a pull request, with the content label, the batch header, and a manifest marker
 * that agree. Returns the first failure with its kind (`commenter`, `unrelated`, or `issue`), so the caller stays
 * quiet for strangers and unrelated issues and answers writers on a review issue.
 */
export function gateDecision({ comment, issue, permission, command, label, issueNumber }) {
  const reject = (kind, reason) => ({ allowed: false, kind, reason });
  if (!comment) return reject('commenter', 'The comment was not found.');
  if (!isCommand(comment.body, command)) return reject('commenter', `The comment does not start with ${command}.`);
  if (isBot(comment.user)) return reject('commenter', `Bots cannot run ${command}.`);
  if (!canWrite(permission)) return reject('commenter', `${comment.user?.login ?? 'The commenter'} has no write, maintain, or admin permission.`);
  const commentIssue = /\/issues\/(\d+)$/.exec(comment.issue_url ?? '')?.[1];
  if (commentIssue && Number(commentIssue) !== Number(issueNumber)) return reject('issue', `The comment is not on issue #${issueNumber}.`);
  return issueDecision({ issue, label, issueNumber });
}

/** The issue half of the gate: an open review issue with the label, a known platform, and a matching marker. */
export function issueDecision({ issue, label, issueNumber }) {
  const reject = (kind, reason) => ({ allowed: false, kind, reason });
  if (!issue) return reject('issue', `Issue #${issueNumber} was not found.`);
  if (issue.pull_request) return reject('issue', `#${issueNumber} is a pull request, not a review issue.`);
  const header = parseHeader(issue.body);
  const labeled = hasLabel(issue, label);
  if (!labeled && !header) return reject('unrelated', `Issue #${issueNumber} is not a social content review issue.`);
  if (issue.state !== 'open') return reject('issue', `Issue #${issueNumber} is ${issue.state}.`);
  if (!labeled) return reject('issue', `Issue #${issueNumber} does not have the ${label} label.`);
  if (!header) return reject('issue', `Issue #${issueNumber} has no social content batch header.`);
  if (!PLATFORMS.includes(header.platform)) return reject('issue', `Issue #${issueNumber} names an unknown platform '${header.platform}'.`);
  const manifest = decodeMarker(issue.body);
  if (!manifest) return reject('issue', `Issue #${issueNumber} has no readable manifest marker.`);
  if (manifest.platform !== header.platform || manifest.batch_id !== header.batch) {
    return reject('issue', `The header and the manifest marker of issue #${issueNumber} disagree.`);
  }
  return { allowed: true, kind: '', reason: '', platform: header.platform, batch: header.batch, revision: header.revision };
}

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isDate(text) {
  const match = DATE.exec(String(text ?? ''));
  if (!match) return false;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return date.toISOString().slice(0, 10) === text;
}

/** A relative path inside the repository, with no traversal, spaces, or shell-unsafe characters. */
export function isRepoPath(text) {
  const value = String(text ?? '');
  return /^[A-Za-z0-9._/-]+$/.test(value) && !value.startsWith('/') && !value.split('/').includes('..');
}

const singleLine = (value) => !/[\r\n]/.test(String(value ?? ''));

/**
 * The agent prompt (`generate [start YYYY-MM-DD] [profile <path>]` or `adjust <issue> [profile <path>]`) and the
 * per-run instructions (non-interactive run, label, optional Drive root, then the caller's own instructions).
 */
export function buildPrompt({ mode, platform, start = '', profile = '', issue = '', label = '', driveRoot = '', instructions = '' }) {
  const errors = [];
  if (!['generate', 'adjust'].includes(mode)) errors.push(`Unknown mode '${mode}'. Use generate or adjust.`);
  if (!PLATFORMS.includes(platform)) errors.push(`Unknown platform '${platform}'.`);
  if (start && !isDate(start)) errors.push(`start must be a YYYY-MM-DD date, got '${start}'.`);
  if (profile && !isRepoPath(profile)) errors.push(`profile must be a relative path inside the repository, got '${profile}'.`);
  if (mode === 'adjust' && !/^[1-9][0-9]*$/.test(String(issue))) errors.push(`adjust needs an issue number, got '${issue}'.`);
  if (!label || !singleLine(label) || label.length > 50) errors.push('label must be a single line of at most 50 characters.');
  if (!singleLine(driveRoot) || driveRoot.length > 200 || /["`$\\]/.test(driveRoot)) errors.push('drive-root must be a single line of at most 200 characters without quotes, backticks, $, or backslashes.');
  if (errors.length) return { errors };

  const words = mode === 'generate' ? ['generate'] : ['adjust', String(issue)];
  if (mode === 'generate' && start) words.push('start', start);
  if (profile) words.push('profile', profile);
  const lines = [
    'Run: non-interactive (GitHub Actions); never wait for input. Stop and report what is missing instead of asking.',
    `Platform: ${PLATFORM_NAMES[platform]} only.`,
    `Review issue label: ${label} (create it when it does not exist).`
  ];
  if (driveRoot) lines.push(`Drive root: ${driveRoot} (pass --root "${driveRoot}" to review-batch.mjs upload).`);
  const extra = String(instructions ?? '').trim();
  if (extra) lines.push('', extra);
  return { errors, prompt: words.join(' '), instructions: lines.join('\n') };
}

export const isDone = (manifest, id) => DONE_STATUSES.includes(manifest?.state?.[id]?.status);

/** Approved for the revision the issue shows, with at least one item left to publish. */
export function isPublishable(manifest, header) {
  if (!manifest || manifest.approval?.status !== 'approved') return false;
  const revision = manifest.review?.revision ?? 1;
  if ((manifest.approval.revision ?? 1) !== revision) return false;
  if (header && header.revision !== revision) return false;
  return (manifest.items ?? []).some((item) => !isDone(manifest, item.id));
}

/** Open, labeled review issues of one platform whose approved batch still has items to publish, oldest first. */
export function pendingIssues(issues, { platform, label }) {
  return issues
    .filter((issue) => !issue.pull_request && issue.state === 'open' && hasLabel(issue, label))
    .filter((issue) => {
      const header = parseHeader(issue.body);
      if (header?.platform !== platform) return false;
      const manifest = decodeMarker(issue.body);
      return manifest?.platform === platform && manifest.batch_id === header.batch && isPublishable(manifest, header);
    })
    .map((issue) => issue.number)
    .sort((a, b) => a - b);
}

const NOTE_LINES = /^(nothing due|publishing limit reached|daily upload limit reached|quota exceeded)\b.*$/gim;
const cell = (text, max = 160) => {
  const line = String(text ?? '').replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

/** Item ids a publisher log reports with a prefix such as `stale:` or `needs a manual check:`. */
export function loggedIds(log, prefix) {
  const ids = new Set();
  for (const line of String(log ?? '').split(/\r?\n/)) {
    if (line.startsWith(prefix)) {
      const id = line.slice(prefix.length).trim().split(/\s+/)[0];
      if (id) ids.add(id);
    }
  }
  return ids;
}

/**
 * The outcome of one publisher run: every item's status (from the manifest state, or `stale` when the log reported
 * it), whether the batch is complete (every item scheduled, published, skipped, or stale), whether the state changed,
 * and the issue comment that reports it.
 */
export function summarize({ manifest, before = null, log = '', outcome = 'success', runUrl = '' }) {
  const stale = loggedIds(log, 'stale:');
  const manual = loggedIds(log, 'needs a manual check:');
  const items = (manifest?.items ?? []).map((item) => {
    const state = manifest.state?.[item.id] ?? {};
    const status = state.status ?? (stale.has(item.id) ? 'stale' : 'pending');
    return { id: item.id, type: item.type, status, url: state.url ?? '', remote: state.remote_id ?? '', error: state.error ?? '', when: state.publish_at ?? item.publish_at ?? item.date ?? '' };
  });
  const complete = items.length > 0 && items.every((item) => DONE_STATUSES.includes(item.status) || item.status === 'stale');
  // Attempts and timestamps change on every retry; only status, result, and error count as a change.
  const signature = (data) => JSON.stringify(Object.entries(data?.state ?? {}).sort(([a], [b]) => a.localeCompare(b)).map(([id, entry]) => [id, entry?.status ?? null, entry?.remote_id ?? null, entry?.error ?? null]));
  const changed = signature(manifest) !== signature(before);
  const notes = [...new Set([...String(log ?? '').matchAll(NOTE_LINES)].map((match) => match[0].trim()))];
  const platform = PLATFORM_NAMES[manifest?.platform] ?? manifest?.platform ?? 'Social';

  const lines = [`### ${platform} publishing${outcome === 'success' ? '' : ' failed'}`, ''];
  lines.push('| Item | Type | Status | When | Link | Detail |', '|---|---|---|---|---|---|');
  for (const item of items) {
    const link = item.url ? `[open](${item.url})` : cell(item.remote);
    const detail = manual.has(item.id) ? 'needs a manual check before a retry' : item.status === 'stale' ? 'publish time passed; move it to a new batch' : cell(item.error);
    lines.push(`| \`${cell(item.id)}\` | ${cell(item.type)} | ${item.status} | ${cell(item.when)} | ${link} | ${detail} |`);
  }
  if (notes.length) lines.push('', ...notes.map((note) => `- ${cell(note, 200)}`));
  lines.push('');
  if (complete) lines.push('Every item is scheduled, published, or stale, so this issue is closed.');
  else if (outcome !== 'success') {
    lines.push(manifest?.platform === 'instagram'
      ? 'The publisher stopped with an error; the state of finished items is saved in the issue body. The next scheduled run retries failed items.'
      : 'The publisher stopped with an error; the state of finished items is saved in the issue body. Retry failed items with a manual run of the publish workflow for this issue, or comment the approve command again.');
  }
  if (manual.size) lines.push(`Check ${[...manual].map((id) => `\`${cell(id)}\``).join(', ')} on the platform before retrying, since the last call got no response.`);
  if (runUrl) lines.push('', `[Workflow run](${runUrl})`);
  return { items, complete, changed, stale: [...stale], manual: [...manual], body: `${lines.join('\n').trim()}\n` };
}

const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * Decides how a publisher run writes its manifest back when the issue body may have changed since the run started
 * (`before` is the manifest restored at the start, `live` the one in the body now). Same batch and revision: keep the
 * live manifest and take, per item id, only the state entries this run changed, so a concurrent run's results
 * survive; the approval comes from this run when it stamped one. A different batch or revision (an adjust ran, or the
 * body lost its marker): `conflict`, and nothing is written.
 */
export function mergeState({ ours, before, live }) {
  if (!live) return { action: 'conflict', reason: 'the issue body has no readable manifest marker anymore' };
  const revision = (manifest) => manifest?.review?.revision ?? 1;
  if (live.platform !== ours.platform || live.batch_id !== ours.batch_id) {
    return { action: 'conflict', reason: `the issue now holds batch ${live.batch_id}, not ${ours.batch_id}` };
  }
  if (revision(live) !== revision(ours) || revision(live) !== revision(before)) {
    return { action: 'conflict', reason: `the batch moved to revision ${revision(live)} while this run published revision ${revision(ours)}` };
  }
  const ids = new Set((live.items ?? []).map((item) => item.id));
  const state = { ...(live.state ?? {}) };
  const changed = [];
  for (const [id, entry] of Object.entries(ours.state ?? {})) {
    if (!ids.has(id) || same(entry, before?.state?.[id])) continue;
    state[id] = entry;
    changed.push(id);
  }
  const approval = ours.approval?.status === 'approved' && live.approval?.status !== 'approved' ? ours.approval : live.approval;
  const merged = { ...live, state, approval };
  return { action: same(merged, live) ? 'unchanged' : 'write', manifest: merged, changed };
}
