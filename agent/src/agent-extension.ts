/**
 * agent/src/agent-extension.ts
 *
 * The extension seam between the generic agent runtime (boot.ts, config
 * sync, cron scheduling) and agent-type-specific behavior (today: the coding
 * agent's PR/task reconcilers and shipwright-loop orchestrator).
 *
 * The runtime calls an AgentExtension at fixed points:
 *
 *   onConfigSync(bundle)      — every successful config-sync tick
 *   periodicPasses            — each tick of the periodic reconciler interval
 *   onCronJobs(jobs)          — every cron-sync tick, BEFORE classifyCronJobs
 *   classifyCronJobs(jobs)    — which jobs get a schedule + dispatch kind
 *   dispatchLoop(loopCronId)  — fire of a job classified as dispatch "loop"
 *
 * Every hook is optional; the defaults reproduce an agent with no extension
 * (all jobs generic, no periodic passes). This file must not import any
 * coding module — index.ts (the composition root) is the only file that wires
 * a concrete extension in.
 */

import type { ErrorCapturingClient } from "@shipwright/lib/sentry";
import type { createRunClaude } from "./claude.ts";
import type { createConfig } from "./config.ts";
import type { createContextStampReader } from "./context-stamp.ts";
import type { CronRunReporter } from "./cron-run-reporter.ts";
import type { createFileSessionStore } from "./sessions.ts";

/** Minimal structural view of a cron job, as the seam needs it. */
export interface ExtensionCronJob {
  id: string;
  name: string | null;
  enabled: boolean;
  parentCronId: string | null;
}

export type CronDispatchKind = "loop" | "generic";

export interface ScheduledCronJob<T extends ExtensionCronJob> {
  job: T;
  dispatch: CronDispatchKind;
}

/** A named, independent unit of periodic work run on the reconciler tick. */
export interface PeriodicPass {
  name: string;
  /** Prefix for the non-fatal failure log: `${logPrefix} tick failed (non-fatal):`. */
  logPrefix: string;
  run(): Promise<void>;
}

/** Everything an extension may need from the runtime to build itself. */
export interface AgentExtensionContext {
  config: ReturnType<typeof createConfig>["config"];
  runner: ReturnType<typeof createRunClaude>;
  sessions: ReturnType<typeof createFileSessionStore>;
  cronRunReporter: CronRunReporter | undefined;
  contextStamp: ReturnType<typeof createContextStampReader>;
  sentryClient: ErrorCapturingClient | undefined;
}

export interface AgentExtension<TBundle = unknown> {
  onConfigSync?(bundle: TBundle): void;
  periodicPasses?: PeriodicPass[];
  onCronJobs?(jobs: ExtensionCronJob[]): void;
  classifyCronJobs?<T extends ExtensionCronJob>(
    jobs: T[],
  ): ScheduledCronJob<T>[];
  /** Runs one loop tick; the orchestrator behind it is built once, lazily. */
  dispatchLoop?(loopCronId: string): Promise<void>;
}

/** Default classification: every enabled job is independently scheduled, generic. */
export function classifyAllGeneric<T extends ExtensionCronJob>(
  jobs: T[],
): ScheduledCronJob<T>[] {
  return jobs
    .filter((job) => job.enabled)
    .map((job) => ({ job, dispatch: "generic" as const }));
}

/**
 * One cron-sync tick's view of the job list: tells the extension about the
 * fresh list first (so e.g. the loop's live jobs ref is current even when
 * nothing gets rescheduled), then classifies it.
 */
export function planCronSchedule<T extends ExtensionCronJob>(
  extension: AgentExtension,
  jobs: T[],
): ScheduledCronJob<T>[] {
  extension.onCronJobs?.(jobs);
  return (extension.classifyCronJobs ?? classifyAllGeneric)(jobs);
}

/**
 * Runs passes in order, each in its own try/catch so one failing pass never
 * prevents the next. Failures are logged non-fatally with the pass's prefix.
 */
export async function runPeriodicPasses(
  passes: readonly PeriodicPass[],
): Promise<void> {
  for (const pass of passes) {
    try {
      await pass.run();
    } catch (err) {
      console.error(
        `${pass.logPrefix} tick failed (non-fatal):`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }
}

/** Builds an extension from the runtime context once the runtime has booted far enough to provide it. */
export type AgentExtensionFactory = (
  ctx: AgentExtensionContext,
) => AgentExtension;

/**
 * Folds the extensions a consumer passed to startAgent into the single
 * extension the runtime talks to. No extensions reproduces an agent with no
 * agent-type behavior; one extension is returned as-is. With several, notify
 * hooks (onConfigSync, onCronJobs) fan out to all, periodic passes concatenate
 * in order, and the first extension defining classifyCronJobs / dispatchLoop
 * owns it — those two decide a single outcome, so they cannot be merged.
 */
export function composeExtensions(
  extensions: readonly AgentExtension[],
): AgentExtension {
  if (extensions.length === 1) return extensions[0];
  const classifier = extensions.find((ext) => ext.classifyCronJobs);
  const dispatcher = extensions.find((ext) => ext.dispatchLoop);
  return {
    onConfigSync: (bundle) => {
      for (const ext of extensions) ext.onConfigSync?.(bundle);
    },
    periodicPasses: extensions.flatMap((ext) => ext.periodicPasses ?? []),
    onCronJobs: (jobs) => {
      for (const ext of extensions) ext.onCronJobs?.(jobs);
    },
    classifyCronJobs: classifier?.classifyCronJobs?.bind(classifier),
    dispatchLoop: dispatcher?.dispatchLoop?.bind(dispatcher),
  };
}
