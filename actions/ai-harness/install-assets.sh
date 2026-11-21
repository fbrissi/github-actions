#!/usr/bin/env bash
# Installs agent skills and Claude Code agents for the resolved harness from local directories or a pinned
# repository archive.
set -euo pipefail

: "${AI_HARNESS:?AI_HARNESS is required}"
skills="${SKILLS:-}"
agents="${AGENTS:-}"

case "$AI_HARNESS" in
  opencode) skills_target_dir="$HOME/.config/opencode/skills" ;;
  claude) skills_target_dir="$HOME/.claude/skills" ;;
  *)
    echo "::error::Unsupported AI harness '${AI_HARNESS}'."
    exit 1
    ;;
esac
agents_target_dir="$HOME/.claude/agents"

if [ -n "$agents" ] && [ "$AI_HARNESS" != 'claude' ]; then
  echo "::error::agents are supported only by the claude harness, got '${AI_HARNESS}'."
  exit 1
fi

check_relative_path() {
  local name="$1" value="$2"
  if [[ "$value" == /* || "$value" == *..* ]]; then
    echo "::error::${name} must be a relative path inside the repository."
    exit 1
  fi
}

check_name() {
  local kind="$1" name="$2"
  if ! [[ "$name" =~ ^[A-Za-z0-9_.-]+$ ]]; then
    echo "::error::Invalid ${kind} name '${name}'."
    exit 1
  fi
}

archive_dir=''
download_archive() {
  if [ -n "$archive_dir" ]; then
    return
  fi
  local repository="${SKILLS_REPOSITORY:?SKILLS_REPOSITORY is required}"
  local ref="${SKILLS_REF:?SKILLS_REF is required}"
  if ! [[ "$repository" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]]; then
    echo "::error::Invalid skills-repository '${repository}'."
    exit 1
  fi
  if ! [[ "$ref" =~ ^[A-Za-z0-9._-]+$ ]]; then
    echo "::error::Invalid skills-ref '${ref}'. Use a tag or a commit SHA."
    exit 1
  fi
  archive_dir="$RUNNER_TEMP/ai-harness-assets"
  rm -rf "$archive_dir"
  mkdir -p "$archive_dir"
  curl -fsSL --retry 3 "https://codeload.github.com/${repository}/tar.gz/${ref}" |
    tar -xz -C "$archive_dir" --strip-components=1
}

if [ -n "$skills" ]; then
  if [ -n "${SKILLS_LOCAL_DIR:-}" ]; then
    source_dir="$SKILLS_LOCAL_DIR"
    source_label="$SKILLS_LOCAL_DIR"
  else
    skills_path="${SKILLS_PATH:-.rulesync/skills}"
    check_relative_path skills-path "$skills_path"
    download_archive
    source_dir="$archive_dir/${skills_path%/}"
    source_label="${SKILLS_REPOSITORY}@${SKILLS_REF}:${skills_path}"
  fi

  mkdir -p "$skills_target_dir"
  for skill in $skills; do
    check_name skill "$skill"
    if [ ! -f "$source_dir/$skill/SKILL.md" ]; then
      echo "::error::Skill '${skill}' was not found in ${source_label}."
      exit 1
    fi
    rm -rf "${skills_target_dir:?}/$skill"
    cp -R "$source_dir/$skill" "$skills_target_dir/$skill"
    if [ -d "$skills_target_dir/$skill/scripts" ]; then
      find "$skills_target_dir/$skill/scripts" -type f -name '*.sh' -exec chmod +x {} +
    fi
    echo "Installed skill '${skill}' from ${source_label} into ${skills_target_dir}."
  done
fi

if [ -n "$agents" ]; then
  if [ -n "${AGENTS_LOCAL_DIR:-}" ]; then
    source_dir="$AGENTS_LOCAL_DIR"
    source_label="$AGENTS_LOCAL_DIR"
  else
    agents_path="${AGENTS_PATH:-plugins/ai-skills/agents}"
    check_relative_path agents-path "$agents_path"
    download_archive
    source_dir="$archive_dir/${agents_path%/}"
    source_label="${SKILLS_REPOSITORY}@${SKILLS_REF}:${agents_path}"
  fi

  mkdir -p "$agents_target_dir"
  for agent in $agents; do
    check_name agent "$agent"
    # Claude Code ranks project agents above user agents, so a same-named agent in the checkout would win.
    if [ -e "${GITHUB_WORKSPACE:-$PWD}/.claude/agents/$agent.md" ]; then
      echo "::error::The checkout defines .claude/agents/${agent}.md, which would override the installed agent '${agent}'."
      exit 1
    fi
    if [ ! -f "$source_dir/$agent.md" ]; then
      echo "::error::Agent '${agent}' was not found in ${source_label}."
      exit 1
    fi
    cp "$source_dir/$agent.md" "$agents_target_dir/$agent.md"
    echo "Installed agent '${agent}' from ${source_label} into ${agents_target_dir}."
  done
fi

if [ -n "$archive_dir" ]; then
  rm -rf "$archive_dir"
fi
