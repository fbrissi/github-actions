#!/usr/bin/env bash
# Downloads the pinned skills archive and keeps only the named skills, so deterministic steps run the publisher and
# review scripts without a harness. Prints the skills directory to GITHUB_OUTPUT as `skills-dir`.
set -euo pipefail

repository="${SKILLS_REPOSITORY:?SKILLS_REPOSITORY is required}"
ref="${SKILLS_REF:?SKILLS_REF is required}"
skills_path="${SKILLS_PATH:-.rulesync/skills}"
skills="${SKILLS:?SKILLS is required}"
target="${SKILLS_TARGET:-${RUNNER_TEMP:?RUNNER_TEMP is required}/social-content-skills}"
base_url="${SKILLS_BASE_URL:-https://codeload.github.com}"

if ! [[ "$repository" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]]; then
  echo "::error::Invalid skills-repository '${repository}'."
  exit 1
fi
if ! [[ "$ref" =~ ^[A-Za-z0-9._-]+$ ]]; then
  echo "::error::Invalid skills-ref '${ref}'. Use a tag or a commit SHA."
  exit 1
fi
if [[ "$skills_path" == /* || "$skills_path" == *..* ]]; then
  echo '::error::skills-path must be a relative path inside the repository.'
  exit 1
fi

archive_dir="$(mktemp -d)"
trap 'rm -rf "$archive_dir"' EXIT
curl -fsSL --retry 3 "${base_url}/${repository}/tar.gz/${ref}" | tar -xz -C "$archive_dir" --strip-components=1

rm -rf "$target"
mkdir -p "$target"
for skill in $skills; do
  if ! [[ "$skill" =~ ^[A-Za-z0-9_.-]+$ ]]; then
    echo "::error::Invalid skill name '${skill}'."
    exit 1
  fi
  source_dir="$archive_dir/${skills_path%/}/$skill"
  if [ ! -f "$source_dir/SKILL.md" ]; then
    echo "::error::Skill '${skill}' was not found in ${repository}@${ref}:${skills_path}."
    exit 1
  fi
  cp -R "$source_dir" "$target/$skill"
  echo "Fetched skill '${skill}' from ${repository}@${ref}."
done

if [ -n "${GITHUB_OUTPUT:-}" ]; then
  echo "skills-dir=$target" >> "$GITHUB_OUTPUT"
fi
