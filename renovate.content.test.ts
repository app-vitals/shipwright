/**
 * Content guards for renovate.json's package rules (ZOD-1.1, AGR-4.1).
 *
 * The claude-code CLI pin and its custom manager moved to the platform image
 * with AGR-4.3b; agent/Dockerfile no longer carries `ARG CLAUDE_CODE_VERSION`.
 *
 * Content-assertion only: readFileSync, no I/O beyond local file reads.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, ".");

type PackageRule = {
  matchPackageNames?: string[];
  followTag?: string;
  groupName?: string;
  matchUpdateTypes?: string[];
  separateMajorMinor?: boolean;
  schedule?: unknown;
  rangeStrategy?: string;
  addLabels?: string[];
};

type RenovateConfig = {
  schedule?: string[];
  packageRules?: PackageRule[];
};

const GENERIC_GROUP = "routine dependency updates";

function loadConfig(): RenovateConfig {
  return JSON.parse(readFileSync(join(repoRoot, "renovate.json"), "utf8"));
}

// Renovate wraps regex-looking patterns as "/.../"; strip the slashes to get a JS RegExp.
function fromRenovatePattern(pattern: string): RegExp {
  expect(pattern.startsWith("/") && pattern.endsWith("/")).toBe(true);
  return new RegExp(pattern.slice(1, -1));
}

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

describe("renovate.json app-vitals agent platform group rule (AGR-4.1)", () => {
  const PLATFORM_GROUP = "app-vitals agent platform";
  const rules = () => loadConfig().packageRules ?? [];
  const platformRuleIndex = () =>
    rules().findIndex((r) => r.groupName === PLATFORM_GROUP);
  const matches = (name: string) =>
    (rules()[platformRuleIndex()].matchPackageNames ?? []).some((p) =>
      p.startsWith("/") ? fromRenovatePattern(p).test(name) : p === name,
    );

  it("groups every @app-vitals/agent-* package and nothing else", () => {
    expect(platformRuleIndex()).toBeGreaterThanOrEqual(0);
    for (const name of [
      "@app-vitals/agent-lib",
      "@app-vitals/agent-admin",
      "@app-vitals/agent-runtime",
    ]) {
      expect(matches(name), name).toBe(true);
    }
    for (const name of [
      "@app-vitals/agentic",
      "agent-lib",
      "@shipwright/lib",
    ]) {
      expect(matches(name), name).toBe(false);
    }
  });

  it("covers every registry @app-vitals/agent-* dependency the repo declares", () => {
    for (const file of [
      "package.json",
      "admin/package.json",
      "agent/package.json",
      "chat/package.json",
      "metrics/package.json",
      "task-store/package.json",
    ]) {
      const pkg = JSON.parse(readFileSync(join(repoRoot, file), "utf8"));
      for (const [name, value] of Object.entries<string>(
        pkg.dependencies ?? {},
      )) {
        if (!name.startsWith("@app-vitals/agent-")) continue;
        if (value.startsWith("workspace:")) continue;
        expect(matches(name), `${file}: ${name}`).toBe(true);
        // Exact pins: the receiver workflow and Renovate both keep them exact.
        expect(value, `${file}: ${name}`).toMatch(/^\d+\.\d+\.\d+$/);
      }
    }
  });

  it("is declared after the generic grouping rule so it is not folded into it", () => {
    const genericIndex = rules().findIndex(
      (r) => r.groupName === GENERIC_GROUP,
    );
    expect(genericIndex).toBeGreaterThanOrEqual(0);
    expect(platformRuleIndex()).toBeGreaterThan(genericIndex);
  });

  it("keeps majors in the same PR, and pins exactly", () => {
    const rule = rules()[platformRuleIndex()];
    expect(rule.matchUpdateTypes).toBeUndefined();
    expect(rule.separateMajorMinor).toBe(false);
    expect(rule.rangeStrategy).toBe("pin");
    expect(rule.addLabels).toBeUndefined();
  });
});
