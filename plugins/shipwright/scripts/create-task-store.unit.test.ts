/**
 * plugins/shipwright/scripts/create-task-store.unit.test.ts
 *
 * Unit tests for loadConfig() discovery precedence chain in create-task-store.ts.
 *
 * Tests use real temp directories — no mocks.
 *
 * Precedence:
 *   1. .shipwright.json found by walking up from cwd
 *   2. SHIPWRIGHT_CONFIG env var
 *   3. Default JSON config
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./create-task-store";

describe("loadConfig discovery", () => {
  let tmpDir: string;
  const origEnv = process.env.SHIPWRIGHT_CONFIG;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "sw-test-"));
    // biome-ignore lint/performance/noDelete: process.env deletion is intentional — assignment stringifies to "undefined"
    delete process.env.SHIPWRIGHT_CONFIG;
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    if (origEnv !== undefined) {
      process.env.SHIPWRIGHT_CONFIG = origEnv;
    } else {
      // biome-ignore lint/performance/noDelete: process.env deletion is intentional — assignment stringifies to "undefined"
      delete process.env.SHIPWRIGHT_CONFIG;
    }
  });

  // Test 1: .shipwright.json in cwd → used
  test("finds .shipwright.json in cwd", () => {
    writeFileSync(
      join(tmpDir, ".shipwright.json"),
      JSON.stringify({
        taskStore: "github",
        github: { owner: "example-org", repo: "example-repo" },
      }),
    );
    const result = loadConfig(tmpDir);
    expect(result.config.taskStore).toBe("github");
    expect(result.configSource).toBe(join(tmpDir, ".shipwright.json"));
  });

  // Test 2: .shipwright.json in parent dir → found by walk-up
  test("walks up directories to find .shipwright.json", () => {
    writeFileSync(
      join(tmpDir, ".shipwright.json"),
      JSON.stringify({
        taskStore: "github",
        github: { owner: "example-org", repo: "example-repo" },
      }),
    );
    const subDir = join(tmpDir, "nested", "subdir");
    mkdirSync(subDir, { recursive: true });
    const result = loadConfig(subDir);
    expect(result.config.taskStore).toBe("github");
    expect(result.configSource).toBe(join(tmpDir, ".shipwright.json"));
  });

  // Test 3: SHIPWRIGHT_CONFIG env, no .shipwright.json → env used
  test("falls back to SHIPWRIGHT_CONFIG when no .shipwright.json found", () => {
    const cfgFile = join(tmpDir, "my-config.json");
    writeFileSync(
      cfgFile,
      JSON.stringify({
        taskStore: "github",
        github: { owner: "example-org", repo: "example-repo" },
      }),
    );
    process.env.SHIPWRIGHT_CONFIG = cfgFile;
    // Use a subdir that does NOT have .shipwright.json and is not under tmpDir's .shipwright.json
    const isolatedDir = mkdtempSync(join(tmpdir(), "sw-isolated-"));
    try {
      const result = loadConfig(isolatedDir);
      expect(result.config.taskStore).toBe("github");
      expect(result.configSource).toBe(cfgFile);
    } finally {
      rmSync(isolatedDir, { recursive: true, force: true });
    }
  });

  // Test 4: .shipwright.json wins over SHIPWRIGHT_CONFIG
  test(".shipwright.json takes precedence over SHIPWRIGHT_CONFIG", () => {
    writeFileSync(
      join(tmpDir, ".shipwright.json"),
      JSON.stringify({
        taskStore: "github",
        github: { owner: "example-org", repo: "example-repo" },
      }),
    );
    const cfgFile = join(tmpDir, "other-config.json");
    writeFileSync(cfgFile, JSON.stringify({ taskStore: "json" }));
    process.env.SHIPWRIGHT_CONFIG = cfgFile;
    const result = loadConfig(tmpDir);
    expect(result.config.taskStore).toBe("github");
    expect(result.configSource).toContain(".shipwright.json");
  });

  // Test 5: neither → JSON default
  test("defaults to json when neither .shipwright.json nor SHIPWRIGHT_CONFIG is set", () => {
    // Use an isolated dir that has no .shipwright.json parents
    const isolatedDir = mkdtempSync(join(tmpdir(), "sw-default-"));
    try {
      const result = loadConfig(isolatedDir);
      expect(result.config.taskStore).toBe("json");
      expect(result.configSource).toBe("default");
    } finally {
      rmSync(isolatedDir, { recursive: true, force: true });
    }
  });
});
