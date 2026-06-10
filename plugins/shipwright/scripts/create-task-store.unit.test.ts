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
  const origTaskStore = process.env.SHIPWRIGHT_TASK_STORE;
  const origGhOwner = process.env.SHIPWRIGHT_GITHUB_OWNER;
  const origGhRepo = process.env.SHIPWRIGHT_GITHUB_REPO;
  const origJiraUrl = process.env.JIRA_BASE_URL;
  const origJiraKey = process.env.JIRA_PROJECT_KEY;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "sw-test-"));
    // biome-ignore lint/performance/noDelete: process.env deletion is intentional — assignment stringifies to "undefined"
    delete process.env.SHIPWRIGHT_CONFIG;
    // biome-ignore lint/performance/noDelete: process.env deletion is intentional — assignment stringifies to "undefined"
    delete process.env.SHIPWRIGHT_TASK_STORE;
    // biome-ignore lint/performance/noDelete: process.env deletion is intentional — assignment stringifies to "undefined"
    delete process.env.SHIPWRIGHT_GITHUB_OWNER;
    // biome-ignore lint/performance/noDelete: process.env deletion is intentional — assignment stringifies to "undefined"
    delete process.env.SHIPWRIGHT_GITHUB_REPO;
    // biome-ignore lint/performance/noDelete: process.env deletion is intentional — assignment stringifies to "undefined"
    delete process.env.JIRA_BASE_URL;
    // biome-ignore lint/performance/noDelete: process.env deletion is intentional — assignment stringifies to "undefined"
    delete process.env.JIRA_PROJECT_KEY;
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    if (origEnv !== undefined) {
      process.env.SHIPWRIGHT_CONFIG = origEnv;
    } else {
      // biome-ignore lint/performance/noDelete: process.env deletion is intentional — assignment stringifies to "undefined"
      delete process.env.SHIPWRIGHT_CONFIG;
    }
    if (origTaskStore !== undefined) {
      process.env.SHIPWRIGHT_TASK_STORE = origTaskStore;
    } else {
      // biome-ignore lint/performance/noDelete: process.env deletion is intentional — assignment stringifies to "undefined"
      delete process.env.SHIPWRIGHT_TASK_STORE;
    }
    if (origGhOwner !== undefined) {
      process.env.SHIPWRIGHT_GITHUB_OWNER = origGhOwner;
    } else {
      // biome-ignore lint/performance/noDelete: process.env deletion is intentional — assignment stringifies to "undefined"
      delete process.env.SHIPWRIGHT_GITHUB_OWNER;
    }
    if (origGhRepo !== undefined) {
      process.env.SHIPWRIGHT_GITHUB_REPO = origGhRepo;
    } else {
      // biome-ignore lint/performance/noDelete: process.env deletion is intentional — assignment stringifies to "undefined"
      delete process.env.SHIPWRIGHT_GITHUB_REPO;
    }
    if (origJiraUrl !== undefined) {
      process.env.JIRA_BASE_URL = origJiraUrl;
    } else {
      // biome-ignore lint/performance/noDelete: process.env deletion is intentional — assignment stringifies to "undefined"
      delete process.env.JIRA_BASE_URL;
    }
    if (origJiraKey !== undefined) {
      process.env.JIRA_PROJECT_KEY = origJiraKey;
    } else {
      // biome-ignore lint/performance/noDelete: process.env deletion is intentional — assignment stringifies to "undefined"
      delete process.env.JIRA_PROJECT_KEY;
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

describe("loadConfig env var fallbacks", () => {
  let isolatedDir: string;
  const origTaskStore = process.env.SHIPWRIGHT_TASK_STORE;
  const origGhOwner = process.env.SHIPWRIGHT_GITHUB_OWNER;
  const origGhRepo = process.env.SHIPWRIGHT_GITHUB_REPO;
  const origJiraUrl = process.env.JIRA_BASE_URL;
  const origJiraKey = process.env.JIRA_PROJECT_KEY;
  const origConfig = process.env.SHIPWRIGHT_CONFIG;

  beforeEach(() => {
    // Use a fresh isolated dir with no .shipwright.json ancestors
    isolatedDir = mkdtempSync(join(tmpdir(), "sw-env-test-"));
    // biome-ignore lint/performance/noDelete: process.env deletion is intentional — assignment stringifies to "undefined"
    delete process.env.SHIPWRIGHT_TASK_STORE;
    // biome-ignore lint/performance/noDelete: process.env deletion is intentional — assignment stringifies to "undefined"
    delete process.env.SHIPWRIGHT_GITHUB_OWNER;
    // biome-ignore lint/performance/noDelete: process.env deletion is intentional — assignment stringifies to "undefined"
    delete process.env.SHIPWRIGHT_GITHUB_REPO;
    // biome-ignore lint/performance/noDelete: process.env deletion is intentional — assignment stringifies to "undefined"
    delete process.env.JIRA_BASE_URL;
    // biome-ignore lint/performance/noDelete: process.env deletion is intentional — assignment stringifies to "undefined"
    delete process.env.JIRA_PROJECT_KEY;
    // biome-ignore lint/performance/noDelete: process.env deletion is intentional — assignment stringifies to "undefined"
    delete process.env.SHIPWRIGHT_CONFIG;
  });

  afterEach(() => {
    rmSync(isolatedDir, { recursive: true, force: true });
    if (origTaskStore !== undefined) {
      process.env.SHIPWRIGHT_TASK_STORE = origTaskStore;
    } else {
      // biome-ignore lint/performance/noDelete: process.env deletion is intentional — assignment stringifies to "undefined"
      delete process.env.SHIPWRIGHT_TASK_STORE;
    }
    if (origGhOwner !== undefined) {
      process.env.SHIPWRIGHT_GITHUB_OWNER = origGhOwner;
    } else {
      // biome-ignore lint/performance/noDelete: process.env deletion is intentional — assignment stringifies to "undefined"
      delete process.env.SHIPWRIGHT_GITHUB_OWNER;
    }
    if (origGhRepo !== undefined) {
      process.env.SHIPWRIGHT_GITHUB_REPO = origGhRepo;
    } else {
      // biome-ignore lint/performance/noDelete: process.env deletion is intentional — assignment stringifies to "undefined"
      delete process.env.SHIPWRIGHT_GITHUB_REPO;
    }
    if (origJiraUrl !== undefined) {
      process.env.JIRA_BASE_URL = origJiraUrl;
    } else {
      // biome-ignore lint/performance/noDelete: process.env deletion is intentional — assignment stringifies to "undefined"
      delete process.env.JIRA_BASE_URL;
    }
    if (origJiraKey !== undefined) {
      process.env.JIRA_PROJECT_KEY = origJiraKey;
    } else {
      // biome-ignore lint/performance/noDelete: process.env deletion is intentional — assignment stringifies to "undefined"
      delete process.env.JIRA_PROJECT_KEY;
    }
    if (origConfig !== undefined) {
      process.env.SHIPWRIGHT_CONFIG = origConfig;
    } else {
      // biome-ignore lint/performance/noDelete: process.env deletion is intentional — assignment stringifies to "undefined"
      delete process.env.SHIPWRIGHT_CONFIG;
    }
  });

  // Test 6: GitHub env vars → github config, configSource="env"
  test("SHIPWRIGHT_TASK_STORE=github + owner + repo → github config with configSource=env", () => {
    process.env.SHIPWRIGHT_TASK_STORE = "github";
    process.env.SHIPWRIGHT_GITHUB_OWNER = "my-org";
    process.env.SHIPWRIGHT_GITHUB_REPO = "my-repo";
    const result = loadConfig(isolatedDir);
    expect(result.config.taskStore).toBe("github");
    expect(result.config.github?.owner).toBe("my-org");
    expect(result.config.github?.repo).toBe("my-repo");
    expect(result.configSource).toBe("env");
  });

  // Test 7: Jira env vars → jira config, configSource="env"
  test("SHIPWRIGHT_TASK_STORE=jira + JIRA_BASE_URL + JIRA_PROJECT_KEY → jira config with configSource=env", () => {
    process.env.SHIPWRIGHT_TASK_STORE = "jira";
    process.env.JIRA_BASE_URL = "https://example.atlassian.net";
    process.env.JIRA_PROJECT_KEY = "SHIP";
    const result = loadConfig(isolatedDir);
    expect(result.config.taskStore).toBe("jira");
    expect(result.config.jira?.baseUrl).toBe("https://example.atlassian.net");
    expect(result.config.jira?.projectKey).toBe("SHIP");
    expect(result.configSource).toBe("env");
  });

  // Test 8: env vars take precedence over .shipwright.json
  test("env vars take precedence over .shipwright.json", () => {
    writeFileSync(
      join(isolatedDir, ".shipwright.json"),
      JSON.stringify({ taskStore: "json" }),
    );
    process.env.SHIPWRIGHT_TASK_STORE = "github";
    process.env.SHIPWRIGHT_GITHUB_OWNER = "env-org";
    process.env.SHIPWRIGHT_GITHUB_REPO = "env-repo";
    const result = loadConfig(isolatedDir);
    expect(result.config.taskStore).toBe("github");
    expect(result.config.github?.owner).toBe("env-org");
    expect(result.configSource).toBe("env");
  });

  // Test 9: env vars take precedence over SHIPWRIGHT_CONFIG file
  test("env vars take precedence over SHIPWRIGHT_CONFIG", () => {
    const cfgFile = join(isolatedDir, "other-config.json");
    writeFileSync(cfgFile, JSON.stringify({ taskStore: "json" }));
    process.env.SHIPWRIGHT_CONFIG = cfgFile;
    process.env.SHIPWRIGHT_TASK_STORE = "github";
    process.env.SHIPWRIGHT_GITHUB_OWNER = "env-org";
    process.env.SHIPWRIGHT_GITHUB_REPO = "env-repo";
    const result = loadConfig(isolatedDir);
    expect(result.config.taskStore).toBe("github");
    expect(result.config.github?.owner).toBe("env-org");
    expect(result.configSource).toBe("env");
  });

  // Test 10: SHIPWRIGHT_TASK_STORE=github with no owner/repo → github config with undefined owner/repo
  test("SHIPWRIGHT_TASK_STORE=github with no owner/repo → github config, owner and repo are undefined", () => {
    process.env.SHIPWRIGHT_TASK_STORE = "github";
    const result = loadConfig(isolatedDir);
    expect(result.config.taskStore).toBe("github");
    expect(result.config.github?.owner).toBeUndefined();
    expect(result.config.github?.repo).toBeUndefined();
    expect(result.configSource).toBe("env");
  });

  // Test 11: SHIPWRIGHT_TASK_STORE=json → json config with configSource="env", skips file walk-up
  test("SHIPWRIGHT_TASK_STORE=json → json config with configSource=env, skips .shipwright.json walk-up", () => {
    // Place a .shipwright.json that would otherwise be picked up by the walk-up
    writeFileSync(
      join(isolatedDir, ".shipwright.json"),
      JSON.stringify({
        taskStore: "github",
        github: { owner: "example-org", repo: "example-repo" },
      }),
    );
    process.env.SHIPWRIGHT_TASK_STORE = "json";
    const result = loadConfig(isolatedDir);
    expect(result.config.taskStore).toBe("json");
    expect(result.configSource).toBe("env");
  });
});
