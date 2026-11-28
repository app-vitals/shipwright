import { describe, expect, it } from "bun:test";
import { validatePatrolDoc } from "./check-patrol-docs.ts";
import {
  type EnvFinding,
  isoWeekSuffix,
  renderEnvironmentsDoc,
} from "./environments-scan.ts";

function finding(i: number): EnvFinding {
  return {
    id: "lockfile",
    title: `Item ${i}`,
    why: "reason",
    route: "auto",
    priority: i,
    paths: [`p${i}.json`],
  };
}

describe("renderEnvironmentsDoc", () => {
  it("renders under 150 lines with no count tables, even with many items", () => {
    const many = Array.from({ length: 400 }, (_, i) => finding(i));
    const doc = renderEnvironmentsDoc(many);
    expect(doc.trimEnd().split("\n").length).toBeLessThanOrEqual(150);
    expect(validatePatrolDoc(doc)).toEqual([]);
    expect(doc).not.toMatch(/^\s*\|/m);
  });

  it("states there are no open items when empty", () => {
    const doc = renderEnvironmentsDoc([]);
    expect(doc).toContain("No open items.");
    expect(validatePatrolDoc(doc)).toEqual([]);
  });

  it("lists highest priority first and is timestamp free", () => {
    const doc = renderEnvironmentsDoc([finding(5), finding(1)]);
    expect(doc.indexOf("Item 1")).toBeLessThan(doc.indexOf("Item 5"));
    expect(doc).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });
});

describe("isoWeekSuffix", () => {
  it("formats ISO weeks across a year boundary", () => {
    expect(isoWeekSuffix(new Date("2026-11-28T00:00:00Z"))).toBe("2026-W48");
    expect(isoWeekSuffix(new Date("2027-01-01T00:00:00Z"))).toBe("2026-W53");
  });
});
