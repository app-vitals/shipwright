# Plan Session: patch-cancelled-ci

Repo: app-vitals/shipwright

## Background

PR #2562 (a plan-only PR, already `APPROVED` and `MERGEABLE`) sat stuck with
`mergeStateStatus: BLOCKED` because `patch` never picked it up. Its `lint / typecheck / test`
CI job had `conclusion: "cancelled"` — a bucket neither of patch's two CI-failure checkpoints
recognizes:

- `agent/src/check-patch.ts:194-196`'s `hasFailingCi()` (consumed by `getPatchCandidates`, the
  candidate provider that `shipwright-loop` uses to decide whether to dispatch `patch` at all)
  only matches `conclusion === "failure" || conclusion === "timed_out"`.
- `plugins/shipwright/commands/patch.md:326-327` (Step 3c, the command's own re-validation
  before acting) has the identical narrow match.

`"cancelled"` falls through both, so a PR in this state never gets added to patch's List D,
never gets a CI-fix dispatched, and never surfaces to a human either — it just sits blocked
indefinitely.

## Root Cause

Traced the actual cancellation on PR #2562, run `31500012948`. `ci.yml` declares **no
`concurrency:` block** (unlike `chart-release.yml`, `sync-plugin-version.yml`,
`auto-bump-chart.yml`, `deploy-site.yml`, which do) — so this was not a superseding-push
auto-cancel; nothing else pushed to the branch after.

The `lint / typecheck / test` job (`ci.yml:80`) has `timeout-minutes: 8`. Sampling the prior
15 runs of that job on `main`/PRs, it normally completes in ~2-2.5 minutes. The run on #2562
ran 13 minutes before terminating — roughly 5x normal duration, consistent with a hang or
severe slowdown that hit the job's `timeout-minutes` ceiling. GitHub Actions has a known API
quirk here: a job that hits `timeout-minutes` is reported by the REST/GraphQL API as
`conclusion: "cancelled"`, not `"timed_out"` — the `"Timed out"` label only appears in the
web UI. So this cancellation was very likely a real anomaly (a hung or abnormally slow step),
silently misreported as a routine, ignorable cancellation.

**Why a blanket "treat cancelled as failure" fix is unsafe:** `chart-release.yml`,
`sync-plugin-version.yml`, `auto-bump-chart.yml`, and `deploy-site.yml` all use
`concurrency` + implicit `cancel-in-progress` semantics intentionally — a `cancelled`
conclusion on those workflows is normal, correct, and not a bug. `hasFailingCi()` must not
start flagging those as CI-fix-worthy.

## Design

Add a second, narrower detection path alongside the existing `hasFailingCi()` failure/timed-out
check, scoped specifically to "this PR's latest run for a workflow is cancelled, and no newer
run for that workflow exists" (mirrors the existing latest-run-per-workflow dedup
`hasFailingCi()` already does). Do not fold this into `hasFailingCi()` itself — keep it a
distinct signal so patch can react to it differently.

**`check-patch.ts`:** add a function (e.g. `hasCancelledCi`) next to `hasFailingCi()`
(`~line 179-197`) using the same latest-run-per-workflow map, returning true when the latest
run's `conclusion === "cancelled"`. Surface this as a second field (e.g. `hasCancelled`)
alongside `hasFailing` from `fetchCiStatus` (`~line 630-657`) and thread it through
`getPatchCandidates` so a PR qualifying only via `hasCancelled` (not `hasFailing`) still gets
selected as a patch candidate — otherwise the command-level fix below is unreachable; the
candidate provider is authoritative on qualification (per the Candidate Selection Contract in
`plugins/shipwright/CLAUDE.md`).

**`patch.md`:** in the Step 3c/6b/6c area, branch on which bucket the PR qualified through:

- **`hasFailing` (existing List D — failure/timed_out):** unchanged. Goes straight to the
  existing Step 6c CI-fix subagent dispatch.
- **`hasCancelled` only (new):** first attempt a cheap, no-commit recovery —
  `gh run rerun {run_id}` on the cancelled run — and poll briefly for a terminal conclusion.
  This is safe regardless of *why* it cancelled (timeout blip or an intentional human cancel);
  worst case it's a harmless duplicate run. If the rerun succeeds, the cycle ends with no
  subagent dispatch. If the rerun **also** ends `cancelled` or `failure`, that is real signal —
  fall through to the existing Step 6c CI-fix subagent dispatch, but pass along context noting
  this is a repeated-timeout/hang signal (job ran ~Nx its normal duration) rather than a normal
  assertion failure, so the subagent investigates for a hang/perf regression rather than just
  reading a stack trace that may not exist.
- A PR that qualifies via **both** buckets (a genuine failure on one workflow, a stale cancel
  on another) is treated as List D — the rerun-first step only applies when cancellation is the
  *only* signal.

This sidesteps needing to distinguish "job timeout" from "manual human cancel" via the GitHub
API (which doesn't cleanly expose that distinction) — the rerun itself is the disambiguator.

## Tasks

| Task | Title | Depends on | Blocks | HITL | Status |
|---|---|---|---|---|---|
| PCC-1.1 | Detect stale-cancelled CI in patch; rerun before escalating to CI-fix | — | — | — | pending |

### PCC-1.1: Detect stale-cancelled CI in patch; rerun before escalating to CI-fix

**Description:** `check-patch.ts`'s `hasFailingCi()` and `patch.md`'s Step 3c only treat
`conclusion === "failure" || "timed_out"` as CI-fix-worthy. A PR whose latest CI run is
`cancelled` (e.g. a job hitting `timeout-minutes`, reported by GitHub's API as `cancelled`
rather than `timed_out`) never qualifies for patch dispatch at all and sits blocked
indefinitely with no automated or human-visible signal.

Add a `hasCancelledCi`-style check in `check-patch.ts` (next to `hasFailingCi`, same
latest-run-per-workflow dedup) that flags a PR whose latest run for some workflow is
`cancelled` with no newer run since. Surface it as a distinct field from `getPatchCandidates`
so a PR qualifying only via this new signal is still selected for patch dispatch (per the
Candidate Selection Contract — the candidate provider must recognize it, not just the
command). In `patch.md`, when a PR's *only* signal is the new cancelled bucket, attempt
`gh run rerun {run_id}` and poll for a terminal result before touching anything else; only
escalate to the existing Step 6c CI-fix subagent if the rerun itself fails or cancels again.
The existing failure/timed_out path (List D) is unchanged. Do not treat `cancelled` as
failure-equivalent for workflows that use `concurrency`/`cancel-in-progress`
(`chart-release.yml`, `sync-plugin-version.yml`, `auto-bump-chart.yml`, `deploy-site.yml`) —
scope this to detecting the *specific PR's* latest-run state, not workflow identity, since the
rerun-first step is itself safe to run even on those workflows if they ever end up in this
bucket (a cheap rerun is a no-op either way).

**Acceptance Criteria:**
1. `check-patch.ts` exposes a function detecting "this PR's latest run for some workflow is
   `cancelled`, with no newer run for that workflow since" — distinct from `hasFailingCi()`'s
   failure/timed_out check, using the same latest-run-per-workflow dedup logic. `fetchCiStatus`/
   `getPatchCandidates` surface this as a separate field (e.g. `hasCancelled`) so a PR
   qualifying solely through it is still selected as a patch candidate.
2. `patch.md` adds a branch: a PR qualifying only via the cancelled signal (not `hasFailing`)
   triggers `gh run rerun {run_id}` and a brief poll for a terminal conclusion — no commit, no
   subagent dispatch — before falling through to anything else. A PR with a genuine
   failure/timed_out run (with or without an additional cancelled run) is unaffected and goes
   straight to the existing Step 6c flow.
3. If the rerun itself ends `cancelled` or `failure`, patch falls through to the existing
   Step 6c CI-fix subagent dispatch, with the prompt noting this is a repeated-timeout/hang
   signal (include the job's abnormal duration vs. its typical duration) rather than a normal
   test failure.
4. Test decision: add unit tests to `check-patch.unit.test.ts` (mirroring the existing
   `hasFailingCi` describe block at `~line 1720`) for the new detection function — cancelled
   with no newer run → true; cancelled but a newer successful rerun exists → false; one
   workflow cancelled + another genuinely failed → both signals reported correctly. Add
   content-test coverage in `patch.content.test.ts` asserting the new rerun-first step exists
   in the Step 3c/6c area and is gated on "cancelled-only, no failure/timed_out." No existing
   tests are retired — purely additive.

**Dependencies:** none
**Branch:** `feat/pcc-1-1-rerun-before-escalate-cancelled-ci`
**Layer:** Shared
**Hours:** 4
**HITL:** none
**Complexity:** 4 (`sonnet`) — cross-layer (candidate provider in `agent/src` + plugin command
doc in `plugins/shipwright/`), standard feature, no new abstraction beyond mirroring the
existing `hasFailingCi` pattern
**Safe to deploy standalone:** yes — purely additive; the existing failure/timed_out path is
untouched, and the new cancelled-bucket path is a no-op for any PR that never lands in it.
