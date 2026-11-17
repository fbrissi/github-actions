# Contributing

Issues and pull requests are welcome. This library only holds logic shared by at least two projects; keep
project-specific behavior in the calling repository.

## Layout

- `.github/workflows/*.yml` with `on: workflow_call` are the reusable workflows. `quality-checks.yml` and
  `release-orchestrator.yml` run this repository's own CI and releases.
- `actions/<name>/` holds one composite action with `action.yml`, a `README.md`, and any shell scripts it runs.

## Conventions

- Document every input, secret, output, and required permission in the README of the component, and in the root
  README for reusable workflows.
- Pass inputs and event data to scripts through `env`, never by interpolating `${{ }}` inside `run`.
- Keep `permissions: {}` at the workflow level and grant the minimum per job.
- Pin third-party tools to an exact version (and checksum for downloaded binaries).
- Put non-trivial shell logic in `*.sh` files next to the action so shellcheck covers it.
- Commit messages: `feat|fix|chore|docs|refactor|test|style: short lowercase summary`.

## Validation

```bash
docker run --rm -v "$PWD":/repo -w /repo rhysd/actionlint:1.7.12 .github/workflows/*.yml
```

```bash
docker run --rm -v "$PWD":/mnt -w /mnt koalaman/shellcheck:v0.10.0 $(git ls-files '*.sh')
```

CI runs both, plus the release-note check. When they pass, Quality Checks dispatches `pr-code-review.yml` on `main`,
which reviews the pull request with the local `code-review.yml` (set the `CODE_REVIEW_ENABLED` variable to `false` to
turn it off).

## Releases

Every pull request to `main` adds a `## vX.Y.Z` section at the top of [CHANGELOG.md](CHANGELOG.md)
([Keep a Changelog](https://keepachangelog.com/en/1.1.0/) categories). Bump the major version for breaking changes
to inputs, secrets, outputs, or behavior; the minor version for new features; the patch version for fixes.

Merging runs the release orchestrator, which tags `vX.Y.Z`, creates the GitHub release, and moves the major tag
(`v1`). A release can also be run manually from the **Release Orchestrator** workflow.
