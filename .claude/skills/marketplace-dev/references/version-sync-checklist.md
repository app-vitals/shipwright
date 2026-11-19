# Version Sync Checklist

In this repo, **CI owns the version** — you do not bump it by hand.
This document explains what actually happens on release and how to verify that a
release landed cleanly.

## How Versioning Works

The path is tag-driven (there is no semantic-release workflow).

What actually runs on every merge to `main`:

1. **`.github/workflows/release.yml`** fires once the `CI` workflow succeeds on
   `main` and the merge touched a relevant path (`agent/**`, `plugins/**`,
   `.claude-plugin/**`, `package.json`, `bun.lock`). It uses
   `mathieudutour/github-tag-action` to compute the next version from conventional
   commits since the last `agent-v*` tag (`default_bump: patch`), builds and pushes the
   agent Docker image stamped with that version, then pushes a new `agent-v*` git tag.
2. **`scripts/sync-version.ts`** is run at image build time (`agent/Dockerfile`,
   `ARG AGENT_VERSION`) and stamps the version into the image's copy of the
   package.json files, `version.txt`, and the plugin/marketplace manifests. Nothing is
   committed back to git: the committed `plugin.json` and `marketplace.json` carry no
   `version`, so external `claude plugin marketplace add` installs are versioned by
   commit SHA and every commit is an update.

## Commit Types and the Bump They Trigger

| Commit prefix | Version bump | Notes |
|---|---|---|
| `fix:` | Patch (4.2.0 → 4.2.1) | Bug fixes, doc corrections |
| `feat:` | Minor (4.2.0 → 4.3.0) | New commands, skills, agents, hooks |
| `feat!:` or `BREAKING CHANGE:` footer | Major (4.2.0 → 5.0.0) | Renamed command, changed hook matcher |
| `docs:`, `chore:`, `ci:`, `build:`, `refactor:`, `test:` | No release | Automation ignores these |

If you intended a release but none fired, confirm that at least one commit in the
batch uses a release-triggering prefix (`fix:`, `feat:`, `perf:`, `revert:`), and that
the merge actually touched one of the agent service's trigger paths in `release.yml` — a docs-only PR to
an unrelated path never fires a release regardless of commit prefix.

## Post-Release Verification

After a release merges:

```bash
# 1. Check the new git tag
git fetch --tags
git tag --sort=-creatordate | head -5

# 2. Check the committed files agree with version.txt
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

Do not add a `"version"` to `plugin.json` or `marketplace.json`, and do not hand-edit
version fields elsewhere. Write correct conventional commits and let `release.yml`
do the job. Confirmed the hard way in PR
#1296, where a manual patch bump had to be reverted.
