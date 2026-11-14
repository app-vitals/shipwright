// Unit tests for compute-risk-rating.ts — pure logic, no I/O.

import { describe, expect, it } from "bun:test";
import {
  bandFor,
  computeRiskRating,
  RISK_THRESHOLDS,
  type HeuristicFactor,
} from "./compute-risk-rating";

const hf = (points: number, factor = "size"): HeuristicFactor => ({
  factor,
  level: points >= 4 ? "high" : points >= 2 ? "medium" : "low",
  points,
  evidence: "e",
});
const heur = (totalPoints: number) => ({
  factors: [hf(totalPoints)],
  totalPoints,
});

describe("bandFor / thresholds", () => {
  it("exports the table", () => {
    expect(RISK_THRESHOLDS.map((t) => t.level)).toEqual([
      "high",
      "medium",
      "low",
    ]);
  });
  it.each([
    [0, "low"],
    [3, "low"],
    [4, "medium"],
    [7, "medium"],
    [8, "high"],
    [50, "high"],
    [-1, "low"],
    [Number.NaN, "low"],
  ] as const)("%p points -> %p", (pts, lvl) => {
    expect(bandFor(pts)).toBe(lvl);
  });
});

describe("computeRiskRating", () => {
  it("heuristic-only when subagents missing or empty", () => {
    const a = computeRiskRating({ heuristic: heur(5) });
    const b = computeRiskRating({ heuristic: heur(5), subagents: [] });
    expect(a.level).toBe("medium");
    expect(b).toEqual(a);
  });

  it("is deterministic", () => {
    const input = {
      heuristic: heur(2),
      subagents: [
        { level: "medium", factors: [{ factor: "x", level: "medium", evidence: "y" }] },
      ],
    };
    expect(computeRiskRating(input)).toEqual(computeRiskRating(input));
  });

  it("subagent high floors at high", () => {
    const r = computeRiskRating({
      heuristic: heur(0),
      subagents: [{ level: "high", factors: [] }],
    });
    expect(r.level).toBe("high");
    expect(r.heuristicLevel).toBe("low");
    expect(r.reason).toContain("raised from low");
  });

  it("subagent medium floors at medium", () => {
    expect(
      computeRiskRating({
        heuristic: heur(1),
        subagents: [{ level: "medium", factors: [] }],
      }).level,
    ).toBe("medium");
  });

  it("subagent factor level alone can raise", () => {
    const r = computeRiskRating({
      heuristic: heur(1),
      subagents: [
        { factors: [{ factor: "blast radius", level: "high", evidence: "a:1" }] },
      ],
    });
    expect(r.level).toBe("high");
  });

  it("subagents never lower the heuristic band", () => {
    const r = computeRiskRating({
      heuristic: heur(9),
      subagents: [
        { level: "low", factors: [{ factor: "f", level: "low", evidence: "" }] },
      ],
    });
    expect(r.level).toBe("high");
    expect(r.reason).not.toContain("raised");
  });

  it("ignores malformed subagent input", () => {
    const r = computeRiskRating({
      heuristic: heur(1),
      subagents: [
        null,
        "high",
        42,
        { level: "critical", factors: "nope" },
        {
          level: "banana",
          factors: [
            null,
            { factor: "", level: "high", evidence: "" },
            { factor: "ok", level: "extreme", evidence: "" },
            { level: "high" },
          ],
        },
      ],
    });
    expect(r.level).toBe("low");
    expect(r.factors.every((f) => f.source === "heuristic")).toBe(true);
  });

  it("renders table and one-line reason", () => {
    const r = computeRiskRating({
      heuristic: { factors: [hf(4, "size")], totalPoints: 4 },
      subagents: [
        { level: "high", factors: [{ factor: "migr|ation", level: "high", evidence: "a\nb" }] },
      ],
    });
    expect(r.table.split("\n")[0]).toBe("| Factor | Level | Basis | Evidence |");
    expect(r.table).toContain("| size | high | 4 pts | e |");
    expect(r.table).toContain("| migr\\|ation | high | judgment | a b |");
    expect(r.reason).not.toContain("\n");
    expect(r.reason).toContain("size");
  });
});
