# terraform-cloud-wait

Waits for the newest HCP Terraform (Terraform Cloud) run of a commit in a workspace to finish. It succeeds on
`applied` or `planned_and_finished` (no changes), keeps waiting while the run needs manual apply approval, and fails
on `errored`, `canceled`, `force_canceled`, `discarded`, or `policy_soft_failed` with a link to the run.

Bound the total wait with the job's `timeout-minutes`, since a run may wait for manual approval.

## Usage

```yaml
jobs:
  wait-for-infrastructure:
    runs-on: ubuntu-latest
    timeout-minutes: 60
    steps:
      - uses: fbrissi/github-actions/actions/terraform-cloud-wait@v1
        with:
          organization: my-org
          workspace: my-workspace
          token: ${{ secrets.TFC_API_TOKEN }}
```

## Inputs

| Input | Default | Description |
|---|---|---|
| `organization` | – (required) | HCP Terraform organization. |
| `workspace` | – (required) | HCP Terraform workspace. |
| `token` | – (required) | API token that can read the workspace runs. |
| `commit-sha` | `github.sha` | Commit whose run is awaited. |
| `start-timeout-minutes` | `30` | Minutes to wait for a run of the commit to appear. |
| `poll-interval-seconds` | `10` | Seconds between API polls. |

## Outputs

| Output | Description |
|---|---|
| `run-id` | The awaited run ID. |
| `status` | Final status, `applied` or `planned_and_finished`. |

If a run fails, re-running the job alone keeps failing because the action always waits for the newest run of the
commit: start a new run for the same commit in HCP Terraform first, then re-run the job.
