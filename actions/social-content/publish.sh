#!/usr/bin/env bash
# Restores one approved batch and runs its deterministic publisher (no LLM). Modes:
#   approve  stamp the approval from the /aprove comment (review-batch.mjs approve); Facebook and YouTube publish
#            right away (native scheduling), Instagram and LinkedIn are only validated and recorded for the scheduled runs.
#   resume   restore the manifest from the issue marker and publish (manual run, optionally with --retry ids).
#   sweep    same as resume, for the scheduled Instagram and LinkedIn runs.
# Writes manifest, before, and log paths to GITHUB_OUTPUT before doing anything, so later steps can always report.
set -euo pipefail

mode="${SOCIAL_MODE:?SOCIAL_MODE is required}"
issue="${SOCIAL_ISSUE:?SOCIAL_ISSUE is required}"
platform="${SOCIAL_PLATFORM:?SOCIAL_PLATFORM is required}"
skills="${SOCIAL_SKILLS_DIR:?SOCIAL_SKILLS_DIR is required}"
profile="${SOCIAL_PROFILE:-docs/ai/social-content.md}"
retry="${SOCIAL_RETRY:-}"
instagram_max="${SOCIAL_INSTAGRAM_MAX:-1}"
linkedin_max="${SOCIAL_LINKEDIN_MAX:-1}"
work="${SOCIAL_WORK_DIR:-${RUNNER_TEMP:?RUNNER_TEMP is required}/social-batch}/${issue}"

case "$mode" in approve | resume | sweep) ;; *) echo "::error::Unknown mode '${mode}'."; exit 1 ;; esac
case "$platform" in
  facebook) platform_name=Facebook ;;
  instagram) platform_name=Instagram ;;
  youtube) platform_name=YouTube ;;
  linkedin) platform_name=LinkedIn ;;
  *) echo "::error::Unknown platform '${platform}'."; exit 1 ;;
esac
if ! [[ "$issue" =~ ^[1-9][0-9]*$ ]]; then
  echo "::error::Invalid issue number '${issue}'."
  exit 1
fi
if [ -n "$retry" ] && ! [[ "$retry" =~ ^[A-Za-z0-9._-]+(,[A-Za-z0-9._-]+)*$ ]]; then
  echo "::error::retry must be comma-separated item ids, got '${retry}'."
  exit 1
fi
if ! [[ "$instagram_max" =~ ^[1-9][0-9]*$ ]]; then
  echo "::error::instagram-max must be a positive integer, got '${instagram_max}'."
  exit 1
fi
if ! [[ "$linkedin_max" =~ ^[1-9][0-9]*$ ]]; then
  echo "::error::linkedin-max must be a positive integer, got '${linkedin_max}'."
  exit 1
fi

# Empty optional settings must not reach the publishers: `?? default` keeps an empty string (an empty media prefix, or
# a daily upload limit of 0).
for name in INSTAGRAM_MEDIA_PREFIX INSTAGRAM_USER_ID YOUTUBE_DAILY_UPLOAD_LIMIT FACEBOOK_GRAPH_VERSION R2_ENDPOINT R2_ACCOUNT_ID R2_REGION LINKEDIN_API_VERSION LINKEDIN_DAILY_CALLS; do
  if [ -z "${!name:-}" ]; then
    unset "$name"
  fi
done

manifest="$work/manifest.json"
before="$work/before.json"
log="$work/publisher.log"
rm -rf "$work"
mkdir -p "$work"
: > "$log"
if [ -n "${GITHUB_OUTPUT:-}" ]; then
  {
    echo "manifest=$manifest"
    echo "before=$before"
    echo "log=$log"
  } >> "$GITHUB_OUTPUT"
fi

# Runs one restore step; on failure its error output (ai-skills messages, never tokens) also goes to the log, which
# the report quotes on the issue.
run_step() {
  local status=0
  "$@" 2> "$work/step.err" || status=$?
  cat "$work/step.err" >&2
  if [ "$status" -ne 0 ]; then
    cat "$work/step.err" >> "$log"
    exit "$status"
  fi
}

review="$skills/social-review/scripts/review-batch.mjs"
validator="$skills/social-review/scripts/social-manifest.mjs"
profile_args=()
if [ -f "$profile" ]; then
  profile_args=(--profile "$profile")
fi

if [ "$mode" = 'approve' ]; then
  comment_id="${SOCIAL_COMMENT_ID:?SOCIAL_COMMENT_ID is required}"
  if ! [[ "$comment_id" =~ ^[1-9][0-9]*$ ]]; then
    echo "::error::Invalid comment id '${comment_id}'."
    exit 1
  fi
  # The approval lands in a temporary file: an Instagram or LinkedIn batch is recorded only once it validates.
  run_step node "$review" approve --issue "$issue" --comment-id "$comment_id" --out "$work/approved.json" \
    ${profile_args[@]+"${profile_args[@]}"}
  if [ "$platform" = 'instagram' ] || [ "$platform" = 'linkedin' ]; then
    run_step node "$validator" validate "$work/approved.json" --for-publish --no-files
    mv "$work/approved.json" "$manifest"
    cp "$manifest" "$before"
    echo "${platform_name} batch approved; the scheduled runs publish each item on its date."
    exit 0
  fi
  mv "$work/approved.json" "$manifest"
else
  gh issue view "$issue" --json body --jq .body > "$work/body.md"
  run_step node "$review" marker "$work/body.md" --out "$manifest"
fi
cp "$manifest" "$before"

run_step node "$review" fetch "$manifest"

case "$platform" in
  facebook) publisher=(node "$skills/facebook-publish/scripts/publish-facebook.mjs" "$manifest" --execute) ;;
  youtube) publisher=(node "$skills/youtube-publish/scripts/publish-youtube.mjs" "$manifest" --execute) ;;
  instagram) publisher=(node "$skills/instagram-publish/scripts/publish-instagram.mjs" "$manifest" --execute --max "$instagram_max") ;;
  linkedin) publisher=(node "$skills/linkedin-publish/scripts/publish-linkedin.mjs" "$manifest" --execute --max "$linkedin_max") ;;
esac
if [ -n "$retry" ]; then
  if [ "$platform" = 'instagram' ] || [ "$platform" = 'linkedin' ]; then
    echo "::warning::${platform_name} resolves unknown items on its own; retry is ignored."
  else
    publisher+=(--retry "$retry")
  fi
fi

set +e
"${publisher[@]}" 2>&1 | tee "$log"
status="${PIPESTATUS[0]}"
set -e
if [ "$status" -ne 0 ] && grep -q 'invalid_grant' "$log"; then
  echo "::error::The OAuth refresh token was rejected (invalid_grant): it expired or was revoked. Authorize again and update the secret (Google consent screens in Testing mode issue tokens that expire after 7 days)."
fi
exit "$status"
