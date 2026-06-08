/**
 * scripts/quickstart.smoke.test.ts
 * Smoke tests for scripts/quickstart.sh — validates script structure without
 * running live processes.
 *
 * Checks: file existence, executability, syntax validity, shebang, and
 * references to key tools and commands.
 */

import { describe, expect, test } from "bun:test";
import { accessSync, constants, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const SCRIPT_PATH = resolve(process.cwd(), "scripts/quickstart.sh");

describe("scripts/quickstart.sh — structure", () => {
  test("script file exists at scripts/quickstart.sh", () => {
    let exists = true;
    try {
      statSync(SCRIPT_PATH);
    } catch {
      exists = false;
    }
    expect(exists).toBe(true);
  });

  test("script is executable", () => {
    let executable = true;
    try {
      accessSync(SCRIPT_PATH, constants.X_OK);
    } catch {
      executable = false;
    }
    expect(executable).toBe(true);
  });

  test("bash -n syntax check passes", () => {
    const result = spawnSync("bash", ["-n", SCRIPT_PATH], {
      encoding: "utf8",
    });
    expect(result.status).toBe(0);
  });

  test("script contains a shebang (#!/)", () => {
    const content = readFileSync(SCRIPT_PATH, "utf8");
    expect(content).toMatch(/^#!\//);
  });

  test("script references bun install", () => {
    const content = readFileSync(SCRIPT_PATH, "utf8");
    expect(content).toMatch(/bun install/);
  });

  test("script references task (go-task check)", () => {
    const content = readFileSync(SCRIPT_PATH, "utf8");
    expect(content).toMatch(/\btask\b/);
  });
});
