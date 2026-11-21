# terraform-permissions

Catches a Terraform change that needs a Cloudflare API token permission the token lacks, in CI before merge,
instead of a `403 Authentication error` in the HCP Terraform apply after merge.

The calling repository keeps a permission manifest (by default `terraform/cloudflare-token-permissions.json`) that
maps every `cloudflare_*` resource and data source type in its Terraform files to the API permission groups it needs.
The action runs two checks:

- **Static** (no network): fails when a `.tf` file uses a Cloudflare type, or a `cloudflare_ruleset` phase, missing
  from the manifest, or when the manifest lists one that is no longer used. Files it cannot parse reliably
  (unterminated comments, heredocs or strings, unusual block headers, `*.tf.json`, a Cloudflare provider under
  another local name) fail the check instead of passing.
- **Live**: verifies the real token (account token, then user token), reads its own policies and the permission group
  list, and emits one `::error::` per missing group, naming the group, the scope, the dashboard path, the secret, and
  the resource types that need it. A step summary table lists every group.

Prefer the [`terraform-permissions.yml`](../../README.md#terraform-permissions) reusable workflow, which checks out
the repository with the history this action needs.

## Usage

```yaml
jobs:
  terraform-permissions:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@v7
        with:
          fetch-depth: 0
          persist-credentials: false
      - uses: fbrissi/github-actions/actions/terraform-permissions@v1
        with:
          cloudflare-api-token: ${{ secrets.CLOUDFLARE_API_TOKEN }}
```

## Inputs

| Input | Default | Description |
|---|---|---|
| `cloudflare-api-token` | `""` | The Cloudflare API token Terraform uses. |
| `manifest` | `terraform/cloudflare-token-permissions.json` | Permission manifest path. |
| `terraform-directory` | `terraform` | Directory scanned for `*.tf` files (recursively, skipping dot directories). |
| `mode` | `auto` | `auto`, `static`, or `live` (see below). |
| `change-pattern` | `^terraform/` | Extended regex matched against the files a pull request changes. |

With `mode: auto` the live check runs on pull requests that change a file matching `change-pattern`, on pushes to the
default branch, and on every other event (schedule, manual run). Otherwise only the static check runs and a notice says
so. When the live check should run but the token is empty, fork and Dependabot pull requests get a warning (they
receive no secrets) and every other run fails.

## Manifest

```json
{
  "credential": {
    "githubSecret": "CLOUDFLARE_API_TOKEN",
    "terraformCloudVariable": "CLOUDFLARE_API_TOKEN",
    "syncHint": "run rotate-credentials.yml in manual mode"
  },
  "scopes": {
    "account": { "idLocal": "cloudflare_account_id" },
    "zone": { "idLocal": "cloudflare_zone_id", "nameLocal": "domain" }
  },
  "dashboardLabels": { "Dynamic URL Redirects Write": "Single Redirect: Edit" },
  "resources": {
    "cloudflare_dns_record": {
      "endpoints": ["/zones/{zone_id}/dns_records"],
      "permissions": [{ "scope": "zone", "group": "DNS Write" }]
    },
    "cloudflare_queue": {
      "permissions": [{ "scope": "account", "group": "Queues Write", "anyOf": ["Workers Scripts Write"] }]
    },
    "cloudflare_ruleset": {
      "phases": {
        "http_request_dynamic_redirect": {
          "permissions": [{ "scope": "zone", "group": "Dynamic URL Redirects Write" }],
          "unconfirmed": "Why this mapping is not in the OpenAPI spec."
        }
      }
    }
  },
  "dataSources": {
    "cloudflare_account_api_token_permission_groups_list": {
      "permissions": [{ "scope": "account", "group": "Account API Tokens Read", "anyOf": ["Account API Tokens Write"] }]
    }
  }
}
```

- `credential`: names used in messages. `syncHint` is how to copy a replaced token to HCP Terraform; it defaults to
  updating the `terraformCloudVariable` with the same token.
- `scopes`: names of the Terraform locals (a `name = "value"` line in any `.tf` file) that hold the account ID, zone
  ID, and zone name.
- `permissions`: `scope` is `account` or `zone`; `group` is the API permission group name from
  `GET /accounts/{account_id}/tokens/permission_groups`; `anyOf` lists other groups that also satisfy it.
- Take group names from the `x-api-token-group` values the
  [Cloudflare OpenAPI spec](https://github.com/cloudflare/api-schemas) lists for every endpoint the type calls.
  `endpoints` and `unconfirmed` are free-form documentation.
- `cloudflare_ruleset` is mapped per `phase`, which must be a string literal.

## Token requirements and limits

- The token needs Account API Tokens Read (or Write) for an account-owned token, or API Tokens Read for a user token,
  so the check can read its own policies.
- The token reaches curl on stdin, never on the command line; it is masked and redacted from every message.
- A network failure, HTTP 429 or 5xx, or an unexpected body fails as "Cloudflare API unavailable, token not judged",
  never as a bad token. Only HTTP 401/403 or Cloudflare codes 9106, 9109, and 10000 mean the token was refused.
- Deny policies are matched broadly and allow policies strictly, so the check can fail falsely but not pass falsely.
- It checks the GitHub secret. HCP Terraform keeps its own copy, so keep both on the same token. A client IP filter on
  the token raises a warning, because the check only proves GitHub runners can use it.
