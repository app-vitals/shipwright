# Version Sync Checklist

In this repo, **semantic-release owns the version** — you do not bump it by hand.
This document explains what actually happens on release and how to verify that a
release landed cleanly.

## How Versioning Works

On every merge to `main`, the CI release job runs:

1. **`@semantic-release/commit-analyzer`** reads all conventional commits since the
   last tag and determines the next version (patch / minor / major).
2. **`prepareCmd`** in `.releaserc.json` calls:
   ```
   bun scripts/sync-version.ts ${nextRelease.version}
   ```
3. **`scripts/sync-version.ts`** writes the new version to five files:

   | File | What it updates |
   |------|----------------|
   | `package.json` | Root `"version"` field |
   | `plugins/shipwright/package.json` | Plugin workspace `"version"` field |
   | `metrics/package.json` | Metrics workspace `"version"` field |
   | `agent/package.json` | Agent workspace `"version"` field |
   | `version.txt` | Plain-text version string |

4. A sixth file, `.claude-plugin/marketplace.json`, will also be synced once
   MKT-1.2 lands (the file does not exist yet).

## Commit Types and the Bump They Trigger

| Commit prefix | Version bump | Notes |
|---|---|---|
| `fix:` | Patch (4.2.0 → 4.2.1) | Bug fixes, doc corrections |
| `feat:` | Minor (4.2.0 → 4.3.0) | New commands, skills, agents, hooks |
| `feat!:` or `BREAKING CHANGE:` footer | Major (4.2.0 → 5.0.0) | Renamed command, changed hook matcher |
| `docs:`, `chore:`, `ci:`, `build:`, `refactor:`, `test:` | No release | Automation ignores these |

If you intended a release but none fired, confirm that at least one commit in the
batch uses a release-triggering prefix (`fix:`, `feat:`, `perf:`, `revert:`).

## Post-Release Verification

After a release merges and the CI release job completes:

```bash
# 1. Check the new git tag
git fetch --tags
git tag --sort=-creatordate | head -5

# 2. Verify all five files match the new tag
grep '"version"' package.json
grep '"version"' plugins/shipwright/package.json
grep '"version"' metrics/package.json
grep '"version"' agent/package.json
cat version.txt
```

All five should show the same version string.

## What to Do If Files Are Out of Sync

If a file shows the wrong version after a release:

1. **Do not hand-edit** the version field — run the script instead:
   ```bash
   bun scripts/sync-version.ts <correct-version>
   ```
2. Commit the fix with `chore: resync version to <version>` (no release triggered).
3. The next `feat:` or `fix:` commit will cut a fresh release from the corrected base.

## Reminder: Never Manually Bump Versions

Do not edit `"version"` in `package.json`, `plugin.json`, or `marketplace.json` by
hand. The automation owns these. Write correct conventional commits and let
semantic-release do its job.
