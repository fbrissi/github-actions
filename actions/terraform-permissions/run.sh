#!/usr/bin/env bash
# Decides between the static and the live permission check, then runs check-terraform-permissions.mjs.
# A skipped live check is always reported as a notice or warning and in the step summary, never as a silent pass.
set -euo pipefail

script="$GITHUB_ACTION_PATH/check-terraform-permissions.mjs"

not_checked() {
  local level="$1" message="$2"
  echo "::${level} title=Cloudflare token not checked::${message}"
  printf '### Cloudflare token permissions\n\n**Live check not run.** %s\n' "$message" >> "${GITHUB_STEP_SUMMARY:-/dev/null}"
}

mode="${MODE:-auto}"
case "$mode" in
  auto | static | live) ;;
  *)
    echo "::error::Input mode must be auto, static, or live, not \"$mode\"."
    exit 1
    ;;
esac

if [ "$mode" = auto ]; then
  case "$EVENT_NAME" in
    pull_request)
      if [ -z "$BASE_SHA" ] || [ -z "$HEAD_SHA" ]; then
        mode=live
      else
        # A failing diff (for example a shallow checkout) stops the job instead of skipping the live check.
        changed=$(git diff --name-only "$BASE_SHA...$HEAD_SHA")
        # grep exits 1 for no match and 2 for an invalid pattern; only a real "no match" may skip the live check.
        grep -qE "$CHANGE_PATTERN" <<<"$changed" && match=0 || match=$?
        case "$match" in
          0)
            mode=live
            ;;
          1)
            mode=static
            not_checked notice "No changed file matches \"$CHANGE_PATTERN\" in this pull request; only the manifest was checked."
            ;;
          *)
            echo "::error::Input change-pattern \"$CHANGE_PATTERN\" is not a valid extended regular expression."
            exit 1
            ;;
        esac
      fi
      ;;
    push)
      if [ "$REF" = "$DEFAULT_REF" ]; then
        mode=live
      else
        mode=static
        not_checked notice "Pushes to $REF only run the static manifest check; the default branch, schedules, and manual runs run the live check."
      fi
      ;;
    *)
      mode=live
      ;;
  esac
fi

if [ "$mode" = live ] && [ -z "${CLOUDFLARE_API_TOKEN:-}" ]; then
  if [ "$IS_FORK" = true ] || [ "$PR_AUTHOR" = 'dependabot[bot]' ]; then
    not_checked warning "Fork and Dependabot pull requests receive no secrets. The token was NOT checked; the next pull request from this repository or the push to the default branch checks it."
    mode=static
  else
    echo '::error::The Cloudflare token is empty: pass the Terraform token secret to this workflow so its permissions can be checked.'
    exit 1
  fi
fi

if [ "$mode" = live ]; then
  node "$script" --live
else
  node "$script"
fi
