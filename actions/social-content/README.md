# social-content

Deterministic steps of the social content workflows, with no AI involved. The reusable workflows
[`social-content-generate.yml`](../../README.md#social-content), `social-content-adjust.yml`, and
`social-content-publish.yml` run it; call it directly only to build your own variant of them. The batch contract
(manifest, issue markers, state) belongs to the `fbrissi/ai-skills` social skills (`docs/social-content.md` there).

| Command | Used by | What it does |
|---|---|---|
| `fetch-skills` | generate, publish | Downloads `skills-repository` at `skills-ref` (a tag or SHA, never a branch) and keeps only `skills`, so the review and publisher scripts run without a harness. Output `skills-dir`. |
| `setup-media-tools` | generate, adjust | Installs `ffmpeg`/`ffprobe` (apt, when missing) and `piper-tts==<piper-tts-version>` in a virtual environment, and exports `PIPER_PYTHON`. Warns when Docker (image cards) is missing. |
| `matrix` | generate | Turns `platforms` into a JSON array (`facebook`, `instagram`, `youtube`). |
| `prompt` | generate, adjust | Builds the agent prompt (`generate [start <date>] profile <path>` or `adjust <issue> profile <path>`) and the run instructions (non-interactive, platform, label, Drive root, then `instructions`). Validates the date, path, and Drive root. |
| `gate` | adjust, publish | Reads the comment `comment-id` and checks: it starts with `slash-command` followed by a space or the end; the author is not a bot; `GET /repos/{owner}/{repo}/collaborators/{user}/permission` returns `write`, `maintain`, or `admin`; the issue is open, not a pull request, has `label`, and its batch header and manifest marker agree. Reacts `eyes` when allowed. Strangers, bots, and unrelated issues are only logged; a writer on a review issue that cannot take the command gets a reply with the reason. |
| `target` | publish (manual and scheduled runs) | The issue half of `gate`, for runs without a comment. |
| `pending` | publish (scheduled runs) | Open issues with `label` whose `platform` batch is approved for its current revision and still has items that are not `scheduled`, `published`, or `skipped`, oldest first. |
| `publish` | publish | Runs `publish.sh`: `approve` stamps the approval with `review-batch.mjs approve` (Instagram: then `social-manifest.mjs validate --for-publish --no-files`, and stops); `resume` and `sweep` restore the manifest from the issue marker. Then `review-batch.mjs fetch` and the platform publisher with `--execute` (Facebook and YouTube with `--retry`, Instagram with `--max instagram-max`). Outputs `manifest`, `before`, and `log`; restore errors go to the log. |
| `save-state` | publish | Writes the manifest back to the issue body with `review-batch.mjs issue-body`; skips when nothing was restored. |
| `report` | publish | Comments the item table (status, time, link, error), stale items, items that need a manual check, and the publisher notes; closes the issue (`completed`) when every item is scheduled, published, skipped, or stale. With `mode: approved` it confirms an Instagram approval. Scheduled runs comment only when an item's status, result, or error changed, or a failure no item records. With `save-outcome: failure` it only warns that the state was not saved. |
| `adjust-report` | adjust | Comments whether the adjust produced a new revision, none, or failed. |
| `open-review` | generate | Fallback after the agent: for each manifest under `<batches_dir>/<platform>/` written since `since` that no open issue tracks (by `review.issue_number` or by the header), runs the copy guard and validation, uploads to Drive, creates the label when missing, opens `<Platform>: <date> (<n> items)` with `label`, records it with `set-issue`, and rewrites the body. A batch that fails the guard or validation is never opened. With no batch, it fails only when the agent failed. |

## Usage

```yaml
- uses: fbrissi/github-actions/actions/social-content@v1
  id: gate
  with:
    command: gate
    github-token: ${{ github.token }}
    issue: ${{ github.event.issue.number }}
    comment-id: ${{ github.event.comment.id }}
    slash-command: /aprove
    label: marketing-content
```

`gate`, `publish`, `save-state`, `report`, `adjust-report`, and `open-review` need a token with `issues` write;
`target` and `pending` need `issues` read. The collaborator permission endpoint needs only `metadata` read, which every
token has. `publish` and `open-review` read the Drive, Facebook, Instagram, R2, and YouTube variables listed in the
[root README](../../README.md#social-content) from the step environment; empty optional values are unset so the
publishers use their defaults. Every script needs Node.js 22 or newer (installed when missing).
