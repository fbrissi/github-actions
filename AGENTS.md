# Agent guide

Reusable GitHub Actions workflows (`.github/workflows/*.yml` with `on: workflow_call`) and composite actions (`actions/<name>/`). Conventions, validation, and releases are in [CONTRIBUTING.md](CONTRIBUTING.md); this file lists what an agent needs to change and check code here.

## Commands

- Unit tests: `node --test actions/*/*.test.mjs tests/*.test.mjs` (Node.js 24; the `tests/` release-note tests need bash 4+ and skip on older bash).
- Workflow lint: `actionlint .github/workflows/*.yml` (or `docker run --rm -v "$PWD":/repo -w /repo rhysd/actionlint:1.7.12 .github/workflows/*.yml`).
- Shell lint: `docker run --rm -v "$PWD":/mnt -w /mnt koalaman/shellcheck:v0.10.0 $(git ls-files '*.sh')`.

## Rules

- Document every input, secret, output, and required permission in the component's README and, for reusable workflows, the root README.
- Pass inputs to scripts through `env`, never `${{ }}` inside `run`; keep `permissions: {}` at the workflow level.
- Commits: `feat|fix|chore|docs|refactor|test|style: short lowercase summary`.
- Every PR into `main` adds one new `## vX.Y.Z` section at the top of `CHANGELOG.md` (major for breaking input, secret, output, or behavior changes; minor for features; patch for fixes). Merging tags the release; never move tags by hand.
- AI flows: `docs/ai/` holds the profiles of the AI agents that run on this repository (`ai-dependency-update.yml`).
