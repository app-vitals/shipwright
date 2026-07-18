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
 *   1. Read the four independent phase toggles for this agent (dev-task /
 *      review / patch / deploy) via resolveLoopPhaseToggles — never
 *      shipwright-review-patch's flag, and never invoking /shipwright:review-patch.
 *   2. For each enabled phase, call its WL-2.2 qualification function to get
 *      structured candidates. Merge the enabled phases' PR candidate lists into
 *      one array.
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
 *      dispatch the correct one-shot command by the item's type (task →
 *      /shipwright:dev-task) or its phase tag (pr → /shipwright:review |
 *      /shipwright:patch | /shipwright:deploy) via the injected claude
 *      runner, and report the run.
 *   5. Repeat immediately (not waiting for the next cron tick) while work
 *      remains. Stop when nothing is selected, or if an iteration throws.
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
  buildProductionDeps as buildReviewDeps,
  getReviewCandidates,
} from "./check-review.ts";
import type { ClaudeRunResult } from "./claude.ts";
import { type Clock, SystemClock } from "./clock.ts";
import { buildTokenPayload, formatCronMessage } from "./cron-handler.ts";
import { markCronRunFailureReported } from "./cron-failure-reporter.ts";
import type { CronRunReporter } from "./cron-run-reporter.ts";
import {
  type CronJobLike,
  resolveLoopPhaseToggles,
} from "./loop-cron-classifier.ts";
import { parseMarkers } from "./markers.ts";
import type { WorkQueueReporter } from "./work-queue-reporter.ts";
import {
  type WorkPrCandidate,
  type WorkTaskCandidate,
  rankWorkItems,
  selectNextWorkItem,
} from "./work-selector.ts";

// ─── Types ────────────────────────────────────────────────────────────────────

/** The phase a dispatched run serves — used to tag the AgentCronRun row. */
export type LoopPhase = "dev-task" | "review" | "patch" | "deploy";

export interface LoopOrchestratorDeps {
  /** WL-2.2 dev-task qualification, pre-wired over its own production deps. */
  getDevTaskCandidates: () => Promise<WorkTaskCandidate[]>;
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
  /** The claude runner — sends a one-shot slash-command message. */
  runner: (message: string) => Promise<ClaudeRunResult>;
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
}

// ─── Command routing ──────────────────────────────────────────────────────────

/**
 * The literal slash-command string and phase tag for each pipeline phase.
 * Deliberately no "/shipwright:review-patch" — the loop's per-tick selection
 * across all four phases supersedes that command's internal review-vs-patch
 * decision, so it is never invoked.
 */
const PHASE_COMMANDS: Record<LoopPhase, string> = {
  "dev-task": "/shipwright:dev-task",
  review: "/shipwright:review",
  patch: "/shipwright:patch",
  deploy: "/shipwright:deploy",
};

/**
 * Threshold for spin detection: when the same itemId is dispatched this many
 * times in a row, a console.warn is emitted to signal a potential infinite loop.
 */
const SPIN_DETECTION_THRESHOLD = 3;

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
    getReviewCandidates,
    getPatchCandidates,
    getDeployCandidates,
    claimTask,
    claimPr,
    runner,
    cronRunReporter,
    workQueueReporter,
    loopCronId,
    clock = SystemClock(),
  } = deps;

  // Persisted across ticks: guards against a second concurrent drain.
  let busy = false;

  // Spin detection state: tracks the last dispatched itemId and consecutive
  // repeat count to warn when the same item is dispatched repeatedly.
  let lastDispatchedItemId: string | null = null;
  let consecutiveDispatchCount = 0;

  /**
   * Dispatch one selected phase's one-shot command (with the winning item's
   * id appended, e.g. "/shipwright:review acme/x#1") and report its own
   * tagged run. A command that returns a trailing [silent] marker signals
   * "nothing to do once it actually ran" — the precheck contract's narrow
   * skip case — so it is recorded via skipRun rather than completeRun. Every
   * other outcome completes normally.
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
   */
  async function dispatch(
    phase: LoopPhase,
    itemType: "task" | "pr",
    itemId: string,
    preClaimMarker?: string,
  ): Promise<void> {
    const command = preClaimMarker
      ? `${PHASE_COMMANDS[phase]} ${itemId} ${preClaimMarker}`
      : `${PHASE_COMMANDS[phase]} ${itemId}`;
    const message = formatCronMessage(loopCronId, command);
    const runId = await cronRunReporter.createRun(
      loopCronId,
      clock.now(),
      phase,
      itemType,
      itemId,
    );

    let runResult: ClaudeRunResult;
    try {
      runResult = await runner(message);
    } catch (err) {
      await cronRunReporter.completeRun(
        loopCronId,
        runId,
        clock.now(),
        "failed",
        { error: err instanceof Error ? err.message : String(err) },
        phase,
        itemType,
        itemId,
      );
      markCronRunFailureReported(err);
      throw err;
    }

    const { markers } = parseMarkers(runResult.result);
    const isSilent = markers.some((m) => m.type === "silent");

    if (isSilent) {
      // The command was dispatched (it was selected), but found nothing to do
      // once it ran — one row, marked skipped.
      await cronRunReporter.skipRun(
        loopCronId,
        runId,
        clock.now(),
        "command:no-work",
        undefined,
        phase,
        itemType,
        itemId,
      );
      return;
    }

    await cronRunReporter.completeRun(
      loopCronId,
      runId,
      clock.now(),
      "completed",
      buildTokenPayload(runResult.usage, runResult.modelUsage),
      phase,
      itemType,
      itemId,
    );
  }

  return async function runLoopTick(jobs: CronJobLike[]): Promise<void> {
    // Concurrency guard: a prior tick is still draining — no-op immediately.
    if (busy) return;
    busy = true;

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
        const toggles = resolveLoopPhaseToggles(jobs);

        const tasks: WorkTaskCandidate[] = toggles.devTask
          ? (await getDevTaskCandidates()).filter(
              (t) => !failedPreClaimTaskIds.has(t.id),
            )
          : [];

        const allPrs: WorkPrCandidate[] = [];
        if (toggles.review) allPrs.push(...(await getReviewCandidates()));
        if (toggles.patch) allPrs.push(...(await getPatchCandidates()));
        if (toggles.deploy) allPrs.push(...(await getDeployCandidates()));
        const prs: WorkPrCandidate[] = allPrs.filter(
          (p) => !failedPreClaimPrIds.has(p.id),
        );

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
          item.type === "task" ? "dev-task" : (item.pr.phase ?? "review");
        const itemId = item.type === "task" ? item.task.id : item.pr.id;

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
        let preClaimMarker: string | undefined;
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
          if (!claimed) continue;
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
          if (!claimResult) continue;
          preClaimMarker = formatPreClaimMarker(
            claimResult.id,
            claimResult.commitSha,
          );
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

        await dispatch(phase, item.type, itemId, preClaimMarker);
      }
    } finally {
      busy = false;
    }
  };
}

// ─── Getter factory ────────────────────────────────────────────────────────────

export interface LoopOrchestratorGetterDeps {
  runner: (message: string) => Promise<ClaudeRunResult>;
  cronRunReporter: CronRunReporter;
  workQueueReporter: WorkQueueReporter;
  createOrchestrator?: typeof createProductionLoopOrchestrator;
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
  runner: (message: string) => Promise<ClaudeRunResult>;
  cronRunReporter: CronRunReporter;
  workQueueReporter: WorkQueueReporter;
  loopCronId?: string;
  clock?: Clock;
}

/**
 * Wire the four WL-2.2 qualification functions over their real production deps
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
export async function createProductionLoopOrchestrator(
  opts: LoopOrchestratorProductionOptions,
): Promise<(jobs: CronJobLike[]) => Promise<void>> {
  const devTaskDeps = buildDevTaskDeps();
  const reviewDeps = await buildReviewDeps({ ghJson });
  const patchDeps = await buildPatchDeps({ ghJson, ghGraphql, getCurrentUser });
  const deployDeps = await buildDeployDeps({ ghJson });
  const taskStoreClient = createTaskStoreClient();

  return createLoopOrchestrator({
    getDevTaskCandidates: () => getDevTaskCandidates(devTaskDeps),
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
      return taskStoreClient.claimPr({
        repo: parsed.repo,
        prNumber: parsed.prNumber,
        commitSha: pr.commitSha,
        phase: pr.phase ?? "review",
      });
    },
    runner: opts.runner,
    cronRunReporter: opts.cronRunReporter,
    workQueueReporter: opts.workQueueReporter,
    loopCronId: opts.loopCronId ?? "shipwright-loop",
    clock: opts.clock ?? SystemClock(),
  });
}
