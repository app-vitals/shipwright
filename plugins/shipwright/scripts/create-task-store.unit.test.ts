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
import { JiraTaskStore } from "./adapters/jira";
import { createTaskStore, loadConfig } from "./create-task-store";

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

describe("createTaskStore — jira factory branch", () => {
  // Save and restore JIRA env vars around each test
  const savedEmail = process.env.JIRA_EMAIL;
  const savedToken = process.env.JIRA_API_TOKEN;

  afterEach(() => {
    if (savedEmail !== undefined) {
      process.env.JIRA_EMAIL = savedEmail;
    } else {
      // biome-ignore lint/performance/noDelete: process.env deletion is intentional
      delete process.env.JIRA_EMAIL;
    }
    if (savedToken !== undefined) {
      process.env.JIRA_API_TOKEN = savedToken;
    } else {
      // biome-ignore lint/performance/noDelete: process.env deletion is intentional
      delete process.env.JIRA_API_TOKEN;
    }
  });

  // Test: valid config → returns JiraTaskStore instance
  test("returns JiraTaskStore when taskStore is 'jira' with valid config", () => {
    process.env.JIRA_EMAIL = "test@example.com";
    process.env.JIRA_API_TOKEN = "test-token";
    const store = createTaskStore({
      taskStore: "jira",
      jira: { baseUrl: "https://example.atlassian.net", projectKey: "SHIP" },
    });
    expect(store).toBeInstanceOf(JiraTaskStore);
  });

  // Test: missing config.jira → exits non-zero with a clear error
  test("exits non-zero with clear error when taskStore is 'jira' but jira config is missing", () => {
    // Run in a subprocess so process.exit(1) doesn't terminate the test runner.
    // Derive the factory module path by replacing the test file suffix.
    const testFilePath = new URL(import.meta.url).pathname;
    const factoryPath = testFilePath.replace(".unit.test.ts", ".ts");
    const proc = Bun.spawnSync(
      [
        "bun",
        "--eval",
        `import { createTaskStore } from ${JSON.stringify(factoryPath)}; createTaskStore({ taskStore: "jira" });`,
      ],
      { env: { ...process.env } },
    );
    expect(proc.exitCode).toBe(1);
    const stderr = proc.stderr.toString();
    expect(stderr).toContain("jira.baseUrl");
    expect(stderr).toContain("jira.projectKey");
  });
});
