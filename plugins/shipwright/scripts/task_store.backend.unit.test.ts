/**
 * plugins/shipwright/scripts/task_store.backend.unit.test.ts
 *
 * Unit tests for the `backend` subcommand helper in task_store.ts.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./create-task-store";
import { getBackend } from "./task_store";

describe("getBackend", () => {
  let isolatedDir: string;
  const origTaskStore = process.env.SHIPWRIGHT_TASK_STORE;
  const origConfig = process.env.SHIPWRIGHT_CONFIG;
  const origTaskStoreUrl = process.env.SHIPWRIGHT_TASK_STORE_URL;

  beforeEach(() => {
    isolatedDir = mkdtempSync(join(tmpdir(), "sw-backend-test-"));
    // biome-ignore lint/performance/noDelete: process.env deletion is intentional — assignment stringifies to "undefined"
    delete process.env.SHIPWRIGHT_TASK_STORE;
    // biome-ignore lint/performance/noDelete: process.env deletion is intentional — assignment stringifies to "undefined"
    delete process.env.SHIPWRIGHT_CONFIG;
    // biome-ignore lint/performance/noDelete: process.env deletion is intentional — assignment stringifies to "undefined"
    delete process.env.SHIPWRIGHT_TASK_STORE_URL;
  });

  afterEach(() => {
    rmSync(isolatedDir, { recursive: true, force: true });
    if (origTaskStore !== undefined) {
      process.env.SHIPWRIGHT_TASK_STORE = origTaskStore;
    } else {
      // biome-ignore lint/performance/noDelete: process.env deletion is intentional — assignment stringifies to "undefined"
      delete process.env.SHIPWRIGHT_TASK_STORE;
    }
    if (origConfig !== undefined) {
      process.env.SHIPWRIGHT_CONFIG = origConfig;
    } else {
      // biome-ignore lint/performance/noDelete: process.env deletion is intentional — assignment stringifies to "undefined"
      delete process.env.SHIPWRIGHT_CONFIG;
    }
    if (origTaskStoreUrl !== undefined) {
      process.env.SHIPWRIGHT_TASK_STORE_URL = origTaskStoreUrl;
    } else {
      // biome-ignore lint/performance/noDelete: process.env deletion is intentional — assignment stringifies to "undefined"
      delete process.env.SHIPWRIGHT_TASK_STORE_URL;
    }
  });

  test("no config (JSON default) → returns 'json'", () => {
    const { config } = loadConfig(isolatedDir);
    expect(getBackend(config)).toBe("json");
  });

  test("SHIPWRIGHT_TASK_STORE=task-store → returns 'task-store'", () => {
    process.env.SHIPWRIGHT_TASK_STORE = "task-store";
    process.env.SHIPWRIGHT_TASK_STORE_URL = "https://ts.example.com";
    const { config } = loadConfig(isolatedDir);
    expect(getBackend(config)).toBe("task-store");
  });

  test(".shipwright.json with task-store backend → returns 'task-store'", () => {
    writeFileSync(
      join(isolatedDir, ".shipwright.json"),
      JSON.stringify({
        taskStore: "task-store",
        taskStoreUrl: "https://ts.example.com",
      }),
    );
    const { config } = loadConfig(isolatedDir);
    expect(getBackend(config)).toBe("task-store");
  });

  test(".shipwright.json with json backend → returns 'json'", () => {
    writeFileSync(
      join(isolatedDir, ".shipwright.json"),
      JSON.stringify({ taskStore: "json" }),
    );
    const { config } = loadConfig(isolatedDir);
    expect(getBackend(config)).toBe("json");
  });
});
