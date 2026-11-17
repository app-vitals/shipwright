/**
 * task-store/src/routes/documents.smoke.test.ts
 *
 * Smoke tests for the /documents routes via in-process app.request() against
 * a recording fake DocumentService (PLU-2.2). Service behaviour is covered by
 * document-service.integration.test.ts; this covers the HTTP contract.
 */

import { describe, expect, it } from "bun:test";
import { createTaskStoreApp } from "../app.ts";
import type { ScopeResolver } from "../auth.ts";
import type {
  DocumentListFilters,
  DocumentScope,
  DocumentServiceLike,
} from "../document-service.ts";
import { ForbiddenError } from "../errors.ts";
import type { SessionServiceLike } from "../session-service.ts";
import type { TaskServiceLike } from "../task-service.ts";
import type { TokenServiceLike } from "../token-service.ts";

const ADMIN = "admin-token";
const AGENT = "agent-token";

interface Calls {
  register: unknown[][];
  list: [DocumentListFilters, DocumentScope][];
  patch: unknown[][];
}

function build() {
  const calls: Calls = { register: [], list: [], patch: [] };
  const documentService: DocumentServiceLike = {
    async register(input, accountId, scope) {
      calls.register.push([input, accountId, scope]);
      if (scope.repos !== null && !scope.repos.includes(input.repo)) {
        throw new ForbiddenError("out of scope");
      }
      return { id: "d1", ...input } as never;
    },
    async list(filters, scope) {
      calls.list.push([filters, scope]);
      return { documents: [], total: 0 };
    },
    async patch(id, patch, scope) {
      calls.patch.push([id, patch, scope]);
      return { id, ...patch } as never;
    },
  };
  const tokenService = {
    async validate(raw: string) {
      if (raw === AGENT) return { id: "t2", agentId: "a1" };
      return raw === ADMIN ? { id: "t1", agentId: null } : null;
    },
  } as unknown as TokenServiceLike;
  const scopeResolver: ScopeResolver = async () => ({
    repos: ["org/home"],
    accountId: "default",
  });
  const app = createTaskStoreApp({
    taskService: {} as TaskServiceLike,
    tokenService,
    sessionService: {} as SessionServiceLike,
    documentService,
    scopeResolver,
  });
  return { app, calls };
}

const auth = (t: string) => ({
  Authorization: `Bearer ${t}`,
  "Content-Type": "application/json",
});

const BODY = {
  session: "x",
  kind: "spec",
  number: 1,
  repo: "org/home",
  path: "planning/x/SPEC-0001.md",
};

describe("/documents routes (smoke)", () => {
  it("requires auth", async () => {
    const { app } = build();
    expect((await app.request("/documents")).status).toBe(401);
  });

  it("POST registers a document", async () => {
    const { app, calls } = build();
    const res = await app.request("/documents", {
      method: "POST",
      headers: auth(ADMIN),
      body: JSON.stringify({ ...BODY, prUrl: "u", repos: ["org/a"] }),
    });
    expect(res.status).toBe(200);
    expect(calls.register).toHaveLength(1);
    expect((calls.register[0]?.[0] as { prUrl: string })?.prUrl).toBe("u");
  });

  it("POST rejects an invalid kind with 400", async () => {
    const { app } = build();
    const res = await app.request("/documents", {
      method: "POST",
      headers: auth(ADMIN),
      body: JSON.stringify({ ...BODY, kind: "nope" }),
    });
    expect(res.status).toBe(400);
  });

  it("POST with a repo outside a scoped token's scope is 403", async () => {
    const { app } = build();
    const res = await app.request("/documents", {
      method: "POST",
      headers: auth(AGENT),
      body: JSON.stringify({ ...BODY, repo: "org/elsewhere" }),
    });
    expect(res.status).toBe(403);
  });

  it("GET passes filters to the service", async () => {
    const { app, calls } = build();
    const res = await app.request(
      "/documents?session=x&kind=spec&planned=false&owner=a@x.com",
      { headers: auth(ADMIN) },
    );
    expect(res.status).toBe(200);
    expect(calls.list[0]?.[0]).toEqual({
      session: "x",
      kind: "spec",
      owner: "a@x.com",
      planned: false,
    });
  });

  it("GET with an unknown parameter is 400", async () => {
    const { app, calls } = build();
    const res = await app.request("/documents?bogus=1", {
      headers: auth(ADMIN),
    });
    expect(res.status).toBe(400);
    expect(calls.list).toHaveLength(0);
  });

  it("GET with a bad planned value is 400", async () => {
    const { app } = build();
    const res = await app.request("/documents?planned=maybe", {
      headers: auth(ADMIN),
    });
    expect(res.status).toBe(400);
  });

  it("PATCH updates a document", async () => {
    const { app, calls } = build();
    const res = await app.request("/documents/d1", {
      method: "PATCH",
      headers: auth(ADMIN),
      body: JSON.stringify({
        plannedAt: "2026-11-17T12:00:00.000Z",
        state: "merged",
      }),
    });
    expect(res.status).toBe(200);
    expect(calls.patch[0]?.[0]).toBe("d1");
    expect(calls.patch[0]?.[1]).toEqual({
      plannedAt: "2026-11-17T12:00:00.000Z",
      state: "merged",
    });
  });

  it("PATCH with an invalid plannedAt is 400", async () => {
    const { app } = build();
    const res = await app.request("/documents/d1", {
      method: "PATCH",
      headers: auth(ADMIN),
      body: JSON.stringify({ plannedAt: "yesterday" }),
    });
    expect(res.status).toBe(400);
  });
});
