/**
 * agent/src/github-auth-startup.unit.test.ts
 *
 * Unit tests for startGitHubAuthIfPossible() and the "already active" ref —
 * pure logic, no I/O. The real setupGitHubAuth() call is a fake/spy injected
 * via StartGitHubAuthDeps; no real network, git, or `mock.module()` usage.
 */

import { describe, expect, it } from "bun:test";
import {
  createGitHubAuthActiveRef,
  createGitHubAuthStartGuard,
  githubAuthActiveRef,
  hasGitHubAppCredentials,
  type StartGitHubAuthDeps,
  startGitHubAuthIfPossible,
} from "./github-auth-startup.ts";

const COMPLETE_ENV: Record<string, string | undefined> = {
  GH_APP_ID: "12345",
  GH_APP_INSTALLATION_ID: "67890",
  GH_APP_PRIVATE_KEY:
    "-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----",
};

/**
 * Builds a fresh, fully-independent set of fakes for one test case —
 * mirrors production semantics (isActive flips true only after markActive)
 * but with no real GitHub App I/O, and returns spy call counters for
 * assertions.
 */
function buildFakeDeps(envOverrides?: Record<string, string | undefined>) {
  const activeRef = createGitHubAuthActiveRef();
  const guard = createGitHubAuthStartGuard();
  const calls = { setupGitHubAuth: 0 };

  const deps: StartGitHubAuthDeps = {
    env: { ...COMPLETE_ENV, ...envOverrides },
    isActive: activeRef.isActive,
    markActive: () => activeRef.setActive(true),
    setupGitHubAuth: async () => {
      calls.setupGitHubAuth++;
    },
    guard,
  };

  return { deps, calls, activeRef, guard };
}

describe("hasGitHubAppCredentials", () => {
  it("is true when all three GitHub App env vars are present", () => {
    expect(hasGitHubAppCredentials(COMPLETE_ENV)).toBe(true);
  });

  it("is false when GH_APP_ID is missing", () => {
    expect(
      hasGitHubAppCredentials({ ...COMPLETE_ENV, GH_APP_ID: undefined }),
    ).toBe(false);
  });

  it("is false when GH_APP_INSTALLATION_ID is missing", () => {
    expect(
      hasGitHubAppCredentials({
        ...COMPLETE_ENV,
        GH_APP_INSTALLATION_ID: undefined,
      }),
    ).toBe(false);
  });

  it("is false when GH_APP_PRIVATE_KEY is missing", () => {
    expect(
      hasGitHubAppCredentials({
        ...COMPLETE_ENV,
        GH_APP_PRIVATE_KEY: undefined,
      }),
    ).toBe(false);
  });

  it("is false when all three are missing", () => {
    expect(
      hasGitHubAppCredentials({
        GH_APP_ID: undefined,
        GH_APP_INSTALLATION_ID: undefined,
        GH_APP_PRIVATE_KEY: undefined,
      }),
    ).toBe(false);
  });
});

describe("startGitHubAuthIfPossible", () => {
  it("credentials complete on a later tick (not boot) triggers exactly one GitHub auth setup", async () => {
    const { deps, calls, activeRef } = buildFakeDeps();

    const started = await startGitHubAuthIfPossible(deps);

    expect(started).toBe(true);
    expect(calls.setupGitHubAuth).toBe(1);
    expect(activeRef.isActive()).toBe(true);
  });

  it("a later tick with GitHub auth already active does not re-trigger setup (regression: no duplicate refresh interval)", async () => {
    const { deps, calls } = buildFakeDeps();

    const first = await startGitHubAuthIfPossible(deps);
    const second = await startGitHubAuthIfPossible(deps);

    expect(first).toBe(true);
    expect(second).toBe(false);
    // Critical: setupGitHubAuth must be called exactly once across both
    // ticks — a second call would create a second GitHubTokenManager with
    // its own independent background-refresh interval that the first
    // manager's stopBackgroundRefresh() never touches (see module docstring).
    expect(calls.setupGitHubAuth).toBe(1);
  });

  it("a tick with incomplete credentials (missing GH_APP_ID) does not attempt setup", async () => {
    const { deps, calls } = buildFakeDeps({ GH_APP_ID: undefined });

    const started = await startGitHubAuthIfPossible(deps);

    expect(started).toBe(false);
    expect(calls.setupGitHubAuth).toBe(0);
  });

  it("a tick with incomplete credentials (missing GH_APP_INSTALLATION_ID) does not attempt setup", async () => {
    const { deps, calls } = buildFakeDeps({
      GH_APP_INSTALLATION_ID: undefined,
    });

    const started = await startGitHubAuthIfPossible(deps);

    expect(started).toBe(false);
    expect(calls.setupGitHubAuth).toBe(0);
  });

  it("a tick with incomplete credentials (missing GH_APP_PRIVATE_KEY) does not attempt setup", async () => {
    const { deps, calls } = buildFakeDeps({ GH_APP_PRIVATE_KEY: undefined });

    const started = await startGitHubAuthIfPossible(deps);

    expect(started).toBe(false);
    expect(calls.setupGitHubAuth).toBe(0);
  });

  it("a tick with all credentials missing does not attempt setup", async () => {
    const { deps, calls } = buildFakeDeps({
      GH_APP_ID: undefined,
      GH_APP_INSTALLATION_ID: undefined,
      GH_APP_PRIVATE_KEY: undefined,
    });

    const started = await startGitHubAuthIfPossible(deps);

    expect(started).toBe(false);
    expect(calls.setupGitHubAuth).toBe(0);
  });

  it("overlapping/concurrent calls (two ticks racing before the first setup resolves) do not double-setup", async () => {
    const { deps, calls } = buildFakeDeps();

    let releaseSetup: () => void = () => {};
    const setupGate = new Promise<void>((resolve) => {
      releaseSetup = resolve;
    });
    deps.setupGitHubAuth = async () => {
      await setupGate;
      calls.setupGitHubAuth++;
    };

    const firstCall = startGitHubAuthIfPossible(deps);
    const secondCall = startGitHubAuthIfPossible(deps);

    releaseSetup();
    const [first, second] = await Promise.all([firstCall, secondCall]);

    expect([first, second].filter(Boolean)).toHaveLength(1);
    expect(calls.setupGitHubAuth).toBe(1);
  });

  it("errors from setupGitHubAuth propagate to the caller rather than being swallowed", async () => {
    const { deps } = buildFakeDeps();
    deps.setupGitHubAuth = async () => {
      throw new Error("boom");
    };

    await expect(startGitHubAuthIfPossible(deps)).rejects.toThrow("boom");
  });

  it("errors from setupGitHubAuth do not mark GitHub auth active, so a subsequent retry can proceed", async () => {
    const { deps, calls, activeRef, guard } = buildFakeDeps();
    deps.setupGitHubAuth = async () => {
      throw new Error("boom");
    };

    await expect(startGitHubAuthIfPossible(deps)).rejects.toThrow("boom");
    expect(activeRef.isActive()).toBe(false);
    expect(guard.isInFlight()).toBe(false);

    // Retry with working deps — should succeed since setup never actually completed.
    deps.setupGitHubAuth = async () => {
      calls.setupGitHubAuth++;
    };
    const started = await startGitHubAuthIfPossible(deps);
    expect(started).toBe(true);
    expect(activeRef.isActive()).toBe(true);
  });
});

describe("GitHubAuthActiveRef", () => {
  it("createGitHubAuthActiveRef() defaults to inactive", () => {
    const ref = createGitHubAuthActiveRef();
    expect(ref.isActive()).toBe(false);
  });

  it("setActive(true) is reflected by the next isActive()", () => {
    const ref = createGitHubAuthActiveRef();
    ref.setActive(true);
    expect(ref.isActive()).toBe(true);
  });

  it("multiple independent ref instances don't share state", () => {
    const refA = createGitHubAuthActiveRef();
    const refB = createGitHubAuthActiveRef();

    refA.setActive(true);

    expect(refA.isActive()).toBe(true);
    expect(refB.isActive()).toBe(false);
  });
});

describe("githubAuthActiveRef (process-wide singleton)", () => {
  it("is a working ref, independent of createGitHubAuthActiveRef() instances", () => {
    const independent = createGitHubAuthActiveRef();
    independent.setActive(true);

    expect(githubAuthActiveRef.isActive()).toBe(false);
    githubAuthActiveRef.setActive(true);
    expect(githubAuthActiveRef.isActive()).toBe(true);
    expect(independent.isActive()).toBe(true);

    // Reset the process-wide singleton so this test doesn't leak state into siblings.
    githubAuthActiveRef.setActive(false);
  });
});
