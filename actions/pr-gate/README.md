# pr-gate

Deterministic gates and markers of the PR follow-up, with no AI involved. The reusable workflows
[`pr-fix.yml`](../../README.md#pr-fix) and [`merge-decision.yml`](../../README.md#merge-decision) run it; call it
directly to build your own variant of them, for example a wrapper that loads the App key and the AI keys at run time
from a secret store instead of GitHub secrets (a reusable workflow only accepts secrets from the `secrets` context).

| Command | Token | What it does |
|---|---|---|
| `fix-gate` | `checks: write`, `issues: read`, `pull-requests: read` (the job's `GITHUB_TOKEN` is enough) | Outputs `action` `fix`, `escalate`, or `skip` with the rules of [PR Fix](../../README.md#pr-fix), and creates the `check-name` check run for a `fix`. |
| `fix-record` | GitHub App token with `pull-requests: write` | Posts the `<!-- pr-fix round=N head=<sha> -->` comment `fix-gate` counts. |
| `fix-finish` | `checks: write` | Completes the check run from `result`. |
| `feedback-dispatch` | `actions: write`, `pull-requests: read` (the job's `GITHUB_TOKEN` is enough) | Routes the `pull_request_review` or `check_run` event to `fix-workflow` or `merge-workflow` with the rules of [PR Feedback Dispatch](../../README.md#pr-feedback-dispatch); [`pr-feedback-dispatch.yml`](../../README.md#pr-feedback-dispatch) runs it. |
| `merge-dispatch` | `actions: write` (a GitHub App token, or the job's `GITHUB_TOKEN`) | Dispatches `merge-workflow` with `pr_number` on the default branch, so a merge decision skipped while a fix pass ran is decided again; nothing without `merge-workflow`, a notice when the workflow is not on the default branch. |
| `merge-gate` | `actions`, `checks`, `issues`, `pull-requests`, and `statuses` read | Outputs `action` `decide` or `skip` with the rules of [Merge Decision](../../README.md#merge-decision); `request_review` is `true` when human approvals are missing, `handoff` is `true` when only unresolved review threads block it and no `fix-workflow` run is queued. Of the check runs of one App, workflow file, and name, only the newest counts. |
| `merge-outcome` | none | Reads the harness output (`output-file`, default the ai-harness file) and the harness `outcome`, and outputs `result`: `merged`, `held`, or `not-evaluated` from the last `merge-risk-result:` line (older skills: the `PR #<n>: MERGE / HOLD` line; a failed harness without a result is `not-evaluated`). |
| `merge-record` | GitHub App token with `pull-requests: write` | Posts the `<!-- merge-decision head=<sha> -->` comment, so each head commit is decided once. |

Only comments by bots count as markers, so the record commands need an App token, not a personal one.

## Usage

```yaml
jobs:
  gate:
    runs-on: ubuntu-latest
    permissions:
      checks: write
      issues: read
      pull-requests: read
    outputs:
      action: ${{ steps.gate.outputs.action }}
      round: ${{ steps.gate.outputs.round }}
    steps:
      - id: gate
        uses: fbrissi/github-actions/actions/pr-gate@v1
        with:
          command: fix-gate
          pr-number: ${{ inputs.pr_number }}
          branch-prefixes: feature/ release/ hotfix/ bugfix/
```

## Inputs

| Input | Default | Description |
|---|---|---|
| `command` | – (required) | `feedback-dispatch`, `fix-gate`, `fix-record`, `fix-finish`, `merge-dispatch`, `merge-gate`, `merge-outcome`, or `merge-record`. |
| `github-token` | `github.token` | Token for the GitHub API (see the table above). |
| `pr-number` | `""` | Pull request number. |
| `opt-in-label` | `ai:auto-fix` | `fix-gate`: opt-in label. |
| `branch-prefixes` | `""` | `fix-gate`: head prefixes that also opt in. `merge-gate`: head prefixes a pull request must match (empty matches all). |
| `max-rounds` | `3` | `fix-gate` and `fix-record`: passes before escalation. |
| `escalation-label` | `ai:needs-human` | `fix-gate`: blocks passes while present. |
| `check-name` | `PR Fix` | `fix-gate` and `fix-finish`: check run name. |
| `required-human-approvals` | `1` | `merge-gate`: human approvals on the head commit. |
| `human-approval-exempt-base-prefixes` | `""` | `merge-gate`: base prefixes that need no human approval when the author is exempt too. |
| `human-approval-exempt-authors` | `""` | `merge-gate`: authors exempt into those bases; empty means any GitHub App bot, never a person. |
| `approval-labels` | `ai:needs-approval` | `merge-gate`: labels that require a human approval of the head commit (at least one) even when the pull request is exempt. They never stop a fix pass. |
| `hold-labels` | `do-not-merge hold` | `merge-gate`: labels that block a decision. |
| `round`, `start-sha`, `outcome` | `""` | `fix-record`: round, starting head commit, and harness outcome. |
| `head-sha` | `""` | `merge-record`: decided head commit. |
| `result`, `check-run-id` | `""` | `fix-finish`: fix job result and the check run to complete. |
| `merge-workflow` | `""` | `merge-dispatch` and `feedback-dispatch`: workflow file to dispatch, for example `merge-decision.yml`. |
| `fix-workflow`, `ignore-authors`, `ignore-reply-authors`, `merge-check-name` | `""` | `feedback-dispatch`: as the inputs of the same name of `pr-feedback-dispatch.yml`. |
| `fix-workflow` | `""` | `merge-gate`: the PR Fix caller; a queued run of it keeps unresolved threads from setting `handoff` while the pull request could get a pass (`opt-in-label` or `fix-branch-prefixes`, no `escalation-label`, under `max-rounds`) and has review feedback, not by `ignore-authors`, newer than its last fix round. |
| `fix-branch-prefixes` | `""` | `merge-gate`: the `branch-prefixes` of the PR Fix caller. |

Outputs: `action`, `pr_number`, `round`, `head_ref`, `head_sha`, `base_ref`, `base_sha`, `check_run_id`,
`required_approvals`, `request_review`, `handoff`, and `result`.

The script uses Node.js (installed with actions/setup-node when the runner has none) and no dependencies. Run the
tests with `node --test actions/pr-gate/*.test.mjs`.
