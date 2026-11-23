# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). Release headings use the `## vMAJOR.MINOR.PATCH` form;
merging a pull request that adds one tags the release and moves the major tag.

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
