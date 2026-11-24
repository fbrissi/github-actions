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
| [`merge-decision.yml`](#merge-decision) | Reusable workflow | Deterministic merge gates, then an AI risk rating that holds or (opt-in) merges. |
| [`ai-task.yml`](#ai-task) | Reusable workflow | Runs one AI task delivery task (refinement, readiness, orchestration, implementation) with its agent. |
| [`release-note.yml`](#release-note) | Reusable workflow | Requires each pull request to add one changelog release. |
| [`release.yml`](#release) | Reusable workflow | Tags and publishes the changelog release, then optionally deploys it. |
| [`terraform-permissions.yml`](#terraform-permissions) | Reusable workflow | Fails before merge when the Cloudflare Terraform token lacks a permission. |
| [`ai-harness`](actions/ai-harness/README.md) | Composite action | Installs OpenCode or Claude Code (pinned) and runs one prompt. |
| [`ai-task`](actions/ai-task/README.md) | Composite action | Validates an AI delivery task, installs its agents and skills, and runs it with `ai-harness`. |
| [`terraform-cloud-wait`](actions/terraform-cloud-wait/README.md) | Composite action | Waits for the HCP Terraform apply of a commit. |
| [`terraform-permissions`](actions/terraform-permissions/README.md) | Composite action | Checks a Cloudflare permission manifest and the real token. |

## Versioning

Releases follow [Semantic Versioning](https://semver.org/) and are cut from [CHANGELOG.md](CHANGELOG.md): every
pull request adds a `## vX.Y.Z` heading, and merging it creates the `vX.Y.Z` tag and GitHub release and moves the
major tag (`v1`) to it.

- `@v1` follows every compatible release. This is what the examples use.
- `@v1.2.3` or a full commit SHA freezes the version; Dependabot (`github-actions` ecosystem) can bump it.

Breaking input, secret, or behavior changes only ship in a new major version. The reusable workflows, and the
`ai-task` action (which runs `ai-harness`), call this repository's own actions at the same major tag (`@v1`): a
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
| `harness` | `AI_HARNESS`, then `opencode` | `opencode` or `claude`. |
| `opencode-command` | `pr/review` | OpenCode command that reviews the PR (Kompass). Empty uses the review-changes skill prompt. |
| `opencode-plugins` | `@kompassdev/opencode` | OpenCode plugins. Set `""` when `opencode-command` is empty. |
| `opencode-model` | `OPENCODE_MODEL` | Required by the `opencode` harness. |
| `opencode-variant` | `OPENCODE_VARIANT` | OpenCode model variant. |
| `claude-model` | `CLAUDE_MODEL` | Claude Code model. |
| `claude-effort` | `CLAUDE_EFFORT` | Claude Code effort level. |
| `prompt` | `""` | Overrides the generated prompt. |
| `review-skill-source` | `ai-skills` | `ai-skills` (pinned `ai-skills-ref`), `base` (the PR base commit, for the skills repository itself), or `none`. |
| `ai-skills-ref` | `v0.2.0` | `fbrissi/ai-skills` tag or SHA used with `ai-skills`. |
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
   `changes_requested` (or `commented` with a body or inline comments) and the merge workflow for `approved`.
2. [`pr-fix.yml`](#pr-fix) runs one fix pass and pushes with a GitHub App token. Unlike `GITHUB_TOKEN` pushes, App
   pushes trigger CI, so the code review runs again and its review closes the loop.
3. [`merge-decision.yml`](#merge-decision) checks the merge gates without AI and, when they pass, rates the risk
   with the `merge-risk` skill. It holds by default and merges only with `auto-merge: true`.

Both targets are dispatched on the default branch, so a pull request can never change its own fixer or merger. Use
separate GitHub Apps (one `environment` each, with its own `AGENT_APP_CLIENT_ID` and `AGENT_APP_PRIVATE_KEY`) for
review, fix, and merge, so the fixer's replies are never mistaken for review feedback and the reviewer can never
merge.

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
| `fix-workflow` | `pr-fix.yml` | Dispatched with `pr_number` on a `changes_requested` review, or a `commented` one with a body or inline comments. Empty disables it. |
| `merge-workflow` | `merge-decision.yml` | Dispatched with `pr_number` on an `approved` review or a successful `merge-check-name` check run. Empty disables it. |
| `ignore-authors` | `""` | Logins whose reviews never dispatch a fix, for example the fixer App bot, whose thread replies also emit review events. |
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
   adds `escalation-label`, comments once, and stops; removing the label allows `max-rounds` more. Otherwise it
   creates a `PR Fix` check run on the head commit.
2. **Run PR Fix** checks out the head branch with the App token, commits as the App bot, installs dependencies, and
   runs the harness. It never watches CI or waits for comments: the next review dispatches the next pass. It then
   records the round and fails if the branch was rewritten.
3. **Finish PR Fix** completes the check run.

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
      node-version: "24"
      install-command: npm ci
    secrets: inherit
```

The fixer GitHub App needs `Contents: Read and write`, `Pull requests: Read and write`, `Issues: Read`,
`Actions: Read`, and `Checks: Read`. Do not grant it `Workflows`: GitHub then rejects any push that changes
`.github/workflows/**`.

| Input | Default | Description |
|---|---|---|
| `pr-number` | – (required) | Pull request to fix. |
| `opt-in-label` | `ai:auto-fix` | Label that opts a pull request in. |
| `branch-prefixes` | `""` | Head branch prefixes that also opt a pull request in. |
| `max-rounds` | `3` | Passes before escalation. |
| `escalation-label` | `ai:needs-human` | Added at `max-rounds`; blocks further passes while present. |
| `skills` | `pr-fix pr-checks` | Skills installed for the harness. |
| `agents` | `""` | Claude Code agents installed for the harness (`claude` only). |
| `prompt` | `""` | Overrides the generated prompt. |
| `prompt-append` | `""` | Appended to the prompt. |
| `skill-source` | `ai-skills` | `ai-skills` (pinned `ai-skills-ref`), `base` (the PR base commit), or `none`. |
| `ai-skills-ref` | `v0.4.0` | `fbrissi/ai-skills` tag or SHA used with `ai-skills`. |
| `base-skills-path` | `.rulesync/skills` | Skills directory read from the base commit with `base`. |
| `check-name` | `PR Fix` | Check run name. |
| `environment` | `pr-fix` | Environment of the fix job; its secrets are visible to the job. |
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
   users (not bots or Apps), no unresolved review threads, and no decision recorded for the head commit yet.
2. **Run Merge Decision** checks out the base commit (never the pull request) so the `merge-risk` profile cannot be
   changed by the change it rates, runs the skill in decide mode, and records a
   `<!-- merge-decision head=<sha> -->` comment, so each head commit is decided once. Push a commit (or delete that
   comment) to decide again.

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

| Input | Default | Description |
|---|---|---|
| `pr-number` | – (required) | Pull request to decide on. |
| `auto-merge` | `false` | Let the AI merge; when false it only rates the risk and holds. |
| `required-human-approvals` | `1` | Human approvals required on the head commit. |
| `hold-labels` | `do-not-merge hold` | Labels that block a decision. |
| `branch-prefixes` | `""` | Head branch prefixes a pull request must match; empty decides on every pull request. |
| `skills` | `merge-risk` | Skills installed for the harness. |
| `agents` | `""` | Claude Code agents installed for the harness (`claude` only). |
| `prompt` | `""` | Overrides the generated prompt. |
| `prompt-append` | `""` | Appended to the prompt. |
| `skill-source` | `ai-skills` | `ai-skills` (pinned `ai-skills-ref`), `base` (the base commit), or `none`. |
| `ai-skills-ref` | `v0.4.0` | `fbrissi/ai-skills` tag or SHA used with `ai-skills`. |
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
dependencies, and runs the task's [fbrissi/ai-skills](https://github.com/fbrissi/ai-skills) agent with Claude Code.

| Task | Agent | Input | What it does |
|---|---|---|---|
| `business-refinement` | `business-analyst` | `source` | Turns a source ticket (Jira, GitHub issue, or milestone) into a GitHub milestone and business-level issues, or asks the source what is unclear. |
| `technical-refinement` | `tech-lead` | `milestone` or `issue` | Writes the technical plan of each issue so the milestone's issues can be built in parallel. |
| `readiness-review` | `readiness-reviewer` | `milestone` or `issue` | Marks each issue ready or sends it back to refinement. |
| `orchestrate` | `delivery-orchestrator` | `milestone` | Creates the milestone and task branches and dispatches `implement` for each ready issue whose dependencies are done; opens the milestone PR when every issue is done. Never codes. |
| `implement` | `task-implementer` | `issue`, `branch`, `base-branch` | Implements the issue, runs the review and QA cycle, and opens a PR into the milestone branch. |

Runs never wait for input: blocked tasks leave their questions on the ticket or issue and stop. Inputs left empty
are not sent, so the repository profile (`docs/ai/delivery.md`) and then the skill defaults apply.

Runs are serialized per repository, task, and issue (or milestone, or source) without cancelling: a new run waits
for the current one, and only the newest waiting run is kept.

### GitHub App

The App the agent acts as needs these repository permissions: `Contents`, `Issues`, `Pull requests`, and `Actions`
(read and write), plus `Organization projects` (read and write) on an organization installation when `project` is
used. The token handed to the agent is scoped per task:

| Task | Token permissions |
|---|---|
| `business-refinement`, `technical-refinement`, `readiness-review` | `contents: read`, `issues: write`, `pull-requests: read` |
| `orchestrate` | `contents: write`, `issues: write`, `pull-requests: write`, `actions: write` |
| `implement` | `contents: write`, `issues: write`, `pull-requests: write` |
| any, with `project` | adds `organization-projects: write` |

Organization issue field values (for example Priority, Effort, Start date, Target date) are set with the
`Issues: write` permission every task already gets. The organization `Issue fields` permission only covers listing
and managing the field definitions (`/orgs/{org}/issue-fields`), and `actions/create-github-app-token@v3` cannot
request it yet, so the scoped token does not carry it.

Set `project` as a workflow input, not only in the profile, so the token gets the projects permission. Projects
must belong to the organization that owns the repository: App installation tokens cannot reach projects of
a user account or of another organization. The token expires after one hour, so keep `timeout-minutes` under it. It
has no `workflows` permission, so the agent cannot push changes to `.github/workflows/`.

### Callers

Each task gets its own `workflow_dispatch` caller on the default branch. The caller job only needs
`contents: read`; everything the agent does goes through the App token.

```yaml
# .github/workflows/ai-business-refinement.yml
name: AI Business Refinement

on:
  workflow_dispatch:
    inputs:
      source:
        description: Source ticket (Jira key or URL, GitHub issue, or milestone)
        required: true
        type: string

permissions: {}

jobs:
  refine:
    uses: fbrissi/github-actions/.github/workflows/ai-task.yml@v1
    permissions:
      contents: read
    with:
      task: business-refinement
      source: ${{ inputs.source }}
      source-tracker: jira
      milestone-template: JIRA:{key}
    secrets:
      AGENT_APP_PRIVATE_KEY: ${{ secrets.AGENT_APP_PRIVATE_KEY }}
      ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
      CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
      JIRA_EMAIL: ${{ secrets.JIRA_EMAIL }}
      JIRA_API_TOKEN: ${{ secrets.JIRA_API_TOKEN }}
```

Technical refinement, readiness review, and orchestration take a milestone; only the `task` differs:

```yaml
# .github/workflows/ai-technical-refinement.yml (and ai-readiness-review.yml, ai-orchestrate.yml)
name: AI Technical Refinement

on:
  workflow_dispatch:
    inputs:
      milestone:
        description: GitHub milestone
        required: true
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
      node-version: "24"
      install-command: npm ci
      dependency-cache-path: node_modules
    secrets:
      AGENT_APP_PRIVATE_KEY: ${{ secrets.AGENT_APP_PRIVATE_KEY }}
      ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
      CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
```

Re-run the orchestrator each time a task PR merges into a milestone branch. Task branches are named
`<milestone branch>-<issue>-<slug>`, which is what the `if` checks; the milestone comes from the PR, or from the
issues it closes:

```yaml
# .github/workflows/ai-orchestrate-on-merge.yml
name: AI Orchestrate on Merge

on:
  pull_request:
    types: [closed]
    branches: ["feat/**"]

permissions: {}

jobs:
  dispatch:
    if: ${{ github.event.pull_request.merged == true && startsWith(github.event.pull_request.head.ref, format('{0}-', github.event.pull_request.base.ref)) }}
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
GitHub App (such as the agent's App) or a person. A `workflow_dispatch` sent with `GITHUB_TOKEN`, as above, does
start the orchestrator.

### Inputs

Task parameters are the [`ai-task` action inputs](actions/ai-task/README.md#inputs) under the same names: `task`,
`source`, `source-tracker`, `source-language`, `milestone`, `issue`, `branch`, `base-branch`, `milestone-template`,
`output-language`, `status-labels`, `project`, `project-status-field`, `project-status-options`, `research-sources`, `context`, `profile`,
`implement-workflow`, `max-parallel`, `skills`, `agents`, and `ai-skills-ref` (default `v0.5.0`). The workflow adds:

| Input | Default | Description |
|---|---|---|
| `harness` | `claude` | Only `claude` is supported (agents need Claude Code). |
| `claude-model`, `claude-effort` | `CLAUDE_MODEL`, `CLAUDE_EFFORT` | Claude Code model and effort. |
| `opencode-model`, `opencode-variant` | `OPENCODE_MODEL`, `OPENCODE_VARIANT` | Passed through; unused while only `claude` is supported. |
| `jira-base-url` | `JIRA_BASE_URL` | Jira base URL; Jira is used only with the `JIRA_EMAIL` and `JIRA_API_TOKEN` secrets. |
| `agent-client-id` | `AGENT_APP_CLIENT_ID` | Client ID of the GitHub App the agent acts as. |
| `environment` | `""` | Environment of the task job; empty runs without one. |
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
| `ANTHROPIC_API_KEY` | this or the next | Anthropic API key. |
| `CLAUDE_CODE_OAUTH_TOKEN` | this or the previous | Claude Code OAuth token, used when `ANTHROPIC_API_KEY` is empty. |
| `OPEN_AI_TOKEN` | no | Passed through; unused while only `claude` is supported. |
| `JIRA_EMAIL`, `JIRA_API_TOKEN` | Jira sources | Jira credentials, masked and exported to the agent as `JIRA_EMAIL` and `JIRA_API_TOKEN`. |

Output: `agent`, the agent that ran the task.

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
| `runs-on` | `CI_RUNNER`, then `ubuntu-latest` | Runner label. |

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

## Variables

Reusable workflows read the `vars` context of the calling repository, so these configuration variables (repository,
organization, or, for the review job, its `environment`) are used whenever the matching input is empty:

| Variable | Used by | Purpose |
|---|---|---|
| `CI_RUNNER` | all | Runner label; defaults to `ubuntu-latest`. |
| `AI_HARNESS` | AI workflows except `ai-task.yml` | `opencode` (default) or `claude`. |
| `OPENCODE_MODEL`, `OPENCODE_VARIANT` | AI workflows | OpenCode model and variant. |
| `CLAUDE_MODEL`, `CLAUDE_EFFORT` | AI workflows | Claude Code model and effort. |
| `AGENT_APP_CLIENT_ID` | AI workflows | Client ID of the GitHub App the workflow acts as (set it per `environment` to use one App per role). |
| `JIRA_BASE_URL` | `ai-task.yml` | Jira base URL. |
| `AGENT_APP_ID` | `code-review.yml` | Deprecated fallback for `AGENT_APP_CLIENT_ID`. |

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
| `release-note.yml` | `contents: read` |
| `release.yml` | `actions: write`, `contents: write` |
| `terraform-permissions.yml` | `contents: read` |

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
- The harnesses run with permission prompts disabled. Only review pull requests from trusted contributors, and do
  not run these workflows on `pull_request_target` with untrusted code.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Licensed under the [MIT License](LICENSE).
