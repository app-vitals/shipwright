/**
 * Coupling guard between renovate.json and agent/Dockerfile (CCU-1.2).
 *
 * Renovate tracks the pinned claude-code CLI through a regex custom manager
 * that matches the annotated `ARG CLAUDE_CODE_VERSION=` line in the agent
 * Dockerfile. If that line is reformatted so the regex no longer matches,
 * Renovate silently stops proposing updates — nothing else would notice.
 *
 * Content-assertion only: readFileSync, no I/O beyond local file reads.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, ".");

type CustomManager = {
  customType?: string;
  managerFilePatterns?: string[];
  matchStrings?: string[];
  datasourceTemplate?: string;
  schedule?: unknown;
};

type PackageRule = {
  matchPackageNames?: string[];
  followTag?: string;
  groupName?: string;
  matchUpdateTypes?: string[];
  separateMajorMinor?: boolean;
  schedule?: unknown;
};

type RenovateConfig = {
  schedule?: string[];
  customManagers?: CustomManager[];
  packageRules?: PackageRule[];
};

const CLAUDE_CODE = "@anthropic-ai/claude-code";
const GENERIC_GROUP = "routine dependency updates";

function loadConfig(): RenovateConfig {
  return JSON.parse(readFileSync(join(repoRoot, "renovate.json"), "utf8"));
}

function dockerfile(): string {
  return readFileSync(join(repoRoot, "agent/Dockerfile"), "utf8");
}

// Renovate wraps regex-looking patterns as "/.../"; strip the slashes to get a JS RegExp.
function fromRenovatePattern(pattern: string): RegExp {
  expect(pattern.startsWith("/") && pattern.endsWith("/")).toBe(true);
  return new RegExp(pattern.slice(1, -1));
}

function claudeCodeManager(): CustomManager {
  const manager = (loadConfig().customManagers ?? []).find((m) =>
    (m.matchStrings ?? []).some((s) => s.includes("CLAUDE_CODE_VERSION")),
  );
  if (!manager) {
    throw new Error(
      "renovate.json has no customManagers entry for CLAUDE_CODE_VERSION",
    );
  }
  return manager;
}

describe("renovate.json claude-code custom manager", () => {
  it("is a regex manager that targets the agent Dockerfile", () => {
    const manager = claudeCodeManager();
    expect(manager.customType).toBe("regex");
    const filePatterns = (manager.managerFilePatterns ?? []).map(
      fromRenovatePattern,
    );
    expect(filePatterns.some((re) => re.test("agent/Dockerfile"))).toBe(true);
  });

  it("matchStrings extracts the npm dep name and a semver currentValue from the real Dockerfile", () => {
    const manager = claudeCodeManager();
    const matches = (manager.matchStrings ?? []).map((s) =>
      new RegExp(s).exec(dockerfile()),
    );
    const match = matches.find((m) => m?.groups?.depName === CLAUDE_CODE);
    expect(match).toBeDefined();
    expect(match?.groups?.depName).toBe(CLAUDE_CODE);
    expect(match?.groups?.currentValue).toMatch(/^\d+\.\d+\.\d+$/);
    // datasource comes from the inline `# renovate:` annotation or the manager's template.
    expect(match?.groups?.datasource ?? manager.datasourceTemplate).toBe("npm");
  });
});

describe("renovate.json claude-code packageRule", () => {
  const rules = () => loadConfig().packageRules ?? [];
  const claudeRuleIndex = () =>
    rules().findIndex((r) => (r.matchPackageNames ?? []).includes(CLAUDE_CODE));
  const genericRuleIndex = () =>
    rules().findIndex((r) => r.groupName === GENERIC_GROUP);

  it("exists and follows the stable tag", () => {
    expect(claudeRuleIndex()).toBeGreaterThanOrEqual(0);
    expect(rules()[claudeRuleIndex()].followTag).toBe("stable");
  });

  it("has its own groupName, distinct from the routine grouping", () => {
    const { groupName } = rules()[claudeRuleIndex()];
    expect(groupName).toBeTruthy();
    expect(groupName).not.toBe(GENERIC_GROUP);
  });

  it("is declared after the generic grouping rule so it is not folded into it", () => {
    expect(genericRuleIndex()).toBeGreaterThanOrEqual(0);
    expect(claudeRuleIndex()).toBeGreaterThan(genericRuleIndex());
  });

  it("does not override the schedule — the Monday window is inherited", () => {
    const config = loadConfig();
    expect(config.schedule).toEqual(["before 6am on monday"]);
    expect(rules()[claudeRuleIndex()].schedule).toBeUndefined();
    expect(claudeCodeManager().schedule).toBeUndefined();
  });
});

describe("renovate.json zod / @hono/zod-openapi group rule (ZOD-1.1)", () => {
  const rules = () => loadConfig().packageRules ?? [];
  const zodRuleIndex = () =>
    rules().findIndex((r) => (r.matchPackageNames ?? []).includes("zod"));

  it("groups zod and @hono/zod-openapi into one PR", () => {
    const rule = rules()[zodRuleIndex()];
    expect(rule).toBeDefined();
    expect(rule.matchPackageNames).toContain("@hono/zod-openapi");
    expect(rule.groupName).toBeTruthy();
    expect(rule.groupName).not.toBe(GENERIC_GROUP);
  });

  it("is declared after the generic grouping rule so minor/patch bumps stay paired too", () => {
    const genericIndex = rules().findIndex(
      (r) => r.groupName === GENERIC_GROUP,
    );
    expect(zodRuleIndex()).toBeGreaterThan(genericIndex);
  });

  it("covers major updates (no matchUpdateTypes filter that would exclude them, majors not split out)", () => {
    const rule = rules()[zodRuleIndex()];
    const types = rule.matchUpdateTypes;
    expect(types === undefined || types.includes("major")).toBe(true);
    expect(rule.separateMajorMinor).toBe(false);
  });
});
