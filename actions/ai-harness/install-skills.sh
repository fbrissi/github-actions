#!/usr/bin/env bash
# Installs agent skills for the resolved harness from a local directory or a pinned repository archive.
set -euo pipefail

: "${AI_HARNESS:?AI_HARNESS is required}"
: "${SKILLS:?SKILLS is required}"

case "$AI_HARNESS" in
  opencode) target_dir="$HOME/.config/opencode/skills" ;;
  claude) target_dir="$HOME/.claude/skills" ;;
  *)
    echo "::error::Unsupported AI harness '${AI_HARNESS}'."
    exit 1
    ;;
esac

if [ -n "${SKILLS_LOCAL_DIR:-}" ]; then
  source_dir="$SKILLS_LOCAL_DIR"
  source_label="$SKILLS_LOCAL_DIR"
else
  repository="${SKILLS_REPOSITORY:?SKILLS_REPOSITORY is required}"
  ref="${SKILLS_REF:?SKILLS_REF is required}"
  skills_path="${SKILLS_PATH:-.rulesync/skills}"
  if ! [[ "$repository" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]]; then
    echo "::error::Invalid skills-repository '${repository}'."
    exit 1
  fi
  if ! [[ "$ref" =~ ^[A-Za-z0-9._-]+$ ]]; then
    echo "::error::Invalid skills-ref '${ref}'. Use a tag or a commit SHA."
    exit 1
  fi
  if [[ "$skills_path" == /* || "$skills_path" == *..* ]]; then
    echo "::error::skills-path must be a relative path inside the repository."
    exit 1
  fi

  archive_dir="$RUNNER_TEMP/ai-harness-skills"
  rm -rf "$archive_dir"
  mkdir -p "$archive_dir"
  curl -fsSL --retry 3 "https://codeload.github.com/${repository}/tar.gz/${ref}" |
    tar -xz -C "$archive_dir" --strip-components=1
  source_dir="$archive_dir/${skills_path%/}"
  source_label="${repository}@${ref}:${skills_path}"
fi

mkdir -p "$target_dir"
for skill in $SKILLS; do
  if ! [[ "$skill" =~ ^[A-Za-z0-9_.-]+$ ]]; then
    echo "::error::Invalid skill name '${skill}'."
    exit 1
  fi
  if [ ! -f "$source_dir/$skill/SKILL.md" ]; then
    echo "::error::Skill '${skill}' was not found in ${source_label}."
    exit 1
  fi
  rm -rf "${target_dir:?}/$skill"
  cp -R "$source_dir/$skill" "$target_dir/$skill"
  if [ -d "$target_dir/$skill/scripts" ]; then
    find "$target_dir/$skill/scripts" -type f -name '*.sh' -exec chmod +x {} +
  fi
  echo "Installed skill '${skill}' from ${source_label} into ${target_dir}."
done

if [ -z "${SKILLS_LOCAL_DIR:-}" ]; then
  rm -rf "$archive_dir"
fi
