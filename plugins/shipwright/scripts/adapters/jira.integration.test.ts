/**
 * plugins/shipwright/scripts/adapters/jira.integration.test.ts
 *
 * Integration tests for JiraTaskStore — cassette-backed fixtures in
 * plugins/shipwright/tests/fixtures/jira/. No live Jira calls.
 * fetchFn injected via constructor; no mock.module() or global overrides.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import type { TaskStoreConfig } from "../store.ts";
import { JiraTaskStore } from "./jira.ts";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const FIXTURES_DIR = join(import.meta.dir, "../../tests/fixtures/jira");

function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, name), "utf-8"));
}

const SEARCH_FIXTURE = loadFixture("search.json");
const CREATE_ISSUE_FIXTURE = loadFixture("create-issue.json");
const TRANSITIONS_FIXTURE = loadFixture("transitions.json");
const ADD_COMMENT_FIXTURE = loadFixture("add-comment.json");

// ─── Config ───────────────────────────────────────────────────────────────────

const BASE_URL = "https://test.atlassian.net";
const CONFIG: TaskStoreConfig = {
  taskStore: "jira",
  jira: { baseUrl: BASE_URL, projectKey: "SHIP" },
};

// ─── Cassette fetchFn factory ─────────────────────────────────────────────────

type FetchFn = (url: string | URL | Request, init?: RequestInit) => Promise<Response>;
type CassetteMap = Record<string, { status: number; body: unknown }>;

function resolveRequest(input: RequestInfo | URL, init?: RequestInit): { method: string; path: string } {
  const url = typeof input === "string" ? input : input.toString();
  const method = (init?.method ?? "GET").toUpperCase();
  const path = url.startsWith(BASE_URL) ? url.slice(BASE_URL.length) : url;
  return { method, path };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function makeCassetteFetch(cassette: CassetteMap): FetchFn {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const { method, path } = resolveRequest(input, init);
    const key = `${method} ${path}`;
    const entry = cassette[key];
    if (!entry) throw new Error(`cassette: no entry for "${key}"`);
    return jsonResponse(entry.body, entry.status);
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("JiraTaskStore integration — search → task-list", () => {
  test("query({}) returns tasks mapped from search fixture", async () => {
    const fetchFn = makeCassetteFetch({
      "POST /rest/api/3/issue/search": { status: 200, body: SEARCH_FIXTURE },
    });
    const store = new JiraTaskStore(CONFIG, fetchFn, "user@test.com", "token");
    const tasks = await store.query({});
    expect(tasks).toHaveLength(2);
    expect(tasks[0].id).toBe("JTS-F.1");
    expect(tasks[0].status).toBe("pending");
    expect(tasks[1].id).toBe("JTS-F.2");
    expect(tasks[1].status).toBe("in_progress");
  });

  test("query({ status: 'pending' }) returns only pending tasks", async () => {
    const fetchFn = makeCassetteFetch({
      "POST /rest/api/3/issue/search": { status: 200, body: SEARCH_FIXTURE },
    });
    const store = new JiraTaskStore(CONFIG, fetchFn, "user@test.com", "token");
    const tasks = await store.query({ status: "pending" });
    expect(tasks).toHaveLength(1);
    expect(tasks[0].id).toBe("JTS-F.1");
  });

  test("query({ session: 'fixture-session' }) returns session-scoped tasks", async () => {
    const fetchFn = makeCassetteFetch({
      "POST /rest/api/3/issue/search": { status: 200, body: SEARCH_FIXTURE },
    });
    const store = new JiraTaskStore(CONFIG, fetchFn, "user@test.com", "token");
    const tasks = await store.query({ session: "fixture-session" });
    expect(tasks).toHaveLength(2);
  });
});

describe("JiraTaskStore integration — create-issue flow", () => {
  test("append([newTask]) creates a Jira issue and returns inserted:1", async () => {
    const capturedPaths: string[] = [];
    const fetchFn: FetchFn = async (input, init) => {
      const { method, path } = resolveRequest(input, init);
      capturedPaths.push(`${method} ${path}`);
      if (method === "POST" && path === "/rest/api/3/issue/search") return jsonResponse({ issues: [], total: 0 });
      if (method === "POST" && path === "/rest/api/3/issue") return jsonResponse(CREATE_ISSUE_FIXTURE, 201);
      throw new Error(`cassette: unexpected ${method} ${path}`);
    };
    const store = new JiraTaskStore(CONFIG, fetchFn, "user@test.com", "token");
    const result = await store.append([{ id: "JTS-INT.1", title: "Integration task", status: "pending", session: "test" }]);
    expect(result.inserted).toBe(1);
    expect(result.updated).toBe(0);
    expect(capturedPaths).toContain("POST /rest/api/3/issue");
  });

  test("append([existingTask]) upserts via PUT and returns updated:1", async () => {
    const fetchFn = makeCassetteFetch({
      "POST /rest/api/3/issue/search": { status: 200, body: SEARCH_FIXTURE },
      "PUT /rest/api/3/issue/SHIP-1": { status: 204, body: {} },
    });
    const store = new JiraTaskStore(CONFIG, fetchFn, "user@test.com", "token");
    const result = await store.append([{ id: "JTS-F.1", title: "First fixture task", status: "pending", note: "updated" }]);
    expect(result.inserted).toBe(0);
    expect(result.updated).toBe(1);
  });
});

describe("JiraTaskStore integration — transition-status flow", () => {
  test("update(id, {status:'in_progress'}) transitions to In Progress (id=21)", async () => {
    const transitionCalls: unknown[] = [];
    const fetchFn: FetchFn = async (input, init) => {
      const { method, path } = resolveRequest(input, init);
      if (method === "POST" && path === "/rest/api/3/issue/search") return jsonResponse(SEARCH_FIXTURE);
      if (method === "PUT" && path === "/rest/api/3/issue/SHIP-1") return jsonResponse({}, 204);
      if (method === "GET" && path === "/rest/api/3/issue/SHIP-1/transitions") return jsonResponse(TRANSITIONS_FIXTURE);
      if (method === "POST" && path === "/rest/api/3/issue/SHIP-1/transitions") {
        transitionCalls.push(JSON.parse(init?.body as string));
        return jsonResponse({}, 204);
      }
      throw new Error(`cassette: unexpected ${method} ${path}`);
    };
    const store = new JiraTaskStore(CONFIG, fetchFn, "user@test.com", "token");
    const updated = await store.update("JTS-F.1", { status: "in_progress" });
    expect(updated.status).toBe("in_progress");
    expect(transitionCalls).toHaveLength(1);
    expect((transitionCalls[0] as { transition: { id: string } }).transition.id).toBe("21");
  });

  test("update(id, {status:'done'}) transitions to Done (id=41)", async () => {
    const transitionIds: string[] = [];
    const fetchFn: FetchFn = async (input, init) => {
      const { method, path } = resolveRequest(input, init);
      if (method === "POST" && path === "/rest/api/3/issue/search") return jsonResponse(SEARCH_FIXTURE);
      if (method === "PUT" && path === "/rest/api/3/issue/SHIP-1") return jsonResponse({}, 204);
      if (method === "GET" && path === "/rest/api/3/issue/SHIP-1/transitions") return jsonResponse(TRANSITIONS_FIXTURE);
      if (method === "POST" && path === "/rest/api/3/issue/SHIP-1/transitions") {
        const body = JSON.parse(init?.body as string) as { transition: { id: string } };
        transitionIds.push(body.transition.id);
        return jsonResponse({}, 204);
      }
      throw new Error(`cassette: unexpected ${method} ${path}`);
    };
    const store = new JiraTaskStore(CONFIG, fetchFn, "user@test.com", "token");
    const updated = await store.update("JTS-F.1", { status: "done" });
    expect(updated.status).toBe("done");
    expect(transitionIds).toEqual(["41"]);
  });
});

describe("JiraTaskStore integration — add-comment flow", () => {
  test("update with pr + prUrl posts a comment containing the PR URL", async () => {
    const commentBodies: string[] = [];
    const fetchFn: FetchFn = async (input, init) => {
      const { method, path } = resolveRequest(input, init);
      if (method === "POST" && path === "/rest/api/3/issue/search") return jsonResponse(SEARCH_FIXTURE);
      if (method === "PUT" && path === "/rest/api/3/issue/SHIP-1") return jsonResponse({}, 204);
      if (method === "GET" && path === "/rest/api/3/issue/SHIP-1/transitions") return jsonResponse(TRANSITIONS_FIXTURE);
      if (method === "POST" && path === "/rest/api/3/issue/SHIP-1/transitions") return jsonResponse({}, 204);
      if (method === "POST" && path === "/rest/api/3/issue/SHIP-1/comment") {
        commentBodies.push(init?.body as string);
        return jsonResponse(ADD_COMMENT_FIXTURE, 201);
      }
      throw new Error(`cassette: unexpected ${method} ${path}`);
    };
    const store = new JiraTaskStore(CONFIG, fetchFn, "user@test.com", "token");
    await store.update("JTS-F.1", { status: "pr_open", pr: 99, prUrl: "https://github.com/org/repo/pull/99" });
    expect(commentBodies).toHaveLength(1);
    expect(commentBodies[0]).toContain("https://github.com/org/repo/pull/99");
  });

  test("update without pr field does not post a comment", async () => {
    const commentPaths: string[] = [];
    const fetchFn: FetchFn = async (input, init) => {
      const { method, path } = resolveRequest(input, init);
      if (method === "POST" && path === "/rest/api/3/issue/search") return jsonResponse(SEARCH_FIXTURE);
      if (method === "PUT" && path === "/rest/api/3/issue/SHIP-1") return jsonResponse({}, 204);
      if (method === "GET" && path === "/rest/api/3/issue/SHIP-1/transitions") return jsonResponse(TRANSITIONS_FIXTURE);
      if (method === "POST" && path === "/rest/api/3/issue/SHIP-1/transitions") return jsonResponse({}, 204);
      if (method === "POST" && path.endsWith("/comment")) { commentPaths.push(path); return jsonResponse({}, 201); }
      throw new Error(`cassette: unexpected ${method} ${path}`);
    };
    const store = new JiraTaskStore(CONFIG, fetchFn, "user@test.com", "token");
    await store.update("JTS-F.1", { status: "in_progress" });
    expect(commentPaths).toHaveLength(0);
  });
});
