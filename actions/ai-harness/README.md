# ai-harness

Installs a pinned coding-agent harness, optionally installs agent skills from a pinned source, and runs one
non-interactive prompt in the current checkout.

| Harness | What is installed |
|---|---|
| `opencode` (default) | OpenCode 1.19.5 (linux-x64, SHA-256 verified) plus `opencode-plugins` (default `@kompassdev/opencode`). The OpenCode session is exported to the log after the run. |
| `claude` | Claude Code 2.1.319 from npm (Node.js 24 is installed only when `npm` is missing). Runs with `--strict-mcp-config`, so project MCP servers from `.mcp.json` never start. |

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
| `harness` | `opencode` | `opencode` or `claude`. Empty falls back to `opencode`. |
| `prompt` | – (required) | Prompt sent to the harness. With `opencode-command`, it is passed as the command arguments. |
| `opencode-command` | `""` | OpenCode command, for example `pr/review`. Ignored by Claude Code. |
| `opencode-model` | `""` | OpenCode model in `provider/model` form. |
| `opencode-variant` | `""` | OpenCode model variant. |
| `opencode-plugins` | `@kompassdev/opencode` | Whitespace-separated OpenCode plugins. Empty installs none. |
| `claude-model` | `""` | Claude Code model alias or full model ID. |
| `claude-effort` | `""` | Claude Code effort level. |
| `skills` | `""` | Whitespace-separated skill names to install. Empty installs none. |
| `skills-repository` | `fbrissi/ai-skills` | Repository the skills are downloaded from. |
| `skills-ref` | `v0.2.0` | Tag or commit SHA of `skills-repository`. Pin it; never use a branch. |
| `skills-path` | `.rulesync/skills` | Directory in `skills-repository` with one folder per skill. |
| `skills-local-dir` | `""` | Local directory with one folder per skill; replaces the download when set. |
| `timeout-minutes` | `25` | Maximum harness run time. |
| `output-file` | `$RUNNER_TEMP/ai-harness-output` | File that receives the harness output. |
| `openai-api-key` | `""` | OpenAI key for OpenCode. |
| `anthropic-api-key` | `""` | Anthropic key for Claude Code. |
| `claude-code-oauth-token` | `""` | Claude Code OAuth token, used when no Anthropic key is set. |
| `github-token` | `""` | Exposed as `GITHUB_TOKEN`/`GH_TOKEN` (with `GH_REPO` set to the current repository). Omit it when the task must not reach GitHub. |

Skills are installed into `~/.claude/skills` for Claude Code and `~/.config/opencode/skills` for OpenCode, so they
never come from the checked-out (possibly untrusted) working tree. Empty credentials are unset before the run, so
they do not shadow another authentication method. The `claude` harness fails early without `anthropic-api-key` or
`claude-code-oauth-token`.

## Outputs

| Output | Description |
|---|---|
| `harness` | The resolved harness. |
| `output-file` | File that holds the harness output, for verification steps. |
