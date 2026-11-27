# ai-harness

Installs a pinned coding-agent harness, optionally installs agent skills from a pinned source, and runs one
non-interactive prompt in the current checkout.

| Harness | What is installed |
|---|---|
| `opencode` | OpenCode 1.19.5 (linux-x64, SHA-256 verified) plus `opencode-plugins` (default `@kompassdev/opencode`). The OpenCode session is exported to the log after the run. |
| `claude` (default) | Claude Code 2.1.332 from npm (Node.js 24 is installed only when `npm` is missing). Runs with `--strict-mcp-config`, so project MCP servers from `.mcp.json` never start, and without background work (see [Claude Code run result](#claude-code-run-result)). |

Both harnesses run with permission prompts disabled, so only run them on trusted runners and give them the
narrowest tokens that work.

## Usage

```yaml
- uses: fbrissi/github-actions/actions/ai-harness@v1
  id: harness
  with:
    harness: ${{ vars.AI_HARNESS }}
    prompt: Use the nfse-technical-note-analysis skill with the profile docs/ai/nfse.md.
    opencode-model: ${{ vars.OPENCODE_MODEL }}
    claude-model: ${{ vars.CLAUDE_MODEL }}
    claude-effort: ${{ vars.CLAUDE_EFFORT }}
    skills: nfse-technical-note-analysis
    skills-ref: v0.2.0
    openai-api-key: ${{ secrets.OPEN_AI_TOKEN }}
    anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
    claude-code-oauth-token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
    github-token: ${{ steps.app-token.outputs.token }}

- run: cat "${{ steps.harness.outputs.output-file }}"
```

## Inputs

| Input | Default | Description |
|---|---|---|
| `harness` | `claude` | `opencode` or `claude`. Empty falls back to `claude`. |
| `prompt` | – (required) | Prompt sent to the harness. With `opencode-command`, it is passed as the command arguments. |
| `instructions` | `""` | Per-run instructions appended to `prompt` under `Additional instructions for this run:`. With `opencode-command`, they become part of the command arguments. |
| `opencode-command` | `""` | OpenCode command, for example `pr/review`. Ignored by Claude Code. |
| `opencode-model` | `""` | OpenCode model in `provider/model` form. |
| `opencode-variant` | `""` | OpenCode model variant. |
| `opencode-plugins` | `@kompassdev/opencode` | Whitespace-separated OpenCode plugins. Empty installs none. |
| `claude-model` | `""` | Claude Code model alias or full model ID. |
| `claude-effort` | `""` | Claude Code effort level. |
| `skills` | `""` | Whitespace-separated skill names to install. Empty installs none. |
| `skills-repository` | `fbrissi/ai-skills` | Repository the skills are downloaded from. |
| `skills-ref` | `v0.11.0` | Tag or commit SHA of `skills-repository`. Pin it; never use a branch. |
| `skills-path` | `.rulesync/skills` | Directory in `skills-repository` with one folder per skill. |
| `skills-local-dir` | `""` | Local directory with one folder per skill; replaces the download when set. |
| `agents` | `""` | Whitespace-separated agent names to install at `skills-ref`: from `agents-path` for Claude Code, from `opencode-agents-path` for OpenCode. |
| `agents-path` | `plugins/ai-skills/agents` | Directory in `skills-repository` with one Claude Code `<agent>.md` per agent. |
| `agents-local-dir` | `""` | Local directory with one Claude Code `<agent>.md` per agent; replaces the download when set. |
| `opencode-agents-path` | `plugins/ai-skills/opencode/agent` | Directory in `skills-repository` with one OpenCode `<agent>.md` per agent. |
| `opencode-agents-local-dir` | `""` | Local directory with one OpenCode `<agent>.md` per agent; replaces the download when set. |
| `agent` | `""` | Runs the prompt with that agent as the main agent (`claude --agent` or `opencode run --agent`). |
| `timeout-minutes` | `25` | Maximum harness run time. |
| `output-file` | `$RUNNER_TEMP/ai-harness-output` | File that receives the harness output. |
| `openai-api-key` | `""` | OpenAI key for OpenCode. |
| `anthropic-api-key` | `""` | Anthropic key for Claude Code. |
| `claude-code-oauth-token` | `""` | Claude Code OAuth token, used when no Anthropic key is set. |
| `github-token` | `""` | Exposed as `GITHUB_TOKEN`/`GH_TOKEN` (with `GH_REPO` set to the current repository); with it, [`setup-gh`](../setup-gh/README.md) installs `gh` first when the runner lacks it. Omit it when the task must not reach GitHub. |

## Running an agent

Orchestrator agents (for example `nfse-compliance` from `fbrissi/ai-skills`) delegate to worker agents, which only
works when the orchestrator is the main agent. Install the orchestrator, its workers, and the skills they use, then
name the orchestrator in `agent`:

```yaml
- uses: fbrissi/github-actions/actions/ai-harness@v1
  with:
    harness: ${{ vars.AI_HARNESS }}
    opencode-model: ${{ vars.OPENCODE_MODEL }}
    agent: nfse-compliance
    agents: nfse-compliance developer code-reviewer qa-tester ci-investigator pr-shepherd
    skills: nfse-technical-note-analysis merge-risk quality-cycle review-changes dev pr-create pr-fix pr-checks ticket-create
    skills-ref: v0.4.0
    prompt: scan
    openai-api-key: ${{ secrets.OPEN_AI_TOKEN }}
    anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
    github-token: ${{ steps.app-token.outputs.token }}
```

Claude Code agents are installed into `~/.claude/agents`. Claude Code ranks project agents (`.claude/agents/` in the checkout)
above user agents, so the action fails when an agent file in the checkout's `.claude/agents/` has the same file name
or the same `name:` frontmatter as one in `agents` or `agent`, and when `agent` names an agent that is not installed.
Project skills and settings in the checkout still load, so only run agents on a trusted checkout.

OpenCode agents are installed into `~/.config/opencode/agents` and the prompt runs with `opencode run --agent <agent>`.
OpenCode names an agent by its file name and ranks project agents (`.opencode/agent/` and `.opencode/agents/` in the
checkout) above global ones, so the action fails when the checkout has a file with the same name. OpenCode silently
falls back to its default agent when `--agent` names a missing agent or one with `mode: subagent`, so the action fails
first in both cases: the main agent must be `primary` or `all`. Agents defined in the checkout's `opencode.json` are
not checked.

Skills are installed into `~/.claude/skills` for Claude Code and `~/.config/opencode/skills` for OpenCode, so they
never come from the checked-out (possibly untrusted) working tree. Empty credentials are unset before the run, so
they do not shadow another authentication method. The `claude` harness fails early without `anthropic-api-key` or
`claude-code-oauth-token`.

## Claude Code run result

Print mode stops background work (subagents, shells, Monitor watches) still running when its wait ceiling after the
last turn is reached, drops that work, and can still exit 0. An agent that hands its work to a background subagent and
ends its turn would then lose the work while the step passed. The `claude` harness prevents and detects that:

- it sets `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`, so subagents and shell commands run in the foreground and the agent
  waits for them, and removes the `Monitor` tool (`--disallowedTools Monitor`), which that variable does not cover;
- it runs with `--output-format json` and writes the result text to `output-file`, so readers of the file see the same
  text as before;
- the step fails when Claude Code exits non-zero, prints no JSON result, ends with a result other than `success` or
  with `is_error`, or reports that it stopped background tasks still running.

## Outputs

| Output | Description |
|---|---|
| `harness` | The resolved harness. |
| `output-file` | File that holds the harness output, for verification steps. |
