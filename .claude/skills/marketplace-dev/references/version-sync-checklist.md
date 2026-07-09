# Version Sync Checklist

In this repo, **CI owns the version** — you do not bump it by hand.
This document explains what actually happens on release and how to verify that a
release landed cleanly.

## How Versioning Works

The live path is tag-driven, not the `release.yml` semantic-release job you'll see in
`.releaserc.json` — that job is `workflow_dispatch`-only, admin-gated, and requires
`RELEASE_APP_ID` / `RELEASE_APP_PRIVATE_KEY` secrets that aren't provisioned. It exists
as a manual escape hatch, not the thing that runs on every merge.

What actually runs on every merge to `main`:

1. **`.github/workflows/build-agent.yml`** fires once the `CI` workflow succeeds on
   `main` and the merge touched a relevant path (`agent/**`, `plugins/**`,
   `.claude-plugin/**`, `package.json`, `bun.lock`). It uses
   `mathieudutour/github-tag-action` to compute the next version from conventional
   commits since the last `agent-v*` tag (`default_bump: patch`), builds and pushes the
   agent Docker image stamped with that version, then pushes a new `agent-v*` git tag.
2. **`.github/workflows/sync-plugin-version.yml`** triggers on that `agent-v*` tag push.
   It checks out `main`, runs:
   ```
   bun run scripts/sync-version.ts <version>
   ```
3. **`scripts/sync-version.ts`** writes the new version into six files:

   | File | What it updates |
   |------|----------------|
   | `package.json` | Root `"version"` field |
   | `plugins/shipwright/package.json` | Plugin workspace `"version"` field |
   | `plugins/shipwright/.claude-plugin/plugin.json` | Plugin manifest `"version"` field |
   | `metrics/package.json` | Metrics workspace `"version"` field |
   | `agent/package.json` | Agent workspace `"version"` field |
   | `version.txt` | Plain-text version string |

   Plus a seventh, `.claude-plugin/marketplace.json` — this one is already live (not
   pending any follow-up work); external installs via `claude plugin marketplace add`
   read this file directly, so it's the reason `sync-plugin-version.yml` exists at all
   rather than relying solely on the build-time stamp in the Docker image.
4. The workflow commits the change to a branch (`chore/plugin-version-v<version>`),
   opens a PR, waits for required checks, and self-merges with `--admin` (squash,
   `[skip ci]` on the subject so the merge doesn't re-trigger build workflows).

## Commit Types and the Bump They Trigger

| Commit prefix | Version bump | Notes |
|---|---|---|
| `fix:` | Patch (4.2.0 → 4.2.1) | Bug fixes, doc corrections |
| `feat:` | Minor (4.2.0 → 4.3.0) | New commands, skills, agents, hooks |
| `feat!:` or `BREAKING CHANGE:` footer | Major (4.2.0 → 5.0.0) | Renamed command, changed hook matcher |
| `docs:`, `chore:`, `ci:`, `build:`, `refactor:`, `test:` | No release | Automation ignores these |

If you intended a release but none fired, confirm that at least one commit in the
batch uses a release-triggering prefix (`fix:`, `feat:`, `perf:`, `revert:`), and that
the merge actually touched one of `build-agent.yml`'s trigger paths — a docs-only PR to
an unrelated path never fires a release regardless of commit prefix.

## Post-Release Verification

After a release merges and `sync-plugin-version.yml` completes:

```bash
# 1. Check the new git tag
git fetch --tags
git tag --sort=-creatordate | head -5

# 2. Verify all files match the new tag
bun run scripts/sync-version.ts --check
```

`--check` compares `version.txt` (canonical) against all six package.json/plugin.json
files and `marketplace.json`, and is wired into CI as the `check-version-sync` task
(`Taskfile.yml`) — so drift fails CI on its own, independent of this checklist.

## What to Do If Files Are Out of Sync

If a file shows the wrong version after a release:

1. **Do not hand-edit** the version field — run the script instead:
   ```bash
   bun run scripts/sync-version.ts <correct-version>
   ```
2. Commit the fix with `chore: resync version to <version>` (no release triggered).
3. The next `feat:` or `fix:` commit will cut a fresh release from the corrected base.

## Reminder: Never Manually Bump Versions

Do not edit `"version"` in any `package.json`, `plugin.json`, or `marketplace.json` by
hand — the automation owns these and a manual edit just conflicts with (or gets
overwritten by) the next tag-triggered sync. Write correct conventional commits and let
`build-agent.yml` / `sync-plugin-version.yml` do the job. Confirmed the hard way in PR
#1296, where a manual patch bump had to be reverted.
