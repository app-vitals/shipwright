import { beforeAll, describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SKILL_MD_PATH = join(import.meta.dir, "SKILL.md");

let content: string;

beforeAll(() => {
  content = existsSync(SKILL_MD_PATH)
    ? readFileSync(SKILL_MD_PATH, "utf-8")
    : "";
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

  it("limits writes to the docs file in a worktree, via a docs PR only", () => {
    expect(content).toContain("only repo file this skill writes");
    expect(content).toContain("never committed");
  });

  it("never creates tasks (that belongs to entropy-fix)", () => {
    expect(content).toContain("No task creation");
  });
});

describe("SKILL.md — required --repo, one repo per run (PCR-3.1)", () => {
  it("documents the usage error when --repo is missing", () => {
    expect(content).toContain(
      "Usage: /shipwright:entropy-scan --repo org/repo",
    );
    expect(content).toMatch(/--repo.{0,60}(required|Required)/s);
  });

  it("prints the usage error in Setup, before any other work", () => {
    const setup = content.indexOf("## Setup: Parse Arguments");
    const usage = content.indexOf("Usage: /shipwright:entropy-scan --repo");
    expect(setup).toBeGreaterThan(-1);
    expect(usage).toBeGreaterThan(setup);
    expect(usage).toBeLessThan(content.indexOf("## Step 0:"));
    expect(content).toContain("stop without");
  });

  it("no longer scans repos/ as a multi-repo list or uses the precheck", () => {
    expect(content).not.toContain("shipwright:check-patrol-scope.ts");
    expect(content).not.toContain("Precheck-driven");
    expect(content).not.toContain("entropy-patrol-maintenance");
    expect(content).not.toContain("Fallback (manual invocation");
    expect(content).not.toContain("git remote get-url origin");
    expect(content).toContain("never scans `repos/`");
  });

  it("works in a worktree and branch, like test-readiness", () => {
    expect(content).toContain("docs/entropy-patrol-");
    expect(content).toContain("worktree add");
  });
});

describe("SKILL.md — no legacy state file outside the one-time import (PCR-3.1)", () => {
  const LEGACY = "state/entropy-patrol-last-run.json";

  it("mentions the legacy file only inside the one-time import step", () => {
    const start = content.indexOf("## Step 1.5: Read the prior run");
    expect(start).toBeGreaterThan(-1);
    const end = content.indexOf("\n---", start);
    const outside = content.slice(0, start) + content.slice(end);
    expect(outside).not.toContain(LEGACY);
    expect(outside).not.toContain("entropy-patrol-last-run");
    expect(content.slice(start, end)).toContain(
      "--legacy-shape entropy-patrol-last-run",
    );
  });

  it("reads prior state from the recorder (/cron-runs/latest)", () => {
    expect(content).toContain("cron-run-recorder.ts");
    expect(content).toContain("/cron-runs/latest");
    expect(content).toMatch(/cron-run-recorder\.ts"? prior/);
  });
});

describe("SKILL.md — docs/patrols/entropy.md output (PCR-3.1)", () => {
  it("writes exactly one docs file, validated by the checker", () => {
    expect(content).toContain("docs/patrols/entropy.md");
    expect(content).toContain("check-patrol-docs.ts");
    expect(content).toContain("materiallyChanged");
    expect(content).toMatch(/exactly one file under `docs\/patrols\/`/);
  });

  it("no longer writes entropy-report.md to the clone root", () => {
    expect(content).not.toContain("entropy-report.md");
    expect(content).toContain("clone root");
  });

  it("opens a docs PR only on material change, reusing the test-readiness path", () => {
    expect(content).toMatch(/only (when|on).{0,40}material/i);
    expect(content).toContain("test-readiness");
    expect(content).toContain("gh pr create");
    expect(content).toContain("--label shipwright");
  });

  it("--dry-run records no run and opens no PR", () => {
    const dry = content.match(/`--dry-run`[^\n]*/)?.[0] ?? "";
    expect(dry).toMatch(/no run/i);
    expect(dry).toMatch(/no PR/i);
  });

  it("records only a failed run itself; the success run is recorded once by entropy-fix", () => {
    expect(content).toMatch(/record --cron entropy-patrol --repo/);
    expect(content).toContain('"outcome": "failed"');
    expect(content).toContain("entropy-fix");
    expect(content).toMatch(/records the (single|one) run/i);
  });
});

describe("SKILL.md — suppressions (.shipwright/suppressions.yml)", () => {
  const refPath = join(import.meta.dir, "references", "suppressions.md");

  it("applies suppressions between the scan and the report", () => {
    const step = content.indexOf("## Step 3.5: Apply Suppressions");
    expect(step).toBeGreaterThan(content.indexOf("## Step 3: Run the Scan"));
    expect(step).toBeLessThan(
      content.indexOf("## Step 4: Write docs/patrols/entropy.md"),
    );
  });

  it("reads .shipwright/suppressions.yml via the shared script", () => {
    expect(content).toContain(".shipwright/suppressions.yml");
    expect(content).toContain('suppressions.ts" --filter');
  });

  it("prints the suppressed count and an expired-suppressions count in the capped summary", () => {
    expect(content).toContain("(suppressed: {N})");
    expect(content).toContain("Expired suppressions: {N}");
  });

  it("limits expired entries to the entropy rule", () => {
    expect(content).toContain('`rule == "entropy"`');
  });

  it("keeps suppressed findings out of the report and run-record counts", () => {
    expect(content).toMatch(/Never report a finding suppressed/);
    expect(content).toContain("run record's counts");
  });

  it("links the per-principle match-key reference", () => {
    expect(content).toContain("references/suppressions.md");
    expect(existsSync(refPath)).toBe(true);
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

describe("SKILL.md — capped final summary (CSM-2.7)", () => {
  it("caps the final summary at 3-5 lines and keeps detail in the report file", () => {
    const section =
      content.match(/## Step \d+: Print Summary[\s\S]*?\n---/)?.[0] ?? "";
    expect(section).toContain("3-5 lines");
    expect(section).toContain("ENTROPY SCAN COMPLETE");
    expect(section).toContain("docs/patrols/entropy.md");
    expect(section).not.toContain("━");
  });
});

describe("SKILL.md — --trend reads durable run records", () => {
  it("reads the trend from GET /cron-runs for this repo", () => {
    expect(content).toContain(
      "/cron-runs?cronId=entropy-patrol&repo={url-encoded-repo}",
    );
  });

  it("skips failed runs and needs at least 2 runs", () => {
    expect(content).toMatch(/outcome` `ok` or `no_op`/);
    expect(content).toContain("need at least 2 runs");
  });

  it("keeps no local quality log", () => {
    expect(content).not.toContain("quality-log.jsonl");
    expect(content).not.toContain("Append to Quality Log");
    expect(
      existsSync(join(import.meta.dir, "references", "quality-log-schema.md")),
    ).toBe(false);
  });
});
