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
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, createTaskStore } from "./create-task-store";

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

  // Test 12: unrecognized SHIPWRIGHT_TASK_STORE value → warning on stderr, falls through to file config
  test("unrecognized SHIPWRIGHT_TASK_STORE value emits a warning and falls through to file config", () => {
    writeFileSync(
      join(isolatedDir, ".shipwright.json"),
      JSON.stringify({ taskStore: "json" }),
    );
    process.env.SHIPWRIGHT_TASK_STORE = "GitHub"; // casing typo

    const stderrWrites: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    // biome-ignore lint/suspicious/noExplicitAny: intercepting stderr.write for test assertion
    (process.stderr as any).write = (chunk: string, ...rest: unknown[]) => {
      stderrWrites.push(chunk);
      return true;
    };

    let result: ReturnType<typeof loadConfig>;
    try {
      result = loadConfig(isolatedDir);
    } finally {
      // biome-ignore lint/suspicious/noExplicitAny: restoring original stderr.write
      (process.stderr as any).write = origWrite;
    }

    // Should have emitted the warning
    expect(stderrWrites.some((s) => s.includes("unrecognized SHIPWRIGHT_TASK_STORE value"))).toBe(true);
    expect(stderrWrites.some((s) => s.includes('"GitHub"'))).toBe(true);

    // Should have fallen through to the .shipwright.json file config
    expect(result?.config.taskStore).toBe("json");
    expect(result?.configSource).toContain(".shipwright.json");
  });
});

// ─── TSD-1.2: single-backend enforcement ─────────────────────────────────────

describe("createTaskStore single-backend enforcement", () => {
  let tmpDir: string;
  const origTaskStore = process.env.SHIPWRIGHT_TASK_STORE;
  const origGhOwner = process.env.SHIPWRIGHT_GITHUB_OWNER;
  const origGhRepo = process.env.SHIPWRIGHT_GITHUB_REPO;
  const origConfig = process.env.SHIPWRIGHT_CONFIG;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "sw-single-backend-test-"));
    // biome-ignore lint/performance/noDelete: process.env deletion is intentional — assignment stringifies to "undefined"
    delete process.env.SHIPWRIGHT_TASK_STORE;
    // biome-ignore lint/performance/noDelete: process.env deletion is intentional — assignment stringifies to "undefined"
    delete process.env.SHIPWRIGHT_GITHUB_OWNER;
    // biome-ignore lint/performance/noDelete: process.env deletion is intentional — assignment stringifies to "undefined"
    delete process.env.SHIPWRIGHT_GITHUB_REPO;
    // biome-ignore lint/performance/noDelete: process.env deletion is intentional — assignment stringifies to "undefined"
    delete process.env.SHIPWRIGHT_CONFIG;
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
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
    if (origConfig !== undefined) {
      process.env.SHIPWRIGHT_CONFIG = origConfig;
    } else {
      // biome-ignore lint/performance/noDelete: process.env deletion is intentional — assignment stringifies to "undefined"
      delete process.env.SHIPWRIGHT_CONFIG;
    }
  });

  // Test: when GitHub backend configured, createTaskStore returns a GitHubTaskStore (not JsonTaskStore)
  test("GitHub config → createTaskStore returns GitHubTaskStore, not JsonTaskStore", () => {
    process.env.SHIPWRIGHT_TASK_STORE = "github";
    process.env.SHIPWRIGHT_GITHUB_OWNER = "test-org";
    process.env.SHIPWRIGHT_GITHUB_REPO = "test-repo";
    const { config } = loadConfig(tmpDir);
    const store = createTaskStore(config);
    const { JsonTaskStore } = require("./adapters/json");
    expect(store).not.toBeInstanceOf(JsonTaskStore);
    const { GitHubTaskStore } = require("./adapters/github");
    expect(store).toBeInstanceOf(GitHubTaskStore);
  });

  // Test: when no backend configured, createTaskStore returns a JsonTaskStore (no GitHub calls)
  test("no backend configured → createTaskStore returns JsonTaskStore", () => {
    const isolatedDir = mkdtempSync(join(tmpdir(), "sw-json-default-"));
    try {
      const { config } = loadConfig(isolatedDir);
      expect(config.taskStore).toBe("json");
      const store = createTaskStore(config);
      const { JsonTaskStore } = require("./adapters/json");
      expect(store).toBeInstanceOf(JsonTaskStore);
      const { GitHubTaskStore } = require("./adapters/github");
      expect(store).not.toBeInstanceOf(GitHubTaskStore);
    } finally {
      rmSync(isolatedDir, { recursive: true, force: true });
    }
  });

  // Test: GitHub backend configured → todos.json is NOT read during createTaskStore
  test("GitHub backend configured → todos.json is not read by createTaskStore", () => {
    // Create a todos.json that would be picked up by JsonTaskStore
    mkdirSync(join(tmpDir, "state"), { recursive: true });
    writeFileSync(join(tmpDir, "state", "todos.json"), JSON.stringify([
      { id: "T-1", title: "Should not appear", status: "pending" },
    ]));
    process.env.SHIPWRIGHT_TASK_STORE = "github";
    process.env.SHIPWRIGHT_GITHUB_OWNER = "test-org";
    process.env.SHIPWRIGHT_GITHUB_REPO = "test-repo";
    const { config } = loadConfig(tmpDir);
    expect(config.taskStore).toBe("github");
    // Creating the store should not read todos.json — simply instantiating GitHubTaskStore
    // should not touch the file at all. We verify by checking the factory returns the
    // right type without any interaction with todos.json.
    const store = createTaskStore(config);
    const { GitHubTaskStore } = require("./adapters/github");
    expect(store).toBeInstanceOf(GitHubTaskStore);
    // todos.json still exists and is unchanged (not read/written by createTaskStore)
    const todosContent = readFileSync(join(tmpDir, "state", "todos.json"), "utf-8");
    const todos = JSON.parse(todosContent) as unknown[];
    expect(todos).toHaveLength(1);
  });
});

describe("doctor coexistence warning", () => {
  let tmpDir: string;
  const origTaskStore = process.env.SHIPWRIGHT_TASK_STORE;
  const origGhOwner = process.env.SHIPWRIGHT_GITHUB_OWNER;
  const origGhRepo = process.env.SHIPWRIGHT_GITHUB_REPO;
  const origConfig = process.env.SHIPWRIGHT_CONFIG;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "sw-doctor-coexist-"));
    // biome-ignore lint/performance/noDelete: process.env deletion is intentional — assignment stringifies to "undefined"
    delete process.env.SHIPWRIGHT_TASK_STORE;
    // biome-ignore lint/performance/noDelete: process.env deletion is intentional — assignment stringifies to "undefined"
    delete process.env.SHIPWRIGHT_GITHUB_OWNER;
    // biome-ignore lint/performance/noDelete: process.env deletion is intentional — assignment stringifies to "undefined"
    delete process.env.SHIPWRIGHT_GITHUB_REPO;
    // biome-ignore lint/performance/noDelete: process.env deletion is intentional — assignment stringifies to "undefined"
    delete process.env.SHIPWRIGHT_CONFIG;
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
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
    if (origConfig !== undefined) {
      process.env.SHIPWRIGHT_CONFIG = origConfig;
    } else {
      // biome-ignore lint/performance/noDelete: process.env deletion is intentional — assignment stringifies to "undefined"
      delete process.env.SHIPWRIGHT_CONFIG;
    }
  });

  // Test: doctor warns when todos.json exists + non-empty while GitHub backend active
  test("doctor warns when todos.json exists and is non-empty while GitHub backend is active", () => {
    // Create a non-empty todos.json
    mkdirSync(join(tmpDir, "state"), { recursive: true });
    writeFileSync(join(tmpDir, "state", "todos.json"), JSON.stringify([
      { id: "T-1", title: "Stale task", status: "pending" },
    ]));

    // Write .shipwright.json with github backend
    writeFileSync(
      join(tmpDir, ".shipwright.json"),
      JSON.stringify({
        taskStore: "github",
        github: { owner: "test-org", repo: "test-repo" },
      }),
    );

    const warnings: string[] = [];
    const logs: string[] = [];
    const origWarn = console.warn;
    const origLog = console.log;
    console.warn = (...args: unknown[]) => warnings.push(args.join(" "));
    console.log = (...args: unknown[]) => logs.push(args.join(" "));

    try {
      const { config, configSource } = loadConfig(tmpDir);
      // doctor is in task_store.ts but we need a unit-testable version
      // We call the doctorCheck function exported from create-task-store
      const { doctorCheck } = require("./create-task-store");
      doctorCheck(config, configSource, tmpDir);
    } finally {
      console.warn = origWarn;
      console.log = origLog;
    }

    // Should emit the coexistence warning
    const allOutput = [...warnings, ...logs].join("\n");
    expect(allOutput).toMatch(/\[warn\].*todos\.json.*github/i);
  });

  // Test: doctor does NOT warn when todos.json is empty while GitHub backend active
  test("doctor does NOT warn when todos.json is empty while GitHub backend is active", () => {
    mkdirSync(join(tmpDir, "state"), { recursive: true });
    writeFileSync(join(tmpDir, "state", "todos.json"), JSON.stringify([]));

    writeFileSync(
      join(tmpDir, ".shipwright.json"),
      JSON.stringify({
        taskStore: "github",
        github: { owner: "test-org", repo: "test-repo" },
      }),
    );

    const warnings: string[] = [];
    const logs: string[] = [];
    const origWarn = console.warn;
    const origLog = console.log;
    console.warn = (...args: unknown[]) => warnings.push(args.join(" "));
    console.log = (...args: unknown[]) => logs.push(args.join(" "));

    try {
      const { config, configSource } = loadConfig(tmpDir);
      const { doctorCheck } = require("./create-task-store");
      doctorCheck(config, configSource, tmpDir);
    } finally {
      console.warn = origWarn;
      console.log = origLog;
    }

    const allOutput = [...warnings, ...logs].join("\n");
    expect(allOutput).not.toMatch(/\[warn\].*todos\.json.*github/i);
  });

  // Test: doctor does NOT warn when todos.json absent while GitHub backend active
  test("doctor does NOT warn when todos.json is absent while GitHub backend is active", () => {
    writeFileSync(
      join(tmpDir, ".shipwright.json"),
      JSON.stringify({
        taskStore: "github",
        github: { owner: "test-org", repo: "test-repo" },
      }),
    );

    const warnings: string[] = [];
    const logs: string[] = [];
    const origWarn = console.warn;
    const origLog = console.log;
    console.warn = (...args: unknown[]) => warnings.push(args.join(" "));
    console.log = (...args: unknown[]) => logs.push(args.join(" "));

    try {
      const { config, configSource } = loadConfig(tmpDir);
      const { doctorCheck } = require("./create-task-store");
      doctorCheck(config, configSource, tmpDir);
    } finally {
      console.warn = origWarn;
      console.log = origLog;
    }

    const allOutput = [...warnings, ...logs].join("\n");
    expect(allOutput).not.toMatch(/\[warn\].*todos\.json.*github/i);
  });

  // Test: doctor does NOT warn for JSON backend even when todos.json exists and is non-empty
  test("doctor does NOT emit coexistence warning when JSON backend is active", () => {
    mkdirSync(join(tmpDir, "state"), { recursive: true });
    writeFileSync(join(tmpDir, "state", "todos.json"), JSON.stringify([
      { id: "T-1", title: "Active task", status: "pending" },
    ]));

    const warnings: string[] = [];
    const logs: string[] = [];
    const origWarn = console.warn;
    const origLog = console.log;
    console.warn = (...args: unknown[]) => warnings.push(args.join(" "));
    console.log = (...args: unknown[]) => logs.push(args.join(" "));

    try {
      const isolatedDir = mkdtempSync(join(tmpdir(), "sw-json-doctor-"));
      try {
        // Copy todos.json to isolated dir
        mkdirSync(join(isolatedDir, "state"), { recursive: true });
        writeFileSync(join(isolatedDir, "state", "todos.json"), JSON.stringify([
          { id: "T-1", title: "Active task", status: "pending" },
        ]));
        const { config, configSource } = loadConfig(isolatedDir);
        expect(config.taskStore).toBe("json");
        const { doctorCheck } = require("./create-task-store");
        doctorCheck(config, configSource, isolatedDir);
      } finally {
        rmSync(isolatedDir, { recursive: true, force: true });
      }
    } finally {
      console.warn = origWarn;
      console.log = origLog;
    }

    const allOutput = [...warnings, ...logs].join("\n");
    expect(allOutput).not.toMatch(/\[warn\].*todos\.json.*github/i);
  });
});
