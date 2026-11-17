# github-actions

Reusable GitHub Actions workflows and composite actions for my personal projects: AI code review with a
switchable harness (OpenCode or Claude Code), changelog-driven releases, and HCP Terraform helpers.

Everything here is generic enough to be shared across repositories. Project-specific logic (build matrices,
deploys, credential rotation) stays in each project.

## Catalog

| Component | Type | Purpose |
|---|---|---|
| [`code-review.yml`](#code-review) | Reusable workflow | AI review of a pull request, reported as a `Code Review` check run. |
| [`release-note.yml`](#release-note) | Reusable workflow | Requires each pull request to add one changelog release. |
| [`release.yml`](#release) | Reusable workflow | Tags and publishes the changelog release, then optionally deploys it. |
| [`ai-harness`](actions/ai-harness/README.md) | Composite action | Installs OpenCode or Claude Code (pinned) and runs one prompt. |
| [`terraform-cloud-wait`](actions/terraform-cloud-wait/README.md) | Composite action | Waits for the HCP Terraform apply of a commit. |

## Versioning

Releases follow [Semantic Versioning](https://semver.org/) and are cut from [CHANGELOG.md](CHANGELOG.md): every
pull request adds a `## vX.Y.Z` heading, and merging it creates the `vX.Y.Z` tag and GitHub release and moves the
major tag (`v1`) to it.

- `@v1` follows every compatible release. This is what the examples use.
- `@v1.2.3` or a full commit SHA freezes the version; Dependabot (`github-actions` ecosystem) can bump it.

Breaking input, secret, or behavior changes only ship in a new major version. The reusable workflows call this
repository's own actions at the same major tag (`@v1`).

## Code Review

`.github/workflows/code-review.yml` reviews one pull request with an AI harness and publishes the review through a
GitHub App:

1. **Start Code Review** creates (or reuses) a check run on the PR head commit and marks it in progress. Draft and
   closed PRs fail here.
2. **Run Code Review** checks out the PR head with the base branch fetched, installs dependencies, installs the
   harness and the `review-changes` skill, runs the review, and verifies that the GitHub App published a review for
   the head commit (or that the harness skipped it on purpose, for example when there are no new findings).
3. **Finish Code Review** completes the check run with `success` or `failure`.

### Caller

Dispatch the caller from the default branch so a pull request can never change its own reviewer, and so open pull
requests always run the current review setup without a rebase:

```yaml
# .github/workflows/code-review.yml
name: Code Review

on:
  workflow_dispatch:
    inputs:
      pr_number:
        description: Pull request number to review
        required: true
        type: string

permissions: {}

jobs:
  code-review:
    name: Code Review
    uses: fbrissi/github-actions/.github/workflows/code-review.yml@v1
    permissions:
      checks: write
      contents: read
      pull-requests: read
    with:
      pr-number: ${{ inputs.pr_number }}
      harness: ${{ vars.AI_HARNESS }}
      opencode-model: ${{ vars.OPENCODE_MODEL }}
      opencode-variant: ${{ vars.OPENCODE_VARIANT }}
      claude-model: ${{ vars.CLAUDE_MODEL }}
      claude-effort: ${{ vars.CLAUDE_EFFORT }}
      agent-app-id: ${{ vars.AGENT_APP_ID }}
      runs-on: ${{ vars.CI_RUNNER || 'ubuntu-latest' }}
      node-version: "24"
      node-cache: yarn
      install-command: yarn install --frozen-lockfile
      dependency-cache-path: node_modules
    secrets: inherit
```

Trigger it after the quality checks pass, on the default branch:

```yaml
      - name: Dispatch Code Review
        if: ${{ success() && github.event_name == 'pull_request' }}
        uses: actions/github-script@v9
        with:
          script: |
            await github.rest.actions.createWorkflowDispatch({
              owner: context.repo.owner,
              repo: context.repo.repo,
              workflow_id: 'code-review.yml',
              ref: context.payload.repository.default_branch,
              inputs: { pr_number: String(context.payload.pull_request.number) },
            });
```

The dispatching job needs `actions: write`. Do not add a `concurrency` group to the caller: the reusable workflow
already cancels an older review of the same pull request.

### Inputs

| Input | Default | Description |
|---|---|---|
| `pr-number` | – (required) | Pull request to review. |
| `agent-app-id` | – (required) | GitHub App that publishes the review (`pull-requests: write`, `contents: read`). |
| `harness` | `""` (`opencode`) | `opencode` or `claude`. |
| `opencode-command` | `pr/review` | OpenCode command that reviews the PR (Kompass). Empty uses the review-changes skill prompt. |
| `opencode-plugins` | `@kompassdev/opencode` | OpenCode plugins. Set `""` when `opencode-command` is empty. |
| `opencode-model` | `""` | Required by the `opencode` harness. |
| `opencode-variant` | `""` | OpenCode model variant. |
| `claude-model` | `""` | Claude Code model. |
| `claude-effort` | `""` | Claude Code effort level. |
| `prompt` | `""` | Overrides the generated prompt. |
| `review-skill-source` | `ai-skills` | `ai-skills` (pinned `ai-skills-ref`), `base` (the PR base commit, for the skills repository itself), or `none`. |
| `ai-skills-ref` | `v0.1.0` | `fbrissi/ai-skills` tag or SHA used with `ai-skills`. |
| `base-skills-path` | `.rulesync/skills` | Skills directory read from the base commit with `base`. |
| `check-name` | `Code Review` | Check run name. |
| `environment` | `code-review` | Environment of the review job; its secrets are visible to the job. |
| `runs-on` | `ubuntu-latest` | Runner label of every job. |
| `timeout-minutes` | `25` | Harness run timeout. |
| `job-timeout-minutes` | `30` | Review job timeout. |
| `node-version` | `""` | Node.js version for actions/setup-node; empty skips it. |
| `node-cache` | `""` | `npm`, `yarn`, or `pnpm` cache for actions/setup-node. |
| `install-command` | `""` | Dependency install command; empty skips it. |
| `dependency-cache-path` | `""` | Paths cached around `install-command` (for example `node_modules`). |
| `dependency-cache-prefix` | `code-review-deps-v1` | Cache key prefix; the key is `<prefix>-<os>-<arch>-<hash>`. A quality workflow can pre-warm the same key. |
| `dependency-cache-files` | `**/{package-lock.json,yarn.lock,pnpm-lock.yaml}` | Files hashed into the cache key. |

### Secrets

Pass them with `secrets: inherit` or explicitly under the same names. Secrets stored in the `environment` are also
available to the review job.

| Secret | Required | Description |
|---|---|---|
| `AGENT_APP_PRIVATE_KEY` | yes | Private key of the `agent-app-id` App. |
| `OPEN_AI_TOKEN` | `opencode` | OpenAI API key. |
| `ANTHROPIC_API_KEY` | `claude` (this or the next) | Anthropic API key. |
| `CLAUDE_CODE_OAUTH_TOKEN` | `claude` (this or the previous) | Claude Code OAuth token, used when `ANTHROPIC_API_KEY` is empty. |

### Outputs

| Output | Description |
|---|---|
| `check-run-id` | Check run that reports the review. |

## Release Note

`.github/workflows/release-note.yml` runs on `pull_request` and fails unless the pull request adds exactly one
`## vX.Y.Z` heading to the changelog, as its first release heading, with non-empty notes and no existing tag.

```yaml
  release-note:
    name: Quality / release-note
    if: ${{ github.event_name == 'pull_request' && github.base_ref == 'main' }}
    uses: fbrissi/github-actions/.github/workflows/release-note.yml@v1
    permissions:
      contents: read
    with:
      check-package-version: true
```

| Input | Default | Description |
|---|---|---|
| `changelog-path` | `CHANGELOG.md` | Changelog path. |
| `check-package-version` | `false` | Require `package.json` `version` to match the release. |
| `package-json-path` | `package.json` | `package.json` path. |
| `allow-empty-base-heading` | `false` | Accept filling the notes of the single empty heading already on the base branch (first release). |
| `runs-on` | `ubuntu-latest` | Runner label. |

Output: `version`, the release added by the pull request.

## Release

`.github/workflows/release.yml` publishes a release from the changelog:

1. **Prepare Release** resolves the version (the `version` input, or the first changelog heading), its notes, and the
   commit, which must be reachable from the release branch. On a merged pull request it skips PRs that were only
   marked merged because their commits landed through another PR, and versions already released at another commit.
2. **Wait for Infrastructure** (optional) waits for the HCP Terraform apply of the commit when `terraform-path`
   changed since the previous release.
3. **Create Release** pushes the tag, creates the GitHub release (both idempotent, so re-runs are safe), moves the
   major tag when `update-major-tag` is set, and dispatches `deploy-workflow` on the tag once.

```yaml
# .github/workflows/release-orchestrator.yml
name: Release Orchestrator

on:
  pull_request:
    branches: [main]
    types: [closed]
  workflow_dispatch:
    inputs:
      version:
        description: Version to release. Empty uses the first CHANGELOG.md heading.
        required: false
        type: string

permissions: {}

jobs:
  release:
    name: Release
    if: ${{ github.event_name == 'workflow_dispatch' || github.event.pull_request.merged == true }}
    uses: fbrissi/github-actions/.github/workflows/release.yml@v1
    permissions:
      actions: write
      contents: write
    with:
      version: ${{ inputs.version || '' }}
      tfc-organization: my-org
      tfc-workspace: my-workspace
      deploy-workflow: deploy.yml
    secrets:
      TFC_API_TOKEN: ${{ secrets.TFC_API_TOKEN }}
```

Runs are serialized per repository. Tags pushed with `GITHUB_TOKEN` do not trigger other workflows, which is why the
deploy is dispatched explicitly.

| Input | Default | Description |
|---|---|---|
| `version` | `""` | Version to release; empty uses the first changelog heading. |
| `release-notes` | `""` | Notes; empty uses the changelog section. |
| `prerelease` | `false` | Mark as prerelease (versions with a `-` suffix always are). |
| `changelog-path` | `CHANGELOG.md` | Changelog path. |
| `release-branch` | default branch | Branch the commit must be reachable from. |
| `update-major-tag` | `false` | Move `vN` to stable releases (for action repositories). |
| `tfc-organization` | `""` | HCP Terraform organization. |
| `tfc-workspace` | `""` | Workspace awaited before the release; empty skips the wait. |
| `terraform-path` | `terraform` | Path whose changes trigger the wait. |
| `tfc-start-timeout-minutes` | `30` | Minutes to wait for the run to start. |
| `infrastructure-timeout-minutes` | `360` | Timeout of the wait job (includes manual approval). |
| `deploy-workflow` | `""` | Workflow dispatched on the tag, for example `deploy.yml`. |
| `deploy-tag-input` | `tag` | Input of `deploy-workflow` that receives the tag; empty sends none. |
| `runs-on` | `ubuntu-latest` | Runner label of every job. |

Secret: `TFC_API_TOKEN` (required with `tfc-workspace`). Outputs: `version`, `skipped`.

## Permissions

Reusable workflows can only use the permissions the calling job grants. Set `permissions: {}` at the top of callers
and grant per job:

| Workflow | Caller job permissions |
|---|---|
| `code-review.yml` | `checks: write`, `contents: read`, `pull-requests: read` |
| `release-note.yml` | `contents: read` |
| `release.yml` | `actions: write`, `contents: write` |

## Security

- **Pinned tools.** OpenCode is pinned to a version and SHA-256; Claude Code to an exact npm version; skills to an
  `fbrissi/ai-skills` tag or SHA. Updates land through a pull request and a new release here.
- **A pull request cannot change its own reviewer.** Dispatch the Code Review caller on the default branch, and keep
  the review skill out of the reviewed tree (`ai-skills`, or `base` for the skills repository itself). Skills are
  installed into the harness home directory, never read from the PR checkout.
- **Least privilege.** Jobs declare their own permissions; the review job only gets `contents: read` from
  `GITHUB_TOKEN` and publishes through a short-lived GitHub App token. Claude Code runs with `--strict-mcp-config`,
  so project MCP servers never start in CI.
- **Explicit secrets.** Reusable workflows declare every secret they read. Pass them explicitly, with
  `secrets: inherit`, or through the review environment; never interpolate secrets into scripts.
- **Untrusted input.** Inputs and PR data reach scripts only through environment variables.
- The harnesses run with permission prompts disabled. Only review pull requests from trusted contributors, and do
  not run these workflows on `pull_request_target` with untrusted code.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Licensed under the [MIT License](LICENSE).
