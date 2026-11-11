/**
 * Content guard for .github/workflows/ci.yml (AFB-1.2): the admin spec and
 * types generation must run on every PR inside the existing required job, so a
 * dependency change that breaks it fails at PR time, not at platform-release.
 *
 * Lives at the repo root (not under .github/) because `bun test` never walks
 * dot-directories.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const PATH = join(resolve(import.meta.dir), ".github/workflows/ci.yml");

type Step = { name?: string; run?: string };
type Workflow = {
  on: { pull_request?: unknown };
  jobs: Record<string, { steps: Step[] }>;
};

const text = readFileSync(PATH, "utf8");
const wf = Bun.YAML.parse(text) as Workflow;
const step = wf.jobs.ci.steps.find((s) =>
  s.run?.includes("generate:admin-spec"),
);

describe("ci.yml admin generation guard", () => {
  it("runs on every pull request, unfiltered", () => {
    expect("pull_request" in wf.on).toBe(true);
  });

  it("has a step in the required ci job running both generate scripts", () => {
    expect(step).toBeDefined();
    expect(step?.run).toContain("bun run generate:admin-spec");
    expect(step?.run).toContain("bun run generate:admin-types");
  });

  it("fails on drift over the generated files", () => {
    const run = step?.run ?? "";
    expect(run).toMatch(/git diff --exit-code/);
    for (const f of [
      "admin/openapi.json",
      "admin/src/coding/openapi.coding.json",
      "admin/src/coding/admin-types.ts",
    ]) {
      expect(run).toContain(f);
    }
  });

  it("introduces no secrets references in the guard step", () => {
    expect(step?.run ?? "").not.toContain("secrets.");
    expect(JSON.stringify(step)).not.toContain("secrets.");
  });
});
