/**
 * agent/src/github-app-auth.integration.test.ts
 *
 * Integration tests for GitHubTokenManager — background refresh cycle using
 * a RecordedGitHubAppClient and fake timer injection (no real timers).
 *
 * Isolation contract: no mock.module(), no global overrides, no real network.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { FixedClock } from "./clock.ts";
import {
  createGitHubTokenManager,
  fetchBotIdentity,
  type FetchFn,
  getBotIdentity,
  GitHubTokenManager,
} from "./github-app-auth.ts";

// ─── Test RSA key pair (generated at test time — pure computation, no I/O) ────
// @octokit/auth-app signs a real JWT, so fetchBotIdentity needs a structurally
// valid RSA private key. Generated fresh per test run; never a real App key.

const { privateKey: TEST_PRIVATE_KEY } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "pkcs1", format: "pem" },
});

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
    return function fakeSetInterval(
      fn: unknown,
      ms?: unknown,
    ): ReturnType<typeof setInterval> {
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
    manager.startBackgroundRefresh(async (t) => {
      tokens.push(t);
    });
    timers.tick(5);
    await new Promise((r) => setTimeout(r, 50));
    const unique = new Set(tokens);
    expect(unique.size).toBe(5);
  });

  it("getToken() re-auths when token is near expiry (within 5-minute buffer)", async () => {
    // Anchor clock to a fixed point in time
    const now = new Date("2040-06-01T12:00:00Z");
    const clock = FixedClock(now);

    // Token expires 3 minutes from now — inside the 5-minute REFRESH_BUFFER_MS
    const nearExpiryDate = new Date(now.getTime() + 3 * 60 * 1000);

    // Override the RecordedGitHubAppClient to return the near-expiry timestamp
    const nearExpiryClient = {
      calls: [] as AuthCall[],
      callCount: 0,
      async auth(params?: { type: string; installationId?: number }) {
        nearExpiryClient.callCount += 1;
        nearExpiryClient.calls.push({ timestamp: Date.now(), params });
        return {
          token: `near-expiry-token-${nearExpiryClient.callCount}`,
          expiresAt: nearExpiryDate.toISOString(),
          type: "token",
          tokenType: "installation",
        };
      },
    };

    const nearExpiryManager = new GitHubTokenManager({
      auth: (params) => nearExpiryClient.auth(params),
      installationId: 42,
      setIntervalFn: timers.setIntervalFn,
      clearIntervalFn: timers.clearIntervalFn,
      clock,
    });

    // First call: cache miss, fetches token
    const token1 = await nearExpiryManager.getToken();
    expect(token1).toBe("near-expiry-token-1");
    expect(nearExpiryClient.callCount).toBe(1);

    // Second call: token is near expiry (3 min < 5 min buffer) — must re-auth
    const token2 = await nearExpiryManager.getToken();
    expect(token2).toBe("near-expiry-token-2");
    expect(nearExpiryClient.callCount).toBe(2);
  });
});

// ─── createGitHubTokenManager() — env var wiring & missing-config errors ─────

describe("createGitHubTokenManager() — env var wiring", () => {
  const ORIGINAL_ENV = {
    GH_APP_ID: process.env.GH_APP_ID,
    GH_APP_PRIVATE_KEY: process.env.GH_APP_PRIVATE_KEY,
    GH_APP_INSTALLATION_ID: process.env.GH_APP_INSTALLATION_ID,
  };

  afterEach(() => {
    process.env.GH_APP_ID = ORIGINAL_ENV.GH_APP_ID;
    process.env.GH_APP_PRIVATE_KEY = ORIGINAL_ENV.GH_APP_PRIVATE_KEY;
    process.env.GH_APP_INSTALLATION_ID = ORIGINAL_ENV.GH_APP_INSTALLATION_ID;
  });

  it("throws when GH_APP_ID is missing", () => {
    process.env.GH_APP_ID = undefined;
    process.env.GH_APP_PRIVATE_KEY = TEST_PRIVATE_KEY;
    process.env.GH_APP_INSTALLATION_ID = "123";

    expect(() => createGitHubTokenManager()).toThrow(
      /Missing required env vars/,
    );
  });

  it("throws when GH_APP_PRIVATE_KEY is missing", () => {
    process.env.GH_APP_ID = "12345";
    process.env.GH_APP_PRIVATE_KEY = undefined;
    process.env.GH_APP_INSTALLATION_ID = "123";

    expect(() => createGitHubTokenManager()).toThrow(
      /Missing required env vars/,
    );
  });

  it("throws when GH_APP_INSTALLATION_ID is missing", () => {
    process.env.GH_APP_ID = "12345";
    process.env.GH_APP_PRIVATE_KEY = TEST_PRIVATE_KEY;
    process.env.GH_APP_INSTALLATION_ID = undefined;

    expect(() => createGitHubTokenManager()).toThrow(
      /Missing required env vars/,
    );
  });

  it("throws when GH_APP_INSTALLATION_ID is not a valid number (0/NaN is falsy)", () => {
    process.env.GH_APP_ID = "12345";
    process.env.GH_APP_PRIVATE_KEY = TEST_PRIVATE_KEY;
    process.env.GH_APP_INSTALLATION_ID = "not-a-number";

    expect(() => createGitHubTokenManager()).toThrow(
      /Missing required env vars/,
    );
  });

  it("builds a GitHubTokenManager and unescapes literal \\n sequences in the private key", () => {
    process.env.GH_APP_ID = "12345";
    process.env.GH_APP_PRIVATE_KEY = TEST_PRIVATE_KEY.replace(/\n/g, "\\n");
    process.env.GH_APP_INSTALLATION_ID = "999";

    const manager = createGitHubTokenManager();
    expect(manager).toBeInstanceOf(GitHubTokenManager);
  });
});

// ─── fetchBotIdentity() — success & error branches (injected fetchFn) ────────

describe("fetchBotIdentity() (integration)", () => {
  function fakeFetch(opts: {
    appStatus?: number;
    appBody?: unknown;
    userStatus?: number;
    userBody?: unknown;
  }): FetchFn {
    const {
      appStatus = 200,
      appBody = { slug: "shipwright-bot", name: "Shipwright Bot" },
      userStatus = 200,
      userBody = { id: 987654 },
    } = opts;

    return (async (url: string | URL | Request) => {
      const urlStr = url.toString();
      if (urlStr === "https://api.github.com/app") {
        return new Response(JSON.stringify(appBody), {
          status: appStatus,
          statusText: appStatus >= 400 ? "Error" : "OK",
        });
      }
      // GET /users/:slug[bot]
      return new Response(JSON.stringify(userBody), {
        status: userStatus,
        statusText: userStatus >= 400 ? "Error" : "OK",
      });
    }) as FetchFn;
  }

  it("resolves the bot identity on success (slug, name, userId)", async () => {
    const fetchFn = fakeFetch({});
    const identity = await fetchBotIdentity("12345", TEST_PRIVATE_KEY, fetchFn);

    expect(identity).toEqual({
      slug: "shipwright-bot",
      name: "Shipwright Bot",
      userId: 987654,
    });
  });

  it("throws when GET /app returns a non-ok status", async () => {
    const fetchFn = fakeFetch({ appStatus: 401 });

    let caught: unknown;
    try {
      await fetchBotIdentity("12345", TEST_PRIVATE_KEY, fetchFn);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain("GET /app failed: 401");
  });

  it("throws when GET /users/:slug[bot] returns a non-ok status", async () => {
    const fetchFn = fakeFetch({ userStatus: 404 });

    let caught: unknown;
    try {
      await fetchBotIdentity("12345", TEST_PRIVATE_KEY, fetchFn);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain(
      "GET /users/shipwright-bot[bot] failed: 404",
    );
  });

  it("URL-encodes the bot username lookup (slug[bot])", async () => {
    const calls: string[] = [];
    const fetchFn: FetchFn = (async (url: string | URL | Request) => {
      const urlStr = url.toString();
      calls.push(urlStr);
      if (urlStr === "https://api.github.com/app") {
        return new Response(
          JSON.stringify({ slug: "my-app", name: "My App" }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ id: 1 }), { status: 200 });
    }) as FetchFn;

    await fetchBotIdentity("12345", TEST_PRIVATE_KEY, fetchFn);

    expect(calls[1]).toBe(
      `https://api.github.com/users/${encodeURIComponent("my-app[bot]")}`,
    );
  });
});

// ─── getBotIdentity() — missing env var errors ───────────────────────────────

describe("getBotIdentity() — missing env var errors", () => {
  const ORIGINAL_ENV = {
    GH_APP_ID: process.env.GH_APP_ID,
    GH_APP_PRIVATE_KEY: process.env.GH_APP_PRIVATE_KEY,
  };

  afterEach(() => {
    process.env.GH_APP_ID = ORIGINAL_ENV.GH_APP_ID;
    process.env.GH_APP_PRIVATE_KEY = ORIGINAL_ENV.GH_APP_PRIVATE_KEY;
  });

  it("throws when GH_APP_ID is missing", () => {
    process.env.GH_APP_ID = undefined;
    process.env.GH_APP_PRIVATE_KEY = TEST_PRIVATE_KEY;

    expect(() => getBotIdentity()).toThrow(/Missing required env vars/);
  });

  it("throws when GH_APP_PRIVATE_KEY is missing", () => {
    process.env.GH_APP_ID = "12345";
    process.env.GH_APP_PRIVATE_KEY = undefined;

    expect(() => getBotIdentity()).toThrow(/Missing required env vars/);
  });
});
