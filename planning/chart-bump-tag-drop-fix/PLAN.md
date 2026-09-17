# Plan Session: chart-bump-tag-drop-fix

Repo: app-vitals/shipwright

## Input

Follow-up from the sessions-list-filter-fix investigation (Dan, Slack): the Sessions
page's Org filter fix (#3490) took ~6.5 hours to reach production after merging, even
though it was tagged into a release within seconds. Dan asked to diagnose the
deployment delay.

## Investigation

Traced the full release chain for `task-store-v1.139.0` (the tag containing the org
filter fix, cut 2026-09-16 15:40:22 UTC — same instant as four other same-day releases:
`admin-v1.186.0`, `chat-v1.102.0`, `mcp-server-v0.100.0`, `metrics-v1.107.0`).

The chart-bump commit that ran immediately after that batch (`chore(chart): bump chart
version to 1.20.72`, merged ~15:52 UTC) credited **only `metrics-v1.107.0`** — the other
four tags from the exact same batch, including `task-store-v1.139.0`, were silently
dropped and never credited by any chart version. Confirmed this wasn't task-store-specific:
`admin-v1.186.0` was also permanently skipped (`charts/shipwright/values.yaml`'s admin
pin jumps straight from `admin-v1.185.0` to `admin-v1.187.0`, never referencing `.186.0`).
The org filter fix only reached production because `task-store-v1.140.0` happened to
release again at 22:03 UTC, and that batch's resulting chart bump (1.20.74) picked up
"whatever is currently latest" for task-store as a side effect — incidentally
forward-filling the earlier gap. Had no later task-store release landed that day, the
fix would have stayed silently unshipped indefinitely.

**Root cause** (`.github/workflows/auto-bump-chart.yml`'s `collect_batch_tags()`,
mirrored in `.github/workflows/test-auto-bump-chart.sh`): it decides which tags are
"new" by comparing each tag's creation timestamp against the **merge timestamp of the
previous chart-bump PR** (`since = git log -1 --format=%cI $last_bump_sha`), not against
which tags that PR actually credited. When a new batch of release tags lands *while* an
earlier, unrelated chart-bump PR is still open (waiting on CI/review), the new batch's
tags predate that PR's eventual merge time, so the next run wrongly concludes they were
"already covered" by it. Only the one tag whose push happens to win the
`chart-bump-debounce` concurrency-group race gets rescued (via the
`found=false → tags+=("$trigger_tag")` fallback); every other tag in that batch is
dropped with no error, no warning, nothing in the logs.

Confirmed this is a known-but-unfixed defect class: `.github/workflows/check-chart-drift.yml`
(daily cron, 09:00 UTC) already exists specifically to catch "a race condition in
auto-bump-chart.yml's debounce/burst handling" per its own header comment — a detection
backstop was built, but the root cause in `collect_batch_tags()` was never fixed. It
didn't fire on this incident because the gap self-healed (~22:10 UTC) before the next
scheduled 09:00 UTC run.

The drift-check's own building blocks are the fix: `lib/chart-drift-check.sh`'s
`read_pinned_tag()` (reads what's currently pinned in `values.yaml`) and
`lib/chart-tag-utils.sh`'s `highest_semver_tag()` already implement, and have test
coverage for, exactly the "is this service's tag actually reflected in values.yaml"
comparison that `collect_batch_tags()` should be doing instead of a wall-clock heuristic.

## Design

**CBT-1.1** — replace timestamp-based tag collection with a drift-based diff:
- Move `read_pinned_tag()` from `lib/chart-drift-check.sh` into `lib/chart-tag-utils.sh`
  (a generic dot-path reader with no drift-specific meaning — belongs alongside
  `service_for_tag`/`values_paths_for_service`/`highest_semver_tag`).
  `chart-drift-check.sh` keeps calling it, now via the existing
  "source chart-tag-utils.sh then chart-drift-check.sh" order already used by
  `check-chart-drift.yml` — no behavior change there.
- Add `compute_batch_from_drift()` to `lib/chart-tag-utils.sh`: for each of the 5 service
  patterns, finds the highest-semver `{service}-v*` tag and compares it against
  `read_pinned_tag()`'s current value in `charts/shipwright/values.yaml` on the checked-out
  ref; a service is included in the batch only when the two differ.
- `auto-bump-chart.yml`'s "Resolve chart version bump (retry on branch collision)" step:
  replace the inlined `collect_batch_tags()` body with a call into
  `compute_batch_from_drift()` (sourcing `lib/chart-tag-utils.sh`). The surrounding
  `resolve_batch_with_retry`/`compute_batch_and_version` retry loop is otherwise
  unchanged — a collision retry already re-fetches fresh main before recomputing, which
  is now correct by construction since the new logic diffs live state rather than
  history.
- **Behavior change:** if a trigger fires but the recomputed batch is empty (nothing
  actually drifted — e.g. a concurrent run already pinned everything), skip opening a
  chart-bump PR entirely instead of the old behavior of always crediting the trigger tag
  even when redundant. Mirrors vitals-os's own `bump-shipwright-chart.yml`'s
  "Nothing to commit — already up to date" bail-out. Confirmed with Dan before
  finalizing this plan.
- `test-auto-bump-chart.sh`: replace the `collect_batch_tags` test block with coverage
  for `compute_batch_from_drift()`'s behavior, plus a regression test that reproduces
  this exact incident shape (two service-tag batches landing back-to-back, where the
  second batch's tags predate the first batch's PR merge timestamp) and asserts nothing
  gets dropped. The file keeps its existing convention of inlining its own copies of the
  tag-utils helpers rather than sourcing `lib/chart-tag-utils.sh` directly — that
  pre-existing inconsistency (noted in `lib/chart-tag-utils.sh`'s own header comment) is
  out of scope for this bug fix.

No API/schema/interface change — the resulting chart-bump PR format, branch naming, and
credited-tags commit message are unchanged, so nothing downstream (vitals-os's
`growth/src/shipwright-release-poller.ts` / `bump-shipwright-chart.yml`) needs updating.

Safe to deploy standalone: yes — internal selection-logic fix only, no renames/removals
of anything external consumers depend on.

## Decision Log

- Single task, not split workflow-logic-from-tests: this repo's convention is tests land
  with the code in the same PR; splitting here would leave an unsafe intermediate state
  (rewritten selection logic with stale test coverage).
- Not fixing `test-auto-bump-chart.sh`'s pre-existing inline-copy-vs-source inconsistency
  with `lib/chart-tag-utils.sh`: real, but unrelated to this bug — keeps the fix PR
  scoped and reviewable.
- Skip opening a PR on an empty recomputed batch (behavior change from today's
  always-credit-the-trigger-tag fallback): confirmed with Dan — strictly more correct,
  avoids a redundant/no-op chart version bump.

## Task Breakdown

| Task | Title | Layer | Complexity | Model | Hours | Depends on | HITL |
|---|---|---|---|---|---|---|---|
| CBT-1.1 | Replace timestamp-based tag collection in auto-bump-chart.yml with drift-based diff | CLI | 4 | sonnet | 5 | — | |

### Dependency graph

```
[START]
  └─ CBT-1.1: drift-based tag collection (no deps)
```

HITL scan: no tasks require human steps. `auto-bump-chart.yml` already uses
`secrets.GITHUB_TOKEN` and `secrets.DISPATCH_TOKEN` elsewhere in the same file — no
net-new secret is introduced by this change.
