#!/usr/bin/env bash
# Waits for the newest HCP Terraform run of COMMIT_SHA in TFC_WORKSPACE to apply.
set -euo pipefail

: "${TFC_ORGANIZATION:?organization is required}"
: "${TFC_WORKSPACE:?workspace is required}"
: "${COMMIT_SHA:?commit-sha is required}"
start_timeout_minutes="${START_TIMEOUT_MINUTES:-30}"
poll_interval="${POLL_INTERVAL_SECONDS:-10}"

if [ -z "${TFC_API_TOKEN:-}" ]; then
  echo '::error::The HCP Terraform token is empty.'
  exit 1
fi
for value in "$start_timeout_minutes" "$poll_interval"; do
  if ! [[ "$value" =~ ^[1-9][0-9]*$ ]]; then
    echo "::error::Timeouts and intervals must be positive integers, got '${value}'."
    exit 1
  fi
done

api() {
  curl --fail-with-body --silent --show-error \
    --header "Authorization: Bearer $TFC_API_TOKEN" \
    --header 'Content-Type: application/vnd.api+json' \
    "$@"
}

workspace=$(api "https://app.terraform.io/api/v2/organizations/$TFC_ORGANIZATION/workspaces/$TFC_WORKSPACE")
workspace_id=$(jq --raw-output '.data.id' <<<"$workspace")

attempts=$(((start_timeout_minutes * 60 + poll_interval - 1) / poll_interval))
run_id=''
for ((attempt = 1; attempt <= attempts; attempt++)); do
  runs=$(api --get \
    --data-urlencode "search[commit]=$COMMIT_SHA" \
    --data-urlencode 'page[size]=1' \
    "https://app.terraform.io/api/v2/workspaces/$workspace_id/runs")
  run_id=$(jq --raw-output '.data[0].id // empty' <<<"$runs")

  if [ -n "$run_id" ]; then
    break
  fi

  sleep "$poll_interval"
done

if [ -z "$run_id" ]; then
  echo "::error::Timed out waiting for HCP Terraform to start a run for $COMMIT_SHA in $TFC_WORKSPACE."
  exit 1
fi

echo "run-id=$run_id" >> "$GITHUB_OUTPUT"
run_url="https://app.terraform.io/app/$TFC_ORGANIZATION/workspaces/$TFC_WORKSPACE/runs/$run_id"

while :; do
  run=$(api "https://app.terraform.io/api/v2/runs/$run_id")
  status=$(jq --raw-output '.data.attributes.status' <<<"$run")
  echo "HCP Terraform run $run_id: $status"

  case "$status" in
    applied | planned_and_finished)
      echo "status=$status" >> "$GITHUB_OUTPUT"
      exit 0
      ;;
    planned | policy_checked | policy_override)
      echo 'HCP Terraform is waiting for manual apply approval.'
      ;;
    errored | canceled | force_canceled | discarded | policy_soft_failed)
      echo "::error::HCP Terraform run $run_id ended $status without applying the infrastructure: $run_url"
      echo "To recover, fix the cause, start a new HCP Terraform run for commit $COMMIT_SHA in the" \
        "$TFC_WORKSPACE workspace, wait for it to apply, then re-run this job." \
        'Re-running alone keeps failing because this action always waits for the newest run of the commit.'
      exit 1
      ;;
  esac

  sleep "$poll_interval"
done
