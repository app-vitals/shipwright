/**
 * plugins/shipwright/scripts/adapters/jira.unit.test.ts
 *
 * Tests for JiraTaskStore — injects a fake fetch function via constructor.
 * No global.fetch mutation, no mock.module(). All responses are pre-baked.
 */

import { describe, expect, test } from "bun:test";
import type { TaskStoreConfig } from "../store.ts";
import { JiraTaskStore } from "./jira.ts";

const BASE_URL = "https://example.atlassian.net";
const PROJECT_KEY = "SHIP";

const CONFIG: TaskStoreConfig = {
  taskStore: "jira",
  jira: { baseUrl: BASE_URL, projectKey: PROJECT_KEY },
};

type FakeResponse = { status: number; body: unknown };

// Minimal fetch signature compatible with JiraTaskStore constructor injection
type FetchFn = (url: string | URL | Request, init?: RequestInit) => Promise<Response>;

function makeFakeFetch(responses: Record<string, FakeResponse>): FetchFn {
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = (init?.method ?? "GET").toUpperCase();
    const path = url.startsWith(BASE_URL) ? url.slice(BASE_URL.length) : url;
    const key = `${method} ${path}`;
    const response = responses[key];
    if (!response) throw new Error(`fake fetch: no response for "${key}"`);
    return new Response(JSON.stringify(response.body), {
      status: response.status,
      headers: { "Content-Type": "application/json" },
    });
  };
}

function makeJiraIssue(key: string, summary: string, jiraStatus: string, taskMeta: Record<string, unknown>) {
  const metaJson = JSON.stringify(taskMeta, null, 2);
  const description = {
    type: "doc", version: 1,
    content: [{ type: "codeBlock", attrs: { language: "shipwright" }, content: [{ type: "text", text: metaJson }] }],
  };
  return { id: `10${key.replace(/\D/g, "")}`, key, fields: { summary, status: { name: jiraStatus }, description } };
}

function makeTransitions(transitions: Array<{ id: string; name: string }>) {
  return { transitions };
}

describe("JiraTaskStore constructor", () => {
  test("throws if JIRA_EMAIL is missing", () => {
    expect(() => new JiraTaskStore(CONFIG, makeFakeFetch({}), undefined, "token")).toThrow("JIRA_EMAIL and JIRA_API_TOKEN environment variables are required");
  });
  test("throws if JIRA_API_TOKEN is missing", () => {
    expect(() => new JiraTaskStore(CONFIG, makeFakeFetch({}), "user@example.com", undefined)).toThrow("JIRA_EMAIL and JIRA_API_TOKEN environment variables are required");
  });
  test("throws if both missing", () => {
    expect(() => new JiraTaskStore(CONFIG, makeFakeFetch({}), undefined, undefined)).toThrow("JIRA_EMAIL and JIRA_API_TOKEN environment variables are required");
  });
  test("constructs successfully with both credentials", () => {
    expect(() => new JiraTaskStore(CONFIG, makeFakeFetch({}), "user@example.com", "token123")).not.toThrow();
  });
});

describe("JiraTaskStore.resolveRepo", () => {
  test("returns projectKey from config", async () => {
    const store = new JiraTaskStore(CONFIG, makeFakeFetch({}), "user@example.com", "token");
    expect(await store.resolveRepo()).toBe(PROJECT_KEY);
  });
  test("throws if jira config is missing", async () => {
    const store = new JiraTaskStore({ taskStore: "jira" }, makeFakeFetch({}), "user@example.com", "token");
    await expect(store.resolveRepo()).rejects.toThrow();
  });
});

describe("JiraTaskStore.resolveRepos", () => {
  test("returns projectKey as single-element array", async () => {
    const store = new JiraTaskStore(CONFIG, makeFakeFetch({}), "user@example.com", "token");
    expect(await store.resolveRepos()).toEqual([PROJECT_KEY]);
  });
  test("returns [] when jira config is missing", async () => {
    const store = new JiraTaskStore({ taskStore: "jira" }, makeFakeFetch({}), "user@example.com", "token");
    expect(await store.resolveRepos()).toEqual([]);
  });
});

describe("JiraTaskStore.setup", () => {
  test("succeeds when project exists (200)", async () => {
    const fakeFetch = makeFakeFetch({ [`GET /rest/api/3/project/${PROJECT_KEY}`]: { status: 200, body: { key: PROJECT_KEY } } });
    const store = new JiraTaskStore(CONFIG, fakeFetch, "user@example.com", "token");
    await expect(store.setup()).resolves.toBeUndefined();
  });
  test("throws on 401 auth failure with clear message", async () => {
    const fakeFetch = makeFakeFetch({ [`GET /rest/api/3/project/${PROJECT_KEY}`]: { status: 401, body: {} } });
    const store = new JiraTaskStore(CONFIG, fakeFetch, "user@example.com", "token");
    await expect(store.setup()).rejects.toThrow(/auth/i);
  });
  test("throws on 404 missing project with clear message", async () => {
    const fakeFetch = makeFakeFetch({ [`GET /rest/api/3/project/${PROJECT_KEY}`]: { status: 404, body: {} } });
    const store = new JiraTaskStore(CONFIG, fakeFetch, "user@example.com", "token");
    await expect(store.setup()).rejects.toThrow(/not found|project/i);
  });
});

describe("JiraTaskStore.query", () => {
  test("returns all issues with no filters", async () => {
    const issues = [
      makeJiraIssue("SHIP-1", "First task", "To Do", { id: "JTS-1.1", title: "First task", status: "pending" }),
      makeJiraIssue("SHIP-2", "Second task", "In Progress", { id: "JTS-1.2", title: "Second task", status: "in_progress" }),
    ];
    const fakeFetch = makeFakeFetch({ "POST /rest/api/3/issue/search": { status: 200, body: { issues, total: 2 } } });
    const store = new JiraTaskStore(CONFIG, fakeFetch, "user@example.com", "token");
    const tasks = await store.query({});
    expect(tasks).toHaveLength(2);
    expect(tasks[0].id).toBe("JTS-1.1");
    expect(tasks[1].id).toBe("JTS-1.2");
  });

  test("maps Jira status names to Shipwright statuses via default map", async () => {
    const issues = [
      makeJiraIssue("SHIP-1", "t1", "To Do", { id: "JTS-2.1", title: "t1", status: "pending" }),
      makeJiraIssue("SHIP-2", "t2", "In Progress", { id: "JTS-2.2", title: "t2", status: "in_progress" }),
      makeJiraIssue("SHIP-3", "t3", "In Review", { id: "JTS-2.3", title: "t3", status: "pr_open" }),
      makeJiraIssue("SHIP-4", "t4", "Done", { id: "JTS-2.4", title: "t4", status: "done" }),
      makeJiraIssue("SHIP-5", "t5", "Blocked", { id: "JTS-2.5", title: "t5", status: "blocked" }),
    ];
    const fakeFetch = makeFakeFetch({ "POST /rest/api/3/issue/search": { status: 200, body: { issues, total: 5 } } });
    const store = new JiraTaskStore(CONFIG, fakeFetch, "user@example.com", "token");
    const tasks = await store.query({});
    expect(tasks[0].status).toBe("pending");
    expect(tasks[1].status).toBe("in_progress");
    expect(tasks[2].status).toBe("pr_open");
    expect(tasks[3].status).toBe("done");
    expect(tasks[4].status).toBe("blocked");
  });

  test("filters by status", async () => {
    const issues = [
      makeJiraIssue("SHIP-1", "t1", "To Do", { id: "JTS-3.1", title: "t1", status: "pending" }),
      makeJiraIssue("SHIP-2", "t2", "In Progress", { id: "JTS-3.2", title: "t2", status: "in_progress" }),
    ];
    const fakeFetch = makeFakeFetch({ "POST /rest/api/3/issue/search": { status: 200, body: { issues, total: 2 } } });
    const store = new JiraTaskStore(CONFIG, fakeFetch, "user@example.com", "token");
    const tasks = await store.query({ status: "pending" });
    expect(tasks).toHaveLength(1);
    expect(tasks[0].status).toBe("pending");
  });

  test("filters by session", async () => {
    const issues = [
      makeJiraIssue("SHIP-1", "t1", "To Do", { id: "JTS-4.1", title: "t1", status: "pending", session: "session-a" }),
      makeJiraIssue("SHIP-2", "t2", "To Do", { id: "JTS-4.2", title: "t2", status: "pending", session: "session-b" }),
    ];
    const fakeFetch = makeFakeFetch({ "POST /rest/api/3/issue/search": { status: 200, body: { issues, total: 2 } } });
    const store = new JiraTaskStore(CONFIG, fakeFetch, "user@example.com", "token");
    const tasks = await store.query({ session: "session-a" });
    expect(tasks).toHaveLength(1);
    expect(tasks[0].session).toBe("session-a");
  });

  test("filters by id", async () => {
    const issues = [
      makeJiraIssue("SHIP-1", "t1", "To Do", { id: "JTS-5.1", title: "t1", status: "pending" }),
      makeJiraIssue("SHIP-2", "t2", "To Do", { id: "JTS-5.2", title: "t2", status: "pending" }),
    ];
    const fakeFetch = makeFakeFetch({ "POST /rest/api/3/issue/search": { status: 200, body: { issues, total: 2 } } });
    const store = new JiraTaskStore(CONFIG, fakeFetch, "user@example.com", "token");
    const tasks = await store.query({ id: "JTS-5.2" });
    expect(tasks).toHaveLength(1);
    expect(tasks[0].id).toBe("JTS-5.2");
  });

  test("query ready:true returns only pending tasks with no unmet deps", async () => {
    const issues = [
      makeJiraIssue("SHIP-1", "t1", "To Do", { id: "JTS-6.1", title: "t1", status: "pending", dependencies: [] }),
      makeJiraIssue("SHIP-2", "t2", "To Do", { id: "JTS-6.2", title: "t2", status: "pending", dependencies: ["JTS-6.1"] }),
    ];
    const fakeFetch = makeFakeFetch({ "POST /rest/api/3/issue/search": { status: 200, body: { issues, total: 2 } } });
    const store = new JiraTaskStore(CONFIG, fakeFetch, "user@example.com", "token");
    const tasks = await store.query({ ready: true });
    expect(tasks).toHaveLength(1);
    expect(tasks[0].id).toBe("JTS-6.1");
  });

  test("query ready:true includes tasks whose deps are done", async () => {
    const issues = [
      makeJiraIssue("SHIP-1", "dep", "Done", { id: "JTS-7.1", title: "dep", status: "done", dependencies: [] }),
      makeJiraIssue("SHIP-2", "task", "To Do", { id: "JTS-7.2", title: "task", status: "pending", dependencies: ["JTS-7.1"] }),
    ];
    const fakeFetch = makeFakeFetch({ "POST /rest/api/3/issue/search": { status: 200, body: { issues, total: 2 } } });
    const store = new JiraTaskStore(CONFIG, fakeFetch, "user@example.com", "token");
    const tasks = await store.query({ ready: true });
    expect(tasks).toHaveLength(1);
    expect(tasks[0].id).toBe("JTS-7.2");
  });

  test("query ready:true uses async () => false for isPrMerged", async () => {
    const issues = [
      makeJiraIssue("SHIP-1", "pr-dep", "In Review", { id: "JTS-8.1", title: "pr-dep", status: "pr_open", pr: 42, branch: "feat/other", dependencies: [] }),
      makeJiraIssue("SHIP-2", "task", "To Do", { id: "JTS-8.2", title: "task", status: "pending", branch: "feat/mine", dependencies: ["JTS-8.1"] }),
    ];
    const fakeFetch = makeFakeFetch({ "POST /rest/api/3/issue/search": { status: 200, body: { issues, total: 2 } } });
    const store = new JiraTaskStore(CONFIG, fakeFetch, "user@example.com", "token");
    const tasks = await store.query({ ready: true });
    expect(tasks.find((t) => t.id === "JTS-8.2")).toBeUndefined();
  });

  test("filters by assignee in non-ready query", async () => {
    const issues = [
      makeJiraIssue("SHIP-1", "t1", "To Do", { id: "JTS-9.1", title: "t1", status: "pending", assignee: "alice" }),
      makeJiraIssue("SHIP-2", "t2", "To Do", { id: "JTS-9.2", title: "t2", status: "pending", assignee: "bob" }),
    ];
    const fakeFetch = makeFakeFetch({ "POST /rest/api/3/issue/search": { status: 200, body: { issues, total: 2 } } });
    const store = new JiraTaskStore(CONFIG, fakeFetch, "user@example.com", "token");
    const tasks = await store.query({ assignee: "alice" });
    expect(tasks).toHaveLength(1);
    expect(tasks[0].id).toBe("JTS-9.1");
  });
});

describe("JiraTaskStore fetchAllIssues — readyJql config", () => {
  test("uses config.jira.readyJql when set instead of the default label-based JQL", async () => {
    const capturedJqls: string[] = [];
    const configWithJql: TaskStoreConfig = {
      taskStore: "jira",
      jira: { baseUrl: BASE_URL, projectKey: PROJECT_KEY, readyJql: "project = SHIP AND assignee = currentUser() ORDER BY priority ASC" },
    };
    const fakeFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input.toString();
      const path = url.startsWith(BASE_URL) ? url.slice(BASE_URL.length) : url;
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "POST" && path === "/rest/api/3/issue/search") {
        const body = JSON.parse(init?.body as string) as { jql: string };
        capturedJqls.push(body.jql);
        return new Response(JSON.stringify({ issues: [], total: 0 }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      throw new Error(`fake fetch: unexpected ${method} ${path}`);
    };
    const store = new JiraTaskStore(configWithJql, fakeFetch, "user@example.com", "token");
    await store.query({});
    expect(capturedJqls).toHaveLength(1);
    expect(capturedJqls[0]).toBe("project = SHIP AND assignee = currentUser() ORDER BY priority ASC");
  });

  test("uses default label-based JQL when readyJql is not set", async () => {
    const capturedJqls: string[] = [];
    const fakeFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input.toString();
      const path = url.startsWith(BASE_URL) ? url.slice(BASE_URL.length) : url;
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "POST" && path === "/rest/api/3/issue/search") {
        const body = JSON.parse(init?.body as string) as { jql: string };
        capturedJqls.push(body.jql);
        return new Response(JSON.stringify({ issues: [], total: 0 }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      throw new Error(`fake fetch: unexpected ${method} ${path}`);
    };
    const store = new JiraTaskStore(CONFIG, fakeFetch, "user@example.com", "token");
    await store.query({});
    expect(capturedJqls).toHaveLength(1);
    expect(capturedJqls[0]).toContain("shipwright-session");
    expect(capturedJqls[0]).toContain(PROJECT_KEY);
  });
});

describe("JiraTaskStore fetchAllIssues — pagination", () => {
  test("paginates when total exceeds page size", async () => {
    const page1Issues = [
      makeJiraIssue("SHIP-1", "Task 1", "To Do", { id: "JTS-PAG-1", title: "Task 1", status: "pending" }),
    ];
    const page2Issues = [
      makeJiraIssue("SHIP-2", "Task 2", "In Progress", { id: "JTS-PAG-2", title: "Task 2", status: "in_progress" }),
    ];
    const fetchedStartAts: number[] = [];
    const fakeFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input.toString();
      const path = url.startsWith(BASE_URL) ? url.slice(BASE_URL.length) : url;
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "POST" && path === "/rest/api/3/issue/search") {
        const body = JSON.parse(init?.body as string) as { startAt: number; maxResults: number };
        fetchedStartAts.push(body.startAt);
        const issues = body.startAt === 0 ? page1Issues : page2Issues;
        return new Response(JSON.stringify({ issues, total: 2 }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      throw new Error(`fake fetch: unexpected ${method} ${path}`);
    };
    const store = new JiraTaskStore(CONFIG, fakeFetch, "user@example.com", "token");
    const tasks = await store.query({});
    expect(tasks).toHaveLength(2);
    expect(tasks[0].id).toBe("JTS-PAG-1");
    expect(tasks[1].id).toBe("JTS-PAG-2");
    expect(fetchedStartAts).toHaveLength(2);
    expect(fetchedStartAts[0]).toBe(0);
    expect(fetchedStartAts[1]).toBe(1);
  });

  test("single page fetch when total matches page results", async () => {
    const issues = [
      makeJiraIssue("SHIP-1", "Only task", "To Do", { id: "JTS-PAG-3", title: "Only task", status: "pending" }),
    ];
    let fetchCount = 0;
    const fakeFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input.toString();
      const path = url.startsWith(BASE_URL) ? url.slice(BASE_URL.length) : url;
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "POST" && path === "/rest/api/3/issue/search") {
        fetchCount++;
        return new Response(JSON.stringify({ issues, total: 1 }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      throw new Error(`fake fetch: unexpected ${method} ${path}`);
    };
    const store = new JiraTaskStore(CONFIG, fakeFetch, "user@example.com", "token");
    const tasks = await store.query({});
    expect(tasks).toHaveLength(1);
    expect(fetchCount).toBe(1);
  });

  test("terminates pagination when a non-terminal page returns empty issues (race/server quirk guard)", async () => {
    const page1Issues = [
      makeJiraIssue("SHIP-1", "Task 1", "To Do", { id: "JTS-PAG-4", title: "Task 1", status: "pending" }),
    ];
    let fetchCount = 0;
    const fakeFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input.toString();
      const path = url.startsWith(BASE_URL) ? url.slice(BASE_URL.length) : url;
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "POST" && path === "/rest/api/3/issue/search") {
        fetchCount++;
        const body = JSON.parse(init?.body as string) as { startAt: number };
        // Page 1 returns 1 issue; page 2 returns empty (simulating race/deletion mid-fetch)
        // total=5 ensures the normal terminal guard wouldn't fire on page 2
        const issues = body.startAt === 0 ? page1Issues : [];
        return new Response(JSON.stringify({ issues, total: 5 }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      throw new Error(`fake fetch: unexpected ${method} ${path}`);
    };
    const store = new JiraTaskStore(CONFIG, fakeFetch, "user@example.com", "token");
    const tasks = await store.query({});
    // Should return the first page's tasks and break out of the loop instead of spinning
    expect(tasks).toHaveLength(1);
    expect(tasks[0].id).toBe("JTS-PAG-4");
    expect(fetchCount).toBe(2);
  });
});

describe("JiraTaskStore.append", () => {
  test("creates new issue for a new task", async () => {
    const capturedRequests: Array<{ path: string; body: unknown }> = [];
    const fakeFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input.toString();
      const path = url.startsWith(BASE_URL) ? url.slice(BASE_URL.length) : url;
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "POST" && path === "/rest/api/3/issue/search") {
        return new Response(JSON.stringify({ issues: [], total: 0 }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (method === "POST" && path === "/rest/api/3/issue") {
        capturedRequests.push({ path, body: JSON.parse(init?.body as string) });
        return new Response(JSON.stringify({ key: "SHIP-1", id: "10001" }), { status: 201, headers: { "Content-Type": "application/json" } });
      }
      throw new Error(`fake fetch: unexpected ${method} ${path}`);
    };
    const store = new JiraTaskStore(CONFIG, fakeFetch, "user@example.com", "token");
    const result = await store.append([{ id: "JTS-10.1", title: "New task", status: "pending", description: "Do the thing", session: "test-session" }]);
    expect(result.inserted).toBe(1);
    expect(result.updated).toBe(0);
    expect(capturedRequests).toHaveLength(1);
    const fields = (capturedRequests[0].body as Record<string, { summary: string; labels: string[] }>).fields;
    expect(fields.summary).toContain("JTS-10.1");
    expect(fields.labels).toContain("shipwright-session");
  });

  test("does not create a duplicate issue for an existing task (upserts instead)", async () => {
    const existingIssue = makeJiraIssue("SHIP-1", "JTS-11.1: Existing task", "To Do", { id: "JTS-11.1", title: "Existing task", status: "pending" });
    let createCount = 0;
    let putCount = 0;
    const fakeFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input.toString();
      const path = url.startsWith(BASE_URL) ? url.slice(BASE_URL.length) : url;
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "POST" && path === "/rest/api/3/issue/search") return new Response(JSON.stringify({ issues: [existingIssue], total: 1 }), { status: 200, headers: { "Content-Type": "application/json" } });
      if (method === "PUT" && path === "/rest/api/3/issue/SHIP-1") { putCount++; return new Response("{}", { status: 204 }); }
      if (method === "POST" && path === "/rest/api/3/issue") { createCount++; return new Response(JSON.stringify({ key: "SHIP-2" }), { status: 201, headers: { "Content-Type": "application/json" } }); }
      throw new Error(`fake fetch: unexpected ${method} ${path}`);
    };
    const store = new JiraTaskStore(CONFIG, fakeFetch, "user@example.com", "token");
    const result = await store.append([{ id: "JTS-11.1", title: "Existing task", status: "pending" }]);
    // No new issue is created
    expect(createCount).toBe(0);
    // The existing issue is updated via PUT
    expect(putCount).toBe(1);
    expect(result.inserted).toBe(0);
    expect(result.updated).toBe(1);
  });

  test("issue description contains shipwright fenced block with task metadata", async () => {
    let capturedDescription: unknown = null;
    const fakeFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input.toString();
      const path = url.startsWith(BASE_URL) ? url.slice(BASE_URL.length) : url;
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "POST" && path === "/rest/api/3/issue/search") return new Response(JSON.stringify({ issues: [], total: 0 }), { status: 200, headers: { "Content-Type": "application/json" } });
      if (method === "POST" && path === "/rest/api/3/issue") {
        const body = JSON.parse(init?.body as string) as { fields: { description: unknown } };
        capturedDescription = body.fields.description;
        return new Response(JSON.stringify({ key: "SHIP-1" }), { status: 201, headers: { "Content-Type": "application/json" } });
      }
      throw new Error(`fake fetch: unexpected ${method} ${path}`);
    };
    const store = new JiraTaskStore(CONFIG, fakeFetch, "user@example.com", "token");
    await store.append([{ id: "JTS-12.1", title: "Task with AC", status: "pending", description: "My description", acceptanceCriteria: ["AC one"] }]);
    expect(capturedDescription).toBeDefined();
    const descStr = JSON.stringify(capturedDescription);
    expect(descStr).toContain("shipwright");
    expect(descStr).toContain("JTS-12.1");
  });

  test("upserts existing task: PUTs updated description and increments updated count", async () => {
    const existingIssue = makeJiraIssue("SHIP-1", "JTS-APP-U.1: Existing task", "To Do", { id: "JTS-APP-U.1", title: "Existing task", status: "pending", note: "old note" });
    let putBody: unknown = null;
    let createCount = 0;
    const fakeFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input.toString();
      const path = url.startsWith(BASE_URL) ? url.slice(BASE_URL.length) : url;
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "POST" && path === "/rest/api/3/issue/search") return new Response(JSON.stringify({ issues: [existingIssue], total: 1 }), { status: 200, headers: { "Content-Type": "application/json" } });
      if (method === "PUT" && path === "/rest/api/3/issue/SHIP-1") { putBody = JSON.parse(init?.body as string); return new Response("{}", { status: 204 }); }
      if (method === "POST" && path === "/rest/api/3/issue") { createCount++; return new Response(JSON.stringify({ key: "SHIP-2" }), { status: 201, headers: { "Content-Type": "application/json" } }); }
      throw new Error(`fake fetch: unexpected ${method} ${path}`);
    };
    const store = new JiraTaskStore(CONFIG, fakeFetch, "user@example.com", "token");
    const result = await store.append([{ id: "JTS-APP-U.1", title: "Existing task", status: "pending", note: "updated note", branch: "feat/my-branch" }]);
    expect(result.inserted).toBe(0);
    expect(result.updated).toBe(1);
    expect(createCount).toBe(0);
    expect(putBody).toBeDefined();
    // Updated fields should appear in the body
    const bodyStr = JSON.stringify(putBody);
    expect(bodyStr).toContain("updated note");
    expect(bodyStr).toContain("feat/my-branch");
  });

  test("upsert does not perform a status transition during append", async () => {
    const existingIssue = makeJiraIssue("SHIP-1", "JTS-APP-U.2: Task", "To Do", { id: "JTS-APP-U.2", title: "Task", status: "pending" });
    const transitionCalls: unknown[] = [];
    const fakeFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input.toString();
      const path = url.startsWith(BASE_URL) ? url.slice(BASE_URL.length) : url;
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "POST" && path === "/rest/api/3/issue/search") return new Response(JSON.stringify({ issues: [existingIssue], total: 1 }), { status: 200, headers: { "Content-Type": "application/json" } });
      if (method === "PUT" && path === "/rest/api/3/issue/SHIP-1") return new Response("{}", { status: 204 });
      if (method === "POST" && path.endsWith("/transitions")) { transitionCalls.push(JSON.parse(init?.body as string)); return new Response("{}", { status: 204 }); }
      throw new Error(`fake fetch: unexpected ${method} ${path}`);
    };
    const store = new JiraTaskStore(CONFIG, fakeFetch, "user@example.com", "token");
    // Even if the incoming task has a different status, append should NOT transition
    await store.append([{ id: "JTS-APP-U.2", title: "Task", status: "in_progress", branch: "feat/wip" }]);
    expect(transitionCalls).toHaveLength(0);
  });
});

describe("JiraTaskStore.update", () => {
  test("throws if task not found", async () => {
    const fakeFetch = makeFakeFetch({ "POST /rest/api/3/issue/search": { status: 200, body: { issues: [], total: 0 } } });
    const store = new JiraTaskStore(CONFIG, fakeFetch, "user@example.com", "token");
    await expect(store.update("NOPE", { status: "in_progress" })).rejects.toThrow("task not found: NOPE");
  });

  test("updates non-status fields in issue body", async () => {
    const issue = makeJiraIssue("SHIP-1", "JTS-13.1: Task", "To Do", { id: "JTS-13.1", title: "Task", status: "pending" });
    let putBody: unknown = null;
    const fakeFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input.toString();
      const path = url.startsWith(BASE_URL) ? url.slice(BASE_URL.length) : url;
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "POST" && path === "/rest/api/3/issue/search") return new Response(JSON.stringify({ issues: [issue], total: 1 }), { status: 200, headers: { "Content-Type": "application/json" } });
      if (method === "PUT" && path === "/rest/api/3/issue/SHIP-1") { putBody = JSON.parse(init?.body as string); return new Response("{}", { status: 204 }); }
      throw new Error(`fake fetch: unexpected ${method} ${path}`);
    };
    const store = new JiraTaskStore(CONFIG, fakeFetch, "user@example.com", "token");
    const updated = await store.update("JTS-13.1", { note: "some note" });
    expect(updated.note).toBe("some note");
    expect(updated.status).toBe("pending");
    expect(putBody).toBeDefined();
  });

  test("performs status transition when status field is updated", async () => {
    const issue = makeJiraIssue("SHIP-1", "JTS-14.1: Task", "To Do", { id: "JTS-14.1", title: "Task", status: "pending" });
    const transitionCalls: unknown[] = [];
    const fakeFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input.toString();
      const path = url.startsWith(BASE_URL) ? url.slice(BASE_URL.length) : url;
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "POST" && path === "/rest/api/3/issue/search") return new Response(JSON.stringify({ issues: [issue], total: 1 }), { status: 200, headers: { "Content-Type": "application/json" } });
      if (method === "GET" && path === "/rest/api/3/issue/SHIP-1/transitions") return new Response(JSON.stringify(makeTransitions([{ id: "11", name: "To Do" }, { id: "21", name: "In Progress" }, { id: "31", name: "Done" }])), { status: 200, headers: { "Content-Type": "application/json" } });
      if (method === "POST" && path === "/rest/api/3/issue/SHIP-1/transitions") { transitionCalls.push(JSON.parse(init?.body as string)); return new Response("{}", { status: 204 }); }
      if (method === "PUT" && path === "/rest/api/3/issue/SHIP-1") return new Response("{}", { status: 204 });
      throw new Error(`fake fetch: unexpected ${method} ${path}`);
    };
    const store = new JiraTaskStore(CONFIG, fakeFetch, "user@example.com", "token");
    const updated = await store.update("JTS-14.1", { status: "in_progress" });
    expect(updated.status).toBe("in_progress");
    expect(transitionCalls).toHaveLength(1);
    expect((transitionCalls[0] as { transition: { id: string } }).transition.id).toBe("21");
  });

  test("adds a comment with PR URL when pr field is set", async () => {
    const issue = makeJiraIssue("SHIP-1", "JTS-15.1: Task", "To Do", { id: "JTS-15.1", title: "Task", status: "pending" });
    const commentBodies: unknown[] = [];
    const fakeFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input.toString();
      const path = url.startsWith(BASE_URL) ? url.slice(BASE_URL.length) : url;
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "POST" && path === "/rest/api/3/issue/search") return new Response(JSON.stringify({ issues: [issue], total: 1 }), { status: 200, headers: { "Content-Type": "application/json" } });
      if (method === "GET" && path === "/rest/api/3/issue/SHIP-1/transitions") return new Response(JSON.stringify(makeTransitions([{ id: "21", name: "In Progress" }])), { status: 200, headers: { "Content-Type": "application/json" } });
      if (method === "POST" && path === "/rest/api/3/issue/SHIP-1/transitions") return new Response("{}", { status: 204 });
      if (method === "PUT" && path === "/rest/api/3/issue/SHIP-1") return new Response("{}", { status: 204 });
      if (method === "POST" && path === "/rest/api/3/issue/SHIP-1/comment") { commentBodies.push(JSON.parse(init?.body as string)); return new Response(JSON.stringify({ id: "10001" }), { status: 201, headers: { "Content-Type": "application/json" } }); }
      throw new Error(`fake fetch: unexpected ${method} ${path}`);
    };
    const store = new JiraTaskStore(CONFIG, fakeFetch, "user@example.com", "token");
    await store.update("JTS-15.1", { status: "in_progress", pr: 99, prUrl: "https://github.com/org/repo/pull/99" });
    expect(commentBodies).toHaveLength(1);
    expect(JSON.stringify(commentBodies[0])).toContain("https://github.com/org/repo/pull/99");
  });

  test("PUTs description body even when only status changes (body block stays in sync)", async () => {
    const issue = makeJiraIssue("SHIP-1", "JTS-STATUS-BODY.1: Task", "To Do", { id: "JTS-STATUS-BODY.1", title: "Task", status: "pending" });
    let putCount = 0;
    let putBody: unknown = null;
    const fakeFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input.toString();
      const path = url.startsWith(BASE_URL) ? url.slice(BASE_URL.length) : url;
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "POST" && path === "/rest/api/3/issue/search") return new Response(JSON.stringify({ issues: [issue], total: 1 }), { status: 200, headers: { "Content-Type": "application/json" } });
      if (method === "GET" && path === "/rest/api/3/issue/SHIP-1/transitions") return new Response(JSON.stringify(makeTransitions([{ id: "21", name: "In Progress" }])), { status: 200, headers: { "Content-Type": "application/json" } });
      if (method === "POST" && path === "/rest/api/3/issue/SHIP-1/transitions") return new Response("{}", { status: 204 });
      if (method === "PUT" && path === "/rest/api/3/issue/SHIP-1") { putCount++; putBody = JSON.parse(init?.body as string); return new Response("{}", { status: 204 }); }
      throw new Error(`fake fetch: unexpected ${method} ${path}`);
    };
    const store = new JiraTaskStore(CONFIG, fakeFetch, "user@example.com", "token");
    // Only status is changing — no other fields
    const updated = await store.update("JTS-STATUS-BODY.1", { status: "in_progress" });
    expect(updated.status).toBe("in_progress");
    // The body must have been written so the body block reflects the new status
    expect(putCount).toBe(1);
    expect(putBody).toBeDefined();
    const bodyStr = JSON.stringify(putBody);
    expect(bodyStr).toContain("in_progress");
  });

  test("does NOT add a comment when pr field is not set", async () => {
    const issue = makeJiraIssue("SHIP-1", "JTS-16.1: Task", "To Do", { id: "JTS-16.1", title: "Task", status: "pending" });
    const commentPaths: string[] = [];
    const fakeFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input.toString();
      const path = url.startsWith(BASE_URL) ? url.slice(BASE_URL.length) : url;
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "POST" && path === "/rest/api/3/issue/search") return new Response(JSON.stringify({ issues: [issue], total: 1 }), { status: 200, headers: { "Content-Type": "application/json" } });
      if (method === "PUT" && path === "/rest/api/3/issue/SHIP-1") return new Response("{}", { status: 204 });
      if (method === "POST" && path.endsWith("/comment")) { commentPaths.push(path); return new Response(JSON.stringify({ id: "10001" }), { status: 201, headers: { "Content-Type": "application/json" } }); }
      throw new Error(`fake fetch: unexpected ${method} ${path}`);
    };
    const store = new JiraTaskStore(CONFIG, fakeFetch, "user@example.com", "token");
    await store.update("JTS-16.1", { note: "no PR here" });
    expect(commentPaths).toHaveLength(0);
  });
});

describe("JiraTaskStore.cleanup", () => {
  test("transitions open issues with terminal Shipwright status to Done", async () => {
    const issues = [
      makeJiraIssue("SHIP-1", "Terminal issue", "To Do", { id: "JTS-17.1", title: "Terminal issue", status: "merged" }),
      makeJiraIssue("SHIP-2", "Already done", "Done", { id: "JTS-17.2", title: "Already done", status: "done" }),
      makeJiraIssue("SHIP-3", "Active issue", "In Progress", { id: "JTS-17.3", title: "Active issue", status: "in_progress" }),
    ];
    const transitionedIssues: string[] = [];
    const fakeFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input.toString();
      const path = url.startsWith(BASE_URL) ? url.slice(BASE_URL.length) : url;
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "POST" && path === "/rest/api/3/issue/search") return new Response(JSON.stringify({ issues, total: issues.length }), { status: 200, headers: { "Content-Type": "application/json" } });
      const transMatch = /^GET \/rest\/api\/3\/issue\/([^/]+)\/transitions$/.exec(`${method} ${path}`);
      if (transMatch) return new Response(JSON.stringify(makeTransitions([{ id: "31", name: "Done" }])), { status: 200, headers: { "Content-Type": "application/json" } });
      const postTransMatch = /^POST \/rest\/api\/3\/issue\/([^/]+)\/transitions$/.exec(`${method} ${path}`);
      if (postTransMatch) { transitionedIssues.push(postTransMatch[1]); return new Response("{}", { status: 204 }); }
      throw new Error(`fake fetch: unexpected ${method} ${path}`);
    };
    const store = new JiraTaskStore(CONFIG, fakeFetch, "user@example.com", "token");
    const result = await store.cleanup();
    expect(transitionedIssues).toContain("SHIP-1");
    expect(transitionedIssues).not.toContain("SHIP-2");
    expect(transitionedIssues).not.toContain("SHIP-3");
    expect(result.closed).toBe(1);
    expect(result.milestonesClosed).toBe(0);
    expect(result.plansClosed).toBe(0);
  });

  test("returns zeros when no terminal issues need transitioning", async () => {
    const issues = [makeJiraIssue("SHIP-1", "Active", "In Progress", { id: "JTS-18.1", title: "Active", status: "in_progress" })];
    const fakeFetch = makeFakeFetch({ "POST /rest/api/3/issue/search": { status: 200, body: { issues, total: 1 } } });
    const store = new JiraTaskStore(CONFIG, fakeFetch, "user@example.com", "token");
    const result = await store.cleanup();
    expect(result.closed).toBe(0);
    expect(result.milestonesClosed).toBe(0);
    expect(result.plansClosed).toBe(0);
  });
});

describe("JiraTaskStore auth header", () => {
  test("sends Authorization: Basic header with base64-encoded credentials", async () => {
    const capturedHeaders: Record<string, string>[] = [];
    const fakeFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input.toString();
      const path = url.startsWith(BASE_URL) ? url.slice(BASE_URL.length) : url;
      const method = (init?.method ?? "GET").toUpperCase();
      if (init?.headers) capturedHeaders.push(Object.fromEntries(Object.entries(init.headers as Record<string, string>)));
      if (method === "POST" && path === "/rest/api/3/issue/search") return new Response(JSON.stringify({ issues: [], total: 0 }), { status: 200, headers: { "Content-Type": "application/json" } });
      throw new Error(`fake fetch: unexpected ${method} ${path}`);
    };
    const store = new JiraTaskStore(CONFIG, fakeFetch, "user@example.com", "my-token");
    await store.query({});
    expect(capturedHeaders.length).toBeGreaterThan(0);
    const authHeader = capturedHeaders[0].Authorization ?? capturedHeaders[0].authorization;
    expect(authHeader).toBeDefined();
    expect(authHeader).toMatch(/^Basic /);
    const decoded = Buffer.from(authHeader.replace("Basic ", ""), "base64").toString("utf-8");
    expect(decoded).toBe("user@example.com:my-token");
  });
});

describe("JiraTaskStore custom statusMap", () => {
  test("merges custom statusMap over defaults", async () => {
    const configWithCustomMap: TaskStoreConfig = {
      taskStore: "jira",
      jira: { baseUrl: BASE_URL, projectKey: PROJECT_KEY, statusMap: { "Custom Status": "in_progress", Done: "merged" } },
    };
    const issues = [
      makeJiraIssue("SHIP-1", "t1", "Custom Status", { id: "JTS-19.1", title: "t1", status: "pending" }),
      makeJiraIssue("SHIP-2", "t2", "Done", { id: "JTS-19.2", title: "t2", status: "done" }),
    ];
    const fakeFetch = makeFakeFetch({ "POST /rest/api/3/issue/search": { status: 200, body: { issues, total: 2 } } });
    const store = new JiraTaskStore(configWithCustomMap, fakeFetch, "user@example.com", "token");
    const tasks = await store.query({});
    expect(tasks.find((t) => t.id === "JTS-19.1")?.status).toBe("in_progress");
    expect(tasks.find((t) => t.id === "JTS-19.2")?.status).toBe("merged");
  });
});

describe("JiraTaskStore default statusMap — full coverage", () => {
  const ALL_MAP_ENTRIES: Array<[string, string]> = [
    ["Backlog", "pending"],
    ["Open", "pending"],
    ["PR Open", "pr_open"],
    ["Closed", "done"],
    ["Resolved", "done"],
    ["On Hold", "blocked"],
    ["Won't Do", "cancelled"],
    ["Cancelled", "cancelled"],
  ];

  for (const [jiraStatus, expected] of ALL_MAP_ENTRIES) {
    test(`maps "${jiraStatus}" to "${expected}"`, async () => {
      const issues = [
        makeJiraIssue("SHIP-1", "t1", jiraStatus, { id: `JTS-MAP-${jiraStatus.replace(/\W/g, "")}`, title: "t1", status: "pending" }),
      ];
      const fakeFetch = makeFakeFetch({ "POST /rest/api/3/issue/search": { status: 200, body: { issues, total: 1 } } });
      const store = new JiraTaskStore(CONFIG, fakeFetch, "user@example.com", "token");
      const tasks = await store.query({});
      expect(tasks[0].status).toBe(expected);
    });
  }
});

describe("JiraTaskStore fetch error propagation", () => {
  const throwingFetch: FetchFn = async () => {
    throw new TypeError("Network error");
  };

  test("query() propagates fetch errors", async () => {
    const store = new JiraTaskStore(CONFIG, throwingFetch, "user@example.com", "token");
    await expect(store.query({})).rejects.toThrow("Network error");
  });

  test("append() propagates fetch errors", async () => {
    const store = new JiraTaskStore(CONFIG, throwingFetch, "user@example.com", "token");
    await expect(store.append([{ id: "JTS-ERR.1", title: "task", status: "pending" }])).rejects.toThrow("Network error");
  });

  test("update() propagates fetch errors", async () => {
    const store = new JiraTaskStore(CONFIG, throwingFetch, "user@example.com", "token");
    await expect(store.update("JTS-ERR.1", { status: "in_progress" })).rejects.toThrow("Network error");
  });
});
