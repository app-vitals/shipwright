import { beforeAll, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const LEARNING_DREAMER_MD_PATH = join(import.meta.dir, "learning-dreamer.md");

let content: string;

beforeAll(() => {
  content = readFileSync(LEARNING_DREAMER_MD_PATH, "utf-8");
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
