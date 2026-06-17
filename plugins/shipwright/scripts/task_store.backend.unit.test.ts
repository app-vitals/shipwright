/**
 * plugins/shipwright/scripts/task_store.backend.unit.test.ts
 *
 * Unit tests for the `backend` subcommand helper in task_store.ts.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getBackend } from "./task_store";
import { loadConfig } from "./create-task-store";

describe("getBackend", () => {
  let isolatedDir: string;
  const origTaskStore = process.env.SHIPWRIGHT_TASK_STORE;
  const origConfig = process.env.SHIPWRIGHT_CONFIG;
  const origGhOwner = process.env.SHIPWRIGHT_GITHUB_OWNER;
  const origGhRepo = process.env.SHIPWRIGHT_GITHUB_REPO;
  const origJiraUrl = process.env.JIRA_BASE_URL;
  const origJiraKey = process.env.JIRA_PROJECT_KEY;

  beforeEach(() => {
    isolatedDir = mkdtempSync(join(tmpdir(), "sw-backend-test-"));
    // biome-ignore lint/performance/noDelete: process.env deletion is intentional — assignment stringifies to "undefined"
    delete process.env.SHIPWRIGHT_TASK_STORE;
    // biome-ignore lint/performance/noDelete: process.env deletion is intentional — assignment stringifies to "undefined"
    delete process.env.SHIPWRIGHT_CONFIG;
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

  test("no config (JSON default) → returns 'json'", () => {
    const { config } = loadConfig(isolatedDir);
    expect(getBackend(config)).toBe("json");
  });

  test("SHIPWRIGHT_TASK_STORE=github → returns 'github'", () => {
    process.env.SHIPWRIGHT_TASK_STORE = "github";
    process.env.SHIPWRIGHT_GITHUB_OWNER = "my-org";
    process.env.SHIPWRIGHT_GITHUB_REPO = "my-repo";
    const { config } = loadConfig(isolatedDir);
    expect(getBackend(config)).toBe("github");
  });

  test("SHIPWRIGHT_TASK_STORE=jira → returns 'jira'", () => {
    process.env.SHIPWRIGHT_TASK_STORE = "jira";
    process.env.JIRA_BASE_URL = "https://example.atlassian.net";
    process.env.JIRA_PROJECT_KEY = "SHIP";
    const { config } = loadConfig(isolatedDir);
    expect(getBackend(config)).toBe("jira");
  });

  test(".shipwright.json with github backend → returns 'github'", () => {
    writeFileSync(
      join(isolatedDir, ".shipwright.json"),
      JSON.stringify({
        taskStore: "github",
        github: { owner: "example-org", repo: "example-repo" },
      }),
    );
    const { config } = loadConfig(isolatedDir);
    expect(getBackend(config)).toBe("github");
  });
});
