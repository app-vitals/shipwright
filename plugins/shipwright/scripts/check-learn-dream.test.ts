/**
 * plugins/shipwright/scripts/check-learn-dream.test.ts
 *
 * Unit tests for check-learn-dream.ts
 *
 * Design: the script exports a `run(deps)` function that accepts injected
 * dependencies. Tests inject stub implementations — no file I/O is executed.
 */

import { describe, expect, test } from "bun:test";
import { run } from "./check-learn-dream.ts";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeDeps(overrides: {
  readLastRunAnchor?: () => string | null;
  listTranscriptMtimes?: () => number[] | null;
}) {
  return {
    readLastRunAnchor:
      overrides.readLastRunAnchor ?? (() => "2026-07-01T00:00:00.000Z"),
    listTranscriptMtimes: overrides.listTranscriptMtimes ?? (() => []),
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("check-learn-dream", () => {
  test("exits 0 (first run) when no last-run anchor file exists", async () => {
    const deps = makeDeps({ readLastRunAnchor: () => null });
    const result = await run(deps);
    expect(result.exit).toBe(0);
  });

  test("exits 1 when anchor is newer than all transcripts", async () => {
    const anchor = new Date("2026-07-05T00:00:00.000Z").toISOString();
    const olderMtimes = [
      new Date("2026-07-01T00:00:00.000Z").getTime(),
      new Date("2026-07-03T00:00:00.000Z").getTime(),
    ];
    const deps = makeDeps({
      readLastRunAnchor: () => anchor,
      listTranscriptMtimes: () => olderMtimes,
    });
    const result = await run(deps);
    expect(result.exit).toBe(1);
    expect(result.output).toBe("");
  });

  test("exits 1 when there are no transcript files at all", async () => {
    const anchor = new Date("2026-07-05T00:00:00.000Z").toISOString();
    const deps = makeDeps({
      readLastRunAnchor: () => anchor,
      listTranscriptMtimes: () => [],
    });
    const result = await run(deps);
    expect(result.exit).toBe(1);
    expect(result.output).toBe("");
  });

  test("exits 0 when anchor is older than at least one transcript", async () => {
    const anchor = new Date("2026-07-01T00:00:00.000Z").toISOString();
    const mtimes = [
      new Date("2026-06-30T00:00:00.000Z").getTime(),
      new Date("2026-07-05T00:00:00.000Z").getTime(),
    ];
    const deps = makeDeps({
      readLastRunAnchor: () => anchor,
      listTranscriptMtimes: () => mtimes,
    });
    const result = await run(deps);
    expect(result.exit).toBe(0);
    expect(result.output.length).toBeGreaterThan(0);
  });

  test("exits 0 with a summary mentioning the count of newer transcripts", async () => {
    const anchor = new Date("2026-07-01T00:00:00.000Z").toISOString();
    const mtimes = [
      new Date("2026-07-02T00:00:00.000Z").getTime(),
      new Date("2026-07-03T00:00:00.000Z").getTime(),
      new Date("2026-06-01T00:00:00.000Z").getTime(),
    ];
    const deps = makeDeps({
      readLastRunAnchor: () => anchor,
      listTranscriptMtimes: () => mtimes,
    });
    const result = await run(deps);
    expect(result.exit).toBe(0);
    expect(result.output).toContain("2");
  });

  test("exits 0 when listTranscriptMtimes returns null (read failure — permissive)", async () => {
    const deps = makeDeps({
      readLastRunAnchor: () => "2026-07-01T00:00:00.000Z",
      listTranscriptMtimes: () => null,
    });
    const result = await run(deps);
    expect(result.exit).toBe(0);
  });
});
