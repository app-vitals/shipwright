/**
 * agent/src/pr-state-reconciler.ts
 *
 * PR state reconciler — self-heals task-store PullRequest records left
 * state:"open" after an untracked merge/close (a session crashed or hung
 * AFTER the real work happened on GitHub but BEFORE the completion PATCH
 * ran). Mirrors task-store's own StaleClaimReaper pattern (batch-scan +
 * per-item resolve + defensive continue-on-error) — see
 * task-store/src/stale-claim-reaper.ts — but lives in agent/src since it
 * needs GitHub read access, which agent/src/check-helpers.ts already
 * provides (ghJson, resolveAllRepos, splitOrgRepo, createTaskStoreClient).
 *
 * Unlike the claim reaper (crash backstop for the *claim* fields only), this
 * reconciles the *business state* (state/mergedAt) against GitHub reality,
 * closing the gap CHU-1.x left: check-deploy.ts/check-review.ts/check-patch.ts
 * only ever scan GitHub's *open* PR list, so a merged/closed PR silently
 * drops out of view before its task-store record gets corrected.
 *
 * This is a pure background interval (agent/src/index.ts), not a Claude
 * session and not folded into the loop-orchestrator's per-tick candidate
 * collection — purely mechanical field sync, no judgment required, and
 * running it every tick would multiply gh API calls unnecessarily.
 *
 * Usage: register via setInterval(() => void reconciler.reconcile(), <ms>)
 * with a 30-60 minute interval — see agent/src/index.ts.
 *
 * CHU-2.2 extends this module with a second, causally distinct step:
 * `reconcileReviewState()` self-heals task-store reviewState:"pending"
 * records that are actually terminal on GitHub. Unlike the state/mergedAt
 * drift above (a crash/hang case), this drift comes from an out-of-band
 * reviewer — a review posted directly to GitHub by an identity not wired
 * into any code path that writes to the task-store — so a stuck-pending
 * record would otherwise re-trigger check-review.ts's eligibility gate
 * (agent/src/check-review.ts) forever, spawning a full review sub-agent
 * every time even though nothing is left to review. It shares this file's
 * repo-iteration/page-until-partial/continue-on-error scaffolding and reuses
 * the SAME setInterval tick in agent/src/index.ts — not a second timer.
 *
 * CHU-2.4 extends `reconcileReviewState()` with the mirror-image healing
 * direction of CHU-2.2's pending→terminal pass above: a record stuck at
 * reviewState:"posted" whose review(s) are no longer at the current head
 * commit at all (a new commit landed since the posted verdict, but nothing
 * reset reviewState back to pending — confirmed live on
 * app-vitals/shipwright#1814) gets PATCHed back to "pending" so
 * check-review.ts's dedup guard (`commitSha === headRefOid && reviewState
 * !== "pending" -> skip`) stops trapping the PR out of every phase's
 * candidate set. Runs as a second per-repo pass inside the same
 * `reconcileReviewState()` function — no new setInterval tick.
 *
 * PSR-1.1 introduced an `updatedSince` recency window on
 * `reconcilePrOpenTasks`, `reconcilePrState`'s own open-record scan, and
 * `reconcileReviewState`'s pending-record scan, to stop a full-table
 * gh-backed scan every tick from exhausting the shared GitHub GraphQL rate
 * limit on a long tail of untouched fixture/smoke-test records. An initial
 * 1-hour window was too tight (see this PR's own review history): every one
 * of those passes exists specifically to heal a record that is stuck
 * precisely BECAUSE nothing will ever touch its `updatedAt` again after the
 * crash/hang that stranded it — the exact reasoning `listPostedReviewRecords`
 * (CHU-2.4) is permanently exempted for below — so a record that aged out of
 * a too-tight window before the next tick caught it would never be healed
 * again. Rather than dropping the filter entirely (which fully reverts the
 * rate-limit mitigation), the window was widened to
 * `RECONCILER_UPDATED_SINCE_WINDOW_MS` (default 6h — several multiples of
 * the reconciler's own 30-60 minute tick interval), so a single missed or
 * delayed tick (restart, deploy) still self-corrects on the next tick or two
 * without ever fully losing the ability to heal a stuck record. `computeUpdatedSinceCutoff`
 * centralizes the cutoff computation used by these passes.
 *
 * RDG-1.1 extends `reconcilePrOpenTask()`'s DIRECT path (`task.pr` set) with
 * the same bundle-mate headcount (BBR-1.1) + startedAt (RCP-1.1) precondition
 * the branch-fallback path already enforced — a trailing sibling task on a
 * multi-task branch could otherwise ride a bundle-mate's real merge to
 * "merged" status via its own `task.pr` field alone, without its own
 * startedAt ever having been set. Confirmed live: IC-1.2/1.3/1.4, DPF-2.2,
 * PW-1.2, SBA-1.2 all false-completed this way (reset to pending as a
 * separate data fix). The guard only applies when the task also has a
 * `branch` set (the two fields can coexist); a `task.pr`-set task with no
 * branch, or on a solo-task branch, is unaffected and still advances purely
 * on GitHub's MERGED confirmation, as before.
 */

import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_CLAIM_TTL_MS } from "@shipwright/lib/claim-ttl";
import {
  classifyReviewState,
  createPrRecordQuery,
  hasAnyReviewAtHead,
  readCleanupAfterDays,
  readCleanupMergedWorktrees,
  resolveAllRepos,
  resolveWorkspacePath,
  splitOrgRepo,
} from "./check-helpers.ts";
import type { PrReviewData } from "./check-patch.ts";
import type { Clock } from "./clock.ts";
import { SystemClock } from "./clock.ts";

// ─── Types ────────────────────────────────────────────────────────────────────

/** Minimal shape of a task-store PullRequest record this reconciler needs. */
export interface PrStateRecord {
  id: string;
  repo: string;
  prNumber: number;
  state: string;
  /** Present when this record was fetched for the taskId-backfill lookup; absent/undefined elsewhere. */
  taskId?: string | null;
  /** Merge commit SHA. */
  commitSha?: string | null;
}

/** Result of `gh pr view <n> --json state,mergedAt,headRefName`. */
export interface GhPrView {
  state: "OPEN" | "MERGED" | "CLOSED";
  mergedAt: string | null;
  /**
   * Source branch name (WTR-1.3) — reused to derive the worktree-cleanup
   * side effect's branch slug in `reconcileRecord()` below, piggybacking on
   * this same `gh pr view` call instead of adding a second GitHub lookup.
   * Optional so pre-existing fixtures/fakes that don't set it keep
   * typechecking; `reconcileRecord()` defensively skips worktree removal
   * when it's missing or empty.
   */
  headRefName?: string;
}

/** Minimal shape of a task-store Task this reconciler needs for the pr_open pass (DSR-1.1). */
export interface PrOpenTaskRecord {
  id: string;
  repo?: string;
  pr?: number;
  branch?: string;
  /** Merge timestamp; read by the deploying→deployed pass (DSR-2.1) to gate against a stale promote run. */
  mergedAt?: string | null;
  /**
   * Task-store's write-once "first claimed at" timestamp (RCP-1.1) —
   * task-service.ts's claim() sets this via COALESCE (never overwritten on a
   * re-claim) and release() (task-store/src/task-service.ts:450-464) leaves
   * it untouched even though it nulls `claimedAt` back out. This is the
   * durable signal `reconcilePrOpenTask`'s two branch-based heal paths
   * (the direct path with a `branch` set, and the branch-fallback path) gate
   * on: `null`/`undefined` (never claimed, pre-dating this field, or a
   * genuinely-never-worked task) means a branch-only PR match can't be
   * trusted to be THIS task's own work, even when the BBR-1.1 headcount
   * guard alone would pass (exactly one task shares the branch) — confirmed
   * failing live on TRD-1.2 (PR 2270) and RSG-1.2 (PR 2287), both healed to
   * a merged/deploying-looking state despite claimedBy/claimedAt/startedAt
   * all being null, because each shared a branch with a legitimately-worked
   * bundle-mate. `claimedAt` is deliberately NOT used for this gate — a
   * stale-claim reaper releasing a crashed session's claim nulls `claimedAt`
   * even though the session pushed a real commit and opened a real PR before
   * crashing.
   */
  startedAt?: string | null;
}

export interface PrStateReconcilerDeps {
  repos: string[];
  /** Page size for listing state:"open" records; defaults to the task-store's own default (50). */
  pageLimit?: number;
  /**
   * List one page of state:"open" PR records for a repo, updated at or after
   * `updatedSince` (an ISO timestamp; PSR-1.1). Passed through verbatim to
   * the task-store's own `updatedSince` query param (`gte` semantics
   * server-side), so a record updated exactly at the cutoff is still
   * included. The window is deliberately wide (see the module doc comment's
   * `RECONCILER_UPDATED_SINCE_WINDOW_MS` explanation) — this pass exists to
   * heal records stuck because nothing will ever touch their `updatedAt`
   * again after the crash that stranded them, so the cutoff only needs to
   * survive a missed tick or two, not exclude every record that isn't
   * brand-new.
   */
  listOpenPrRecords: (
    repo: string,
    limit: number,
    offset: number,
    updatedSince: string,
  ) => Promise<PrStateRecord[]>;
  /** PATCH a task-store PR record's fields. */
  patchPrRecord: (id: string, fields: Record<string, unknown>) => Promise<void>;
  /** Fetch live GitHub state for a single PR. Throws on lookup failure. */
  ghViewPr: (repo: string, prNumber: number) => Promise<GhPrView>;
  /**
   * List one page of task-store Tasks with status "pr_open" (DSR-1.1),
   * updated at or after `updatedSince` (PSR-1.1 — see `listOpenPrRecords`
   * above for the same `gte` semantics and wide-window rationale).
   */
  listPrOpenTasks: (
    limit: number,
    offset: number,
    updatedSince: string,
  ) => Promise<PrOpenTaskRecord[]>;
  /** PATCH a task-store Task's fields (DSR-1.1). */
  updateTaskStatus: (
    id: string,
    fields: Record<string, unknown>,
  ) => Promise<void>;
  /** Branch-fallback PR lookup (`gh pr list --head <branch> --state merged`) for tasks with no `pr` number set (DSR-1.1). */
  ghListMergedPrsForBranch: (
    repo: string,
    branch: string,
  ) => Promise<Array<{ number: number }>>;
  /**
   * List every task-store Task sharing a given repo+branch (BBR-1.1's
   * bundle-mate guard) — `GET /tasks?repo=<repo>&branch=<branch>`, paged the
   * same way this file's other list* deps page (see `listAllOpenRecords`).
   * Multiple tasks can share one branch when a
   * bundle of tasks was dispatched together onto the same branch;
   * `reconcilePrOpenTask`'s branch-fallback path calls this BEFORE
   * auto-healing a task via a branch-only PR match, and skips the auto-heal
   * entirely when it returns more than one task — a branch-only PR lookup
   * can't tell which sibling's work the PR actually contains, so guessing is
   * worse than leaving the task untouched (a real bundle only advances a
   * sibling when something explicit says so, e.g. dev-task's own status
   * PATCH — never by branch-level inference alone).
   *
   * RSG-1.2: may resolve to the `SCOPE_DEGRADED` sentinel instead of an
   * array. The task-store's GET /tasks response carries a `scopeDegraded`
   * flag (RSG-1.1) that is true only when the calling agent token's
   * repo-scope resolver call itself failed, forcing `repos` to `[]`
   * server-side — which silently starves the agent-scope OR-union this
   * query relies on and under-counts (or zeroes out) real bundle-mates. A
   * production implementation retries once (bounded delay) on a degraded
   * response; if still degraded after the retry, the true sibling count is
   * unknowable, so it resolves to `SCOPE_DEGRADED` rather than the
   * (possibly under-counted) task list — callers must treat this exactly
   * like the already-handled ">1 sibling" case (skip the heal), but log a
   * distinct message so the two causes stay distinguishable in practice. A
   * non-degraded response (including a legitimate 0- or 1-task result)
   * still resolves to a plain array, identical to pre-RSG-1.2 behavior.
   */
  listAllTasksForBranch: (
    repo: string,
    branch: string,
  ) => Promise<PrOpenTaskRecord[] | typeof SCOPE_DEGRADED>;
  /** Look up a task-store PullRequest record by repo+prNumber, for the taskId backfill (DSR-1.1). */
  findPrRecordByRepoAndPrNumber: (
    repo: string,
    prNumber: number,
  ) => Promise<PrStateRecord | null>;
  /** Injected clock — mergedAt fallback when GitHub doesn't report one (DSR-1.1). */
  now: () => string;
  /**
   * Returns the agent's currently-configured repo scope (WL-4.2's live
   * agent-repos-ref.ts), read fresh on every reconcilePrState() call — not
   * closed over at buildProductionDeps time — so a scope change takes effect
   * on the very next tick. `repos` above is the local-clone filesystem scan
   * (built once); this filter is intersected with it at call time so a repo
   * cloned locally for reference but absent from this list never gets
   * reconciled (see WL-4.4). This scope-filtering is new as of WL-4.4 —
   * check-deploy.ts/check-review.ts/check-patch.ts do not yet apply
   * equivalent filtering and still call resolveAllRepos() unscoped.
   */
  getScopedRepos: () => string[];
  /**
   * Pause for `ms` milliseconds (PSR-1.2) — called once per record/task
   * iteration across every gh-call-issuing loop in this file, so a large
   * batch spreads its calls out over time instead of firing them all in a
   * tight sequential burst (confirmed live: 70+ calls in 21s exhausted the
   * shared GH_TOKEN's GraphQL rate limit for ~9 minutes, blocking sibling
   * agents' dispatch work). Production implementations use a real
   * `setTimeout`; tests inject a no-op so existing correctness-focused tests
   * stay fast and unaffected.
   */
  delay: (ms: number) => Promise<void>;
  /**
   * Whether the `cleanup_merged_worktrees` policy field (state/agent-policy.md,
   * WTR-1.1) is enabled — read once at `buildProductionDeps()` time via
   * `readCleanupMergedWorktrees()` (check-helpers.ts), mirroring
   * `check-deploy.ts`/`check-review.ts`'s established
   * `readAllowSelfReview()` → `isSelfReviewAllowed` pattern: the
   * already-parsed boolean is injected, not raw file content, so tests can
   * set it directly without faking a file read.
   */
  isCleanupMergedWorktreesEnabled: boolean;
  /**
   * Remove a local git worktree (WTR-1.3) — called from `reconcileRecord()`
   * after a successful state PATCH to merged/closed, when
   * `isCleanupMergedWorktreesEnabled` is true. `shortRepo` is the repo name
   * without its org prefix (via `splitOrgRepo`); `worktreeDirName` is the
   * full `<shortRepo>-<branchSlug>` directory name, matching this repo's
   * documented worktree naming convention (`<repo>-<branch>`, see
   * CLAUDE.md's Worktrees section). Failures are caught and logged by the
   * caller — this dep itself may simply reject.
   */
  removeWorktree: (shortRepo: string, worktreeDirName: string) => Promise<void>;
}

/** Minimal shape of a task-store PullRequest record reviewState reconciliation needs. */
export interface PrReviewStateRecord {
  id: string;
  repo: string;
  prNumber: number;
  claimedBy: string | null;
  claimedAt: string | null;
  heartbeatAt: string | null;
}

export interface PrReviewStateReconcilerDeps {
  repos: string[];
  /**
   * Returns the agent's currently-configured repo scope, read fresh on
   * every reconcileReviewState() call — mirrors PrStateReconcilerDeps's own
   * getScopedRepos field (WL-4.4/PSR-1.3). `repos` above is the local-clone
   * filesystem scan (built once); this filter is intersected with it at
   * call time so a repo cloned locally for reference but absent from this
   * list never gets reconciled.
   */
  getScopedRepos: () => string[];
  /** Page size for listing reviewState:"pending" records; defaults to the task-store's own default (50). */
  pageLimit?: number;
  /** Injected time source — never call Date.now()/new Date() directly. */
  clock: Clock;
  /** Claim freshness window in ms; defaults to DEFAULT_CLAIM_TTL_MS (mirrors SHIPWRIGHT_TASK_STORE_CLAIM_TTL_MS's own default). */
  claimTtlMs?: number;
  /**
   * List one page of state:"open" && reviewState:"pending" PR records for a
   * repo, updated at or after `updatedSince` (PSR-1.1). Deliberately NOT
   * mirrored onto `listPostedReviewRecords` below — CHU-2.4's healing pass
   * specifically targets records that have gone stale (untouched for a
   * while), so filtering it at all would defeat its purpose. This pass's own
   * window is deliberately wide (see the module doc comment); it just needs
   * to survive a missed tick or two, not exclude every record that isn't
   * brand-new.
   */
  listPendingReviewRecords: (
    repo: string,
    limit: number,
    offset: number,
    updatedSince: string,
  ) => Promise<PrReviewStateRecord[]>;
  /**
   * List one page of state:"open" && reviewState:"posted" PR records for a
   * repo (CHU-2.4) — mirrors `listPendingReviewRecords`'s exact signature,
   * paged the same way, but for the mirror-image healing direction: a
   * posted verdict that's gone stale because a new commit landed with no
   * review targeting it yet.
   */
  listPostedReviewRecords: (
    repo: string,
    limit: number,
    offset: number,
  ) => Promise<PrReviewStateRecord[]>;
  /** Fetch head commit + reviews + review threads for a single PR. Throws on lookup failure. */
  fetchPrReviews: (
    org: string,
    repo: string,
    prNumber: number,
  ) => Promise<PrReviewData>;
  /** PATCH a task-store PR record's fields. */
  patchPrRecord: (id: string, fields: Record<string, unknown>) => Promise<void>;
  /** Pause for `ms` milliseconds (PSR-1.2) — see `PrStateReconcilerDeps.delay`'s doc comment for the full rationale. */
  delay: (ms: number) => Promise<void>;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const DEFAULT_PAGE_LIMIT = 50;

/**
 * Sentinel returned by `listAllTasksForBranch` (RSG-1.2) when the
 * task-store's GET /tasks response reported `scopeDegraded: true` both on
 * the initial call and its single bounded-delay retry — signals "the true
 * sibling count for this branch is unknown" to both BBR-1.1 guard call
 * sites, as distinct from a confirmed count (including a confirmed >1).
 * A plain string literal (not a class/Symbol) keeps the sentinel trivially
 * serializable/comparable across the dependency-injection boundary tests
 * exercise, and `typeof SCOPE_DEGRADED` gives callers/tests a precise
 * literal type instead of widening to `string`.
 */
export const SCOPE_DEGRADED = "scope-degraded" as const;

/**
 * Bounded pause (RSG-1.2) before `listAllTasksForBranch`'s single retry of a
 * scopeDegraded:true GET /tasks response — reuses the same
 * `deps.delay`/`SHIPWRIGHT_RECONCILER_DELAY_MS`-style injected-pause pattern
 * this file already uses for its gh-call throttling (PSR-1.2), so tests
 * inject a no-op and production waits for real. Deliberately its own
 * constant (not reusing `DEFAULT_RECONCILER_DELAY_MS`) since this retry is a
 * one-shot "give the resolver a beat to recover" pause, not a
 * per-batch-item throttle — a distinct, independently-tunable env var keeps
 * the two concerns from being accidentally coupled.
 */
const SCOPE_DEGRADED_RETRY_DELAY_MS = Number(
  process.env.SHIPWRIGHT_RECONCILER_SCOPE_DEGRADED_RETRY_DELAY_MS ?? 1000,
);

/**
 * Default pause between gh-call-issuing loop iterations (PSR-1.2), in ms.
 * Overridable via SHIPWRIGHT_RECONCILER_DELAY_MS for ops tuning without a
 * code change. Chosen to spread a large batch's calls out over real time
 * (e.g. 70 records × 300ms ≈ 21s instead of a sub-second burst) without
 * meaningfully slowing a normal-sized reconcile pass.
 */
const DEFAULT_RECONCILER_DELAY_MS = Number(
  process.env.SHIPWRIGHT_RECONCILER_DELAY_MS ?? 300,
);

/**
 * Recency window (PSR-1.1): a reconcile pass only re-fetches records/tasks
 * updated within this window, computed fresh once per reconcile-pass entry
 * point from the injected time source (never `Date.now()`/`new Date()`
 * directly) — a single unconditional full-table gh-backed scan every tick
 * was exhausting the shared GitHub GraphQL rate limit on a long tail of
 * untouched fixture/smoke-test records. Deliberately wide — several
 * multiples of the reconciler's own 30-60 minute tick interval — so a
 * record stuck since a crash/hang (the exact case these passes exist to
 * heal) survives a missed or delayed tick rather than aging out of the
 * window permanently. Overridable via
 * SHIPWRIGHT_RECONCILER_UPDATED_SINCE_WINDOW_MS for ops tuning without a
 * code change.
 */
const RECONCILER_UPDATED_SINCE_WINDOW_MS = Number(
  process.env.SHIPWRIGHT_RECONCILER_UPDATED_SINCE_WINDOW_MS ??
    6 * 60 * 60 * 1000,
);

/** Cutoff ISO timestamp `RECONCILER_UPDATED_SINCE_WINDOW_MS` before `nowMs` (epoch ms), for the `updatedSince` recency window above. */
function computeUpdatedSinceCutoff(nowMs: number): string {
  return new Date(nowMs - RECONCILER_UPDATED_SINCE_WINDOW_MS).toISOString();
}

/**
 * RCO-1.5: per-pass record-outcome tally, accumulated across every repo a
 * reconcile pass scans and logged once as a single summary line at the end
 * of the pass — see `logPassSummary` below. A clean, fully successful pass
 * previously produced zero log output, making it impossible to tell "ran and
 * succeeded" apart from "never ran at all" from logs alone.
 *
 * `skippedClaimed` is always 0 for `reconcilePrState()`'s pass — `PrStateRecord`
 * has no claim concept at all — but is included here for schema consistency
 * across all three passes (`reconcilePrState`, and `reconcileReviewState`'s
 * two scans, which DO have a live isActivelyClaimed skip).
 */
interface PassSummary {
  /** Records fetched and considered by this pass (a per-repo list-call failure does NOT add to this — the would-be count is unknown). */
  evaluated: number;
  /** Records that received a PATCH. */
  patched: number;
  /** Records skipped because `isActivelyClaimed()` returned true — always 0 for reconcilePrState's pass. */
  skippedClaimed: number;
  /** Per-record reconcile failures PLUS per-repo list-call failures (each list failure counts as 1, representing the failed call itself). */
  errored: number;
}

function newPassSummary(): PassSummary {
  return { evaluated: 0, patched: 0, skippedClaimed: 0, errored: 0 };
}

/** Logs one summary line for a completed pass — see `PassSummary`'s doc comment for what each count means. */
function logPassSummary(
  prefix: string,
  label: string,
  summary: PassSummary,
): void {
  console.log(
    `${prefix} ${label} summary: evaluated=${summary.evaluated} patched=${summary.patched} skippedClaimed=${summary.skippedClaimed} errored=${summary.errored}`,
  );
}

/** Map GitHub's uppercase PR state to the task-store's lowercase PrState enum. */
function mapGhStateToPrState(
  state: GhPrView["state"],
): "merged" | "closed" | null {
  if (state === "MERGED") return "merged";
  if (state === "CLOSED") return "closed";
  return null; // still OPEN on GitHub — nothing to reconcile
}

/**
 * List every state:"open" PR record for a repo, updated at or after
 * `updatedSince` (PSR-1.1), paging through the task-store's default
 * 50-record page until a page returns fewer than `limit` records.
 */
async function listAllOpenRecords(
  deps: PrStateReconcilerDeps,
  repo: string,
  updatedSince: string,
): Promise<PrStateRecord[]> {
  const limit = deps.pageLimit ?? DEFAULT_PAGE_LIMIT;
  const records: PrStateRecord[] = [];
  let offset = 0;

  for (;;) {
    const page = await deps.listOpenPrRecords(
      repo,
      limit,
      offset,
      updatedSince,
    );
    records.push(...page);
    if (page.length < limit) break;
    offset += limit;
  }

  return records;
}

/**
 * List every task-store Task with status "pr_open" (DSR-1.1), updated at or
 * after `updatedSince` (PSR-1.1), paging through the task-store's default
 * 50-record page until a page returns fewer than `limit` records — same
 * loop shape as `listAllOpenRecords` above (TCR-1.2 follow-up: this dep was
 * previously unpaginated).
 */
async function listAllPrOpenTasks(
  deps: PrStateReconcilerDeps,
  updatedSince: string,
): Promise<PrOpenTaskRecord[]> {
  const limit = deps.pageLimit ?? DEFAULT_PAGE_LIMIT;
  const tasks: PrOpenTaskRecord[] = [];
  let offset = 0;

  for (;;) {
    const page = await deps.listPrOpenTasks(limit, offset, updatedSince);
    tasks.push(...page);
    if (page.length < limit) break;
    offset += limit;
  }

  return tasks;
}

/**
 * Reconcile a single PR record against live GitHub state. Issues a PATCH
 * only when GitHub reports MERGED or CLOSED while the record still says
 * "open" — records still OPEN on GitHub are left completely untouched.
 *
 * WTR-1.3: once that PATCH succeeds, also removes the PR's local worktree
 * (when `cleanup_merged_worktrees` policy is enabled) — piggybacking on this
 * same `gh pr view` call's `headRefName` field instead of adding a second,
 * independent PR-listing/gh-view pass (see this file's module doc comment's
 * PSR-1.2 rate-limit-incident rationale). The removal is isolated in its own
 * try/catch: a failure is logged but never propagates, and never undoes or
 * blocks the already-succeeded state PATCH above.
 *
 * RCO-1.5: returns "patched" or "no-op" (rather than void) so the calling
 * loop in `reconcilePrState()` can tally outcomes for its end-of-pass summary
 * log — purely a reporting addition, does not change which branch runs or
 * what gets written.
 */
async function reconcileRecord(
  deps: PrStateReconcilerDeps,
  record: PrStateRecord,
): Promise<"patched" | "no-op"> {
  const ghState = await deps.ghViewPr(record.repo, record.prNumber);
  const newState = mapGhStateToPrState(ghState.state);
  if (newState === null) return "no-op"; // still open on GitHub — no-op

  // claimedBy/claimedAt/heartbeatAt aren't in routes/prs.ts's PATCH
  // allowlist, so including them here is documentation-of-intent rather than
  // a functional requirement — the actual clearing happens server-side in
  // PullRequestService.update()'s state === "merged" || "closed" special
  // case (mirrors CHU-1.3's pattern). `phase` IS allowlisted and is included
  // here for defense-in-depth alongside the server-side clear.
  const fields: Record<string, unknown> = {
    state: newState,
    claimedBy: null,
    claimedAt: null,
    heartbeatAt: null,
    phase: null,
  };
  if (newState === "merged" && ghState.mergedAt) {
    fields.mergedAt = ghState.mergedAt;
  }

  await deps.patchPrRecord(record.id, fields);

  if (!deps.isCleanupMergedWorktreesEnabled) return "patched";
  if (!ghState.headRefName) return "patched"; // defensive — no branch to derive a worktree path from

  try {
    const [, shortRepo] = splitOrgRepo(record.repo);
    const branchSlug = ghState.headRefName.replaceAll("/", "-");
    await deps.removeWorktree(shortRepo, `${shortRepo}-${branchSlug}`);
  } catch (err) {
    console.error(
      `[pr-state-reconciler] failed to remove worktree for ${record.repo}#${record.prNumber}:`,
      err instanceof Error ? err.message : String(err),
    );
  }
  return "patched";
}

/**
 * Resolve the repo to check a pr_open task against, mirroring the legacy
 * check-deploy.ts reconcileStalePrOpenTasks fallback: a task's own `repo`
 * field wins when it's already "org/repo" shaped, otherwise fall back to
 * the first configured repo. Returns undefined when neither is available
 * (bare repo name + no configured repos) — callers must skip defensively
 * rather than guess.
 */
function resolveTaskRepo(
  deps: PrStateReconcilerDeps,
  task: PrOpenTaskRecord,
): string | undefined {
  if (task.repo?.includes("/")) return task.repo;
  return deps.repos[0];
}

/**
 * RCP-1.1: a hard precondition for both of `reconcilePrOpenTask`'s
 * branch-based heal paths (the direct path with a `branch` set, and the
 * branch-fallback path) — `task.startedAt` must be set before a branch-only
 * PR match is ever trusted as this task's own work, regardless of what the
 * BBR-1.1 headcount guard (`listAllTasksForBranch`) finds. That guard only
 * answers "how many task-store records share this branch" — a single-task
 * branch still passes it even when that one task was never actually
 * claimed/started, which is exactly the gap TRD-1.2 (PR 2270) and RSG-1.2
 * (PR 2287) fell through: both healed to a merged/deploying-looking state
 * purely because a bundle-mate's real work happened to live on the same
 * branch.
 *
 * Falsy-checked (`!task.startedAt`) rather than strictly `=== null` —
 * `startedAt` is only ever a non-empty ISO string or null/undefined
 * (undefined covers task-store records that pre-date this field), and both
 * must skip identically.
 *
 * Deliberately checked by callers BEFORE their GitHub list call (not just
 * before the BBR-1.1 guard) — a task that can't qualify regardless of what's
 * found on GitHub shouldn't spend a GitHub API call finding out.
 */
function hasStarted(task: PrOpenTaskRecord): boolean {
  return !!task.startedAt;
}

/**
 * Distinct-from-BBR-1.1 skip log for the RCP-1.1 startedAt precondition
 * above — shared by both branch-based heal paths so the message shape stays
 * identical between them.
 */
function logStartedAtSkip(task: PrOpenTaskRecord, taskRepo: string): void {
  console.error(
    `[pr-state-reconciler] skipping branch-based heal for task ${task.id} — startedAt is null/missing on ${taskRepo}#${task.branch}, cannot confirm this task was ever actually claimed/started, so a branch-only PR match cannot be trusted as this task's own work`,
  );
}

/**
 * Reconcile one pr_open task against live GitHub state (DSR-1.1 —
 * ports check-deploy.ts's reconcileStalePrOpenTasks two-path logic into the
 * ongoing background sweep instead of a one-shot precheck script).
 *
 * Direct path (task.pr set): reuse the same ghViewPr dep the PR-record pass
 * above already calls, so a real GitHub mergedAt is used when available
 * (falling back to the injected clock only when GitHub didn't report one —
 * unlike the legacy script, which always used `now`). RDG-1.1: when the task
 * also has a `branch` set, applies the same bundle-mate headcount (BBR-1.1) +
 * startedAt (RCP-1.1) precondition the branch-fallback path below already
 * enforces, gating only the merge-advance (not the ghViewPr call itself,
 * which must always run to learn GitHub's state) — see the module doc
 * comment above for the full rationale.
 *
 * Branch-fallback path (no task.pr, task.branch set): `gh pr list --head
 * <branch> --state merged` only returns the PR number, never a mergedAt, so
 * this path always uses the injected clock — matching the legacy script.
 *
 * Either path, once a merge is confirmed, also backfills the task-store
 * PullRequest record's taskId when that record exists and its taskId is
 * still null — closing the gap where only review.md ever wrote it.
 */
async function reconcilePrOpenTask(
  deps: PrStateReconcilerDeps,
  task: PrOpenTaskRecord,
): Promise<void> {
  const taskRepo = resolveTaskRepo(deps, task);
  if (!taskRepo) return; // no repo to resolve against — skip defensively

  let prNumber: number;
  let mergedAt: string;
  let backfillPr: number | undefined; // only set on the branch path, matching the legacy PATCH shape

  if (task.pr) {
    const ghState = await deps.ghViewPr(taskRepo, task.pr);
    if (ghState.state !== "MERGED") return; // still open/closed on GitHub — no-op

    // RDG-1.1: unlike the branch-fallback path below, task.pr is already
    // known, so the ghViewPr call above must always run regardless of the
    // bundle-mate guard — there's no gh call to save by checking first. This
    // guard only applies when the task ALSO has a `branch` set (a task can
    // carry both fields at once); a task.pr-set task with no branch is
    // unaffected (see the `else` fallthrough below). Same BBR-1.1 headcount +
    // RCP-1.1 startedAt precondition as the branch-fallback path — a trailing
    // sibling task on a multi-task branch must not ride a bundle-mate's real
    // merge to "merged" status purely because its own `pr` field happens to
    // point at the same (or another) merged PR, without its own startedAt
    // ever having been set. Confirmed live: IC-1.2/1.3/1.4, DPF-2.2, PW-1.2,
    // SBA-1.2 all false-completed this way.
    if (task.branch) {
      const branchTasks = await deps.listAllTasksForBranch(
        taskRepo,
        task.branch,
      );
      if (branchTasks === SCOPE_DEGRADED) {
        console.error(
          `[pr-state-reconciler] skipping direct-path merge heal for task ${task.id} — degraded scope resolution for ${taskRepo}#${task.branch} (sibling task count unknown, not a confirmed single-task branch), cannot confirm PR #${task.pr} is this task's own work`,
        );
        return;
      }
      if (branchTasks.length > 1 && !hasStarted(task)) {
        logStartedAtSkip(task, taskRepo);
        return;
      }
    }

    prNumber = task.pr;
    mergedAt = ghState.mergedAt ?? deps.now();
  } else if (task.branch) {
    // RCP-1.1: checked before the GitHub call — a task that was never
    // claimed/started can't qualify for the branch-fallback heal regardless
    // of what's found on GitHub, so no gh call should be spent finding out.
    if (!hasStarted(task)) {
      logStartedAtSkip(task, taskRepo);
      return;
    }

    const merged = await deps.ghListMergedPrsForBranch(taskRepo, task.branch);
    const first = merged[0];
    if (!first) return; // no merged PR found for this branch yet

    // BBR-1.1: a branch-only PR match can't tell which sibling's work a
    // shared branch's PR actually contains — on a bundle (>1 task sharing
    // this branch), skip the auto-heal entirely (both the status PATCH below
    // and the taskId backfill) rather than guessing. Single-task branches
    // (the original DSR-1.1 crash-recovery case) are unaffected.
    //
    // RSG-1.2: `listAllTasksForBranch` may resolve to `SCOPE_DEGRADED`
    // instead of a task list when the task-store couldn't confirm the true
    // sibling count (its own scope resolver failed, even after a retry) —
    // treat that identically to the >1-sibling skip above (same outcome:
    // don't guess), but log a message that names the real cause instead of
    // implying a confirmed count.
    const branchTasks = await deps.listAllTasksForBranch(taskRepo, task.branch);
    if (branchTasks === SCOPE_DEGRADED) {
      console.error(
        `[pr-state-reconciler] skipping branch-fallback merge heal for task ${task.id} — degraded scope resolution for ${taskRepo}#${task.branch} (sibling task count unknown, not a confirmed single-task branch), cannot determine which one PR #${first.number} belongs to`,
      );
      return;
    }
    if (branchTasks.length > 1) {
      console.error(
        `[pr-state-reconciler] skipping branch-fallback merge heal for task ${task.id} — ${branchTasks.length} tasks share branch ${taskRepo}#${task.branch}, cannot determine which one PR #${first.number} belongs to`,
      );
      return;
    }

    prNumber = first.number;
    backfillPr = first.number;
    mergedAt = deps.now();
  } else {
    return; // neither path resolvable — nothing to do
  }

  await deps.updateTaskStatus(task.id, {
    status: "merged",
    ...(backfillPr !== undefined ? { pr: backfillPr } : {}),
    mergedAt,
  });

  const prRecord = await deps.findPrRecordByRepoAndPrNumber(taskRepo, prNumber);
  if (prRecord && !prRecord.taskId) {
    await deps.patchPrRecord(prRecord.id, { taskId: task.id });
  }
}

/**
 * Scan every pr_open task, resolve its linked PR (directly via task.pr, or
 * via the branch fallback), and PATCH the task to merged when GitHub
 * confirms the PR is actually merged. A single per-task failure is logged
 * and does not abort reconciliation of the rest of the batch — mirrors
 * reconcilePrState's own per-record error isolation above.
 */
export async function reconcilePrOpenTasks(
  deps: PrStateReconcilerDeps,
): Promise<void> {
  // Computed once per reconcile pass (PSR-1.1) — never freshly inside the
  // page loop, so a single pass uses one consistent cutoff across all pages.
  const updatedSince = computeUpdatedSinceCutoff(
    new Date(deps.now()).getTime(),
  );

  let tasks: PrOpenTaskRecord[];
  try {
    tasks = await listAllPrOpenTasks(deps, updatedSince);
  } catch (err) {
    console.error(
      "[pr-state-reconciler] failed to list pr_open tasks:",
      err instanceof Error ? err.message : String(err),
    );
    return;
  }

  const scopedReposSet = new Set(deps.getScopedRepos());

  for (const task of tasks) {
    const taskRepo = resolveTaskRepo(deps, task);
    if (!taskRepo || !scopedReposSet.has(taskRepo)) continue; // out of scope — skip, zero gh calls

    try {
      await reconcilePrOpenTask(deps, task);
    } catch (err) {
      console.error(
        `[pr-state-reconciler] failed to reconcile pr_open task ${task.id}:`,
        err instanceof Error ? err.message : String(err),
      );
    }
    await deps.delay(DEFAULT_RECONCILER_DELAY_MS);
  }
}

// ─── Core logic ───────────────────────────────────────────────────────────────

/**
 * Scan every repo's state:"open" PR records, compare each against live
 * GitHub state, and PATCH only the ones that disagree (GitHub shows
 * MERGED/CLOSED but the record still says "open"). A single per-PR gh
 * lookup failure is logged and does not abort reconciliation of the rest
 * of the batch. Then runs the pr_open-task reconciliation pass (DSR-1.1) so
 * agent/src/index.ts's single call site doesn't need to change.
 *
 * RCO-1.5: logs one end-of-pass summary line (evaluated/patched/
 * skippedClaimed/errored) via `logPassSummary` — additive only, does not
 * change any reconciliation decision or write. `skippedClaimed` is always 0
 * here (see `PassSummary`'s doc comment); included for schema consistency
 * with `reconcileReviewState()`'s two scans. Scoped to this function's own
 * PR-record scan only — `reconcilePrOpenTasks()` below has its own
 * pre-existing error handling and is out of scope for this summary line.
 */
export async function reconcilePrState(
  deps: PrStateReconcilerDeps,
): Promise<void> {
  // Computed once per reconcile pass (PSR-1.1) — see reconcilePrOpenTasks above.
  const updatedSince = computeUpdatedSinceCutoff(
    new Date(deps.now()).getTime(),
  );

  const scopedReposSet = new Set(deps.getScopedRepos());
  const scopedRepos = deps.repos.filter((repo) => scopedReposSet.has(repo));

  const summary = newPassSummary();

  for (const repo of scopedRepos) {
    let records: PrStateRecord[];
    try {
      records = await listAllOpenRecords(deps, repo, updatedSince);
    } catch (err) {
      console.error(
        `[pr-state-reconciler] failed to list open PRs for ${repo}:`,
        err instanceof Error ? err.message : String(err),
      );
      summary.errored += 1; // the failed list-call itself — would-be record count is unknown
      continue;
    }

    for (const record of records) {
      summary.evaluated += 1;
      try {
        const outcome = await reconcileRecord(deps, record);
        if (outcome === "patched") summary.patched += 1;
      } catch (err) {
        console.error(
          `[pr-state-reconciler] failed to reconcile ${repo}#${record.prNumber}:`,
          err instanceof Error ? err.message : String(err),
        );
        summary.errored += 1;
      }
      await deps.delay(DEFAULT_RECONCILER_DELAY_MS);
    }
  }

  logPassSummary("[pr-state-reconciler]", "pass", summary);

  await reconcilePrOpenTasks(deps);
}

// ─── reconcileReviewState ───────────────────────────────────────────────────────
//
// reviewsAtHeadCommit/hasAnyReviewAtHead/classifyReviewState now live in
// check-helpers.ts (RVD-1.1) — promoted so check-review.ts's candidate
// selection can reuse the same live-review classification for its own
// identity-agnostic dedup, not just this file's async background reconcile
// pass. Imported above; see check-helpers.ts for the full doc comments.

/**
 * A record is "actively claimed" (skip it — never overwrite a live claim's
 * reviewState) when `claimedBy` is set AND its freshness timestamp
 * (`heartbeatAt`, falling back to `claimedAt` when null) is within the claim
 * TTL window of `clock.now()`. If `claimedBy` is null, or both timestamps
 * are null, the record is NOT actively claimed.
 */
function isActivelyClaimed(
  record: PrReviewStateRecord,
  clock: Clock,
  claimTtlMs: number,
): boolean {
  if (!record.claimedBy) return false;
  const freshnessTimestamp = record.heartbeatAt ?? record.claimedAt;
  if (!freshnessTimestamp) return false;
  const cutoff = clock.now().getTime() - claimTtlMs;
  return new Date(freshnessTimestamp).getTime() >= cutoff;
}

/**
 * List every record a paginated per-repo list-fn returns for a repo, paging
 * through the task-store's default 50-record page until a page returns
 * fewer than `limit` records. Shared pagination-until-partial-page loop for
 * both the reviewState:"pending" scan (`listPendingReviewRecords`) and the
 * reviewState:"posted" scan (`listPostedReviewRecords`, CHU-2.4) — the loop
 * body is identical, only the underlying dep function differs.
 */
async function listAllReviewRecords(
  deps: PrReviewStateReconcilerDeps,
  repo: string,
  listFn: (
    repo: string,
    limit: number,
    offset: number,
  ) => Promise<PrReviewStateRecord[]>,
): Promise<PrReviewStateRecord[]> {
  const limit = deps.pageLimit ?? DEFAULT_PAGE_LIMIT;
  const records: PrReviewStateRecord[] = [];
  let offset = 0;

  for (;;) {
    const page = await listFn(repo, limit, offset);
    records.push(...page);
    if (page.length < limit) break;
    offset += limit;
  }

  return records;
}

/**
 * Reconcile a single reviewState:"pending" record against live GitHub
 * review data. Skips actively-claimed records without any GitHub call.
 * Issues a PATCH only when GitHub shows a terminal review at the PR's
 * current head commit — a genuine unaddressed finding, a stale-commit-only
 * review, or no review at all are all left completely untouched.
 *
 * RCO-1.5: returns "patched" | "no-op" | "skipped-claimed" (rather than
 * void) so the calling loop in `reconcileReviewState()` can tally outcomes
 * for its end-of-pass summary log — purely a reporting addition, does not
 * change which branch runs or what gets written.
 */
async function reconcileReviewStateRecord(
  deps: PrReviewStateReconcilerDeps,
  record: PrReviewStateRecord,
): Promise<"patched" | "no-op" | "skipped-claimed"> {
  // deps.claimTtlMs is NOT left unwired here: buildReviewStateProductionDeps
  // (below) reads process.env.SHIPWRIGHT_TASK_STORE_CLAIM_TTL_MS itself and
  // sets it on the returned deps object, so index.ts's bare
  // buildReviewStateReconcilerDeps({ ghGraphql }) call site still gets the
  // env var end-to-end — confirmed by this factory's own unit tests below.
  const claimTtlMs = deps.claimTtlMs ?? DEFAULT_CLAIM_TTL_MS;
  if (isActivelyClaimed(record, deps.clock, claimTtlMs))
    return "skipped-claimed"; // live claim — never overwrite

  const [org, repoName] = splitOrgRepo(record.repo);
  const reviewData = await deps.fetchPrReviews(org, repoName, record.prNumber);
  const newReviewState = classifyReviewState(reviewData);
  if (newReviewState === null) return "no-op"; // nothing terminal at head — no-op

  await deps.patchPrRecord(record.id, { reviewState: newReviewState });
  return "patched";
}

/**
 * Reconcile a single reviewState:"posted" record against live GitHub review
 * data (CHU-2.4 — the mirror-image direction of
 * `reconcileReviewStateRecord` above). Skips actively-claimed records
 * without any GitHub call, same as the pending-scan guard.
 *
 * Unlike the pending-scan reconciler, this does NOT use
 * `classifyReviewState()`'s return value directly — that function collapses
 * "nothing at head at all" and "a genuine finding exists at head" into the
 * same `null`, which is the right no-op for a *pending* record but wrong
 * for a *posted* one. Here the two cases must be told apart:
 *
 *   - NO review at all at the current head commit (confirmed live on
 *     app-vitals/shipwright#1814: a new commit landed one commit past every
 *     review on file) means the posted verdict is stale — PATCH back to
 *     "pending" so check-review.ts re-selects the PR for a fresh review.
 *   - Anything else (a genuine unresolved finding at head, a still-terminal
 *     review, or a still-approved review) leaves the record completely
 *     untouched — there's nothing to heal.
 *
 * RCO-1.5: returns "patched" | "no-op" | "skipped-claimed" (rather than
 * void) — see `reconcileReviewStateRecord`'s doc comment above for the same
 * rationale.
 */
async function reconcilePostedReviewStateRecord(
  deps: PrReviewStateReconcilerDeps,
  record: PrReviewStateRecord,
): Promise<"patched" | "no-op" | "skipped-claimed"> {
  const claimTtlMs = deps.claimTtlMs ?? DEFAULT_CLAIM_TTL_MS;
  if (isActivelyClaimed(record, deps.clock, claimTtlMs))
    return "skipped-claimed"; // live claim — never overwrite

  const [org, repoName] = splitOrgRepo(record.repo);
  const reviewData = await deps.fetchPrReviews(org, repoName, record.prNumber);
  if (hasAnyReviewAtHead(reviewData)) return "no-op"; // something at head (finding or terminal) — untouched

  await deps.patchPrRecord(record.id, { reviewState: "pending" });
  return "patched";
}

/**
 * Scan every repo's reviewState:"pending" PR records, compare each against
 * live GitHub review data, and PATCH only the ones that have gone terminal
 * at the current head commit (an out-of-band reviewer posted an APPROVED or
 * clean-approve-shaped/terminal review directly to GitHub). Then runs the
 * mirror-image reviewState:"posted" scan (CHU-2.4): a posted verdict whose
 * review(s) are no longer at the current head commit at all (a new commit
 * landed since the posted verdict, but nothing reset reviewState back to
 * pending) gets PATCHed back to "pending" so check-review.ts's dedup guard
 * (`commitSha === headRefOid && reviewState !== "pending" -> skip`) stops
 * trapping the PR out of every phase's candidate set. A single per-record
 * failure (claim check aside) is logged and does not abort reconciliation
 * of the rest of the batch, for either scan.
 *
 * RCO-1.5: each scan logs its OWN end-of-pass summary line (evaluated/
 * patched/skippedClaimed/errored) via `logPassSummary` — additive only, does
 * not change any reconciliation decision or write.
 */
export async function reconcileReviewState(
  deps: PrReviewStateReconcilerDeps,
): Promise<void> {
  // Computed once per reconcile pass (PSR-1.1) — never freshly inside the
  // page loop, so a single pass uses one consistent cutoff across all pages.
  // Deliberately only threaded into the pending-scan below —
  // listPostedReviewRecords (CHU-2.4's healing pass) must keep scanning
  // regardless of record age; see its dep-interface doc comment above.
  const updatedSince = computeUpdatedSinceCutoff(deps.clock.now().getTime());

  const scopedReposSet = new Set(deps.getScopedRepos());
  const scopedRepos = deps.repos.filter((repo) => scopedReposSet.has(repo));

  const pendingSummary = newPassSummary();

  for (const repo of scopedRepos) {
    let records: PrReviewStateRecord[];
    try {
      records = await listAllReviewRecords(deps, repo, (r, limit, offset) =>
        deps.listPendingReviewRecords(r, limit, offset, updatedSince),
      );
    } catch (err) {
      console.error(
        `[pr-state-reconciler:review] failed to list pending-review PRs for ${repo}:`,
        err instanceof Error ? err.message : String(err),
      );
      pendingSummary.errored += 1; // the failed list-call itself — would-be record count is unknown
      continue;
    }

    for (const record of records) {
      pendingSummary.evaluated += 1;
      try {
        const outcome = await reconcileReviewStateRecord(deps, record);
        if (outcome === "patched") pendingSummary.patched += 1;
        else if (outcome === "skipped-claimed")
          pendingSummary.skippedClaimed += 1;
      } catch (err) {
        console.error(
          `[pr-state-reconciler:review] failed to reconcile ${repo}#${record.prNumber}:`,
          err instanceof Error ? err.message : String(err),
        );
        pendingSummary.errored += 1;
      }
      await deps.delay(DEFAULT_RECONCILER_DELAY_MS);
    }
  }

  logPassSummary(
    "[pr-state-reconciler:review]",
    "pending scan",
    pendingSummary,
  );

  const postedSummary = newPassSummary();

  for (const repo of scopedRepos) {
    let postedRecords: PrReviewStateRecord[];
    try {
      postedRecords = await listAllReviewRecords(
        deps,
        repo,
        deps.listPostedReviewRecords,
      );
    } catch (err) {
      console.error(
        `[pr-state-reconciler:review] failed to list posted-review PRs for ${repo}:`,
        err instanceof Error ? err.message : String(err),
      );
      postedSummary.errored += 1; // the failed list-call itself — would-be record count is unknown
      continue;
    }

    for (const record of postedRecords) {
      postedSummary.evaluated += 1;
      try {
        const outcome = await reconcilePostedReviewStateRecord(deps, record);
        if (outcome === "patched") postedSummary.patched += 1;
        else if (outcome === "skipped-claimed")
          postedSummary.skippedClaimed += 1;
      } catch (err) {
        console.error(
          `[pr-state-reconciler:review] failed to reconcile posted ${repo}#${record.prNumber}:`,
          err instanceof Error ? err.message : String(err),
        );
        postedSummary.errored += 1;
      }
      await deps.delay(DEFAULT_RECONCILER_DELAY_MS);
    }
  }

  logPassSummary("[pr-state-reconciler:review]", "posted scan", postedSummary);
}

// ─── Production deps ──────────────────────────────────────────────────────────

interface PrListResponseJson {
  prs: PrStateRecord[];
  total: number;
  limit: number;
  offset: number;
}

interface PrReviewListResponseJson {
  prs: PrReviewStateRecord[];
  total: number;
  limit: number;
  offset: number;
}

interface ReviewGraphqlResponse {
  data: {
    repository: {
      pullRequest: PrReviewData;
    };
  };
}

/** Shared PATCH-fetch helper for both production-deps factories in this file. */
function makePatchPrRecord(opts: {
  baseUrl: string;
  headers: Record<string, string>;
  doFetch: (url: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
}): (id: string, fields: Record<string, unknown>) => Promise<void> {
  const { baseUrl, headers, doFetch } = opts;
  return async (id: string, fields: Record<string, unknown>) => {
    const res = await doFetch(`${baseUrl}/prs/${id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify(fields),
    });
    if (!res.ok) {
      throw new Error(`task-store PATCH /prs/${id} → ${res.status}`);
    }
  };
}

/** GET /tasks response shape — mirrors createTaskStoreClient's own legacy-bare-array tolerance. */
interface TaskListResponseJson {
  tasks: PrOpenTaskRecord[];
}

/**
 * Shared GET
 * /tasks?status=<status>&limit=<limit>&offset=<offset>&updatedSince=<updatedSince>
 * helper backing `listPrOpenTasks` (PSR-1.1). `limit`/`offset` are passed
 * straight through, same as `listOpenPrRecords`'s own GET /prs helper, so the
 * module-level `listAllPrOpenTasks` pagination loop above can page to
 * completion instead of only ever seeing the task-store's default first
 * page. `updatedSince` is unconditionally included — recency-filtered per
 * PSR-1.1's (widened) window; see the module doc comment and
 * `PrStateReconcilerDeps.listOpenPrRecords`'s doc comment.
 */
function makeListTasksByStatus(opts: {
  baseUrl: string;
  headers: Record<string, string>;
  doFetch: (url: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
}): (
  status: string,
  limit: number,
  offset: number,
  updatedSince: string,
) => Promise<PrOpenTaskRecord[]> {
  const { baseUrl, headers, doFetch } = opts;
  return async (
    status: string,
    limit: number,
    offset: number,
    updatedSince: string,
  ) => {
    const params = new URLSearchParams({
      status,
      limit: String(limit),
      offset: String(offset),
      updatedSince,
    });
    const res = await doFetch(`${baseUrl}/tasks?${params}`, { headers });
    if (!res.ok) {
      throw new Error(`task-store GET /tasks?${params} → ${res.status}`);
    }
    const data = (await res.json()) as unknown;
    // Same legacy-bare-array tolerance as createTaskStoreClient's query().
    if (Array.isArray(data)) return data as PrOpenTaskRecord[];
    return (data as TaskListResponseJson).tasks;
  };
}

/** A single GET /tasks?repo=&branch= page, plus RSG-1.1's scopeDegraded signal. */
interface TasksByBranchPage {
  tasks: PrOpenTaskRecord[];
  /**
   * Mirrors the task-store's own `scopeDegraded` response field (RSG-1.1) —
   * true only when the calling agent token's repo-scope resolver call
   * itself failed upstream, forcing this response's `tasks` (and the
   * agent-scope OR-union it depends on) to under-report. Defaults to
   * `false` for legacy bare-array responses (pre-RSG-1.1 fixtures/servers),
   * matching that field's own documented default semantics.
   */
  scopeDegraded: boolean;
}

/**
 * GET /tasks?repo=<repo>&branch=<branch>&limit=<limit>&offset=<offset> helper
 * for `listAllTasksForBranch` (BBR-1.1's bundle-mate guard) — same request
 * shape/response handling as `makeListTasksByStatus` above, but filtered by
 * repo+branch instead of status. `repo=` scoping mirrors
 * `listOpenPrRecords`'s own GET /prs helper; `branch=` mirrors
 * check-deploy.ts's `createBundleCompleteQuery` (GET /tasks?branch=), the
 * existing "check every task on a branch individually" pattern this guard
 * follows.
 *
 * RSG-1.2: unlike `makeListTasksByStatus`, this returns the page alongside
 * the response's `scopeDegraded` flag (rather than just the task array) —
 * `listAllTasksForBranchImpl` below needs it to decide whether to retry.
 */
function makeListTasksByBranch(opts: {
  baseUrl: string;
  headers: Record<string, string>;
  doFetch: (url: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
}): (
  repo: string,
  branch: string,
  limit: number,
  offset: number,
) => Promise<TasksByBranchPage> {
  const { baseUrl, headers, doFetch } = opts;
  return async (
    repo: string,
    branch: string,
    limit: number,
    offset: number,
  ) => {
    const params = new URLSearchParams({
      repo,
      branch,
      limit: String(limit),
      offset: String(offset),
    });
    const res = await doFetch(`${baseUrl}/tasks?${params}`, { headers });
    if (!res.ok) {
      throw new Error(`task-store GET /tasks?${params} → ${res.status}`);
    }
    const data = (await res.json()) as unknown;
    // Same legacy-bare-array tolerance as createTaskStoreClient's query().
    if (Array.isArray(data)) {
      return { tasks: data as PrOpenTaskRecord[], scopeDegraded: false };
    }
    const parsed = data as TaskListResponseJson & { scopeDegraded?: boolean };
    return {
      tasks: parsed.tasks,
      scopeDegraded: parsed.scopeDegraded ?? false,
    };
  };
}

/**
 * WTR-1.4 staleness gate for `removeWorktree`'s production implementation
 * (review finding on #2313): a worktree directory whose mtime is more
 * recent than `cleanupAfterDays` is presumed still in active use by a
 * concurrent dev-task/patch/deploy session and is left alone, mirroring the
 * `cleanup_after_days` policy field already used elsewhere to decide when a
 * stale worktree is safe to remove.
 *
 * Uses the worktree directory's own mtime rather than a marker file inside
 * it — simplest signal available, and any file write within an active
 * session (git operations, editor saves, etc.) bumps the containing
 * directory's mtime on every mainstream filesystem this runs on (ext4,
 * APFS, etc.), so this doesn't require a session to touch any particular
 * file to stay "fresh".
 *
 * Missing directory (already removed, never created, wrong path) is
 * treated as stale — there's nothing to protect, so this should not block
 * `git worktree remove` from failing normally on a missing path.
 */
export function isWorktreeStale(
  worktreePath: string,
  cleanupAfterDays: number,
): boolean {
  if (!existsSync(worktreePath)) return true;
  const { mtimeMs } = statSync(worktreePath);
  const ageMs = Date.now() - mtimeMs;
  const thresholdMs = cleanupAfterDays * 24 * 60 * 60 * 1000;
  return ageMs >= thresholdMs;
}

export function buildProductionDeps(opts: {
  ghJson: <T>(args: string[]) => Promise<T>;
  fetchFn?: (url: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  getScopedRepos: () => string[];
  /**
   * Optional override for the resolved workspace root, normally derived from
   * WORKSPACE_PATH/AGENT_HOME via resolveWorkspacePath(). Exists so tests
   * that only care about other deps don't need AGENT_HOME/WORKSPACE_PATH set
   * in the ambient process.env — avoiding a shared-process test-isolation
   * hazard where another suite's temporary env mutation (e.g.
   * check-helpers.unit.test.ts's resolveWorkspacePath tests deleting
   * AGENT_HOME around their own assertions) could otherwise leak into these
   * tests since Bun runs all test files in one process. Defaults to
   * resolveWorkspacePath() when omitted, so production callers are
   * unaffected.
   */
  workspacePath?: string;
}): PrStateReconcilerDeps {
  const workspacePath = opts.workspacePath ?? resolveWorkspacePath();
  const repos = resolveAllRepos(workspacePath);
  const { ghJson } = opts;

  const taskStoreUrl = (process.env.SHIPWRIGHT_TASK_STORE_URL ?? "").trim();
  const taskStoreToken = (process.env.SHIPWRIGHT_TASK_STORE_TOKEN ?? "").trim();
  const baseUrl = taskStoreUrl.replace(/\/$/, "");
  const headers = {
    Authorization: `Bearer ${taskStoreToken}`,
    "Content-Type": "application/json",
  };
  const doFetch = opts.fetchFn ?? fetch;
  const listTasksByStatus = makeListTasksByStatus({
    baseUrl,
    headers,
    doFetch,
  });
  const listTasksByBranch = makeListTasksByBranch({
    baseUrl,
    headers,
    doFetch,
  });

  /**
   * Page a single repo+branch query to completion (BBR-1.1) — same loop
   * shape as `listAllOpenRecords` elsewhere in this file, but over
   * `listTasksByBranch`. Used by `listAllTasksForBranch`
   * below so a bundle branch with more task-store records than one page
   * still yields its true sibling count instead of silently truncating.
   *
   * RSG-1.2: the *first* page's `scopeDegraded` flag gates a single bounded
   * retry of that same first page before any further pagination happens —
   * a degraded response means the task-store's own agent-scope OR-union was
   * starved by a resolver failure, so continuing to page a response that
   * may already be under-counted would just compound the problem. If the
   * retried first page is STILL degraded, the true count is unknowable and
   * this resolves to `SCOPE_DEGRADED` without ever paging further. A
   * non-degraded first page (0, 1, or N tasks) proceeds exactly as before —
   * no retry, no delay call, identical to pre-RSG-1.2 behavior.
   *
   * Reads `deps.delay` (via the `deps` closure below, populated once
   * `buildProductionDeps` assembles its return object) rather than a
   * separately-captured delay function, so a caller that reassigns
   * `deps.delay` post-construction (this file's own tests do exactly that,
   * to inject a no-op/spy) transparently governs this retry's pause too —
   * there is only ever one "the delay dep" for a given deps object.
   */
  const listAllTasksForBranchImpl = async (
    repo: string,
    branch: string,
  ): Promise<PrOpenTaskRecord[] | typeof SCOPE_DEGRADED> => {
    const limit = DEFAULT_PAGE_LIMIT;

    let firstPage = await listTasksByBranch(repo, branch, limit, 0);
    if (firstPage.scopeDegraded) {
      await deps.delay(SCOPE_DEGRADED_RETRY_DELAY_MS);
      firstPage = await listTasksByBranch(repo, branch, limit, 0);
      if (firstPage.scopeDegraded) {
        return SCOPE_DEGRADED;
      }
    }

    const tasks: PrOpenTaskRecord[] = [...firstPage.tasks];
    if (firstPage.tasks.length < limit) return tasks;

    let offset = limit;
    for (;;) {
      const page = await listTasksByBranch(repo, branch, limit, offset);
      tasks.push(...page.tasks);
      if (page.tasks.length < limit) break;
      offset += limit;
    }

    return tasks;
  };

  // RSG-1.2: assembled as a named `const` (rather than a bare `return {...}`)
  // so `listAllTasksForBranchImpl` above can close over `deps.delay` by
  // reference — see its doc comment for why that matters for post-construction
  // test overrides of the delay dep.
  const deps: PrStateReconcilerDeps = {
    repos,
    getScopedRepos: opts.getScopedRepos,
    listOpenPrRecords: async (
      repo: string,
      limit: number,
      offset: number,
      updatedSince: string,
    ) => {
      const params = new URLSearchParams({
        repo,
        state: "open",
        limit: String(limit),
        offset: String(offset),
        updatedSince,
      });
      const res = await doFetch(`${baseUrl}/prs?${params}`, { headers });
      if (!res.ok) {
        throw new Error(`task-store GET /prs?${params} → ${res.status}`);
      }
      const data = (await res.json()) as PrListResponseJson;
      return data.prs;
    },
    patchPrRecord: makePatchPrRecord({ baseUrl, headers, doFetch }),
    ghViewPr: async (repo: string, prNumber: number) => {
      return await ghJson<GhPrView>([
        "pr",
        "view",
        String(prNumber),
        "--repo",
        repo,
        "--json",
        // headRefName (WTR-1.3) piggybacks on this same call — see
        // GhPrView's doc comment and reconcileRecord()'s worktree-removal
        // side effect above.
        "state,mergedAt,headRefName",
      ]);
    },
    listPrOpenTasks: (limit: number, offset: number, updatedSince: string) =>
      listTasksByStatus("pr_open", limit, offset, updatedSince),
    updateTaskStatus: async (id: string, fields: Record<string, unknown>) => {
      const res = await doFetch(`${baseUrl}/tasks/${id}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify(fields),
      });
      if (!res.ok) {
        throw new Error(`task-store PATCH /tasks/${id} → ${res.status}`);
      }
    },
    ghListMergedPrsForBranch: async (repo: string, branch: string) => {
      return await ghJson<Array<{ number: number }>>([
        "pr",
        "list",
        "--head",
        branch,
        "--state",
        "merged",
        "--repo",
        repo,
        "--json",
        "number",
      ]);
    },
    listAllTasksForBranch: listAllTasksForBranchImpl,
    // createPrRecordQuery (check-helpers.ts) already implements exactly this
    // repo+prNumber lookup and, unlike this file's own listOpenPrRecords/
    // patchPrRecord, never throws — it resolves to null on missing config or
    // any fetch error, which matches the "a PR record may simply not exist
    // yet" semantics the taskId backfill needs.
    findPrRecordByRepoAndPrNumber: createPrRecordQuery<PrStateRecord>({
      fetchFn: opts.fetchFn,
    }),
    now: () => new Date().toISOString(),
    delay: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
    isCleanupMergedWorktreesEnabled: readCleanupMergedWorktrees(workspacePath),
    removeWorktree: async (shortRepo: string, worktreeDirName: string) => {
      const worktreeRoot = (
        process.env.SHIPWRIGHT_WORKTREE_DIR ?? join(workspacePath, "worktrees")
      ).trim();
      const worktreePath = join(worktreeRoot, worktreeDirName);

      // WTR-1.4 (review finding on #2313): `--force` bypasses git's own
      // uncommitted/untracked-changes safety check and is triggered purely
      // by GitHub-reported merge/close state, with no signal for whether a
      // concurrent dev-task/patch/deploy session still has this exact
      // worktree open (e.g. a human merges the PR mid-session). Gate the
      // force-removal on the same `cleanup_after_days` staleness threshold
      // that already governs "remove worktrees older than N days" — a
      // worktree modified more recently than that threshold is presumed
      // still in active use and is left alone rather than force-removed.
      const cleanupAfterDays = readCleanupAfterDays(workspacePath);
      if (!isWorktreeStale(worktreePath, cleanupAfterDays)) {
        console.log(
          `[pr-state-reconciler] skipping removal of ${worktreePath} — modified within the last ${cleanupAfterDays} day(s), may still be in use`,
        );
        return;
      }

      const proc = Bun.spawn(
        ["git", "worktree", "remove", worktreePath, "--force"],
        {
          cwd: join(workspacePath, "repos", shortRepo),
          env: process.env,
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [stderr, status] = await Promise.all([
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      if (status !== 0) {
        throw new Error(
          `git worktree remove ${worktreePath} failed (exit ${status}): ${stderr}`,
        );
      }
    },
  };

  return deps;
}

/**
 * Production deps for `reconcileReviewState()`. Kept as a distinctly-named
 * factory (not a `buildProductionDeps` overload) since its query shape
 * (`state=open&reviewState=pending`) and GitHub call (GraphQL review fetch)
 * are unrelated to `reconcilePrState()`'s (`state=open` list + `gh pr view`).
 */
export function buildReviewStateProductionDeps(opts: {
  ghGraphql: <T>(query: string) => Promise<T>;
  fetchFn?: (url: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  clock?: Clock;
  getScopedRepos: () => string[];
  /**
   * Optional override for the resolved workspace root, normally derived from
   * WORKSPACE_PATH/AGENT_HOME via resolveWorkspacePath(). Exists so tests
   * that only care about other deps don't need AGENT_HOME/WORKSPACE_PATH set
   * in the ambient process.env — avoiding a shared-process test-isolation
   * hazard where another suite's temporary env mutation (e.g.
   * check-helpers.unit.test.ts's resolveWorkspacePath tests deleting
   * AGENT_HOME around their own assertions) could otherwise leak into these
   * tests since Bun runs all test files in one process. Defaults to
   * resolveWorkspacePath() when omitted, so production callers are
   * unaffected.
   */
  workspacePath?: string;
}): PrReviewStateReconcilerDeps {
  const workspacePath = opts.workspacePath ?? resolveWorkspacePath();
  const repos = resolveAllRepos(workspacePath);
  const { ghGraphql } = opts;

  const taskStoreUrl = (process.env.SHIPWRIGHT_TASK_STORE_URL ?? "").trim();
  const taskStoreToken = (process.env.SHIPWRIGHT_TASK_STORE_TOKEN ?? "").trim();
  const baseUrl = taskStoreUrl.replace(/\/$/, "");
  const headers = {
    Authorization: `Bearer ${taskStoreToken}`,
    "Content-Type": "application/json",
  };
  const doFetch = opts.fetchFn ?? fetch;

  /**
   * Shared GET
   * /prs?repo=<repo>&state=open&reviewState=<reviewState>[&updatedSince=<updatedSince>]
   * helper for both the pending scan and the posted scan (CHU-2.4) —
   * identical request shape, only the `reviewState` query value differs (and,
   * as of PSR-1.1, whether `updatedSince` is included at all: the pending
   * scan passes it through from its caller, the posted scan never does — see
   * `PrReviewStateReconcilerDeps.listPendingReviewRecords`'s doc comment for
   * why CHU-2.4's healing pass must not be recency-filtered).
   */
  const listReviewRecordsByState = (
    reviewState: "pending" | "posted",
  ): ((
    repo: string,
    limit: number,
    offset: number,
    updatedSince?: string,
  ) => Promise<PrReviewStateRecord[]>) => {
    return async (
      repo: string,
      limit: number,
      offset: number,
      updatedSince?: string,
    ) => {
      const params = new URLSearchParams({
        repo,
        state: "open",
        reviewState,
        limit: String(limit),
        offset: String(offset),
        ...(updatedSince !== undefined ? { updatedSince } : {}),
      });
      const res = await doFetch(`${baseUrl}/prs?${params}`, { headers });
      if (!res.ok) {
        throw new Error(`task-store GET /prs?${params} → ${res.status}`);
      }
      const data = (await res.json()) as PrReviewListResponseJson;
      return data.prs;
    };
  };

  return {
    repos,
    getScopedRepos: opts.getScopedRepos,
    clock: opts.clock ?? SystemClock(),
    claimTtlMs: Number(
      process.env.SHIPWRIGHT_TASK_STORE_CLAIM_TTL_MS ?? DEFAULT_CLAIM_TTL_MS,
    ),
    listPendingReviewRecords: listReviewRecordsByState("pending"),
    listPostedReviewRecords: listReviewRecordsByState("posted"),
    patchPrRecord: makePatchPrRecord({ baseUrl, headers, doFetch }),
    fetchPrReviews: async (org: string, repo: string, pr: number) => {
      const query = `{
  repository(owner: "${org}", name: "${repo}") {
    pullRequest(number: ${pr}) {
      headRefOid
      reviews(first: 50) {
        nodes {
          author { login }
          state
          submittedAt
          commit { oid }
          body
        }
      }
      reviewThreads(first: 100) {
        nodes {
          isResolved
          comments(first: 1) {
            nodes {
              author { login }
              body
            }
          }
        }
      }
      comments(last: 50) {
        nodes {
          author { login }
          body
          createdAt
        }
      }
    }
  }
}`;
      const response = await ghGraphql<ReviewGraphqlResponse>(query);
      return response.data.repository.pullRequest;
    },
    delay: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}
