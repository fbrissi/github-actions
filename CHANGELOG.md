# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). Release headings use the `## vMAJOR.MINOR.PATCH` form;
merging a pull request that adds one tags the release and moves the major tag.

## v1.0.0

### Added

- `code-review.yml` reusable workflow: reviews a pull request with an AI harness and reports a `Code Review` check run on the PR head commit. Supports OpenCode (Kompass `pr/review` by default) and Claude Code with the `review-changes` skill from a pinned `fbrissi/ai-skills` tag or from the PR base commit, publishes the review through a GitHub App, and verifies that a review was published for the head commit.
- `release-note.yml` reusable workflow: requires a pull request to add exactly one `## vX.Y.Z` heading as the first changelog release, with notes and no existing tag, optionally matching `package.json`.
- `release.yml` reusable workflow: releases the first changelog version of a merged pull request (or a given version), idempotently creates the tag and the GitHub release, optionally waits for the HCP Terraform apply of the commit, dispatches a deploy workflow on the tag, and moves the major tag.
- `ai-harness` action: installs pinned OpenCode 1.19.5 (SHA-256 verified) or Claude Code 2.1.319, installs skills from a pinned repository ref or a local directory, and runs one non-interactive prompt.
- `terraform-cloud-wait` action: waits for the newest HCP Terraform run of a commit to apply.
- Repository quality checks (actionlint, shellcheck, release note) and release orchestration for this repository.
