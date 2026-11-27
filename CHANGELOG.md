# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). Release headings use the `## vMAJOR.MINOR.PATCH` form;
merging a pull request that adds one tags the release and moves the major tag.

## v1.14.0

Release order: `fbrissi/ai-skills` `v0.11.0` first, then this release.

- **Merge gate counts only the newest run of each check** (`pr-gate` `merge-gate`, used by `merge-decision.yml`):
  `check-runs?filter=latest` is per check suite and each workflow run has its own suite, so a cancelled run that a
  newer run of the same workflow replaced still blocked the merge (`checks not successful ... (cancelled)`). Check runs
  are now grouped by App, workflow file (from the run that owns the suite), and name, and only the newest (latest
  `started_at`, then highest id) is judged; same-named jobs of different workflows stay separate.
- **Unresolved review threads no longer stall a merge silently:** when they are the only gate left and no
  `fix-workflow` run is queued, `merge-gate` sets the new `handoff` output and `merge-decision.yml` runs **Hand Off
  Unresolved Threads**, one `merge-decision` handoff to the requester (`<!-- merge-decision unresolved-threads -->`,
  not repeated while it is open). New `merge-decision.yml` and `pr-gate` input `fix-workflow` (default `pr-fix.yml` in
  the workflow); while a run of it is queued, the pull request could get a pass (new inputs `fix-opt-in-label`,
  `fix-branch-prefixes`, `fix-max-rounds`, `fix-escalation-label`, `fix-ignore-authors`, set like the PR Fix and PR
  Feedback Dispatch callers), and it has review feedback newer than its last fix round, the decision only skips, since
  that pass dispatches it again.
- **Clean grades never dispatch PR Fix** (`pr-gate` `feedback-dispatch`, used by `pr-feedback-dispatch.yml`): a
  `commented` review that is only a clean `★★★★★` grade with no inline comments now always goes to `merge-workflow`,
  even with unresolved threads (the merge gate hands those off). Before, two clean reviews of one head with a thread
  still open dispatched two fix passes at the same moment.
- **Release Note `exempt-paths`** (`release-note.yml`, default empty, so nothing changes until set): a pull request
  that only changes matching paths, for example `*.md docs/* .ai/* .github/*` (documentation, agent configuration,
  CI), and adds no release heading passes with an empty `version`. A file renamed out of a non-exempt path is not
  exempt. Covered by the new `tests/release-note.test.mjs`, which runs the workflow's inline script in scratch
  repositories (CI runs `node --test actions/*/*.test.mjs tests/*.test.mjs`).
- **`ai-skills-ref` default `v0.11.0`** everywhere skills are loaded: `ai-task.yml` and the `ai-task` action (from
  `v0.10.1`), `merge-decision.yml` (from `v0.9.0`), `pr-fix.yml` (from `v0.4.0`), `code-review.yml` (from `v0.2.0`),
  and the `ai-harness` action's `skills-ref` (from `v0.2.0`). Every stage opens the issue's images itself, and the
  milestone pull request is marked ready only with its required checks green. Pin the old ref to keep the old behavior.
  Callers of `pr-fix.yml` (`v0.4.0` -> `v0.11.0`) will notice that the `pr-fix` skill:
  - resolves a review thread that a bot (or its own review) started once its pushed commit fixes the finding; threads
    people started stay open for them;
  - downloads and opens images the feedback points at (ticket attachments, inline images, private GitHub
    `user-attachments` with the job's token) and says so when one cannot be downloaded;
  - runs in `auto` mode when the run is non-interactive (`CI` or `GITHUB_ACTIONS` set), and posts a blocker comment
    on the pull request where it used to ask (for example uncommitted changes).

  Callers of `code-review.yml` (`v0.2.0` -> `v0.11.0`) will notice that the `review-changes` skill:
  - resolves its own earlier threads whose finding the current head fixes (people's threads stay open);
  - reviews large pull requests across several passes: a partial pass publishes a `COMMENT` review with `Covered:` and
    `Not covered:` lines and never approves, even at 5 stars; the review body gains a `Coverage:` line, and approval
    comes once the passes together cover every changed file;
  - adds a security and privacy pass when a change touches authentication, sessions, tokens, permissions, tenancy,
    personal data, secrets, storage, or retention, so such changes can get new findings;
  - downloads and opens the ticket's attachments and inline images instead of skipping them, and compares the change
    against them.

## v1.13.1

Release order: `fbrissi/ai-skills` `v0.10.1` first, then this release.

- **AI Task `ai-skills-ref` default `v0.10.0` -> `v0.10.1`** (the `ai-task.yml` workflow and the `ai-task` action):
  orchestration now checks that the milestone pull request merges cleanly before marking it ready, and leaves a
  conflicting one in draft with a blocker that names the files.

## v1.13.0

Release order: `fbrissi/ai-skills` `v0.10.0` first (its `dependency-updates` and `issue-resolver` open a release when
a bugfix has none), then this release.

- **AI Task `ai-skills-ref` default `v0.9.0` -> `v0.10.0`** (the `ai-task.yml` workflow and the `ai-task` action). The `dependency-update` prompt rule no longer tells the
  agent to wait when there is no release branch: it opens one as the skill says (a milestone named after the next
  version, its release branch from the base branch, and a tracking issue the bugfix pull request closes), and waits
  only when the release branch cannot be created. `issue-resolve` does the same through its agent.
- **Docs:** the orchestrate-on-merge caller example also re-runs the orchestrator for `bugfix/*` pull requests merged
  into `release/*` (a release opened for a bugfix has no other work; the milestone comes from the pull request), and
  the branch model, `issue-resolve`, and `dependency-update` sections describe the new rule. Callers that copied the
  example should add the `bugfix/` head prefix.

## v1.12.0

Release order: `fbrissi/ai-skills` `v0.9.0` first (its `merge-risk` prints the `merge-risk-result:` line this release
reads), then this release.

- **setup-gh:** new composite action that makes `gh` available on any Linux runner. It keeps an installed `gh` (at
  least `min-version` when set, compared part by part), otherwise downloads the pinned official release (2.103.3) for `linux_amd64` or
  `linux_arm64` into `RUNNER_TEMP`, checks its SHA-256, and adds it to the `PATH`, without root. `ai-harness` runs it
  whenever it gets a `github-token`, so agents and skills in `ai-task`, `pr-fix.yml`, `merge-decision.yml`, and
  `code-review.yml` always have `gh` (before, a self-hosted runner without it made the merge decision hold with
  `gh: command not found`). `ai-task.yml` and `pr-fix.yml` run it before their own `gh` steps, and `code-review.yml`
  with `min-version: 2.48.0` for `gh api --slurp`. `release.yml` is unchanged: it would need this release's tag to
  exist before it runs.
- **Merge Decision:** a tooling failure is no longer a permanent HOLD. The new `pr-gate` `merge-outcome` command reads
  the skill's `merge-risk-result: merged | held | not-evaluated` line (older skills: the `PR #<n>: MERGE / HOLD`
  line). Only `merged` or `held` records the `<!-- merge-decision head=<sha> -->` marker; `not-evaluated`, or a failed
  harness without a result, posts a `merge-decision` handoff that mentions the requester with the run link and
  leaves the head undecided. The prompt states that per-run `instructions` (for example from `/ai-resume
  merge-decision <text>`) can only make the decision stricter: never a higher max risk, more base branches, fewer
  approvals, fewer hold labels, or auto-merge.
- **Merge Decision `ai-skills-ref` default `v0.4.0` -> `v0.9.0`.** Callers that keep the default get these
  `merge-risk` changes:
  - Base branches are a list of names or patterns (`release/*`, `release/`) instead of one base branch.
  - The profile may set `Max risk to merge` and `Required human approvals` per base pattern; the first matching row
    wins over the general values.
  - With `Required human approvals: 0` (or the workflow passing 0 for exempt bases and authors), an empty
    `reviewDecision` passes; only `CHANGES_REQUESTED`, or `REVIEW_REQUIRED` from branch protection, holds. Otherwise
    it counts human approvals on the head commit from the reviews, never `reviewDecision` alone.
  - A tooling failure is `NOT EVALUATED` (no HOLD posted), and the output ends with `merge-risk-result:`.
  Pin `ai-skills-ref: v0.4.0` to keep the old behavior (and the old HOLD on tooling failures).
- **AI Delivery:** `merge-decision` is a stage: handoffs and `/ai-resume merge-decision` dispatch `merge-decision.yml`
  with `pr_number`. The resume first posts `<!-- merge-decision redecide -->`; `merge-gate` then allows one new
  decision on a head that already has a decision marker older than that comment (the new record is newer, so it is
  bounded; only bot comments count).
- **AI Task:** `ai-skills-ref` defaults to `v0.9.0` (release notes merge the base branch and pick a version above
  existing tags; bugfix branches start from their release branch).

## v1.11.0

Release order: `fbrissi/ai-skills` `v0.8.1` first, then this release.

- **Portable heredoc delimiters:** `pr-fix.yml`, `merge-decision.yml`, `code-review.yml`, and `release.yml` built
  their `GITHUB_OUTPUT` delimiters with `uuidgen`, which self-hosted runners without util-linux lack (`uuidgen: command
  not found` failed the step). They now read 16 random bytes with `od` from `/dev/urandom`.
- **PR Fix:** a failed pass posts a `pr-fix` handoff on the pull request (marker `<!-- pr-fix failed -->`) that
  mentions the requester and links the run, instead of only failing the check run. New input `merge-workflow`
  (default empty): after a successful pass, it is dispatched with `pr_number` once the check run is complete, so a
  merge decision skipped with `checks still running: PR Fix` is decided again. It needs `Actions: Read and write` on
  the fixer App; one dispatch per pass, so `max-rounds` bounds it. Both run in a new **Follow Up PR Fix** job that uses
  `environment` (for the App key) and mints only what its path needs; **Finish PR Fix** stays without an environment,
  so environment protection never holds the check run open.
- **AI Delivery:** `handoff` supersedes an open handoff of the same stage that has other markers (state
  `superseded`) instead of skipping, so a max-rounds escalation after a failed-pass handoff is still posted with its
  `<!-- pr-fix escalated -->` marker. An open handoff with the same markers is still not repeated.
- **pr-gate:** new `merge-dispatch` command, and `feedback-dispatch`, which holds the routing of PR Feedback Dispatch
  (moved from an inline script, now covered by tests).
- **PR Feedback Dispatch:** a `commented` review that is only a clean `★★★★★` grade (plus `Ticket:` lines), with no
  inline comments and no unresolved thread on the pull request, dispatches `merge-workflow` instead of
  `fix-workflow`. A reviewer that cannot approve its own pull request leaves its approval that way, and the fix pass
  it used to start had nothing to do. Such a review now gets no PR Fix pass: with failing CI, the pull request waits
  like an approved one (the merge gate skips it) until CI or a new review changes. Merge gates and human approval
  rules are unchanged.
- **AI Task:** `app-token-permission-issue-fields` reaches create-github-app-token through the step environment
  (`INPUT_PERMISSION-ISSUE-FIELDS`, which the action reads for every permission) instead of an undeclared input, so
  the runner no longer warns `Unexpected input(s) 'permission-issue-fields'`. `ai-skills-ref` defaults to `v0.8.1`,
  whose refinement skills fill empty Start and Target dates.

## v1.10.0

- **AI Task:** new `dependency-update` task, run by the ai-skills `dependency-updater` agent with the
  `dependency-updates` skill (plus `developer`, `code-reviewer`, and `qa-tester`). It takes the open dependency-bot
  pull requests (and outdated packages when the profile asks), reads release notes and upgrade guides,
  adapts the code, runs the checks and the review and QA cycle, and opens or updates pull requests that supersede the
  bot pull requests, branched like `issue-resolve`: updates that fix a high or critical advisory go to a `hotfix/`
  pull request into the base branch, the rest to a `bugfix/` pull request into the open release branch (or wait for a
  later run when there is none), then stops; the PR Feedback Loop takes over. It needs no `issue` or `milestone`, reads
  `docs/ai/dependency-updates.md` by default, gets `contents` and `pull-requests` write on the App token, and is told
  about the `setup-command` test environment like `implement`. Default caller `ai-dependency-update.yml` (dispatch
  input `requested_by`); `/ai-resume dependency-update` (or `dependency-updater`) resumes it, and the follow-up hands
  off a failed run on a tracking issue.
- **AI Task:** Jira and Sentry credentials reach only the tasks that use them: Jira the delivery and issue tasks,
  Sentry only `issue-intake` and `issue-resolve` (the `ai-task.yml` workflow and the action both filter them), and
  `dependency-update` gets neither, since it installs and runs new third-party package versions. Before, every task
  had them in its environment. The `dependency-update` prompt reuses an earlier pull request only when it is from this
  repository, authored by the run's own App, on a branch with the template's prefix, installs with lifecycle scripts
  off where possible, and never closes, merges, approves, comments on, or pushes to the bot pull requests.
- **Repository:** `.github/workflows/ai-dependency-update.yml` runs the `dependency-update` task on this repository every Tuesday 06:00 UTC (after Dependabot's weekly run) and on demand, with the profile `docs/ai/dependency-updates.md` (`Bugfix release branch: base`: no release branches here, so every update goes to `main`); it is skipped while the `AGENT_APP_CLIENT_ID` variable is empty (a missing private key fails the run), passes only the agent App key and harness keys, and stops at the PR. New `AGENTS.md` (with `CLAUDE.md`) with the commands and rules agents need.
- **AI Task:** `ai-skills-ref` defaults to `v0.8.0`, the ai-skills release with the `dependency-updater` agent.

## v1.9.0

- **AI Task:** the `implement` and `issue-resolve` prompts say when the test environment is already running. The
  workflow passes its `setup-command` to the `ai-task` action as the new `test-environment` input; before, the prompt
  only described the no-environment case, and the agent reported `browser QA skipped: no CI environment` with the
  stack up. Both prompts also ask for the reviewer and QA on every change, documentation-only ones included.
- **AI Task follow-up:** mirrors each issue's final status label on the GitHub Project status field when `project`
  is set, so label moves made by the follow-up (an implement issue back to `ready`) or by an agent that skipped the
  Project show on the board. The field and option map come from the inputs or, when empty, from the delivery
  profile's `Project status field` and `Project status options` lines. The follow-up token gets
  `organization-projects: write` with `project`. New `project`, `project-status-field`, `project-status-options`, and
  `profile` inputs on the `ai-delivery` action. Problems are warnings.

## v1.8.1

- **AI Task:** new `max-send-backs` input (default `3`). The follow-up may send a milestone's issues back to an
  earlier refinement stage (for example readiness review back to technical refinement) only that many times in the
  whole milestone; after that it hands off to the requester to investigate. Counted as `send-backs=N` in the
  dispatch marker; a resume resets it. Also on the `ai-delivery` action.
- **AI Task:** new `app-token-permission-issue-fields` input. Set it to `write` so refinement can set organization
  issue fields (Priority, Effort, Start date, Target date); the narrowed token did not include that permission, so
  readiness review kept sending issues back. The README no longer says `issues: write` is enough.

## v1.8.0

### Added

- `ai-task` action: runs one AI task delivery task (`business-refinement`, `technical-refinement`, `readiness-review`,
  `orchestrate`, or `implement`) with its fbrissi/ai-skills agent. It validates the task and the inputs it requires,
  installs the task's agents and skills (default `ai-skills-ref` `v0.6.0`) plus any extra `skills` and `agents`,
  passes every non-empty parameter explicitly in a non-interactive prompt so the repository profile fills the rest,
  and exports masked Jira credentials only to the harness step. It runs `ai-harness@v1`.
- `ai-task.yml` reusable workflow: creates a GitHub App token scoped per task (`actions: write` only for
  `orchestrate`, `contents` and `pull-requests` write only for `orchestrate` and `implement`,
  `organization-projects: write` only with `project`), checks out with full history and push credentials, commits as
  the App bot, installs dependencies, and runs `ai-task`. Runs are serialized per task and issue, milestone, or source.
- Delivery chaining in `ai-task.yml`: a `follow-up` job with a fresh App token (`actions: write`) reads the issues'
  `status:*` labels after each run and dispatches the next stage (business refinement -> technical refinement ->
  readiness review -> orchestrate) or hands off to a human. Failed, timed-out, or cancelled runs hand off with the run
  link and move an issue stuck in `status:in-progress` back to `status:ready`. New inputs `chain` (default `true`),
  `stage-workflows` (`stage=file` overrides), and `max-auto-dispatches` (loop guard, default `3`); new output
  `milestone`.
- `requested-by` input on `ai-task.yml` and the `ai-task` action (default `github.triggering_actor`, bots ignored):
  the agent and every handoff mention that person, it is stored in the milestone description as
  `<!-- ai-delivery requested-by=<login> -->`, and every chained dispatch passes it on as `requested_by`.
- Handoff comments: mention the requester, explain the blocker, link the questions, and end with
  ``Reply `/ai-resume` (optionally with instructions on the next lines) to continue: <stage> -> <next stage>.``, a
  `<!-- ai-resume ... state=open -->` marker, and a `gh workflow run` fallback.
- `ai-resume.yml` reusable workflow: on `issue_comment` `created`, a comment whose first line is
  `/ai-resume [stage] [instructions]` (the stage may also be a skill or agent alias such as `quality-cycle` or
  `issue-resolver`; by an `OWNER`, `MEMBER`, or `COLLABORATOR` with write, maintain, or admin
  permission; bots are ignored) resumes the named stage, else the newest open handoff of the agent App (or
  `trusted-bots`) on that issue or pull request. It reacts with `eyes`, marks the handoff `state=resumed` before
  dispatching (so a second command cannot run it twice; runs are serialized per issue or pull request), removes
  `ai:needs-human` for `pr-fix`, resets the loop guard, dispatches the stage with the command's `instructions`, then
  reacts with `rocket` and replies with the run link. Without an open handoff or a stage, or without permission, it
  replies with the reason and dispatches nothing. Handoffs with the earlier checkbox still resume.
- `ai-delivery` action: the deterministic `follow-up`, `handoff`, `resume`, and `request-review` steps, with tests.
- `setup-command` input on `ai-task.yml` to install browsers and start the test environment before the agent; the
  `implement` prompt falls back to tests-only QA (PR checks) when no environment is reachable and never escalates for
  that.
- `merge-decision.yml`: `human-approval-exempt-base-prefixes` and `human-approval-exempt-authors` (pull requests
  into a matching base branch, such as a `release/` branch, that are also authored by an exempt author need no human
  approval; the author list defaults to any GitHub App bot, so pull requests by people always need approval) and
  `request-human-review` (default `true`: while approvals are missing, request a review from the flow's requester
  and mention them once). The decision prompt now passes the base branch, the required approvals, and the approval
  rule: with 0 required approvals an empty `reviewDecision` passes and only `CHANGES_REQUESTED` (or
  `REVIEW_REQUIRED` from branch protection) fails; otherwise human approvals on the head commit are counted from the
  reviews, never from `reviewDecision` alone.
- `pr-gate` action: the deterministic `fix-gate`, `fix-record`, `fix-finish`, `merge-gate`, and `merge-record` steps
  of `pr-fix.yml` and `merge-decision.yml`, with tests, so wrappers that load secrets at run time get the same gates
  and markers.
- `pr-feedback-dispatch.yml`: `ignore-reply-authors` skips reply-only reviews (no body, every inline comment a reply)
  by those logins, for setups where one App both reviews and fixes.
- `ai-harness` action: `agents` and `agent` work with OpenCode too. OpenCode agents come from the new
  `opencode-agents-path` (default `plugins/ai-skills/opencode/agent`) or `opencode-agents-local-dir`, are installed
  into `~/.config/opencode/agents`, and the prompt runs with `opencode run --agent <agent>`. The action fails when the
  agent is missing, has `mode: subagent`, or is overridden by the checkout's `.opencode/agent(s)/`, because OpenCode
  would silently fall back to its default agent.
- `branch-sync.yml` reusable workflow: fast-forwards `target` (default `develop`) to `source` (default `main`), with an
  optional GitHub App so the update triggers the target's workflows. It never force-pushes: when the target has
  commits the source does not, it opens or comments on one issue that mentions the pusher and `mention`, and closes it
  after the next successful sync.
  Input `app-token-permission-workflows` (default empty) requests `Workflows` for commits that change
  `.github/workflows/**`; a refused update returns `blocked` and is reported in the sync issue.
- Issue tasks on `ai-task.yml` and the `ai-task` action, run by the `issue-resolver` agent of fbrissi/ai-skills:
  `issue-intake` (reads a source such as Sentry with the `sentry-issues` skill and creates or updates GitHub issues
  labeled `ai:resolve`) and `issue-resolve` (`issue` required: branch, change, quality cycle, pull request, then
  stop; the PR Feedback Loop follows up). New optional `SENTRY_AUTH_TOKEN` secret and `sentry-org` and
  `sentry-base-url` inputs (variables `SENTRY_ORG` and `SENTRY_BASE_URL`); `issue-resolve` gets `contents` and
  `pull-requests` write. A failed run hands off with an `issue-intake` or `issue-resolve` resume (default callers
  `ai-issue-intake.yml` and `ai-issue-resolve.yml`).
- `instructions` input for per-run instructions, appended to the prompt as `Additional instructions for this run:`
  on `ai-task.yml` and the `ai-task` action (`context` stays as a deprecated alias), `pr-fix.yml` and
  `merge-decision.yml` (`prompt-append` stays as a deprecated alias), `code-review.yml` (both harnesses, including
  the OpenCode command form), and the `ai-harness` action. Chained dispatches never pass it on.
- `pr-feedback-dispatch.yml` reusable workflow: on `pull_request_review` and `check_run` events, dispatches the fix
  workflow for `changes_requested` or commented reviews (except from `ignore-authors`) and the merge decision workflow
  for approvals or a successful `merge-check-name` check run, always on the default branch and never for forks.
- `pr-fix.yml` reusable workflow: one AI pass of the `pr-fix` skill on an opted-in (`opt-in-label` or
  `branch-prefixes`) same-repository pull request, pushed with a GitHub App token so CI runs again. Deterministic
  gates skip drafts, forks, and repeated passes on the same head without new feedback; after `max-rounds` it adds
  `escalation-label` and stops. Reports a `PR Fix` check run.
- `merge-decision.yml` reusable workflow: deterministic merge gates (state, `branch-prefixes`, hold labels, conflicts, checks, human
  approvals on the head commit, unresolved threads, one decision per head commit), then the `merge-risk` skill in
  decide mode on the base branch checkout. Holds unless `auto-merge` is on; merges with the App token.

### Changed

- The README examples follow the branch model `feature/*` (into a `release/*`), `release/*` (the milestone branch,
  into `main`), `hotfix/*` (into `main`), and `bugfix/*` (into the open `release/*`), with `main` as the default
  branch: `branch-prefixes: feature/ release/ hotfix/ bugfix/`, `human-approval-exempt-base-prefixes: release/`, and an
  orchestrate-on-merge caller for `feature/*` into `release/*` and `release/*` into `main`. Prefix inputs are free
  lists, so callers can keep older prefixes such as `feat/` while those branches are open.
- The default harness is now `claude` everywhere: `code-review.yml`, `pr-fix.yml`, `merge-decision.yml`, `ai-task.yml`, and the `ai-harness` and `ai-task` actions use Claude Code when the input and `AI_HARNESS` are empty. Set `AI_HARNESS=opencode` to keep OpenCode.
- `ai-task` action and `ai-task.yml` run with `opencode` or `claude`, resolved like every AI workflow: the input, then
  the `AI_HARNESS` variable, then `claude` (and `OPENCODE_MODEL`, `OPENCODE_VARIANT`, `CLAUDE_MODEL`,
  `CLAUDE_EFFORT` the same way). `opencode` requires `opencode-model` in `provider/model` form, plus `openai-api-key`
  for an `openai/` model; `claude` requires `anthropic-api-key` or `claude-code-oauth-token`. New `harness` output.
- `pr-fix.yml` and `merge-decision.yml`: `agents` installs the OpenCode agents of the same names with `opencode`.
- `pr-fix.yml` and `merge-decision.yml` run their gates and markers through `pr-gate` instead of inline scripts; the
  behavior is unchanged.
- `pr-fix.yml` escalation posts a handoff that mentions the requester and offers a `pr-fix` resume instead of only
  asking to remove the label.
- README: setup from zero (App permissions, secrets, variables, labels, project status options, release order), how
  stages chain, resume, QA in CI, stage callers with their dispatch inputs, and PR follow-up for task branches. Issue
  field values only need `issues: write`.
- Documentation: Mermaid diagrams of how the workflows and actions fit together, the PR feedback loop, merge
  decision gates, stage chaining and the follow-up job, resume, issue intake and resolve, and branch sync.

## v1.6.1

### Fixed

- `ai-harness` action: the checkout agent guard also matches the `name:` frontmatter of every `.claude/agents/**/*.md`
  file, because Claude Code identifies agents by that name, not by file name. A checkout file such as
  `.claude/agents/x.md` with `name: nfse-compliance` no longer overrides the installed agent silently.

## v1.6.0

### Added

- `ai-harness` action: `agents`, `agents-path`, and `agents-local-dir` inputs install Claude Code agents (default
  `plugins/ai-skills/agents` from the pinned `skills-repository`) into `~/.claude/agents`, and the `agent` input runs
  the prompt with that agent as the main agent (`claude --agent`), so orchestrator agents can delegate to worker
  agents. Both are Claude-only and fail early with `opencode`. The action also fails when the checkout defines a
  same-named `.claude/agents/<agent>.md` (Claude Code would prefer it) or when `agent` is not installed.

## v1.5.1

### Fixed

- `terraform-permissions` action: quote the `change-pattern` description, whose `mode: auto` text made `action.yml` invalid YAML so every caller failed to load the action.
- `Quality / node-tests` now parses every `actions/*/action.yml`, because actionlint does not check composite action metadata.

## v1.5.0

### Added

- `terraform-permissions.yml` reusable workflow and `terraform-permissions` composite action. They check a repository's Cloudflare permission manifest against its Terraform files and against the real Terraform token, so a missing token permission fails before merge instead of in the HCP Terraform apply.
- `Quality / node-tests` job that runs the action scripts' Node tests.

## v1.4.0

### Changed

- Pin the shared skills to fbrissi/ai-skills `v0.2.0`: the `ai-harness` action's `skills-ref` and `code-review.yml`'s `ai-skills-ref` defaults move from `v0.1.0`, so the review-changes skill resolves linked tickets from any supported provider.

## v1.3.0

### Added

- `code-review.yml` input `save-dependency-cache` (default `false`) to opt back into saving the dependency cache from a review.

### Security

- `code-review.yml` only restores the dependency cache by default and no longer saves it after installing a pull request's dependencies, whose install scripts could otherwise poison the cache that later reviews restore. `node-cache` now applies only with `save-dependency-cache`, because actions/setup-node also saves its cache. Warm the cache from the default branch instead.

## v1.2.1

### Fixed

- Document that callers outside the `fbrissi` account must pass secrets explicitly: `secrets: inherit` does not cross owners, so organization secrets would arrive empty.

## v1.2.0

### Added

- `code-review.yml` accepts the review GitHub App's client ID through the `agent-client-id` input or the `AGENT_APP_CLIENT_ID` variable.

### Changed

- `code-review.yml` scopes the review App token to `contents: read`, `issues: read`, and `pull-requests: write`, so the harness never receives the App's other permissions.

### Deprecated

- The `agent-app-id` input and the `AGENT_APP_ID` variable. They still work when no client ID is set.

## v1.1.0

### Added

- Reusable workflows fall back to the calling repository's configuration variables when an input is empty: `CI_RUNNER` for `runs-on` in every workflow, and `AI_HARNESS`, `OPENCODE_MODEL`, `OPENCODE_VARIANT`, `CLAUDE_MODEL`, `CLAUDE_EFFORT`, and `AGENT_APP_ID` in `code-review.yml`. The review job resolves them inside its `environment`, so environment-level variables work too.

### Changed

- `code-review.yml` no longer requires the `agent-app-id` input when the `AGENT_APP_ID` variable is set.

## v1.0.0

### Added

- `code-review.yml` reusable workflow: reviews a pull request with an AI harness and reports a `Code Review` check run on the PR head commit. Supports OpenCode (Kompass `pr/review` by default) and Claude Code with the `review-changes` skill from a pinned `fbrissi/ai-skills` tag or from the PR base commit, publishes the review through a GitHub App, and verifies that a review was published for the head commit.
- `release-note.yml` reusable workflow: requires a pull request to add exactly one `## vX.Y.Z` heading as the first changelog release, with notes and no existing tag, optionally matching `package.json`.
- `release.yml` reusable workflow: releases the first changelog version of a merged pull request (or a given version), idempotently creates the tag and the GitHub release, optionally waits for the HCP Terraform apply of the commit, dispatches a deploy workflow on the tag, and moves the major tag.
- `ai-harness` action: installs pinned OpenCode 1.19.5 (SHA-256 verified) or Claude Code 2.1.319, installs skills from a pinned repository ref or a local directory, and runs one non-interactive prompt.
- `terraform-cloud-wait` action: waits for the newest HCP Terraform run of a commit to apply.
- Repository quality checks (actionlint, shellcheck, release note), AI code review of its own pull requests, and release orchestration for this repository.
