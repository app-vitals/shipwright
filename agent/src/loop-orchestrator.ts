/**
 * agent/src/loop-orchestrator.ts
 *
 * WL-3.3 — the shipwright-loop drain-until-dry orchestrator.
 *
 * createLoopOrchestrator(deps) returns a single `(jobs) => Promise<void>`
 * closure that the cron-sync loop constructs ONCE and calls on every tick. The
 * closure owns a mutable busy flag so a mid-drain tick can no-op immediately
 * when a prior tick is still running — a process restart mid-loop is safe
 * without extra durability, since the existing stale-claim reaper reclaims
 * anything left claimed.
 *
 * Each tick, while not busy:
 *   1. Read the five independent phase toggles for this agent (dev-task /
 *      plan / review / patch / deploy) via resolveLoopPhaseToggles — never
 *      shipwright-review-patch's flag, and never invoking /shipwright:review-patch.
 *      The plan phase (PDR-4.1) additionally requires the
 *      SHIPWRIGHT_AGENT_AUTONOMOUS_PLAN_SESSION_ENABLED kill switch; with it
 *      unset the tick behaves byte-for-byte as it did before PDR-4.1.
 *   2. For each enabled phase, call its qualification function to get
 *      structured candidates. Merge the enabled phases' PR candidate lists into
 *      one array, and dev-task's + plan's task candidate lists into another.
 *   3. Call work-selector.ts's selectNextWorkItem(tasks, mergedPrs) exactly
 *      once — strict age-based FIFO across both entity types, no phase bias.
 *   4. If it returns an item, pre-claim it against the task store BEFORE
 *      dispatch — task items via claimTask (CBD-1.2), PR items via claimPr
 *      (CBD-1.3, POST /prs/claim). A 409 conflict (another replica already
 *      claimed it) skips dispatch entirely (no runner() call, no cron-run
 *      row) and the drain loop re-collects and continues. On a successful PR
 *      pre-claim, a marker carrying the claimed record's id + commitSha
 *      (see formatPreClaimMarker) is appended to the dispatched command
 *      string so a future downstream skill (CBD-1.4/1.5/1.6) can recognize
 *      and trust it instead of re-claiming and 409ing against itself. Then
 *      dispatch the correct one-shot command by the item's phase tag (task →
 *      /shipwright:dev-task | /shipwright:plan-session; pr →
 *      /shipwright:review | /shipwright:patch | /shipwright:deploy) via the
 *      injected claude runner, and report the run. Every phase's command is
 *      `{command} {itemId}` except plan's, which is
 *      `{command} {repo} {session} --autonomous {itemId}`.
 *   5. Repeat immediately (not waiting for the next cron tick) while work
 *      remains. Stop when nothing is selected. A dispatch that throws (e.g.
 *      the runner times out or errors) is caught, reported, and skipped —
 *      it does not abort the tick; the drain continues with the next
 *      candidate.
 *
 * The busy flag is always released in a finally block, even on a thrown error.
 *
 * Cron-run observability: every real one-shot command dispatch reports its own
 * createRun/completeRun pair via CronRunReporter, tagged with that
 * invocation's phase, so the admin UI run-history page and metrics dashboard
 * can attribute cost/tokens/outcome to the correct phase even though every
 * invocation shares the single shipwright-loop cronId.
 *
 * Noise guard: a phase whose qualification check simply finds no candidates is
 * NOT a run and creates zero AgentCronRun rows. The reporter is only called
 * inside the branch where selectNextWorkItem returned a non-null item and a
 * command was genuinely dispatched. An idle tick (nothing selected) reports
 * nothing at all.
 *
 * Work-queue reporting (AWQ-1.3) is deliberately NOT subject to that noise
 * guard: every while-loop iteration ranks that iteration's already-collected
 * tasks/prs via rankWorkItems() and fires workQueueReporter.reportSnapshot()
 * — including the final idle/dry iteration where selectNextWorkItem returns
 * null and nothing gets dispatched. This is a full-queue observability
 * snapshot (what's waiting right now), not a per-dispatch run record, so an
 * empty snapshot on an idle tick is itself meaningful signal rather than
 * noise.
 */

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ErrorCapturingClient } from "@shipwright/lib/sentry";
import {
  buildProductionDeps as buildDeployDeps,
  getDeployCandidates,
} from "./check-deploy.ts";
import {
  buildProductionDeps as buildDevTaskDeps,
  getDevTaskCandidates,
} from "./check-dev-task.ts";
import {
  createTaskStoreClient,
  getCurrentUser,
  ghGraphql,
  ghJson,
  parseCandidateId,
} from "./check-helpers.ts";
import {
  buildProductionDeps as buildPatchDeps,
  getPatchCandidates,
} from "./check-patch.ts";
import {
  buildProductionDeps as buildPlanDeps,
  getPlanCandidates,
} from "./check-plan.ts";
import {
  buildProductionDeps as buildReviewDeps,
  getReviewCandidates,
} from "./check-review.ts";
import {
  ClaudeRunError,
  type ClaudeRunResult,
  ClaudeTimeoutError,
  type EarlySessionIdCallback,
  type ProgressCallback,
  reportClaudeError,
} from "./claude.ts";
import { type Clock, SystemClock } from "./clock.ts";
import type { RunContextStamp } from "./context-stamp.ts";
import { markCronRunFailureReported } from "./cron-failure-reporter.ts";
import {
  buildTokenPayload,
  formatCronMessage,
  type TokenPayloadExtras,
} from "./cron-handler.ts";
import type { CronRunReporter } from "./cron-run-reporter.ts";
import {
  type CronJobLike,
  LOOP_PHASE_JOB_NAMES,
  resolveLoopPhaseJobId,
  resolveLoopPhaseToggles,
} from "./loop-cron-classifier.ts";
import { parseMarkers } from "./markers.ts";
import {
  createPatchStateSnapshotter,
  evaluatePatchOutcome,
  type PatchStateSnapshot,
} from "./patch-outcome-check.ts";
import type { RunTelemetry } from "./run-telemetry.ts";
import type { WorkQueueReporter } from "./work-queue-reporter.ts";
import {
  rankWorkItems,
  selectNextWorkItem,
  type WorkPrCandidate,
  type WorkTaskCandidate,
} from "./work-selector.ts";

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * The phase a dispatched run serves — used to tag the AgentCronRun row.
 * "plan" (PDR-4.1) is the autonomous plan-session phase; unlike the other
 * four it is gated behind BOTH its manifest cron toggle and the
 * SHIPWRIGHT_AGENT_AUTONOMOUS_PLAN_SESSION_ENABLED kill switch.
 */
export type LoopPhase = "dev-task" | "plan" | "review" | "patch" | "deploy";

export interface LoopOrchestratorDeps {
  /** WL-2.2 dev-task qualification, pre-wired over its own production deps. */
  getDevTaskCandidates: () => Promise<WorkTaskCandidate[]>;
  /**
   * PDR-4.1 autonomous plan-session qualification — candidates tagged
   * `phase: "plan"` and carrying the task's repo/session (check-plan.ts).
   * Optional: an orchestrator constructed without it behaves exactly as it
   * does today, and it is only ever CALLED when both the `shipwright-plan`
   * toggle and SHIPWRIGHT_AGENT_AUTONOMOUS_PLAN_SESSION_ENABLED are on.
   */
  getPlanCandidates?: () => Promise<WorkTaskCandidate[]>;
  /** WL-2.2 review qualification — candidates tagged phase: "review". */
  getReviewCandidates: () => Promise<WorkPrCandidate[]>;
  /** WL-2.2 patch qualification — candidates tagged phase: "patch". */
  getPatchCandidates: () => Promise<WorkPrCandidate[]>;
  /** WL-2.2 deploy qualification — candidates tagged phase: "deploy". */
  getDeployCandidates: () => Promise<WorkPrCandidate[]>;
  /**
   * Pre-claim (CBD-1.2): claims a dev-task candidate directly against the
   * task store, POSTing /tasks/{id}/claim, BEFORE it is dispatched. Resolves
   * true on success (200/201) — dispatch proceeds unchanged. Resolves false
   * on a 409 conflict (another agent replica already claimed it) — the item
   * is skipped entirely (no dispatch, no cron-run row) and the drain loop
   * re-collects candidates and continues. Only called for `item.type ===
   * "task"` — PR items (review/patch/deploy) are never pre-claimed here.
   */
  claimTask: (taskId: string) => Promise<boolean>;
  /**
   * Pre-claim (CBD-1.3): claims a PR candidate (review/patch/deploy) directly
   * against the task store, POSTing /prs/claim, BEFORE it is dispatched.
   * Resolves the claimed record's {id, commitSha} on success (200/201) — used
   * to build the pre-claim marker appended to the dispatched command string
   * (see formatPreClaimMarker) so a future downstream skill can recognize and
   * trust it instead of re-claiming and 409ing against itself. Resolves null
   * on a 409 conflict (another agent replica already claimed this PR at this
   * commit) — the item is skipped entirely (no dispatch, no cron-run row) and
   * the drain loop re-collects candidates and continues. Only called for
   * `item.type === "pr"` — task items are pre-claimed via claimTask.
   */
  claimPr: (
    pr: WorkPrCandidate,
  ) => Promise<{ id: string; commitSha: string } | null>;
  /**
   * SKT-2.1 — records a skip against the task-store's skip-tracking streak
   * for the given item, called on the `[silent]`-marker dispatch branch
   * (found nothing to do once it actually ran). Fire-and-forget: the
   * implementation must never throw/reject (errors are caught and warned at
   * the client layer), so call sites `await` it directly with no wrapping
   * try/catch — a task-store error here must never abort or delay the
   * dispatch loop.
   *
   * `recordId` is NOT always the same value as the dispatch's `itemId`: for
   * a "task" item they're identical (the task's plain id), but for a "pr"
   * item `recordId` must be the PullRequest DB record's CUID (captured from
   * claimPr's result at the pre-claim call site) — `itemId` for PR items
   * stays the human-readable "org/repo#123" candidate id used purely for
   * cron-run-reporter tagging, and is the WRONG value to pass here.
   *
   * `reason` (SRB-1.1) is the dispatch's parsed `[skip-reason:...]` marker
   * text (or the "command:no-work" fallback when no marker was tagged),
   * forwarded unconditionally — no skip-reason category is exempt from the
   * task-store's reason-aware skip-streak counting.
   */
  recordSkip: (
    itemType: "task" | "pr",
    recordId: string,
    reason?: string,
  ) => Promise<void>;
  /**
   * SKT-2.1 — clears a prior skip streak for the given item, called on the
   * real `completed` dispatch branch (any actual progress). Same
   * fire-and-forget contract and recordId-vs-itemId distinction as
   * recordSkip above.
   */
  resetSkip: (itemType: "task" | "pr", recordId: string) => Promise<void>;
  /**
   * The claude runner — sends a one-shot slash-command message. The optional
   * second `onProgress` param (CSU-1.1) is fired as each new assistant turn
   * completes, with a fresh accumulated per-model usage snapshot — wired to
   * cronRunReporter.recordProgress (debounced) inside dispatch() so token
   * totals survive an agent-process kill mid-run, not just a clean
   * completion.
   *
   * DTW-1.3 widened the signature with two optional trailing params:
   *   - `sessionKey` — the resume identity. The underlying runner
   *     (createRunClaude's closure) persists session ids in its own
   *     `sessions` map keyed by this value and automatically builds `-r <id>`
   *     on the next call with the SAME key, so a resume "just happens" by
   *     calling runner() again with it. Two shapes, per phase:
   *       · dev-task — `dev-task:{taskId}` (DTR-1.1): stable across every
   *         dispatch of this task, no per-dispatch nonce, so it survives
   *         separate dispatches too — a LATER, independent dispatch of the
   *         same still-in_progress task (next cron tick, a StaleClaimReaper
   *         reclaim, a human re-run) resumes this same session instead of
   *         starting cold. Only cleared (via clearSessionKey) once a fresh
   *         getTaskState check confirms the task reached a terminal
   *         dev-task-work status — see dispatchItem's dev-task finally block.
   *       · review/patch/deploy — `{phase}:{itemId}:{uuid}` (CRT-1.3): a
   *         per-dispatch nonce, so resuming works WITHIN one dispatch's own
   *         resume loop but never across dispatches; cleared unconditionally
   *         when that loop exits.
   *     Left undefined for plan, which always starts fresh.
   *   - `onEarlySessionId` — fires as soon as a session id is known (even for
   *     a call that started fresh), wired to cronRunReporter.recordSessionId
   *     so the cron-run log carries it before the run reaches a terminal state.
   */
  runner: (
    message: string,
    onProgress?: ProgressCallback,
    sessionKey?: string,
    onEarlySessionId?: EarlySessionIdCallback,
  ) => Promise<ClaudeRunResult>;
  /**
   * DTW-1.3 — fetches a task's live state from the task store, used by the
   * dev-task-only auto-resume loop in dispatchItem to decide whether to
   * immediately resume a still-in_progress task instead of waiting for the
   * next cron tick / the StaleClaimReaper. Returns null if the task can't be
   * found (treated as "stop resuming").
   *
   * Returns `claimedBy` alongside `status` (both come from the same
   * GET /tasks/{id} response, so this costs nothing extra) because status
   * alone can't distinguish "still mine" from "reaped and re-claimed by
   * someone else" — see the resume gate in dispatchItem and the `agentId`
   * doc comment below.
   */
  getTaskState: (
    taskId: string,
  ) => Promise<{ status: string; claimedBy: string | null } | null>;
  /**
   * This agent's own claim identity (SHIPWRIGHT_AGENT_ID) — the value the
   * task store pins `claimedBy` to when this agent's token claims a task.
   * Used by BOTH auto-resume gates in dispatchItem — the dev-task one
   * (DTW-1.3) and the PR-phase review/patch/deploy one (CRT-1.3). A dispatch
   * can hold a task or PR across up to 1 + MAX_AUTO_RESUMES sequential
   * runner() calls, which is long enough for the claim TTL to lapse if an
   * attempt stalls past its heartbeat. If the StaleClaimReaper then releases
   * the claim and a different claimant picks the item back up before the next
   * check, an owner-blind gate would happily resume this loop's stale session
   * against a task/PR another session now owns.
   *
   * Optional: when undefined (no agent id configured, and every test that
   * doesn't opt in), each gate skips only its owner-match half and falls back
   * to its always-on floor — `status === "in_progress"` for dev-task,
   * `claimedBy !== null` for a PR — so an unconfigured agent behaves as it
   * did pre-gate rather than silently refusing to ever resume, while still
   * never resuming against a released or finished item.
   */
  agentId?: string;
  /**
   * DTW-1.3 — renews this dispatch's claim on a task (POST
   * /tasks/{id}/heartbeat) immediately before each auto-resume attempt.
   *
   * `lib/claim-ttl.ts`'s DEFAULT_CLAIM_TTL_MS (session timeout + 5min buffer)
   * is sized on the assumption that a claim spans exactly ONE Claude session,
   * so "a claim isn't reaped mid-session". The auto-resume loop breaks that
   * assumption: one dispatch can issue up to 1 + MAX_AUTO_RESUMES sequential
   * runner() calls against the same claim, and nothing in this file (or in
   * createTaskStoreClient) renews the claim between them — the only other
   * heartbeat renewals are prompt-driven, inside the dev-task session itself,
   * and an attempt that exits abnormally early (precisely the case this
   * feature targets) may never reach one. Without this renewal the reaper can
   * release the claim mid-dispatch and a sibling agent can start a second,
   * cold session on the same task/branch while this dispatch's next attempt is
   * still in flight. The `claimedBy` ownership gate closes the resume half of
   * that race but not the reap half; refreshing here closes the reap half by
   * giving every attempt a full TTL window, exactly like the `/claim` that
   * started the dispatch.
   *
   * A rejection means "the claim could not be proven fresh" and stops the
   * resume loop (the dispatch itself still succeeds) — strictly today's
   * pre-DTW-1.3 behavior, same fail-safe stance as a getTaskState failure.
   *
   * Optional: when undefined (every test that doesn't opt in), the loop
   * resumes without renewing, identical to pre-fix behavior.
   */
  heartbeatTask?: (taskId: string) => Promise<void>;
  /**
   * CRT-1.2 — fetches a PR's live state from the task store; consumed by
   * CRT-1.3's PR-phase (review/patch/deploy) auto-resume gate in dispatchItem
   * to decide whether to immediately resume the same session instead of
   * waiting for the next cron tick / the StaleClaimReaper. Returns null if the
   * PR can't be found (treated as "stop resuming"). The PR analog of
   * getTaskState, called with the PullRequest DB record's CUID (`recordId`),
   * never the `org/repo#123` display id.
   *
   * `claimedBy` is the whole gate for a PR item: unlike a task there is no
   * `in_progress`-equivalent status to check, because every real PR completion
   * path already nulls the claim.
   *
   * Optional: when undefined (every test and deployment that doesn't opt in),
   * a PR-phase dispatch never resumes — it runs exactly one attempt, identical
   * to pre-CRT-1.3 behavior.
   */
  getPrState?: (
    prId: string,
  ) => Promise<{ reviewState?: string; claimedBy: string | null } | null>;
  /**
   * PSL-2.1 — reads the PR record fields that move when a review/patch phase
   * makes real progress (reviewState, reviewedCommitSha, commitSha). Called
   * before and after a PR dispatch; if the dispatch ends `[silent]` without
   * a `[skip-reason:...]` marker and the record made progress (new
   * commitSha/reviewedCommitSha, or reviewState moved somewhere other than
   * `pending`), the skip streak is reset instead of advanced (skipRun is
   * still reported). Kept separate from getPrState so
   * the resume gate's call sequence is unaffected. Returns null if the PR is
   * missing; a rejection or null on either read fails closed to recordSkip.
   *
   * Optional: when undefined, every `[silent]` PR dispatch calls recordSkip
   * exactly as before.
   */
  getPrProgress?: (prId: string) => Promise<{
    reviewState?: string | null;
    reviewedCommitSha?: string | null;
    commitSha?: string | null;
  } | null>;
  /**
   * PHS-3.1 — post-dispatch outcome check for patch dispatches. `snapshot`
   * reads a PR's live patch-candidacy state (head, open finding refs, merge
   * conflict, failing CI) by candidate id ("org/repo#n"); it is called before
   * the dispatch and again after it on EVERY exit (completed, `[silent]`, or
   * thrown). If the PR is still a patch candidate at the same head with the
   * same unsettled state, `escalate` flags the PR record blocked with a
   * specific reason instead of letting the next tick re-dispatch it. A null
   * snapshot (read failure) or a rejecting `escalate` never fails the
   * dispatch. Optional: when undefined, patch dispatches are unchanged.
   */
  patchOutcome?: {
    snapshot: (
      candidateId: string,
      prAuthor?: string,
    ) => Promise<PatchStateSnapshot | null>;
    escalate: (
      recordId: string,
      candidateId: string,
      reason: string,
      headSha: string,
    ) => Promise<void>;
  };
  /**
   * CRT-1.2 — renews a claimed PR's `heartbeatAt` (POST /prs/{id}/heartbeat)
   * so the task-store's claim TTL doesn't release the claim out from
   * under a long-running, multi-attempt dispatch. The PR analog of
   * heartbeatTask, and consumed by CRT-1.3's PR-phase resume loop for exactly
   * the same reason: one dispatch can hold a claim across up to
   * 1 + MAX_AUTO_RESUMES sequential runner() calls, while DEFAULT_CLAIM_TTL_MS
   * is sized for a single session. Called with `recordId` (the DB CUID) and
   * ordered AFTER the ownership gate, so a claim that already belongs to a
   * sibling agent is never refreshed on its behalf. A rejection means "the
   * claim could not be proven fresh" and stops the resume loop; the dispatch
   * itself still succeeds.
   *
   * Optional: when undefined (every test that doesn't opt in), the loop
   * resumes without renewing, identical to pre-CRT-1.2 behavior.
   */
  heartbeatPr?: (prId: string) => Promise<void>;
  /**
   * PRL-1.3 — mechanical safety net behind the patch skill's prose-level
   * release (PRL-1.2): releases the PR record's claim (POST /prs/{id}/release).
   * Called after a patch dispatch ends `[silent]` (including the PHS-3.1
   * escalation path, since blockPr does not release the claim) when the live
   * claimedBy is still this agent. Best-effort: a rejection is logged and
   * swallowed, never failing the dispatch. Requires getPrState and agentId to
   * take effect.
   *
   * Optional: when undefined, a silent patch dispatch leaves the claim as-is.
   */
  releasePr?: (prId: string) => Promise<void>;
  /**
   * Clears a persisted session-store entry by key. Called (best-effort) when a
   * dispatch's resume loop exits — but WHEN it's called differs per phase,
   * matching the two sessionKey shapes described on `runner` above:
   *   - dev-task (DTR-1.1) — ONLY once a fresh getTaskState check in that
   *     block's finally confirms the task reached a terminal dev-task-work
   *     status (TERMINAL_DEV_TASK_STATUSES). The key is stable
   *     (`dev-task:{taskId}`, no nonce) precisely so it can survive this
   *     dispatch's exit and be resumed by a LATER, separate dispatch of the
   *     same still-in_progress task; clearing unconditionally (the
   *     pre-DTR-1.1 behavior) would defeat that cross-dispatch resume.
   *   - review/patch/deploy (CRT-1.3) — unconditionally on every exit. Those
   *     keys are per-dispatch nonces with nothing to preserve across
   *     dispatches, so there's no state to re-check first.
   *
   * Optional and never awaited for correctness: a failure here is logged and
   * swallowed (a stray entry is harmless, and the store's TTL prune — wired in
   * index.ts — is the backstop for the entries an abrupt process kill leaves
   * behind).
   */
  clearSessionKey?: (key: string) => Promise<void>;
  /** Reports each dispatch's run to the admin API (fire-and-forget). */
  cronRunReporter: CronRunReporter;
  /**
   * Reports the ranked work-queue snapshot every while-loop iteration
   * (dispatch or idle), fire-and-forget. Unlike cronRunReporter, this has no
   * dispatch-only noise guard — see the file's top doc comment.
   */
  workQueueReporter: WorkQueueReporter;
  /** The shipwright-loop cron id — shared by every dispatch's run row. */
  loopCronId: string;
  /** Clock for deterministic run timestamps. Defaults to SystemClock(). */
  clock?: Clock;
  /**
   * Reads the always-loaded-context stamp (see context-stamp.ts) once per
   * dispatch so the run row can be grouped by what the model was given.
   * Optional: absent → runs are reported without a fingerprint.
   */
  contextStamp?: () => RunContextStamp | null;
  /**
   * LO-1.1 — optional injected Sentry client, mirroring cron-failure-
   * reporter.ts's sentryClient?.captureException pattern (undefined when
   * SENTRY_DSN is unset, matching every other optional-by-convention
   * sentryClient call site in this codebase). When present, dispatch()'s
   * entire per-item execution runs inside `sentryClient.withScope(...)` —
   * a forked (not shared/mutated) Sentry scope tagged with `item_type`/
   * `item_id` for the item currently being dispatched. Any Sentry event
   * captured while that scope is active (dispatch()'s own
   * captureException call on a thrown runner failure below, or a
   * console.warn/console.error forwarded as a Sentry Log by
   * consoleLoggingIntegration) carries those tags, so a Sentry
   * Issue/Log is attributable to the specific task/PR in flight — not
   * just "which service/agent" (lib/sentry.ts's static initialScope
   * tags). `withScope` is optional on ErrorCapturingClient — a fake that
   * only implements `captureException` (the older, pre-LO-1.1 shape)
   * still type-checks; dispatch() falls back to running the per-item body
   * unscoped when either `sentryClient` or `sentryClient.withScope` is
   * absent.
   */
  sentryClient?: ErrorCapturingClient;
  /**
   * DTA-1.3 — random source for the per-run command variant draw, returning
   * a float in [0, 1). Optional: defaults to Math.random. Injected so tests
   * can pin the draw deterministically.
   */
  random?: () => number;
  /**
   * DTA-1.3 — validates that a configured alternate slash command exists
   * before it is dispatched. Optional: defaults to checking the shipwright
   * plugin's commands directory (`/shipwright:<name>` → `<name>.md`). A
   * command that fails the check falls back to the default command.
   */
  commandExists?: (command: string) => boolean;
}

// ─── Command routing ──────────────────────────────────────────────────────────

/**
 * The literal slash-command string and phase tag for each pipeline phase.
 * Deliberately no "/shipwright:review-patch" — the loop's per-tick selection
 * across all five phases supersedes that command's internal review-vs-patch
 * decision, so it is never invoked.
 */
const PHASE_COMMANDS: Record<LoopPhase, string> = {
  "dev-task": "/shipwright:dev-task",
  plan: "/shipwright:plan-session",
  review: "/shipwright:review",
  patch: "/shipwright:patch",
  deploy: "/shipwright:deploy",
};

/** Which slash-command variant a dispatch ran (DTA-1.3). */
export type CommandVariant = "default" | "alternate";

/**
 * Default existence check for a configured alternate command: it must be a
 * `/shipwright:<name>` slash command backed by a `<name>.md` file in the
 * plugin's commands directory.
 */
function pluginCommandExists(command: string): boolean {
  const match = /^\/shipwright:([a-z0-9-]+)$/.exec(command);
  if (!match) return false;
  return existsSync(
    join(
      import.meta.dir,
      "../../plugins/shipwright/commands",
      `${match[1]}.md`,
    ),
  );
}

/**
 * Reads a phase's A/B config from `SHIPWRIGHT_LOOP_<PHASE>_ALT_COMMAND` and
 * `SHIPWRIGHT_LOOP_<PHASE>_ALT_SHARE` (percentage, 0-100). Read fresh on every
 * call so an env change takes effect on the next dispatch. A missing,
 * non-numeric or out-of-range share is treated as 0 (alternate never used),
 * so with nothing configured every run uses the default command.
 */
function readVariantConfig(phase: LoopPhase): {
  alternate: string | undefined;
  share: number;
} {
  const key = `SHIPWRIGHT_LOOP_${phase.toUpperCase().replace(/-/g, "_")}_ALT`;
  const alternate = process.env[`${key}_COMMAND`]?.trim() || undefined;
  const share = Number(process.env[`${key}_SHARE`]);
  return {
    alternate,
    share: Number.isFinite(share) && share > 0 ? Math.min(share, 100) : 0,
  };
}

/**
 * DTA-1.3 — picks the slash command for one dispatch. Returns the default
 * `PHASE_COMMANDS` entry unless an alternate is configured with a positive
 * share, the random draw lands inside that share, AND the alternate passes
 * the existence check (a bad value falls back to the default, with a warning).
 */
export function resolvePhaseCommand(
  phase: LoopPhase,
  random: () => number,
  commandExists: (command: string) => boolean = pluginCommandExists,
): { command: string; variant: CommandVariant } {
  const fallback = {
    command: PHASE_COMMANDS[phase],
    variant: "default" as const,
  };
  const { alternate, share } = readVariantConfig(phase);
  if (!alternate || share <= 0) return fallback;
  if (random() * 100 >= share) return fallback;
  if (!commandExists(alternate)) {
    console.warn(
      `[loop-orchestrator] ${phase} alternate command "${alternate}" does not exist — falling back to ${fallback.command}`,
    );
    return fallback;
  }
  return { command: alternate, variant: "alternate" };
}

/**
 * PDR-4.1 — the code-level kill switch gating the autonomous plan-session
 * phase, separate from (and ANDed with) the `shipwright-plan` manifest cron
 * toggle. Both must be on for plan candidates to be collected at all. With
 * this unset, the plan branch is structurally unreachable and the tick's
 * behavior is byte-for-byte what it is today.
 */
const AUTONOMOUS_PLAN_SESSION_ENV =
  "SHIPWRIGHT_AGENT_AUTONOMOUS_PLAN_SESSION_ENABLED";

/**
 * Reads a strict `"true"` boolean env var. Read fresh on every call (never
 * cached) so an operator's env change takes effect on the very next tick
 * without a restart — same contract as readPositiveIntEnv below.
 */
function readBooleanEnv(name: string): boolean {
  return process.env[name] === "true";
}

/**
 * Builds the plan phase's command arguments:
 * `{repo} {session} --autonomous {task-id}`, matching
 * plugins/shipwright/commands/plan-session.md's argument contract (repo
 * first, session second, then the `--autonomous {task-id}` flag). Returns
 * null when the candidate lacks either field, which check-plan.ts already
 * filters out — kept here as a typed guard so an injected/foreign candidate
 * provider can't produce a `/shipwright:plan-session undefined undefined`
 * dispatch.
 */
export function buildPlanCommandArgs(task: WorkTaskCandidate): string | null {
  const repo = task.repo?.trim();
  const session = task.session?.trim();
  if (!repo || !session) return null;
  return `${repo} ${session} --autonomous ${task.id}`;
}

/**
 * Threshold for spin detection: when the same itemId is dispatched this many
 * times in a row, a console.warn is emitted to signal a potential infinite loop.
 */
const SPIN_DETECTION_THRESHOLD = 3;

/**
 * PHS-3.3: skip-reason recorded when dispatch()'s runner throws (crash,
 * timeout, stream-incomplete). Distinct from every command-tagged
 * [skip-reason:...] and the "command:no-work" fallback.
 */
export const DISPATCH_ERROR_SKIP_REASON = "dispatch:runner-error";

/**
 * SKT-2.2 — empty-queue backoff defaults. When the queue has been genuinely
 * empty for this many consecutive ticks (SHIPWRIGHT_LOOP_EMPTY_BACKOFF_ATTEMPTS),
 * runLoopTick skips all candidate collection (no GitHub calls, no task-store
 * queries) for this many ms (SHIPWRIGHT_LOOP_EMPTY_BACKOFF_MS) before trying
 * again — see the env-var read helpers below.
 */
const DEFAULT_EMPTY_BACKOFF_MS = 300_000;
const DEFAULT_EMPTY_BACKOFF_ATTEMPTS = 3;

/**
 * LPF-7.2 — busy-stall safety margin. claude.ts's runner() call is bounded by
 * a 30-minute ceiling (`timeoutMs: number = 30 * 60 * 1000`), so a healthy
 * *single drain iteration* (candidate collection through one dispatch) can
 * never legitimately run past that. This threshold is set comfortably above
 * that ceiling (35 minutes) so it never fires during normal drain overlap —
 * only once an iteration has clearly hung somewhere before ever completing
 * dispatch()/runner() (e.g. a wedge in candidate collection or a runner()
 * call that itself failed to respect its own timeout), meaning it cannot
 * self-recover without a process restart. busySince is reset at the top of
 * every drain iteration (not just once at tick-start) AND again at the top of
 * every dispatch attempt (runOneAttempt), so elapsedMs never spans more than
 * one runner() call — a tick that sequentially works through many candidates,
 * or a single dev-task dispatch that auto-resumes itself up to MAX_AUTO_RESUMES
 * times, stays busy for far longer than any one runner() call, but that
 * cumulative time is healthy, not stall evidence. Once busySince's elapsed
 * time exceeds this, the busy-skip log below escalates from console.warn to
 * console.error.
 */
const BUSY_STALL_THRESHOLD_MS = 35 * 60 * 1000;

/**
 * Parses a positive-integer env var, falling back to `fallback` when unset or
 * not a valid positive integer. Read fresh on every call (never cached) so an
 * operator's env change takes effect on the very next tick without a restart
 * — see check-dev-task.ts's buildProductionDeps for the same
 * read-process.env-inside-a-function pattern.
 */
function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Cooldown window (CBD-2.2) for re-dispatching a PR whose preclaimed
 * commitSha hasn't changed since its last dispatch. Set below the documented
 * ~30min dev-task/loop cadence so a genuinely new cron tick still gets
 * through, while re-fires far tighter than that cadence (the observed bug —
 * a PR was re-dispatched every 2-5 minutes for hours on an unchanged commit)
 * are suppressed.
 *
 * The cooldown key is phase-scoped (`${pr.id}:${phase}`, see
 * isPrDispatchSuppressed) — each phase tracks its own redispatch history
 * independently. PH-1.3 previously assumed a bare-pr.id key shared across
 * review/patch/deploy was safe because review's cooldown was believed inert
 * in practice (see below); that assumption is disproven (confirmed live,
 * PRC-1.1): a real review dispatch on an unchanged commit was suppressing an
 * unrelated, independent patch need (e.g. resolving a live merge conflict)
 * for the full cooldown window.
 *
 * Per-phase load-bearing status:
 * - **review**: redundant-but-harmless in isolation. check-review.ts has its
 *   own commitSha+reviewState dedup, plus RVD-1.1's live-GitHub dedup — an
 *   unchanged-commit PR never even reaches getReviewCandidates()'s output, so
 *   this cooldown rarely gets a chance to fire for review in practice. Kept
 *   (not removed) because it's still a legitimate backstop for review's own
 *   phase.
 * - **patch**: load-bearing. check-patch.ts re-evaluates live state every
 *   tick and keeps no "already attempted this commit" memory of its own — a
 *   non-blocking failed/no-op cycle would redispatch every tick without this
 *   cooldown.
 * - **deploy**: partially load-bearing. The 30-minute pipeline-timeout path
 *   sets `blocked` for its own designed failure mode and doesn't need this
 *   cooldown, but a transient/unhandled failure outside that path has the
 *   same unbounded-redispatch exposure as patch.
 */
const PR_REDISPATCH_COOLDOWN_MS = 25 * 60 * 1000;

/**
 * Debounce window for onProgress → cronRunReporter.recordProgress pushes
 * within a single dispatch. A chatty run can fire onProgress on every
 * assistant turn; without this, each turn would PATCH the admin API,
 * hammering it on long multi-turn runs. A push that fires less than this
 * many ms after the last one that actually went through is skipped — the
 * next progress snapshot (or the final completeRun) carries the up-to-date
 * totals instead.
 */
const PROGRESS_PUSH_DEBOUNCE_MS = 5000;

/**
 * DTW-1.3 — how many times a single dispatch may auto-resume its own session
 * before giving up and returning to the drain loop. A cron-dispatched session
 * that ends with its work item still claimed by this agent (e.g. it hit a long
 * wait and its process exited) used to sit until the task-store's
 * StaleClaimReaper released the claim ~65 minutes later, and the next tick
 * then re-dispatched it with ZERO memory of prior progress. Resuming
 * immediately with the same sessionKey keeps the prior session's context.
 *
 * Capped so a persistently-stuck item can't spin forever: at most 4 runner()
 * calls per dispatch (1 initial + 3 resumes), each its own AgentCronRun row
 * tagged with the same itemId. On exhausting the cap the item is simply left
 * claimed — exactly today's behavior — for the reaper + human triage.
 *
 * Shared by both resume loops in dispatchItem: dev-task's (DTW-1.3/DTR-1.1)
 * and, since CRT-1.3, review/patch/deploy's.
 */
const MAX_AUTO_RESUMES = 3;

/**
 * DTR-1.1 — dev-task statuses that mean the task has left active dev-task
 * work. The session key for a task in one of these statuses is safe to
 * clear: no later dispatch will ever want to resume it, because dev-task's
 * own claim/dependency/reality-check gates (see dev-task.md) refuse to
 * re-enter a task once it's reached one of these.
 */
const TERMINAL_DEV_TASK_STATUSES = new Set([
  "pr_open",
  "blocked",
  "cancelled",
  "done",
]);

/**
 * Builds the phase-scoped cooldown key (PRC-1.1) shared by
 * isPrDispatchSuppressed's lookup and the dispatch loop's lastPrDispatch
 * write — `${pr.id}:${phase}` rather than bare pr.id, so each phase's
 * redispatch history is tracked independently and a dispatch in one phase
 * can't suppress an unrelated phase's need to act on the same PR.
 */
function prDispatchCooldownKey(pr: WorkPrCandidate): string {
  return `${pr.id}:${pr.phase ?? "review"}`;
}

/**
 * A PR item should be excluded from this tick's candidate pool when it was
 * already dispatched at this exact commitSha, in this same phase, within the
 * cooldown window — nothing new to act on since the last dispatch. (A
 * hitl:true PR is excluded further upstream, at the candidate-collector
 * level — see check-patch.ts and check-review.ts — so it never reaches this
 * function in the first place.)
 *
 * `lastDispatch` is keyed by prDispatchCooldownKey(pr) and persists across
 * ticks (closure state, like lastDispatchedItemId below) so the suppression
 * holds across many cron ticks, not just within one drain.
 */
function isPrDispatchSuppressed(
  pr: WorkPrCandidate,
  lastDispatch: ReadonlyMap<
    string,
    { commitSha: string; dispatchedAt: number }
  >,
  nowMs: number,
): boolean {
  const last = lastDispatch.get(prDispatchCooldownKey(pr));
  if (!last || last.commitSha !== pr.commitSha) return false;

  return nowMs - last.dispatchedAt < PR_REDISPATCH_COOLDOWN_MS;
}

/**
 * Format the pre-claim marker (CBD-1.3) appended to a dispatched PR command
 * string on a successful pre-claim. Bracket-delimited to match the codebase's
 * existing marker convention (see markers.ts's [silent]/[upload:...]) — but
 * carried on the *input* dispatched command rather than an *output* response.
 * A future downstream skill (CBD-1.4/1.5/1.6) parses it to recognize a PR the
 * loop already claimed, so it trusts the claim instead of re-claiming and
 * 409ing against itself.
 *
 * recordId is a CUID and commitSha a git SHA — both plain alphanumeric with no
 * colons — so splitting on ":" is unambiguous for that future parser.
 */
export function formatPreClaimMarker(
  recordId: string,
  commitSha: string,
): string {
  return `[preclaim:${recordId}:${commitSha}]`;
}

// ─── Factory ────────────────────────────────────────────────────────────────

/**
 * Build the shipwright-loop tick handler. The returned closure is meant to be
 * constructed once and reused across every cron tick, so its internal busy
 * flag persists between invocations.
 */
export function createLoopOrchestrator(
  deps: LoopOrchestratorDeps,
): (jobs: CronJobLike[]) => Promise<void> {
  const {
    getDevTaskCandidates,
    getPlanCandidates,
    getReviewCandidates,
    getPatchCandidates,
    getDeployCandidates,
    claimTask,
    claimPr,
    recordSkip,
    resetSkip,
    getTaskState,
    agentId,
    heartbeatTask,
    getPrState,
    getPrProgress,
    patchOutcome,
    heartbeatPr,
    releasePr,
    clearSessionKey,
    runner,
    cronRunReporter,
    workQueueReporter,
    loopCronId,
    clock = SystemClock(),
    contextStamp,
    sentryClient,
    random = Math.random,
    commandExists = pluginCommandExists,
  } = deps;

  // Persisted across ticks: guards against a second concurrent drain.
  let busy = false;
  // LPF-7.1: set (via the injected clock) whenever `busy` flips to true and
  // cleared everywhere `busy` resets to false (the backoff-skip early
  // return and the tick's `finally` block) — lets the busy-skip warn below
  // report how long the in-flight tick has been draining, with no stale
  // leakage into a later tick.
  let busySince: Date | null = null;

  // Spin detection state: tracks the last dispatched itemId and consecutive
  // repeat count to warn when the same item is dispatched repeatedly.
  let lastDispatchedItemId: string | null = null;
  let consecutiveDispatchCount = 0;

  // SKT-2.2 empty-queue backoff state: tracks how many consecutive ticks in a
  // row had zero candidates on their first drain iteration ("empty ticks" —
  // see runLoopTick's doc comment on the distinction between an empty tick
  // and a tick that dispatches then later drains dry). Same in-memory-only,
  // resets-on-restart pattern as the spin-detection variables above — no
  // persistence needed since a process restart naturally clears any backoff.
  let consecutiveEmptyTicks = 0;
  let backoffUntil: Date | null = null;

  // Redispatch-cooldown state (CBD-2.2): tracks the commitSha and timestamp
  // of each PR item's most recent dispatch, persisted across ticks — see
  // isPrDispatchSuppressed above.
  const lastPrDispatch = new Map<
    string,
    { commitSha: string; dispatchedAt: number }
  >();

  /**
   * PSL-2.1: reads the PR fields that change when a review/patch phase makes
   * progress. Returns null (fail closed) when getPrProgress isn't wired, the
   * PR is missing, or the read rejects.
   */
  type PrProgressSnapshot = {
    reviewState: string | null;
    reviewedCommitSha: string | null;
    commitSha: string | null;
  };
  async function snapshotPrProgress(
    prId: string,
  ): Promise<PrProgressSnapshot | null> {
    if (!getPrProgress) return null;
    try {
      const pr = await getPrProgress(prId);
      if (!pr) return null;
      return {
        reviewState: pr.reviewState ?? null,
        reviewedCommitSha: pr.reviewedCommitSha ?? null,
        commitSha: pr.commitSha ?? null,
      };
    } catch (err) {
      console.warn(
        `[loop-orchestrator] PR progress snapshot failed for ${prId}: ${String(err)} — treating as no progress`,
      );
      return null;
    }
  }

  /**
   * PSL-2.1: did the PR record move in a way that reflects real work? The
   * "before" snapshot is taken after the pre-claim (claimPr has already set
   * reviewState=in_progress), so a bare reviewState change is not enough: a
   * release() back to `pending` (stale-head abort, failed post) is a retreat,
   * not progress. A new commitSha/reviewedCommitSha, or a reviewState change
   * to anything other than `pending`, counts.
   */
  function prMadeProgress(
    before: PrProgressSnapshot,
    after: PrProgressSnapshot,
  ): boolean {
    return (
      before.commitSha !== after.commitSha ||
      before.reviewedCommitSha !== after.reviewedCommitSha ||
      (before.reviewState !== after.reviewState &&
        after.reviewState !== "pending")
    );
  }

  /**
   * SKT-2.1 guard around recordSkip/resetSkip: both are documented
   * never-throwing (the production client swallows fetch errors and non-ok
   * responses internally, matching HttpCronRunReporter.patchRun's pattern),
   * but a task-store error at this call site must not abort or delay the
   * dispatch loop regardless — so a rejection is caught and warned rather
   * than left to propagate out of dispatch() and abort the tick.
   */
  async function callSkipTracker(
    label: "recordSkip" | "resetSkip",
    fn: () => Promise<void>,
  ): Promise<void> {
    try {
      await fn();
    } catch (err) {
      console.warn(
        `${label} rejected — swallowing: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Dispatch one selected phase's one-shot command (with the winning item's
   * id appended, e.g. "/shipwright:review acme/x#1") and report its own
   * tagged run. A command that returns a trailing [silent] marker signals
   * "nothing to do once it actually ran" — the precheck contract's narrow
   * skip case — so it is recorded via skipRun rather than completeRun. Every
   * other outcome completes normally.
   *
   * `phaseId` is the dispatched phase's child AgentCronJob id (resolved via
   * resolveLoopPhaseJobId), threaded through to the reporter so every
   * AgentCronRun row records which phase cron it was dispatched by (LPC-3.1).
   * Null when the agent hasn't reconciled that phase's child row yet — the
   * reporter is called with phaseId ?? undefined in that case, same as an
   * unset value.
   *
   * `itemType`/`itemId` identify the winning work item this dispatch was sent
   * against ("task" | "pr", plus its id) — threaded through to the reporter so
   * every AgentCronRun row records which task or PR a given cron run actually
   * touched (WLS-2.2).
   *
   * `preClaimMarker` (CBD-1.3), when present, is appended to the command string
   * after the item id (e.g. "/shipwright:review acme/x#1 [preclaim:<id>:<sha>]")
   * so the downstream PR skill can recognize the loop already claimed this PR
   * and trust that claim instead of re-claiming. Only ever set for PR items.
   *
   * `recordId` (SKT-2.1) is the task-store record id passed to
   * recordSkip/resetSkip — deliberately NOT the same value as `itemId` for PR
   * items. `itemId` stays "org/repo#123" (cron-run-reporter tagging only);
   * `recordId` is the task's plain id for a task item, or the PullRequest DB
   * record's CUID (from claimPr's result) for a PR item. See the recordSkip
   * doc comment on LoopOrchestratorDeps for the full rationale.
   *
   * LO-1.1: the entire body below runs inside `sentryClient.withScope(...)`
   * (see the thin `dispatch` wrapper below this function) — a Sentry scope
   * forked just for this call and tagged `item_type`/`item_id` for the item
   * being dispatched. Any Sentry event captured while this function is
   * in flight (its own captureException call in the catch block below, or a
   * console.warn/console.error forwarded as a Sentry Log by
   * consoleLoggingIntegration) carries those tags — see LoopOrchestratorDeps's
   * sentryClient doc comment for the full rationale and why a fork (not a
   * bare Sentry.setTag() global mutation) is required for correctness under
   * concurrent/sequential dispatches.
   */
  /**
   * SLS-1.1: the pre-dispatch live patch-state snapshot for an in-flight patch
   * PR dispatch, keyed by itemId. Set by dispatch() and read by the `[silent]`
   * branch in dispatchItem(); always deleted when the dispatch exits.
   */
  const patchLiveBefore = new Map<
    string,
    { before: PatchStateSnapshot | null; prAuthor?: string }
  >();
  /**
   * PRL-1.3: itemIds of patch PR dispatches that ended `[silent]`, recorded by
   * dispatchItem() and consumed (deleted) by dispatch() to decide whether a
   * still-held pre-claim needs releasing.
   */
  const silentPatchItems = new Set<string>();

  async function dispatchItem(
    phase: LoopPhase,
    phaseId: string | null,
    itemType: "task" | "pr",
    itemId: string,
    recordId: string,
    preClaimMarker?: string,
    commandArgs?: string,
  ): Promise<void> {
    // `commandArgs` (PDR-4.1) is the argument string appended after the
    // phase's slash command. It defaults to the bare `itemId` — today's
    // behavior for every phase — and is only overridden by the plan phase,
    // whose command contract is `{repo} {session} --autonomous {task-id}`
    // rather than a bare id. `itemId` itself stays the plain task/PR id
    // everywhere else (cron-run-reporter tagging, spin detection,
    // recordSkip/resetSkip dedup) regardless.
    const args = commandArgs ?? itemId;
    // DTA-1.3: drawn once per dispatch (not per resume attempt) so every
    // attempt of one run uses the same variant, and recorded on the run row.
    const { command: phaseCommand, variant: commandVariant } =
      resolvePhaseCommand(phase, random, commandExists);
    const command = preClaimMarker
      ? `${phaseCommand} ${args} ${preClaimMarker}`
      : `${phaseCommand} ${args}`;
    const message = formatCronMessage(loopCronId, command);

    // DTW-1.3/DTR-1.1/CRT-1.3: a session identity, so a follow-up attempt
    // continues the same Claude session instead of starting cold. The
    // underlying runner persists session ids keyed by this value and builds
    // `-r <id>` itself on the next call with the same key, so nothing here has
    // to carry the id around.
    //
    // Two deliberately DIFFERENT mechanisms live behind this one variable, and
    // the resume loop below has a matching block for each:
    //
    //   dev-task (DTR-1.1) — `dev-task:{itemId}`, a STABLE key with no
    //     per-dispatch nonce, so it survives this dispatch's exit and a later,
    //     fully separate dispatch of the same still-in_progress task (the next
    //     cron tick, a StaleClaimReaper reclaim, an explicit human re-run)
    //     resumes this exact session instead of starting cold with zero memory
    //     of substantial prior progress. Safe cross-dispatch reuse depends on
    //     when the key is cleared: the dev-task block's `finally` clears it
    //     only once a FRESH getTaskState check confirms the task reached a
    //     terminal dev-task-work status (TERMINAL_DEV_TASK_STATUSES), never
    //     unconditionally on exit — so a still-in_progress task keeps its key
    //     while a task that reached e.g. `pr_open` drops it, and a later,
    //     unrelated task reusing this exact `itemId` (unlikely, but not
    //     impossible after task-store id reuse) never inherits a dead session.
    //
    //   review/patch/deploy (CRT-1.3) — `{phase}:{itemId}:{randomUUID()}`, a
    //     PER-DISPATCH nonce: exactly the shape dev-task used before DTR-1.1
    //     dropped its own. These phases opt into the same-session resume loop
    //     (an attempt that exits early mid-review/patch/deploy is just as
    //     wasteful to redo cold) but deliberately NOT into cross-dispatch
    //     persistence — they re-validate live GitHub/task-store state at the
    //     top of every dispatch, so a reclaim, or simply this dispatch ending,
    //     must mean a cold start next time. The nonce guarantees that on its
    //     own, and the matching block clears the key unconditionally on exit.
    //
    //   plan — still undefined. Out of CRT-1.3's scope; a plan-session
    //     dispatch always starts fresh.
    //
    // sessions.ts's store is file-backed with a 7-day TTL and no lazy
    // eviction on write, only on `get()` — index.ts's periodic
    // `sessions.prune()` remains the backstop for whatever an abrupt process
    // kill leaves behind before either finally block ever runs.
    const sessionKey =
      phase === "dev-task"
        ? `dev-task:${itemId}`
        : phase === "review" || phase === "patch" || phase === "deploy"
          ? `${phase}:${itemId}:${randomUUID()}`
          : undefined;

    /**
     * One dispatch attempt: its own createRun → runner() → terminal
     * completeRun/skipRun pair, all tagged with this dispatch's
     * phaseId/itemType/itemId. Resolves "silent" when the command reported
     * nothing to do, "completed" otherwise; a runner failure is reported as a
     * failed run and RETHROWN, exactly as before DTW-1.3 (the resume loop
     * below must not swallow it).
     */
    async function runOneAttempt(): Promise<"completed" | "silent"> {
      // LPF-7.2 + DTW-1.3: re-baseline the busy-stall window on EVERY attempt,
      // not just once per drain iteration. BUSY_STALL_THRESHOLD_MS assumes the
      // measured window is a single runner() call, bounded by claude.ts's
      // 30-minute ceiling. The auto-resume loop below makes one dev-task
      // dispatch issue up to 1 + MAX_AUTO_RESUMES sequential runner() calls
      // (~2 hours of legitimate work) inside one drain iteration, so measuring
      // from the iteration's start would let a concurrent tick's busy check
      // cross the threshold and emit a false, Sentry-eligible "stuck/wedged"
      // console.error on a perfectly healthy resume loop. Resetting here keeps
      // elapsedMs meaning "time since the current runner() call started" — the
      // one quantity the 35-minute margin is actually calibrated against — so
      // the stall window stays as tight as it was pre-DTW-1.3 rather than
      // being widened 4x. Applied to every phase (not just dev-task): a
      // single-attempt phase is simply the n=1 case, and the iteration-level
      // reset above still covers a wedge in candidate collection or pre-claim,
      // which happens before this point.
      busySince = clock.now();

      const runId = await cronRunReporter.createRun(
        loopCronId,
        clock.now(),
        phaseId ?? undefined,
        itemType,
        itemId,
        commandVariant,
      );

      // DTW-1.3/CES-1.2: push the session id into the cron-run row the moment
      // it's known — before the run reaches any terminal state — so an operator
      // can find/resume the session manually even if this attempt never
      // completes. Wired for every phase (all five: dev-task, plan, review,
      // patch, deploy), independent of sessionKey. The sessionKey itself remains
      // undefined for plan by design (plan doesn't resume), but the session id
      // capture is decoupled from that — plan still pushes it for observability.
      // Fire-and-forget, same contract as recordProgress below.
      const onEarlySessionId: EarlySessionIdCallback = (sid) => {
        cronRunReporter.recordSessionId(loopCronId, runId, sid).catch((err) => {
          console.warn(
            `[loop-orchestrator] recordSessionId failed for run ${runId}: ${String(err)} — swallowing`,
          );
        });
      };

      // Progress push (CSU-3.1): fired as each new assistant turn completes so
      // token totals survive an agent-process OOM/deploy-kill mid-run, not just
      // a clean completion. Debounced against PROGRESS_PUSH_DEBOUNCE_MS (via the
      // injected clock, not Date.now(), to stay deterministic under
      // FixedClock) to avoid hammering the admin API on a chatty multi-turn
      // run. recordProgress is fire-and-forget per its own doc comment — a
      // rejection must not crash dispatch(), so it's awaited with the
      // rejection caught and swallowed (a transient admin-API blip here isn't
      // worth losing the dispatch over).
      let lastProgressPushAt: number | undefined;
      const onProgress: ProgressCallback = (modelUsage) => {
        const { modelBreakdown } = buildTokenPayload(undefined, modelUsage);
        if (!modelBreakdown || modelBreakdown.length === 0) return;

        const now = clock.now();
        const nowMs = now.getTime();
        if (
          lastProgressPushAt !== undefined &&
          nowMs - lastProgressPushAt < PROGRESS_PUSH_DEBOUNCE_MS
        ) {
          return;
        }
        lastProgressPushAt = nowMs;

        cronRunReporter
          .recordProgress(loopCronId, runId, modelBreakdown, now)
          .catch((err) => {
            console.warn(
              `[loop-orchestrator] recordProgress failed for run ${runId}: ${String(err)} — swallowing`,
            );
          });
      };

      // PSL-2.1: for a PR item, snapshot the progress-bearing PR fields
      // before dispatch (this runs after the pre-claim, so the baseline is
      // the claimed in_progress state — see prMadeProgress) so a [silent]
      // ending can be told apart from a no-op — a review/patch that did real
      // work then ended [silent] must not advance the skip streak. Null on a
      // task item, a missing dep, or a read failure (fail closed: behaves
      // exactly as before).
      const prProgressBefore =
        itemType === "pr" ? await snapshotPrProgress(recordId) : null;

      // Stamp the always-loaded context once per dispatch, before the run,
      // so a mid-run workspace edit can't make the fingerprint disagree with
      // what this run's first turn loaded. Fail-soft: unstamped on error.
      let stamp: RunContextStamp | undefined;
      try {
        stamp = contextStamp?.() ?? undefined;
      } catch (err) {
        console.warn(
          `[loop-orchestrator] context stamp failed for run ${runId}: ${String(err)} — running unstamped`,
        );
      }
      const extras = (t: RunTelemetry | undefined): TokenPayloadExtras => ({
        telemetry: t,
        contextStamp: stamp,
      });

      let runResult: ClaudeRunResult;
      try {
        runResult = await runner(
          message,
          onProgress,
          sessionKey,
          onEarlySessionId,
        );
        if (runResult.streamIncomplete) {
          // Clean process exit, but the stream never emitted a terminal
          // `result` event — treat this the same as a genuine failure rather
          // than letting an empty response masquerade as a completed dispatch
          // (see CSU-1.1 review).
          throw new ClaudeRunError(
            "claude stream ended without a terminal result event",
            undefined,
            "stream incomplete — no terminal result event",
            runResult.sessionId,
            runResult.modelUsage,
            runResult.telemetry,
          );
        }
      } catch (err) {
        // Partial-usage-on-failure (CSU-3.1): a ClaudeTimeoutError carries
        // whatever per-model usage was accumulated before the process was
        // killed — attach it as modelBreakdown so a timed-out run's tokens
        // aren't dropped entirely (the direct fix for "unknown model" on
        // timed-out shipwright-loop runs). Scoped narrowly to
        // ClaudeTimeoutError's `partialModelUsage` field, not ClaudeRunError's
        // differently-named `modelUsage` field — any other error (including
        // ClaudeRunError) falls back to { error } only, unchanged.
        const partialTelemetry =
          err instanceof ClaudeTimeoutError || err instanceof ClaudeRunError
            ? err.partialTelemetry
            : undefined;
        const tokenPayload =
          err instanceof ClaudeTimeoutError
            ? buildTokenPayload(
                undefined,
                err.partialModelUsage,
                extras(partialTelemetry),
              )
            : partialTelemetry !== undefined
              ? buildTokenPayload(
                  undefined,
                  undefined,
                  extras(partialTelemetry),
                )
              : undefined;

        // CSI-2.3: mirror cron-handler.ts's (CSI-2.2) session-id extraction —
        // only ClaudeRunError/ClaudeTimeoutError carry a sessionId field; any
        // other thrown error has none.
        const errSessionId =
          err instanceof ClaudeRunError || err instanceof ClaudeTimeoutError
            ? err.sessionId
            : undefined;

        await cronRunReporter.completeRun(
          loopCronId,
          runId,
          clock.now(),
          "failed",
          {
            error: err instanceof Error ? err.message : String(err),
            ...tokenPayload,
            sessionId: errSessionId,
          },
          phaseId ?? undefined,
          itemType,
          itemId,
        );
        markCronRunFailureReported(err);
        // LO-1.1: captured while the sentryClient.withScope fork set up by the
        // dispatch() wrapper below is still active — item_type/item_id tags
        // are attached to this Issue automatically. Previously a per-item
        // dispatch failure was only ever surfaced as a console.warn at the
        // runLoopTick call site (never reaching reportCronFailure's
        // captureException, since that catch swallows-and-continues rather
        // than rethrowing out of the tick) — this is a genuinely new Sentry
        // Issue capture point, not a duplicate of cron-failure-reporter.ts's.
        reportClaudeError(sentryClient, err);
        // PHS-3.3: a runner error (crash, timeout, throw) is a skip-streak
        // input too, so a deterministically crashing item hits the existing
        // SKIP_BLOCK_THRESHOLD auto-block instead of only tripping spin
        // detection. A single stable reason keeps the same-reason streak
        // semantics: repeated crashes advance it, any other reason resets it,
        // and a later successful run clears it via the resetSkip path below.
        await callSkipTracker("recordSkip", () =>
          recordSkip(itemType, recordId, DISPATCH_ERROR_SKIP_REASON),
        );
        throw err;
      }

      const { markers } = parseMarkers(runResult.result);
      const isSilent = markers.some((m) => m.type === "silent");

      if (isSilent) {
        // DBV-1.1: a command can tag its own silent dispatch with a specific,
        // machine-readable [skip-reason:text] marker (e.g. deploy's Step 2b
        // bundle-completeness gate) so the AgentCronRun.skipReason field
        // records exactly why nothing happened, instead of the generic
        // "command:no-work" literal. Falls back to that literal when the
        // command didn't tag a reason, leaving every other command's behavior
        // unchanged.
        const skipReasonMarker = markers.find((m) => m.type === "skip-reason");
        const skipReason =
          skipReasonMarker?.type === "skip-reason"
            ? skipReasonMarker.reason
            : "command:no-work";

        // The command was dispatched (it was selected), but found nothing to do
        // once it ran — one row, marked skipped. runner(message) already ran
        // and may have spent real tokens before reporting nothing-to-do, so
        // (unlike the other skip paths, e.g. a 409 pre-claim conflict) forward
        // that spend via buildTokenPayload rather than dropping it (see the
        // file's skipRun opts doc comment).
        await cronRunReporter.skipRun(
          loopCronId,
          runId,
          clock.now(),
          skipReason,
          {
            ...buildTokenPayload(
              runResult.usage,
              runResult.modelUsage,
              extras(runResult.telemetry),
            ),
            sessionId: runResult.sessionId,
          },
          phaseId ?? undefined,
          itemType,
          itemId,
        );
        // SRB-1.1: every skip-reason category now counts toward the
        // task-store's reason-aware skip-streak (recordSkip(id, reason)) —
        // the former isDeferredCategory/isSameBranchSiblingBusy exemption
        // (STD-1.1/BBE-1.2) is removed. That exemption existed because
        // counting a legitimate defer toward SKIP_BLOCK_THRESHOLD risked a
        // false auto-block on a task that correctly kept re-deferring for
        // different reasons each tick. Now that recordSkip() only advances
        // the streak when the *same* reason repeats (resetting to 1 on any
        // change, including the very first skip), a legitimate defer that
        // keeps changing reason never crosses the threshold on its own —
        // only a genuinely stuck task repeating the identical reason three
        // times in a row does, which is exactly the case that should
        // auto-block (see SZV-BRT-3.2/FTR-1.4, which this fixes: a task
        // self-deferring on the same unmet hidden requirement every tick,
        // invisible to skipCount and therefore to /unblock). `skipReason`
        // (parsed above, or the "command:no-work" fallback) is forwarded
        // as-is — no category filtering.
        // PSL-2.1: the run is still reported as skipped above, but if the PR
        // record moved during the dispatch it did real work — clear the streak
        // instead of advancing it. A run that tagged an explicit
        // [skip-reason:...] is a deliberate defer (e.g. review's
        // unresolved-human-feedback / already-reviewed-at-head defers, which
        // PATCH reviewState/reviewedCommitSha away from the claimed
        // in_progress baseline) and must keep advancing the same-reason
        // streak (SRB-1.1), so it never takes the reset branch.
        // SLS-1.1: patch dispatches decide from the live-state outcome
        // (patch-outcome-check) instead of the PR record fields — a push via
        // `gh pr update-branch` moves the head without writing any of them.
        // changed/settled resets; unchanged records. When the live state is
        // unreadable, fall back to the record-field check above.
        // SLS-1.2: a no-op-at-dispatch marker doesn't veto the live-state
        // check — a patch run whose only work was `gh pr update-branch` still
        // emits [skip-reason:patch:deferred:no-op-at-dispatch:{pr}] even
        // though the head moved. Unchanged live state still records the
        // marker's reason via recordSkip below. Other markers (e.g.
        // waiting-on-author) remain deliberate defers.
        const patchLive = patchLiveBefore.get(itemId);
        const markerAllowsLiveState =
          !skipReasonMarker ||
          (skipReasonMarker.type === "skip-reason" &&
            skipReasonMarker.reason.startsWith(
              "patch:deferred:no-op-at-dispatch",
            ));
        const patchLiveAfter =
          patchLive && markerAllowsLiveState && patchOutcome
            ? await patchOutcome
                .snapshot(itemId, patchLive.prAuthor)
                .catch(() => null)
            : null;
        const prProgressAfter =
          prProgressBefore && !skipReasonMarker
            ? await snapshotPrProgress(recordId)
            : null;
        const madeProgress =
          patchLive?.before && patchLiveAfter
            ? evaluatePatchOutcome(patchLive.before, patchLiveAfter).kind !==
              "escalated"
            : prProgressBefore &&
              prProgressAfter &&
              prMadeProgress(prProgressBefore, prProgressAfter);
        if (madeProgress) {
          await callSkipTracker("resetSkip", () =>
            resetSkip(itemType, recordId),
          );
        } else {
          await callSkipTracker("recordSkip", () =>
            recordSkip(itemType, recordId, skipReason),
          );
        }
        if (phase === "patch" && itemType === "pr")
          silentPatchItems.add(itemId);
        return "silent";
      }

      await cronRunReporter.completeRun(
        loopCronId,
        runId,
        clock.now(),
        "completed",
        {
          ...buildTokenPayload(
            runResult.usage,
            runResult.modelUsage,
            extras(runResult.telemetry),
          ),
          sessionId: runResult.sessionId,
        },
        phaseId ?? undefined,
        itemType,
        itemId,
      );
      // SKT-2.1: real progress clears any prior skip streak.
      await callSkipTracker("resetSkip", () => resetSkip(itemType, recordId));
      return "completed";
    }

    // DTW-1.3 auto-resume loop — the dev-task (task-item) mechanism; the PR
    // phases have their own, deliberately separate block below (CRT-1.3).
    // After an attempt finishes,
    // re-read the task's LIVE state: still `in_progress` AND still claimed by
    // this agent means the session ended without finishing the task (the
    // ScheduleWakeup/long-wait case), so resume it right now with the same
    // sessionKey instead of leaving the claim to go stale for ~65 minutes and
    // burning a cold session on the next tick. Capped at MAX_AUTO_RESUMES; a
    // "silent" outcome or a thrown failure ends the loop (the throw propagates
    // out of dispatchItem unchanged).
    if (phase === "dev-task" && sessionKey) {
      try {
        if ((await runOneAttempt()) !== "completed") return;
        let resumeAttempt = 0;
        while (resumeAttempt < MAX_AUTO_RESUMES) {
          let liveState: Awaited<ReturnType<typeof getTaskState>>;
          try {
            liveState = await getTaskState(itemId);
          } catch (err) {
            // Resuming is an optimization — a task-store blip here must not
            // turn an otherwise-successful dispatch into a failure. Fall back
            // to today's behavior (stop, let the reaper + next tick handle it).
            console.warn(
              `[loop-orchestrator] getTaskState failed for ${itemId}: ${String(err)} — not resuming`,
            );
            return;
          }
          if (liveState?.status !== "in_progress") return;
          // Ownership gate: `in_progress` alone doesn't prove the claim is
          // still ours. If this dispatch's claim lapsed and was reaped, another
          // claimant can have the task back at `in_progress` by now — resuming
          // a stale session against it would have two sessions working one
          // task. Skipped only when no agentId is configured (see the dep's
          // doc comment).
          if (agentId && liveState.claimedBy !== agentId) {
            console.warn(
              `[loop-orchestrator] ${itemId} is in_progress but claimed by ${liveState.claimedBy ?? "nobody"} (not ${agentId}) — not resuming`,
            );
            return;
          }
          // Claim-TTL refresh: DEFAULT_CLAIM_TTL_MS is sized for exactly one
          // Claude session, but this loop can hold one claim across up to
          // 1 + MAX_AUTO_RESUMES of them. Renew it here so the attempt below
          // starts with a full TTL window — otherwise an attempt that exited
          // before its in-session heartbeat step leaves a claim that the
          // StaleClaimReaper can release mid-dispatch, letting a sibling agent
          // start a second, cold session on the same task/branch while this
          // attempt is still running. Ordered AFTER the ownership gate so a
          // claim that already belongs to someone else is never refreshed on
          // their behalf. A failure means the claim can't be proven fresh, so
          // stop resuming rather than run an attempt that may be racing a reap
          // — the dispatch itself stays successful.
          if (heartbeatTask) {
            try {
              await heartbeatTask(itemId);
            } catch (err) {
              console.warn(
                `[loop-orchestrator] heartbeatTask failed for ${itemId}: ${String(err)} — not resuming`,
              );
              return;
            }
          }
          resumeAttempt += 1;
          if ((await runOneAttempt()) !== "completed") return;
        }
        return;
      } finally {
        // DTR-1.1: clear the session key ONLY once the task has actually left
        // active dev-task work. A stable (non-nonce) key must otherwise survive
        // this dispatch's exit so a LATER, separate dispatch of the same task
        // (next cron tick, a StaleClaimReaper reclaim, an explicit re-run) can
        // resume this exact Claude session instead of starting cold — that's the
        // whole point of DTR-1.1. Re-check FRESH state here rather than reusing
        // whatever the resume loop last observed: this finally runs on every exit
        // path (silent, completed, resume-cap exhausted, thrown failure), several
        // of which never call getTaskState at all.
        let isTerminal = false;
        try {
          const finalState = await getTaskState(itemId);
          isTerminal = finalState
            ? TERMINAL_DEV_TASK_STATUSES.has(finalState.status)
            : false;
        } catch (err) {
          console.warn(
            `[loop-orchestrator] getTaskState failed while checking final status for ${itemId}: ${String(err)} — not clearing sessionKey`,
          );
        }
        if (isTerminal && clearSessionKey) {
          try {
            await clearSessionKey(sessionKey);
          } catch (err) {
            console.warn(
              `[loop-orchestrator] clearSessionKey failed for ${sessionKey}: ${String(err)} — swallowing`,
            );
          }
        }
      }
    }

    // CRT-1.3 auto-resume loop — the PR phases (review/patch/deploy). Same
    // shape and same MAX_AUTO_RESUMES cap as the dev-task block above, but a
    // deliberately SEPARATE block rather than a widened one, because the two
    // mechanisms differ in both halves that matter:
    //
    //   - Ownership: a PR item has no `in_progress`-equivalent status to gate
    //     on — every real PR completion path (review posted, patch pushed,
    //     deploy merged/promoted, an explicit release) already nulls
    //     `claimedBy` — so `claimedBy` carries both halves of dev-task's
    //     status-then-owner check at once: "still claimed at all" is the
    //     always-on floor (dev-task's status check), and "claimed by ME" is
    //     the owner match (skipped when no agentId is configured). It's also
    //     read through getPrState/heartbeatPr (`/prs/{id}`), a different
    //     task-store surface from getTaskState/heartbeatTask (`/tasks/{id}`).
    //
    //   - Cleanup: the key is cleared UNCONDITIONALLY on exit — no
    //     terminal-status re-check, because a per-dispatch nonce key has no
    //     cross-dispatch value to preserve in the first place (see the
    //     sessionKey comment above).
    //
    // Everything else matches dev-task: heartbeat AFTER the ownership gate and
    // BEFORE each resume (never refresh a claim that now belongs to a sibling
    // agent), any failure along the way stops resuming without failing the
    // dispatch, and a "silent" or thrown attempt ends the loop — the throw
    // propagating out of dispatchItem to the drain loop's per-item isolation
    // and the reaper fallback exactly as before.
    //
    // `recordId`, NOT `itemId`, is the id both PR deps take: for a PR item
    // `itemId` is the human-readable "org/repo#123" display id (command
    // routing + cron-run tagging) while `recordId` is the PullRequest DB
    // record's CUID that GET/POST /prs/{id} keys on — the same distinction the
    // recordSkip/resetSkip calls above already observe.
    if (
      (phase === "review" || phase === "patch" || phase === "deploy") &&
      sessionKey
    ) {
      try {
        if ((await runOneAttempt()) !== "completed") return;
        // Without this dep there is no way to prove the claim is still ours,
        // and resuming on faith could put two sessions on one PR/branch — so
        // don't resume at all, leaving this dispatch as the single attempt it
        // was before CRT-1.3. Checked once here rather than per iteration:
        // it's a closure-captured dep that cannot change mid-loop.
        if (!getPrState) return;
        let resumeAttempt = 0;
        while (resumeAttempt < MAX_AUTO_RESUMES) {
          let liveState: Awaited<ReturnType<typeof getPrState>>;
          try {
            liveState = await getPrState(recordId);
          } catch (err) {
            // Resuming is an optimization — a task-store blip here must not
            // turn an otherwise-successful dispatch into a failure.
            console.warn(
              `[loop-orchestrator] getPrState failed for ${recordId}: ${String(err)} — not resuming`,
            );
            return;
          }
          // The PR record is gone (404 → null): nothing left to resume against.
          if (!liveState) return;
          // Ownership gate, in two parts:
          //
          //   - The floor (`claimedBy === null`) applies ALWAYS, configured
          //     agentId or not. A null claim means the PR was released — by a
          //     clean completion, an explicit release, or the reaper — so
          //     there is nothing left for this session to resume against. This
          //     is the PR-side analog of dev-task's unconditional
          //     `status !== "in_progress"` check: without it, an agent with no
          //     SHIPWRIGHT_AGENT_ID would resume on any PR record that still
          //     exists, whoever owns it. That gap is reachable in production,
          //     not just in theory — `agentId` is read from the env var only,
          //     while entrypoint.ts also accepts an equivalent `--agent-id`
          //     CLI flag.
          //   - The owner match is skipped when no agentId is configured,
          //     which keeps such an agent on the pre-gate behavior for a claim
          //     that IS held by someone rather than silently never resuming
          //     (same fail-open stance as the dev-task gate's own `agentId &&`).
          if (
            liveState.claimedBy === null ||
            (agentId && liveState.claimedBy !== agentId)
          ) {
            console.warn(
              `[loop-orchestrator] ${recordId} is claimed by ${liveState.claimedBy ?? "nobody"}${agentId ? ` (not ${agentId})` : ""} — not resuming`,
            );
            return;
          }
          if (heartbeatPr) {
            try {
              await heartbeatPr(recordId);
            } catch (err) {
              console.warn(
                `[loop-orchestrator] heartbeatPr failed for ${recordId}: ${String(err)} — not resuming`,
              );
              return;
            }
          }
          resumeAttempt += 1;
          if ((await runOneAttempt()) !== "completed") return;
        }
        return;
      } finally {
        // Unconditional clear — unlike dev-task's DTR-1.1 stable key, these
        // three phases use a per-dispatch nonce with no cross-dispatch
        // persistence: a reclaim, or simply this dispatch ending, always means
        // a cold start next time. Runs on every exit path (silent, completed,
        // resume-cap exhausted, thrown failure); best-effort, since a stray
        // entry is harmless and sessions.prune() is the backstop anyway.
        if (clearSessionKey) {
          try {
            await clearSessionKey(sessionKey);
          } catch (err) {
            console.warn(
              `[loop-orchestrator] clearSessionKey failed for ${sessionKey}: ${String(err)} — swallowing`,
            );
          }
        }
      }
    }

    await runOneAttempt();
  }

  /**
   * LO-1.1 — thin wrapper around dispatchItem(): forks a Sentry scope (via
   * the injected sentryClient's withScope) tagged `item_type`/`item_id` for
   * the item about to be dispatched, then runs dispatchItem() entirely
   * inside that fork. A fork — not a bare `Sentry.setTag()` global mutation
   * — is required for correctness: setTag would mutate one shared scope
   * object, so two dispatch() calls (sequential across drain iterations, or
   * concurrent across cron ticks were that ever possible) would race to
   * overwrite each other's tags, mistagging whichever Sentry event fires
   * last. `sentryClient.withScope`'s AsyncLocalStorage-based propagation
   * (real @sentry/bun) keeps each fork's tags isolated and correctly
   * attributed even across the awaited chain inside dispatchItem(), while
   * never leaking into a sibling call's fork.
   *
   * Falls back to calling dispatchItem() unscoped when no sentryClient is
   * injected, or when the injected client doesn't implement `withScope`
   * (the pre-LO-1.1 ErrorCapturingClient shape, e.g. a fake that only
   * implements captureException) — identical behavior to today for every
   * existing caller/test that doesn't opt in.
   */
  async function dispatchScoped(
    phase: LoopPhase,
    phaseId: string | null,
    itemType: "task" | "pr",
    itemId: string,
    recordId: string,
    preClaimMarker?: string,
    commandArgs?: string,
  ): Promise<void> {
    if (!sentryClient?.withScope) {
      return dispatchItem(
        phase,
        phaseId,
        itemType,
        itemId,
        recordId,
        preClaimMarker,
        commandArgs,
      );
    }
    return sentryClient.withScope(async (scope) => {
      scope.setTag("item_type", itemType);
      scope.setTag("item_id", itemId);
      return dispatchItem(
        phase,
        phaseId,
        itemType,
        itemId,
        recordId,
        preClaimMarker,
        commandArgs,
      );
    });
  }

  /**
   * PHS-3.1 — wraps dispatchScoped() for patch dispatches with the state-based
   * outcome check: snapshot the PR's candidacy before, run the dispatch, and
   * on every non-throwing exit (a throw propagates unchanged and skips the
   * check, leaving it to the PHS-3.3 crash budget) recompute it. Same head + same unsettled state means the run broke the
   * "settled, changed, or escalated" invariant, so escalate the PR record
   * (blocked + specific reason) rather than let the next tick re-dispatch it.
   * Everything here is best-effort: a failed read or escalation is logged and
   * never fails the dispatch. Non-patch phases pass straight through.
   */
  async function dispatch(
    phase: LoopPhase,
    phaseId: string | null,
    itemType: "task" | "pr",
    itemId: string,
    recordId: string,
    preClaimMarker?: string,
    commandArgs?: string,
    prAuthor?: string,
  ): Promise<void> {
    if (phase !== "patch" || itemType !== "pr" || !patchOutcome) {
      return dispatchScoped(
        phase,
        phaseId,
        itemType,
        itemId,
        recordId,
        preClaimMarker,
        commandArgs,
      );
    }
    const before = await patchOutcome.snapshot(itemId, prAuthor);
    patchLiveBefore.set(itemId, { before, prAuthor });
    let completed = false;
    try {
      await dispatchScoped(
        phase,
        phaseId,
        itemType,
        itemId,
        recordId,
        preClaimMarker,
        commandArgs,
      );
      completed = true;
    } finally {
      patchLiveBefore.delete(itemId);
      const endedSilent = silentPatchItems.delete(itemId);
      try {
        // A thrown dispatch (crash/timeout) is left to the PHS-3.3 crash budget
        // (recordSkip with the error reason) — escalating here would bypass it.
        const after =
          before && completed
            ? await patchOutcome.snapshot(itemId, prAuthor)
            : null;
        if (before && after) {
          const outcome = evaluatePatchOutcome(before, after);
          if (outcome.kind === "escalated") {
            console.warn(
              `[loop-orchestrator] ${itemId}: ${outcome.reason} — escalating`,
            );
            await patchOutcome.escalate(
              recordId,
              itemId,
              outcome.reason,
              outcome.headSha,
            );
          }
        }
      } catch (err) {
        console.warn(
          `[loop-orchestrator] patch outcome check failed for ${itemId}: ${String(err)} — swallowing`,
        );
      }
      if (completed && endedSilent) await releaseHeldPatchClaim(recordId);
    }
  }

  /**
   * PRL-1.3 — after a silent patch dispatch, releases the pre-claim only if it
   * is still held by this agent (a completed run releases via /patch; a claim
   * held by a sibling is not ours to release). Best-effort: never throws.
   */
  async function releaseHeldPatchClaim(recordId: string): Promise<void> {
    if (!releasePr || !getPrState || !agentId) return;
    try {
      const live = await getPrState(recordId);
      if (live?.claimedBy !== agentId) return;
      await releasePr(recordId);
    } catch (err) {
      console.warn(
        `[loop-orchestrator] releasePr failed for ${recordId}: ${String(err)} — swallowing`,
      );
    }
  }

  return async function runLoopTick(jobs: CronJobLike[]): Promise<void> {
    // Concurrency guard: a prior tick is still draining — no-op immediately.
    // LTO-1.1: logged (before returning) so an operator staring at a silent
    // shipwright-loop gap can tell "still draining a prior tick" apart from
    // the backoff-active and genuinely-empty no-op paths below — see the
    // file's top doc comment / LTO-1.1 for why this matters.
    // LPF-7.1: console.warn (not console.log) — a tick still busy on the
    // next scheduled invocation is a stronger operator signal than a plain
    // informational skip, and the elapsed time (derived from busySince via
    // the injected clock) shows how long the current drain iteration has
    // been running.
    // LPF-7.2: busySince is reset at the top of every drain iteration (see
    // the reset inside the while loop below) and again at the top of every
    // dispatch attempt (runOneAttempt), so this elapsed time reflects only
    // the current in-flight runner() call, not the whole tick's cumulative
    // drain time — a tick sequentially working through many candidates, or a
    // dev-task dispatch auto-resuming itself up to MAX_AUTO_RESUMES times, is
    // legitimately busy far longer than any single runner() call, and
    // measuring from tick-start would misread that as a stall. Once the
    // current attempt's elapsed time exceeds BUSY_STALL_THRESHOLD_MS — well past
    // claude.ts's 30-minute runner() ceiling — it can no longer be "still
    // running normally"; it's wedged somewhere before ever completing
    // dispatch()/runner() and cannot self-recover, so escalate to
    // console.error (Sentry-eligible, matching the spin-detection warn's
    // style) instead of the routine console.warn.
    if (busy) {
      const elapsedMs = busySince
        ? clock.now().getTime() - busySince.getTime()
        : 0;
      if (elapsedMs > BUSY_STALL_THRESHOLD_MS) {
        console.error(
          `[loop-orchestrator] tick skipped: busy — a prior tick has been draining for ${elapsedMs}ms, which exceeds the ${BUSY_STALL_THRESHOLD_MS}ms safety margin — this tick appears stuck/wedged and will not self-recover without a process restart`,
        );
      } else {
        console.warn(
          `[loop-orchestrator] tick skipped: busy — a prior tick has been draining for ${elapsedMs}ms (still running)`,
        );
      }
      return;
    }
    busy = true;
    busySince = clock.now();

    // SKT-2.2 empty-queue backoff: if a prior tick's run of consecutive empty
    // ticks reached the configured threshold, skip this tick entirely — no
    // candidate collection (no GitHub calls, no task-store queries) — until
    // the backoff window elapses. Checked before anything else so a tick
    // inside the window is as cheap as possible.
    // LTO-1.1: logged (before releasing busy and returning) — distinguishable
    // from the busy-flag skip above so the two silent-no-op causes aren't
    // conflated from the outside.
    if (backoffUntil !== null && clock.now() < backoffUntil) {
      const remainingMs = backoffUntil.getTime() - clock.now().getTime();
      console.log(
        `[loop-orchestrator] tick skipped: empty-queue backoff active — ${remainingMs}ms remaining until ${backoffUntil.toISOString()}`,
      );
      busy = false;
      busySince = null;
      return;
    }

    // Read fresh every tick (never cached) so an operator's env change takes
    // effect on the very next tick without an agent restart — same pattern as
    // resolveLoopPhaseToggles's per-tick reads above.
    const emptyBackoffMs = readPositiveIntEnv(
      "SHIPWRIGHT_LOOP_EMPTY_BACKOFF_MS",
      DEFAULT_EMPTY_BACKOFF_MS,
    );
    const emptyBackoffAttempts = readPositiveIntEnv(
      "SHIPWRIGHT_LOOP_EMPTY_BACKOFF_ATTEMPTS",
      DEFAULT_EMPTY_BACKOFF_ATTEMPTS,
    );
    // Set whenever this tick's collected candidates (tasks + PRs) are ever
    // nonzero on any drain iteration — used after the loop exits to decide
    // whether this was an "empty tick" for backoff-counting purposes.
    // Deliberately tracks candidate *presence*, not dispatch success: a tick
    // that collects real candidates but loses every claim race to a sibling
    // replica (409 conflict or a thrown 5xx pre-claim, both a few lines
    // below) still saw a non-empty queue and must not count as empty, even
    // though nothing got dispatched. Matches AC #1's "consecutive ticks that
    // collect zero candidates" — collection, not dispatch, is what backoff
    // is measuring.
    let candidatesSeenThisTick = false;

    // Per-tick guard (CBD-2.1): task ids whose pre-claim threw (e.g. a 5xx
    // from task-store) during this tick. Unlike a 409 conflict, a throw means
    // the claim never actually succeeded — the task-store record is still
    // pending and getDevTaskCandidates() will keep returning it every
    // iteration. Without this filter the drain would re-select and re-throw
    // on the same oldest candidate forever within the tick. Scoped to this
    // call so a later tick gets a fresh chance at the same task.
    const failedPreClaimTaskIds = new Set<string>();
    // Per-tick guard (CBD-2.1): the PR-path analog of failedPreClaimTaskIds
    // above. claimPr's production implementation throws the identical
    // task-store-5xx error claimTask does — without this filter a thrown PR
    // pre-claim would leave the same candidate re-selected and re-thrown on
    // every iteration for the rest of the tick.
    const failedPreClaimPrIds = new Set<string>();

    try {
      // Drain until dry: keep selecting-and-dispatching while work remains.
      // Each iteration re-reads toggles and re-collects candidates so a phase
      // toggled off mid-drain (or freshly-consumed work) is reflected at once.
      while (true) {
        // LPF-7.2: reset busySince at the top of every iteration, not just
        // once at tick-start. A drain that sequentially works through many
        // candidates (each dispatch its own bounded runner() call) is
        // legitimately busy for longer than any single dispatch — measuring
        // from tick-start would treat that healthy cumulative time as stall
        // evidence. Resetting per-iteration makes elapsedMs reflect only how
        // long the *current* iteration (candidate collection through
        // dispatch) has been running, which — like a single dispatch — is
        // bounded by claude.ts's 30-minute runner() ceiling, so the safety
        // margin below still only fires on a genuinely wedged iteration.
        busySince = clock.now();
        const toggles = resolveLoopPhaseToggles(jobs, loopCronId);

        // Unreconciled-agent guard (LPC-2.1 follow-up): resolveLoopPhaseToggles
        // reads phases exclusively from child rows (parentCronId === loopCronId).
        // An agent whose four phase rows haven't been backfilled with a
        // parentCronId yet by reconcileSystemCrons() (LPC-1.2) will have a
        // shipwright-loop row present but zero children — every toggle resolves
        // false and the drain simply stops with no candidates collected. Without
        // this warn that state is indistinguishable from a legitimately idle or
        // all-phases-disabled tick. Logged so it stays observable (Sentry-eligible)
        // instead of the loop silently going quiet.
        //
        // Checked per-phase-name (not "any child row exists at all under this
        // parent") because reconciliation can be partial: e.g. only the
        // dev-task row has been backfilled with parentCronId so far, the
        // other three haven't. In that case at least one job matches
        // `parentCronId === loopCronId`, but all four toggles can still
        // resolve false — this warn exists specifically to catch that gap.
        // The discriminator against a legitimate all-phases-disabled tick
        // (four reconciled child rows, all enabled: false) is whether every
        // phase name HAS a same-parent child row: if it does, its false
        // toggle is a real "disabled" choice, not a reconciliation gap. So
        // the warn fires whenever AT LEAST ONE of the four phase names still
        // lacks a same-parent child row entirely — not only when all four do.
        if (
          !toggles.devTask &&
          !toggles.review &&
          !toggles.patch &&
          !toggles.deploy &&
          jobs.some((job) => job.name === "shipwright-loop") &&
          LOOP_PHASE_JOB_NAMES.some(
            (name) =>
              !jobs.some(
                (job) => job.parentCronId === loopCronId && job.name === name,
              ),
          )
        ) {
          console.warn(
            `shipwright-loop ${loopCronId} has no child phase rows — all phases resolved false. If this agent hasn't reconciled since LPC-1.2/2.1 shipped, run reconcileSystemCrons() to backfill parentCronId on its phase rows.`,
          );
        }

        const devTaskCandidates: WorkTaskCandidate[] = toggles.devTask
          ? (await getDevTaskCandidates()).filter(
              (t) => !failedPreClaimTaskIds.has(t.id),
            )
          : [];

        // PDR-4.1: the autonomous plan-session phase's candidates join the
        // SAME merged task pool dev-task's do — no phase-priority bias, the
        // age-based FIFO below picks the winner across both. Gated behind
        // BOTH the shipwright-plan cron toggle and the
        // SHIPWRIGHT_AGENT_AUTONOMOUS_PLAN_SESSION_ENABLED kill switch (read
        // fresh every iteration, never cached, so an operator's env change
        // lands on the very next tick). With the env var unset this
        // condition is always false, so zero new candidates ever enter the
        // pool and every pre-PDR-4.1 code path below is untouched.
        const planEnabled =
          toggles.plan && readBooleanEnv(AUTONOMOUS_PLAN_SESSION_ENV);
        const planCandidates: WorkTaskCandidate[] =
          planEnabled && getPlanCandidates
            ? (await getPlanCandidates()).filter(
                (t) => !failedPreClaimTaskIds.has(t.id),
              )
            : [];

        // Dedupe by id, plan-tagged copy winning — a defensive backstop, not
        // a workaround. The two providers' pools are already disjoint in
        // practice: check-plan asks for the PRD slice (buildPrdTaskQuery), and
        // check-dev-task's `?ready=true` excludes it outright — task-store's
        // ready.ts drops a task whose `kind` is "prd" (TKD-1.3 removed the
        // legacy `autonomousPlanSession` boolean this exclusion used to also
        // check), so a PRD task cannot legitimately appear in dev-task's list
        // at all.
        //
        // The dedupe stays because that disjointness is enforced server-side,
        // one deploy away: an agent binary running against an older/newer
        // task-store version skew (or a row whose `kind` was hand-edited
        // inconsistently) can still surface the same task from both providers.
        // When that happens both copies carry an identical `createdAt`, and
        // selectNextWorkItem's strict `<` keeps the first occurrence on a tie,
        // so the untagged dev-task copy would win and the PRD task would be
        // dispatched as `/shipwright:dev-task` — never reaching plan-session.
        // Correcting that misroute locally is far cheaper than the alternative.
        //
        // Still done here rather than by narrowing check-dev-task's ready
        // query with a `?kind=dev` param: the exclusion belongs in ready.ts
        // (where it already is), and the task-store filters `kind` by strict
        // equality, so a client-side narrowing would only duplicate a
        // server-side guarantee.
        const planTaskIds = new Set(planCandidates.map((t) => t.id));
        const tasks: WorkTaskCandidate[] = [
          ...devTaskCandidates.filter((t) => !planTaskIds.has(t.id)),
          ...planCandidates,
        ];

        const allPrs: WorkPrCandidate[] = [];
        if (toggles.review) allPrs.push(...(await getReviewCandidates()));
        if (toggles.patch) allPrs.push(...(await getPatchCandidates()));
        if (toggles.deploy) allPrs.push(...(await getDeployCandidates()));
        const nowMs = clock.now().getTime();
        const prs: WorkPrCandidate[] = allPrs.filter(
          (p) =>
            !failedPreClaimPrIds.has(p.id) &&
            !isPrDispatchSuppressed(p, lastPrDispatch, nowMs),
        );

        // SKT-2.2: record candidate presence for this tick regardless of
        // whether anything below ends up dispatched — see the
        // candidatesSeenThisTick doc comment above the declaration.
        if (tasks.length > 0 || prs.length > 0) {
          candidatesSeenThisTick = true;
        }

        // Full-queue observability snapshot — fires every iteration
        // (dispatch or idle), deliberately with no noise guard. See the
        // file's top doc comment.
        const ranked = rankWorkItems(tasks, prs);
        await workQueueReporter.reportSnapshot({
          computedAt: clock.now().toISOString(),
          items: ranked,
        });

        const item = selectNextWorkItem(tasks, prs);
        if (!item) break;

        // Only NOW does anything reach the reporter — a phase that found no
        // candidates never logged a row (noise guard).
        const phase: LoopPhase =
          item.type === "task"
            ? (item.task.phase ?? "dev-task")
            : (item.pr.phase ?? "review");
        const phaseId = resolveLoopPhaseJobId(
          jobs,
          loopCronId,
          `shipwright-${phase}`,
        );
        const itemId = item.type === "task" ? item.task.id : item.pr.id;

        // PDR-4.1: the plan phase is the only one whose dispatched command
        // isn't `{command} {itemId}` — it needs the task's repo and session
        // too (see buildPlanCommandArgs). Built BEFORE the pre-claim below
        // so a candidate that can't produce a well-formed command is never
        // claimed in the first place. check-plan.ts already filters these
        // out, so this only fires for a foreign/injected candidate provider.
        let commandArgs: string | undefined;
        if (phase === "plan" && item.type === "task") {
          const planArgs = buildPlanCommandArgs(item.task);
          if (planArgs === null) {
            console.warn(
              `Plan candidate ${itemId} is missing repo and/or session — cannot build /shipwright:plan-session arguments, skipping for this tick`,
            );
            failedPreClaimTaskIds.add(itemId);
            continue;
          }
          commandArgs = planArgs;
        }

        // Pre-claim: a selected item must be claimed directly against the task
        // store before dispatch — dev-task items via claimTask (CBD-1.2), PR
        // items via claimPr (CBD-1.3). A 409 means another agent replica
        // claimed it first since this item was collected — skip dispatch
        // entirely (no runner() call, no cronRunReporter, no spin-detection
        // accounting for this iteration) and `continue` the while loop so the
        // next iteration re-reads toggles and re-collects candidates fresh,
        // naturally excluding the now-claimed item. On a successful PR
        // pre-claim, capture the marker (claimed record id + commitSha) to
        // append to the dispatched command string below.
        //
        // `recordId` (SKT-2.1) is the id passed to recordSkip/resetSkip — for
        // a task item it's the same as `itemId` (the task's plain id), but
        // for a PR item it MUST be the PullRequest DB record's CUID
        // (claimResult.id) rather than `itemId` (which stays the
        // human-readable "org/repo#123" display id used for cron-run-reporter
        // tagging only). See the recordSkip doc comment on
        // LoopOrchestratorDeps for the full rationale.
        let preClaimMarker: string | undefined;
        let recordId: string;
        if (item.type === "task") {
          let claimed: boolean;
          try {
            claimed = await claimTask(itemId);
          } catch (err) {
            // CBD-2.1: a thrown pre-claim (e.g. task-store 5xx) must not
            // abort the whole drain — skip this item for the rest of the
            // tick and keep draining the next candidate. Logged so repeated
            // claim failures stay observable (Sentry-eligible) instead of
            // being silently swallowed.
            console.warn(
              `Pre-claim failed for task ${itemId}, skipping for this tick: ` +
                `${err instanceof Error ? err.message : String(err)}`,
            );
            failedPreClaimTaskIds.add(itemId);
            continue;
          }
          if (!claimed) {
            // RCG-1.2: a clean 409 (claimTask resolved false — another
            // replica claimed it first, the expected "already claimed"
            // outcome) must be excluded from re-selection for the rest of
            // this tick just like a thrown pre-claim above. Without this,
            // an item that always loses the claim race — e.g. because the
            // record legitimately belongs to a sibling replica for the
            // whole tick — gets re-collected and re-selected every
            // iteration, starving every other candidate in every phase and
            // repo for the tick's entire duration.
            failedPreClaimTaskIds.add(itemId);
            continue;
          }
          recordId = itemId;
        } else {
          let claimResult: { id: string; commitSha: string } | null;
          try {
            claimResult = await claimPr(item.pr);
          } catch (err) {
            // CBD-2.1: completes the throw-isolation fix for the PR path —
            // a thrown pre-claim (e.g. task-store 5xx) must not abort the
            // whole drain here either. Skip this item for the rest of the
            // tick and keep draining the next candidate. Logged so repeated
            // claim failures stay observable (Sentry-eligible) instead of
            // being silently swallowed.
            console.warn(
              `Pre-claim failed for PR ${itemId}, skipping for this tick: ` +
                `${err instanceof Error ? err.message : String(err)}`,
            );
            failedPreClaimPrIds.add(itemId);
            continue;
          }
          if (!claimResult) {
            // RCG-1.2: PR-path analog of the clean-409 exclusion above — a
            // clean 409 (claimPr resolved null) must also be excluded from
            // re-selection for the rest of this tick, not just a thrown
            // pre-claim.
            failedPreClaimPrIds.add(itemId);
            continue;
          }
          preClaimMarker = formatPreClaimMarker(
            claimResult.id,
            claimResult.commitSha,
          );
          // NOT itemId — claimResult.id is the PullRequest DB record's CUID,
          // the value the /prs/:id/skip[/reset] routes expect.
          recordId = claimResult.id;
        }

        // Spin detection: track consecutive dispatches of the same itemId.
        // On reaching the threshold, emit a console.warn (Sentry-eligible) to
        // alert on a potential infinite loop or stuck candidate. Warn on every
        // dispatch once the threshold is reached (not just at the crossing) so
        // the signal persists and escalates in Sentry for as long as the spin
        // continues, making it more useful for alert rules than a one-time signal.
        if (itemId === lastDispatchedItemId) {
          consecutiveDispatchCount += 1;
        } else {
          consecutiveDispatchCount = 1;
          lastDispatchedItemId = itemId;
        }

        if (consecutiveDispatchCount >= SPIN_DETECTION_THRESHOLD) {
          console.warn(
            `Spin detected: repeated dispatch of ${itemId} ` +
              `(${consecutiveDispatchCount} consecutive times)`,
          );
        }

        // CBD-2.3: a thrown dispatch (e.g. the injected runner throwing or
        // timing out) must not abort the whole drain — dispatch() itself
        // already reports the failed run via cronRunReporter.completeRun and
        // calls markCronRunFailureReported(err) before re-throwing (see its
        // catch block above), so this catch only needs to stop the throw
        // from escaping the drain loop. `continue` skips the rest of this
        // iteration's loop body (including the lastPrDispatch bookkeeping
        // below) and lets the next iteration re-collect candidates fresh —
        // the pre-claim above already removed this item from candidacy
        // (claimTask/claimPr succeeded), so it won't be re-selected this
        // tick. Logged so repeated dispatch failures stay observable
        // (Sentry-eligible) instead of being silently swallowed, matching
        // the CBD-2.1 pre-claim catch blocks' style/wording above.
        try {
          await dispatch(
            phase,
            phaseId,
            item.type,
            itemId,
            recordId,
            preClaimMarker,
            commandArgs,
            item.type === "pr" ? item.pr.authorLogin : undefined,
          );
        } catch (err) {
          // Throw isolation for the runner itself: dispatch() already
          // reported the failure (cronRunReporter.completeRun +
          // markCronRunFailureReported) before rethrowing — the rethrow
          // exists so callers can react, but letting it propagate out of
          // the drain loop here would abort the ENTIRE tick, blocking every
          // other candidate that hasn't failed (the "one flaky/timeout
          // dispatch stalls unrelated review/patch/deploy work" bug). Skip
          // this item for the rest of the tick and keep draining — the item
          // stays claimed in the task store (pre-claim above already
          // succeeded), so it naturally drops out of the next iteration's
          // candidates rather than being re-selected and re-thrown forever.
          console.warn(
            `Dispatch failed for ${item.type} ${itemId}, skipping for this tick: ` +
              `${err instanceof Error ? err.message : String(err)}`,
          );
          continue;
        }
        // Not re-marking candidatesSeenThisTick here — a successful dispatch
        // is only reachable after this iteration already found tasks/prs
        // nonzero above, so it's already true by this point.

        // Record this PR dispatch's commitSha/timestamp (CBD-2.2) so a later
        // tick can suppress a redundant re-dispatch at the same commit within
        // the cooldown window. Only reached once dispatch() has resolved
        // without throwing (a thrown dispatch `continue`s above before
        // reaching here).
        if (item.type === "pr") {
          lastPrDispatch.set(prDispatchCooldownKey(item.pr), {
            commitSha: item.pr.commitSha,
            dispatchedAt: clock.now().getTime(),
          });
        }
      }

      // SKT-2.2: update empty-tick bookkeeping now that the drain loop has
      // exited. Any candidates seen this tick — dispatched or not — mean it
      // wasn't empty: reset the counter and clear any active backoff
      // immediately. This covers both real work landing and a contended
      // queue where every claim lost a race to a sibling replica (candidates
      // were seen but nothing dispatched) — neither is "zero candidates
      // collected", so neither should climb the empty-tick counter.
      if (candidatesSeenThisTick) {
        consecutiveEmptyTicks = 0;
        backoffUntil = null;
      } else {
        consecutiveEmptyTicks += 1;
        // LTO-1.1: a genuinely-empty tick (drained fully, saw zero
        // candidates on every iteration) — distinguishable from both early
        // returns above, and includes the resulting count so a string of
        // these in the logs shows the climb toward emptyBackoffAttempts.
        console.log(
          `[loop-orchestrator] tick empty: no candidates collected this tick — consecutiveEmptyTicks now ${consecutiveEmptyTicks}`,
        );
        if (consecutiveEmptyTicks >= emptyBackoffAttempts) {
          backoffUntil = new Date(clock.now().getTime() + emptyBackoffMs);
          // LTO-1.1: fires only on the crossing tick (this branch is only
          // entered once per backoff cycle, immediately before
          // consecutiveEmptyTicks is reset below) — noting when backoff
          // will next allow candidate collection again.
          console.log(
            `[loop-orchestrator] empty-queue backoff engaging: ${consecutiveEmptyTicks} consecutive empty ticks reached — backing off until ${backoffUntil.toISOString()}`,
          );
          consecutiveEmptyTicks = 0;
        }
      }
    } finally {
      busy = false;
      busySince = null;
    }
  };
}

// ─── Getter factory ────────────────────────────────────────────────────────────

export interface LoopOrchestratorGetterDeps {
  /** DTW-1.3 — see LoopOrchestratorDeps's runner doc comment. */
  runner: (
    message: string,
    onProgress?: ProgressCallback,
    sessionKey?: string,
    onEarlySessionId?: EarlySessionIdCallback,
  ) => Promise<ClaudeRunResult>;
  cronRunReporter: CronRunReporter;
  workQueueReporter: WorkQueueReporter;
  createOrchestrator?: typeof createProductionLoopOrchestrator;
  /** LO-1.1 — see LoopOrchestratorDeps's sentryClient doc comment. */
  sentryClient?: ErrorCapturingClient;
  /** DTW-1.3 — see LoopOrchestratorDeps's clearSessionKey doc comment. */
  clearSessionKey?: (key: string) => Promise<void>;
  /** See LoopOrchestratorDeps's contextStamp doc comment. */
  contextStamp?: () => RunContextStamp | null;
}

/**
 * Creates a getter function that constructs a LoopOrchestrator once and memoizes it,
 * parameterized with the real loopCronId passed at call time.
 *
 * Usage:
 *   const getter = createLoopOrchestratorGetter({ runner, cronRunReporter });
 *   const orch = await getter(realLoopCronId);
 *
 * The orchestrator is constructed only on the first call; subsequent calls return
 * the cached instance regardless of the loopCronId passed. On rejection, the
 * memoization is reset so transient failures (e.g., gh unavailable) can be retried
 * on the next call.
 */
export function createLoopOrchestratorGetter(
  deps: LoopOrchestratorGetterDeps,
): (loopCronId: string) => Promise<(jobs: CronJobLike[]) => Promise<void>> {
  const createOrchestrator =
    deps.createOrchestrator ?? createProductionLoopOrchestrator;
  let orchestrator: ((jobs: CronJobLike[]) => Promise<void>) | undefined;
  let orchestratorInit: Promise<(jobs: CronJobLike[]) => Promise<void>> | null =
    null;

  return async function getLoopOrchestrator(
    loopCronId: string,
  ): Promise<(jobs: CronJobLike[]) => Promise<void>> {
    if (orchestrator) return orchestrator;
    if (!orchestratorInit) {
      orchestratorInit = createOrchestrator({
        runner: deps.runner,
        cronRunReporter: deps.cronRunReporter,
        workQueueReporter: deps.workQueueReporter,
        loopCronId,
        sentryClient: deps.sentryClient,
        clearSessionKey: deps.clearSessionKey,
        contextStamp: deps.contextStamp,
      })
        .then((orch) => {
          orchestrator = orch;
          return orch;
        })
        .catch((err) => {
          // Reset so a transient dep-wiring failure (e.g. gh unavailable) can be
          // retried on the next loop tick rather than caching the rejection.
          orchestratorInit = null;
          throw err;
        });
    }
    return orchestratorInit;
  };
}

// ─── Production wiring ────────────────────────────────────────────────────────

export interface LoopOrchestratorProductionOptions {
  /** DTW-1.3 — see LoopOrchestratorDeps's runner doc comment. */
  runner: (
    message: string,
    onProgress?: ProgressCallback,
    sessionKey?: string,
    onEarlySessionId?: EarlySessionIdCallback,
  ) => Promise<ClaudeRunResult>;
  cronRunReporter: CronRunReporter;
  workQueueReporter: WorkQueueReporter;
  loopCronId?: string;
  clock?: Clock;
  /** LO-1.1 — see LoopOrchestratorDeps's sentryClient doc comment. */
  sentryClient?: ErrorCapturingClient;
  /** DTW-1.3 — see LoopOrchestratorDeps's clearSessionKey doc comment. */
  clearSessionKey?: (key: string) => Promise<void>;
  /** See LoopOrchestratorDeps's contextStamp doc comment. */
  contextStamp?: () => RunContextStamp | null;
}

/**
 * Wire the five qualification functions over their real production deps
 * and return an orchestrator ready for the cron-sync call site. Each phase's
 * deps are built once here (they read the workspace repo list and self-review
 * policy) and reused across ticks — the closures they hold re-query GitHub /
 * the task store on every candidate collection, so a single build stays live.
 *
 * The dev-task deps are built synchronously (and hard-exit on a missing
 * SHIPWRIGHT_AGENT_ID, matching the plugin precheck) — but the agent has
 * already validated its id at boot, so this only runs on a correctly
 * configured agent. Review/patch/deploy deps are async because they resolve
 * workspace state and the current GitHub user up front.
 */
/**
 * Builds the request body createProductionLoopOrchestrator's `claimPr` wrapper
 * sends to taskStoreClient.claimPr() — a pure function (no I/O) so the
 * authorLogin/headRefName/title forwarding (POM-1.2) can be unit-tested
 * without standing up the production task-store client or the review/patch/
 * deploy deps createProductionLoopOrchestrator otherwise requires.
 * authorLogin/headRefName/title are all optional on WorkPrCandidate, so
 * passing them through as-is (including undefined) is safe — check-helpers.ts's
 * claimPr() implementation is what actually renames headRefName -> headRef
 * for the outbound HTTP body.
 */
export function buildClaimPrRequest(
  pr: WorkPrCandidate,
  parsed: { repo: string; prNumber: number },
): {
  repo: string;
  prNumber: number;
  commitSha: string;
  phase: "review" | "patch" | "deploy";
  authorLogin?: string;
  headRefName?: string;
  title?: string;
  authorIsBot?: boolean;
  hasAutomatedLabel?: boolean;
  hasShipwrightLabel?: boolean;
} {
  return {
    repo: parsed.repo,
    prNumber: parsed.prNumber,
    commitSha: pr.commitSha,
    phase: pr.phase ?? "review",
    authorLogin: pr.authorLogin,
    headRefName: pr.headRefName,
    title: pr.title,
    // POF-1.2: forwarded alongside authorLogin/headRefName/title so the
    // task-store can derive origin server-side using the same is_bot/label
    // precedence POF-1.1's deriveOrigin() applies.
    authorIsBot: pr.authorIsBot,
    hasAutomatedLabel: pr.hasAutomatedLabel,
    hasShipwrightLabel: pr.hasShipwrightLabel,
  };
}

export async function createProductionLoopOrchestrator(
  opts: LoopOrchestratorProductionOptions,
): Promise<(jobs: CronJobLike[]) => Promise<void>> {
  const devTaskDeps = buildDevTaskDeps();
  // PDR-4.1: built unconditionally alongside devTaskDeps (same synchronous,
  // task-store-only wiring and the same SHIPWRIGHT_AGENT_ID precondition, so
  // no new failure mode). The phase itself stays inert until both the
  // shipwright-plan cron toggle and
  // SHIPWRIGHT_AGENT_AUTONOMOUS_PLAN_SESSION_ENABLED are on — this provider
  // is never even called otherwise.
  const planDeps = buildPlanDeps();
  const reviewDeps = await buildReviewDeps({ ghJson, ghGraphql });
  const patchDeps = await buildPatchDeps({ ghJson, ghGraphql, getCurrentUser });
  const deployDeps = await buildDeployDeps({ ghJson });
  const taskStoreClient = createTaskStoreClient();

  return createLoopOrchestrator({
    getDevTaskCandidates: () => getDevTaskCandidates(devTaskDeps),
    getPlanCandidates: () => getPlanCandidates(planDeps),
    getReviewCandidates: () => getReviewCandidates(reviewDeps),
    getPatchCandidates: () => getPatchCandidates(patchDeps),
    getDeployCandidates: () => getDeployCandidates(deployDeps),
    claimTask: (id) => taskStoreClient.claim(id),
    claimPr: (pr) => {
      const parsed = parseCandidateId(pr.id);
      if (!parsed) {
        throw new Error(
          `invalid PR candidate id (expected org/repo#number): ${pr.id}`,
        );
      }
      return taskStoreClient.claimPr(buildClaimPrRequest(pr, parsed));
    },
    recordSkip: (itemType, id, reason) =>
      taskStoreClient.recordSkip(itemType, id, reason),
    resetSkip: (itemType, id) => taskStoreClient.resetSkip(itemType, id),
    // DTW-1.3: a missing task (getTask → null) stays null, which the resume
    // loop reads as "stop resuming". claimedBy rides along on the same
    // response so the resume gate can check claim ownership, not just status.
    getTaskState: (id) =>
      taskStoreClient
        .getTask(id)
        .then((t) =>
          t ? { status: t.status, claimedBy: t.claimedBy ?? null } : null,
        ),
    // The value the task store pins claimedBy to for this agent's own claims.
    // Empty/unset → the resume gate keeps its status-only behavior.
    agentId: (process.env.SHIPWRIGHT_AGENT_ID ?? "").trim() || undefined,
    // DTW-1.3: renews the claim before each resume attempt so a multi-attempt
    // dispatch never outlives DEFAULT_CLAIM_TTL_MS, which is sized for a
    // single session. Throws on a non-ok response — the resume gate reads that
    // as "stop resuming".
    heartbeatTask: (id) => taskStoreClient.heartbeatTask(id),
    // CRT-1.2/CRT-1.3: PR-phase live-state check — a missing PR (getPr → null)
    // stays null, which the PR resume gate reads as "stop resuming".
    // claimedBy rides along on the same response and is the entire gate (a PR
    // has no in_progress-equivalent status).
    getPrState: (id) =>
      taskStoreClient.getPr(id).then((pr) =>
        pr
          ? {
              reviewState: (pr as { reviewState?: string }).reviewState,
              claimedBy:
                (pr as { claimedBy?: string | null }).claimedBy ?? null,
            }
          : null,
      ),
    // PSL-2.1: progress snapshot for [silent] PR dispatches (null = PR missing).
    patchOutcome: {
      snapshot: createPatchStateSnapshotter(patchDeps),
      escalate: (recordId, candidateId, reason, headSha) => {
        const parsed = parseCandidateId(candidateId);
        if (!parsed) return Promise.resolve();
        return taskStoreClient.blockPr(recordId, parsed.repo, reason, headSha);
      },
    },
    getPrProgress: (id) =>
      taskStoreClient.getPr(id).then((pr) =>
        pr
          ? {
              reviewState: (pr as { reviewState?: string | null }).reviewState,
              reviewedCommitSha: (pr as { reviewedCommitSha?: string | null })
                .reviewedCommitSha,
              commitSha: (pr as { commitSha?: string | null }).commitSha,
            }
          : null,
      ),
    // CRT-1.2/CRT-1.3: PR-phase claim renewal, called before each resume
    // attempt so a multi-attempt dispatch never outlives the single-session
    // claim TTL. Throws on a non-ok response — the resume gate reads that as
    // "stop resuming".
    heartbeatPr: (id) => taskStoreClient.heartbeatPr(id),
    releasePr: (id) => taskStoreClient.releasePr(id),
    clearSessionKey: opts.clearSessionKey,
    contextStamp: opts.contextStamp,
    runner: opts.runner,
    cronRunReporter: opts.cronRunReporter,
    workQueueReporter: opts.workQueueReporter,
    loopCronId: opts.loopCronId ?? "shipwright-loop",
    clock: opts.clock ?? SystemClock(),
    sentryClient: opts.sentryClient,
  });
}
