import { beforeAll, describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SKILL_MD_PATH = join(import.meta.dir, "SKILL.md");

let content: string;

beforeAll(() => {
  content = existsSync(SKILL_MD_PATH) ? readFileSync(SKILL_MD_PATH, "utf-8") : "";
});

describe("SKILL.md — file exists and has content", () => {
  it("file exists", () => {
    expect(existsSync(SKILL_MD_PATH)).toBe(true);
  });

  it("is non-empty", () => {
    expect(content.length).toBeGreaterThan(200);
  });
});

describe("SKILL.md — frontmatter", () => {
  it("has frontmatter with name: entropy-scan", () => {
    expect(content).toContain("name: entropy-scan");
  });

  it("has frontmatter with a description field", () => {
    expect(content).toMatch(/^description:/m);
  });
});

describe("SKILL.md — report-only, no code changes", () => {
  it("declares it makes no code changes", () => {
    expect(content).toContain("No code changes");
  });

  it("declares no git operations", () => {
    expect(content).toContain("No git operations");
  });

  it("declares no PR creation", () => {
    expect(content).toContain("No PR creation");
  });
});

describe("SKILL.md — Repo Scope consumes a precheck-provided repo list (RSF-3.1)", () => {
  it("has a Repo Scope section", () => {
    expect(content).toContain("## Repo Scope");
  });

  it("documents the precheck-driven repo list as the preferred source", () => {
    expect(content).toContain("Precheck-driven (preferred)");
    expect(content).toContain("shipwright:check-patrol-scope.ts");
  });

  it("names the entropy-patrol-maintenance cron whose preCheck supplies the list", () => {
    expect(content).toContain("entropy-patrol-maintenance");
  });

  it("documents that the preCheck's stdout becomes the invoking prompt", () => {
    const text = content.toLowerCase();
    expect(text).toContain("stdout becomes the actual prompt");
  });

  it("preserves manual single-repo invocation as an explicit fallback", () => {
    expect(content).toContain("Fallback (manual invocation");
    expect(content).toContain("git remote get-url origin");
  });

  it("documents running Steps 1-6 once per repo, cd'ing into each repo's clone dir", () => {
    const text = content.toLowerCase();
    expect(text).toContain("cd` into its local clone directory");
    expect(text).toContain("scoped to that repo");
  });

  it("is positioned before Setup: Parse Arguments", () => {
    const repoScopeIndex = content.indexOf("## Repo Scope");
    const setupIndex = content.indexOf("## Setup: Parse Arguments");
    expect(repoScopeIndex).toBeGreaterThan(-1);
    expect(setupIndex).toBeGreaterThan(-1);
    expect(repoScopeIndex).toBeLessThan(setupIndex);
  });
});

describe("SKILL.md — suppressions (.shipwright/suppressions.yml)", () => {
  const refPath = join(import.meta.dir, "references", "suppressions.md");

  it("applies suppressions between the scan and the report", () => {
    const step = content.indexOf("## Step 3.5: Apply Suppressions");
    expect(step).toBeGreaterThan(content.indexOf("## Step 3: Run the Scan"));
    expect(step).toBeLessThan(content.indexOf("## Step 4: Write the Report"));
  });

  it("reads .shipwright/suppressions.yml via the shared script", () => {
    expect(content).toContain(".shipwright/suppressions.yml");
    expect(content).toContain('suppressions.ts" --filter');
  });

  it("prints the suppressed count and lists expired entries", () => {
    expect(content).toContain("Suppressed:");
    expect(content).toContain("no longer suppressing");
  });

  it("limits expired entries to the entropy rule", () => {
    expect(content).toContain('`rule == "entropy"`');
  });

  it("keeps suppressed findings out of the report and quality log", () => {
    expect(content).toMatch(/Never report a finding suppressed/);
    expect(content).toContain("totalViolations");
  });

  it("links the per-principle match-key reference", () => {
    expect(content).toContain("references/suppressions.md");
    expect(existsSync(refPath)).toBe(true);
  });

  it("documents the optional suppressed field in the quality-log schema", () => {
    const schema = readFileSync(
      join(import.meta.dir, "references", "quality-log-schema.md"),
      "utf-8",
    );
    expect(schema).toContain("`suppressed`");
  });

  it("reference names every scannable rule in principles.md", () => {
    const ref = readFileSync(refPath, "utf-8");
    const principles = readFileSync(
      join(import.meta.dir, "..", "..", "references", "principles.md"),
      "utf-8",
    );
    const scannable = principles
      .split(/^### /m)
      .slice(1)
      .filter((b) => b.includes("**Detection:**"))
      .map((b) => b.match(/^`([^`]+)`/)?.[1])
      .filter((id): id is string => !!id && /^[a-z_]+$/.test(id));
    expect(scannable.length).toBeGreaterThanOrEqual(12);
    for (const id of scannable) expect(ref).toContain(`\`${id}\``);
  });
});
