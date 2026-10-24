/**
 * plugins/shipwright/scripts/prompt-audit/eval-harness.unit.test.ts
 */

import { describe, expect, test } from "bun:test";
import {
  assertCostGate,
  assertJudgeFamily,
  buildEvalCases,
  diffEvals,
  type EvalResult,
  estimateEvalCost,
  extractSteps,
  mcnemarExact,
  prepareEvals,
  renderGrader,
  runEvalDiff,
  writeEvalCases,
} from "./eval-harness.ts";
import type { Finding } from "./finding.ts";

const CMD =
  "# Merge\n## Arguments\n## Step 1: Resolve Target PR\n### 1a. Own-PRs-Only Check\n## Step 2: Pre-flight Checks\n## Step 3: Merge\n## Step 4: Print Handoff\n";
const finding = { file: "plugins/shipwright/commands/merge.md" } as Finding;

function deps() {
  const written: Record<string, string> = {};
  return {
    written,
    d: {
      fs: { read: () => CMD },
      write: (_r: string, rel: string, c: string) => {
        written[rel] = c;
      },
    },
  };
}

describe("cost gate", () => {
  test("estimate = cases x runs x arms x per-case cost", () => {
    expect(estimateEvalCost({ cases: 20, runs: 3, arms: 2 })).toBe(12);
    expect(
      estimateEvalCost({ cases: 20, runs: 3, arms: 2, lastPerCaseUsd: 0.2 }),
    ).toBe(24);
  });
  test("refuses without cap or over cap", () => {
    const i = { cases: 20, runs: 3, arms: 2 };
    expect(() => assertCostGate(i, undefined)).toThrow(
      "--max-cost-usd is required",
    );
    expect(() => assertCostGate(i, 5)).toThrow("exceeds");
    expect(assertCostGate(i, 12).estimateUsd).toBe(12);
  });
  test("refuses fewer than 3 seeds", () => {
    expect(() => estimateEvalCost({ cases: 20, runs: 2, arms: 2 })).toThrow(
      "seeds",
    );
  });
});

describe("buildEvalCases", () => {
  test("20-30 deterministic cases with should/shouldn't Skill graders", () => {
    const a = buildEvalCases(finding, "/r", deps().d);
    const b = buildEvalCases(finding, "/r", deps().d);
    expect(a).toEqual(b);
    expect(a.length).toBeGreaterThanOrEqual(20);
    expect(a.length).toBeLessThanOrEqual(30);
    expect(new Set(a.map((c) => c.id)).size).toBe(a.length);
    const should = a.filter((c) => c.kind === "trigger-should");
    const shouldnt = a.filter((c) => c.kind === "trigger-shouldnt");
    expect(should.length).toBeGreaterThan(0);
    expect(shouldnt.length).toBeGreaterThan(0);
    for (const c of [...should, ...shouldnt]) {
      expect(
        c.graders.some((g) => g.type === "tool_used" && g.tool === "Skill"),
      ).toBe(true);
      expect(c.smoke).toBe(true);
      expect(c.seeds).toBeGreaterThanOrEqual(3);
    }
  });
  test("historical tasks are non-smoke and reset the repo", () => {
    const d = deps().d;
    const cases = buildEvalCases(finding, "/r", {
      ...d,
      historical: [
        {
          id: "T-1",
          prompt: "do it",
          preTaskCommit: "abc",
          testCommand: "bun test",
        },
      ],
    });
    const h = cases.find((c) => c.kind === "historical");
    expect(h?.smoke).toBe(false);
    expect(h?.resetTo).toBe("abc");
    expect(h?.graders[0]).toEqual({ type: "tests_pass", command: "bun test" });
  });
  test("judge must be a different family", () => {
    expect(() =>
      assertJudgeFamily("claude-sonnet-5-5", "claude-opus-4-6"),
    ).toThrow("family");
    expect(() => assertJudgeFamily("claude-sonnet-5-5", "gpt-5")).not.toThrow();
  });
  test("writes prompt.md and graders/*.md", () => {
    const { written, d } = deps();
    const cases = buildEvalCases(finding, "/r", d);
    writeEvalCases(cases, "/r", d);
    const c = cases[0];
    expect(written[`evals/${c.id}/prompt.md`]).toContain(c.prompt);
    const g = Object.keys(written).filter((k) =>
      k.startsWith(`evals/${c.id}/graders/`),
    );
    expect(g.length).toBe(c.graders.length);
    const t = cases.find((x) => x.kind === "trigger-should");
    expect(written[`evals/${t?.id}/graders/01-tool_used.md`]).toContain(
      "type: tool_used\ntool: Skill\n",
    );
  });
  test("prompt.md carries frontmatter and the prompt as body", () => {
    const { written, d } = deps();
    const c = buildEvalCases(finding, "/r", d)[0];
    writeEvalCases([c], "/r", d);
    expect(written[`evals/${c.id}/prompt.md`]).toBe(
      `---\nmax_turns: 10\nallowed_tools: [Read, Glob, Grep, Skill]\n---\n\n${c.prompt}\n`,
    );
  });
  test("historical tests_pass / task_store_state graders are dropped with a logged reason", () => {
    const { written, d } = deps();
    const logs: string[] = [];
    const cases = buildEvalCases(finding, "/r", {
      ...d,
      historical: [
        {
          id: "T-1",
          prompt: "do it",
          preTaskCommit: "abc",
          testCommand: "bun test",
          expectedState: { field: "status", expected: "pr_open" },
        },
      ],
    });
    writeEvalCases(cases, "/r", { ...d, log: (m) => logs.push(m) });
    const h = cases.find((c) => c.kind === "historical");
    expect(logs).toHaveLength(2);
    expect(logs[0]).toContain("dropped tests_pass");
    expect(logs[1]).toContain("dropped task_store_state");
    const files = Object.keys(written).filter((k) =>
      k.startsWith(`evals/${h?.id}/graders/`),
    );
    expect(files).toEqual([`evals/${h?.id}/graders/01-tool_used.md`]);
  });
});

describe("renderGrader", () => {
  test("tool_used present", () => {
    expect(
      renderGrader({
        type: "tool_used",
        tool: "Skill",
        skill: "dev-task",
        expect: "present",
      }),
    ).toStartWith(
      `---\ntype: tool_used\ntool: Skill\ninput_match: '"skill"\\s*:\\s*"(?:shipwright:)?dev-task"'\nmin: 1\n---\n`,
    );
  });
  test("tool_used absent caps at zero and regex-escapes the skill", () => {
    const out = renderGrader({
      type: "tool_used",
      tool: "Skill",
      skill: "a.b",
      expect: "absent",
    });
    expect(out).toContain("a\\.b");
    expect(out).toContain("min: 0\nmax: 0\n---");
  });
  test("transcript_contains is a regex over the last message, escaped", () => {
    const out = renderGrader({
      type: "transcript_contains",
      text: "1: Step (it's) [x]",
    });
    expect(out).toStartWith(
      `---\ntype: regex\ntarget: last_message\npattern: '1: Step \\(it''s\\) \\[x\\]'\n---\n`,
    );
  });
  test("llm_judge puts the rubric in the body", () => {
    expect(
      renderGrader({ type: "llm_judge", model: "gpt-5", rubric: "Be good." }),
    ).toBe("---\ntype: llm\nweight: 1\n---\n\nBe good.\n");
  });
  test("rejects graders plugin eval cannot express", () => {
    expect(() =>
      renderGrader({ type: "tests_pass", command: "bun test" }),
    ).toThrow(/no plugin-eval equivalent/);
  });
  test("prepareEvals writes nothing when the gate refuses", () => {
    const { written, d } = deps();
    expect(() =>
      prepareEvals(finding, "/r", { arms: 2, runs: 3 }, d),
    ).toThrow();
    expect(Object.keys(written)).toHaveLength(0);
    const ok = prepareEvals(
      finding,
      "/r",
      { arms: 2, runs: 3, maxCostUsd: "100" },
      d,
    );
    expect(ok.cases).toBeGreaterThanOrEqual(20);
    expect(Object.keys(written).length).toBeGreaterThan(0);
  });
});

const arm = (name: string, cases: Record<string, boolean[]>): EvalResult => ({
  arm: name,
  cases,
});

describe("extractSteps", () => {
  test("skips headings inside fenced code blocks", () => {
    const md =
      "## Step 1: Real\n```md\n## Fake heading\n```\n~~~\n### Also fake\n~~~\n### Step 2: Also real\n";
    expect(extractSteps(md)).toEqual(["1: Real", "2: Also real"]);
  });
});

describe("diffEvals", () => {
  test("exact McNemar", () => {
    expect(mcnemarExact(0, 0)).toBe(1);
    expect(mcnemarExact(0, 5)).toBeCloseTo(0.0625, 4);
    expect(mcnemarExact(3, 3)).toBe(1);
  });
  test("no change reports no-regression-detected-within-MDE with MDE", () => {
    const r = arm("a", { x: [true, true, true], y: [true, false, true] });
    const d = diffEvals(
      r,
      arm("b", { x: [true, true, true], y: [true, false, true] }),
    );
    expect(d.verdict).toBe("no-regression-detected-within-MDE");
    expect(d.pairs).toBe(6);
    expect(d.mde).toBeGreaterThan(0);
  });
  test("pairs per case and seed; detects regression", () => {
    const cases = (v: boolean) =>
      Object.fromEntries(
        Array.from({ length: 6 }, (_, i) => [`c${i}`, [v, v, v]]),
      );
    const d = diffEvals(arm("a", cases(true)), arm("b", cases(false)));
    expect(d.regressions).toBe(18);
    expect(d.verdict).toBe("regression-detected");
  });
  test("unpaired cases excluded; <3 seeds throws", () => {
    const d = diffEvals(
      arm("a", { x: [true, true, true], z: [true, true, true] }),
      arm("b", { x: [true, true, true] }),
    );
    expect(d.unpairedCases).toEqual(["z"]);
    expect(d.verdict).toBe("inconclusive-unpaired-cases");
    expect(() =>
      diffEvals(arm("a", { x: [true, true] }), arm("b", { x: [true, true] })),
    ).toThrow("seeds");
  });
  test("runEvalDiff renders from recorded JSON without 'no regression' wording", () => {
    const files: Record<string, string> = {
      "a.json": JSON.stringify(arm("a", { x: [true, true, true] })),
      "b.json": JSON.stringify(arm("b", { x: [true, true, true] })),
    };
    const out = runEvalDiff("a.json", "b.json", { readFile: (p) => files[p] });
    expect(out).toContain("no-regression-detected-within-MDE");
    expect(out).toContain("minimum detectable effect");
    expect(out).not.toMatch(/no regression(?!-)/);
  });
});
