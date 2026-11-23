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
