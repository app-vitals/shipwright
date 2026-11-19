/**
 * task-store/src/tasks.provenance.smoke.test.ts
 *
 * PLU-2.5 route contracts: POST /tasks, POST /tasks/bulk and PATCH /tasks/:id
 * validate owner / planDocumentId / specDocumentId / originKind / originRef,
 * and GET /tasks threads the owner and originKind filters to the service
 * (an unknown originKind is a 400).
 */

import { describe, expect, it } from "bun:test";
import { createTaskStoreApp } from "./app.ts";
import type { Task } from "./index.ts";
import type { SessionServiceLike } from "./session-service.ts";
import type { TaskListFilters, TaskServiceLike } from "./task-service.ts";
import type { TokenServiceLike } from "./token-service.ts";

const TOKEN = "valid-token";

const tokenService: TokenServiceLike = {
  async create() {
    throw new Error("unused");
  },
  async validate(raw: string) {
    return raw === TOKEN ? { id: "tok-1", agentId: null } : null;
  },
  async revoke() {
    return null;
  },
  async list() {
    return [];
  },
  async update() {
    return null;
  },
};

const sessionService = {} as SessionServiceLike;

function makeApp(captured: {
  filters: TaskListFilters[];
  created: unknown[];
  bulk: unknown[];
  updated: unknown[];
}) {
  const taskService = {
    async list(filters?: TaskListFilters) {
      if (filters) captured.filters.push({ ...filters });
      return { tasks: [], total: 0, limit: 50 };
    },
    async create(data: unknown) {
      captured.created.push(data);
      return { id: "created-1", ...(data as object) } as unknown as Task;
    },
    async bulk(tasks: unknown[]) {
      captured.bulk.push(...tasks);
      return { inserted: tasks.length, updated: 0, skipped: [] };
    },
    async get(id: string) {
      return { id, assignee: null, claimedBy: null, repo: null, blockedBy: [] };
    },
    async update(id: string, data: unknown) {
      captured.updated.push(data);
      return { id, ...(data as object) };
    },
  } as unknown as TaskServiceLike;
  return createTaskStoreApp({ taskService, tokenService, sessionService });
}

function fresh() {
  return { filters: [], created: [], bulk: [], updated: [] } as {
    filters: TaskListFilters[];
    created: unknown[];
    bulk: unknown[];
    updated: unknown[];
  };
}

function send(
  app: ReturnType<typeof makeApp>,
  path: string,
  method: string,
  payload?: unknown,
) {
  return app.request(path, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
    },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
}

const base = { title: "T", status: "pending", repo: null };
const provenance = {
  owner: "a@example.com",
  planDocumentId: "doc-1",
  specDocumentId: "doc-2",
  originKind: "skill",
  originRef: "plan-session",
};

describe("task provenance fields (smoke)", () => {
  it("POST /tasks accepts and forwards the five fields", async () => {
    const cap = fresh();
    const res = await send(makeApp(cap), "/tasks", "POST", {
      ...base,
      ...provenance,
    });
    expect(res.status).toBe(201);
    expect(cap.created[0]).toMatchObject(provenance);
    expect(await res.json()).toMatchObject(provenance);
  });

  it("POST /tasks rejects originKind bogus with 400", async () => {
    const res = await send(makeApp(fresh()), "/tasks", "POST", {
      ...base,
      originKind: "bogus",
    });
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toContain("originKind");
  });

  it("POST /tasks rejects non-string owner with 400", async () => {
    const res = await send(makeApp(fresh()), "/tasks", "POST", {
      ...base,
      owner: 5,
    });
    expect(res.status).toBe(400);
  });

  it("POST /tasks/bulk validates every item", async () => {
    const cap = fresh();
    const ok = await send(makeApp(cap), "/tasks/bulk", "POST", [
      { ...base, ...provenance },
    ]);
    expect(ok.status).toBe(200);
    expect(cap.bulk[0]).toMatchObject(provenance);
    const bad = await send(makeApp(fresh()), "/tasks/bulk", "POST", [
      base,
      { ...base, originKind: "bogus" },
    ]);
    expect(bad.status).toBe(400);
  });

  it("PATCH accepts the fields, nulls included, and rejects a bogus kind", async () => {
    const cap = fresh();
    const ok = await send(makeApp(cap), "/tasks/task-1", "PATCH", provenance);
    expect(ok.status).toBe(200);
    expect(cap.updated[0]).toMatchObject(provenance);
    const nulls = await send(makeApp(fresh()), "/tasks/task-1", "PATCH", {
      owner: null,
      originKind: null,
      originRef: null,
    });
    expect(nulls.status).toBe(200);
    const bad = await send(makeApp(fresh()), "/tasks/task-1", "PATCH", {
      originKind: "bogus",
    });
    expect(bad.status).toBe(400);
  });

  it("GET /tasks threads owner and originKind to the service", async () => {
    const cap = fresh();
    const res = await send(
      makeApp(cap),
      "/tasks?owner=a@example.com&originKind=cron",
      "GET",
    );
    expect(res.status).toBe(200);
    expect(cap.filters[0]).toMatchObject({
      owner: "a@example.com",
      originKind: "cron",
    });
  });

  it("GET /tasks?originKind=bogus is a 400", async () => {
    const res = await send(makeApp(fresh()), "/tasks?originKind=bogus", "GET");
    expect(res.status).toBe(400);
  });
});
