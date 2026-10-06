/**
 * GitHubInstallationsReporter — reports the installations manager's state to
 * the admin API: PUT /agents/:agentId/github-installations (replace-all).
 *
 * Posts a full snapshot when the state signature changes (discovered,
 * removed, ok <-> broken) and on a heartbeat once HEARTBEAT_MS has passed
 * since the last post; a report with no change inside the heartbeat window
 * posts nothing. Same fire-and-forget contract as WorkQueueReporter: never
 * throws, swallows non-2xx and thrown errors with console.warn, injectable
 * `fetchFn` and `clock`. The payload is built from a fixed allowlist of
 * fields with constant error strings — no token, key, or raw response body.
 *
 * HttpGitHubInstallationsReporter: production implementation.
 * NoopGitHubInstallationsReporter: testing / default when not configured.
 */

import { type Clock, SystemClock } from "./clock.ts";
import type {
  InstallationState,
  InstallationsSnapshot,
} from "./github-installations.ts";

export const INSTALLATIONS_HEARTBEAT_MS = 30 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 10_000;

export interface GitHubInstallationsReporter {
  /** Fire-and-forget: never throws, never blocks the caller on a failed PUT. */
  report(snapshot: InstallationsSnapshot): Promise<void>;
}

export interface ReportedInstallation {
  owner: string;
  installationId: number;
  state: InstallationState["health"];
  lastError: string | null;
}

const REASON_TEXT: Record<NonNullable<InstallationState["reason"]>, string> = {
  suspended: "installation suspended",
  mint_rejected: "installation token mint rejected",
};

function toReported(i: InstallationState): ReportedInstallation {
  return {
    owner: i.owner ?? "unknown",
    installationId: i.id,
    state: i.health,
    lastError: i.reason ? REASON_TEXT[i.reason] : null,
  };
}

export interface HttpGitHubInstallationsReporterOptions {
  apiUrl: string;
  agentId: string;
  apiKey: string;
  fetchFn?: typeof fetch;
  clock?: Clock;
  heartbeatMs?: number;
}

export class HttpGitHubInstallationsReporter
  implements GitHubInstallationsReporter
{
  private readonly fetchFn: typeof fetch;
  private readonly clock: Clock;
  private readonly heartbeatMs: number;
  private lastSignature: string | null = null;
  private lastPostedAt = 0;

  constructor(private opts: HttpGitHubInstallationsReporterOptions) {
    this.fetchFn = opts.fetchFn ?? fetch;
    this.clock = opts.clock ?? SystemClock();
    this.heartbeatMs = opts.heartbeatMs ?? INSTALLATIONS_HEARTBEAT_MS;
  }

  async report(snapshot: InstallationsSnapshot): Promise<void> {
    try {
      const installations = snapshot.installations.map(toReported);
      const signature = JSON.stringify(installations);
      const nowMs = this.clock.now().getTime();
      const changed = signature !== this.lastSignature;
      if (!changed && nowMs - this.lastPostedAt < this.heartbeatMs) return;
      // Claim the slot before awaiting so overlapping reports don't double-post.
      this.lastSignature = signature;
      this.lastPostedAt = nowMs;
      await this.put(installations, new Date(nowMs).toISOString());
    } catch (err) {
      console.warn(
        `[github-installations-reporter] report failed: ${String(err)} — swallowing`,
      );
    }
  }

  private async put(
    installations: ReportedInstallation[],
    reportedAt: string,
  ): Promise<void> {
    const { apiUrl, agentId, apiKey } = this.opts;
    const url = `${apiUrl}/agents/${agentId}/github-installations`;
    try {
      const res = await this.fetchFn(url, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ reportedAt, installations }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!res.ok) {
        this.lastSignature = null; // retry on the next report
        console.warn(
          `[github-installations-reporter] PUT ${url} returned ${res.status} — swallowing`,
        );
      }
    } catch (err) {
      this.lastSignature = null;
      console.warn(
        `[github-installations-reporter] PUT ${url} failed: ${String(err)} — swallowing`,
      );
    }
  }
}

export class NoopGitHubInstallationsReporter
  implements GitHubInstallationsReporter
{
  async report(_snapshot: InstallationsSnapshot): Promise<void> {
    // intentional no-op
  }
}

/**
 * Drives the heartbeat: the manager only calls onChange on a state change, so
 * a quiet period needs its own tick to re-report the current state.
 */
export function startInstallationsHeartbeat(
  reporter: GitHubInstallationsReporter,
  getState: () => InstallationsSnapshot,
  opts: { setIntervalFn?: typeof setInterval; tickMs?: number } = {},
): () => void {
  const setIntervalFn = opts.setIntervalFn ?? setInterval;
  const timer = setIntervalFn(
    () => {
      void reporter.report(getState());
    },
    opts.tickMs ?? 5 * 60 * 1000,
  );
  return () => clearInterval(timer);
}
