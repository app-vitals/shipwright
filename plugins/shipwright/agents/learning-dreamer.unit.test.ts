import { beforeAll, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const LEARNING_DREAMER_MD_PATH = join(import.meta.dir, "learning-dreamer.md");

let content: string;
// Collapse whitespace/newlines so substring assertions aren't broken by markdown
// line-wrapping — matches prose intent, not exact line breaks.
let normalized: string;

beforeAll(() => {
  content = readFileSync(LEARNING_DREAMER_MD_PATH, "utf-8");
  normalized = content.replace(/\s+/g, " ");
});

describe("learning-dreamer.md — Harness TODO flush, step 5 hitl-seeding fallback", () => {
  it("no longer tells the agent to leave the entry in the queue", () => {
    expect(content).not.toContain("Leave the entry in the queue");
  });

  it("describes seeding a hitl:true task in the task store", () => {
    const hasHitlSeed =
      content.includes('"hitl": true') && content.includes("task store");
    expect(hasHitlSeed).toBe(true);
  });

  it("documents the POST /tasks curl pattern", () => {
    const hasPostPattern =
      content.includes("POST") && content.includes('"$SHIPWRIGHT_TASK_STORE_URL/tasks"');
    expect(hasPostPattern).toBe(true);
  });

  it("explicitly says to omit branch and states the reason why", () => {
    const hasOmitBranch =
      content.includes("omit `branch`") || content.includes("Omit `branch`");
    const hasReason =
      content.includes("commands/dev-task.md") && content.includes("skips the task");
    expect(hasOmitBranch && hasReason).toBe(true);
  });

  it("states the broad trigger condition — not narrowly scoped to other plugins", () => {
    const hasBroadTrigger =
      content.includes("broad") && content.includes("other plugins");
    expect(hasBroadTrigger).toBe(true);
  });

  it("says to remove the entry from the Harness TODO queue once seeded", () => {
    const hasRemoval = normalized.includes("remove the entry from `# Harness TODO`");
    expect(hasRemoval).toBe(true);
  });
});

describe("learning-dreamer.md — Inputs section", () => {
  it("lists docs/*.md as a mining input within the ## Inputs section", () => {
    const inputsStart = content.indexOf("## Inputs");
    expect(inputsStart).toBeGreaterThan(-1);
    const nextHeadingIdx = content.indexOf("## ", inputsStart + "## Inputs".length);
    expect(nextHeadingIdx).toBeGreaterThan(inputsStart);
    const inputsSection = content.slice(inputsStart, nextHeadingIdx);
    expect(inputsSection).toContain("docs/*.md");
  });
});

describe("learning-dreamer.md — mining table", () => {
  it("has a mining table row for stale/overridden docs/*.md lines with a docs-refresher hand-off", () => {
    const tableStart = content.indexOf("## What to mine for");
    expect(tableStart).toBeGreaterThan(-1);
    const nextHeadingIdx = content.indexOf(
      "## ",
      tableStart + "## What to mine for".length,
    );
    expect(nextHeadingIdx).toBeGreaterThan(tableStart);
    const tableSection = content.slice(tableStart, nextHeadingIdx);

    expect(tableSection).toContain("docs/*.md");
    expect(tableSection).toContain("docs-refresher");

    const docsRowLine = tableSection
      .split("\n")
      .find((line) => line.includes("docs/*.md") && line.includes("|"));
    expect(docsRowLine).toBeDefined();
    expect(docsRowLine).toContain("docs-refresher");
  });
});
