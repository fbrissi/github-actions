# ai-delivery

Deterministic steps of the AI task delivery flow, with no AI involved. The reusable workflows
[`ai-task.yml`](../../README.md#how-stages-chain), [`ai-resume.yml`](../../README.md#resume),
[`pr-fix.yml`](../../README.md#pr-fix), and [`merge-decision.yml`](../../README.md#merge-decision) run it; call it
directly only to build your own variant of them.

| Command | Used by | What it does |
|---|---|---|
| `follow-up` | `ai-task.yml` | After a stage run, reads the `status:*` labels of the milestone's open issues (or of `issue`) and dispatches the next stage, or posts a handoff for each blocked issue. On `failure` or `cancelled` it hands off the same stage with the run link and moves an `implement` issue stuck in `status:in-progress` without a PR back to `status:ready`. Stores the requester in the milestone description and enforces the loop guard. |
| `handoff` | `pr-fix.yml` | Posts one handoff comment for `task` on `pr` (or `issue`), unless an unchecked one for the same stage is already there. |
| `resume` | `ai-resume.yml` | On an `issue_comment` `edited` event, resumes the stage of a handoff whose box a person with write permission just checked, then replaces the box with `Resumed by @<login> -> <run link>`. |
| `request-review` | `merge-decision.yml` | Requests a review on `pr` from the requester and mentions them once. |

## Markers

| Marker | Where | Purpose |
|---|---|---|
| `<!-- ai-delivery requested-by=<login> -->` | milestone description | Person who started the flow; never a bot. |
| `<!-- ai-delivery-dispatches <stage>=<n> ... -->` | milestone description | Automatic dispatches per stage (loop guard); a resume removes it. |
| `<!-- ai-resume stage=... milestone=... issue=... pr=... requested-by=... branch=... base=... jira=... label=... workflow=... -->` | handoff comment, after the `- [ ] Resume:` line | What to dispatch on resume. Values are percent-encoded. |
| `<!-- merge-decision review-requested=<login> -->` | pull request comment | Deduplicates the review request. |

## Stage callers

`stage-workflows` takes `stage=file` lines on top of these defaults. The follow-up and the resume send only the
inputs below, on the default branch; an input the caller does not declare is dropped with a warning.

| Stage | Default file | Inputs |
|---|---|---|
| `business-refinement` | `ai-business-refinement.yml` | `milestone`, `jira_key`, `requested_by` |
| `technical-refinement` | `ai-technical-refinement.yml` | `milestone`, `issue`, `requested_by` |
| `readiness-review` | `ai-readiness-review.yml` | `milestone`, `issue`, `requested_by` |
| `orchestrate` | `ai-orchestrate.yml` | `milestone`, `requested_by` |
| `implement` | `ai-implement.yml` | `issue`, `branch`, `base_branch`, `requested_by` |
| `pr-fix` | `pr-fix.yml` | `pr_number` |

A handoff for the stage of the running workflow names that caller's own file (from `GITHUB_WORKFLOW_REF`) unless
`stage-workflows` overrides it, and the resume dispatches the file named in the marker.

## Usage

```yaml
- uses: fbrissi/github-actions/actions/ai-delivery@v1
  with:
    command: handoff
    github-token: ${{ steps.app-token.outputs.token }}
    task: pr-fix
    pr: ${{ inputs.pr_number }}
    blocker: Automatic fixes stopped after 3 rounds.
```

## Inputs

| Input | Default | Description |
|---|---|---|
| `command` | – (required) | `follow-up`, `handoff`, `resume`, or `request-review`. |
| `github-token` | – (required) | GitHub App token. `follow-up`: `actions` and `issues` write, `pull-requests` read. `handoff` and `request-review`: `pull-requests` write. `resume`: `actions`, `issues`, and `pull-requests` write. |
| `task` | `""` | Stage of `follow-up` (an `ai-task` task) or `handoff` (any stage, including `pr-fix`). |
| `result` | `success` | `follow-up`: result of the stage job, `success`, `failure`, or `cancelled`. |
| `milestone` | `""` | Milestone title. |
| `result-milestone` | `""` | Milestone the stage reported, used when `milestone` is empty. |
| `issue`, `pr` | `""` | Issue or pull request number. |
| `branch`, `base-branch` | `""` | Task and milestone branch of `implement`. |
| `source` | `""` | Source ticket; its Jira key finds the milestone through `milestone-template`. |
| `milestone-template` | `""` | Milestone title template, for example `JIRA:{key}`. |
| `requested-by` | `""` | Requester; bots are ignored and the milestone marker is used instead. |
| `blocker` | `""` | `handoff` blocker text, up to three lines. |
| `marker` | `""` | HTML comment lines a `handoff` starts with, for example `<!-- pr-fix escalated -->`. |
| `status-labels` | `""` | `state=label` overrides (default `status:<state>`). |
| `stage-workflows` | `""` | `stage=file` overrides of the stage callers. |
| `max-auto-dispatches` | `3` | Automatic dispatches of one stage per milestone before `follow-up` hands off instead. |
| `chain` | `true` | `follow-up` dispatches the next stage; `false` only hands off. |
| `escalation-label` | `ai:needs-human` | Escalation label; a `pr-fix` resume removes it. |
| `bot-login`, `trusted-bots` | `""` | `resume`: bot logins whose handoff comments may be resumed. |
| `jira-base-url` | `""` | Links the Jira ticket in business refinement handoffs. |
| `required-approvals` | `1` | `request-review`: approvals the pull request needs. |

The scripts use Node.js (installed with actions/setup-node when the runner has none) and no dependencies. Run the
tests with `node --test actions/ai-delivery/*.test.mjs`.
