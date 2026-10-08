/**
 * plugins/shipwright/scripts/prompt-audit/rules.unit.test.ts
 *
 * Every rule gets a positive case against a "bad" mini repo and a negative
 * case against a "clean" one. Nothing touches the network, git or real fs.
 */

import { describe, expect, test } from "bun:test";
import {
  ALL_RULES,
  type Finding,
  makeFinding,
  type Rule,
  type RuleContext,
  runAllRules,
} from "./rules.ts";
import * as R from "./rules.ts";
import { walkInventory } from "./inventory.ts";
import {
  findOrphanedAutoSections,
  type ResolverDeps,
  resolveReferences,
} from "./reference-resolver.ts";
import { estimateTokens } from "./token-count.ts";

const MODEL = "claude-sonnet-5-5";
const lines = (n: number, f: (i: number) => string) =>
  Array.from({ length: n }, (_, i) => f(i + 1)).join("\n");
const fm = (o: Record<string, string>, body = "body") =>
  `---\n${Object.entries(o).map(([k, v]) => `${k}: ${v}`).join("\n")}\n---\n${body}\n`;

const BAD: Record<string, string> = {
  "Taskfile.yml": "version: '3'\ntasks:\n  ci:\n    cmds: [x]\n",
  "package.json": JSON.stringify({ scripts: { build: "x" } }),
  "CLAUDE.md": [
    "# Root",
    "@docs/a.md",
    "## Shipwright Learned Facts",
    "_auto-maintained by the learn skill_",
    "## Scripts",
    lines(16, (i) => `Step ${i}: see plugins/p/scripts/file${i}.ts`),
    "## Filler",
    lines(190, (i) => `Filler ${i}`),
    "NEVER skip the filler.",
  ].join("\n"),
  "docs/a.md": "a\n@b.md\n",
  "docs/b.md": "b\n@c.md\n",
  "docs/c.md": "c\n",
  "docs/bad.md": [
    "Uses claude-sonnet-4-5 here.",
    "Read `src/gone.ts` first.",
    "Run `task nope`.",
    "Try `/shipwright:scan --bogus`.",
  ].join("\n"),
  "plugins/p/commands/scan.md": fm({ "argument-hint": "'[--dry-run]'" }),
  ".claude/rules/global.md": "Always on\n",
  "plugins/p/skills/long/SKILL.md": fm(
    { name: "long", description: "Long skill" },
    lines(520, (i) => `Line ${i}`),
  ),
  "plugins/p/skills/big/SKILL.md": fm({ name: "big", description: "x".repeat(1600) }),
  ...Object.fromEntries(
    Array.from({ length: 6 }, (_, i) => [
      `plugins/p/skills/s${i}/SKILL.md`,
      fm({ name: `s${i}`, description: `${i}`.repeat(1500) }),
    ]),
  ),
  "plugins/p/skills/orig/SKILL.md": fm({ name: "orig", description: "Same words" }),
  "plugins/p/skills/twin/SKILL.md": fm({ name: "twin", description: "Same words" }),
  "plugins/p/skills/noname/SKILL.md": fm({ description: "Nameless skill" }),
  "plugins/p/skills/multi/SKILL.md": "---\nname: multi\ndescription: >\n  two\n  lines\n---\nbody\n",
  "plugins/p/skills/heavy/SKILL.md": fm({ name: "heavy", description: "Heavy" }),
  "plugins/p/skills/hot/SKILL.md": fm({ name: "hot", description: "Hot" }),
  "plugins/p/commands/longdesc.md": fm({ description: "d".repeat(1600) }),
  "plugins/p/commands/many.md": fm({}, lines(61, () => "- Run the thing")),
  "plugins/p/commands/shouty.md": fm({}, lines(10, () => "MUST do it")),
  "plugins/p/commands/nope.md": fm(
    {},
    "Do not a.\nDo not b.\nDo not c.\nDo not d.\n",
  ),
};

const CLEAN: Record<string, string> = {
  "CLAUDE.md": "# Root\nNEVER force push.\n",
  ".claude/rules/scoped.md": "---\npaths:\n  - src/**\n---\nScoped\n",
  "plugins/p/skills/ok/SKILL.md": fm({ name: "ok", description: "Fine" }),
  "plugins/p/commands/ok.md": fm({ description: "Fine" }, "Run the thing.\n"),
};

function ctxFor(
  files: Record<string, string>,
  over: Partial<RuleContext> & { tokenOverride?: Record<string, number> } = {},
): RuleContext {
  const deps: ResolverDeps = {
    rateKeys: [MODEL],
    listFiles: () => Object.keys(files),
    readFile: (_r, p) => files[p],
  };
  const items = walkInventory("/r", deps);
  const tokens: RuleContext["tokens"] = {};
  for (const i of items) {
    const t = over.tokenOverride?.[i.path] ?? estimateTokens(files[i.path]);
    tokens[i.path] = { [MODEL]: { tokens: t, estimated: true } };
  }
  return {
    items,
    read: (p) => files[p],
    models: [MODEL],
    tokens,
    unresolved: resolveReferences("/r", deps),
    orphans: findOrphanedAutoSections("/r", deps),
    blame: {},
    usage: null,
    totalRuns: 0,
    usageWindowDays: 7,
    ...over,
  };
}

const stat = (name: string, o: Partial<import("./usage-attribution.ts").SkillStat>) => ({
  kind: "skill", name, runs: 0, invocations: 0, turns: 0, input: 0, output: 0,
  cacheRead: 0, cacheCreation: 0, avgInvokeContextDelta: null, ...o,
});

const bad = ctxFor(BAD, {
  tokenOverride: { "CLAUDE.md": 25_000, "plugins/p/skills/heavy/SKILL.md": 9_000 },
  usage: [
    stat("heavy", { runs: 1, invocations: 100, avgInvokeContextDelta: 6_000 }),
    stat("hot", { runs: 8, invocations: 8 }),
  ],
  totalRuns: 10,
  blame: {
    "CLAUDE.md": { lines: 10, maxAgeDays: 400, medianAgeDays: 300, oldestLine: { line: 2, ageDays: 400 } },
    "docs/a.md": { lines: 10, maxAgeDays: 400, medianAgeDays: 10, oldestLine: { line: 2, ageDays: 400 } },
  },
});
const clean = ctxFor(CLEAN, {
  usage: [stat("ok", { runs: 1, invocations: 1 })],
  totalRuns: 10,
  blame: { "CLAUDE.md": { lines: 2, maxAgeDays: 5, medianAgeDays: 5, oldestLine: null } },
});

const CASES: Array<[string, Rule, string]> = [
  ["claude-md-over-200-lines", R.claudeMdOver200Lines, "CLAUDE.md"],
  ["always-set-tokens", R.alwaysSetTokens, "CLAUDE.md"],
  ["rule-without-paths", R.ruleWithoutPaths, ".claude/rules/global.md"],
  ["import-chain", R.importChain, "docs/c.md"],
  ["listing-budget-share", R.listingBudgetShare, "plugins/p/skills/big/SKILL.md"],
  ["listing-entry-over-1536", R.listingEntryOver1536, "plugins/p/skills/big/SKILL.md"],
  ["on-invoke-heavy", R.onInvokeHeavy, "plugins/p/skills/heavy/SKILL.md"],
  ["invoke-cost-weekly", R.invokeCostWeekly, "plugins/p/skills/heavy/SKILL.md"],
  ["unresolvable-path", R.unresolvablePath, "docs/bad.md"],
  ["unresolvable-command", R.unresolvableCommand, "docs/bad.md"],
  ["unknown-flag", R.unknownFlag, "docs/bad.md"],
  ["retired-model-id", R.retiredModelId, "docs/bad.md"],
  ["orphaned-auto-section", R.orphanedAutoSection, "CLAUDE.md"],
  ["blame-age", R.blameAge, "CLAUDE.md"],
  ["move-to-path-rule", R.moveToPathRule, "CLAUDE.md"],
  ["skill-to-docs-index", R.skillToDocsIndex, "plugins/p/skills/hot/SKILL.md"],
  ["skill-over-500-lines", R.skillOver500Lines, "plugins/p/skills/long/SKILL.md"],
  ["key-instructions-not-near-top", R.keyInstructionsNotNearTop, "CLAUDE.md"],
  ["description-over-1536", R.descriptionOver1536, "plugins/p/commands/longdesc.md"],
  ["description-multiline", R.descriptionMultiline, "plugins/p/skills/multi/SKILL.md"],
  ["frontmatter-missing-name", R.frontmatterMissingName, "plugins/p/skills/noname/SKILL.md"],
  ["duplicate-listing-entry", R.duplicateListingEntry, "plugins/p/skills/twin/SKILL.md"],
  ["instruction-count-high", R.instructionCountHigh, "plugins/p/commands/many.md"],
  ["caps-emphasis-ratio", R.capsEmphasisRatio, "plugins/p/commands/shouty.md"],
  ["prohibition-cluster", R.prohibitionCluster, "plugins/p/commands/nope.md"],
];

describe("rules: positive and negative fixture per rule", () => {
  for (const [name, rule, file] of CASES) {
    test(`${name} fires on the bad repo`, () => {
      const hits = rule(bad).filter((f) => f.rule === name && f.file === file);
      expect(hits.length).toBeGreaterThan(0);
    });
    test(`${name} stays quiet on the clean repo`, () => {
      expect(rule(clean)).toEqual([]);
    });
  }

  test("every v1 rule is covered", () => {
    expect(new Set(CASES.map((c) => c[1]))).toEqual(
      new Set(ALL_RULES.map((r) => r)),
    );
  });

  test("rule-specific negatives: scoped rule and non-hot skill are not flagged", () => {
    expect(R.ruleWithoutPaths(bad).some((f) => f.file.endsWith("scoped.md"))).toBe(false);
    expect(R.skillToDocsIndex(bad).some((f) => f.file.includes("/orig/"))).toBe(false);
    expect(R.blameAge(bad).some((f) => f.file === "docs/a.md")).toBe(false);
  });

  test("usage-dependent rules return nothing without usage data", () => {
    const noUsage = { ...bad, usage: null };
    expect(R.invokeCostWeekly(noUsage)).toEqual([]);
    expect(R.skillToDocsIndex(noUsage)).toEqual([]);
  });
});

describe("finding records", () => {
  const all = runAllRules(bad);

  test("every finding is labelled and quality-claimed always has an eval", () => {
    expect(all.length).toBeGreaterThan(20);
    for (const f of all) {
      expect(["cost-only", "quality-claimed"]).toContain(f.claim);
      if (f.claim === "quality-claimed") {
        expect(f.measurement.tier).toBe("eval");
        expect(f.measurement.evals?.length).toBeGreaterThan(0);
      } else {
        expect(f.measurement.tier).toBe("static");
      }
      expect(f.fingerprint).toMatch(/^[0-9a-f]{12}$/);
      expect(f.metrics.units).toBeTruthy();
    }
  });

  test("quality-claimed rules are the ones that change what the model reads", () => {
    const quality = new Set(all.filter((f) => f.claim === "quality-claimed").map((f) => f.rule));
    expect([...quality].sort()).toEqual([
      "caps-emphasis-ratio",
      "instruction-count-high",
      "key-instructions-not-near-top",
      "move-to-path-rule",
      "prohibition-cluster",
      "skill-to-docs-index",
    ]);
  });

  test("always-loaded files use production-series, others with-without", () => {
    const f = (rule: string, file: string): Finding => {
      const hit = all.find((x) => x.rule === rule && x.file === file);
      if (!hit) throw new Error(`missing ${rule} ${file}`);
      return hit;
    };
    expect(f("key-instructions-not-near-top", "CLAUDE.md").measurement.evals?.[0].kind).toBe("production-series");
    expect(f("instruction-count-high", "plugins/p/commands/many.md").measurement.evals?.[0].kind).toBe("with-without");
    expect(f("skill-to-docs-index", "plugins/p/skills/hot/SKILL.md").measurement.evals?.[0].kind).toBe("trigger");
  });

  test("fingerprints are stable across runs and unique per finding", () => {
    expect(runAllRules(bad).map((f) => f.fingerprint)).toEqual(all.map((f) => f.fingerprint));
    expect(new Set(all.map((f) => f.fingerprint)).size).toBe(all.length);
  });

  test("makeFinding without evalKind is cost-only and static", () => {
    const item = bad.items[0];
    const f = makeFinding({
      class: "a", rule: "x", item, evidence: "e",
      metrics: { before: 1, units: "u", estimated: false },
      action: "a", severity: "low",
    });
    expect(f.claim).toBe("cost-only");
    expect(f.measurement.evals).toBeUndefined();
  });

  test("measured delta replaces the static count in invoke-cost-weekly", () => {
    const f = R.invokeCostWeekly(bad)[0];
    expect(f.metrics.before).toBe(600_000);
    expect(f.metrics.estimated).toBe(false);
  });
});
