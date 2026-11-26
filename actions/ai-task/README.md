# ai-task

Runs one task of the AI task delivery flow with its [fbrissi/ai-skills](https://github.com/fbrissi/ai-skills) agent:
it validates the task and its inputs, installs the task's agents and skills, builds a non-interactive prompt that
passes every non-empty parameter explicitly, and runs it with [`ai-harness`](../ai-harness/README.md) (OpenCode or
Claude Code, the agent as the main agent). With `opencode` the agents are the OpenCode agents of the same names from
`plugins/ai-skills/opencode/agent`.

| Task | Agent | Default skills | Requires |
|---|---|---|---|
| `business-refinement` | `business-analyst` | `business-refinement`, `ticket-create` | `source` |
| `technical-refinement` | `tech-lead` | `technical-refinement`, `ticket-plan` | `milestone` or `issue` |
| `readiness-review` | `readiness-reviewer` | `readiness-review` | `milestone` or `issue` |
| `orchestrate` | `delivery-orchestrator` | `delivery-orchestration`, `pr-create` | `milestone` |
| `implement` | `task-implementer` (+ `developer`, `code-reviewer`, `qa-tester`) | `dev`, `quality-cycle`, `pr-create`, `review-changes`, `qa-e2e`, `bdd-scenarios`, `ticket-plan` | `issue`, `branch` |
| `issue-intake` | `issue-resolver` (`intake` mode) | `sentry-issues`, `ticket-create` | – |
| `issue-resolve` | `issue-resolver` (`resolve` mode, + `developer`, `code-reviewer`, `qa-tester`) | `sentry-issues`, `observability-triage`, `dev`, `quality-cycle`, `pr-create`, `review-changes`, `qa-e2e`, `bdd-scenarios`, `ticket-plan` | `issue` |
| `dependency-update` | `dependency-updater` (+ `developer`, `code-reviewer`, `qa-tester`) | `dependency-updates`, `dev`, `quality-cycle`, `pr-create`, `review-changes`, `qa-e2e`, `bdd-scenarios` | – |

`skills` and `agents` add to these defaults. Runs never wait for input: when a task is blocked, the agent writes its
questions on the ticket or issue, sets the blocked status, and stops.

Parameters left empty are not sent, so the repository profile (`profile`, default `docs/ai/delivery.md`) and then the
skill defaults apply (`dependency-update` reads `docs/ai/dependency-updates.md` instead). Set an input only to override the
profile.

## What the caller owns

The action does not check out, authenticate, or install anything for the project. Before it, the job must:

- Create a GitHub App token and pass it as `github-token`. The agent uses it for `gh` and `git push`. Every task
  needs `issues` write; `orchestrate`, `implement`, `issue-resolve`, and `dependency-update` also need `contents` and `pull-requests` write (the others only
  read); `orchestrate` needs `actions` write (it dispatches the implement workflow); and any task needs
  `organization-projects` write when `project` is set.
- Check out the repository with full history (`fetch-depth: 0`) and push credentials (the App token, with
  `persist-credentials` left on) for `orchestrate`, `implement`, `issue-resolve`, and `dependency-update`, which create and
  push branches.
- Set the git identity the agent commits as (usually the App bot).
- Install the project dependencies the agent needs to build and test.

The [`ai-task.yml`](../../README.md#ai-task) reusable workflow does all of this.

## Usage

```yaml
- uses: fbrissi/github-actions/actions/ai-task@v1
  with:
    task: implement
    issue: ${{ inputs.issue }}
    branch: ${{ inputs.branch }}
    base-branch: ${{ inputs.base-branch }}
    harness: ${{ vars.AI_HARNESS }}
    opencode-model: ${{ vars.OPENCODE_MODEL }}
    opencode-variant: ${{ vars.OPENCODE_VARIANT }}
    claude-model: ${{ vars.CLAUDE_MODEL }}
    claude-effort: ${{ vars.CLAUDE_EFFORT }}
    github-token: ${{ steps.app-token.outputs.token }}
    openai-api-key: ${{ secrets.OPEN_AI_TOKEN }}
    anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
    claude-code-oauth-token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
```

## Inputs

Task parameters (see the [task table](#ai-task) for which are required):

| Input | Empty means | Description |
|---|---|---|
| `task` | – (required) | `business-refinement`, `technical-refinement`, `readiness-review`, `orchestrate`, `implement`, `issue-intake`, `issue-resolve`, or `dependency-update`. |
| `source` | – | Source ticket: Jira key or URL, GitHub issue, or GitHub milestone. |
| `source-tracker` | profile, then `github` | `github` or `jira`. |
| `source-language` | profile, then `auto` | Language of comments on the source ticket; `auto` uses the source's language. |
| `milestone` | – | GitHub milestone. |
| `issue` | – | GitHub issue number (`12` or `#12`). |
| `branch` | – | Task branch for `implement`. |
| `base-branch` | profile, then the default branch | Base branch; the milestone branch for `implement`. |
| `milestone-template` | profile, then `{key}` | Milestone title template, for example `JIRA:{key}`. |
| `output-language` | profile, then `English` | Language of what the task writes on GitHub. |
| `status-labels` | `status:<state>` | Multiline `state=label` overrides. States: `needs-business-refinement`, `business-blocked`, `needs-technical-refinement`, `technical-blocked`, `needs-review`, `ready`, `in-progress`, `in-review`, `done`. |
| `project` | profile | GitHub Project (`owner/number`) whose status field follows the issue state. |
| `project-status-field` | profile, then `Status` | Single-select status field of `project`. |
| `project-status-options` | profile, then Title Case of the state | Multiline `state=Option name` mapping to `project-status-field` options; several states may share one option, for example `needs-review=Technical Refinement`, `business-blocked=Blocked`. |
| `research-sources` | profile | Multiline URLs or repository paths to consult when details are missing. |
| `test-environment` | – | Command that started the test environment before this action (the `setup-command` of `ai-task.yml`). The `implement`, `issue-resolve`, and `dependency-update` prompts then tell QA it is running. |
| `instructions` | – | Per-run instructions appended to the prompt under `Additional instructions for this run:`. |
| `context` | – | Deprecated, use `instructions`. Free text appended to the prompt. |
| `profile` | `docs/ai/delivery.md` (`docs/ai/dependency-updates.md` for `dependency-update`) | Repository profile path. |
| `implement-workflow` | profile, then `ai-implement.yml` | Workflow file `orchestrate` dispatches per issue. |
| `max-parallel` | profile, then `3` | Implement runs `orchestrate` keeps in progress. |
| `requested-by` | `github.triggering_actor` | Person who started the flow. The agent mentions them when it asks a question or stops for a human, and stores `<!-- ai-delivery requested-by=<login> -->` in a milestone it creates. Bots are dropped; the agent then uses that marker. |

Run settings and credentials:

| Input | Default | Description |
|---|---|---|
| `skills` | `""` | Extra whitespace-separated skills. |
| `agents` | `""` | Extra whitespace-separated agents. |
| `harness` | `claude` | `opencode` or `claude`; pass the caller's `AI_HARNESS` variable. Empty uses `claude`. |
| `opencode-model` | `""` | OpenCode model in `provider/model` form. Required by `opencode`. |
| `opencode-variant` | `""` | OpenCode model variant. |
| `claude-model` | `""` | Claude Code model. |
| `claude-effort` | `""` | Claude Code effort level. |
| `ai-skills-ref` | `v0.8.0` | `fbrissi/ai-skills` tag or SHA the skills and agents come from. |
| `timeout-minutes` | `50` | Harness run timeout. GitHub App installation tokens expire after one hour. |
| `github-token` | – (required) | GitHub App token used for `gh` and `git push`. |
| `openai-api-key` | `""` | OpenAI API key. Required by `opencode` with an `openai/` model. |
| `anthropic-api-key` | `""` | Anthropic API key. |
| `claude-code-oauth-token` | `""` | Claude Code OAuth token, used when no Anthropic key is set. `claude` requires one of the two. |
| `jira-base-url` | `""` | Jira base URL, exported as `JIRA_BASE_URL`. |
| `jira-email` | `""` | Exported as `JIRA_EMAIL`; masked. |
| `jira-api-token` | `""` | Exported as `JIRA_API_TOKEN`; masked. |
| `sentry-auth-token` | `""` | Exported as `SENTRY_AUTH_TOKEN`; masked. The prompt mentions Sentry only when it is set. |
| `sentry-org`, `sentry-base-url` | `""` | Exported as `SENTRY_ORG` and `SENTRY_BASE_URL`. |

Jira is enabled only when the URL, e-mail, and token are all set; an e-mail or token without the others fails, and
so does `business-refinement` with `source-tracker: jira` without them. The credentials are masked, only exported to
the harness step, and never written into the prompt.

## Outputs

| Output | Description |
|---|---|
| `harness` | Harness that ran the task. |
| `agent` | Agent that ran the task. |
| `agents` | Installed agents. |
| `skills` | Installed skills. |
| `output-file` | File that holds the harness output. |
| `milestone` | Milestone the agent reported it created or worked on, when `milestone` was empty. The agent writes it as `milestone=<title>` to the file in `AI_TASK_RESULT_FILE`. |

## Browser QA

The `implement` prompt tells the agent to run browser QA when the profile's test environment is reachable (start it
before this action, for example with the `setup-command` input of [`ai-task.yml`](../../README.md#qa-in-ci)). When
none is reachable, QA runs in tests-only mode: it relies on the automated tests that run as pull request checks,
reports `browser QA skipped: no CI environment`, and never escalates for that reason. With `test-environment` set, the
prompt says the environment is already running, so QA uses it instead. The `implement`, `issue-resolve`, and
`dependency-update` prompts always ask for the reviewer and QA, documentation-only changes included.

## Notes

- **Nested action.** A composite action cannot use a relative `./` path to a sibling action once it is called from a
  remote ref, so this action calls `fbrissi/github-actions/actions/ai-harness@v1`, the same major tag the reusable
  workflows use. Pinning `ai-task` to `@v1.2.3` or a SHA therefore still runs the latest `v1` `ai-harness`.
- **Token lifetime.** GitHub App installation tokens expire after one hour, so keep `timeout-minutes` under that, or
  the agent's last `git push` and `gh` calls fail.
- **Workflow files.** The token pattern above cannot push changes under `.github/workflows/`; that needs the
  `workflows` permission, which this setup does not grant.
- The harness runs with permission prompts disabled and loads project skills and settings from the checkout. Only
  run it on a trusted ref, from `workflow_dispatch` or trusted events, never on `pull_request_target`.
