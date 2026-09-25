/**
 * scripts/check-competitive-freshness.unit.test.ts
 *
 * Unit tests for check-competitive-freshness.ts — the competitive-positioning
 * freshness precheck (CF-1.1). Mirrors
 * plugins/shipwright/scripts/check-site-docs-freshness.unit.test.ts's
 * injected-dependency style: no real file I/O, a stub Clock controls "now",
 * and stub page/row content is passed straight into `run(deps)`.
 */

import { describe, expect, test } from "bun:test";
import { run } from "./check-competitive-freshness.ts";

// ─── Helpers ──────────────────────────────────────────────────────────────────

// Fixed "now" for every test — 2026-09-25 (the task's real seed date), noon UTC
// to stay clear of any date-boundary edge cases.
const NOW = new Date("2026-09-25T12:00:00Z");

// 5 days before NOW — comfortably under the default 30-day threshold.
const FRESH_DATE = "September 20, 2026";
// 45 days before NOW — comfortably over the default 30-day threshold.
const STALE_DATE = "August 11, 2026";

function vsPageContent(verifiedDate: string | null): string {
  const constLine =
    verifiedDate === null ? "" : `const verifiedDate = "${verifiedDate}";`;
  return `---
import BaseLayout from "../../layouts/BaseLayout.astro";
${constLine}
const src = { home: "https://example.com" };
---
<BaseLayout title="vs example" />
`;
}

function compareSourceWithRows(
  rows: Array<{ tool: string; verifiedDate: string | null }>,
): string {
  const entries = rows
    .map(
      (r) => `  {
    tool: "${r.tool}",${
        r.verifiedDate === null ? "" : `\n    verifiedDate: "${r.verifiedDate}",`
      }
    license: "Commercial",
    citations: [{ label: "source", url: "https://example.com" }],
  },`,
    )
    .join("\n");
  return `---
const verifiedDate = "September 5, 2026";
const landscape = [
${entries}
];
---
`;
}

interface MakeDepsOptions {
  vsPages?: Record<string, string>;
  compareSource?: string | null;
  now?: () => Date;
  thresholdDays?: number;
}

// Default compareSource is a present-but-empty landscape — tests that only
// care about vs/*.astro pages shouldn't incidentally pick up a "compare.astro
// missing" finding just because they didn't pass one. Tests that specifically
// exercise the "compare.astro unreadable" case pass `compareSource: null`.
function makeDeps(overrides: MakeDepsOptions = {}) {
  return {
    vsPages: overrides.vsPages ?? {},
    compareSource:
      overrides.compareSource === undefined
        ? compareSourceWithRows([])
        : overrides.compareSource,
    now: overrides.now ?? (() => NOW),
    thresholdDays: overrides.thresholdDays,
  };
}

// ─── vs/*.astro page evaluation ─────────────────────────────────────────────

describe("check-competitive-freshness — vs/*.astro pages", () => {
  test("exits 1 with no output when every page's verifiedDate is fresh", async () => {
    const deps = makeDeps({
      vsPages: {
        "site/src/pages/vs/devin.astro": vsPageContent(FRESH_DATE),
        "site/src/pages/vs/factory.astro": vsPageContent(FRESH_DATE),
      },
    });
    const result = await run(deps);
    expect(result.exit).toBe(1);
    expect(result.output).toBe("");
  });

  test("exits 0 and names the page when its verifiedDate is more than the threshold old", async () => {
    const deps = makeDeps({
      vsPages: {
        "site/src/pages/vs/factory.astro": vsPageContent(STALE_DATE),
      },
    });
    const result = await run(deps);
    expect(result.exit).toBe(0);
    expect(result.output).toContain("site/src/pages/vs/factory.astro");
    expect(result.output).toContain("45");
  });

  test("treats a missing verifiedDate const as qualifying", async () => {
    const deps = makeDeps({
      vsPages: {
        "site/src/pages/vs/openhands.astro": vsPageContent(null),
      },
    });
    const result = await run(deps);
    expect(result.exit).toBe(0);
    expect(result.output).toContain("site/src/pages/vs/openhands.astro");
  });

  test("treats an unparseable verifiedDate as qualifying", async () => {
    const deps = makeDeps({
      vsPages: {
        "site/src/pages/vs/openhands.astro": vsPageContent("not-a-real-date"),
      },
    });
    const result = await run(deps);
    expect(result.exit).toBe(0);
    expect(result.output).toContain("site/src/pages/vs/openhands.astro");
  });

  test("a page exactly at the threshold does not qualify (only 'more than' the threshold does)", async () => {
    // Exactly 30 days before NOW.
    const deps = makeDeps({
      vsPages: {
        "site/src/pages/vs/devin.astro": vsPageContent("August 26, 2026"),
      },
      thresholdDays: 30,
    });
    const result = await run(deps);
    expect(result.exit).toBe(1);
    expect(result.output).toBe("");
  });

  test("respects a configurable threshold (7 days) instead of the 30-day default", async () => {
    const deps = makeDeps({
      vsPages: {
        "site/src/pages/vs/devin.astro": vsPageContent(FRESH_DATE), // 5 days old
      },
      thresholdDays: 7,
    });
    const result1 = await run(deps);
    expect(result1.exit).toBe(1);

    const deps2 = makeDeps({
      vsPages: {
        "site/src/pages/vs/devin.astro": vsPageContent(FRESH_DATE), // still 5 days old
      },
      thresholdDays: 3,
    });
    const result2 = await run(deps2);
    expect(result2.exit).toBe(0);
    expect(result2.output).toContain("site/src/pages/vs/devin.astro");
  });

  test("one page's evaluation failure is isolated and does not suppress a sibling page's real finding", async () => {
    const deps = makeDeps({
      vsPages: {
        // Not a string at runtime (simulates an unexpected read/parse failure)
        // despite the Deps type saying string — forces evaluation to throw.
        "site/src/pages/vs/broken.astro": null as unknown as string,
        "site/src/pages/vs/factory.astro": vsPageContent(STALE_DATE),
      },
    });
    const result = await run(deps);
    expect(result.exit).toBe(0);
    // The broken page is permissively flagged too (unknown state).
    expect(result.output).toContain("site/src/pages/vs/broken.astro");
    // The good page's real finding is not suppressed by the other's failure.
    expect(result.output).toContain("site/src/pages/vs/factory.astro");
  });
});

// ─── compare.astro landscape row evaluation ────────────────────────────────

describe("check-competitive-freshness — compare.astro landscape rows", () => {
  test("exits 1 with no output when every row's verifiedDate is fresh", async () => {
    const deps = makeDeps({
      compareSource: compareSourceWithRows([
        { tool: "Devin", verifiedDate: FRESH_DATE },
        { tool: "Cursor", verifiedDate: FRESH_DATE },
      ]),
    });
    const result = await run(deps);
    expect(result.exit).toBe(1);
    expect(result.output).toBe("");
  });

  test("exits 0 and names the specific stale row (not the whole file) with days since verified", async () => {
    const deps = makeDeps({
      compareSource: compareSourceWithRows([
        { tool: "Devin", verifiedDate: FRESH_DATE },
        { tool: "Cursor", verifiedDate: STALE_DATE },
      ]),
    });
    const result = await run(deps);
    expect(result.exit).toBe(0);
    expect(result.output).toContain("Cursor");
    expect(result.output).toContain("45");
    expect(result.output).not.toContain("Devin: ");
  });

  test("treats a row with a missing verifiedDate field as qualifying", async () => {
    const deps = makeDeps({
      compareSource: compareSourceWithRows([
        { tool: "OpenHands", verifiedDate: null },
      ]),
    });
    const result = await run(deps);
    expect(result.exit).toBe(0);
    expect(result.output).toContain("OpenHands");
  });

  test("treats a row with an unparseable verifiedDate field as qualifying", async () => {
    const deps = makeDeps({
      compareSource: compareSourceWithRows([
        { tool: "OpenHands", verifiedDate: "whenever" },
      ]),
    });
    const result = await run(deps);
    expect(result.exit).toBe(0);
    expect(result.output).toContain("OpenHands");
  });

  test("a missing compare.astro file (unreadable) qualifies rather than being silently skipped", async () => {
    const deps = makeDeps({ compareSource: null });
    const result = await run(deps);
    expect(result.exit).toBe(0);
    expect(result.output).toContain("compare.astro");
  });
});

// ─── Cross-source behavior ──────────────────────────────────────────────────

describe("check-competitive-freshness — combined vs pages + compare rows", () => {
  test("exits 1 with no output when both sources are entirely fresh", async () => {
    const deps = makeDeps({
      vsPages: {
        "site/src/pages/vs/devin.astro": vsPageContent(FRESH_DATE),
      },
      compareSource: compareSourceWithRows([
        { tool: "Devin", verifiedDate: FRESH_DATE },
      ]),
    });
    const result = await run(deps);
    expect(result.exit).toBe(1);
    expect(result.output).toBe("");
  });

  test("a stale vs/*.astro page does not suppress a stale compare.astro row, or vice versa", async () => {
    const deps = makeDeps({
      vsPages: {
        "site/src/pages/vs/factory.astro": vsPageContent(STALE_DATE),
      },
      compareSource: compareSourceWithRows([
        { tool: "Cursor", verifiedDate: STALE_DATE },
      ]),
    });
    const result = await run(deps);
    expect(result.exit).toBe(0);
    expect(result.output).toContain("site/src/pages/vs/factory.astro");
    expect(result.output).toContain("Cursor");
  });
});

// ─── Exit-0 stdout shape — this text becomes the entire next cron prompt ───

describe("check-competitive-freshness — exit-0 stdout shape", () => {
  test("names every qualifying page/row and explicitly instructs following the refresh runbook", async () => {
    const deps = makeDeps({
      vsPages: {
        "site/src/pages/vs/factory.astro": vsPageContent(STALE_DATE),
      },
      compareSource: compareSourceWithRows([
        { tool: "Cursor", verifiedDate: STALE_DATE },
      ]),
    });
    const result = await run(deps);
    expect(result.exit).toBe(0);
    // Names each qualifying page/row.
    expect(result.output).toContain("site/src/pages/vs/factory.astro");
    expect(result.output).toContain("Cursor");
    // Names days since last verified.
    expect(result.output).toContain("45");
    // Self-contained instruction to follow the (separate-task) runbook — this
    // stdout IS the next prompt, so the instruction must be explicit, not implied.
    expect(result.output).toContain("scripts/competitive-refresh-runbook.md");
    expect(result.output.toLowerCase()).toContain("follow");
  });

  test("exit-1 output is truly empty, not whitespace or a placeholder", async () => {
    const deps = makeDeps({
      vsPages: {
        "site/src/pages/vs/devin.astro": vsPageContent(FRESH_DATE),
      },
      compareSource: compareSourceWithRows([
        { tool: "Devin", verifiedDate: FRESH_DATE },
      ]),
    });
    const result = await run(deps);
    expect(result.exit).toBe(1);
    expect(result.output).toBe("");
  });
});
