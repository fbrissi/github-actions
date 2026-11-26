# Dependency updates

Profile of the fbrissi/ai-skills `dependency-updates` skill for this repository, run weekly by `.github/workflows/ai-dependency-update.yml`.

## Scope
- Ecosystems: github-actions
- Directories: github-actions: /actions/* (composite actions)
- Bots: dependabot   # one grouped PR (group `github-actions`), weekly
- Outdated: none

## Branch and PR
- Base branch: main
- Branch template: chore/dependency-updates-{date}
- Labels: dependencies

## Never update
- `.github/workflows/**`: the agent's App token has no `Workflows` permission, so it cannot push workflow changes; leave those updates in the Dependabot PR for a person.

## Hold
- (none)

## Validation
- Checks: `node --test actions/*/*.test.mjs`, actionlint, and shellcheck, as `CONTRIBUTING.md` (Validation) says.
- Extra validation: for each bumped action, read its release notes for changed or removed inputs and outputs and check every `with:` and `steps.<id>.outputs` use in `actions/*/action.yml`; keep major tags (`@v4`), not SHAs, unless the file already pins a SHA.
- Release notes: a new `## vX.Y.Z` section (next patch) at the top of `CHANGELOG.md`, as `CONTRIBUTING.md` (Releases) says.

## Schedule
- Dependabot runs weekly on Monday (default time); this run starts Tuesday 06:00 UTC.
