#!/usr/bin/env bash
# Writes a batch manifest back to its review issue body (the durable copy of the publishing state). Does nothing when
# the manifest was never restored, so it can run after any outcome.
set -euo pipefail

manifest="${SOCIAL_MANIFEST:-}"
issue="${SOCIAL_ISSUE:?SOCIAL_ISSUE is required}"
skills="${SOCIAL_SKILLS_DIR:?SOCIAL_SKILLS_DIR is required}"
profile="${SOCIAL_PROFILE:-docs/ai/social-content.md}"

if [ -z "$manifest" ] || [ ! -f "$manifest" ]; then
  echo 'No restored manifest; the issue body is unchanged.'
  exit 0
fi
if ! [[ "$issue" =~ ^[1-9][0-9]*$ ]]; then
  echo "::error::Invalid issue number '${issue}'."
  exit 1
fi

profile_args=()
if [ -f "$profile" ]; then
  profile_args=(--profile "$profile")
fi
body="$(dirname "$manifest")/issue-body.md"
node "$skills/social-review/scripts/review-batch.mjs" issue-body "$manifest" ${profile_args[@]+"${profile_args[@]}"} > "$body"
gh issue edit "$issue" --body-file "$body"
echo "Saved the batch state in #${issue}."
