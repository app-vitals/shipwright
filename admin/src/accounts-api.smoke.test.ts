/**
 * admin/src/accounts-api.smoke.test.ts
 * Smoke tests for the admin-only /accounts API (SSP-5.1). In-process
 * app.request(), in-memory AccountService double.
 */

import { describe, expect, it } from "bun:test";
import { sign } from "hono/jwt";
import type { AccountWithCounts } from "./accounts.ts";
import { createAccountsApp } from "./accounts-api.ts";
import { parseAdminApiKeys } from "./api-auth.ts";
import { UnprocessableEntityError } from "./errors.ts";

const SESSION_SECRET = "accounts-smoke-secret-32-bytes!!!";
const ADMIN_KEY = "admin-key";
const SCOPED_KEY = "scoped-key";
const AGENT_TOKEN = "agent-token";

const NOW = new Date("2026-01-01T00:00:00.000Z");

function acct(over: Partial<AccountWithCounts> = {}): AccountWithCounts {
  return {
    id: "acc1",
    name: "Acme",
    status: "active",
    maxAgents: 0,
    plan: null,
    trialExpiresAt: null,
    trialExpiryWarnedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    agentCount: 2,
    memberCount: 1,
    ...over,
  };
}

function cookie(isAdmin: boolean): Promise<string> {
  return sign(
    {
      isAdmin,
      userId: "u1",
      email: "someone@example.com",
      exp: Math.floor(Date.now() / 1000) + 3600,
    },
    SESSION_SECRET,
    "HS256",
  );
}

function build(enabled = true) {
  const calls: Array<{ fn: string; args: unknown[] }> = [];
  const store = new Map<string, AccountWithCounts>([
    ["acc1", acct()],
    ["expired1", acct({ id: "expired1", status: "trial_expired" })],
  ]);
  const app = createAccountsApp({
    selfServe: { enabled, defaultMaxAgents: 0, contactEmail: "c@x.com" },
    sessionSecret: SESSION_SECRET,
    adminApiKeys: parseAdminApiKeys(
      `admin:${ADMIN_KEY}:*,scoped:${SCOPED_KEY}:agent-1`,
    ),
    agentTokenService: {
      validate: async (t: string) =>
        t === AGENT_TOKEN ? { agentId: "agent-1" } : null,
    } as never,
    accountService: {
      listWithCounts: async () => [...store.values()],
      getWithCounts: async (id: string) => store.get(id) ?? null,
      create: async (...args: unknown[]) => {
        calls.push({ fn: "create", args });
        const [name, ownerEmail] = args as [string, string];
        if (ownerEmail === "taken@x.com") {
          throw Object.assign(new Error("unique"), { code: "P2002" });
        }
        const a = acct({ id: "new1", name, agentCount: 0, memberCount: 1 });
        store.set(a.id, a);
        return a;
      },
    },
    accountLifecycle: {
      update: async (...args: unknown[]) => {
        calls.push({ fn: "update", args });
        const [id, data] = args as [string, Partial<AccountWithCounts>];
        const cur = store.get(id);
        if (!cur) throw Object.assign(new Error("nf"), { code: "P2025" });
        if (data.status === "active" && cur.status === "trial_expired") {
          throw new UnprocessableEntityError("trial still lapsed");
        }
        const next = { ...cur, ...data };
        store.set(id, next);
        return next;
      },
    },
  });
  return { app, calls };
}

const adminHeaders = { Authorization: `Bearer ${ADMIN_KEY}` };
const json = { "Content-Type": "application/json" };

const ROUTES: Array<[string, string, unknown?]> = [
  ["GET", "/accounts", undefined],
  ["GET", "/accounts/acc1", undefined],
  ["POST", "/accounts", { name: "N", ownerEmail: "o@x.com", maxAgents: 1 }],
  ["PATCH", "/accounts/acc1", { maxAgents: 3 }],
];

function req(
  app: ReturnType<typeof build>["app"],
  method: string,
  path: string,
  headers: Record<string, string>,
  body?: unknown,
) {
  return app.request(path, {
    method,
    headers: body === undefined ? headers : { ...headers, ...json },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe("flag off", () => {
  it.each(ROUTES)("%s %s -> 404", async (method, path, body) => {
    const { app } = build(false);
    const res = await req(app, method, path, adminHeaders, body);
    expect(res.status).toBe(404);
  });
});

describe("auth classes", () => {
  it.each(ROUTES)("%s %s: no credentials -> 401", async (m, p, b) => {
    const { app } = build();
    expect((await req(app, m, p, {}, b)).status).toBe(401);
  });

  it.each(ROUTES)("%s %s: non-admin cookie -> 403", async (m, p, b) => {
    const { app } = build();
    const res = await req(
      app,
      m,
      p,
      { Cookie: `admin_session=${await cookie(false)}` },
      b,
    );
    expect(res.status).toBe(403);
  });

  it.each(ROUTES)("%s %s: scoped key -> 403", async (m, p, b) => {
    const { app } = build();
    const res = await req(
      app,
      m,
      p,
      { Authorization: `Bearer ${SCOPED_KEY}` },
      b,
    );
    expect(res.status).toBe(403);
  });

  it.each(ROUTES)("%s %s: per-agent token -> 403", async (m, p, b) => {
    const { app } = build();
    const res = await req(
      app,
      m,
      p,
      { Authorization: `Bearer ${AGENT_TOKEN}` },
      b,
    );
    expect(res.status).toBe(403);
  });

  it.each(ROUTES)("%s %s: admin cookie -> 2xx", async (m, p, b) => {
    const { app } = build();
    const res = await req(
      app,
      m,
      p,
      { Cookie: `admin_session=${await cookie(true)}` },
      b,
    );
    expect(res.status).toBeLessThan(300);
  });

  it.each(ROUTES)("%s %s: scope * key -> 2xx", async (m, p, b) => {
    const { app } = build();
    expect((await req(app, m, p, adminHeaders, b)).status).toBeLessThan(300);
  });
});

describe("behaviour", () => {
  it("GET /accounts returns counts and ISO dates", async () => {
    const { app } = build();
    const res = await req(app, "GET", "/accounts", adminHeaders);
    const body = (await res.json()) as {
      accounts: Array<Record<string, unknown>>;
    };
    expect(body.accounts[0]).toMatchObject({
      id: "acc1",
      agentCount: 2,
      memberCount: 1,
      createdAt: NOW.toISOString(),
    });
  });

  it("GET /accounts/:id 404s for unknown", async () => {
    const { app } = build();
    expect((await req(app, "GET", "/accounts/nope", adminHeaders)).status).toBe(
      404,
    );
  });

  it("POST /accounts passes through fields and returns 201", async () => {
    const { app, calls } = build();
    const res = await req(app, "POST", "/accounts", adminHeaders, {
      name: "N",
      ownerEmail: "o@x.com",
      maxAgents: 5,
      plan: "pro",
      trialExpiresAt: "2030-01-01T00:00:00.000Z",
    });
    expect(res.status).toBe(201);
    expect(calls[0]?.args[1]).toBe("o@x.com");
    expect(calls[0]?.args[2]).toMatchObject({
      maxAgents: 5,
      plan: "pro",
      trialExpiresAt: new Date("2030-01-01T00:00:00.000Z"),
    });
  });

  it("POST /accounts with an already-used owner email -> 409", async () => {
    const { app } = build();
    const res = await req(app, "POST", "/accounts", adminHeaders, {
      name: "N",
      ownerEmail: "taken@x.com",
      maxAgents: 1,
    });
    expect(res.status).toBe(409);
  });

  it("POST /accounts validation failure -> 400", async () => {
    const { app } = build();
    const res = await req(app, "POST", "/accounts", adminHeaders, {
      name: "",
      ownerEmail: "bad",
      maxAgents: -1,
    });
    expect(res.status).toBe(400);
  });

  it("PATCH raises maxAgents and converts trialExpiresAt", async () => {
    const { app, calls } = build();
    const res = await req(app, "PATCH", "/accounts/acc1", adminHeaders, {
      maxAgents: 3,
      trialExpiresAt: null,
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { maxAgents: number }).maxAgents).toBe(3);
    expect(calls[0]?.args[1]).toEqual({ maxAgents: 3, trialExpiresAt: null });
  });

  it("PATCH unknown account -> 404", async () => {
    const { app } = build();
    expect(
      (
        await req(app, "PATCH", "/accounts/nope", adminHeaders, {
          maxAgents: 1,
        })
      ).status,
    ).toBe(404);
  });

  it("PATCH routes status changes through the account lifecycle (SSP-8.2)", async () => {
    const { app, calls } = build();
    const res = await req(app, "PATCH", "/accounts/acc1", adminHeaders, {
      status: "suspended",
    });
    expect(res.status).toBe(200);
    expect(calls).toEqual([
      { fn: "update", args: ["acc1", { status: "suspended" }] },
    ]);
  });

  it("PATCH reactivation rejected by the lifecycle -> 422", async () => {
    const { app } = build();
    const res = await req(app, "PATCH", "/accounts/expired1", adminHeaders, {
      status: "active",
    });
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: "trial still lapsed" });
  });
});
