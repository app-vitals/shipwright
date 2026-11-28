import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  isoWeek,
  planBaselineTasks,
  scanBaseline,
} from "./entropy-baseline";

const dirs: string[] = [];
function fixture(files: Record<string, string>): string {
  const d = mkdtempSync(join(tmpdir(), "entropy-baseline-"));
  dirs.push(d);
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(d, rel)), { recursive: true });
    writeFileSync(join(d, rel), body);
  }
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const bare = {
  "package.json": JSON.stringify({ name: "x", devDependencies: {} }),
  "src/index.js": "export const a = 1;\n",
};
const week = isoWeek(new Date("2026-11-28T00:00:00Z"));

describe("entropy baseline — repo with no repo-specific principles", () => {
  it("reports a missing formatter and missing pre-commit hooks", () => {
    const ids = scanBaseline(fixture(bare)).map((f) => f.ruleId);
    expect(ids).toContain("tooling_formatter");
    expect(ids).toContain("tooling_pre_commit");
    expect(ids).toContain("tooling_linter");
    expect(ids).toContain("tooling_ci_lint_typecheck");
  });

  it("routes formatter and pre-commit as auto, via the task-store task shape", () => {
    const findings = scanBaseline(fixture(bare));
    const tasks = planBaselineTasks(findings, "acme/widgets", week, []);
    for (const rule of ["tooling_formatter", "tooling_pre_commit"]) {
      const t = tasks.find((x) => x.id.startsWith(`entropy-${rule}-`));
      expect(findings.find((f) => f.ruleId === rule)?.route).toBe("auto");
      expect(t?.status).toBe("pending");
      expect(t?.hitl).toBe(false);
      expect(t?.originRef).toBe("entropy-patrol");
    }
  });

  it("reports nothing for a fully configured repo", () => {
    const d = fixture({
      "package.json": JSON.stringify({ name: "x" }),
      "biome.json": "{}",
      ".husky/pre-commit": "bun run lint",
      ".github/workflows/ci.yml": "steps:\n  - run: bunx biome check .\n",
    });
    expect(scanBaseline(d)).toEqual([]);
  });

  it("detects typescript and a missing type checker in CI", () => {
    const d = fixture({
      "package.json": JSON.stringify({ devDependencies: { typescript: "5" } }),
      "biome.json": "{}",
      ".husky/pre-commit": "x",
      ".github/workflows/ci.yml": "run: biome check\n",
    });
    const ids = scanBaseline(d).map((f) => f.ruleId);
    expect(ids).toContain("tooling_type_checker");
    expect(ids).toContain("tooling_ci_lint_typecheck");
  });
});

describe("entropy baseline — stricter mode routes to review", () => {
  const ts = {
    "package.json": JSON.stringify({ name: "x" }),
    "tsconfig.json": '{ // comment\n "compilerOptions": { "target": "es2022" }, }',
    "biome.json": "{}",
    ".husky/pre-commit": "x",
    ".github/workflows/ci.yml": "run: biome check && tsc --noEmit\n",
  };

  it("flags strict-off as review, blocked with needs-review, never auto", () => {
    const findings = scanBaseline(fixture(ts));
    expect(findings.map((f) => f.ruleId)).toEqual(["tooling_stricter_mode"]);
    expect(findings[0].route).toBe("review");
    const [task] = planBaselineTasks(findings, "acme/widgets", week, []);
    expect(task.status).toBe("blocked");
    expect(task.blockedReason?.startsWith("needs-review:")).toBe(true);
    expect(task.hitl).toBe(false);
  });

  it("does not flag when strict is on", () => {
    const d = fixture({
      ...ts,
      "tsconfig.json": '{"compilerOptions":{"strict":true}}',
    });
    expect(scanBaseline(d)).toEqual([]);
  });
});

describe("entropy baseline — idempotent re-run", () => {
  it("yields identical findings and queues no duplicate tasks", () => {
    const d = fixture(bare);
    const first = scanBaseline(d);
    expect(scanBaseline(d)).toEqual(first);
    const tasks = planBaselineTasks(first, "acme/widgets", week, []);
    expect(tasks.length).toBe(first.length);
    const again = planBaselineTasks(
      first,
      "acme/widgets",
      week,
      tasks.map((t) => t.id),
    );
    expect(again).toEqual([]);
    // a later week still dedups against the still-active task
    expect(
      planBaselineTasks(first, "acme/widgets", "2026-W50", tasks.map((t) => t.id)),
    ).toEqual([]);
  });
});

describe("entropy baseline — other toolchains", () => {
  it("python without ruff/mypy is flagged; go/rust built-ins are not", () => {
    const py = scanBaseline(fixture({ "pyproject.toml": "[project]\nname='x'\n" }));
    expect(py.map((f) => f.ruleId)).toContain("tooling_type_checker");
    const go = scanBaseline(fixture({ "go.mod": "module x\n" })).map((f) => f.ruleId);
    expect(go).toContain("tooling_linter");
    expect(go).not.toContain("tooling_formatter");
    expect(go).not.toContain("tooling_type_checker");
  });

  it("returns nothing when no toolchain is detected", () => {
    expect(scanBaseline(fixture({ "README.md": "hi" }))).toEqual([]);
  });
});
