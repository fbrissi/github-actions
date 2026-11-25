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
| `merge-gate` | `actions`, `checks`, `issues`, `pull-requests`, and `statuses` read | Outputs `action` `decide` or `skip` with the rules of [Merge Decision](../../README.md#merge-decision); `request_review` is `true` when human approvals are missing. |
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
| `command` | – (required) | `fix-gate`, `fix-record`, `fix-finish`, `merge-gate`, or `merge-record`. |
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
| `hold-labels` | `do-not-merge hold` | `merge-gate`: labels that block a decision. |
| `round`, `start-sha`, `outcome` | `""` | `fix-record`: round, starting head commit, and harness outcome. |
| `head-sha` | `""` | `merge-record`: decided head commit. |
| `result`, `check-run-id` | `""` | `fix-finish`: fix job result and the check run to complete. |

Outputs: `action`, `pr_number`, `round`, `head_ref`, `head_sha`, `base_ref`, `base_sha`, `check_run_id`,
`required_approvals`, and `request_review`.

The script uses Node.js (installed with actions/setup-node when the runner has none) and no dependencies. Run the
tests with `node --test actions/pr-gate/*.test.mjs`.
