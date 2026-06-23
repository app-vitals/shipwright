/**
 * plugins/shipwright/scripts/store.integration.test.ts
 *
 * Integration tests for TaskStoreHttpClient — cassette-backed fixtures in
 * plugins/shipwright/tests/fixtures/task-store/. No live HTTP calls.
 * fetchFn injected via constructor; no mock.module() or global overrides.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { TaskStoreHttpClient } from "./store.ts";
import type { FetchFn, TaskStoreConfig } from "./store.ts";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const FIXTURES_DIR = join(import.meta.dir, "../tests/fixtures/task-store");

function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, name), "utf-8"));
}

const TASKS_READY_FIXTURE = loadFixture("tasks-ready.json");
const TASK_UPDATED_FIXTURE = loadFixture("task-updated.json");
const TASK_CLAIMED_FIXTURE = loadFixture("task-claimed.json");
const REPO_FIXTURE = loadFixture("repo.json");

// ─── Config ───────────────────────────────────────────────────────────────────

const BASE_URL = "https://task-store.test";
const TOKEN = "test-bearer-token";
const CONFIG: TaskStoreConfig = {
  taskStoreUrl: BASE_URL,
};

// ─── Cassette fetchFn factory ─────────────────────────────────────────────────

type CassetteMap = Record<string, { status: number; body: unknown }>;

function resolveRequest(
  input: RequestInfo | URL,
  init?: RequestInit,
): { method: string; path: string } {
  const url = typeof input === "string" ? input : input.toString();
  const method = (init?.method ?? "GET").toUpperCase();
  const path = url.startsWith(BASE_URL) ? url.slice(BASE_URL.length) : url;
  return { method, path };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function makeCassetteFetch(cassette: CassetteMap): FetchFn {
  return async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const { method, path } = resolveRequest(input, init);
    const key = `${method} ${path}`;
    const entry = cassette[key];
    if (!entry) throw new Error(`cassette: no entry for "${key}"`);
    return jsonResponse(entry.body, entry.status);
  };
}

// ─── Tests: query ─────────────────────────────────────────────────────────────

describe("TaskStoreHttpClient — query", () => {
  test("query({ ready: true }) makes GET /tasks?ready=true and returns tasks", async () => {
    const fetchFn = makeCassetteFetch({
      "GET /tasks?ready=true": { status: 200, body: TASKS_READY_FIXTURE },
    });
    const store = new TaskStoreHttpClient(CONFIG, fetchFn, TOKEN);
    const tasks = await store.query({ ready: true });
    expect(Array.isArray(tasks)).toBe(true);
    expect(tasks.length).toBeGreaterThan(0);
    expect(tasks[0].id).toBe("TSS-F.1");
    expect(tasks[0].status).toBe("pending");
  });

  test("query({ status: 'pending' }) makes GET /tasks?status=pending", async () => {
    const capturedPaths: string[] = [];
    const fetchFn: FetchFn = async (input, init) => {
      const { method, path } = resolveRequest(input, init);
      capturedPaths.push(`${method} ${path}`);
      return jsonResponse(TASKS_READY_FIXTURE);
    };
    const store = new TaskStoreHttpClient(CONFIG, fetchFn, TOKEN);
    await store.query({ status: "pending" });
    expect(capturedPaths).toContain("GET /tasks?status=pending");
  });

  test("query({ assignee: 'dev' }) makes GET /tasks?assignee=dev", async () => {
    const capturedPaths: string[] = [];
    const fetchFn: FetchFn = async (input, init) => {
      const { method, path } = resolveRequest(input, init);
      capturedPaths.push(`${method} ${path}`);
      return jsonResponse([]);
    };
    const store = new TaskStoreHttpClient(CONFIG, fetchFn, TOKEN);
    await store.query({ assignee: "dev" });
    expect(capturedPaths).toContain("GET /tasks?assignee=dev");
  });

  test("query({ ready: true, assignee: 'dev' }) combines filters", async () => {
    const capturedPaths: string[] = [];
    const fetchFn: FetchFn = async (input, init) => {
      const { method, path } = resolveRequest(input, init);
      capturedPaths.push(`${method} ${path}`);
      return jsonResponse([]);
    };
    const store = new TaskStoreHttpClient(CONFIG, fetchFn, TOKEN);
    await store.query({ ready: true, assignee: "dev" });
    expect(capturedPaths[0]).toMatch(/^GET \/tasks\?/);
    expect(capturedPaths[0]).toContain("ready=true");
    expect(capturedPaths[0]).toContain("assignee=dev");
  });
});

// ─── Tests: append ────────────────────────────────────────────────────────────

describe("TaskStoreHttpClient — append", () => {
  test("append([newTask]) posts via POST /tasks and returns inserted:1", async () => {
    const capturedPaths: string[] = [];
    const fetchFn: FetchFn = async (input, init) => {
      const { method, path } = resolveRequest(input, init);
      capturedPaths.push(`${method} ${path}`);
      return jsonResponse(
        { id: "TSS-INT.1", title: "New task", status: "pending" },
        201,
      );
    };
    const store = new TaskStoreHttpClient(CONFIG, fetchFn, TOKEN);
    const result = await store.append([
      { id: "TSS-INT.1", title: "New task", status: "pending" },
    ]);
    expect(result.inserted).toBe(1);
    expect(result.updated).toBe(0);
    expect(capturedPaths).toContain("POST /tasks");
  });

  test("append with 409 conflict skips without error and returns inserted:0", async () => {
    const fetchFn: FetchFn = async () => jsonResponse({ error: "conflict" }, 409);
    const store = new TaskStoreHttpClient(CONFIG, fetchFn, TOKEN);
    const result = await store.append([
      { id: "TSS-EXIST.1", title: "Already exists", status: "pending" },
    ]);
    expect(result.inserted).toBe(0);
    expect(result.updated).toBe(0);
  });

  test("append([task1, task2]) posts each task and returns inserted:2", async () => {
    let callCount = 0;
    const fetchFn: FetchFn = async () => { callCount++; return jsonResponse({}, 201); };
    const store = new TaskStoreHttpClient(CONFIG, fetchFn, TOKEN);
    const result = await store.append([
      { id: "TSS-A.1", title: "Task A1", status: "pending" },
      { id: "TSS-A.2", title: "Task A2", status: "pending" },
    ]);
    expect(callCount).toBe(2);
    expect(result.inserted).toBe(2);
  });
});

// ─── Tests: update ────────────────────────────────────────────────────────────

describe("TaskStoreHttpClient — update", () => {
  test("update(id, fields) sends PATCH /tasks/{id} and returns updated task", async () => {
    const capturedPaths: string[] = [];
    const capturedBodies: string[] = [];
    const fetchFn: FetchFn = async (input, init) => {
      const { method, path } = resolveRequest(input, init);
      capturedPaths.push(`${method} ${path}`);
      if (init?.body) capturedBodies.push(init.body as string);
      return jsonResponse(TASK_UPDATED_FIXTURE);
    };
    const store = new TaskStoreHttpClient(CONFIG, fetchFn, TOKEN);
    const updated = await store.update("TSS-F.1", { status: "in_progress" });
    expect(capturedPaths).toContain("PATCH /tasks/TSS-F.1");
    expect(updated.id).toBe("TSS-F.1");
    expect(updated.status).toBe("in_progress");
    const body = JSON.parse(capturedBodies[0]) as Record<string, unknown>;
    expect(body.status).toBe("in_progress");
  });

  test("update throws on non-2xx response", async () => {
    const fetchFn: FetchFn = async () => jsonResponse({ error: "not found" }, 404);
    const store = new TaskStoreHttpClient(CONFIG, fetchFn, TOKEN);
    await expect(
      store.update("MISSING", { status: "in_progress" }),
    ).rejects.toThrow();
  });
});

// ─── Tests: claim ─────────────────────────────────────────────────────────────

describe("TaskStoreHttpClient — claim", () => {
  test("claim(id) sends POST /tasks/{id}/claim and returns claimed task", async () => {
    const capturedPaths: string[] = [];
    const fetchFn: FetchFn = async (input, init) => {
      const { method, path } = resolveRequest(input, init);
      capturedPaths.push(`${method} ${path}`);
      return jsonResponse(TASK_CLAIMED_FIXTURE);
    };
    const store = new TaskStoreHttpClient(CONFIG, fetchFn, TOKEN);
    const claimed = await store.claim("TSS-F.1");
    expect(capturedPaths).toContain("POST /tasks/TSS-F.1/claim");
    expect(claimed.id).toBe("TSS-F.1");
    expect(claimed.status).toBe("in_progress");
  });
});

// ─── Tests: resolveRepo ───────────────────────────────────────────────────────

describe("TaskStoreHttpClient — resolveRepo", () => {
  test("resolveRepo calls GET /tasks/repo when available", async () => {
    const fetchFn = makeCassetteFetch({
      "GET /tasks/repo": { status: 200, body: REPO_FIXTURE },
    });
    const store = new TaskStoreHttpClient(CONFIG, fetchFn, TOKEN);
    const repo = await store.resolveRepo();
    expect(repo).toBe("app-vitals/shipwright");
  });

  test("resolveRepo falls back to first task repo when /tasks/repo returns 404", async () => {
    const fetchFn: FetchFn = async (input, init) => {
      const { path } = resolveRequest(input, init);
      if (path === "/tasks/repo") return jsonResponse({ error: "not found" }, 404);
      return jsonResponse(TASKS_READY_FIXTURE);
    };
    const store = new TaskStoreHttpClient(CONFIG, fetchFn, TOKEN);
    const repo = await store.resolveRepo();
    expect(repo).toBe("app-vitals/shipwright");
  });

  test("resolveRepos returns single-element array from resolveRepo", async () => {
    const fetchFn = makeCassetteFetch({
      "GET /tasks/repo": { status: 200, body: REPO_FIXTURE },
    });
    const store = new TaskStoreHttpClient(CONFIG, fetchFn, TOKEN);
    const repos = await store.resolveRepos();
    expect(repos).toEqual(["app-vitals/shipwright"]);
  });
});

// ─── Tests: cleanup ───────────────────────────────────────────────────────────

describe("TaskStoreHttpClient — cleanup", () => {
  test("cleanup returns zeros without HTTP calls", async () => {
    const capturedPaths: string[] = [];
    const fetchFn: FetchFn = async (input, init) => {
      const { method, path } = resolveRequest(input, init);
      capturedPaths.push(`${method} ${path}`);
      return jsonResponse({});
    };
    const store = new TaskStoreHttpClient(CONFIG, fetchFn, TOKEN);
    const result = await store.cleanup();
    expect(result).toEqual({ closed: 0, milestonesClosed: 0, plansClosed: 0 });
    expect(capturedPaths).toHaveLength(0);
  });
});

// ─── Tests: auth header ───────────────────────────────────────────────────────

describe("TaskStoreHttpClient — auth", () => {
  test("all requests include Authorization: Bearer token header", async () => {
    const capturedHeaders: Record<string, string>[] = [];
    const fetchFn: FetchFn = async (_input, init) => {
      capturedHeaders.push((init?.headers ?? {}) as Record<string, string>);
      return jsonResponse([]);
    };
    const store = new TaskStoreHttpClient(CONFIG, fetchFn, TOKEN);
    await store.query({});
    expect(capturedHeaders.length).toBeGreaterThan(0);
    expect(capturedHeaders[0].Authorization).toBe(`Bearer ${TOKEN}`);
  });

  test("throws if token is missing", () => {
    expect(
      () => new TaskStoreHttpClient(CONFIG, makeCassetteFetch({}), ""),
    ).toThrow("SHIPWRIGHT_TASK_STORE_TOKEN");
  });
});
