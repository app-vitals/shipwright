/**
 * Integration tests for GitHubInstallationsManager with injected auth,
 * fetchFn, Clock and a fake setIntervalFn. No real network or timers.
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import {
  GitHubInstallationsManager,
  type InstallationEvent,
  type InstallationsSnapshot,
} from "./github-installations.ts";

const SECRET_TOKEN = "ghs_SECRET_TOKEN_VALUE";
const SECRET_JWT = "eyJ.SECRET.JWT";

type Raw = { id: number; owner: string; suspended?: boolean };

function makeHarness(opts: { pinnedId?: number } = {}) {
  let installs: Raw[] = [];
  let discoveryStatus = 200;
  const mintBehavior = new Map<number, number | "network">(); // id -> failure
  const mintCalls: number[] = [];
  let mintSeq = 0;
  const events: InstallationEvent[] = [];
  const changes: InstallationsSnapshot[] = [];
  const intervals: { fn: () => void; ms: number; cleared: boolean }[] = [];

  const auth = async (p?: { type: string; installationId?: number }) => {
    if (!p) throw new Error("no params");
    if (p.type === "app")
      return {
        token: SECRET_JWT,
        expiresAt: "",
        type: "app",
        tokenType: "app",
      };
    const id = p.installationId as number;
    mintCalls.push(id);
    const fail = mintBehavior.get(id);
    if (fail === "network") throw new Error("socket hang up");
    if (fail) throw Object.assign(new Error("mint rejected"), { status: fail });
    return {
      token: `${SECRET_TOKEN}_${id}_${++mintSeq}`,
      expiresAt: new Date(Date.UTC(2030, 0, 1)).toISOString(),
      type: "token",
      tokenType: "installation",
    };
  };
  const fetchFn = (async () =>
    new Response(
      JSON.stringify(
        installs.map((i) => ({
          id: i.id,
          account: { login: i.owner },
          suspended_at: i.suspended ? "2026-01-01T00:00:00Z" : null,
        })),
      ),
      { status: discoveryStatus },
    )) as unknown as typeof fetch;
  const setIntervalFn = ((fn: () => void, ms: number) => {
    const rec = { fn, ms, cleared: false };
    intervals.push(rec);
    return rec as unknown as ReturnType<typeof setInterval>;
  }) as unknown as typeof setInterval;
  const clearIntervalFn = ((h: { cleared: boolean }) => {
    h.cleared = true;
  }) as unknown as typeof clearInterval;

  const manager = new GitHubInstallationsManager({
    auth,
    fetchFn,
    clock: { now: () => new Date(Date.UTC(2029, 0, 1)) },
    setIntervalFn,
    clearIntervalFn,
    pinnedId: opts.pinnedId,
    onEvent: (e) => events.push(e),
    onChange: (s) => changes.push(s),
  });
  return {
    manager,
    events,
    changes,
    intervals,
    mintCalls,
    mintBehavior,
    setInstalls: (i: Raw[]) => {
      installs = i;
    },
    setDiscoveryStatus: (s: number) => {
      discoveryStatus = s;
    },
  };
}

describe("GitHubInstallationsManager", () => {
  let logSpy: ReturnType<typeof spyOn>;
  let errSpy: ReturnType<typeof spyOn>;
  let logged: string[];
  beforeEach(() => {
    logged = [];
    logSpy = spyOn(console, "log").mockImplementation((...a) => {
      logged.push(a.map(String).join(" "));
    });
    errSpy = spyOn(console, "error").mockImplementation((...a) => {
      logged.push(a.map(String).join(" "));
    });
  });
  afterEach(() => {
    logSpy.mockRestore();
    errSpy.mockRestore();
  });

  it("creates exactly one interval for N installations", async () => {
    const h = makeHarness();
    h.setInstalls([
      { id: 1, owner: "a" },
      { id: 2, owner: "b" },
      { id: 3, owner: "c" },
    ]);
    await h.manager.reconcile(["a", "b", "c"]);
    h.manager.start();
    h.manager.start();
    expect(h.manager.getState().installations).toHaveLength(3);
    expect(h.intervals).toHaveLength(1);
    h.manager.stop();
    expect(h.intervals[0].cleared).toBe(true);
  });

  it("a broken installation does not affect the others' tokens", async () => {
    const h = makeHarness();
    h.setInstalls([
      { id: 1, owner: "a" },
      { id: 2, owner: "b" },
    ]);
    h.mintBehavior.set(1, 403);
    await h.manager.reconcile(["a", "b"]);
    await h.manager.refresh();
    const byId = new Map(
      h.manager.getState().installations.map((i) => [i.id, i]),
    );
    expect(byId.get(1)?.health).toBe("broken");
    expect(byId.get(1)?.reason).toBe("mint_rejected");
    expect(byId.get(2)?.health).toBe("ok");
    expect(await h.manager.getToken(2)).toContain("_2_");
    await expect(h.manager.getToken(1)).rejects.toThrow("broken");
    // broken installation is no longer retried on later ticks
    h.mintCalls.length = 0;
    await h.manager.refresh();
    expect(h.mintCalls).not.toContain(1);
  });

  it("treats suspended installations as broken without minting", async () => {
    const h = makeHarness();
    h.setInstalls([{ id: 1, owner: "a", suspended: true }]);
    await h.manager.reconcile(["a"]);
    await h.manager.refresh();
    expect(h.manager.getState().installations[0]).toMatchObject({
      health: "broken",
      reason: "suspended",
    });
    expect(h.mintCalls).toHaveLength(0);
  });

  it("recovers a suspended installation after it is unsuspended", async () => {
    const h = makeHarness();
    h.setInstalls([{ id: 1, owner: "a", suspended: true }]);
    await h.manager.reconcile(["a"]);
    await h.manager.refresh();
    expect(h.manager.getState().installations[0]).toMatchObject({
      health: "broken",
      reason: "suspended",
    });
    h.setInstalls([{ id: 1, owner: "a" }]);
    await h.manager.reconcile(["a"]);
    await h.manager.refresh();
    expect(h.manager.getState().installations[0]).toMatchObject({
      health: "ok",
      reason: null,
    });
    expect(h.mintCalls).toEqual([1]);
    expect(await h.manager.getToken(1)).toContain("_1_");
  });

  it("marks 404/422 broken but keeps 5xx and network errors transient", async () => {
    const h = makeHarness();
    h.setInstalls([
      { id: 1, owner: "a" },
      { id: 2, owner: "b" },
      { id: 3, owner: "c" },
      { id: 4, owner: "d" },
    ]);
    h.mintBehavior.set(1, 404);
    h.mintBehavior.set(2, 422);
    h.mintBehavior.set(3, 503);
    h.mintBehavior.set(4, "network");
    await h.manager.reconcile(["a", "b", "c", "d"]);
    await h.manager.refresh();
    const health = Object.fromEntries(
      h.manager.getState().installations.map((i) => [i.id, i.health]),
    );
    expect(health).toEqual({
      1: "broken",
      2: "broken",
      3: "unknown",
      4: "unknown",
    });
    // transient ones retry, and recover when the error clears
    h.mintBehavior.delete(3);
    await h.manager.refresh();
    expect(
      h.manager.getState().installations.find((i) => i.id === 3)?.health,
    ).toBe("ok");
    const failed = h.events.filter((e) => e.type === "mint_failed");
    expect(
      failed
        .slice(0, 4)
        .map((e) => (e.type === "mint_failed" ? e.statusClass : null)),
    ).toEqual(["4xx", "4xx", "5xx", "network"]);
  });

  it("emits minted, mint_failed, discovered and removed events", async () => {
    const h = makeHarness();
    h.setInstalls([
      { id: 1, owner: "a" },
      { id: 2, owner: "b" },
    ]);
    h.mintBehavior.set(2, 500);
    await h.manager.reconcile(["a", "b"]);
    await h.manager.refresh();
    h.setInstalls([{ id: 2, owner: "b" }]);
    await h.manager.reconcile(["a", "b"]);
    const types = new Set(h.events.map((e) => e.type));
    expect(types).toEqual(
      new Set(["discovered", "minted", "mint_failed", "removed"]),
    );
    expect(h.events).toContainEqual({ type: "removed", installationId: 1 });
    expect(h.events).toContainEqual({ type: "minted", installationId: 1 });
    expect(h.manager.getState().installations.map((i) => i.id)).toEqual([2]);
  });

  it("minted is emitted only when a new token is minted", async () => {
    const h = makeHarness();
    h.setInstalls([{ id: 1, owner: "a" }]);
    await h.manager.reconcile(["a"]);
    await h.manager.refresh();
    await h.manager.refresh();
    expect(h.events.filter((e) => e.type === "minted")).toHaveLength(1);
  });

  it("a discovery failure leaves the previous installation list in place", async () => {
    const h = makeHarness();
    h.setInstalls([{ id: 1, owner: "a" }]);
    await h.manager.reconcile(["a"]);
    h.setDiscoveryStatus(500);
    await h.manager.reconcile(["a"]);
    expect(h.manager.getState().installations.map((i) => i.id)).toEqual([1]);
    expect(h.events).toContainEqual({ type: "discovery_failed" });
    expect(h.events.some((e) => e.type === "removed")).toBe(false);
  });

  it("calls onChange only when state changes", async () => {
    const h = makeHarness();
    h.setInstalls([{ id: 1, owner: "a" }]);
    await h.manager.reconcile(["a"]);
    await h.manager.reconcile(["a"]);
    expect(h.changes).toHaveLength(1);
    await h.manager.refresh();
    expect(h.changes).toHaveLength(2);
    expect(h.changes[1].installations[0].health).toBe("ok");
  });

  it("never throws out of the timer, even when listeners or auth throw", async () => {
    const h = makeHarness();
    h.setInstalls([{ id: 1, owner: "a" }]);
    await h.manager.reconcile(["a"]);
    h.manager.start();
    h.mintBehavior.set(1, 500);
    expect(() => h.intervals[0].fn()).not.toThrow();
    await h.manager.refresh();
    const bad = new GitHubInstallationsManager({
      auth: async () => {
        throw new Error("jwt signing failed");
      },
      onEvent: () => {
        throw new Error("listener boom");
      },
    });
    await expect(bad.reconcile(["a"])).resolves.toBeUndefined();
    await expect(bad.refresh()).resolves.toBeUndefined();
  });

  it("uses a pinned id before scope is synced", async () => {
    const h = makeHarness({ pinnedId: 7 });
    h.setInstalls([
      { id: 7, owner: "a" },
      { id: 8, owner: "b" },
    ]);
    await h.manager.reconcile(null);
    expect(h.manager.getState()).toMatchObject({ defaultId: 7 });
    expect(h.manager.getState().installations.map((i) => i.id)).toEqual([7]);
  });

  it("never exposes token or key material in logs or events", async () => {
    const h = makeHarness();
    h.setInstalls([
      { id: 1, owner: "a" },
      { id: 2, owner: "b" },
    ]);
    h.mintBehavior.set(2, 403);
    await h.manager.reconcile(["a", "b"]);
    await h.manager.refresh();
    h.setDiscoveryStatus(500);
    await h.manager.reconcile(["a", "b"]);
    const blob = JSON.stringify([
      h.events,
      h.changes,
      h.manager.getState(),
      logged,
    ]);
    expect(blob).not.toContain("SECRET");
    expect(blob).not.toContain("ghs_");
  });
});
