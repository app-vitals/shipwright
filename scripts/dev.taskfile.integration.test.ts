/**
 * scripts/dev.taskfile.integration.test.ts
 * Asserts that Taskfile.yml has the required api, ui, and dev targets.
 *
 * Uses text-based parsing (key presence + content checks) since bun:yaml
 * is not available in bun test v1.3.14. This is sufficient for a structural
 * assertion on a simple YAML file with well-defined keys.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Resolve relative to the repo root (cwd when tests run)
const TASKFILE_PATH = resolve(process.cwd(), "Taskfile.yml");

function readTaskfile(): string {
  return readFileSync(TASKFILE_PATH, "utf8");
}

/**
 * Naive YAML task-block extractor — pulls out the block under `tasks:\n  <key>:`
 * Returns the indented block text for the given top-level task key.
 */
function getTaskBlock(content: string, taskKey: string): string | null {
  // Match `  <taskKey>:\n` at the 2-space indent level inside tasks:
  const re = new RegExp(`^  ${taskKey}:\\s*$`, "m");
  const match = re.exec(content);
  if (!match) return null;

  const start = match.index + match[0].length;
  // Collect lines until we hit another 2-space top-level key or EOF
  const rest = content.slice(start);
  const end = rest.search(/^ {2}\S/m);
  return end === -1 ? rest : rest.slice(0, end);
}

describe("Taskfile.yml — required run targets", () => {
  test("task api exists", () => {
    const content = readTaskfile();
    const block = getTaskBlock(content, "api");
    expect(block).not.toBeNull();
  });

  test("task api has a desc field", () => {
    const content = readTaskfile();
    const block = getTaskBlock(content, "api");
    expect(block).toMatch(/desc:/);
  });

  test("task api has a cmds field", () => {
    const content = readTaskfile();
    const block = getTaskBlock(content, "api");
    expect(block).toMatch(/cmds:/);
  });

  test("task ui exists", () => {
    const content = readTaskfile();
    const block = getTaskBlock(content, "ui");
    expect(block).not.toBeNull();
  });

  test("task ui has a desc field", () => {
    const content = readTaskfile();
    const block = getTaskBlock(content, "ui");
    expect(block).toMatch(/desc:/);
  });

  test("task ui has a cmds field", () => {
    const content = readTaskfile();
    const block = getTaskBlock(content, "ui");
    expect(block).toMatch(/cmds:/);
  });

  test("task dev exists", () => {
    const content = readTaskfile();
    const block = getTaskBlock(content, "dev");
    expect(block).not.toBeNull();
  });

  test("task dev has a desc field", () => {
    const content = readTaskfile();
    const block = getTaskBlock(content, "dev");
    expect(block).toMatch(/desc:/);
  });

  test("task dev has a cmds field", () => {
    const content = readTaskfile();
    const block = getTaskBlock(content, "dev");
    expect(block).toMatch(/cmds:/);
  });

  test("task api cmd references metrics server in offline mode", () => {
    const content = readTaskfile();
    const block = getTaskBlock(content, "api");
    expect(block).toMatch(/metrics\/src\/server\.ts/);
    expect(block).toMatch(/METRICS_OFFLINE/);
  });

  test("task ui cmd references metrics server in offline mode", () => {
    const content = readTaskfile();
    const block = getTaskBlock(content, "ui");
    expect(block).toMatch(/metrics\/src\/server\.ts/);
    expect(block).toMatch(/METRICS_OFFLINE/);
  });

  test("task dev cmd references scripts/dev.ts", () => {
    const content = readTaskfile();
    const block = getTaskBlock(content, "dev");
    expect(block).toMatch(/scripts\/dev\.ts/);
  });
});
