#!/usr/bin/env bash
# Runs one non-interactive prompt with the harness resolved by action.yml.
set -euo pipefail

# shellcheck source=checkout-agent.sh disable=SC1091
source "$(dirname "${BASH_SOURCE[0]}")/checkout-agent.sh"

: "${AI_HARNESS:?AI_HARNESS is required}"
: "${AI_PROMPT:?AI_PROMPT is required}"
: "${AI_OUTPUT_FILE:?AI_OUTPUT_FILE is required}"
timeout_minutes="${AI_TIMEOUT_MINUTES:-25}"

if ! [[ "$timeout_minutes" =~ ^[1-9][0-9]*$ ]]; then
  echo "::error::timeout-minutes must be a positive integer, got '${timeout_minutes}'."
  exit 1
fi

# Empty credentials must not shadow another authentication method.
for name in OPENAI_API_KEY ANTHROPIC_API_KEY CLAUDE_CODE_OAUTH_TOKEN GITHUB_TOKEN GH_TOKEN; do
  if [ -z "${!name:-}" ]; then
    unset "$name"
  fi
done

mkdir -p "$(dirname "$AI_OUTPUT_FILE")"

agent="${AI_AGENT:-}"
if [ -n "$agent" ] && ! [[ "$agent" =~ ^[A-Za-z0-9_.:-]+$ ]]; then
  echo "::error::Invalid agent name '${agent}'."
  exit 1
fi

case "$AI_HARNESS" in
  opencode)
    command=(opencode run --thinking --dangerously-skip-permissions)
    if [ -n "${OPENCODE_MODEL:-}" ]; then
      command+=("--model=${OPENCODE_MODEL}")
    fi
    if [ -n "${OPENCODE_VARIANT:-}" ]; then
      command+=("--variant=${OPENCODE_VARIANT}")
    fi
    if [ -n "${OPENCODE_COMMAND:-}" ]; then
      command+=("--command=${OPENCODE_COMMAND}")
    fi
    if [ -n "$agent" ]; then
      # OpenCode silently falls back to its default agent when the agent is missing or is a subagent.
      agent_file="$HOME/.config/opencode/agents/$agent.md"
      if [ ! -f "$agent_file" ]; then
        echo "::error::Agent '${agent}' is not installed in ~/.config/opencode/agents; add it to the agents input."
        exit 1
      fi
      if [ "$(agent_mode "$agent_file")" = 'subagent' ]; then
        echo "::error::Agent '${agent}' has mode 'subagent'; OpenCode can run only a primary agent as the main agent."
        exit 1
      fi
      if override="$(checkout_opencode_agent_override "$PWD" "$agent")"; then
        echo "::error::The checkout defines ${override}, which would override the installed agent '${agent}'."
        exit 1
      fi
      command+=("--agent=${agent}")
    fi
    command+=("$AI_PROMPT")
    timeout --foreground --kill-after=30s "${timeout_minutes}m" "${command[@]}" 2>&1 | tee "$AI_OUTPUT_FILE"
    ;;
  claude)
    if [ -z "${ANTHROPIC_API_KEY:-}" ] && [ -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]; then
      echo '::error::The claude harness requires an anthropic-api-key or claude-code-oauth-token credential.'
      exit 1
    fi
    # --strict-mcp-config without --mcp-config keeps project MCP servers (.mcp.json) from starting.
    command=(claude --print --output-format text --dangerously-skip-permissions --strict-mcp-config)
    if [ -n "${CLAUDE_MODEL:-}" ]; then
      command+=(--model "$CLAUDE_MODEL")
    fi
    if [ -n "${CLAUDE_EFFORT:-}" ]; then
      command+=(--effort "$CLAUDE_EFFORT")
    fi
    if [ -n "$agent" ]; then
      if [[ "$agent" != *:* ]]; then
        if [ ! -f "$HOME/.claude/agents/$agent.md" ]; then
          echo "::error::Agent '${agent}' is not installed in ~/.claude/agents; add it to the agents input."
          exit 1
        fi
        if override="$(checkout_agent_override "$PWD" "$agent")"; then
          echo "::error::The checkout defines ${override}, which would override the installed agent '${agent}'."
          exit 1
        fi
      fi
      command+=(--agent "$agent")
    fi
    printf '%s' "$AI_PROMPT" |
      timeout --foreground --kill-after=30s "${timeout_minutes}m" "${command[@]}" 2>&1 |
      tee "$AI_OUTPUT_FILE"
    ;;
  *)
    echo "::error::Unsupported AI harness '${AI_HARNESS}'."
    exit 1
    ;;
esac
