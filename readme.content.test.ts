/**
 * Regression guard for the stale hardcoded version claim (MMA-1.2).
 *
 * README.md's "Project status" section once stated "...all ship with
 * v0.1.0" — a version that drifted immediately since the release badge at
 * the top of the file already pulls the live version from GitHub releases.
 * No other test layer covers static markdown copy, so this content test is
 * the only thing that would catch a future editor re-hardcoding a version.
 *
 * Content-assertion only: readFileSync, no I/O beyond a local file read.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, ".");

function projectStatusSection(): string {
  const content = readFileSync(join(repoRoot, "README.md"), "utf8");
  const start = content.indexOf("## Project status");
  if (start === -1) {
    throw new Error("README.md is missing a '## Project status' section");
  }
  const nextHeading = content.indexOf("\n## ", start + 1);
  return nextHeading === -1
    ? content.slice(start)
    : content.slice(start, nextHeading);
}

describe("README.md Project status section", () => {
  it("does not hardcode a bare version literal", () => {
    const section = projectStatusSection();
    expect(section).not.toMatch(/\bv0\.\d+(\.\d+)?\b/);
  });

  it("still communicates that the plugin, metrics dashboard, and agent ship together", () => {
    const section = projectStatusSection();
    expect(section).toMatch(/plugin/i);
    expect(section).toMatch(/metrics dashboard/i);
    expect(section).toMatch(/shipwright agent/i);
  });
});

describe("README.md competitor-naming policy (brand/MESSAGING.md D10)", () => {
  const content = readFileSync(join(repoRoot, "README.md"), "utf8");

  it("does not name a competitor", () => {
    const match = content.match(/devin|cursor|openhands|augment code|copilot/i);
    expect(match?.[0] ?? null).toBeNull();
  });

  it("still has the Compare it bullet", () => {
    expect(content).toMatch(/\*\*Compare it\*\*/);
  });
});

describe("docs/quickstart.md first-PR path", () => {
  const content = readFileSync(join(repoRoot, "docs/quickstart.md"), "utf8");

  it("uses the working two-step plugin install form", () => {
    expect(content).toContain("/plugin marketplace add app-vitals/shipwright");
    expect(content).toContain("/plugin install shipwright@shipwright");
  });

  it("does not use the failing marketplace-qualified install form", () => {
    expect(content).not.toContain("shipwright@app-vitals/shipwright");
  });

  it("does not contain stale not-yet-built phrases", () => {
    expect(content).not.toMatch(
      /still being built|coming soon|🚧|not yet ready/i,
    );
  });

  it("walks plan-session, dev-task and review via the local store", () => {
    expect(content).toContain("scripts/local-store.sh");
    expect(content).toContain("/shipwright:plan-session");
    expect(content).toContain("/shipwright:dev-task");
    expect(content).toContain("/shipwright:review");
  });

  it("states the Docker prerequisite, expected time and CI coverage limits", () => {
    expect(content).toMatch(/\*\*Docker\*\*/);
    expect(content).toMatch(/## Expected time/);
    expect(content).toMatch(/## What CI does not cover/);
  });

  it("tells the reader about the plan PR and plan-session's two confirmations", () => {
    expect(content).toMatch(/plan PR/i);
    expect(content).toMatch(/Confirm the detected repo/);
    expect(content).toMatch(/Approve the design and task breakdown/);
  });
});

describe("docs/quickstart.md reorder (CRQ-7.1)", () => {
  const content = readFileSync(join(repoRoot, "docs/quickstart.md"), "utf8");
  const firstPr = content.slice(
    content.indexOf("## Before you start"),
    content.indexOf("## Clean-up"),
  );

  it("starts the task store and sources the env file before launching Claude Code", () => {
    const store = firstPr.indexOf("scripts/local-store.sh");
    const source = firstPr.indexOf("source ~/.shipwright/local-store.env");
    const launch = firstPr.indexOf("\nclaude\n");
    expect(store).toBeGreaterThan(-1);
    expect(source).toBeGreaterThan(store);
    expect(launch).toBeGreaterThan(source);
  });

  it("never tells the reader to exit Claude Code", () => {
    expect(firstPr).not.toMatch(/\b(exit|quit|leave) Claude Code|\/exit/i);
  });

  it("labels every code block with where it is typed and keeps slash commands to one per block", () => {
    const blocks = [...firstPr.matchAll(/```(\w+)\n([\s\S]*?)```/g)];
    expect(blocks.length).toBeGreaterThan(0);
    for (const [, lang, body] of blocks) {
      if (lang === "text") {
        const cmds = body.split("\n").filter((l) => l.startsWith("/"));
        expect(cmds.length).toBe(1);
      } else {
        expect(lang).toBe("bash");
      }
    }
    for (const heading of firstPr.match(/^## .*$/gm) ?? []) {
      if (/^## Step/.test(heading)) {
        expect(heading).toMatch(/\((in your terminal|inside Claude Code)\)/);
      }
    }
  });

  it("has no angle-bracket placeholder in a code block", () => {
    for (const [, , body] of firstPr.matchAll(/```(\w+)\n([\s\S]*?)```/g)) {
      expect(body).not.toMatch(/<[A-Za-z][^>\n]*>/);
    }
  });

  it("has runnable checks for gh auth, Bun, git identity and the repo", () => {
    expect(firstPr).toContain("gh auth status");
    expect(firstPr).toContain("bun --version");
    expect(firstPr).toContain("git config user.name");
    expect(firstPr).toMatch(/gh repo (create|clone)/);
  });

  it("creates the spec with a heredoc and warns about running plan-session first", () => {
    expect(firstPr).toContain("planning/first-pr/PRODUCT-SPEC.md");
    expect(firstPr).toContain("<<'SPEC'");
    expect(firstPr).toMatch(/appears in the transcript/);
  });

  it("cites the 48-minute human run and the missed 15-minute target", () => {
    expect(content).toMatch(/48 minutes/);
    expect(content).toMatch(/13 minutes/);
    expect(content).toMatch(/15 minutes/);
    expect(content).toMatch(/14 min 15 s/);
  });

  it("splits the two-line plugin install block in every file that shows it", () => {
    const files = [
      "README.md",
      "plugins/shipwright/README.md",
      "docs/quickstart.md",
      ".claude/skills/marketplace-dev/references/plugin-scaffolding.md",
    ];
    for (const f of files) {
      const text = readFileSync(join(repoRoot, f), "utf8");
      expect(text).not.toMatch(
        /\/plugin marketplace add app-vitals\/shipwright\n\/plugin install/,
      );
    }
  });
});

describe("README.md Quickstart section (CRQ-3.2)", () => {
  const readme = readFileSync(join(repoRoot, "README.md"), "utf8");
  const start = readme.indexOf("## Quickstart");
  const end = readme.indexOf("\n## ", start + 1);
  const quickstart = readme.slice(start, end);

  it("has a Quickstart section", () => {
    expect(start).toBeGreaterThan(-1);
  });

  it("uses the working two-step plugin install form", () => {
    expect(quickstart).toContain(
      "/plugin marketplace add app-vitals/shipwright",
    );
    expect(quickstart).toContain("/plugin install shipwright@shipwright");
  });

  it("never uses the failing marketplace-qualified install form", () => {
    expect(readme).not.toContain("shipwright@app-vitals/shipwright");
  });

  it("starts the local task store and walks plan-session, dev-task and review", () => {
    expect(quickstart).toContain("scripts/local-store.sh");
    expect(quickstart).toContain("/shipwright:plan-session");
    expect(quickstart).toContain("/shipwright:dev-task");
    expect(quickstart).toContain("/shipwright:review");
  });

  it("lists the Docker, gh and git prerequisites", () => {
    expect(quickstart).toMatch(/Docker/);
    expect(quickstart).toMatch(/\bgh\b/);
    expect(quickstart).toMatch(/\bgit\b/);
  });

  it("links to docs/quickstart.md", () => {
    expect(quickstart).toContain("(./docs/quickstart.md)");
  });

  it("contains no stale not-yet-built phrases", () => {
    expect(quickstart).not.toMatch(
      /still being built|coming soon|🚧|not yet ready/i,
    );
  });

  it("keeps the metrics dashboard and full dev stack as optional content", () => {
    expect(quickstart).toMatch(/Optional/);
    expect(quickstart).toContain("task stack");
  });
});
