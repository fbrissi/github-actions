# setup-gh

Makes the GitHub CLI (`gh`) available on any Linux runner, including self-hosted runners whose image lacks it. When
`gh` is on the `PATH` (and at least `min-version`, when set), it does nothing. Otherwise it downloads the pinned
official release for the runner's architecture (`linux_amd64` or `linux_arm64`) into `RUNNER_TEMP`, checks its SHA-256,
and adds it to the `PATH` of the following steps. It needs no root, no package manager, and no token.

The [`ai-harness`](../ai-harness/README.md) action runs it whenever it gets a `github-token`, so agents always have
`gh`; the reusable workflows also run it before their own `gh` steps.

## Usage

```yaml
steps:
  - uses: fbrissi/github-actions/actions/setup-gh@v1
  - run: gh api user
    env:
      GH_TOKEN: ${{ github.token }}
```

## Inputs

| Input | Default | Description |
|---|---|---|
| `min-version` | `""` | Lowest installed gh version to keep, for example `2.48.0` for `gh api --slurp`. Empty keeps any installed gh. |

The pinned version and checksums live in `setup-gh.sh`. Run the tests with `node --test actions/setup-gh/*.test.mjs`.
