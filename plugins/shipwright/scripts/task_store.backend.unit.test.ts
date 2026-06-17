/**
 * plugins/shipwright/scripts/task_store.backend.unit.test.ts
 *
 * Unit tests for the `backend` subcommand helper in task_store.ts.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cmdBackend } from "./task_store";
import { loadConfig } from "./create-task-store";

describe("cmdBackend", () => {
  let isolatedDir: string;
  const origTaskStore = process.env.SHIPWRIGHT_TASK_STORE;
  const origConfig = process.env.SHIPWRIGHT_CONFIG;
  const origGhOwner = process.env.SHIPWRIGHT_GITHUB_OWNER;
  const origGhRepo = process.env.SHIPWRIGHT_GITHUB_REPO;

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
  });

  test("no config (JSON default) → prints 'json'", () => {
    const { config } = loadConfig(isolatedDir);
    const output: string[] = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    // biome-ignore lint/suspicious/noExplicitAny: intercepting stdout.write for test assertion
    (process.stdout as any).write = (chunk: string, ...rest: unknown[]) => {
      output.push(chunk);
      return true;
    };
    try {
      cmdBackend(config);
    } finally {
      // biome-ignore lint/suspicious/noExplicitAny: restoring original stdout.write
      (process.stdout as any).write = origWrite;
    }
    expect(output.join("")).toBe("json\n");
  });

  test("SHIPWRIGHT_TASK_STORE=github → prints 'github'", () => {
    process.env.SHIPWRIGHT_TASK_STORE = "github";
    process.env.SHIPWRIGHT_GITHUB_OWNER = "my-org";
    process.env.SHIPWRIGHT_GITHUB_REPO = "my-repo";
    const { config } = loadConfig(isolatedDir);
    const output: string[] = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    // biome-ignore lint/suspicious/noExplicitAny: intercepting stdout.write for test assertion
    (process.stdout as any).write = (chunk: string, ...rest: unknown[]) => {
      output.push(chunk);
      return true;
    };
    try {
      cmdBackend(config);
    } finally {
      // biome-ignore lint/suspicious/noExplicitAny: restoring original stdout.write
      (process.stdout as any).write = origWrite;
    }
    expect(output.join("")).toBe("github\n");
  });

  test("SHIPWRIGHT_TASK_STORE=jira → prints 'jira'", () => {
    process.env.SHIPWRIGHT_TASK_STORE = "jira";
    process.env.JIRA_BASE_URL = "https://example.atlassian.net";
    process.env.JIRA_PROJECT_KEY = "SHIP";
    const origJiraUrl = process.env.JIRA_BASE_URL;
    const origJiraKey = process.env.JIRA_PROJECT_KEY;
    const { config } = loadConfig(isolatedDir);
    const output: string[] = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    // biome-ignore lint/suspicious/noExplicitAny: intercepting stdout.write for test assertion
    (process.stdout as any).write = (chunk: string, ...rest: unknown[]) => {
      output.push(chunk);
      return true;
    };
    try {
      cmdBackend(config);
    } finally {
      // biome-ignore lint/suspicious/noExplicitAny: restoring original stdout.write
      (process.stdout as any).write = origWrite;
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
    }
    expect(output.join("")).toBe("jira\n");
  });

  test(".shipwright.json with github backend → prints 'github'", () => {
    writeFileSync(
      join(isolatedDir, ".shipwright.json"),
      JSON.stringify({
        taskStore: "github",
        github: { owner: "example-org", repo: "example-repo" },
      }),
    );
    const { config } = loadConfig(isolatedDir);
    const output: string[] = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    // biome-ignore lint/suspicious/noExplicitAny: intercepting stdout.write for test assertion
    (process.stdout as any).write = (chunk: string, ...rest: unknown[]) => {
      output.push(chunk);
      return true;
    };
    try {
      cmdBackend(config);
    } finally {
      // biome-ignore lint/suspicious/noExplicitAny: restoring original stdout.write
      (process.stdout as any).write = origWrite;
    }
    expect(output.join("")).toBe("github\n");
  });
});
