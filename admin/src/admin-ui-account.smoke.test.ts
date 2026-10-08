/**
 * admin/src/admin-ui-account.smoke.test.ts
 * Smoke tests for /admin/account routes (SSP-3.2). In-memory service doubles.
 */

import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import {
  type AccountRouteDeps,
  registerAccountRoutes,
} from "./admin-ui-account.ts";
import type { AdminUIEnv } from "./admin-ui.ts";
import {
  AccountMemberNotFoundError,
  LastOwnerError,
} from "./account-members.ts";

const d = new Date("2026-01-01T00:00:00Z");

function setup(
  opts: { enabled?: boolean; seedMembers?: Array<[string, string]> } = {},
) {
  const account = {
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
  let members = (
    opts.seedMembers ?? [
      ["owner@x.com", "owner"],
      ["member@x.com", "member"],
    ]
  ).map(([email, role], i) => ({
    id: `m${i}`,
    accountId: "a1",
    email,
    role,
    createdAt: d,
  }));
  let invites: Array<{
    id: string;
    accountId: string;
    email: string;
    invitedBy: string;
    acceptedAt: null;
    createdAt: Date;
  }> = [];
  const ownersLeft = () => members.filter((m) => m.role === "owner").length;

  const deps: AccountRouteDeps = {
    enabled: opts.enabled ?? true,
    requireAuth: (async (c, next) => {
      c.set("userEmail", c.req.header("x-test-user-email") ?? "owner@x.com");
      c.set("isAdmin", false);
      await next();
    }) as MiddlewareHandler<AdminUIEnv>,
    html: (content, o) =>
      new Response(content, {
        status: o?.status ?? 200,
        headers: { "Content-Type": "text/html" },
      }),
    accounts: {
      async getByMemberEmail(email) {
        return members.some((m) => m.email === email.toLowerCase())
          ? (account as never)
          : null;
      },
      async update(_id, data) {
        Object.assign(account, data);
        return account as never;
      },
      async countAgents() {
        return 1;
      },
    },
    members: {
      async listByAccount() {
        return members as never;
      },
      async getByEmail(email) {
        return (members.find((m) => m.email === email) ?? null) as never;
      },
      async remove(_a, email) {
        const m = members.find((x) => x.email === email);
        if (!m) throw new AccountMemberNotFoundError("a1", email);
        if (m.role === "owner" && ownersLeft() <= 1)
          throw new LastOwnerError("a1");
        members = members.filter((x) => x !== m);
      },
      async promote(_a, email) {
        const m = members.find((x) => x.email === email);
        if (!m) throw new AccountMemberNotFoundError("a1", email);
        m.role = "owner";
        return m as never;
      },
      async demote(_a, email) {
        const m = members.find((x) => x.email === email);
        if (!m) throw new AccountMemberNotFoundError("a1", email);
        if (m.role === "owner" && ownersLeft() <= 1)
          throw new LastOwnerError("a1");
        m.role = "member";
        return m as never;
      },
    },
    invites: {
      async create(_a, rawEmail, by) {
        const email = rawEmail.trim().toLowerCase();
        const inv = {
          id: `i${invites.length}`,
          accountId: "a1",
          email,
          invitedBy: by,
          acceptedAt: null,
          createdAt: d,
        };
        invites = [...invites.filter((i) => i.email !== email), inv];
        return inv as never;
      },
      async listPending() {
        return invites as never;
      },
      async revoke(_a, email) {
        invites = invites.filter((i) => i.email !== email);
      },
    },
  };
  const app = new Hono<AdminUIEnv>();
  registerAccountRoutes(app, deps);
  return { app, getMembers: () => members, getAccount: () => account };
}

function post(
  app: Hono<AdminUIEnv>,
  path: string,
  fields: Record<string, string>,
  email?: string,
) {
  return app.request(path, {
    method: "POST",
    body: new URLSearchParams(fields).toString(),
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      ...(email ? { "x-test-user-email": email } : {}),
    },
  });
}

describe("/admin/account", () => {
  it("returns 404 for every route when the flag is off", async () => {
    const { app } = setup({ enabled: false });
    expect((await app.request("/admin/account")).status).toBe(404);
    expect(
      (await post(app, "/admin/account/invite", { email: "a@b.co" })).status,
    ).toBe(404);
  });

  it("returns 404 for a signed-in user without an account", async () => {
    const { app } = setup();
    const res = await app.request("/admin/account", {
      headers: { "x-test-user-email": "stranger@x.com" },
    });
    expect(res.status).toBe(404);
  });

  it("GET renders the account for a member", async () => {
    const { app } = setup();
    const res = await app.request("/admin/account", {
      headers: { "x-test-user-email": "member@x.com" },
    });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("Acme");
    expect(body).toContain("1 / 2");
  });

  it("owner can invite, see it pending, and revoke it", async () => {
    const { app } = setup();
    const res = await post(app, "/admin/account/invite", {
      email: "New@X.com",
    });
    expect(res.status).toBe(302);
    const page = await (await app.request("/admin/account")).text();
    expect(page).toContain("new@x.com");
    const rev = await post(app, "/admin/account/invites/revoke", {
      email: "new@x.com",
    });
    expect(rev.status).toBe(302);
    expect(await (await app.request("/admin/account")).text()).not.toContain(
      "new@x.com",
    );
  });

  it("rejects an invalid or already-member invite email with 400", async () => {
    const { app } = setup();
    expect(
      (await post(app, "/admin/account/invite", { email: "nope" })).status,
    ).toBe(400);
    expect(
      (await post(app, "/admin/account/invite", { email: "member@x.com" }))
        .status,
    ).toBe(400);
  });

  it("member gets 403 on every mutation", async () => {
    const { app } = setup();
    for (const [path, fields] of [
      ["/admin/account/invite", { email: "a@b.co" }],
      ["/admin/account/invites/revoke", { email: "a@b.co" }],
      ["/admin/account/members/remove", { email: "owner@x.com" }],
      ["/admin/account/members/promote", { email: "member@x.com" }],
      ["/admin/account/members/demote", { email: "owner@x.com" }],
      ["/admin/account/rename", { name: "X" }],
    ] as const) {
      const res = await post(app, path, { ...fields }, "member@x.com");
      expect(res.status).toBe(403);
    }
  });

  it("removing or demoting the last owner shows an error and changes nothing", async () => {
    const { app, getMembers } = setup();
    const rm = await post(app, "/admin/account/members/remove", {
      email: "owner@x.com",
    });
    expect(rm.status).toBe(400);
    expect(await rm.text()).toContain("last owner");
    const dm = await post(app, "/admin/account/members/demote", {
      email: "owner@x.com",
    });
    expect(dm.status).toBe(400);
    expect(getMembers().find((m) => m.email === "owner@x.com")?.role).toBe(
      "owner",
    );
    expect(getMembers()).toHaveLength(2);
  });

  it("owner can promote then remove a member", async () => {
    const { app, getMembers } = setup();
    expect(
      (
        await post(app, "/admin/account/members/promote", {
          email: "member@x.com",
        })
      ).status,
    ).toBe(302);
    expect(getMembers().find((m) => m.email === "member@x.com")?.role).toBe(
      "owner",
    );
    expect(
      (
        await post(app, "/admin/account/members/remove", {
          email: "member@x.com",
        })
      ).status,
    ).toBe(302);
    expect(getMembers()).toHaveLength(1);
  });

  it("removing an unknown member returns 404", async () => {
    const { app } = setup();
    expect(
      (
        await post(app, "/admin/account/members/remove", {
          email: "ghost@x.com",
        })
      ).status,
    ).toBe(404);
  });

  it("owner can rename; empty name is 400", async () => {
    const { app, getAccount } = setup();
    expect(
      (await post(app, "/admin/account/rename", { name: " New Name " })).status,
    ).toBe(302);
    expect(getAccount().name).toBe("New Name");
    expect(
      (await post(app, "/admin/account/rename", { name: "  " })).status,
    ).toBe(400);
  });
});
