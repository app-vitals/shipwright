#!/usr/bin/env bun
import { parseFlags } from "@app-vitals/agent-lib/cli-flags";

/**
 * scripts/preview-hold.ts — keep a public preview alive and decide when it ends.
 *
 * Polls once a minute and exits 0 printing the stop reason when any end
 * condition holds. The decision is PURE (`decideHold`); the clock, the
 * PR-state fetcher and the tunnel probe are injected so the loop is testable
 * without GitHub, a tunnel or real time.
 *
 * Fails closed: an API error is a failed poll, and three failed polls in a
 * row end the preview.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Hard ceiling on a job (GitHub kills it at 360 minutes; leave headroom). */
export const JOB_BUDGET_MINUTES = 345;
export const MAX_POLL_FAILURES = 3;
export const DEFAULT_WINDOW_MINUTES = 120;
export const PREVIEW_LABEL = "preview";
export const PREVIEW_USERNAME = "preview";
/** Hidden marker used to find the one comment per PR. */
export const COMMENT_MARKER = "<!-- shipwright-preview -->";

const MINUTE_MS = 60_000;
const POLL_INTERVAL_MS = MINUTE_MS;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type StopReason =
  | "job_budget"
  | "window_elapsed"
  | "label_removed"
  | "pr_closed"
  | "head_changed"
  | "tunnel_dead"
  | "poll_failures";

/** The PR facts the loop cares about. */
export interface PrState {
  open: boolean;
  labels: readonly string[];
  headSha: string;
}

export interface HoldState {
  /** Epoch ms the job started. */
  jobStartMs: number;
  /** Epoch ms the preview window ends (see computeWindowEnd). */
  windowEndMs: number;
  /** Commit the preview was built from. */
  previewedSha: string;
  /** Failed polls in a row so far. */
  consecutiveFailures: number;
}

export interface Observation {
  nowMs: number;
  /** null = the poll failed. */
  pr: PrState | null;
  tunnelAlive: boolean;
}

export interface HoldDecision {
  stop: StopReason | null;
  /** Carry into the next HoldState. */
  consecutiveFailures: number;
}

// ---------------------------------------------------------------------------
// Pure logic
// ---------------------------------------------------------------------------

/**
 * End of the preview window: the requested window from `startMs`, never later
 * than JOB_BUDGET_MINUTES after the job started.
 */
export function computeWindowEnd(
  jobStartMs: number,
  startMs: number,
  windowMinutes: number = DEFAULT_WINDOW_MINUTES,
): number {
  return Math.min(
    startMs + windowMinutes * MINUTE_MS,
    jobStartMs + JOB_BUDGET_MINUTES * MINUTE_MS,
  );
}

/** Decide whether the preview ends now. Time and tunnel checks run even when the poll failed. */
export function decideHold(state: HoldState, obs: Observation): HoldDecision {
  const consecutiveFailures = obs.pr ? 0 : state.consecutiveFailures + 1;
  const result = (stop: StopReason | null): HoldDecision => ({
    stop,
    consecutiveFailures,
  });

  if (obs.nowMs >= state.jobStartMs + JOB_BUDGET_MINUTES * MINUTE_MS) {
    return result("job_budget");
  }
  if (obs.nowMs >= state.windowEndMs) return result("window_elapsed");
  if (!obs.tunnelAlive) return result("tunnel_dead");
  if (!obs.pr) {
    return result(
      consecutiveFailures >= MAX_POLL_FAILURES ? "poll_failures" : null,
    );
  }
  if (!obs.pr.open) return result("pr_closed");
  if (!obs.pr.labels.includes(PREVIEW_LABEL)) return result("label_removed");
  if (obs.pr.headSha !== state.previewedSha) return result("head_changed");
  return result(null);
}

const REASON_TEXT: Record<StopReason, string> = {
  job_budget: "the CI job reached its time budget",
  window_elapsed: "the preview window passed",
  label_removed: "the `preview` label was removed",
  pr_closed: "the pull request was closed",
  head_changed: "new commits were pushed to the pull request",
  tunnel_dead: "the tunnel stopped",
  poll_failures: "the pull request could not be checked three times in a row",
};

export type CommentInput =
  | { status: "live"; url: string; sha: string; expiresAtMs: number }
  | { status: "expired"; reason: StopReason };

/**
 * The preview runs the admin UI without a sign-in provider, so its plain URL
 * lands on a sign-in page with nothing to click. This route starts a session
 * and redirects into the admin UI.
 */
export const PREVIEW_ENTRY_PATH = "/admin/dev-login";

/** Build the single PR comment. Never includes the password. */
export function buildComment(input: CommentInput): string {
  if (input.status === "expired") {
    return [
      COMMENT_MARKER,
      "### Preview ended",
      "",
      `This preview is no longer available: ${REASON_TEXT[input.reason]}.`,
      "Add the `preview` label again to request a new one.",
    ].join("\n");
  }
  return [
    COMMENT_MARKER,
    "### Preview ready",
    "",
    `- URL: ${input.url}${PREVIEW_ENTRY_PATH}`,
    `- Username: \`${PREVIEW_USERNAME}\``,
    `- Commit: \`${input.sha.slice(0, 7)}\``,
    `- Expires: ${new Date(input.expiresAtMs).toISOString()}`,
    "",
    "Maintainers hold the password; ask one of them for it.",
    "The link signs you in to the admin UI once you are past the password prompt.",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Loop (injected clock, fetcher, probe)
// ---------------------------------------------------------------------------

export interface HoldDeps {
  now: () => number;
  /** Throws on API error. */
  fetchPr: () => Promise<PrState>;
  tunnelAlive: () => boolean;
  sleep: (ms: number) => Promise<void>;
}

/** Poll until an end condition holds; returns its reason. */
export async function runHold(
  initial: Omit<HoldState, "consecutiveFailures">,
  deps: HoldDeps,
): Promise<StopReason> {
  let state: HoldState = { ...initial, consecutiveFailures: 0 };
  for (;;) {
    let pr: PrState | null = null;
    try {
      pr = await deps.fetchPr();
    } catch {
      pr = null;
    }
    const decision = decideHold(state, {
      nowMs: deps.now(),
      pr,
      tunnelAlive: deps.tunnelAlive(),
    });
    if (decision.stop) return decision.stop;
    state = { ...state, consecutiveFailures: decision.consecutiveFailures };
    await deps.sleep(POLL_INTERVAL_MS);
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function ghFetchPr(repo: string, pr: string): Promise<PrState> {
  const proc = Bun.spawn(["gh", "api", `repos/${repo}/pulls/${pr}`], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, code] = await Promise.all([
    new Response(proc.stdout).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`gh api exited ${code}`);
  const json = JSON.parse(out) as {
    state: string;
    head: { sha: string };
    labels: { name: string }[];
  };
  return {
    open: json.state === "open",
    labels: json.labels.map((l) => l.name),
    headSha: json.head.sha,
  };
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv, [
    "--repo",
    "--pr",
    "--sha",
    "--job-start",
    "--tunnel-pid",
    "--window-minutes",
  ] as const);
  const repo = flags["--repo"];
  const pr = flags["--pr"];
  const sha = flags["--sha"];
  const jobStart = Number(flags["--job-start"]);
  const tunnelPid = Number(flags["--tunnel-pid"]);
  if (!repo || !pr || !sha || !Number.isFinite(jobStart) || !tunnelPid) {
    console.error(
      "usage: preview-hold.ts --repo <o/r> --pr <n> --sha <sha> --job-start <epoch-seconds> --tunnel-pid <pid> [--window-minutes <n>]",
    );
    process.exit(1);
  }
  const windowMinutes = flags["--window-minutes"]
    ? Number(flags["--window-minutes"])
    : DEFAULT_WINDOW_MINUTES;
  const jobStartMs = jobStart * 1000;
  const reason = await runHold(
    {
      jobStartMs,
      windowEndMs: computeWindowEnd(jobStartMs, Date.now(), windowMinutes),
      previewedSha: sha,
    },
    {
      now: Date.now,
      fetchPr: () => ghFetchPr(repo, pr),
      tunnelAlive: () => pidAlive(tunnelPid),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    },
  );
  console.log(reason);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(`[preview-hold] FAILED: ${(err as Error).message}`);
    process.exit(1);
  });
}
