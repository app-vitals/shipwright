/**
 * agent/src/slack-startup.unit.test.ts
 *
 * Unit tests for startSlackIfPossible() and the Slack client ref — pure
 * logic, no I/O. All Slack/Bolt/DM calls are fakes/spies injected via
 * StartSlackDeps; no real network or `mock.module()` usage.
 */

import type { WebClient } from "@slack/web-api";
import { describe, expect, it } from "bun:test";
import {
  createSlackClientRef,
  createSlackStartGuard,
  slackClientRef,
  startSlackIfPossible,
  type StartableSlackApp,
  type StartSlackDeps,
} from "./slack-startup.ts";

/** Builds a minimal fake WebClient stand-in for identity/shape assertions. */
function fakeClient(tag: string): WebClient {
  return { fake: tag } as unknown as WebClient;
}

/**
 * Builds a fresh, fully-independent set of fakes for one test case —
 * mirrors production semantics (isAppStarted flips true only after setApp)
 * but with no real Slack I/O, and returns spy call counters for assertions.
 */
function buildFakeDeps(overrides?: {
  botToken?: string;
  appToken?: string;
}) {
  let appStarted: StartableSlackApp | undefined;
  const calls = {
    createSlackApp: 0,
    appStart: 0,
    setApp: 0,
    markSlackConnected: 0,
    createSlackClient: 0,
    setSlackClient: 0,
    sendBackOnlineDm: 0,
  };

  const clientRef = createSlackClientRef();
  const guard = createSlackStartGuard();

  const deps: StartSlackDeps = {
    buildSlackConfig: () => ({
      botToken: overrides?.botToken ?? "xoxb-live",
      appToken: overrides?.appToken ?? "xapp-live",
      signingSecret: "shh",
    }),
    hasSlackCredentials: (cfg) =>
      cfg.botToken.trim() !== "" && cfg.appToken.trim() !== "",
    isAppStarted: () => appStarted !== undefined,
    createSlackApp: () => {
      calls.createSlackApp++;
      return {
        start: async () => {
          calls.appStart++;
        },
      };
    },
    setApp: (app) => {
      calls.setApp++;
      appStarted = app;
    },
    createSlackClient: () => {
      calls.createSlackClient++;
      // A minimal stand-in — startSlackIfPossible only threads this through
      // to setSlackClient/sendBackOnlineDm, never calls real WebClient methods.
      return fakeClient("started");
    },
    setSlackClient: (client) => {
      calls.setSlackClient++;
      clientRef.set(client);
    },
    markSlackConnected: () => {
      calls.markSlackConnected++;
    },
    sendBackOnlineDm: async () => {
      calls.sendBackOnlineDm++;
    },
    guard,
  };

  return {
    deps,
    calls,
    clientRef,
    guard,
    isStarted: () => appStarted !== undefined,
  };
}

describe("startSlackIfPossible", () => {
  it("credentials complete on a later tick (not boot) triggers exactly one Slack start", async () => {
    const { deps, calls, clientRef } = buildFakeDeps();

    const started = await startSlackIfPossible(deps);

    expect(started).toBe(true);
    expect(calls.createSlackApp).toBe(1);
    expect(calls.appStart).toBe(1);
    expect(calls.setApp).toBe(1);
    expect(calls.markSlackConnected).toBe(1);
    expect(calls.createSlackClient).toBe(1);
    expect(calls.sendBackOnlineDm).toBe(1);
    expect(clientRef.get()).toBeDefined();
    expect((clientRef.get() as unknown as { fake: string }).fake).toBe(
      "started",
    );
  });

  it("a later tick with the app already started does not re-trigger a start", async () => {
    const { deps, calls } = buildFakeDeps();

    const first = await startSlackIfPossible(deps);
    const second = await startSlackIfPossible(deps);

    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(calls.createSlackApp).toBe(1);
    expect(calls.appStart).toBe(1);
    expect(calls.setApp).toBe(1);
    expect(calls.markSlackConnected).toBe(1);
    expect(calls.sendBackOnlineDm).toBe(1);
  });

  it("a tick with still-incomplete credentials (missing app token) does not attempt a start", async () => {
    const { deps, calls } = buildFakeDeps({
      botToken: "xoxb-live",
      appToken: "",
    });

    const started = await startSlackIfPossible(deps);

    expect(started).toBe(false);
    expect(calls.createSlackApp).toBe(0);
    expect(calls.appStart).toBe(0);
    expect(calls.setApp).toBe(0);
    expect(calls.markSlackConnected).toBe(0);
    expect(calls.createSlackClient).toBe(0);
    expect(calls.sendBackOnlineDm).toBe(0);
  });

  it("a tick with still-incomplete credentials (missing bot token) does not attempt a start", async () => {
    const { deps, calls } = buildFakeDeps({
      botToken: "",
      appToken: "xapp-live",
    });

    const started = await startSlackIfPossible(deps);

    expect(started).toBe(false);
    expect(calls.createSlackApp).toBe(0);
    expect(calls.appStart).toBe(0);
  });

  it("a tick with both credentials missing does not attempt a start", async () => {
    const { deps, calls } = buildFakeDeps({ botToken: "", appToken: "" });

    const started = await startSlackIfPossible(deps);

    expect(started).toBe(false);
    expect(calls.createSlackApp).toBe(0);
  });

  it("overlapping/concurrent calls (two ticks racing before the first app.start() resolves) do not double-start", async () => {
    const { deps, calls } = buildFakeDeps();

    // Make app.start() hang until we let both calls race against it, so the
    // second call's isAppStarted() check still sees "not started" while the
    // first is mid-flight — the in-flight guard, not timing luck, must be
    // what prevents a double start.
    let releaseStart: () => void = () => {};
    const startGate = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    deps.createSlackApp = () => {
      calls.createSlackApp++;
      return {
        start: async () => {
          await startGate;
          calls.appStart++;
        },
      };
    };

    const firstCall = startSlackIfPossible(deps);
    const secondCall = startSlackIfPossible(deps);

    releaseStart();
    const [first, second] = await Promise.all([firstCall, secondCall]);

    expect([first, second].filter(Boolean)).toHaveLength(1);
    expect(calls.createSlackApp).toBe(1);
    expect(calls.appStart).toBe(1);
    expect(calls.setApp).toBe(1);
    expect(calls.markSlackConnected).toBe(1);
    expect(calls.sendBackOnlineDm).toBe(1);
  });

  it("app already started before syncConfig's first tick (boot succeeded) is a no-op", async () => {
    const { deps, calls } = buildFakeDeps();

    // Simulate boot having already started Bolt.
    await startSlackIfPossible(deps);
    calls.createSlackApp = 0;
    calls.appStart = 0;
    calls.setApp = 0;
    calls.markSlackConnected = 0;
    calls.sendBackOnlineDm = 0;

    const started = await startSlackIfPossible(deps);

    expect(started).toBe(false);
    expect(calls.createSlackApp).toBe(0);
    expect(calls.appStart).toBe(0);
    expect(calls.setApp).toBe(0);
    expect(calls.markSlackConnected).toBe(0);
    expect(calls.sendBackOnlineDm).toBe(0);
  });

  it("errors from app.start() propagate to the caller rather than being swallowed", async () => {
    const { deps } = buildFakeDeps();
    deps.createSlackApp = () => ({
      start: async () => {
        throw new Error("boom");
      },
    });

    await expect(startSlackIfPossible(deps)).rejects.toThrow("boom");
  });

  it("errors from app.start() release the in-flight guard so a subsequent retry can proceed", async () => {
    const { deps, calls, guard } = buildFakeDeps();
    deps.createSlackApp = () => ({
      start: async () => {
        throw new Error("boom");
      },
    });

    await expect(startSlackIfPossible(deps)).rejects.toThrow("boom");
    expect(guard.isInFlight()).toBe(false);

    // Retry with working deps — should succeed since the app never actually started.
    deps.createSlackApp = () => {
      calls.createSlackApp++;
      return {
        start: async () => {
          calls.appStart++;
        },
      };
    };
    const started = await startSlackIfPossible(deps);
    expect(started).toBe(true);
  });
});

describe("SlackClientRef", () => {
  it("createSlackClientRef() defaults to undefined (no client yet)", () => {
    const ref = createSlackClientRef();
    expect(ref.get()).toBeUndefined();
  });

  it("set() replaces the current client, reflected by the next get()", () => {
    const ref = createSlackClientRef();
    const client = fakeClient("a");

    ref.set(client);
    expect(ref.get()).toBe(client);
  });

  it("multiple independent ref instances don't share state", () => {
    const refA = createSlackClientRef();
    const refB = createSlackClientRef();
    const client = fakeClient("a");

    refA.set(client);

    expect(refA.get()).toBe(client);
    expect(refB.get()).toBeUndefined();
  });
});

describe("slackClientRef (process-wide singleton)", () => {
  it("is a working ref that reflects set() through get(), independent of createSlackClientRef() instances", () => {
    const independent = createSlackClientRef();
    const leakClient = fakeClient("should-not-leak");
    independent.set(leakClient);

    const realClient = fakeClient("real");
    slackClientRef.set(realClient);

    expect(slackClientRef.get()).toBe(realClient);
    expect(independent.get()).toBe(leakClient);

    // Reset the process-wide singleton so this test doesn't leak state into siblings.
    slackClientRef.set(undefined);
  });
});
