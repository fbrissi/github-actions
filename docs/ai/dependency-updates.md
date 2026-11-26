# Dependency updates

Profile of the fbrissi/ai-skills `dependency-updates` skill for this repository, run weekly by `.github/workflows/ai-dependency-update.yml`.

## Scope
- Ecosystems: github-actions
- Directories: github-actions: /actions/* (composite actions)
- Bots: dependabot   # one grouped PR (group `github-actions`), weekly
- Outdated: none

## Branches and PR
- Base branch: main
- Bugfix release branch: base   # no release branches here: every PR into main is a release, so non-urgent updates also go to main (as `bugfix/dependency-updates-<date>`), security ones as `hotfix/dependency-updates-<date>`
- Labels: dependencies

## Never update
- `.github/workflows/**`: the agent's App token has no `Workflows` permission, so it cannot push workflow changes; leave those updates in the Dependabot PR for a person (that PR then stays partly superseded).

## Hold
- (none)

## Supply chain
- Minimum release age: 3d   # also worth a Dependabot `cooldown`
- Install scripts: off (no package manager installs here)
- Secrets: `AGENT_APP_PRIVATE_KEY` and the harness keys only

## Validation
- Checks: `node --test actions/*/*.test.mjs`, actionlint, and shellcheck, as `CONTRIBUTING.md` (Validation) says.
- Extra validation: for each bumped action, read its release notes for changed or removed inputs and outputs and check every `with:` and `steps.<id>.outputs` use in `actions/*/action.yml`; keep major tags (`@v4`), not SHAs, unless the file already pins a SHA.
- Release notes: a new `## vX.Y.Z` section (next patch) at the top of `CHANGELOG.md`, as `CONTRIBUTING.md` (Releases) says.

## Schedule
- Dependabot runs weekly on Monday (default time); this run starts Tuesday 06:00 UTC.
