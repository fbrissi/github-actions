#!/usr/bin/env bash
# Sourced helper. Claude Code ranks project agents (.claude/agents in the checkout) above user agents and identifies an
# agent by its `name:` frontmatter, so a checkout file with the same file name or the same `name:` would win.

# Prints the first checkout agent file that would override agent "$2" in checkout "$1".
checkout_agent_override() {
  local checkout="$1" agent="$2" agents_dir file
  agents_dir="$checkout/.claude/agents"
  [ -d "$agents_dir" ] || return 1
  while IFS= read -r -d '' file; do
    if [ "$(basename "$file" .md)" = "$agent" ] ||
      awk -v agent="$agent" '
        { sub(/\r$/, "") }
        NR == 1 && $0 != "---" { exit }
        NR > 1 && $0 == "---" { exit }
        NR > 1 && /^name:/ {
          value = $0
          sub(/^name:[[:space:]]*/, "", value)
          sub(/[[:space:]]+$/, "", value)
          gsub(/^["'\'']|["'\'']$/, "", value)
          found = (value == agent)
          exit
        }
        END { exit !found }
      ' "$file"; then
      printf '%s\n' "$file"
      return 0
    fi
  done < <(find "$agents_dir" -type f -name '*.md' -print0)
  return 1
}

# OpenCode ranks project agents (.opencode/agent and .opencode/agents in the checkout) above global agents and
# identifies an agent by its file path relative to the agents directory, without `.md`.
# Prints the first checkout agent file that would override OpenCode agent "$2" in checkout "$1".
checkout_opencode_agent_override() {
  local checkout="$1" agent="$2" dir
  for dir in agent agents; do
    if [ -f "$checkout/.opencode/$dir/$agent.md" ]; then
      printf '%s\n' "$checkout/.opencode/$dir/$agent.md"
      return 0
    fi
  done
  return 1
}

# Prints the `mode:` frontmatter value of agent file "$1", empty when it is not set.
agent_mode() {
  awk '
    { sub(/\r$/, "") }
    NR == 1 && $0 != "---" { exit }
    NR > 1 && $0 == "---" { exit }
    NR > 1 && /^mode:/ {
      value = $0
      sub(/^mode:[[:space:]]*/, "", value)
      sub(/[[:space:]]+$/, "", value)
      gsub(/^["'\'']|["'\'']$/, "", value)
      print value
      exit
    }
  ' "$1"
}
