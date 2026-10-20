/**
 * agent/src/coding/extension.ts
 *
 * The coding agent's AgentExtension: PR-policy refs, the periodic PR/task
 * reconcilers, the shipwright-loop cron classification, and the lazily-built
 * loop orchestrator. Everything coding-specific that index.ts used to wire
 * inline lives behind this one factory.
 */

import type { AgentConfigResponse } from "@shipwright/admin";
import type {
  AgentExtension,
  AgentExtensionContext,
  PeriodicPass,
} from "../runtime/agent-extension.ts";
import { agentReposRef } from "../runtime/agent-repos-ref.ts";
import type {
  EarlySessionIdCallback,
  ProgressCallback,
} from "../runtime/claude.ts";
import { cleanupMergedWorktreesRef } from "../runtime/cleanup-merged-worktrees-ref.ts";
import { NoopCronRunReporter } from "../runtime/cron-run-reporter.ts";
import { ghGraphql, ghJson } from "../runtime/gh-helpers.ts";
import { allowSelfReviewRef } from "./allow-self-review-ref.ts";
import {
  buildProductionDeps as buildClaimInvariantReconcilerDeps,
  reconcileClaimInvariant,
} from "./claim-invariant-reconciler.ts";
import {
  type CronJobLike,
  classifyCronJobsForScheduling,
} from "./loop-cron-classifier.ts";
import { createJobsRef } from "./loop-jobs-ref.ts";
import { createLoopOrchestratorGetter } from "./loop-orchestrator.ts";
import {
  patchAuthorAllowlistRef,
  resolvePatchAuthorAllowlist,
} from "./patch-author-allowlist-ref.ts";
import {
  buildProductionDeps as buildPrCensusDeps,
  runPrCensus,
} from "./pr-census.ts";
import {
  buildProductionDeps as buildPrStateReconcilerDeps,
  buildReviewStateProductionDeps as buildReviewStateReconcilerDeps,
  reconcilePrState,
  reconcileReviewState,
} from "./pr-state-reconciler.ts";
import {
  resolveReviewAuthorAllowlist,
  reviewAuthorAllowlistRef,
} from "./review-author-allowlist-ref.ts";
import {
  HttpWorkQueueReporter,
  NoopWorkQueueReporter,
} from "./work-queue-reporter.ts";

export function createCodingExtension(
  ctx: AgentExtensionContext,
): AgentExtension<AgentConfigResponse> {
  const { config, runner, sessions, cronRunReporter, contextStamp } = ctx;

  const workQueueReporter =
    config.shipwright.apiUrl &&
    config.shipwright.apiKey &&
    config.shipwright.agentId
      ? new HttpWorkQueueReporter({
          apiUrl: config.shipwright.apiUrl,
          agentId: config.shipwright.agentId,
          apiKey: config.shipwright.apiKey,
        })
      : new NoopWorkQueueReporter();

  // ─── Periodic passes ────────────────────────────────────────────────────────
  // Crash backstops and self-heal sweeps; each builds its deps lazily on first
  // tick so a not-yet-ready workspace/GH auth at boot can't crash startup.
  // See pr-state-reconciler.ts, claim-invariant-reconciler.ts and pr-census.ts
  // for the per-pass rationale.
  let reconcilerDeps: ReturnType<typeof buildPrStateReconcilerDeps> | undefined;
  let reviewStateReconcilerDeps:
    | ReturnType<typeof buildReviewStateReconcilerDeps>
    | undefined;
  let claimInvariantReconcilerDeps:
    | ReturnType<typeof buildClaimInvariantReconcilerDeps>
    | undefined;
  let prCensusDeps: ReturnType<typeof buildPrCensusDeps> | undefined;

  const periodicPasses: PeriodicPass[] = [
    {
      name: "pr-state",
      logPrefix: "[pr-state-reconciler]",
      run: async () => {
        reconcilerDeps ??= buildPrStateReconcilerDeps({
          ghJson,
          getScopedRepos: agentReposRef.get,
        });
        await reconcilePrState(reconcilerDeps);
      },
    },
    {
      name: "review-state",
      logPrefix: "[pr-state-reconciler:review]",
      run: async () => {
        reviewStateReconcilerDeps ??= buildReviewStateReconcilerDeps({
          ghGraphql,
          getScopedRepos: agentReposRef.get,
        });
        await reconcileReviewState(reviewStateReconcilerDeps);
      },
    },
    {
      name: "claim-invariant",
      logPrefix: "[claim-invariant-reconciler]",
      run: async () => {
        claimInvariantReconcilerDeps ??= buildClaimInvariantReconcilerDeps({
          getScopedRepos: agentReposRef.get,
        });
        await reconcileClaimInvariant(claimInvariantReconcilerDeps);
      },
    },
    {
      name: "pr-census",
      logPrefix: "[pr-census]",
      run: async () => {
        prCensusDeps ??= buildPrCensusDeps({
          ghJson,
          getScopedRepos: agentReposRef.get,
        });
        await runPrCensus(prCensusDeps);
      },
    },
  ];

  // ─── Loop wiring ────────────────────────────────────────────────────────────
  // Live view of the most recent cron job list: the shipwright-loop job is only
  // scheduled once, so its dispatch must read this at fire-time (see
  // loop-jobs-ref.ts).
  const loopJobsRef = createJobsRef<CronJobLike>();

  // The orchestrator is a single stateful closure (it owns the cross-tick busy
  // flag), so it is constructed once and reused across ticks — built lazily on
  // the first loop dispatch so agents without a shipwright-loop cron never pay
  // its dep wiring cost, and construction errors surface at fire time rather
  // than crashing startup.
  const getLoopOrchestrator = createLoopOrchestratorGetter({
    // DTW-1.3/DTR-1.1/CRT-1.3: the orchestrator supplies a stable
    // `dev-task:{taskId}` session key for dev-task dispatches and a
    // per-dispatch nonce `{phase}:{itemId}:{uuid}` key for review/patch/deploy
    // (nothing for plan), plus an onEarlySessionId callback — see
    // loop-orchestrator.ts's sessionKey doc comment. The loop never passes
    // extraEnv.
    runner: (
      message: string,
      onProgress?: ProgressCallback,
      sessionKey?: string,
      onEarlySessionId?: EarlySessionIdCallback,
    ) =>
      runner(
        message,
        sessionKey,
        onProgress,
        undefined,
        undefined,
        onEarlySessionId,
      ),
    cronRunReporter: cronRunReporter ?? new NoopCronRunReporter(),
    workQueueReporter,
    // DTW-1.3/DTR-1.1/CRT-1.3: lets the resume loops drop their session keys —
    // dev-task only once the task reaches a terminal status, review/patch/
    // deploy unconditionally on every exit. Keeps sessions.json from
    // accumulating a permanent entry per finished dispatch.
    clearSessionKey: (key: string) => sessions.clear(key),
    contextStamp,
    sentryClient: ctx.sentryClient,
  });

  return {
    onConfigSync(bundle) {
      // Sync the agent's review-author-allowlist live ref
      reviewAuthorAllowlistRef.set(
        resolveReviewAuthorAllowlist(bundle.reviewAuthorAllowlist),
      );

      // Sync the agent's patch-author-allowlist live ref
      patchAuthorAllowlistRef.set(
        resolvePatchAuthorAllowlist(bundle.patchAuthorAllowlist),
      );

      // Sync the agent's allow-self-review live ref (APM-1.4)
      allowSelfReviewRef.set(bundle.allowSelfReview);

      // Sync the agent's cleanup-merged-worktrees live ref (APM-1.6)
      cleanupMergedWorktreesRef.set(bundle.cleanupMergedWorktrees);
    },
    periodicPasses,
    onCronJobs(jobs) {
      loopJobsRef.set(jobs);
    },
    classifyCronJobs: classifyCronJobsForScheduling,
    async dispatchLoop(loopCronId) {
      const orchestrator = await getLoopOrchestrator(loopCronId);
      await orchestrator(loopJobsRef.get());
    },
  };
}
