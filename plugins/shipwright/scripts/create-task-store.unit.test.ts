/**
 * plugins/shipwright/scripts/create-task-store.unit.test.ts
 *
 * Unit tests for loadConfig() discovery precedence chain in create-task-store.ts.
 *
 * Tests use real temp directories — no mocks.
 *
 * Precedence:
 *   1. SHIPWRIGHT_TASK_STORE env var → highest precedence
 *   2. .shipwright.json found by walking up from cwd
 *   3. SHIPWRIGHT_CONFIG env var
 *   4. Error — no config found
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
import { TaskStoreHttpAdapter } from "./adapters/task-store";
import { createTaskStore, loadConfig } from "./create-task-store";

describe("loadConfig discovery", () => {
  let tmpDir: string;
  const origEnv = process.env.SHIPWRIGHT_CONFIG;
  const origTaskStore = process.env.SHIPWRIGHT_TASK_STORE;
  const origTaskStoreUrl = process.env.SHIPWRIGHT_TASK_STORE_URL;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "sw-test-"));
    // biome-ignore lint/performance/noDelete: process.env deletion is intentional — assignment stringifies to "undefined"
    delete process.env.SHIPWRIGHT_CONFIG;
    // biome-ignore lint/performance/noDelete: process.env deletion is intentional — assignment stringifies to "undefined"
    delete process.env.SHIPWRIGHT_TASK_STORE;
    // biome-ignore lint/performance/noDelete: process.env deletion is intentional — assignment stringifies to "undefined"
    delete process.env.SHIPWRIGHT_TASK_STORE_URL;
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
    if (origTaskStoreUrl !== undefined) {
      process.env.SHIPWRIGHT_TASK_STORE_URL = origTaskStoreUrl;
    } else {
      // biome-ignore lint/performance/noDelete: process.env deletion is intentional — assignment stringifies to "undefined"
      delete process.env.SHIPWRIGHT_TASK_STORE_URL;
    }
  });

  // Test 1: .shipwright.json in cwd → used
  test("finds .shipwright.json in cwd", () => {
    writeFileSync(
      join(tmpDir, ".shipwright.json"),
      JSON.stringify({
        taskStore: "task-store",
        taskStoreUrl: "https://example.com",
      }),
    );
    const result = loadConfig(tmpDir);
    expect(result.config.taskStore).toBe("task-store");
    expect(result.configSource).toBe(join(tmpDir, ".shipwright.json"));
  });

  // Test 2: .shipwright.json in parent dir → found by walk-up
  test("walks up directories to find .shipwright.json", () => {
    writeFileSync(
      join(tmpDir, ".shipwright.json"),
      JSON.stringify({
        taskStore: "task-store",
        taskStoreUrl: "https://example.com",
      }),
    );
    const subDir = join(tmpDir, "nested", "subdir");
    mkdirSync(subDir, { recursive: true });
    const result = loadConfig(subDir);
    expect(result.config.taskStore).toBe("task-store");
    expect(result.configSource).toBe(join(tmpDir, ".shipwright.json"));
  });

  // Test 3: SHIPWRIGHT_CONFIG env, no .shipwright.json → env used
  test("falls back to SHIPWRIGHT_CONFIG when no .shipwright.json found", () => {
    const cfgFile = join(tmpDir, "my-config.json");
    writeFileSync(
      cfgFile,
      JSON.stringify({
        taskStore: "task-store",
        taskStoreUrl: "https://example.com",
      }),
    );
    process.env.SHIPWRIGHT_CONFIG = cfgFile;
    // Use a subdir that does NOT have .shipwright.json and is not under tmpDir's .shipwright.json
    const isolatedDir = mkdtempSync(join(tmpdir(), "sw-isolated-"));
    try {
      const result = loadConfig(isolatedDir);
      expect(result.config.taskStore).toBe("task-store");
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
        taskStore: "task-store",
        taskStoreUrl: "https://example.com",
      }),
    );
    const cfgFile = join(tmpDir, "other-config.json");
    writeFileSync(
      cfgFile,
      JSON.stringify({ taskStore: "task-store", taskStoreUrl: "https://other.com" }),
    );
    process.env.SHIPWRIGHT_CONFIG = cfgFile;
    const result = loadConfig(tmpDir);
    expect(result.config.taskStore).toBe("task-store");
    expect(result.configSource).toContain(".shipwright.json");
  });
});

describe("loadConfig env var fallbacks", () => {
  let isolatedDir: string;
  const origTaskStore = process.env.SHIPWRIGHT_TASK_STORE;
  const origTaskStoreUrl = process.env.SHIPWRIGHT_TASK_STORE_URL;
  const origConfig = process.env.SHIPWRIGHT_CONFIG;

  beforeEach(() => {
    // Use a fresh isolated dir with no .shipwright.json ancestors
    isolatedDir = mkdtempSync(join(tmpdir(), "sw-env-test-"));
    // biome-ignore lint/performance/noDelete: process.env deletion is intentional — assignment stringifies to "undefined"
    delete process.env.SHIPWRIGHT_TASK_STORE;
    // biome-ignore lint/performance/noDelete: process.env deletion is intentional — assignment stringifies to "undefined"
    delete process.env.SHIPWRIGHT_TASK_STORE_URL;
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
    if (origTaskStoreUrl !== undefined) {
      process.env.SHIPWRIGHT_TASK_STORE_URL = origTaskStoreUrl;
    } else {
      // biome-ignore lint/performance/noDelete: process.env deletion is intentional — assignment stringifies to "undefined"
      delete process.env.SHIPWRIGHT_TASK_STORE_URL;
    }
    if (origConfig !== undefined) {
      process.env.SHIPWRIGHT_CONFIG = origConfig;
    } else {
      // biome-ignore lint/performance/noDelete: process.env deletion is intentional — assignment stringifies to "undefined"
      delete process.env.SHIPWRIGHT_CONFIG;
    }
  });

  // Test 6: task-store env vars → task-store config, configSource="env"
  test("SHIPWRIGHT_TASK_STORE=task-store + URL → task-store config with configSource=env", () => {
    process.env.SHIPWRIGHT_TASK_STORE = "task-store";
    process.env.SHIPWRIGHT_TASK_STORE_URL = "https://ts.example.com";
    const result = loadConfig(isolatedDir);
    expect(result.config.taskStore).toBe("task-store");
    expect((result.config as { taskStoreUrl?: string }).taskStoreUrl).toBe(
      "https://ts.example.com",
    );
    expect(result.configSource).toBe("env");
  });

  // Test 7: env vars take precedence over .shipwright.json
  test("env vars take precedence over .shipwright.json", () => {
    writeFileSync(
      join(isolatedDir, ".shipwright.json"),
      JSON.stringify({ taskStore: "task-store", taskStoreUrl: "https://file.example.com" }),
    );
    process.env.SHIPWRIGHT_TASK_STORE = "task-store";
    process.env.SHIPWRIGHT_TASK_STORE_URL = "https://ts.example.com";
    const result = loadConfig(isolatedDir);
    expect(result.config.taskStore).toBe("task-store");
    expect(result.configSource).toBe("env");
  });

  // Test 8: env vars take precedence over SHIPWRIGHT_CONFIG file
  test("env vars take precedence over SHIPWRIGHT_CONFIG", () => {
    const cfgFile = join(isolatedDir, "other-config.json");
    writeFileSync(
      cfgFile,
      JSON.stringify({ taskStore: "task-store", taskStoreUrl: "https://file.example.com" }),
    );
    process.env.SHIPWRIGHT_CONFIG = cfgFile;
    process.env.SHIPWRIGHT_TASK_STORE = "task-store";
    process.env.SHIPWRIGHT_TASK_STORE_URL = "https://ts.example.com";
    const result = loadConfig(isolatedDir);
    expect(result.config.taskStore).toBe("task-store");
    expect(result.configSource).toBe("env");
  });

  // Test 9: SHIPWRIGHT_TASK_STORE=task-store with no URL → task-store config with empty URL
  test("SHIPWRIGHT_TASK_STORE=task-store with no URL → task-store config, taskStoreUrl is empty", () => {
    process.env.SHIPWRIGHT_TASK_STORE = "task-store";
    const result = loadConfig(isolatedDir);
    expect(result.config.taskStore).toBe("task-store");
    expect((result.config as { taskStoreUrl?: string }).taskStoreUrl).toBe("");
    expect(result.configSource).toBe("env");
  });

  // Test: unrecognized SHIPWRIGHT_TASK_STORE value → warning on stderr, falls through to file config
  test("unrecognized SHIPWRIGHT_TASK_STORE value emits a warning and falls through to file config", () => {
    writeFileSync(
      join(isolatedDir, ".shipwright.json"),
      JSON.stringify({ taskStore: "task-store", taskStoreUrl: "https://example.com" }),
    );
    process.env.SHIPWRIGHT_TASK_STORE = "GitHub"; // casing typo

    const stderrWrites: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    (process.stderr as unknown as { write: (chunk: string) => boolean }).write =
      (chunk: string) => {
        stderrWrites.push(chunk);
        return true;
      };

    let result: ReturnType<typeof loadConfig>;
    try {
      result = loadConfig(isolatedDir);
    } finally {
      process.stderr.write = origWrite;
    }

    // Should have emitted the warning
    expect(
      stderrWrites.some((s) =>
        s.includes("unrecognized SHIPWRIGHT_TASK_STORE value"),
      ),
    ).toBe(true);
    expect(stderrWrites.some((s) => s.includes('"GitHub"'))).toBe(true);

    // Should have fallen through to the .shipwright.json file config
    expect(result?.config.taskStore).toBe("task-store");
    expect(result?.configSource).toContain(".shipwright.json");
  });
});

// ─── TSD-1.2: single-backend enforcement ─────────────────────────────────────

describe("createTaskStore single-backend enforcement", () => {
  let tmpDir: string;
  const origTaskStore = process.env.SHIPWRIGHT_TASK_STORE;
  const origTaskStoreUrl = process.env.SHIPWRIGHT_TASK_STORE_URL;
  const origConfig = process.env.SHIPWRIGHT_CONFIG;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "sw-single-backend-test-"));
    // biome-ignore lint/performance/noDelete: process.env deletion is intentional — assignment stringifies to "undefined"
    delete process.env.SHIPWRIGHT_TASK_STORE;
    // biome-ignore lint/performance/noDelete: process.env deletion is intentional — assignment stringifies to "undefined"
    delete process.env.SHIPWRIGHT_TASK_STORE_URL;
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
    if (origTaskStoreUrl !== undefined) {
      process.env.SHIPWRIGHT_TASK_STORE_URL = origTaskStoreUrl;
    } else {
      // biome-ignore lint/performance/noDelete: process.env deletion is intentional — assignment stringifies to "undefined"
      delete process.env.SHIPWRIGHT_TASK_STORE_URL;
    }
    if (origConfig !== undefined) {
      process.env.SHIPWRIGHT_CONFIG = origConfig;
    } else {
      // biome-ignore lint/performance/noDelete: process.env deletion is intentional — assignment stringifies to "undefined"
      delete process.env.SHIPWRIGHT_CONFIG;
    }
  });

  // Test: when task-store backend configured, createTaskStore returns a TaskStoreHttpAdapter
  test("task-store config → createTaskStore returns TaskStoreHttpAdapter", () => {
    process.env.SHIPWRIGHT_TASK_STORE = "task-store";
    process.env.SHIPWRIGHT_TASK_STORE_URL = "https://ts.example.com";
    process.env.SHIPWRIGHT_TASK_STORE_TOKEN = "test-token";
    const origToken = process.env.SHIPWRIGHT_TASK_STORE_TOKEN;
    try {
      const { config } = loadConfig(tmpDir);
      const store = createTaskStore(config);
      expect(store).toBeInstanceOf(TaskStoreHttpAdapter);
    } finally {
      if (origToken !== undefined) {
        process.env.SHIPWRIGHT_TASK_STORE_TOKEN = origToken;
      } else {
        // biome-ignore lint/performance/noDelete: process.env deletion is intentional — assignment stringifies to "undefined"
        delete process.env.SHIPWRIGHT_TASK_STORE_TOKEN;
      }
    }
  });

  // Test: task-store backend configured → todos.json is NOT read during createTaskStore
  test("task-store backend configured → todos.json is not read by createTaskStore", () => {
    // Create a todos.json that would have been picked up by the old JsonTaskStore
    mkdirSync(join(tmpDir, "state"), { recursive: true });
    writeFileSync(
      join(tmpDir, "state", "todos.json"),
      JSON.stringify([
        { id: "T-1", title: "Should not appear", status: "pending" },
      ]),
    );
    process.env.SHIPWRIGHT_TASK_STORE = "task-store";
    process.env.SHIPWRIGHT_TASK_STORE_URL = "https://ts.example.com";
    process.env.SHIPWRIGHT_TASK_STORE_TOKEN = "test-token";
    const origToken = process.env.SHIPWRIGHT_TASK_STORE_TOKEN;
    try {
      const { config } = loadConfig(tmpDir);
      expect(config.taskStore).toBe("task-store");
      const store = createTaskStore(config);
      expect(store).toBeInstanceOf(TaskStoreHttpAdapter);
      // todos.json still exists and is unchanged (not read/written by createTaskStore)
      const todosContent = readFileSync(
        join(tmpDir, "state", "todos.json"),
        "utf-8",
      );
      const todos = JSON.parse(todosContent) as unknown[];
      expect(todos).toHaveLength(1);
    } finally {
      if (origToken !== undefined) {
        process.env.SHIPWRIGHT_TASK_STORE_TOKEN = origToken;
      } else {
        // biome-ignore lint/performance/noDelete: process.env deletion is intentional — assignment stringifies to "undefined"
        delete process.env.SHIPWRIGHT_TASK_STORE_TOKEN;
      }
    }
  });
});
