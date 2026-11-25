# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). Release headings use the `## vMAJOR.MINOR.PATCH` form;
merging a pull request that adds one tags the release and moves the major tag.

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
- Handoff comments: mention the requester, explain the blocker, link the questions, and offer a
  `- [ ] Resume: <stage>` checkbox plus a `gh workflow run` fallback.
- `ai-resume.yml` reusable workflow: on `issue_comment` `edited`, resumes the stage of a handoff whose box a person
  with write permission just checked, removes `ai:needs-human` for `pr-fix`, resets the loop guard, and replaces the
  box with a link to the dispatched run.
- `ai-delivery` action: the deterministic `follow-up`, `handoff`, `resume`, and `request-review` steps, with tests.
- `setup-command` input on `ai-task.yml` to install browsers and start the test environment before the agent; the
  `implement` prompt falls back to tests-only QA (PR checks) when no environment is reachable and never escalates for
  that.
- `merge-decision.yml`: `human-approval-exempt-base-prefixes` (pull requests into matching base branches, such as
  milestone branches, need no human approval) and `request-human-review` (default `true`: while approvals are
  missing, request a review from the flow's requester and mention them once).
- `pr-gate` action: the deterministic `fix-gate`, `fix-record`, `fix-finish`, `merge-gate`, and `merge-record` steps
  of `pr-fix.yml` and `merge-decision.yml`, with tests, so wrappers that load secrets at run time get the same gates
  and markers.
- `pr-feedback-dispatch.yml`: `ignore-reply-authors` skips reply-only reviews (no body, every inline comment a reply)
  by those logins, for setups where one App both reviews and fixes.

### Changed

- `pr-fix.yml` and `merge-decision.yml` run their gates and markers through `pr-gate` instead of inline scripts; the
  behavior is unchanged.
- `pr-fix.yml` escalation posts a handoff that mentions the requester and offers a `pr-fix` resume instead of only
  asking to remove the label.
- README: setup from zero (App permissions, secrets, variables, labels, project status options, release order), how
  stages chain, resume, QA in CI, stage callers with their dispatch inputs, and PR follow-up for task branches. Issue
  field values only need `issues: write`.

## v1.7.0

### Added

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
