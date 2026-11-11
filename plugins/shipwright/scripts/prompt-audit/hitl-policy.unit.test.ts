import { describe, expect, it } from "bun:test";
import {
  computeHitl,
  type HitlPolicyInput,
  hitlReasons,
  isHighFanoutFile,
  promotionFor,
} from "./hitl-policy.ts";

const promotedFix: HitlPolicyInput = {
  rule: "unresolvable-path",
  class: "c",
  claim: "cost-only",
  file: "plugins/shipwright/skills/foo/references/bar.md",
  autonomyEntry: true,
  acceptedProposals: 5,
  replacementVerified: true,
  cronCount: 0,
  pinningTestCount: 0,
  descriptionOrFrontmatterChange: false,
  diffLines: 20,
  leverCount: 1,
};

describe("computeHitl", () => {
  it("is false for a promoted class-c low-fanout unpinned <=20-line single-lever fix", () => {
    expect(computeHitl(promotedFix)).toBe(false);
    expect(hitlReasons(promotedFix)).toEqual([]);
  });

  const flips: Array<[string, Partial<HitlPolicyInput>]> = [
    ["high-fanout file (CLAUDE.md)", { file: "CLAUDE.md" }],
    [
      "high-fanout file (command)",
      { file: "plugins/shipwright/commands/x.md" },
    ],
    ["file invoked by a cron", { cronCount: 1 }],
    ["pinned lines", { pinningTestCount: 1 }],
    ["description change", { descriptionOrFrontmatterChange: true }],
    ["21 lines", { diffLines: 21 }],
    ["two levers", { leverCount: 2 }],
    ["zero levers", { leverCount: 0 }],
    ["no autonomy entry", { autonomyEntry: false }],
    ["4 accepted proposals", { acceptedProposals: 4 }],
    ["replacement unverified", { replacementVerified: false }],
    ["class e", { class: "e" }],
    ["class a", { class: "a" }],
  ];
  it.each(flips)("flips to true: %s", (_name, patch) => {
    const input = { ...promotedFix, ...patch };
    expect(computeHitl(input)).toBe(true);
    expect(hitlReasons(input).length).toBeGreaterThan(0);
  });

  it("is true for every class when no rule is promoted, including class c", () => {
    for (const cls of ["a", "b", "c", "e", "f"] as const) {
      expect(
        computeHitl({
          ...promotedFix,
          class: cls,
          autonomyEntry: false,
          acceptedProposals: 0,
        }),
      ).toBe(true);
    }
  });

  it("is always true for quality-claimed, even when every other condition holds", () => {
    const input = { ...promotedFix, claim: "quality-claimed" as const };
    expect(computeHitl(input)).toBe(true);
    expect(hitlReasons(input)[0]).toContain("quality-claimed");
  });
});

describe("isHighFanoutFile", () => {
  it.each([
    "agent/workspace/CLAUDE.md.template",
    "CLAUDE.md",
    "plugins/shipwright/CLAUDE.md",
    ".claude/rules/a.md",
    "plugins/shipwright/commands/prompt-fix.md",
    "plugins/shipwright/agents/code-reviewer.md",
    "plugins/shipwright/references/methodology-contracts/x.md",
  ])("%s is high-fanout", (f) => {
    expect(isHighFanoutFile(f, 0)).toBe(true);
  });

  it("a plain skill reference is low-fanout", () => {
    expect(
      isHighFanoutFile("plugins/shipwright/skills/a/references/b.md", 0),
    ).toBe(false);
  });
});

describe("promotionFor", () => {
  const text = [
    "### Rule X",
    "**Autonomy:** unresolvable-path, 7 accepted proposals (#1, #2)",
    "**Autonomy:** retired-model-id, see notes",
  ].join("\n");

  it("reads the accepted count for a promoted rule", () => {
    expect(promotionFor(text, "unresolvable-path")).toEqual({
      autonomyEntry: true,
      acceptedProposals: 7,
    });
  });
  it("treats an unreadable count as zero", () => {
    expect(promotionFor(text, "retired-model-id")).toEqual({
      autonomyEntry: true,
      acceptedProposals: 0,
    });
  });
  it("returns no promotion when absent or the registry is empty", () => {
    const none = { autonomyEntry: false, acceptedProposals: 0 };
    expect(promotionFor(text, "other")).toEqual(none);
    expect(promotionFor("", "unresolvable-path")).toEqual(none);
  });
});
