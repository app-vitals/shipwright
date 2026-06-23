/**
 * plugins/shipwright/scripts/create-task-store.unit.test.ts
 *
 * Unit tests for loadConfig() in create-task-store.ts.
 * Config is read exclusively from SHIPWRIGHT_TASK_STORE_URL.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { TaskStoreHttpClient } from "./store";
import { createTaskStore, loadConfig } from "./create-task-store";

describe("loadConfig", () => {
  const origUrl = process.env.SHIPWRIGHT_TASK_STORE_URL;
  const origToken = process.env.SHIPWRIGHT_TASK_STORE_TOKEN;

  beforeEach(() => {
    // biome-ignore lint/performance/noDelete: process.env deletion is intentional — assignment stringifies to "undefined"
    delete process.env.SHIPWRIGHT_TASK_STORE_URL;
    // biome-ignore lint/performance/noDelete: process.env deletion is intentional — assignment stringifies to "undefined"
    delete process.env.SHIPWRIGHT_TASK_STORE_TOKEN;
  });

  afterEach(() => {
    if (origUrl !== undefined) {
      process.env.SHIPWRIGHT_TASK_STORE_URL = origUrl;
    } else {
      // biome-ignore lint/performance/noDelete: process.env deletion is intentional — assignment stringifies to "undefined"
      delete process.env.SHIPWRIGHT_TASK_STORE_URL;
    }
    if (origToken !== undefined) {
      process.env.SHIPWRIGHT_TASK_STORE_TOKEN = origToken;
    } else {
      // biome-ignore lint/performance/noDelete: process.env deletion is intentional — assignment stringifies to "undefined"
      delete process.env.SHIPWRIGHT_TASK_STORE_TOKEN;
    }
  });

  test("reads taskStoreUrl from SHIPWRIGHT_TASK_STORE_URL", () => {
    process.env.SHIPWRIGHT_TASK_STORE_URL = "https://ts.example.com";
    const config = loadConfig();
    expect(config.taskStoreUrl).toBe("https://ts.example.com");
  });

  test("trims whitespace from SHIPWRIGHT_TASK_STORE_URL", () => {
    process.env.SHIPWRIGHT_TASK_STORE_URL = "  https://ts.example.com  ";
    const config = loadConfig();
    expect(config.taskStoreUrl).toBe("https://ts.example.com");
  });
});

describe("createTaskStore", () => {
  const origUrl = process.env.SHIPWRIGHT_TASK_STORE_URL;
  const origToken = process.env.SHIPWRIGHT_TASK_STORE_TOKEN;

  afterEach(() => {
    if (origUrl !== undefined) {
      process.env.SHIPWRIGHT_TASK_STORE_URL = origUrl;
    } else {
      // biome-ignore lint/performance/noDelete: process.env deletion is intentional — assignment stringifies to "undefined"
      delete process.env.SHIPWRIGHT_TASK_STORE_URL;
    }
    if (origToken !== undefined) {
      process.env.SHIPWRIGHT_TASK_STORE_TOKEN = origToken;
    } else {
      // biome-ignore lint/performance/noDelete: process.env deletion is intentional — assignment stringifies to "undefined"
      delete process.env.SHIPWRIGHT_TASK_STORE_TOKEN;
    }
  });

  test("returns a TaskStoreHttpClient", () => {
    process.env.SHIPWRIGHT_TASK_STORE_TOKEN = "test-token";
    const store = createTaskStore({ taskStoreUrl: "https://ts.example.com" });
    expect(store).toBeInstanceOf(TaskStoreHttpClient);
  });
});
