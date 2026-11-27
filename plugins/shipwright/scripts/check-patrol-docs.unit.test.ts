/**
 * Unit tests for check-patrol-docs.ts — pure functions, no file I/O.
 */
import { describe, expect, test } from "bun:test";
import {
  checkPatrolDoc,
  isMaterialChange,
  MAX_LINES,
  renderPatrolDoc,
  validatePatrolDoc,
  type PatrolItem,
} from "./check-patrol-docs.ts";

const BASE = `# Entropy

Last updated: 2026-11-20

- **Dead export** — unused (\`a.ts\`)
- **Long fn** — too long (\`b.ts\`)
`;

const bigFixture = (n: number): PatrolItem[] =>
  Array.from({ length: n }, (_, i) => ({
    priority: i % 7,
    title: `Finding ${i}`,
    why: "reason",
    paths: [`src/f${i}.ts`],
  }));

describe("validatePatrolDoc", () => {
  test("clean doc has no violations", () => {
    expect(validatePatrolDoc(BASE)).toEqual([]);
  });
  test("over 150 lines names max-lines", () => {
    const doc = Array.from({ length: MAX_LINES + 1 }, (_, i) => `- item ${i}`).join("\n");
    const v = validatePatrolDoc(doc);
    expect(v.map((x) => x.rule)).toContain("max-lines");
    expect(v[0].message).toContain("max-lines");
  });
  test("exactly 150 lines is fine", () => {
    const doc = Array.from({ length: MAX_LINES }, (_, i) => `- item ${i}`).join("\n");
    expect(validatePatrolDoc(doc)).toEqual([]);
  });
  test("count table is flagged", () => {
    const doc = "# X\n\n| Rule | Count |\n|---|---|\n| dry | 12 |\n";
    expect(validatePatrolDoc(doc).map((x) => x.rule)).toContain("count-table");
  });
  test("a text-only table is not a count table", () => {
    const doc = "# X\n\n| File | Why |\n|---|---|\n| a.ts | dead |\n";
    expect(validatePatrolDoc(doc)).toEqual([]);
  });
  test("run-history section is flagged", () => {
    const doc = "# X\n\n## Run History\n\n- 2026-11-01\n";
    expect(validatePatrolDoc(doc).map((x) => x.rule)).toContain("run-history");
  });
  test("resolved-items section is flagged", () => {
    const doc = "# X\n\n## Resolved\n\n- old\n";
    expect(validatePatrolDoc(doc).map((x) => x.rule)).toContain("resolved-items");
  });
});

describe("isMaterialChange", () => {
  test("unchanged file is not material", () => {
    expect(isMaterialChange(BASE, BASE)).toBe(false);
  });
  test("timestamp-only change is not material", () => {
    expect(isMaterialChange(BASE, BASE.replace("2026-11-20", "2026-11-27"))).toBe(false);
  });
  test("pure reorder is not material", () => {
    const [h, ...items] = BASE.trimEnd().split("\n\n");
    const lines = items.join("\n\n").split("\n");
    const reordered = [h, lines.slice().reverse().join("\n")].join("\n\n");
    expect(isMaterialChange(BASE, reordered)).toBe(false);
  });
  test("added item is material", () => {
    expect(isMaterialChange(BASE, BASE + "- **New** — x (`c.ts`)\n")).toBe(true);
  });
  test("removed item is material", () => {
    expect(isMaterialChange(BASE, BASE.replace(/- \*\*Long fn.*\n/, ""))).toBe(true);
  });
  test("reworded item is material", () => {
    expect(isMaterialChange(BASE, BASE.replace("unused", "never imported"))).toBe(true);
  });
  test("missing current file is material", () => {
    expect(isMaterialChange(null, BASE)).toBe(true);
  });
});

describe("renderPatrolDoc", () => {
  test("large fixture renders under the cap with the overflow pointer", () => {
    const doc = renderPatrolDoc({ title: "Entropy", items: bigFixture(400) });
    const lines = doc.trimEnd().split("\n");
    expect(lines.length).toBeLessThanOrEqual(MAX_LINES);
    expect(lines[lines.length - 1]).toMatch(/remaining \d+ open items are tracked in the fix tasks/);
    expect(validatePatrolDoc(doc)).toEqual([]);
    // highest priority (0) items come first
    expect(lines.find((l) => l.startsWith("- "))).toContain("Finding 0");
  });
  test("small fixture has no pointer line", () => {
    const doc = renderPatrolDoc({ title: "Entropy", items: bigFixture(3) });
    expect(doc).not.toContain("tracked in the fix tasks");
  });
});

describe("checkPatrolDoc", () => {
  test("combines violations and materiality", () => {
    const r = checkPatrolDoc(BASE, BASE);
    expect(r).toEqual({ violations: [], materiallyChanged: false });
  });
});
