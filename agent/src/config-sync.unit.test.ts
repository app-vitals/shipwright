/**
 * agent/src/config-sync.unit.test.ts
 *
 * Unit tests for startConfigSync — all dependencies injected (bundle source,
 * timer seams, env target, claude setter, log). No network, no globals.
 */

import { describe, expect, it } from "bun:test";
import type { AgentConfigResponse } from "@shipwright/admin";
import type { LiveClaudeConfig } from "./claude.ts";
import { type ConfigBundleSource, startConfigSync } from "./config-sync.ts";

const DEFAULT_MODEL = "claude-test-model";

function makeBundle(
  overrides: Partial<AgentConfigResponse> = {},
): AgentConfigResponse {
  return { env: {}, allowedTools: [], plugins: [], ...overrides };
}

/** A bundle source that returns a fixed bundle and counts calls. */
function fixedSource(
  bundle: AgentConfigResponse,
): ConfigBundleSource & { calls: number } {
  const s = {
    calls: 0,
    async getAgentConfigBundle(): Promise<AgentConfigResponse> {
      s.calls += 1;
      return bundle;
    },
  };
  return s;
}

/** A bundle source that always rejects with the given error. */
function throwingSource(err: unknown): ConfigBundleSource {
  return {
    async getAgentConfigBundle(): Promise<AgentConfigResponse> {
      throw err;
    },
  };
}

/** Captured timer seam — records scheduled callbacks, never auto-fires. */
function fakeTimers() {
  const scheduled: Array<{ fn: () => void; ms: number }> = [];
  let cleared = 0;
  return {
    scheduled,
    get cleared() {
      return cleared;
    },
    setIntervalFn: (fn: () => void, ms: number): (() => void) => {
      scheduled.push({ fn, ms });
      return () => {
        cleared += 1;
      };
    },
  };
}

function noopClaude(): (patch: Partial<LiveClaudeConfig>) => void {
  return () => {};
}

describe("startConfigSync", () => {
  it("applies bundle env vars to the injected env (token propagation)", async () => {
    const env: Record<string, string | undefined> = { EXISTING: "keep" };
    const timers = fakeTimers();
    await startConfigSync({
      source: fixedSource(
        makeBundle({ env: { GH_TOKEN: "fake-token-aaa", FOO: "bar" } }),
      ),
      agentId: "a1",
      defaultModel: DEFAULT_MODEL,
      env,
      applyClaudeConfig: noopClaude(),
      ...timers,
      log: () => {},
    });
    expect(env.GH_TOKEN).toBe("fake-token-aaa");
    expect(env.FOO).toBe("bar");
    expect(env.EXISTING).toBe("keep");
  });

  it("runs one sync before returning (await-first)", async () => {
    const source = fixedSource(makeBundle());
    const timers = fakeTimers();
    await startConfigSync({
      source,
      agentId: "a1",
      defaultModel: DEFAULT_MODEL,
      env: {},
      applyClaudeConfig: noopClaude(),
      ...timers,
      log: () => {},
    });
    expect(source.calls).toBe(1);
  });

  it("schedules a 60s interval by default and honors an override", async () => {
    const timers = fakeTimers();
    await startConfigSync({
      source: fixedSource(makeBundle()),
      agentId: "a1",
      defaultModel: DEFAULT_MODEL,
      env: {},
      applyClaudeConfig: noopClaude(),
      ...timers,
      log: () => {},
    });
    expect(timers.scheduled).toHaveLength(1);
    expect(timers.scheduled[0].ms).toBe(60_000);

    const t2 = fakeTimers();
    await startConfigSync({
      source: fixedSource(makeBundle()),
      agentId: "a1",
      defaultModel: DEFAULT_MODEL,
      intervalMs: 5_000,
      env: {},
      applyClaudeConfig: noopClaude(),
      ...t2,
      log: () => {},
    });
    expect(t2.scheduled[0].ms).toBe(5_000);
  });

  it("logs changed KEYS but never values", async () => {
    const logs: string[] = [];
    await startConfigSync({
      source: fixedSource(
        makeBundle({ env: { GH_TOKEN: "fake-secret-value" } }),
      ),
      agentId: "a1",
      defaultModel: DEFAULT_MODEL,
      env: {},
      applyClaudeConfig: noopClaude(),
      ...fakeTimers(),
      log: (m) => logs.push(m),
    });
    const updated = logs.find((l) => l.startsWith("[config-sync] updated:"));
    expect(updated).toContain("GH_TOKEN");
    expect(updated).not.toContain("fake-secret-value");
  });

  it("sets AGENT_ALLOWED_TOOLS and pushes model+tools to the claude setter", async () => {
    const env: Record<string, string | undefined> = {};
    let patch: Partial<LiveClaudeConfig> | undefined;
    await startConfigSync({
      source: fixedSource(makeBundle({ allowedTools: ["Read", "Bash"] })),
      agentId: "a1",
      defaultModel: DEFAULT_MODEL,
      env,
      applyClaudeConfig: (p) => {
        patch = p;
      },
      ...fakeTimers(),
      log: () => {},
    });
    expect(env.AGENT_ALLOWED_TOOLS).toBe(JSON.stringify(["Read", "Bash"]));
    expect(patch?.model).toBe(DEFAULT_MODEL);
    expect(patch?.allowedTools).toEqual(["Read", "Bash"]);
  });

  it("clears AGENT_ALLOWED_TOOLS when allowedTools is empty (prevents stale env)", async () => {
    // Seed a stale value as if tools had been set in a prior sync cycle.
    const env: Record<string, string | undefined> = {
      AGENT_ALLOWED_TOOLS: JSON.stringify(["Read", "Bash"]),
    };
    await startConfigSync({
      source: fixedSource(makeBundle({ allowedTools: [] })),
      agentId: "a1",
      defaultModel: DEFAULT_MODEL,
      env,
      applyClaudeConfig: () => {},
      ...fakeTimers(),
      log: () => {},
    });
    expect(env.AGENT_ALLOWED_TOOLS).toBeUndefined();
  });

  it("honors env.ANTHROPIC_MODEL over the default model", async () => {
    let patch: Partial<LiveClaudeConfig> | undefined;
    await startConfigSync({
      source: fixedSource(makeBundle()),
      agentId: "a1",
      defaultModel: DEFAULT_MODEL,
      env: { ANTHROPIC_MODEL: "claude-override" },
      applyClaudeConfig: (p) => {
        patch = p;
      },
      ...fakeTimers(),
      log: () => {},
    });
    expect(patch?.model).toBe("claude-override");
  });

  it("treats a 404 as 'no bundle' — logs once, no throw, env untouched", async () => {
    const env: Record<string, string | undefined> = { KEEP: "yes" };
    const logs: string[] = [];
    const handle = await startConfigSync({
      source: throwingSource({ statusCode: 404 }),
      agentId: "a1",
      defaultModel: DEFAULT_MODEL,
      env,
      applyClaudeConfig: noopClaude(),
      ...fakeTimers(),
      log: (m) => logs.push(m),
    });
    // A second sync should NOT log the not-found line again.
    await handle.syncOnce();
    const notFound = logs.filter((l) => l.includes("no config bundle found"));
    expect(notFound).toHaveLength(1);
    expect(env).toEqual({ KEEP: "yes" });
  });

  it("logs (does not throw) on a non-404 fetch error and leaves env untouched", async () => {
    const env: Record<string, string | undefined> = { KEEP: "yes" };
    const logs: string[] = [];
    await startConfigSync({
      source: throwingSource(new Error("boom")),
      agentId: "a1",
      defaultModel: DEFAULT_MODEL,
      env,
      applyClaudeConfig: noopClaude(),
      ...fakeTimers(),
      log: (m) => logs.push(m),
    });
    expect(logs.some((l) => l.includes("failed to fetch config bundle"))).toBe(
      true,
    );
    expect(env).toEqual({ KEEP: "yes" });
  });

  it("stop() clears the interval via the injected seam", async () => {
    const timers = fakeTimers();
    const handle = await startConfigSync({
      source: fixedSource(makeBundle()),
      agentId: "a1",
      defaultModel: DEFAULT_MODEL,
      env: {},
      applyClaudeConfig: noopClaude(),
      ...timers,
      log: () => {},
    });
    expect(timers.cleared).toBe(0);
    handle.stop();
    expect(timers.cleared).toBe(1);
  });

  it("the scheduled callback runs another sync (polling continues)", async () => {
    const source = fixedSource(makeBundle());
    const timers = fakeTimers();
    await startConfigSync({
      source,
      agentId: "a1",
      defaultModel: DEFAULT_MODEL,
      env: {},
      applyClaudeConfig: noopClaude(),
      ...timers,
      log: () => {},
    });
    expect(source.calls).toBe(1);
    // Fire the interval callback the loop registered.
    timers.scheduled[0].fn();
    await Promise.resolve();
    expect(source.calls).toBe(2);
  });
});
