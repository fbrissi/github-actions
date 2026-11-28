# github-actions

Reusable GitHub Actions workflows and composite actions for my personal projects: AI code review with a
switchable harness (OpenCode or Claude Code), changelog-driven releases, HCP Terraform helpers, and a Terraform
credential permission check.

Everything here is generic enough to be shared across repositories. Project-specific logic (build matrices,
deploys, credential rotation) stays in each project.

## Catalog

| Component | Type | Purpose |
|---|---|---|
| [`code-review.yml`](#code-review) | Reusable workflow | AI review of a pull request, reported as a `Code Review` check run. |
| [`pr-feedback-dispatch.yml`](#pr-feedback-dispatch) | Reusable workflow | Turns review and check events into fix and merge-decision dispatches on the default branch. |
| [`pr-fix.yml`](#pr-fix) | Reusable workflow | One AI pass that fixes review feedback and failing CI on an opted-in pull request. |
| [`qa.yml`](#review-and-qa-in-separate-jobs) | Reusable workflow | AI QA of a pull request in its own job, reported as an `AI QA` check run with the report, then joined with the code review. |
| [`quality-join.yml`](#review-and-qa-in-separate-jobs) | Reusable workflow | Joins each review with the QA check of the same head: dispatches the merge decision when both approve, otherwise one fix pass. |
| [`merge-decision.yml`](#merge-decision) | Reusable workflow | Deterministic merge gates, then an AI risk rating that holds or (opt-in) merges. |
| [`ai-task.yml`](#ai-task) | Reusable workflow | Runs one AI task delivery task (refinement, readiness, orchestration, implementation) or issue task (intake, resolve) with its agent, then chains the next stage or hands off to a human. |
| [`ai-resume.yml`](#resume) | Reusable workflow | Resumes a stopped delivery stage when someone with write permission replies `/ai-resume [stage] [instructions]`. |
| [`branch-sync.yml`](#branch-sync) | Reusable workflow | Fast-forwards a branch (`develop`) to another (`main`) on every push; opens one issue when it cannot. |
| [`release-note.yml`](#release-note) | Reusable workflow | Requires each pull request to add one changelog release. |
| [`release.yml`](#release) | Reusable workflow | Tags and publishes the changelog release, then optionally deploys it. |
| [`terraform-permissions.yml`](#terraform-permissions) | Reusable workflow | Fails before merge when the Cloudflare Terraform token lacks a permission. |
| [`social-content-generate.yml`](#generate) | Reusable workflow | Generates a Facebook, Instagram, or YouTube content batch per platform with its fbrissi/ai-skills agent and opens the review issue (deterministic fallback when the agent does not). |
| [`social-content-adjust.yml`](#adjust) | Reusable workflow | Reworks the items a writer's `/adjust` comment names on a review issue with the platform agent. |
| [`social-content-publish.yml`](#publish) | Reusable workflow | Deterministic publishing of an approved batch: `/aprove` schedules Facebook and YouTube natively; scheduled runs publish Instagram items. |
| [`ai-harness`](actions/ai-harness/README.md) | Composite action | Installs OpenCode or Claude Code (pinned) and runs one prompt. |
| [`ai-task`](actions/ai-task/README.md) | Composite action | Validates an AI delivery task, installs its agents and skills, and runs it with `ai-harness`. |
| [`ai-delivery`](actions/ai-delivery/README.md) | Composite action | Deterministic delivery steps: chain or hand off after a stage, handoff comments, resume, review requests. |
| [`social-content`](actions/social-content/README.md) | Composite action | Deterministic social content steps: comment gate, prompt, review issue fallback, publisher runs, state, and reports. |
| [`setup-gh`](actions/setup-gh/README.md) | Composite action | Makes `gh` available on any Linux runner: keeps the installed one, else installs a pinned, checksum-verified release without root. |
| [`pr-gate`](actions/pr-gate/README.md) | Composite action | Deterministic PR follow-up gates and markers of `pr-fix.yml` and `merge-decision.yml`, for wrappers that load secrets at run time. |
| [`terraform-cloud-wait`](actions/terraform-cloud-wait/README.md) | Composite action | Waits for the HCP Terraform apply of a commit. |
| [`terraform-permissions`](actions/terraform-permissions/README.md) | Composite action | Checks a Cloudflare permission manifest and the real token. |

How the pieces fit: each caller in your repository calls one reusable workflow, which runs the composite actions. Dashed arrows are `workflow_dispatch` events that start the next run.

```mermaid
flowchart LR
  C1["Stage callers<br/>ai-*.yml"] --> W1["ai-task.yml"]
  C2["ai-resume.yml caller"] --> W2["ai-resume.yml"]
  C3["pr-feedback.yml caller"] --> W3["pr-feedback-dispatch.yml"]
  C4["pr-fix.yml and<br/>merge-decision.yml callers"] --> W4["pr-fix.yml<br/>merge-decision.yml"]
  C5["code-review.yml caller"] --> W6["code-review.yml"]
  C6["branch-sync.yml caller"] --> W7["branch-sync.yml"]
  C7["social content callers"] --> W8["social-content-*.yml"]
  W8 --> A5["social-content action"]
  W8 --> A4
  W1 --> A1["ai-task action"]
  W1 --> A2["ai-delivery action"]
  W2 --> A2
  W4 --> A2
  W4 --> A3["pr-gate action"]
  W4 --> A4["ai-harness action"]
  W6 --> A4
  A1 --> A4
  A4 --> H["OpenCode or Claude Code<br/>with fbrissi/ai-skills<br/>agents and skills"]
  W3 -. "dispatch pr_number" .-> C4
  A2 -. "dispatch next<br/>or resumed stage" .-> C1
```

## Versioning

Releases follow [Semantic Versioning](https://semver.org/) and are cut from [CHANGELOG.md](CHANGELOG.md): every
pull request adds a `## vX.Y.Z` heading, and merging it creates the `vX.Y.Z` tag and GitHub release and moves the
major tag (`v1`) to it.

- `@v1` follows every compatible release. This is what the examples use.
- `@v1.2.3` or a full commit SHA freezes the version; Dependabot (`github-actions` ecosystem) can bump it.

Breaking input, secret, or behavior changes only ship in a new major version. The reusable workflows (which also
run `ai-delivery`), and the `ai-task` action (which runs `ai-harness`), call this repository's own actions at the same major tag (`@v1`): a
composite action cannot reference a sibling action by a relative path once it is called from a remote ref.

## Code Review

`.github/workflows/code-review.yml` reviews one pull request with an AI harness and publishes the review through a
GitHub App:

1. **Start Code Review** creates (or reuses) a check run on the PR head commit and marks it in progress. Draft and
   closed PRs fail here.
2. **Run Code Review** checks out the PR head with the base branch fetched, installs dependencies, installs the
   harness and the `review-changes` skill, runs the review, and verifies that the GitHub App published a review for
   the head commit (or that the harness skipped it on purpose, for example when there are no new findings).
3. **Finish Code Review** completes the check run with `success` or `failure`.

The review GitHub App needs repository permissions `Contents: Read and write`, `Pull requests: Read and write`, and
`Issues: Read`, and nothing else. `Contents: write` only makes its approval count toward required reviews: the token
handed to the harness is always scoped down to `contents: read`, `issues: read`, and `pull-requests: write`. Keep
other automation, such as Terraform, on a separate App so the review key never reaches secrets or variables.

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
      node-version: "24"
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

Harness and model settings come from the [variables](#variables) of the calling repository (or of the review
`environment`) unless the matching input is set. The dispatching job needs `actions: write`. Do not add a `concurrency` group to the caller: the reusable workflow
already cancels an older review of the same pull request.

### Inputs

| Input | Default | Description |
|---|---|---|
| `pr-number` | – (required) | Pull request to review. |
| `agent-client-id` | `AGENT_APP_CLIENT_ID`, then `agent-app-id` | Client ID of the GitHub App that publishes the review. |
| `agent-app-id` | `AGENT_APP_ID` | Deprecated: App ID, used only when no client ID is set. |
| `harness` | `AI_HARNESS`, then `claude` | `opencode` or `claude`. |
| `opencode-command` | `pr/review` | OpenCode command that reviews the PR (Kompass). Empty uses the review-changes skill prompt. |
| `opencode-plugins` | `@kompassdev/opencode` | OpenCode plugins. Set `""` when `opencode-command` is empty. |
| `opencode-model` | `OPENCODE_MODEL` | Required by the `opencode` harness. |
| `opencode-variant` | `OPENCODE_VARIANT` | OpenCode model variant. |
| `claude-model` | `CLAUDE_MODEL` | Claude Code model. |
| `claude-effort` | `CLAUDE_EFFORT` | Claude Code effort level. |
| `prompt` | `""` | Overrides the generated prompt. |
| `instructions` | `""` | Per-run instructions appended to the prompt under `Additional instructions for this run:`; with `opencode-command` they are part of the command arguments. |
| `review-skill-source` | `ai-skills` | `ai-skills` (pinned `ai-skills-ref`), `base` (the PR base commit, for the skills repository itself), or `none`. |
| `ai-skills-ref` | `v0.11.0` | `fbrissi/ai-skills` tag or SHA used with `ai-skills`. |
| `base-skills-path` | `.rulesync/skills` | Skills directory read from the base commit with `base`. |
| `check-name` | `Code Review` | Check run name. |
| `environment` | `code-review` | Environment of the review job; its secrets are visible to the job. |
| `runs-on` | `CI_RUNNER`, then `ubuntu-latest` | Runner label of every job. |
| `timeout-minutes` | `25` | Harness run timeout. |
| `job-timeout-minutes` | `30` | Review job timeout. |
| `node-version` | `""` | Node.js version for actions/setup-node; empty skips it. |
| `node-cache` | `""` | `npm`, `yarn`, or `pnpm` cache for actions/setup-node. Only used with `save-dependency-cache`. |
| `install-command` | `""` | Dependency install command; empty skips it. |
| `dependency-cache-path` | `""` | Paths cached around `install-command` (for example `node_modules`). |
| `dependency-cache-prefix` | `code-review-deps-v1` | Cache key prefix; the key is `<prefix>-<os>-<arch>-<hash>`. A quality workflow can pre-warm the same key. |
| `dependency-cache-files` | `**/{package-lock.json,yarn.lock,pnpm-lock.yaml}` | Files hashed into the cache key. |
| `save-dependency-cache` | `false` | Save the cache after installing the PR's dependencies. Keep it off and warm the same key from the default branch. |

### Secrets

Pass them with `secrets: inherit` or explicitly under the same names. Secrets stored in the `environment` are also
available to the review job.

`secrets: inherit` only works when the caller belongs to the same owner as this repository (`fbrissi`). Callers in
another organization must pass each secret explicitly, or organization secrets arrive empty:

```yaml
    secrets:
      AGENT_APP_PRIVATE_KEY: ${{ secrets.AGENT_APP_PRIVATE_KEY }}
      OPEN_AI_TOKEN: ${{ secrets.OPEN_AI_TOKEN }}
      ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
      CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
```

| Secret | Required | Description |
|---|---|---|
| `AGENT_APP_PRIVATE_KEY` | yes | Private key of the review GitHub App. |
| `OPEN_AI_TOKEN` | `opencode` | OpenAI API key. |
| `ANTHROPIC_API_KEY` | `claude` (this or the next) | Anthropic API key. |
| `CLAUDE_CODE_OAUTH_TOKEN` | `claude` (this or the previous) | Claude Code OAuth token, used when `ANTHROPIC_API_KEY` is empty. |

### Outputs

| Output | Description |
|---|---|
| `check-run-id` | Check run that reports the review. |

## PR Feedback Loop

Three workflows follow a pull request up event by event instead of one agent that blocks on CI:

1. A review arrives. [`pr-feedback-dispatch.yml`](#pr-feedback-dispatch) dispatches the fix workflow for
   `changes_requested` (or `commented` with a body or inline comments) and the merge workflow for `approved`, or for a
   `commented` review that is only a clean `★★★★★` grade with no inline comments (a reviewer that cannot approve, for
   example on its own pull request, leaves its approval that way). A clean grade never dispatches a fix, even while
   threads are open: the merge gate hands those to a person.
2. [`pr-fix.yml`](#pr-fix) runs one fix pass and pushes with a GitHub App token. Unlike `GITHUB_TOKEN` pushes, App
   pushes trigger CI, so the code review runs again and its review closes the loop.
3. [`merge-decision.yml`](#merge-decision) checks the merge gates without AI and, when they pass, rates the risk
   with the `merge-risk` skill. It holds by default and merges only with `auto-merge: true`.

```mermaid
flowchart TD
  push["Push to the PR branch"] --> cr["Code Review<br/>AI review by the review App"]
  push --> ci["CI checks"]
  cr --> disp{"pr-feedback-dispatch.yml<br/>review state"}
  disp -- "changes_requested<br/>or commented" --> fix["pr-fix.yml"]
  disp -- "approved<br/>or clean ★★★★★ comment" --> merge["merge-decision.yml"]
  fix --> fgate{"pr-gate<br/>fix gate"}
  fgate -- "skip" --> idle["No pass"]
  fgate -- "fix" --> pass["One pr-fix pass<br/>push with the fix App token"]
  pass --> push
  pass -. "merge-workflow set" .-> merge
  pass -- "failed" --> failed["Handoff to the requester<br/>with the run link"]
  fgate -- "escalate<br/>after max-rounds" --> esc["Label ai:needs-human<br/>handoff to the requester"]
  esc -. "/ai-resume pr-fix<br/>or label removed" .-> fix
  merge --> mgate{"pr-gate<br/>merge gate"}
  mgate -- "approval missing" --> ask["Request review<br/>from the requester"]
  mgate -- "only unresolved threads,<br/>no fix run queued" --> threads["Handoff to the requester"]
  ask -. "their approval" .-> disp
  mgate -- "decide" --> risk["merge-risk rating"]
  risk -- "auto-merge and low risk" --> merged["Merged by the merge App"]
  risk -- "otherwise" --> hold["Hold with the rating"]
```

Both targets are dispatched on the default branch, so a pull request can never change its own fixer or merger. Use
separate GitHub Apps (one `environment` each, with its own `AGENT_APP_CLIENT_ID` and `AGENT_APP_PRIVATE_KEY`) for
review, fix, and merge, so the fixer's replies are never mistaken for review feedback and the reviewer can never
merge.
When one App does both, set `ignore-reply-authors` to its bot instead of `ignore-authors`: its fix replies are
ignored and its new reviews still dispatch fixes.

The gates and markers of both workflows live in the [`pr-gate`](actions/pr-gate/README.md) action. Callers that load
the App key and AI keys at run time (for example from a cloud secret store), which a reusable workflow cannot receive
as `secrets`, can build their own wrapper from `pr-gate`, [`ai-harness`](actions/ai-harness/README.md), and
[`ai-delivery`](actions/ai-delivery/README.md) with the same behavior.

### Review and QA in separate jobs

The `implement` task can run its quality cycle in one job (`quality-mode: cycle`, the default), or leave the review
and QA to their own workflows (`quality-mode: separate`) so no job holds the developer, the reviewer, and QA within
one timeout. With `separate`:

1. The implement agent only develops: it runs the narrow checks, pushes, opens the pull request, and stops.
2. The push starts the code review ([`code-review.yml`](#code-review)) and QA
   ([`qa.yml`](#review-and-qa-in-separate-jobs)) in parallel: dispatch both from the CI job that dispatches the code
   review today. QA starts `setup-command`, runs the `qa-e2e` skill on the scenarios of the change (from the second
   round: the failed scenarios, those covering the files changed since, and the touched `@smoke` scenarios), and
   reports an `AI QA` check run on the head commit, `success` or `failure`, with its report as the check output. A run
   without a `qa-result:` last line is `neutral`: QA comments on the pull request, and nothing moves until QA is rerun.
   Pull requests whose head matches `skip-head-prefixes` (for example `release/`, whose task pull requests had their
   own QA) get a passing check without a run.
3. The pr-gate [`quality-join`](actions/pr-gate/README.md) command joins them. It runs after each of the two checks
   completes (the QA workflow's `join-qa` job, and a job of the code review caller after `code-review.yml`) and on every
   review ([`quality-join.yml`](#review-and-qa-in-separate-jobs)). It decides only once the `Code Review` and `AI QA`
   check runs of the head have completed, trusting only check runs of the QA and code review callers dispatched on the
   default branch. The review side asks for a fix when any substantive review of the head does (replies to existing
   threads and `ignore-authors` never do), and approves otherwise, also when the reviewer published nothing new.
   Both approving dispatches `merge-workflow`; otherwise `fix-workflow`. A
   `<!-- quality-join head=<sha> review-check=<id> qa-check=<id> reviews=<id> -->` bot comment, posted after the
   dispatch, records each decision, so a decision is dispatched once and a QA rerun or a new review decides again.
   One concurrency group per pull request serializes the joins; each reads the whole state, so a join the group drops
   is made up by the next one.
4. [`pr-fix.yml`](#pr-fix) with `qa-check-name` fixes the review threads and the QA report together and pushes; the
   push starts the next review and QA. `max-rounds` and the escalation of PR Fix bound the loop.

```yaml
# .github/workflows/pr-feedback.yml (replaces the pr-feedback-dispatch.yml caller)
name: PR Feedback
on:
  pull_request_review:
    types: [submitted]
permissions: {}
jobs:
  join:
    uses: fbrissi/github-actions/.github/workflows/quality-join.yml@v1
    permissions:
      actions: write
      checks: read
      pull-requests: write
    with:
      ignore-authors: my-fixer[bot]
```

```yaml
# .github/workflows/qa.yml
name: QA
on:
  workflow_dispatch:
    inputs:
      pr_number:
        required: true
        type: string
permissions: {}
jobs:
  qa:
    uses: fbrissi/github-actions/.github/workflows/qa.yml@v1
    permissions:
      actions: write
      checks: write
      contents: read
      pull-requests: write
    with:
      pr-number: ${{ inputs.pr_number }}
      ignore-authors: my-fixer[bot]
      setup-command: scripts/start-test-stack.sh
      skip-head-prefixes: release/
    secrets: inherit
```

```yaml
# .github/workflows/code-review.yml: add this job after the code-review job
  join:
    needs: code-review
    if: ${{ always() && !cancelled() }}
    runs-on: ubuntu-latest
    permissions:
      actions: write
      checks: read
      pull-requests: write
    concurrency:
      group: quality-join-${{ github.repository }}-${{ inputs.pr_number }}
      cancel-in-progress: false
    steps:
      - uses: fbrissi/github-actions/actions/pr-gate@v1
        with:
          command: quality-join
          pr-number: ${{ inputs.pr_number }}
          qa-check-name: AI QA
          fix-workflow: pr-fix.yml
          merge-workflow: merge-decision.yml
          ignore-authors: my-fixer[bot]
```

`qa.yml` inputs: `pr-number` (required); `check-name` (`AI QA`); `setup-command` (`""`, targeted validation without
it); `skip-head-prefixes` (`""`); `skills` (`qa-e2e bdd-scenarios`) and `ai-skills-ref`; for the join,
`fix-workflow` (`pr-fix.yml`) and `merge-workflow` (`merge-decision.yml`) (an empty one skips the join),
`ignore-authors`, `review-check-name` (`Code Review`), `qa-workflow` (`qa.yml`, the caller's file name), and
`review-workflow` (`code-review.yml`); `prompt` (it must keep the `qa-result:` last line) and `instructions`;
`environment`, `timeout-minutes` (`40`), and `job-timeout-minutes` (`55`); and `harness`, the model inputs,
`agent-client-id`, `runs-on`, and the dependency inputs as in [Code Review](#inputs). The agent App needs `Contents`,
`Issues`, `Pull requests`, and `Checks: Read`. Output: `result` (`approved`, `changes-required`, `skipped`, or `none`).
`quality-join.yml` inputs: `qa-check-name` (`AI QA`), `review-check-name`, `qa-workflow`, `review-workflow`,
`fix-workflow`, `merge-workflow`, `ignore-authors` (their reviews start no join), and `runs-on`.

### PR Feedback Dispatch

`.github/workflows/pr-feedback-dispatch.yml` needs no secrets and never checks out code. It skips fork pull
requests, whose `GITHUB_TOKEN` is read-only.

```yaml
# .github/workflows/pr-feedback.yml
name: PR Feedback

on:
  pull_request_review:
    types: [submitted]
  check_run:
    types: [completed]

permissions: {}

jobs:
  dispatch:
    name: PR Feedback
    uses: fbrissi/github-actions/.github/workflows/pr-feedback-dispatch.yml@v1
    permissions:
      actions: write
      pull-requests: read
    with:
      ignore-authors: my-fixer-app[bot]
```

| Input | Default | Description |
|---|---|---|
| `fix-workflow` | `pr-fix.yml` | Dispatched with `pr_number` on a `changes_requested` review, or a `commented` one with a body or inline comments that is not a clean grade. Empty disables it. |
| `merge-workflow` | `merge-decision.yml` | Dispatched with `pr_number` on an `approved` review, a clean-grade `commented` review (only `★★★★★`, plus `Ticket:` lines, no inline comments; open threads are left to the merge gate), or a successful `merge-check-name` check run. Empty disables it. The merge gates, human approvals included, still apply. |
| `ignore-authors` | `""` | Logins whose reviews never dispatch a fix, for example the fixer App bot, whose thread replies also emit review events. |
| `ignore-reply-authors` | `""` | Logins whose reply-only reviews (no body, every inline comment a reply) never dispatch a fix. Use it instead of `ignore-authors` when one App both reviews and fixes, so its new reviews still dispatch fixes. |
| `merge-check-name` | `Code Review` | Successful check run that dispatches `merge-workflow` for each pull request in `check_run.pull_requests` (same repository only). Empty disables it. |
| `runs-on` | `CI_RUNNER`, then `ubuntu-latest` | Runner label. |

GitHub never starts `check_run` workflows for check runs whose suite was created by GitHub Actions, and events caused
by `GITHUB_TOKEN` never start workflows (except `workflow_dispatch` and `repository_dispatch`). The `Code Review`
check run of [`code-review.yml`](#code-review) is one of those, so `merge-check-name` only fires for check runs that
another GitHub App creates. To decide again after an approval that arrived before the review finished, dispatch the
merge workflow from the Code Review caller once the review succeeds:

```yaml
  merge-decision:
    name: Dispatch Merge Decision
    needs: code-review
    runs-on: ubuntu-latest
    permissions:
      actions: write
    steps:
      - uses: actions/github-script@v9
        env:
          PR_NUMBER: ${{ inputs.pr_number }}
        with:
          script: |
            await github.rest.actions.createWorkflowDispatch({
              owner: context.repo.owner,
              repo: context.repo.repo,
              workflow_id: 'merge-decision.yml',
              ref: context.payload.repository.default_branch,
              inputs: { pr_number: process.env.PR_NUMBER },
            });
```

### PR Fix

`.github/workflows/pr-fix.yml` runs one pass of the `pr-fix` skill in auto mode on one pull request:

1. **Check PR Fix Gates** skips (successfully, with `skipped: <reason>` in the step summary) unless the pull request
   is open, not a draft, from this repository, opted in (`opt-in-label` or a `branch-prefixes` match), and without
   `escalation-label`. Each pass leaves a `<!-- pr-fix round=N head=<sha> -->` comment; a pass is skipped when one
   exists for the current head and nobody but the fixer has commented or reviewed since. After `max-rounds` passes it
   adds `escalation-label` and posts one [handoff](#how-stages-chain) that mentions the person who started the flow
   (the `requested-by` marker of the PR's milestone, or of the issues it closes), explains the blocker, and offers a
   `pr-fix` resume; replying `/ai-resume` (with the [resume caller](#resume)) or removing the label allows
   `max-rounds` more. Otherwise it creates a `PR Fix` check run on the head commit.
2. **Run PR Fix** checks out the head branch with the App token, commits as the App bot, installs dependencies, and
   runs the harness. It never watches CI or waits for comments: the next review dispatches the next pass. It then
   records the round and fails if the branch was rewritten.
3. **Finish PR Fix** completes the check run.
4. **Follow Up PR Fix** (in `environment`, for the App key; after the check run is complete) posts a `pr-fix`
   [handoff](#how-stages-chain) when the pass failed (for example a runner or credential problem), mentioning the
   requester and linking the run, so the pull request does not wait silently; `/ai-resume` runs the pass again. A
   later escalation supersedes that handoff, so the escalation is still posted. After a successful pass with
   `merge-workflow` set, it dispatches that workflow, so a merge decision skipped while the pass was running
   (`checks still running: PR Fix`) is decided again. Each pass dispatches it at most once, so `max-rounds` bounds
   it, and a merge decision never dispatches a fix.

```yaml
# .github/workflows/pr-fix.yml
name: PR Fix

on:
  workflow_dispatch:
    inputs:
      pr_number:
        description: Pull request number to fix
        required: true
        type: string
      instructions:
        description: Extra instructions for this run only
        required: false
        type: string

permissions: {}

jobs:
  pr-fix:
    name: PR Fix
    uses: fbrissi/github-actions/.github/workflows/pr-fix.yml@v1
    permissions:
      checks: write
      issues: read
      pull-requests: read
    with:
      pr-number: ${{ inputs.pr_number }}
      branch-prefixes: ai/
      instructions: ${{ inputs.instructions }}
      node-version: "24"
      install-command: npm ci
    secrets: inherit
```

The fixer GitHub App needs `Contents: Read and write`, `Pull requests: Read and write`, `Issues: Read`,
`Actions: Read` (`Read and write` with `merge-workflow`), and `Checks: Read`. When it is not the agent App, add its bot to `trusted-bots` of the
[resume caller](#resume) so its handoffs can be resumed. Do not grant it `Workflows`: GitHub then rejects any push that changes
`.github/workflows/**`.

| Input | Default | Description |
|---|---|---|
| `pr-number` | – (required) | Pull request to fix. |
| `opt-in-label` | `ai:auto-fix` | Label that opts a pull request in. |
| `branch-prefixes` | `""` | Head branch prefixes that also opt a pull request in (`startsWith`), for example `feature/ release/ hotfix/ bugfix/`. |
| `max-rounds` | `3` | Passes before escalation. |
| `escalation-label` | `ai:needs-human` | Added at `max-rounds`; blocks further passes while present. |
| `skills` | `pr-fix pr-checks` | Skills installed for the harness. |
| `agents` | `""` | Agents installed for the harness (Claude Code or OpenCode agents of the same name). |
| `prompt` | `""` | Overrides the generated prompt. |
| `instructions` | `""` | Per-run instructions appended to the prompt under `Additional instructions for this run:`. |
| `prompt-append` | `""` | Deprecated, use `instructions`. Appended to the prompt. |
| `skill-source` | `ai-skills` | `ai-skills` (pinned `ai-skills-ref`), `base` (the PR base commit), or `none`. |
| `ai-skills-ref` | `v0.11.0` | `fbrissi/ai-skills` tag or SHA used with `ai-skills`. |
| `base-skills-path` | `.rulesync/skills` | Skills directory read from the base commit with `base`. |
| `check-name` | `PR Fix` | Check run name. |
| `merge-workflow` | `""` | Workflow dispatched with `pr_number` after a successful pass, for example `merge-decision.yml`. Needs `Actions: Read and write` on the fixer App. Empty disables it. |
| `qa-check-name` | `""` | QA check run of [`qa.yml`](#review-and-qa-in-separate-jobs): the pass also fixes the findings in the report of its newest failing run on the head commit and answers them in one pull request comment. Empty fixes review feedback only. |
| `environment` | `pr-fix` | Environment of the fix and follow-up jobs; its secrets are visible to them. |
| `agent-client-id` | `AGENT_APP_CLIENT_ID` | Client ID of the fixer GitHub App. |

`harness`, `opencode-plugins` (default `""`), `opencode-model`, `opencode-variant`, `claude-model`, `claude-effort`,
`runs-on`, `timeout-minutes` (`25`), `job-timeout-minutes` (`30`), `node-version`, `node-cache`, `install-command`,
`dependency-cache-path`, `dependency-cache-prefix` (`pr-fix-deps-v1`), `dependency-cache-files`, and
`save-dependency-cache` work as in [Code Review](#inputs). Secrets are the same as [Code Review](#secrets). Output:
`result` (`fix`, `escalate`, or `skip`).

### Merge Decision

`.github/workflows/merge-decision.yml` decides on one pull request:

1. **Check Merge Gates** skips (successfully, with `skipped: <reason>`) unless the pull request is open, not a draft,
   on a head branch matching `branch-prefixes` (when set), without `hold-labels`, free of conflicts, with every check
   run and commit status on the head commit completed and
   successful (`neutral` and `skipped` count; runs started by review or check events, such as the dispatcher, are
   ignored), with no standing `CHANGES_REQUESTED`, at least `required-human-approvals` approvals on the head commit by
   users (not bots or Apps; none when the base branch matches `human-approval-exempt-base-prefixes` and the author
   matches `human-approval-exempt-authors`, unless the pull request has one of the `approval-labels`), no unresolved review threads, and no decision recorded for the head
   commit yet. Of several check runs with one name from the same App and workflow file (for example a cancelled run
   and the newer run that replaced it), only the newest counts; same-named jobs of different workflows stay separate. When only unresolved threads remain and no `fix-workflow` run is queued that this pull request could get (opted in, not
   escalated, rounds left, review feedback newer than its last fix round), **Hand Off
   Unresolved Threads** posts one `merge-decision` [handoff](#how-stages-chain) to the requester
   (`<!-- merge-decision unresolved-threads -->`, kept while it is open) instead of waiting silently; resume after
   resolving them. A queued fix run only skips, since its follow-up dispatches the decision again.
2. **Request Human Review** runs only when the approvals are missing (and `request-human-review` is on): it requests
   a review from the person who started the flow (the `requested-by` marker of the PR's milestone, or of the issues
   it closes) and mentions them once per pull request (`<!-- merge-decision review-requested=<login> -->`). Their
   approval dispatches the decision again through [PR Feedback Dispatch](#pr-feedback-dispatch).
3. **Run Merge Decision** checks out the base commit (never the pull request) so the `merge-risk` profile cannot be
   changed by the change it rates, runs the skill in decide mode with the base branch, the required approvals, and
   the approval rule (with 0 required approvals an empty `reviewDecision` passes and only `CHANGES_REQUESTED`, or
   `REVIEW_REQUIRED` from branch protection, fails; otherwise it counts human approvals on the head commit from the
   reviews, never `reviewDecision` alone). It reads the skill's last line, `merge-risk-result: merged | held |
   not-evaluated` (older skills: the `PR #<n>: MERGE | HOLD` line). A real decision (`merged`, or `held` for a gate or
   the rating) records a `<!-- merge-decision head=<sha> -->` comment, so each head commit is decided once. When the
   skill could not evaluate the pull request (for example `gh` failed or the API errored) or the harness failed
   without a result, it records nothing and posts a `merge-decision` [handoff](#how-stages-chain) that mentions the
   requester with the run link. Push a commit, or reply `/ai-resume merge-decision` (it leaves a `<!-- merge-decision
   redecide -->` comment that allows one new decision on the current head), to decide again. `instructions` (for example
   from `/ai-resume merge-decision <text>`) can only make the decision stricter: the prompt says they never raise the
   max risk, add base branches, lower approvals, remove hold labels, or turn auto-merge on. Agents get `gh` from
   [`setup-gh`](actions/setup-gh/README.md) when the runner lacks it.

```mermaid
flowchart TD
  start["merge-decision.yml<br/>pr_number"] --> g1{"Open, not a draft,<br/>branch-prefixes match,<br/>no hold label, no conflicts?"}
  g1 -- "no" --> skip["Skip with the reason"]
  g1 -- "yes" --> g2{"Every check green,<br/>no changes requested,<br/>no unresolved thread?"}
  g2 -- "no" --> skip
  g2 -- "yes" --> ex{"Base matches exempt base prefixes<br/>AND author is an exempt author?"}
  ex -- "yes" --> g4{"Head commit<br/>already decided?"}
  ex -- "no" --> appr{"Enough human approvals<br/>on the head commit?"}
  appr -- "no" --> req["Request Human Review<br/>review request and one mention<br/>for the requested-by login"]
  req -. "approval dispatches again" .-> start
  appr -- "yes" --> g4
  g4 -- "yes" --> skip
  g4 -- "no" --> risk["Run merge-risk on a<br/>checkout of the base commit"]
  risk -- "auto-merge true<br/>and rating allows" --> merged["Merge with the App token"]
  risk -- "otherwise" --> hold["Hold"]
  merged --> rec["Record the head decision marker"]
  hold --> rec
```

The App token only gets `contents: write` with `auto-merge: true`, so with the default the harness cannot merge. A
merge made with the App token, unlike one made with `GITHUB_TOKEN`, triggers the release workflows of the merged
commit.

```yaml
# .github/workflows/merge-decision.yml
name: Merge Decision

on:
  workflow_dispatch:
    inputs:
      pr_number:
        description: Pull request number to decide on
        required: true
        type: string

permissions: {}

jobs:
  merge-decision:
    name: Merge Decision
    uses: fbrissi/github-actions/.github/workflows/merge-decision.yml@v1
    permissions:
      actions: read
      checks: read
      contents: read
      issues: read
      pull-requests: read
      statuses: read
    with:
      pr-number: ${{ inputs.pr_number }}
      auto-merge: false
    secrets: inherit
```

The merge GitHub App needs `Contents: Read and write` (`Read` is enough while `auto-merge` is off),
`Pull requests: Read and write`, `Issues: Read`, `Checks: Read`, and `Commit statuses: Read`, and must be allowed to
merge by the branch rules. Without `Workflows`, it cannot merge a pull request that changes `.github/workflows/**`.
The review request uses the same App with `pull-requests: write`.

| Input | Default | Description |
|---|---|---|
| `pr-number` | – (required) | Pull request to decide on. |
| `auto-merge` | `false` | Let the AI merge; when false it only rates the risk and holds. |
| `required-human-approvals` | `1` | Human approvals required on the head commit. |
| `human-approval-exempt-base-prefixes` | `""` | Base branch prefixes whose pull requests need no human approval when the author is exempt too, for example `release/` for task PRs into release branches. |
| `human-approval-exempt-authors` | `""` (any GitHub App bot) | Authors that may skip human approval into an exempt base, for example the agent App bot `my-agent[bot]`. Pull requests by people always need `required-human-approvals`. |
| `request-human-review` | `true` | Request a review from the flow's requester and mention them once while approvals are missing. |
| `approval-labels` | `ai:needs-approval` | Labels that cancel the exemption: the pull request needs a human approval of its head commit (at least one) before a decision, for example a sign-off on legal text. Unlike the PR Fix `escalation-label`, they never stop a fix pass, so review findings keep being fixed while the sign-off is pending. |
| `hold-labels` | `do-not-merge hold` | Labels that block a decision. |
| `fix-workflow` | `pr-fix.yml` | PR Fix caller; while a run of it is queued, the pull request could get a pass, and it has review feedback newer than its last fix round, unresolved threads only skip, otherwise they hand off to the requester. Empty always hands off. |
| `fix-opt-in-label`, `fix-branch-prefixes`, `fix-max-rounds`, `fix-escalation-label` | `ai:auto-fix`, `""`, `3`, `ai:needs-human` | Set them as the `opt-in-label`, `branch-prefixes`, `max-rounds`, and `escalation-label` of the PR Fix caller, so the gate only waits for a pass the pull request could get. |
| `fix-ignore-authors` | `""` | The `ignore-authors` of the PR Feedback Dispatch caller; their feedback never waits for a queued fix run. |
| `branch-prefixes` | `""` | Head branch prefixes a pull request must match (`startsWith`), for example `feature/ release/ hotfix/ bugfix/`; empty decides on every pull request. |
| `skills` | `merge-risk` | Skills installed for the harness. |
| `agents` | `""` | Agents installed for the harness (Claude Code or OpenCode agents of the same name). |
| `prompt` | `""` | Overrides the generated prompt. |
| `instructions` | `""` | Per-run instructions appended to the prompt under `Additional instructions for this run:`. |
| `prompt-append` | `""` | Deprecated, use `instructions`. Appended to the prompt. |
| `skill-source` | `ai-skills` | `ai-skills` (pinned `ai-skills-ref`), `base` (the base commit), or `none`. |
| `ai-skills-ref` | `v0.11.0` | `fbrissi/ai-skills` tag or SHA used with `ai-skills`. |
| `base-skills-path` | `.rulesync/skills` | Skills directory read from the base commit with `base`. |
| `environment` | `merge-decision` | Environment of the decision job; its secrets are visible to the job. |
| `agent-client-id` | `AGENT_APP_CLIENT_ID` | Client ID of the merge GitHub App. |
| `timeout-minutes` | `15` | Harness run timeout. |
| `job-timeout-minutes` | `20` | Decision job timeout. |

`harness`, `opencode-plugins` (default `""`), `opencode-model`, `opencode-variant`, `claude-model`, `claude-effort`,
and `runs-on` work as in [Code Review](#inputs). Secrets are the same as [Code Review](#secrets). Output: `result`
(`decide` or `skip`).

## AI Task

`.github/workflows/ai-task.yml` runs one task of the AI task delivery flow with the
[`ai-task`](actions/ai-task/README.md) action: it creates a GitHub App token scoped to the task, checks out the
calling ref with full history and the token as push credentials, sets the git identity to the App bot, installs
dependencies, runs the optional `setup-command`, and runs the task's
[fbrissi/ai-skills](https://github.com/fbrissi/ai-skills) agent with OpenCode or Claude Code (`AI_HARNESS`). A follow-up job then chains the
next stage or hands off to a human (see [How stages chain](#how-stages-chain)).

| Task | Agent | Input | What it does |
|---|---|---|---|
| `business-refinement` | `business-analyst` | `source` | Turns a source ticket (Jira, GitHub issue, or milestone) into a GitHub milestone and business-level issues, or asks the source what is unclear. |
| `technical-refinement` | `tech-lead` | `milestone` or `issue` | Writes the technical plan of each issue so the milestone's issues can be built in parallel. |
| `readiness-review` | `readiness-reviewer` | `milestone` or `issue` | Marks each issue ready or sends it back to refinement. |
| `orchestrate` | `delivery-orchestrator` | `milestone` | Creates the milestone and task branches and dispatches `implement` for each ready issue whose dependencies are done; opens the milestone PR when every issue is done. Never codes. |
| `implement` | `task-implementer` | `issue`, `branch`, `base-branch` | Implements the issue, runs the review and QA cycle, and opens a PR into the milestone (release) branch. |
| `issue-intake`, `issue-resolve` | `issue-resolver` | –, `issue` | See [Issue intake and resolve](#issue-intake-and-resolve). |
| `dependency-update` | `dependency-updater` | – | See [Dependency updates](#dependency-updates). |

Runs never wait for input: blocked tasks leave their questions on the ticket or issue and stop. Inputs left empty
are not sent, so the repository profile (`docs/ai/delivery.md`) and then the skill defaults apply.

Runs are serialized per repository, task, and issue (or milestone, or source) without cancelling: a new run waits
for the current one, and only the newest waiting run is kept.

### Setup from zero

Do these once per repository, in this order:

1. **Releases.** Tag `fbrissi/ai-skills` first (the agents and skills, pinned by `ai-skills-ref`, default
   `v0.11.0`), then release this repository: the reusable workflows call `actions/ai-task@v1` and
   `actions/ai-delivery@v1`, so a workflow only works once a `v1` release contains those actions. Callers then use
   `@v1` (or a pinned `@v1.8.0`).
2. **GitHub App** for the agent, installed on the repository, with these repository permissions:
   `Contents`, `Issues`, `Pull requests`, and `Actions` (read and write; `Actions: write` dispatches the next stage,
   the implement runs, and resumes), `Metadata` (read), plus `Organization projects` (read and write) on an
   organization installation when `project` is used. Without `Workflows`, it can never push
   `.github/workflows/**`. Use separate Apps for [PR Fix](#pr-fix) and [Merge Decision](#merge-decision) if you
   want their permissions apart (see [PR Feedback Loop](#pr-feedback-loop)).
3. **Secrets** (repository, organization, or the `environment`): `AGENT_APP_PRIVATE_KEY`, the harness credential
   (`OPEN_AI_TOKEN` for OpenCode with an `openai/` model; `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` for Claude
   Code), and `JIRA_EMAIL` plus `JIRA_API_TOKEN` for Jira sources.
4. **Variables:** `AGENT_APP_CLIENT_ID`, the harness (`AI_HARNESS`: `claude` by default, with optional `CLAUDE_MODEL` and `CLAUDE_EFFORT`, or `opencode` with `OPENCODE_MODEL` and
   optional `OPENCODE_VARIANT`), and optional
   `CI_RUNNER` and `JIRA_BASE_URL`. Every AI workflow reads the same ones; see [Variables](#variables).
5. **Labels** the flow sets but never creates:

   ```bash
   for state in needs-business-refinement business-blocked needs-technical-refinement technical-blocked \
     needs-review ready in-progress in-review done; do
     gh label create "status:${state}" --force
   done
   gh label create ai:auto-fix --force      # opts a pull request into PR Fix
   gh label create ai:needs-human --force   # set by PR Fix when it escalates
   gh label create ai:needs-approval --force  # needs a person's approval before merge; PR Fix keeps running
   gh label create do-not-merge --force     # hold labels of Merge Decision
   gh label create hold --force
   ```

   Rename them with `status-labels` (`state=label` lines) if the repository already uses other names.
6. **Project** (optional): a single-select `Status` field (or `project-status-field`) with one option per state,
   by default the Title Case of the state: `Needs Business Refinement`, `Business Blocked`,
   `Needs Technical Refinement`, `Technical Blocked`, `Needs Review`, `Ready`, `In Progress`, `In Review`, `Done`.
   Map several states to one option with `project-status-options`, for example `business-blocked=Blocked`.
7. **Profile:** commit `docs/ai/delivery.md` (template: `references/delivery-profile.md` of the
   `delivery-orchestration` skill in fbrissi/ai-skills) with the milestone template, branch names, test commands,
   and the test environment.
8. **Callers** on the default branch (dispatch only finds workflows there): the five [stage callers](#callers),
   the [resume caller](#resume), the [orchestrate-on-merge caller](#callers), and the
   [PR follow-up callers](#pr-follow-up-for-task-branches).
9. **Branch rules:** let the merge App merge into release branches (`release/**`), and keep one human approval on
   the default branch (`main`). See [Branch model](#branch-model).

Start a delivery with **Actions > AI Business Refinement > Run workflow** and the Jira key (or
`gh workflow run ai-business-refinement.yml -f source=DEV-1`). Everything after that runs on its own until a stage
needs a person.

### How stages chain

After every run, the `follow-up` job takes a fresh App token (the task's token may have expired) and reads the
`status:*` labels of the milestone's open issues (or of `issue` when the run was scoped to one):

| Finished stage | Hands off when | Otherwise dispatches |
|---|---|---|
| `business-refinement` | an issue is `business-blocked` | `technical-refinement` when an issue `needs-technical-refinement` |
| `technical-refinement` | an issue is `technical-blocked` | `business-refinement` when an issue `needs-business-refinement`, else `readiness-review` when one `needs-review` |
| `readiness-review` | an issue is `business-blocked` or `technical-blocked` | `business-refinement`, else `technical-refinement`, else `orchestrate` when an issue is `ready` |
| `orchestrate` | – | nothing: it dispatches `implement` itself, and the orchestrate-on-merge caller re-runs it |
| `implement` | the issue is blocked, its PR or issue has `ai:needs-human`, or the run ended without a PR | nothing: the [PR follow-up](#pr-follow-up-for-task-branches) takes the PR from here |
| `issue-resolve` | the run failed, or it left the issue open with no open pull request referencing it and no `ai-delivery blocker` comment since the run was created | nothing: the PR follow-up takes the PR from here |

The stages and the labels that move a milestone between them:

```mermaid
stateDiagram-v2
  direction LR
  BR: business-refinement
  TR: technical-refinement
  RR: readiness-review
  OR: orchestrate
  IM: implement
  PF: PR follow-up
  HO: Handoff to the requester
  [*] --> BR: source ticket
  BR --> TR: needs-technical-refinement
  TR --> BR: needs-business-refinement
  TR --> RR: needs-review
  RR --> BR: needs-business-refinement
  RR --> TR: needs-technical-refinement
  RR --> OR: ready
  OR --> IM: one run per ready issue
  IM --> PF: task PR opened
  PF --> OR: task PR merged, orchestrate-on-merge
  OR --> [*]: every issue done, milestone PR ready
  BR --> HO: business-blocked
  TR --> HO: technical-blocked
  RR --> HO: an issue is blocked
  IM --> HO: blocked, escalated, or no PR
  HO --> [*]: wait for /ai-resume
```

- **Failed, timed-out, or cancelled runs** hand off with `run failed: <run URL>` and resume the same stage
  (`pr-fix` when the implement PR already exists). An `implement` issue left in `status:in-progress` without a PR
  moves back to `status:ready`, so it does not hold an orchestration slot.
- **Dispatches** go to the default branch with the stage caller's `workflow_dispatch` inputs: `milestone`,
  `issue` (technical refinement and readiness review, when the run was scoped to one issue), `jira_key` (business
  refinement), `branch` and `base_branch` (implement), and `requested_by`. File names come from `stage-workflows`.
  An input a caller does not declare is dropped with a warning, so older callers keep working.
- **Loop guard.** Each automatic dispatch of a stage increments a counter in the milestone description
  (`<!-- ai-delivery-dispatches stage=N -->`). Past `max-auto-dispatches` (default `3`) the follow-up hands off
  instead; a resume resets the counters.
- **Send-back limit.** A dispatch to an earlier refinement stage (readiness review back to business or technical
  refinement, or technical refinement back to business refinement) is a send-back, counted as `send-backs=N` in the
  same marker. Past `max-send-backs` (default `3`) the follow-up hands off to the requester to investigate why the
  refinement did not fix it; a resume resets the counter.
- **Requester.** `requested-by` (default `github.triggering_actor`) is stored in the milestone description as
  `<!-- ai-delivery requested-by=<login> -->` and passed on as `requested_by` to every dispatch. Runs started by the
  App (whose triggering actor is the bot) use the marker instead, and bots are never mentioned. PR Fix and Merge
  Decision read the same marker from the PR's milestone, or the milestone of the issues it closes.
- **Project status.** With `project` set, the follow-up mirrors each issue's final status label on the Project's
  status field (`project-status-field`, default `Status`), adding the issue to the Project when needed. The field and
  the `state=Option name` map come from the inputs, else from the `Project status field` and `Project status options`
  lines of the delivery profile (`profile`, default `docs/ai/delivery.md`) on the default branch. Status moves made
  through labels, by the follow-up or by an agent, then show on the board. Problems are warnings, never failures.
- `chain: false` keeps the handoffs and only stops the dispatches.

What the `follow-up` job decides after each run:

```mermaid
flowchart TD
  task["task job<br/>ai-task action runs the agent"] --> fu["follow-up job, always runs<br/>fresh App token, ai-delivery follow-up"]
  fu --> res{"Task result"}
  res -- "failed, timed out,<br/>or cancelled" --> fail["Handoff with the run URL<br/>implement issue without PR<br/>back to status:ready"]
  res -- "success" --> labels["Read the status labels of the<br/>milestone issues or the scoped issue"]
  labels --> blocked{"Blocked issue, escalated PR,<br/>or implement without PR?"}
  blocked -- "yes" --> hand["One handoff per blocked issue<br/>mentions requested-by"]
  blocked -- "no" --> next{"Next stage<br/>to dispatch?"}
  next -- "none" --> stop["Done"]
  next -- "yes" --> chain{"chain true?"}
  chain -- "no" --> stop
  chain -- "yes" --> back{"Send-back to an earlier refinement<br/>past max-send-backs?"}
  back -- "yes" --> hand
  back -- "no" --> guard{"Stage dispatched more than<br/>max-auto-dispatches times?"}
  guard -- "yes" --> hand
  guard -- "no" --> disp["Count it in the milestone<br/>dispatch the stage caller<br/>on the default branch"]
```

Each handoff is one comment per blocked issue (or a tracking issue `<milestone or source> - <stage>` when there is
none). It mentions the requester, gives the blocker in up to three lines, links the questions (the last comment on
the issue, and the Jira ticket for business refinement), and ends with:

```markdown
Answer where the questions are, then resume.
Reply `/ai-resume` (optionally with instructions on the next lines) to continue: technical-refinement -> readiness-review.
<!-- ai-resume stage=technical-refinement milestone=JIRA:DEV-1 issue=12 pr= requested-by=alice ... workflow=ai-technical-refinement.yml state=open -->
```

plus a collapsed `gh workflow run ...` fallback. An open handoff (`state=open`) for the same stage is never posted
twice.

### Resume

Answer the questions where they were asked, then reply on the issue or pull request with a new comment whose first
line starts with `/ai-resume`:

```text
/ai-resume [stage] [instructions]
more instructions on the next lines
```

The stage is optional. It is a stage name (`business-refinement`, `technical-refinement`, `readiness-review`,
`orchestrate`, `implement`, `pr-fix`, `merge-decision`, `issue-intake`, `issue-resolve`, `dependency-update`) or a skill or agent name a blocker comment
used as its stage (`delivery-orchestration` -> `orchestrate`; `dev`, `quality-cycle`, `task-implementer` ->
`implement`; `issue-resolver` -> `issue-resolve`; `dependency-updater` and `dependency-updates` -> `dependency-update`; and the other task agents); an unknown stage-like word gets a reply
with the valid stages. Anything after it on the first line, plus the following lines, becomes the `instructions` of
the resumed run (appended to its prompt for that run only). `.github/workflows/ai-resume.yml` runs on the
`issue_comment` `created` event. Its job only starts for comments that begin with `/ai-resume`, are not written by
a bot, and come from an `OWNER`, `MEMBER`, or `COLLABORATOR`; the script then checks that the author has write,
maintain, or admin permission. It then:

1. reacts with `eyes` on the command,
2. picks the target: the named stage (its newest handoff here, or the issue or pull request itself when there is
   none), else the newest open handoff posted by the agent App bot (or one of `trusted-bots`). With neither, it
   replies with the list of stages and dispatches nothing,
3. marks the handoff `state=resumed` (`Resumed by @<login>`) before dispatching, so a second command finds nothing
   open; runs are serialized per issue or pull request,
4. removes the escalation label (`ai:needs-human`) of the pull request when the stage is `pr-fix`, posts a
   `<!-- merge-decision redecide -->` comment when it is `merge-decision` (one new decision on the current head even
   when it was decided before), and resets the milestone's automatic dispatch counters,
5. dispatches the stage caller (the workflow named in the marker, else `stage-workflows`) on the default branch with
   `milestone`, `issue`, `jira_key`, `branch`, `base_branch`, or `pr_number`, `requested_by`, and `instructions`,
6. links the run in the handoff (`Resumed by @<login> -> <run link>`), reacts with `rocket`, and replies with the
   run link.

```mermaid
sequenceDiagram
  actor U as Person with write access
  participant GH as Issue or PR
  participant R as ai-resume.yml
  participant D as ai-delivery resume
  participant S as Stage caller
  U->>GH: Comment /ai-resume [stage] [instructions]
  GH->>R: issue_comment created
  R->>R: Prefilter on /ai-resume, not a bot,<br/>OWNER, MEMBER, or COLLABORATOR
  R->>D: Run with the App token
  D->>GH: Check write, maintain, or admin permission
  D->>GH: React eyes
  D->>GH: Pick the named stage or the newest open handoff
  D->>GH: Mark the handoff state=resumed
  D->>GH: Remove ai:needs-human for pr-fix, reset dispatch counters
  D->>S: workflow_dispatch on the default branch with instructions
  D->>GH: Link the run, react rocket, reply with the run link
  alt Rejected or dispatch failed
    D->>GH: Reply with the reason, reopen the handoff on a failed dispatch
  end
```

A rejection (no permission, no open handoff, invalid values) is a reply with the reason. If the dispatch fails, the
handoff is reopened, the reply says so, and the job fails. Handoffs posted with the earlier checkbox resume the same
way. The resumed stage reads the human's answer and the chain continues on its own.

```yaml
# .github/workflows/ai-resume.yml
name: AI Resume

on:
  issue_comment:
    types: [created]

permissions: {}

jobs:
  resume:
    if: ${{ startsWith(github.event.comment.body, '/ai-resume') }}
    uses: fbrissi/github-actions/.github/workflows/ai-resume.yml@v1
    with:
      trusted-bots: my-fixer-app[bot] # the PR Fix App, when it is not the agent App
    secrets:
      AGENT_APP_PRIVATE_KEY: ${{ secrets.AGENT_APP_PRIVATE_KEY }}
```

| Input | Default | Description |
|---|---|---|
| `stage-workflows` | `""` | `stage=file` overrides used when a handoff does not name its workflow (defaults below). |
| `trusted-bots` | `""` | Other bot logins whose handoffs may be resumed, for example the PR Fix App. The agent App's own bot is always trusted. |
| `agent-client-id` | `AGENT_APP_CLIENT_ID` | Client ID of the agent App. |
| `environment` | `""` | Environment of the job. |
| `runs-on` | `CI_RUNNER`, then `ubuntu-latest` | Runner label. |

Secret: `AGENT_APP_PRIVATE_KEY`. The caller needs no `GITHUB_TOKEN` permissions: the App token (`actions`,
`issues`, and `pull-requests` write) dispatches the stage, edits the handoff, and posts the reactions and replies, so
the App needs `Actions`, `Issues`, and `Pull requests` read and write.

### QA in CI

The implement agent runs browser QA (Playwright, or Selenium if the project uses it) when the profile's test
environment is reachable. Install the browsers and start the environment with `setup-command`, which runs after
`install-command` and before the agent; background processes and `docker compose up -d` services stay up for the
agent:

```yaml
      setup-command: |
        npx playwright install --with-deps chromium
        docker compose up -d --wait
```

The workflow passes the `setup-command` to the agent as `test-environment`, so the `implement`, `issue-resolve`, and
`dependency-update` prompts say the environment is already running and QA uses it instead of starting it. Without a `setup-command` and
without a reachable environment, QA runs in tests-only mode: it relies on the automated tests that already run as PR
checks, reports `browser QA skipped: no CI environment`, and never escalates for that reason. Either way the agent runs
the reviewer and QA for every change, documentation included. With `quality-mode: separate` the task runs neither, and
[QA runs in its own workflow](#review-and-qa-in-separate-jobs) with the `setup-command` there instead.

### GitHub App

The App the agent acts as needs the permissions in [Setup from zero](#setup-from-zero). The token handed to the
agent is scoped per task:

| Task | Token permissions |
|---|---|
| `business-refinement`, `technical-refinement`, `readiness-review` | `contents: read`, `issues: write`, `pull-requests: read` |
| `orchestrate` | `contents: write`, `issues: write`, `pull-requests: write`, `actions: write` |
| `implement`, `issue-resolve`, `dependency-update` | `contents: write`, `issues: write`, `pull-requests: write` |
| `issue-intake` | `contents: read`, `issues: write`, `pull-requests: read` |
| any, with `project` | adds `organization-projects: write` |
| any, with `app-token-permission-issue-fields: write` | adds `issue-fields: write` |
| follow-up job | `actions: write`, `contents: read` (the delivery profile), `issues: write`, `pull-requests: read`; with `project`, `organization-projects: write` |

Organization issue field values (for example Priority, Effort, Start date, Target date) need the `issue-fields:
write` token permission. Set `app-token-permission-issue-fields: write` when the profile uses issue fields and the
agent App has the Issue fields permission; without it the agent cannot set them and readiness review sends the
issues back.

Set `project` as a workflow input, not only in the profile, so the token gets the projects permission. Projects
must belong to the organization that owns the repository: App installation tokens cannot reach projects of
a user account or of another organization. The token expires after one hour, so keep `timeout-minutes` under it. It
has no `workflows` permission, so the agent cannot push changes to `.github/workflows/`.

### Callers

Each task gets its own `workflow_dispatch` caller on the default branch, named as in `stage-workflows` (defaults
below). Declare the inputs the follow-up and the resume send, all optional, and pass `requested_by` on. The caller
job only needs `contents: read`; everything the agent does goes through the App token.

| Stage | Default caller | Dispatch inputs |
|---|---|---|
| `business-refinement` | `ai-business-refinement.yml` | `milestone`, `jira_key`, `requested_by` (plus your own `source`) |
| `technical-refinement` | `ai-technical-refinement.yml` | `milestone`, `issue`, `requested_by` |
| `readiness-review` | `ai-readiness-review.yml` | `milestone`, `issue`, `requested_by` |
| `orchestrate` | `ai-orchestrate.yml` | `milestone`, `requested_by` |
| `implement` | `ai-implement.yml` | `issue`, `branch`, `base_branch`, `requested_by` |
| `pr-fix` | `pr-fix.yml` | `pr_number` |
| `issue-intake` | `ai-issue-intake.yml` | `requested_by` |
| `issue-resolve` | `ai-issue-resolve.yml` | `issue`, `requested_by` |
| `dependency-update` | `ai-dependency-update.yml` | `requested_by` |

Declare an optional `instructions` input too and pass it to the reusable workflow (`instructions:
${{ inputs.instructions }}`): an `/ai-resume` command sends it, and a person can set it when running the caller by
hand. Chained dispatches never send it.

```yaml
# .github/workflows/ai-business-refinement.yml
name: AI Business Refinement

on:
  workflow_dispatch:
    inputs:
      source:
        description: Source ticket (Jira key or URL, GitHub issue, or milestone)
        required: false
        type: string
      jira_key:
        description: Jira key (set by the flow)
        required: false
        type: string
      milestone:
        description: GitHub milestone (set by the flow)
        required: false
        type: string
      requested_by:
        description: Person to mention when the flow needs a human
        required: false
        type: string
      instructions:
        description: Extra instructions for this run only
        required: false
        type: string

permissions: {}

jobs:
  refine:
    uses: fbrissi/github-actions/.github/workflows/ai-task.yml@v1
    permissions:
      contents: read
    with:
      task: business-refinement
      source: ${{ inputs.source || inputs.jira_key || inputs.milestone }}
      source-tracker: jira
      milestone-template: JIRA:{key}
      requested-by: ${{ inputs.requested_by }}
      instructions: ${{ inputs.instructions }}
    secrets:
      AGENT_APP_PRIVATE_KEY: ${{ secrets.AGENT_APP_PRIVATE_KEY }}
      ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
      CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
      JIRA_EMAIL: ${{ secrets.JIRA_EMAIL }}
      JIRA_API_TOKEN: ${{ secrets.JIRA_API_TOKEN }}
```

Set `milestone-template` in every caller (or in the profile) when milestones are named after Jira keys, so the
follow-up can find the milestone a business refinement created and send `jira_key` back to it.

Technical refinement, readiness review, and orchestration take a milestone (refinement and readiness also an
issue); only the `task` differs, and orchestration declares no `issue`:

```yaml
# .github/workflows/ai-technical-refinement.yml (and ai-readiness-review.yml, ai-orchestrate.yml)
name: AI Technical Refinement

on:
  workflow_dispatch:
    inputs:
      milestone:
        description: GitHub milestone
        required: false
        type: string
      issue:
        description: Issue number (only this issue)
        required: false
        type: string
      requested_by:
        description: Person to mention when the flow needs a human
        required: false
        type: string
      instructions:
        description: Extra instructions for this run only
        required: false
        type: string

permissions: {}

jobs:
  task:
    uses: fbrissi/github-actions/.github/workflows/ai-task.yml@v1
    permissions:
      contents: read
    with:
      task: technical-refinement # readiness-review, orchestrate
      milestone: ${{ inputs.milestone }}
      issue: ${{ inputs.issue }}
      milestone-template: JIRA:{key}
      requested-by: ${{ inputs.requested_by }}
      instructions: ${{ inputs.instructions }}
      node-version: "24"
      install-command: npm ci
    secrets:
      AGENT_APP_PRIVATE_KEY: ${{ secrets.AGENT_APP_PRIVATE_KEY }}
      ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
      CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
```

The orchestrator dispatches the implement caller (`implement-workflow`, default `ai-implement.yml`) with the inputs
`issue`, `branch`, and `base_branch`:

```yaml
# .github/workflows/ai-implement.yml
name: AI Implement

on:
  workflow_dispatch:
    inputs:
      issue:
        description: Issue number
        required: true
        type: string
      branch:
        description: Task branch
        required: true
        type: string
      base_branch:
        description: Milestone branch the PR targets
        required: true
        type: string
      requested_by:
        description: Person to mention when the flow needs a human
        required: false
        type: string
      instructions:
        description: Extra instructions for this run only
        required: false
        type: string

permissions: {}

jobs:
  implement:
    uses: fbrissi/github-actions/.github/workflows/ai-task.yml@v1
    permissions:
      contents: read
    with:
      task: implement
      issue: ${{ inputs.issue }}
      branch: ${{ inputs.branch }}
      base-branch: ${{ inputs.base_branch }}
      requested-by: ${{ inputs.requested_by }}
      instructions: ${{ inputs.instructions }}
      node-version: "24"
      install-command: npm ci
      dependency-cache-path: node_modules
      setup-command: npx playwright install --with-deps chromium
    secrets:
      AGENT_APP_PRIVATE_KEY: ${{ secrets.AGENT_APP_PRIVATE_KEY }}
      ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
      CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
```

Re-run the orchestrator each time a task PR (`feature/*`) or a bugfix PR (`bugfix/*`, which may be the only work of a
release opened for it) merges into a release branch, so it starts the next issues or completes the release,
and when the release PR (`release/*`) merges into the default branch, so it finishes the milestone. The milestone
comes from the PR, or from the issues it closes (see [Branch model](#branch-model)):

```yaml
# .github/workflows/ai-orchestrate-on-merge.yml
name: AI Orchestrate on Merge

on:
  pull_request:
    types: [closed]
    branches: ["release/**", main]

permissions: {}

jobs:
  dispatch:
    if: >-
      ${{ github.event.pull_request.merged == true && (
      ((startsWith(github.event.pull_request.head.ref, 'feature/') || startsWith(github.event.pull_request.head.ref, 'bugfix/'))
      && startsWith(github.event.pull_request.base.ref, 'release/'))
      || (startsWith(github.event.pull_request.head.ref, 'release/') && github.event.pull_request.base.ref == 'main')) }}
    runs-on: ubuntu-latest
    permissions:
      actions: write
      issues: read
      pull-requests: read
    steps:
      - uses: actions/github-script@v9
        with:
          script: |
            const pr = context.payload.pull_request;
            let milestone = pr.milestone?.title;
            if (!milestone) {
              const { repository } = await github.graphql(
                `query($owner: String!, $repo: String!, $number: Int!) {
                  repository(owner: $owner, name: $repo) {
                    pullRequest(number: $number) {
                      closingIssuesReferences(first: 10) { nodes { milestone { title } } }
                    }
                  }
                }`,
                { owner: context.repo.owner, repo: context.repo.repo, number: pr.number },
              );
              milestone = repository.pullRequest.closingIssuesReferences.nodes
                .map((issue) => issue.milestone?.title)
                .find(Boolean);
            }
            if (!milestone) {
              core.notice(`PR #${pr.number} has no milestone; orchestrate was not dispatched.`);
              return;
            }
            await github.rest.actions.createWorkflowDispatch({
              owner: context.repo.owner,
              repo: context.repo.repo,
              workflow_id: 'ai-orchestrate.yml',
              ref: context.payload.repository.default_branch,
              inputs: { milestone },
            });
```

Merges made with `GITHUB_TOKEN` do not trigger `pull_request` workflows, so this only fires for PRs merged by a
GitHub App (such as the merge App) or a person. A `workflow_dispatch` sent with `GITHUB_TOKEN`, as above, does
start the orchestrator.

### Branch model

The examples use this model; the concrete names (templates, the release of a bugfix) live in the repository profiles
of fbrissi/ai-skills.

| Branch | From | Pull request into | Purpose |
|---|---|---|---|
| `feature/*` | a `release/*` | that `release/*` | New work: one task of a milestone. |
| `release/*` | `main` | `main` | A release being prepared; in the delivery flow, the milestone (aggregating) branch. |
| `hotfix/*` | `main` | `main` | Urgent production fix. |
| `bugfix/*` | the open `release/*` | that `release/*` | Non-urgent production bug; with no open release, the flow opens one. |
| `develop` | `main` | – | Optional backup of `main`, fast-forwarded by [Branch Sync](#branch-sync). |

`main` is the default branch. Prefixes are plain `startsWith` matches and the inputs take any list, so callers that
still have open branches with older prefixes (for example `feat/`) can keep them next to the new ones until those
branches are merged.

### PR follow-up for task branches

Task PRs (`feature/*` into `release/*`), release PRs (`release/*` into `main`), and fix PRs (`hotfix/*` into `main`,
`bugfix/*` into a `release/*`) go through the [PR Feedback Loop](#pr-feedback-loop):

```yaml
# .github/workflows/pr-fix.yml
jobs:
  pr-fix:
    uses: fbrissi/github-actions/.github/workflows/pr-fix.yml@v1
    permissions:
      checks: write
      issues: read
      pull-requests: read
    with:
      pr-number: ${{ inputs.pr_number }}
      branch-prefixes: feature/ release/ hotfix/ bugfix/
      instructions: ${{ inputs.instructions }}
    secrets: inherit
```

```yaml
# .github/workflows/merge-decision.yml
jobs:
  merge-decision:
    uses: fbrissi/github-actions/.github/workflows/merge-decision.yml@v1
    permissions:
      actions: read
      checks: read
      contents: read
      issues: read
      pull-requests: read
      statuses: read
    with:
      pr-number: ${{ inputs.pr_number }}
      branch-prefixes: feature/ release/ hotfix/ bugfix/
      # PRs into a release branch opened by the agent App merge on the AI review, green CI, and a low merge-risk
      # rating; PRs by people, and every PR into main (release and hotfix), still need one human approval.
      human-approval-exempt-base-prefixes: release/
      human-approval-exempt-authors: my-agent[bot]
      auto-merge: true
      instructions: ${{ inputs.instructions }}
    secrets: inherit
```

Keep the [PR Feedback Dispatch](#pr-feedback-dispatch) caller and the Code Review caller as they are. When a
release or hotfix PR waits for its approval, Merge Decision requests a review from the requester and mentions them once;
their approval dispatches the decision again. When PR Fix escalates, its handoff offers a `pr-fix` resume.

### Issue intake and resolve

Two more tasks run the `issue-resolver` agent of fbrissi/ai-skills, which resolves issues that come from a source
skill (by default `sentry-issues`). They are `ai-task.yml` tasks rather than a separate workflow, so they get the
same App token, checkout, dependency setup, harness, requester, `instructions`, and failure handoff:

| Task | Mode | Input | What it does |
|---|---|---|---|
| `issue-intake` | `intake` | – | Reads the source (for example unresolved Sentry issues filtered by the profile), deduplicates against existing GitHub issues, creates or updates one GitHub issue per source issue with a severity decision and the `ai:resolve` label, and stops. Never changes code. |
| `issue-resolve` | `resolve` | `issue` | Fixes one issue: branch (`hotfix/*` into the default branch when critical, else `bugfix/*` into the open `release/*`, per the profile; with none, it opens a release: a milestone named after the next version, its `release/*` branch, and the issue moved into it), change, quality cycle, pull request, then stops. |

```mermaid
flowchart LR
  cron["Weekly schedule<br/>or manual run"] --> intake["ai-issue-intake.yml<br/>task issue-intake"]
  intake --> src["Read the source<br/>for example Sentry<br/>dedupe against issues"]
  src --> gi["Create or update one issue<br/>with severity and ai:resolve"]
  gi -- "issues labeled" --> resolve["ai-issue-resolve.yml<br/>task issue-resolve"]
  person["Person adds ai:resolve"] --> resolve
  resolve --> crit{"Critical?"}
  crit -- "yes" --> hf["hotfix/* PR<br/>into the default branch"]
  crit -- "no" --> bf["bugfix/* PR<br/>into the open release/*<br/>(opened when none is open)"]
  hf --> loop["PR Feedback Loop"]
  bf --> loop
  intake -. "failed run" .-> ho["Handoff with a resume"]
  resolve -. "failed run" .-> ho
```

Neither waits for anything: the pull request it opens goes through the [PR Feedback Loop](#pr-feedback-loop)
(`pr-fix.yml` and `merge-decision.yml`, triggered by review and check events). A failed or timed-out run hands off on
the issue (or a tracking issue for the intake) with an `issue-intake` or `issue-resolve` resume, and so does an
`issue-resolve` run that left its issue open with no open pull request referencing it and no `ai-delivery blocker`
comment since it was created. Sentry credentials
are optional: the `SENTRY_AUTH_TOKEN` secret, plus `SENTRY_ORG` and `SENTRY_BASE_URL` (variables or the
`sentry-org` and `sentry-base-url` inputs). Create the `ai:resolve` label once:
`gh label create ai:resolve --force`.

A weekly intake caller:

```yaml
# .github/workflows/ai-issue-intake.yml
name: AI Issue Intake

on:
  schedule:
    - cron: "0 6 * * 1"
  workflow_dispatch:
    inputs:
      requested_by:
        description: Person to mention when the flow needs a human
        required: false
        type: string
      instructions:
        description: Extra instructions for this run only
        required: false
        type: string

permissions: {}

jobs:
  intake:
    uses: fbrissi/github-actions/.github/workflows/ai-task.yml@v1
    permissions:
      contents: read
    with:
      task: issue-intake
      requested-by: ${{ inputs.requested_by }}
      instructions: ${{ inputs.instructions }}
    secrets:
      AGENT_APP_PRIVATE_KEY: ${{ secrets.AGENT_APP_PRIVATE_KEY }}
      ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
      CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
      SENTRY_AUTH_TOKEN: ${{ secrets.SENTRY_AUTH_TOKEN }}
```

A resolve caller that runs when an issue gets the `ai:resolve` label (from the intake, whose App token does trigger
workflows, or from a person with triage access), and on dispatch for resumes:

```yaml
# .github/workflows/ai-issue-resolve.yml
name: AI Issue Resolve

on:
  issues:
    types: [labeled]
  workflow_dispatch:
    inputs:
      issue:
        description: Issue number
        required: true
        type: string
      requested_by:
        description: Person to mention when the flow needs a human
        required: false
        type: string
      instructions:
        description: Extra instructions for this run only
        required: false
        type: string

permissions: {}

jobs:
  resolve:
    if: ${{ github.event_name == 'workflow_dispatch' || github.event.label.name == 'ai:resolve' }}
    uses: fbrissi/github-actions/.github/workflows/ai-task.yml@v1
    permissions:
      contents: read
    with:
      task: issue-resolve
      issue: ${{ inputs.issue || github.event.issue.number }}
      requested-by: ${{ inputs.requested_by }}
      instructions: ${{ inputs.instructions }}
      node-version: "24"
      install-command: npm ci
    secrets:
      AGENT_APP_PRIVATE_KEY: ${{ secrets.AGENT_APP_PRIVATE_KEY }}
      ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
      CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
      SENTRY_AUTH_TOKEN: ${{ secrets.SENTRY_AUTH_TOKEN }}
```

Keep `timeout-minutes` at `50` or less (the default): the App token expires after one hour.

### Dependency updates

The `dependency-update` task runs the `dependency-updater` agent of fbrissi/ai-skills with the `dependency-updates`
skill: it takes the open Dependabot (or Renovate) pull requests into the base branch, outdated packages when the
profile (`docs/ai/dependency-updates.md`) asks, and the open advisories; reads each package's release notes and upgrade
guide, adapts the code, holds back what cannot be adopted safely, and runs the checks and the review and QA cycle
(with the `setup-command` environment when given). It branches like `issue-resolve`: updates that fix a high or
critical advisory on the version in use (or that a person labeled with the hotfix label) go to
`hotfix/dependency-updates-<date>` with a pull request into the base branch; the rest go to
`bugfix/dependency-updates-<date>` into the delivery profile's `Bugfix release branch`, else the oldest open release
branch. When there is none, it opens one: a milestone named after the next version, its release branch from the base
branch, and a `Dependency updates <date>` tracking issue the pull request closes; the orchestrator completes that
release once the pull request merges (see [Callers](#callers): the orchestrate-on-merge caller must accept `bugfix/`
heads). Only when the release branch cannot be created do the updates wait for a later run (reported, no blocker). Each pull request lists the packages, the
breaking changes and their handling, the held packages, and `Supersedes #<n>` for the bot pull requests it covers; a
later run updates the open pull request of its kind. It never closes, merges, approves, comments on, or pushes to the
bot pull requests; they close themselves once the updates reach the base branch.

```mermaid
flowchart LR
  bots["Dependabot / Renovate<br/>pull requests, advisories"] --> cron["Weekly schedule after the bots<br/>or manual run"]
  cron --> run["ai-dependency-update.yml<br/>task dependency-update"]
  run -- "high or critical advisory" --> hf["hotfix/* pull request<br/>into the base branch"]
  run -- "other updates" --> bf["bugfix/* pull request<br/>into the open release branch"]
  run -. "no release branch" .-> open["Open a release:<br/>milestone, release branch, issue"]
  open --> bf
  open -. "branch refused" .-> wait["Wait for a later run"]
  hf --> loop["PR Feedback Loop"]
  bf --> loop
  run -. "failed run" .-> ho["Handoff with a resume"]
```

Like the other tasks it stops at the pull requests: the [PR Feedback Loop](#pr-feedback-loop) takes over (the
`hotfix/` and `bugfix/` prefixes already opt them in). A repository without release branches sets `Bugfix release
branch: base` in its profile, so the non-urgent updates also go to the base branch. A failed run hands off on a
tracking issue with a `dependency-update` resume. Schedule it after the bots, and give it the same dependency setup as `implement` so checks and QA can run:

```yaml
# .github/workflows/ai-dependency-update.yml
name: AI Dependency Update

on:
  schedule:
    - cron: "0 12 * * 1"
  workflow_dispatch:
    inputs:
      requested_by:
        description: Person to mention when the flow needs a human
        required: false
        type: string
      instructions:
        description: Extra instructions for this run only
        required: false
        type: string

permissions: {}

jobs:
  dependency-update:
    uses: fbrissi/github-actions/.github/workflows/ai-task.yml@v1
    permissions:
      contents: read
    with:
      task: dependency-update
      requested-by: ${{ inputs.requested_by }}
      instructions: ${{ inputs.instructions }}
      node-version: "24"
      install-command: npm ci
      setup-command: |
        npx playwright install --with-deps chromium
        docker compose up -d --wait
    secrets:
      AGENT_APP_PRIVATE_KEY: ${{ secrets.AGENT_APP_PRIVATE_KEY }}
      ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
      CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
```

### Inputs

Task parameters are the [`ai-task` action inputs](actions/ai-task/README.md#inputs) under the same names: `task`,
`source`, `source-tracker`, `source-language`, `milestone`, `issue`, `branch`, `base-branch`, `milestone-template`,
`output-language`, `status-labels`, `project`, `project-status-field`, `project-status-options`, `research-sources`, `instructions`, `context` (deprecated alias), `profile`,
`implement-workflow`, `max-parallel`, `skills`, `agents`, and `ai-skills-ref` (default `v0.11.0`). The workflow adds:

| Input | Default | Description |
|---|---|---|
| `requested-by` | `github.triggering_actor` | Person mentioned when the flow needs a human, stored in the milestone and passed on to every chained stage. Bots fall back to the milestone marker. |
| `chain` | `true` | Dispatch the next stage after the run. When false the follow-up only hands off. |
| `stage-workflows` | `""` | Multiline `stage=file` overrides of the stage callers. Defaults: `business-refinement=ai-business-refinement.yml`, `technical-refinement=ai-technical-refinement.yml`, `readiness-review=ai-readiness-review.yml`, `orchestrate=ai-orchestrate.yml`, `implement=ai-implement.yml`, `pr-fix=pr-fix.yml`, `issue-intake=ai-issue-intake.yml`, `issue-resolve=ai-issue-resolve.yml`, `dependency-update=ai-dependency-update.yml`. |
| `max-auto-dispatches` | `3` | Automatic dispatches of one stage per milestone before the follow-up hands off instead. |
| `max-send-backs` | `3` | Send-backs per milestone to an earlier refinement stage (readiness review or technical refinement back to a refinement) before the follow-up hands off to the requester instead. |
| `app-token-permission-issue-fields` | `""` | Set to `write` so the agent can set organization issue fields (Priority, Effort, dates). The agent App must have the Issue fields permission. |
| `setup-command` | `""` | Runs after `install-command` and before the agent, for example to install browsers and start the test environment. |
| `quality-mode` | `cycle` | `implement`, `issue-resolve`, and `dependency-update`: `cycle` runs the reviewer and QA in the task; `separate` only develops and opens the pull request for [Review and QA in separate jobs](#review-and-qa-in-separate-jobs). Leave `setup-command` empty with `separate`. |
| `harness`, `opencode-model`, `opencode-variant`, `claude-model`, `claude-effort` | see [Variables](#variables) | Harness and model, like every AI workflow. |
| `jira-base-url` | `JIRA_BASE_URL` | Jira base URL; Jira is used only with the `JIRA_EMAIL` and `JIRA_API_TOKEN` secrets. |
| `sentry-org`, `sentry-base-url` | `SENTRY_ORG`, `SENTRY_BASE_URL` | Sentry organization and base URL (self-hosted), exported to the agent. |
| `agent-client-id` | `AGENT_APP_CLIENT_ID` | Client ID of the GitHub App the agent acts as. |
| `environment` | `""` | Environment of the task and follow-up jobs; empty runs without one. |
| `runs-on` | `CI_RUNNER`, then `ubuntu-latest` | Runner label. |
| `timeout-minutes` | `50` | Harness run timeout; keep it under the one-hour App token lifetime. |
| `job-timeout-minutes` | `60` | Task job timeout. |
| `node-version` | `""` | Node.js version for actions/setup-node; empty skips it. |
| `node-cache` | `""` | `npm`, `yarn`, or `pnpm` cache for actions/setup-node. Only used with `save-dependency-cache`. |
| `install-command` | `""` | Dependency install command; empty skips it. |
| `dependency-cache-path` | `""` | Paths cached around `install-command`. |
| `dependency-cache-prefix` | `ai-task-deps-v1` | Cache key prefix; the key is `<prefix>-<os>-<arch>-<hash>`. |
| `dependency-cache-files` | `**/{package-lock.json,yarn.lock,pnpm-lock.yaml}` | Files hashed into the cache key. |
| `save-dependency-cache` | `false` | Save the cache after installing. |

### Secrets

| Secret | Required | Description |
|---|---|---|
| `AGENT_APP_PRIVATE_KEY` | yes | Private key of the GitHub App the agent acts as. |
| `OPEN_AI_TOKEN` | `opencode` with an `openai/` model | OpenAI API key. |
| `ANTHROPIC_API_KEY` | `claude`: this or the next | Anthropic API key. |
| `CLAUDE_CODE_OAUTH_TOKEN` | `claude`: this or the previous | Claude Code OAuth token, used when `ANTHROPIC_API_KEY` is empty. |
| `JIRA_EMAIL`, `JIRA_API_TOKEN` | Jira sources | Jira credentials, masked and exported to the agent as `JIRA_EMAIL` and `JIRA_API_TOKEN`. |
| `SENTRY_AUTH_TOKEN` | Sentry sources | Sentry auth token, masked and exported to the agent as `SENTRY_AUTH_TOKEN` (with `SENTRY_ORG` and `SENTRY_BASE_URL`). |

With `opencode`, the task's agents are the OpenCode agents of the same names from `fbrissi/ai-skills`
(`plugins/ai-skills/opencode/agent`). Outputs: `agent`, the agent that ran the task, and `milestone`, the milestone the agent reported it created or
worked on.

## Branch Sync

`.github/workflows/branch-sync.yml` keeps a branch as a fast-forward copy of another, for example `develop` as a
backup of `main` that keeps driving sandbox deploys. On each run it fast-forwards `target` to the head of `source`
(creating `target` when it does not exist) and never force-pushes. When `target` has commits that `source` does not,
it opens one issue (`Branch sync: <target> cannot fast-forward to <source>`, found again by a
`<!-- branch-sync source=... target=... -->` marker) that mentions the person who pushed and `mention`, or comments on
it when it is already open; the next successful sync closes it.

```mermaid
flowchart TD
  push["Push to source<br/>for example main"] --> sync["branch-sync.yml"]
  sync --> exists{"Target exists?"}
  exists -- "no" --> create["Create target at the source head<br/>created"]
  exists -- "yes" --> ff{"Can target<br/>fast-forward?"}
  ff -- "already at source" --> up["up-to-date"]
  ff -- "yes" --> upd["Fast-forward with the App token<br/>updated"]
  ff -- "no, target has<br/>its own commits" --> div["diverged"]
  upd -- "update refused" --> blk["blocked"]
  div --> issue["Open or comment on one issue<br/>mention the pusher and mention"]
  blk --> issue
  create --> close["Close the open<br/>sync issue, if any"]
  up --> close
  upd --> close
```

```yaml
# .github/workflows/branch-sync.yml
name: Branch Sync

on:
  push:
    branches: [main]

permissions: {}

jobs:
  sync:
    uses: fbrissi/github-actions/.github/workflows/branch-sync.yml@v1
    permissions:
      contents: write
      issues: write
    with:
      source: main
      target: develop
    secrets:
      AGENT_APP_PRIVATE_KEY: ${{ secrets.AGENT_APP_PRIVATE_KEY }}
```

With a GitHub App (`AGENT_APP_CLIENT_ID` and `AGENT_APP_PRIVATE_KEY`, with `Contents` and `Issues` read and write and
allowed to push to `target`), the update triggers the workflows of `target`, such as its deploy; without one it
falls back to `GITHUB_TOKEN`, whose pushes trigger no workflows.

| Input | Default | Description |
|---|---|---|
| `source` | `main` | Branch the target follows. |
| `target` | `develop` | Branch fast-forwarded to `source`. |
| `mention` | `""` | Logins also mentioned on divergence (bots are never mentioned). |
| `agent-client-id` | `AGENT_APP_CLIENT_ID` | Client ID of the App that updates the target. |
| `runs-on` | `CI_RUNNER`, then `ubuntu-latest` | Runner label. |
| `app-token-permission-workflows` | `""` | Set to `write` when the App has `Workflows: Read and write`, so commits that change `.github/workflows/**` are fast-forwarded. Empty does not request it. |

Secret: `AGENT_APP_PRIVATE_KEY` (optional). Output: `result` (`updated`, `created`, `up-to-date`, `diverged`, or
`blocked`). `blocked` means GitHub refused the update, usually a commit that changes `.github/workflows/**` without
the `Workflows` permission, or a branch rule the App cannot bypass; it is reported in the same issue.
Runs are serialized per target branch.

## Release Note

`.github/workflows/release-note.yml` runs on `pull_request` and fails unless the pull request adds exactly one
`## vX.Y.Z` heading to the changelog, as its first release heading, with non-empty notes and no existing tag. With
`exempt-paths`, a pull request that only changes matching paths (for example documentation, agent configuration, and
CI) and adds no heading passes with an empty `version`; one that adds a heading is still validated.

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
| `exempt-paths` | `""` | Whitespace-separated path globs (shell `case` patterns; `*` also matches `/`) that need no release note, for example `*.md docs/* .ai/* .github/*`. Empty exempts nothing. |
| `runs-on` | `CI_RUNNER`, then `ubuntu-latest` | Runner label. |

Output: `version`, the release added by the pull request (empty for an exempt pull request).

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
| `runs-on` | `CI_RUNNER`, then `ubuntu-latest` | Runner label of every job. |

Secret: `TFC_API_TOKEN` (required with `tfc-workspace`). Outputs: `version`, `skipped`.

## Terraform Permissions

`.github/workflows/terraform-permissions.yml` compares the Cloudflare API token Terraform uses with the calling
repository's permission manifest, so a new resource type that needs a permission the token lacks fails in CI instead
of in the HCP Terraform apply after merge. See [`terraform-permissions`](actions/terraform-permissions/README.md) for
the manifest format, the checks, and their limits.

```yaml
  terraform-permissions:
    name: Terraform / Cloudflare token permissions
    uses: fbrissi/github-actions/.github/workflows/terraform-permissions.yml@v1
    permissions:
      contents: read
    with:
      change-pattern: '^(terraform/|\.github/workflows/quality-checks\.yml$)'
    secrets:
      CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
```

Call it from a `pull_request` workflow (never `pull_request_target`) that also runs on pushes to the default branch,
and make it required: do not merge while it is red, because the release apply would fail the same way.

| Input | Default | Description |
|---|---|---|
| `manifest` | `terraform/cloudflare-token-permissions.json` | Permission manifest path. |
| `terraform-directory` | `terraform` | Directory scanned for `*.tf` files. |
| `mode` | `auto` | `auto` runs the live check on pull requests changing `change-pattern`, default-branch pushes, and other events; `static` or `live` force one. |
| `change-pattern` | `^terraform/` | Extended regex matched against the files a pull request changes. |
| `runs-on` | `CI_RUNNER`, then `ubuntu-latest` | Runner label. |

| Secret | Description |
|---|---|
| `CLOUDFLARE_API_TOKEN` | The Terraform Cloudflare token. Fork and Dependabot pull requests have none and get a "not checked" warning; any other run without it fails. |

## Social Content

Three reusable workflows run the social content flow of `fbrissi/ai-skills` (`v0.14.0`, `docs/social-content.md`
there): an agent per platform (`facebook-content`, `instagram-content`, `youtube-content`, `linkedin-content`) generates a batch and opens
a review issue, writers ask for changes with `/adjust` or approve with `/aprove`, and deterministic publishers (no
LLM) schedule or publish the approved batch. Everything project-specific lives in the caller's profile
(`docs/ai/social-content.md`, from the ai-skills `social-profile-template.md`) and its secrets.

```mermaid
flowchart LR
  C["weekly cron"] --> G["social-content-generate.yml<br/>one job per platform"]
  G --> A["agent generate:<br/>plan, copy, media, guard,<br/>Drive upload, review issue"]
  A -. "no issue opened" .-> F["open-review fallback:<br/>guard, validate, upload, issue"]
  A --> I{"review issue<br/>label + manifest marker"}
  F --> I
  I -->|"/adjust id: change"| J["social-content-adjust.yml<br/>agent adjust issue"]
  J --> I
  I -->|"/aprove"| P["social-content-publish.yml"]
  P -->|"Facebook, YouTube"| S["schedule natively now"]
  P -->|"Instagram"| M["mark approved"]
  K["Instagram cron"] --> P2["social-content-publish.yml<br/>sweep"] --> Q["publish due items,<br/>save state, close when done"]
```

The review issue is the batch's durable record: its first line is `<!-- social-content:batch platform=<p>
batch=<id> revision=<n> -->` and its last line the gzip and base64 manifest marker, which holds the publishing state
after every run (Drive holds the media). Only comments that start with the command and then a space or the end count,
from people (never bots) whose `GET /repos/{owner}/{repo}/collaborators/{user}/permission` is `write`, `maintain`, or
`admin`, on an open issue with the label and a consistent header and marker. Permission is the API's `role_name` (or
`permission`), as in the ai-skills scripts, so a custom repository role does not count as write access.

Concurrency and the issue body:

- Adjust, approve, and manual publish runs of one issue share the group `fbrissi-social-content-<repo>-<issue>` with
  `cancel-in-progress: false`, so human commands run one at a time and the gate checks each one again when it starts.
- Scheduled Instagram sweeps use their own group, `fbrissi-social-content-sweep-<repo>-<issue>`, so a sweep never
  displaces a waiting command; a missed sweep is picked up by the next one.
- Because a sweep can overlap an adjust or approve, the publish workflow re-reads the body just before writing its
  state. On the same batch revision it merges per item id, keeping entries another run wrote and taking only those this
  run changed. When the revision moved (an adjust bumped it) it writes nothing and comments this run's results as a
  note, so nothing published is lost; check those items before approving the new revision.
- An adjust never overlaps a publisher run: its gate, inside the issue group, refuses `/adjust` on a batch that is
  approved or has an item `scheduled`, `published`, or `unknown`, and replies that the changes belong in a new batch.
  Sweeps publish only approved batches, and an approval cannot land while an adjust runs (same group), so the agent
  never rewrites a body a publisher may be writing.
- GitHub keeps one waiting job per group, and a newer one cancels it without a comment. Two quick commands on one issue
  can therefore drop the first. A dropped `/adjust` is not lost: the next adjust reads every `/adjust` comment since the
  last revision. A dropped `/aprove` must be repeated (an `/adjust` after it starts a new revision anyway).

### Generate

`social-content-generate.yml` runs one job per platform. Each job installs Node.js 24, ffmpeg and Piper TTS (`video`,
always for YouTube; image cards render in Docker), restores the `.cache/image-cards` and `.cache/video-shorts` cache,
and runs the platform agent through `ai-harness` in `generate` mode with the skills `social-content-plan copy-guard
image-cards social-review` (plus `video-shorts`, and `extra-skills`). The agent uploads to Drive under
`<drive root>/<Platform>/<date>/` and opens the issue. The agent step has `continue-on-error`: a deterministic step
then opens the issue for each batch the agent wrote in this run that no open issue tracks, only after the copy guard
and validation pass. The job fails when the agent failed and left no batch, or when a batch cannot be opened.

```yaml
# .github/workflows/social-content.yml
name: Social Content

on:
  schedule:
    - cron: "0 12 * * 5" # Friday 9:00 in America/Sao_Paulo
  workflow_dispatch:
    inputs:
      start:
        description: First date of the batch (YYYY-MM-DD); empty takes next week.
        required: false
        type: string
      platforms:
        description: Platforms to generate.
        required: false
        type: string
        default: facebook instagram youtube

permissions: {}

jobs:
  generate:
    uses: fbrissi/github-actions/.github/workflows/social-content-generate.yml@v1
    permissions:
      contents: read
      issues: write
    with:
      platforms: ${{ inputs.platforms || 'facebook instagram youtube' }}
      start: ${{ inputs.start }}
    secrets:
      CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
      GOOGLE_DRIVE_CLIENT_SECRET: ${{ secrets.GOOGLE_DRIVE_CLIENT_SECRET }}
      GOOGLE_DRIVE_REFRESH_TOKEN: ${{ secrets.GOOGLE_DRIVE_REFRESH_TOKEN }}
```

| Input | Default | Description |
|---|---|---|
| `platforms` | `facebook instagram youtube` | Platforms, one job each (spaces or commas): `facebook`, `instagram`, `youtube`, `linkedin`. Add `linkedin` once the LinkedIn app has the Community Management API. |
| `start` | `""` | First date of the batch, `YYYY-MM-DD`; empty takes the next week in the profile time zone. |
| `profile` | `docs/ai/social-content.md` | Profile with the context and the `## Parameters` block. |
| `label` | `marketing-content` | Review issue label; keep it equal to the profile's `review.label`. |
| `drive-root` | `""` | Drive root folder; empty uses the profile's `review.drive_root`. |
| `instructions` | `""` | Extra instructions for this run. |
| `video` | `true` | Video tools and `video-shorts` for Facebook and Instagram; YouTube always gets them. |
| `extra-skills` | `""` | Optional skills the agents use when installed, for example `copywriting social remotion-best-practices ffmpeg dev`. |
| `skills-ref` | `v0.14.0` | fbrissi/ai-skills tag or SHA. |
| `harness`, `opencode-model`, `opencode-variant`, `claude-model`, `claude-effort` | variables | See [Variables](#variables). |
| `timeout-minutes` / `job-timeout-minutes` | `90` / `120` | Agent and job timeouts. |
| `agent-client-id` | `AGENT_APP_CLIENT_ID` | Optional GitHub App; without it (or its key) the job uses `GITHUB_TOKEN`. |
| `google-drive-client-id` | `GOOGLE_DRIVE_CLIENT_ID` variable, then secret | Google OAuth client ID of the Drive app. |
| `environment` | `""` | Environment of the platform jobs. |
| `runs-on` | `CI_RUNNER`, then `ubuntu-latest` | Runner label; needs Docker, apt, and Python 3.10+. |

Secrets: `GOOGLE_DRIVE_CLIENT_SECRET` and `GOOGLE_DRIVE_REFRESH_TOKEN` (scope `drive.file`, required); `ANTHROPIC_API_KEY`
or `CLAUDE_CODE_OAUTH_TOKEN` for `claude`, `OPEN_AI_TOKEN` for an `openai/` OpenCode model; optional
`GOOGLE_DRIVE_CLIENT_ID`, `GOOGLE_API_KEY` (public music folder), and `AGENT_APP_PRIVATE_KEY`.

### Adjust

`social-content-adjust.yml` runs on the `issue_comment` `created` event. Inside the issue's concurrency group it runs
the gate (which also refuses an approved or partly published batch, with a reply), then the platform agent of the issue's header in `adjust <issue>` mode, which regenerates only the items the
writers' `/adjust <id>: <request>` comments name, bumps the revision, uploads, edits the body, and posts a revision
comment. The workflow then comments whether a new revision came out, none did, or the run failed (the job fails too).

```yaml
# .github/workflows/social-content-adjust.yml
name: Social Content Adjust

on:
  issue_comment:
    types: [created]

permissions: {}

jobs:
  adjust:
    if: >-
      ${{ !github.event.issue.pull_request
      && startsWith(github.event.comment.body, '/adjust')
      && contains(github.event.issue.labels.*.name, 'marketing-content')
      && github.event.comment.user.type != 'Bot'
      && contains(fromJSON('["OWNER", "MEMBER", "COLLABORATOR"]'), github.event.comment.author_association) }}
    uses: fbrissi/github-actions/.github/workflows/social-content-adjust.yml@v1
    permissions:
      contents: read
      issues: write
    secrets:
      CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
      GOOGLE_DRIVE_CLIENT_SECRET: ${{ secrets.GOOGLE_DRIVE_CLIENT_SECRET }}
      GOOGLE_DRIVE_REFRESH_TOKEN: ${{ secrets.GOOGLE_DRIVE_REFRESH_TOKEN }}
```

Inputs: `command` (default `/adjust`, keep it equal to `review.commands.adjust`), and `profile`, `label`, `drive-root`,
`instructions`, `video`, `extra-skills`, `skills-ref`, the harness and model inputs, `timeout-minutes` (60),
`job-timeout-minutes` (90), `agent-client-id`, `google-drive-client-id`, `environment`, and `runs-on`, as in Generate.
Secrets: the same as Generate.

### Publish

`social-content-publish.yml` has no LLM step. It runs the `facebook-publish`, `instagram-publish`, and
`youtube-publish` scripts of `skills-ref` against the manifest in the issue marker, and writes the state back to the
body after every run, even a failed one (published items are never redone; `failed` Instagram items are retried by the
next scheduled run, Facebook and YouTube ones by a manual run or a new `/aprove`). The write merges with what other
runs wrote, as described above. When it fails, or the batch moved to a new revision, the report says the state was not
saved and neither confirms an approval nor closes the issue; fix it before publishing again. Scheduled runs download the batch media from Drive before the publisher decides what is due, so keep video
batches and the sweep frequency within `job-timeout-minutes`.
It has three entry points:

- **Approval** (`issue_comment` starting with `command`, default `/aprove`): the gate, then
  `review-batch.mjs approve`, which also requires the comment to be newer than the last revision comment and the body
  to be at that revision. Facebook and YouTube download the media from Drive and schedule natively at once. Instagram
  and LinkedIn have no scheduling API: the approved batch is validated and recorded, and the scheduled runs publish it.
- **Scheduled runs** (no comment, no `issue`): every open, approved `scheduled-platform` (`instagram`, or `linkedin`
  in a second scheduled caller) batch with items left, oldest first and one at a time, publishes up to `instagram-max`
  or `linkedin-max` (1) due items per batch and run (an item is due on its `date`). Run it several times a day when a
  batch has more than one item per day.
- **Manual runs** (`issue` set): publish an approved issue again, with `retry` for Facebook or YouTube items left
  `unknown` once you checked they are not live.

Each run comments the item table on the issue (scheduled runs only when something changed or failed) and closes the
issue when every item is scheduled, published, or stale (`publish_at` already passed; move it to a new batch).

```yaml
# .github/workflows/social-content-publish.yml
name: Social Content Publish

on:
  issue_comment:
    types: [created]
  schedule:
    - cron: "0 12,15,21 * * *" # Instagram: 9:00, 12:00, and 18:00 in America/Sao_Paulo
  workflow_dispatch:
    inputs:
      issue:
        description: Approved review issue to publish again.
        required: true
        type: string
      retry:
        description: Facebook or YouTube item ids to retry after a manual check.
        required: false
        type: string

permissions: {}

jobs:
  publish:
    if: >-
      ${{ github.event_name != 'issue_comment'
      || (!github.event.issue.pull_request
      && startsWith(github.event.comment.body, '/aprove')
      && contains(github.event.issue.labels.*.name, 'marketing-content')
      && github.event.comment.user.type != 'Bot'
      && contains(fromJSON('["OWNER", "MEMBER", "COLLABORATOR"]'), github.event.comment.author_association)) }}
    uses: fbrissi/github-actions/.github/workflows/social-content-publish.yml@v1
    permissions:
      contents: read
      issues: write
    with:
      issue: ${{ inputs.issue }}
      retry: ${{ inputs.retry }}
    secrets:
      GOOGLE_DRIVE_CLIENT_SECRET: ${{ secrets.GOOGLE_DRIVE_CLIENT_SECRET }}
      GOOGLE_DRIVE_REFRESH_TOKEN: ${{ secrets.GOOGLE_DRIVE_REFRESH_TOKEN }}
      FACEBOOK_PAGE_ACCESS_TOKEN: ${{ secrets.FACEBOOK_PAGE_ACCESS_TOKEN }}
      YOUTUBE_CLIENT_SECRET: ${{ secrets.YOUTUBE_CLIENT_SECRET }}
      YOUTUBE_REFRESH_TOKEN: ${{ secrets.YOUTUBE_REFRESH_TOKEN }}
      R2_ACCESS_KEY_ID: ${{ secrets.R2_ACCESS_KEY_ID }}
      R2_SECRET_ACCESS_KEY: ${{ secrets.R2_SECRET_ACCESS_KEY }}
```

| Input | Default | Description |
|---|---|---|
| `command` | `/aprove` | Approve command; keep it equal to `review.commands.approve`. |
| `issue` | `""` | Manual run: the approved issue to publish again. |
| `retry` | `""` | Manual run: comma-separated Facebook or YouTube item ids passed as `--retry`. |
| `scheduled-platform` | `instagram` | Platform the scheduled runs sweep: `instagram` or `linkedin` (one scheduled caller each). |
| `instagram-max` | `1` | Instagram items per batch and run. |
| `linkedin-max` | `1` | LinkedIn items per batch and run. |
| `instagram-media-prefix` | `marketing/instagram/{date}/{id}/` | R2 key prefix of the Instagram media. |
| `profile`, `label`, `skills-ref` | as in Generate | Profile, label, and ai-skills ref. |
| `facebook-page-id` | `FACEBOOK_PAGE_ID` | Page of the Facebook posts and of the linked Instagram account. |
| `facebook-graph-version` | `FACEBOOK_GRAPH_VERSION`, then `v24.0` | Graph API version. |
| `instagram-user-id` | `INSTAGRAM_USER_ID`, then the Page's account | Instagram professional account. |
| `youtube-client-id` | `YOUTUBE_CLIENT_ID` | Google OAuth client ID of the YouTube app. |
| `youtube-daily-upload-limit` | `YOUTUBE_DAILY_UPLOAD_LIMIT`, then `100` | Uploads per 24 hours. |
| `linkedin-organization-id` | `LINKEDIN_ORGANIZATION_ID` variable, then secret | LinkedIn Page (organization) ID. |
| `linkedin-client-id` | `LINKEDIN_CLIENT_ID` variable, then secret | LinkedIn app client ID. |
| `linkedin-api-version` | `LINKEDIN_API_VERSION`, then the publisher's | LinkedIn API version (`YYYYMM`). |
| `linkedin-daily-calls` | `LINKEDIN_DAILY_CALLS`, then `500` | LinkedIn API calls per 24 hours (Development tier: 500 per app). |
| `google-drive-client-id` | `GOOGLE_DRIVE_CLIENT_ID` variable, then secret | Drive app that holds the approved media. |
| `agent-client-id`, `environment`, `runs-on` | as in Generate | App, environment, runner. |
| `job-timeout-minutes` | `60` | Timeout of each publish job. |

Secrets, all optional so a caller passes only its platforms': `GOOGLE_DRIVE_CLIENT_SECRET`,
`GOOGLE_DRIVE_REFRESH_TOKEN` (and `GOOGLE_DRIVE_CLIENT_ID`); `FACEBOOK_PAGE_ACCESS_TOKEN` (Facebook:
`pages_manage_posts`, `pages_read_engagement`, `pages_show_list`; Instagram also `instagram_basic` and
`instagram_content_publish`); `YOUTUBE_CLIENT_SECRET`, `YOUTUBE_REFRESH_TOKEN` (`youtube.upload`, `youtube.force-ssl`
for captions, `youtube` for playlists; ask only for `youtube.upload` when you need neither); `LINKEDIN_CLIENT_SECRET`,
`LINKEDIN_REFRESH_TOKEN` (a Page admin's token for an app with the Community Management API: `w_organization_social`,
`r_organization_social`; `LINKEDIN_ORGANIZATION_ID` and `LINKEDIN_CLIENT_ID` may also be secrets); for Instagram media, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, and
`R2_ACCOUNT_ID` or `R2_ENDPOINT`, `R2_BUCKET`, `R2_PUBLIC_BASE_URL` (these four also read from variables of the same
name); and `AGENT_APP_PRIVATE_KEY`.

A rejected OAuth refresh token (`invalid_grant`: expired or revoked; Google tokens from a consent screen in Testing
mode expire after 7 days) fails the run with an error that says to authorize again and update the secret, and the
issue report explains it. Meta apps must be in Live mode with App Review, Instagram needs Page Publishing
Authorization, and a system-user Page token is better than a user token.

For LinkedIn, add a second scheduled caller with `scheduled-platform: linkedin` and pass its secrets:

```yaml
# .github/workflows/social-content-linkedin.yml
on:
  schedule:
    - cron: "0 12 * * 2,4" # LinkedIn: Tuesday and Thursday, 9:00 in America/Sao_Paulo
jobs:
  publish:
    uses: fbrissi/github-actions/.github/workflows/social-content-publish.yml@v1
    permissions:
      contents: read
      issues: write
    with:
      scheduled-platform: linkedin
    secrets:
      GOOGLE_DRIVE_CLIENT_SECRET: ${{ secrets.GOOGLE_DRIVE_CLIENT_SECRET }}
      GOOGLE_DRIVE_REFRESH_TOKEN: ${{ secrets.GOOGLE_DRIVE_REFRESH_TOKEN }}
      LINKEDIN_ORGANIZATION_ID: ${{ secrets.LINKEDIN_ORGANIZATION_ID }}
      LINKEDIN_CLIENT_ID: ${{ secrets.LINKEDIN_CLIENT_ID }}
      LINKEDIN_CLIENT_SECRET: ${{ secrets.LINKEDIN_CLIENT_SECRET }}
      LINKEDIN_REFRESH_TOKEN: ${{ secrets.LINKEDIN_REFRESH_TOKEN }}
```

The approval comment caller above handles LinkedIn batches too when it passes the LinkedIn secrets.

All three workflows need `contents: read` and `issues: write` on the caller job. With a GitHub App
(`agent-client-id` and `AGENT_APP_PRIVATE_KEY`, `Contents` read and `Issues` read and write) the comments and issues
come from the App; without one, `GITHUB_TOKEN` writes them, whose comments trigger no further workflows.

## Variables

Reusable workflows read the `vars` context of the calling repository, so these configuration variables (repository,
organization, or, for the review job, its `environment`) are used whenever the matching input is empty.

The AI workflows (`code-review.yml`, `pr-fix.yml`, `merge-decision.yml`, `ai-task.yml`, and the social content generate and adjust workflows) all take the inputs
`harness`, `opencode-model`, `opencode-variant`, `claude-model`, and `claude-effort`, and resolve each one as the input,
then the variable below, then the default (`claude` for the harness). Agents run with both harnesses. The
`ai-harness` and `ai-task` actions take the same values as inputs only. Credentials: `opencode` needs
`OPENCODE_MODEL` (and `OPEN_AI_TOKEN` for an `openai/` model); `claude` needs `ANTHROPIC_API_KEY` or
`CLAUDE_CODE_OAUTH_TOKEN`.

| Variable | Used by | Purpose |
|---|---|---|
| `CI_RUNNER` | all | Runner label; defaults to `ubuntu-latest`. |
| `AI_HARNESS` | AI workflows | `claude` (default) or `opencode`. |
| `OPENCODE_MODEL` | AI workflows | OpenCode model in `provider/model` form; required with `opencode`. |
| `OPENCODE_VARIANT` | AI workflows | OpenCode model variant (provider-specific reasoning effort). |
| `CLAUDE_MODEL`, `CLAUDE_EFFORT` | AI workflows | Claude Code model and effort. |
| `AGENT_APP_CLIENT_ID` | AI workflows, `ai-resume.yml`, social content workflows (optional) | Client ID of the GitHub App the workflow acts as (set it per `environment` to use one App per role). |
| `JIRA_BASE_URL` | `ai-task.yml` | Jira base URL. |
| `SENTRY_ORG`, `SENTRY_BASE_URL` | `ai-task.yml` | Sentry organization and base URL for the issue tasks. |
| `AGENT_APP_ID` | `code-review.yml` | Deprecated fallback for `AGENT_APP_CLIENT_ID`. |
| `GOOGLE_DRIVE_CLIENT_ID` | social content workflows | Google OAuth client ID of the Drive app. |
| `FACEBOOK_PAGE_ID`, `FACEBOOK_GRAPH_VERSION`, `INSTAGRAM_USER_ID` | `social-content-publish.yml` | Facebook Page, Graph API version, Instagram account. |
| `YOUTUBE_CLIENT_ID`, `YOUTUBE_DAILY_UPLOAD_LIMIT` | `social-content-publish.yml` | YouTube OAuth client ID and upload limit. |
| `R2_ACCOUNT_ID`, `R2_ENDPOINT`, `R2_BUCKET`, `R2_PUBLIC_BASE_URL` | `social-content-publish.yml` | Public bucket of the Instagram media, when not kept as secrets. |
| `LINKEDIN_ORGANIZATION_ID`, `LINKEDIN_CLIENT_ID`, `LINKEDIN_API_VERSION`, `LINKEDIN_DAILY_CALLS` | `social-content-publish.yml` | LinkedIn Page, app client ID, API version, and daily call budget. |

## Permissions

Reusable workflows can only use the permissions the calling job grants. Set `permissions: {}` at the top of callers
and grant per job:

| Workflow | Caller job permissions |
|---|---|
| `code-review.yml` | `checks: write`, `contents: read`, `pull-requests: read` |
| `pr-feedback-dispatch.yml` | `actions: write`, `pull-requests: read` |
| `pr-fix.yml` | `checks: write`, `issues: read`, `pull-requests: read` |
| `merge-decision.yml` | `actions: read`, `checks: read`, `contents: read`, `issues: read`, `pull-requests: read`, `statuses: read` |
| `ai-task.yml` | `contents: read` |
| `ai-resume.yml` | none (`{}`); it acts through the App token |
| `branch-sync.yml` | `contents: write`, `issues: write` |
| `release-note.yml` | `contents: read` |
| `release.yml` | `actions: write`, `contents: write` |
| `terraform-permissions.yml` | `contents: read` |
| `social-content-generate.yml`, `social-content-adjust.yml`, `social-content-publish.yml` | `contents: read`, `issues: write` |

## Security

- **Pinned tools.** OpenCode is pinned to a version and SHA-256; Claude Code to an exact npm version; skills to an
  `fbrissi/ai-skills` tag or SHA. Updates land through a pull request and a new release here.
- **A pull request cannot change its own reviewer.** Dispatch the Code Review caller on the default branch, and keep
  the review skill out of the reviewed tree (`ai-skills`, or `base` for the skills repository itself). Skills are
  installed into the harness home directory, never read from the PR checkout.
- **Least privilege.** Jobs declare their own permissions; the review job only gets `contents: read` from
  `GITHUB_TOKEN` and publishes through a short-lived GitHub App token scoped to `contents: read`, `issues: read`, and
  `pull-requests: write`, whatever else the App can do. Claude Code runs with `--strict-mcp-config`,
  so project MCP servers never start in CI.
- **Explicit secrets.** Reusable workflows declare every secret they read. Pass them explicitly (required
  for callers outside the `fbrissi` account), with `secrets: inherit`, or through the review environment; never interpolate secrets into scripts.
- **Read-only dependency cache.** The review installs the pull request's dependencies, whose install scripts can
  tamper with `node_modules`. It only restores the dependency cache by default, so one pull request can never poison
  the cache that later reviews restore. Warm the same key from a workflow that runs on the default branch.
- **Untrusted input.** Inputs and PR data reach scripts only through environment variables.
- **Fix and merge.** `pr-fix.yml` is the only workflow that runs pull request code with secrets, and only for
  same-repository pull requests that opted in; its App token has no `Workflows` permission. `merge-decision.yml`
  never checks out the pull request, counts only human approvals, and cannot merge unless `auto-merge` is on.
- **Resume.** `ai-resume.yml` only acts on comments posted by the agent App bot (or `trusted-bots`), only when a
  person with write, maintain, or admin permission checks the box, and validates every marker value before it
  dispatches; anyone who can edit the comment could already run the same `gh workflow run` command.
- **Social content.** `/adjust` and `/aprove` count only for people (never bots) with write, maintain, or admin
  permission, checked through the API, on an open issue with the content label and matching markers. Publishing runs
  no LLM; publisher tokens reach only the publish step, never the agents, and the Drive token is scoped to
  `drive.file`.
- The harnesses run with permission prompts disabled. Only review pull requests from trusted contributors, and do
  not run these workflows on `pull_request_target` with untrusted code.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Licensed under the [MIT License](LICENSE).
