/**
 * admin/src/admin-ui-accounts.smoke.test.ts
 * Smoke tests for /admin/accounts routes (SSP-5.2): admin vs non-admin on
 * every route, flag-off 404, persisted edits. In-memory service doubles.
 */

import { describe, expect, it } from "bun:test";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import {
  AccountMemberNotFoundError,
  LastOwnerError,
} from "./account-members.ts";
import type { AdminUIEnv } from "./admin-ui.ts";
import {
  type AdminAccountsRouteDeps,
  registerAdminAccountsRoutes,
} from "./admin-ui-accounts.ts";

const d = new Date("2026-01-01T00:00:00Z");

function setup(opts: { enabled?: boolean } = {}) {
  const account: Record<string, unknown> = {
    id: "a1",
    name: "Acme",
    status: "active",
    maxAgents: 2,
    plan: null,
    trialExpiresAt: null,
    trialExpiryWarnedAt: null,
    createdAt: d,
    updatedAt: d,
  };
  let members = [
    {
      id: "m1",
      accountId: "a1",
      email: "owner@x.com",
      role: "owner",
      createdAt: d,
    },
    {
      id: "m2",
      accountId: "a1",
      email: "member@x.com",
      role: "member",
      createdAt: d,
    },
  ];
  const agentAccounts: Record<string, string | null> = {
    g1: "a1",
    free: null,
  };
  const reconciled: Array<{
    id: string;
    slug?: string;
    accountId?: string | null;
  }> = [];
  const withCounts = () =>
    ({ ...account, agentCount: 1, memberCount: members.length }) as never;
  const owners = () => members.filter((m) => m.role === "owner").length;

  const deps: AdminAccountsRouteDeps = {
    enabled: opts.enabled ?? true,
    requireAuth: (async (c, next) => {
      c.set("userEmail", "admin@x.com");
      c.set("isAdmin", c.req.header("x-test-admin") === "1");
      await next();
    }) as MiddlewareHandler<AdminUIEnv>,
    html: (content, o) =>
      new Response(content, {
        status: o?.status ?? 200,
        headers: { "Content-Type": "text/html" },
      }),
    accounts: {
      async listWithCounts() {
        return [withCounts()];
      },
      async getWithCounts(id) {
        return id === "a1" ? withCounts() : null;
      },
      async update(_id, data) {
        Object.assign(account, data);
        return account as never;
      },
      async listAgents() {
        return [{ id: "g1", name: "Bot" }];
      },
    },
    members: {
      async listByAccount() {
        return members;
      },
      async getByEmail(email) {
        return members.find((m) => m.email === email) ?? null;
      },
      async add(_id, email, role = "member") {
        const m = {
          id: `m${members.length + 1}`,
          accountId: "a1",
          email,
          role,
          createdAt: d,
        };
        members.push(m);
        return m as never;
      },
      async remove(_id, email) {
        const m = members.find((x) => x.email === email);
        if (!m) throw new AccountMemberNotFoundError("a1", email);
        if (m.role === "owner" && owners() <= 1) throw new LastOwnerError("a1");
        members = members.filter((x) => x !== m);
      },
      async promote(_id, email) {
        const m = members.find((x) => x.email === email);
        if (!m) throw new AccountMemberNotFoundError("a1", email);
        m.role = "owner";
        return m as never;
      },
      async demote(_id, email) {
        const m = members.find((x) => x.email === email);
        if (!m) throw new AccountMemberNotFoundError("a1", email);
        if (m.role === "owner" && owners() <= 1) throw new LastOwnerError("a1");
        m.role = "member";
        return m as never;
      },
    },
    invites: {
      async listPending() {
        return [];
      },
    },
    agents: {
      async getDetail(id) {
        return id in agentAccounts
          ? ({
              id,
              name: id,
              selfHosted: false,
              accountId: agentAccounts[id],
            } as never)
          : null;
      },
      async updateFields(id, input) {
        agentAccounts[id] = input.accountId ?? null;
        return {
          id,
          name: id,
          selfHosted: false,
          accountId: agentAccounts[id],
        } as never;
      },
    },
    provisioner: {
      async reconcile(agents) {
        reconciled.push(...agents);
        return { recreated: [], orphans: [], failed: [], updated: [] };
      },
    },
  };
  const app = new Hono<AdminUIEnv>();
  registerAdminAccountsRoutes(app, deps);
  return { app, account, members: () => members, agentAccounts, reconciled };
}

const ADMIN = { "x-test-admin": "1" };
function post(
  app: Hono<AdminUIEnv>,
  path: string,
  fields: Record<string, string>,
  admin = true,
) {
  return app.request(path, {
    method: "POST",
    headers: admin ? ADMIN : {},
    body: new URLSearchParams(fields),
  });
}

describe("/admin/accounts agent assignment (SSP-5.3)", () => {
  it("assigns an agent, then reconciles it with the new accountId", async () => {
    const { app, agentAccounts, reconciled } = setup();
    const res = await post(app, "/admin/accounts/a1/agents/assign", {
      agentId: "free",
    });
    expect(res.status).toBe(302);
    expect(agentAccounts.free).toBe("a1");
    expect(reconciled).toEqual([{ id: "free", slug: "free", accountId: "a1" }]);
  });

  it("rejects an unknown agent without changing anything", async () => {
    const { app, reconciled } = setup();
    const res = await post(app, "/admin/accounts/a1/agents/assign", {
      agentId: "nope",
    });
    expect(res.status).toBe(400);
    expect(reconciled).toEqual([]);
  });

  it("unassigns an agent and reconciles with a null accountId", async () => {
    const { app, agentAccounts, reconciled } = setup();
    const res = await post(app, "/admin/accounts/a1/agents/unassign", {
      agentId: "g1",
    });
    expect(res.status).toBe(302);
    expect(agentAccounts.g1).toBeNull();
    expect(reconciled).toEqual([{ id: "g1", slug: "g1", accountId: null }]);
  });

  it("refuses to unassign an agent owned by another account", async () => {
    const { app, agentAccounts } = setup();
    const res = await post(app, "/admin/accounts/a1/agents/unassign", {
      agentId: "free",
    });
    expect(res.status).toBe(400);
    expect(agentAccounts.free).toBeNull();
  });
});

describe("/admin/accounts", () => {
  it("lists accounts for admin", async () => {
    const { app } = setup();
    const res = await app.request("/admin/accounts", { headers: ADMIN });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("Acme");
    expect(body).toContain("owner@x.com");
  });

  it("403 for non-admin on every route", async () => {
    const { app } = setup();
    expect((await app.request("/admin/accounts")).status).toBe(403);
    expect((await app.request("/admin/accounts/a1")).status).toBe(403);
    for (const p of [
      "update",
      "suspend",
      "reactivate",
      "members/add",
      "members/remove",
      "members/promote",
      "members/demote",
      "agents/assign",
      "agents/unassign",
    ]) {
      const res = await post(
        app,
        `/admin/accounts/a1/${p}`,
        { email: "x@y.com" },
        false,
      );
      expect(res.status).toBe(403);
    }
  });

  it("404 everywhere when flag is off, even for admin", async () => {
    const { app } = setup({ enabled: false });
    expect(
      (await app.request("/admin/accounts", { headers: ADMIN })).status,
    ).toBe(404);
    expect(
      (await app.request("/admin/accounts/a1", { headers: ADMIN })).status,
    ).toBe(404);
    expect((await post(app, "/admin/accounts/a1/suspend", {})).status).toBe(
      404,
    );
  });

  it("detail 404 for unknown account", async () => {
    const { app } = setup();
    expect(
      (await app.request("/admin/accounts/nope", { headers: ADMIN })).status,
    ).toBe(404);
    expect((await post(app, "/admin/accounts/nope/suspend", {})).status).toBe(
      404,
    );
  });

  it("detail page shows agents and members", async () => {
    const { app } = setup();
    const body = await (
      await app.request("/admin/accounts/a1", { headers: ADMIN })
    ).text();
    expect(body).toContain("Bot");
    expect(body).toContain("member@x.com");
  });

  it("update persists maxAgents, plan and trialExpiresAt", async () => {
    const { app, account } = setup();
    const res = await post(app, "/admin/accounts/a1/update", {
      name: "Acme 2",
      maxAgents: "7",
      plan: "pro",
      trialExpiresAt: "2026-03-05",
    });
    expect(res.status).toBe(302);
    expect(account.name).toBe("Acme 2");
    expect(account.maxAgents).toBe(7);
    expect(account.plan).toBe("pro");
    expect((account.trialExpiresAt as Date).toISOString().slice(0, 10)).toBe(
      "2026-03-05",
    );
    await post(app, "/admin/accounts/a1/update", {
      name: "Acme 2",
      maxAgents: "7",
      plan: "",
      trialExpiresAt: "",
    });
    expect(account.trialExpiresAt).toBeNull();
    expect(account.plan).toBeNull();
  });

  it("update rejects invalid maxAgents / date / name with 400", async () => {
    const { app, account } = setup();
    const cases: Array<Record<string, string>> = [
      { name: "A", maxAgents: "-1" },
      { name: "A", maxAgents: "1.5" },
      { name: "A", maxAgents: "" },
      { name: "A", maxAgents: "1", trialExpiresAt: "garbage" },
      { name: "", maxAgents: "1" },
    ];
    for (const f of cases) {
      expect((await post(app, "/admin/accounts/a1/update", f)).status).toBe(
        400,
      );
    }
    expect(account.maxAgents).toBe(2);
  });

  it("suspend and reactivate set status", async () => {
    const { app, account } = setup();
    expect((await post(app, "/admin/accounts/a1/suspend", {})).status).toBe(
      302,
    );
    expect(account.status).toBe("suspended");
    expect((await post(app, "/admin/accounts/a1/reactivate", {})).status).toBe(
      302,
    );
    expect(account.status).toBe("active");
  });

  it("adds member and owner; rejects invalid and duplicate emails", async () => {
    const { app, members } = setup();
    expect(
      (
        await post(app, "/admin/accounts/a1/members/add", {
          email: "New@X.com",
          role: "owner",
        })
      ).status,
    ).toBe(302);
    expect(members().find((m) => m.email === "new@x.com")?.role).toBe("owner");
    expect(
      (await post(app, "/admin/accounts/a1/members/add", { email: "bad" }))
        .status,
    ).toBe(400);
    expect(
      (
        await post(app, "/admin/accounts/a1/members/add", {
          email: "member@x.com",
        })
      ).status,
    ).toBe(400);
  });

  it("promote, demote, remove; last-owner guard returns 400", async () => {
    const { app, members } = setup();
    await post(app, "/admin/accounts/a1/members/promote", {
      email: "member@x.com",
    });
    expect(members().find((m) => m.email === "member@x.com")?.role).toBe(
      "owner",
    );
    await post(app, "/admin/accounts/a1/members/remove", {
      email: "member@x.com",
    });
    expect(members().length).toBe(1);
    const res = await post(app, "/admin/accounts/a1/members/remove", {
      email: "owner@x.com",
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("last owner");
    expect(
      (
        await post(app, "/admin/accounts/a1/members/demote", {
          email: "ghost@x.com",
        })
      ).status,
    ).toBe(404);
  });
});
