/**
 * plugins/shipwright/scripts/check-test-readiness.test.ts
 *
 * Unit tests for check-test-readiness.ts
 *
 * Design: the script exports a `run(deps)` function that accepts injected
 * dependencies. Tests inject stub implementations — no file I/O is executed.
 */

import { describe, expect, test } from "bun:test";
import { ARTIFACT_PATHS, run, STALE_THRESHOLD_MS } from "./check-test-readiness.ts";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const NOW = 1_000_000_000_000;

function makeDeps(overrides: {
  getMtimeMs?: (path: string) => number | null;
  now?: () => number;
}) {
  return {
    getMtimeMs: overrides.getMtimeMs ?? (() => NOW),
    now: overrides.now ?? (() => NOW),
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("check-test-readiness", () => {
  test("exits 1 with empty output when all 4 artifacts are fresh", async () => {
    const deps = makeDeps({
      getMtimeMs: () => NOW,
      now: () => NOW,
    });
    const result = await run(deps);
    expect(result.exit).toBe(1);
    expect(result.output).toBe("");
  });

  test("exits 0 with a summary when one artifact is stale (old mtime)", async () => {
    const staleMtime = NOW - (STALE_THRESHOLD_MS + 1);
    const deps = makeDeps({
      getMtimeMs: (path) =>
        path === ARTIFACT_PATHS[1] ? staleMtime : NOW,
      now: () => NOW,
    });
    const result = await run(deps);
    expect(result.exit).toBe(0);
    expect(result.output).toContain(ARTIFACT_PATHS[1]);
  });

  test("exits 0 (treated as stale) when an artifact is missing entirely", async () => {
    const deps = makeDeps({
      getMtimeMs: (path) => (path === ARTIFACT_PATHS[2] ? null : NOW),
      now: () => NOW,
    });
    const result = await run(deps);
    expect(result.exit).toBe(0);
    expect(result.output).toContain(ARTIFACT_PATHS[2]);
  });

  test("exits 0 and lists all stale artifacts when multiple are stale", async () => {
    const staleMtime = NOW - (STALE_THRESHOLD_MS + 1);
    const deps = makeDeps({
      getMtimeMs: (path) => {
        if (path === ARTIFACT_PATHS[0]) return staleMtime;
        if (path === ARTIFACT_PATHS[3]) return null;
        return NOW;
      },
      now: () => NOW,
    });
    const result = await run(deps);
    expect(result.exit).toBe(0);
    expect(result.output).toContain(ARTIFACT_PATHS[0]);
    expect(result.output).toContain(ARTIFACT_PATHS[3]);
    expect(result.output).not.toContain(ARTIFACT_PATHS[1]);
    expect(result.output).not.toContain(ARTIFACT_PATHS[2]);
  });

  test("treats mtime exactly at the 24h boundary as fresh (permissive on boundary)", async () => {
    const boundaryMtime = NOW - STALE_THRESHOLD_MS;
    const deps = makeDeps({
      getMtimeMs: () => boundaryMtime,
      now: () => NOW,
    });
    const result = await run(deps);
    expect(result.exit).toBe(1);
    expect(result.output).toBe("");
  });
});
