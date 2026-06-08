/**
 * agent/src/github-app-auth.integration.test.ts
 *
 * Integration tests for GitHubTokenManager — background refresh cycle using
 * a RecordedGitHubAppClient and fake timer injection (no real timers).
 *
 * Isolation contract: no mock.module(), no global overrides, no real network.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { GitHubTokenManager } from "./github-app-auth.ts";

// ─── Recorded client double ───────────────────────────────────────────────────

interface AuthCall {
  timestamp: number;
  params: { type: string; installationId?: number } | undefined;
}

class RecordedGitHubAppClient {
  calls: AuthCall[] = [];
  private callCount = 0;

  async auth(params?: { type: string; installationId?: number }): Promise<{
    token: string;
    expiresAt: string;
    type: string;
    tokenType: string;
  }> {
    this.callCount += 1;
    this.calls.push({ timestamp: Date.now(), params });
    const tokenIndex = this.callCount;
    // Use a fixed future timestamp so token freshness is not wall-clock dependent
    const FIXED_FUTURE = new Date("2099-01-01T00:00:00Z");
    return {
      token: `fake-token-${tokenIndex}`,
      expiresAt: FIXED_FUTURE.toISOString(),
      type: "token",
      tokenType: "installation",
    };
  }

}

// ─── Fake timer infrastructure ────────────────────────────────────────────────

/**
 * FakeTimerControl provides fake setInterval/clearInterval functions that can
 * be injected into GitHubTokenManager. Intervals are triggered manually via
 * tick() — no real time passes.
 */
class FakeTimerControl {
  private callbacks: Map<number, () => void> = new Map();
  private nextId = 1;
  clearedIds: number[] = [];
  registeredIntervalMs: number[] = [];

  /** Returns a fake setInterval suitable for constructor injection. */
  get setIntervalFn(): typeof setInterval {
    const self = this;
    return function fakeSetInterval(fn: unknown, ms?: unknown): ReturnType<typeof setInterval> {
      const id = self.nextId++;
      self.callbacks.set(id, fn as () => void);
      self.registeredIntervalMs.push(ms as number);
      return id as unknown as ReturnType<typeof setInterval>;
    } as unknown as typeof setInterval;
  }

  /** Returns a fake clearInterval suitable for constructor injection. */
  get clearIntervalFn(): typeof clearInterval {
    const self = this;
    return function fakeClearInterval(id: unknown): void {
      const numId = id as number;
      self.callbacks.delete(numId);
      self.clearedIds.push(numId);
    } as unknown as typeof clearInterval;
  }

  /** Manually fire the interval callback N times. */
  tick(times = 1): void {
    for (let i = 0; i < times; i++) {
      for (const fn of this.callbacks.values()) {
        fn();
      }
    }
  }

  get activeTimerCount(): number {
    return this.callbacks.size;
  }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("GitHubTokenManager — background refresh (integration)", () => {
  let client: RecordedGitHubAppClient;
  let timers: FakeTimerControl;
  let manager: GitHubTokenManager;

  beforeEach(() => {
    client = new RecordedGitHubAppClient();
    timers = new FakeTimerControl();
    manager = new GitHubTokenManager({
      auth: (params) => client.auth(params),
      installationId: 42,
      setIntervalFn: timers.setIntervalFn,
      clearIntervalFn: timers.clearIntervalFn,
    });
  });

  it("getToken() calls auth once and caches the result", async () => {
    const token1 = await manager.getToken();
    const token2 = await manager.getToken();
    expect(token1).toBe("fake-token-1");
    expect(token2).toBe("fake-token-1"); // cached
    expect(client.calls.length).toBe(1);
  });

  it("startBackgroundRefresh() fires onRefresh callback each tick", async () => {
    const refreshed: string[] = [];
    manager.startBackgroundRefresh(async (token) => {
      refreshed.push(token);
    });

    // Tick 3 times — each tick should call auth and invoke onRefresh
    timers.tick(3);

    // Give async callbacks time to resolve
    await new Promise((r) => setTimeout(r, 50));

    expect(refreshed.length).toBe(3);
    expect(refreshed[0]).toBe("fake-token-1");
    expect(refreshed[1]).toBe("fake-token-2");
    expect(refreshed[2]).toBe("fake-token-3");
    // RecordedGitHubAppClient was called once per tick (cache cleared each refresh)
    expect(client.calls.length).toBe(3);
  });

  it("startBackgroundRefresh() registers exactly one interval at 30-minute cadence", async () => {
    manager.startBackgroundRefresh(async () => {});
    expect(timers.activeTimerCount).toBe(1);
    expect(timers.registeredIntervalMs[0]).toBe(30 * 60 * 1000);
  });

  it("stopBackgroundRefresh() clears the interval", async () => {
    manager.startBackgroundRefresh(async () => {});
    expect(timers.activeTimerCount).toBe(1);
    manager.stopBackgroundRefresh();
    expect(timers.activeTimerCount).toBe(0);
  });

  it("calling startBackgroundRefresh() twice replaces the previous timer", async () => {
    manager.startBackgroundRefresh(async () => {});
    manager.startBackgroundRefresh(async () => {});
    // Old timer was cleared, new one registered
    expect(timers.activeTimerCount).toBe(1);
    expect(timers.clearedIds.length).toBe(1);
  });

  it("onRefresh receives distinct tokens across multiple ticks", async () => {
    const tokens: string[] = [];
    manager.startBackgroundRefresh(async (t) => { tokens.push(t); });
    timers.tick(5);
    await new Promise((r) => setTimeout(r, 50));
    const unique = new Set(tokens);
    expect(unique.size).toBe(5);
  });
});
