/**
 * admin/src/admin-ui-session-follow.smoke.test.ts
 * Smoke tests for POST /admin/sessions/:slug/{follow,unfollow} (SESH-6.2).
 *
 * Uses app.request() against a minimal Hono<AdminUIEnv> instance with
 * registerSessionFollowRoutes() applied directly — no real server, no real
 * DB, mirroring admin-ui-sessions.smoke.test.ts's own isolation shape.
 * sessionFollowService/agentMemberService/agentService/fetchTaskStoreSession
 * are all injected as plain in-memory object doubles (per the "no
 * mock.module()" isolation rule). session-scope.ts's visibleAgentIdsFor/
 * isSessionVisible are the real, already-unit-tested pure functions — not
 * doubled — so these tests exercise the real visibility contract end to end
 * through the route layer.
 */

import { describe, expect, it, spyOn } from "bun:test";
import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import {
  type SessionFollowRoutesDeps,
  registerSessionFollowRoutes,
} from "./admin-ui-session-follow.ts";
import type { AdminUIEnv } from "./admin-ui.ts";
import type { AgentMemberService } from "./agent-members.ts";
import type { AgentService } from "./agents.ts";
import type {
  SessionFollowRow,
  SessionFollowService,
} from "./session-follow-service.ts";
import type { SessionForVisibility } from "./session-scope.ts";

// ─── Test doubles ─────────────────────────────────────────────────────────────

const DEFAULT_EMAIL = "dave@example.com";

function makeFakeRequireAuth(): MiddlewareHandler<AdminUIEnv> {
  return async (c, next) => {
    c.set("userEmail", c.req.header("x-test-user-email") ?? DEFAULT_EMAIL);
    c.set("isAdmin", c.req.header("x-test-is-admin") !== "false");
    await next();
  };
}

interface FakeSessionFollowService
  extends Pick<SessionFollowService, "follow" | "unfollow"> {
  followCalls: Array<{ userEmail: string; sessionSlug: string }>;
  unfollowCalls: Array<{ userEmail: string; sessionSlug: string }>;
}

function makeFakeSessionFollowService(): FakeSessionFollowService {
  const followCalls: Array<{ userEmail: string; sessionSlug: string }> = [];
  const unfollowCalls: Array<{ userEmail: string; sessionSlug: string }> = [];
  return {
    followCalls,
    unfollowCalls,
    async follow(userEmail: string, sessionSlug: string) {
      followCalls.push({ userEmail, sessionSlug });
      const row: SessionFollowRow = {
        id: `follow-${sessionSlug}`,
        userEmail,
        sessionSlug,
        muted: false,
        createdAt: new Date("2024-01-01"),
        updatedAt: new Date("2024-01-01"),
      };
      return row;
    },
    async unfollow(userEmail: string, sessionSlug: string) {
      unfollowCalls.push({ userEmail, sessionSlug });
    },
  };
}

function makeFakeAgentMemberService(
  membershipsByEmail: Record<string, Array<{ agentId: string }>>,
): Pick<AgentMemberService, "listByEmail"> {
  return {
    async listByEmail(email: string) {
      return (membershipsByEmail[email] ?? []) as Awaited<
        ReturnType<AgentMemberService["listByEmail"]>
      >;
    },
  };
}

function makeFakeAgentService(
  reposByAgentId: Record<string, string[]>,
): Pick<AgentService, "listByIds"> {
  return {
    async listByIds(ids: string[]) {
      return ids.map(
        (id) =>
          ({
            id,
            repos: reposByAgentId[id] ?? [],
          }) as Awaited<ReturnType<AgentService["listByIds"]>>[number],
      );
    },
  };
}

function buildApp(
  overrides: {
    isAdmin?: boolean;
    sessionFollowService?: FakeSessionFollowService;
    agentMemberService?: Pick<AgentMemberService, "listByEmail">;
    agentService?: Pick<AgentService, "listByIds">;
    fetchTaskStoreSession?: (
      slug: string,
    ) => Promise<SessionForVisibility | null>;
  } = {},
): { app: Hono<AdminUIEnv>; sessionFollowService: FakeSessionFollowService } {
  const sessionFollowService =
    overrides.sessionFollowService ?? makeFakeSessionFollowService();
  const deps: SessionFollowRoutesDeps = {
    requireAuth: makeFakeRequireAuth(),
    sessionFollowService,
    agentMemberService:
      overrides.agentMemberService ?? makeFakeAgentMemberService({}),
    agentService: overrides.agentService ?? makeFakeAgentService({}),
    fetchTaskStoreSession: overrides.fetchTaskStoreSession,
  };
  const app = new Hono<AdminUIEnv>();
  registerSessionFollowRoutes(app, deps);
  return { app, sessionFollowService };
}

async function req(
  app: Hono<AdminUIEnv>,
  path: string,
  opts: { isAdmin?: boolean; email?: string } = {},
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (opts.isAdmin === false) headers["x-test-is-admin"] = "false";
  if (opts.email) headers["x-test-user-email"] = opts.email;
  return await app.request(path, { method: "POST", headers });
}

// ─── POST /admin/sessions/:slug/follow ─────────────────────────────────────

describe("POST /admin/sessions/:slug/follow", () => {
  it("admin-follow: an admin follows without any session-visibility lookup", async () => {
    // No fetchTaskStoreSession configured at all — proves admins skip the
    // session lookup entirely.
    const { app, sessionFollowService } = buildApp({ isAdmin: true });

    const res = await req(app, "/admin/sessions/some-slug/follow", {
      isAdmin: true,
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ sessionSlug: "some-slug", following: true });
    expect(sessionFollowService.followCalls).toEqual([
      { userEmail: DEFAULT_EMAIL, sessionSlug: "some-slug" },
    ]);
  });

  it("member-follow-visible: a member follows a session their membership makes visible", async () => {
    const { app, sessionFollowService } = buildApp({
      agentMemberService: makeFakeAgentMemberService({
        [DEFAULT_EMAIL]: [{ agentId: "agent-1" }],
      }),
      agentService: makeFakeAgentService({ "agent-1": [] }),
      fetchTaskStoreSession: async (slug: string) => {
        expect(slug).toBe("visible-slug");
        return { agentIds: ["agent-1"], repos: [] };
      },
    });

    const res = await req(app, "/admin/sessions/visible-slug/follow", {
      isAdmin: false,
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ sessionSlug: "visible-slug", following: true });
    expect(sessionFollowService.followCalls).toEqual([
      { userEmail: DEFAULT_EMAIL, sessionSlug: "visible-slug" },
    ]);
  });

  it("member-follow-invisible-404: a member following an invisible session gets 404 and no row is written", async () => {
    const { app, sessionFollowService } = buildApp({
      agentMemberService: makeFakeAgentMemberService({
        [DEFAULT_EMAIL]: [{ agentId: "agent-1" }],
      }),
      agentService: makeFakeAgentService({ "agent-1": ["some/repo"] }),
      fetchTaskStoreSession: async () => ({
        agentIds: ["agent-other"],
        repos: ["other/repo"],
      }),
    });

    const res = await req(app, "/admin/sessions/invisible-slug/follow", {
      isAdmin: false,
    });

    expect(res.status).toBe(404);
    expect(sessionFollowService.followCalls).toEqual([]);
  });

  it("member-follow-invisible-404: a nonexistent session (fetchTaskStoreSession → null) gets 404", async () => {
    const { app, sessionFollowService } = buildApp({
      agentMemberService: makeFakeAgentMemberService({
        [DEFAULT_EMAIL]: [{ agentId: "agent-1" }],
      }),
      agentService: makeFakeAgentService({ "agent-1": [] }),
      fetchTaskStoreSession: async () => null,
    });

    const res = await req(app, "/admin/sessions/nonexistent-slug/follow", {
      isAdmin: false,
    });

    expect(res.status).toBe(404);
    expect(sessionFollowService.followCalls).toEqual([]);
  });

  it("member-follow-invisible-404: no fetchTaskStoreSession configured — member fails closed with 404", async () => {
    const { app, sessionFollowService } = buildApp({
      agentMemberService: makeFakeAgentMemberService({
        [DEFAULT_EMAIL]: [{ agentId: "agent-1" }],
      }),
      agentService: makeFakeAgentService({ "agent-1": [] }),
      // fetchTaskStoreSession intentionally absent.
    });

    const res = await req(app, "/admin/sessions/any-slug/follow", {
      isAdmin: false,
    });

    expect(res.status).toBe(404);
    expect(sessionFollowService.followCalls).toEqual([]);
  });

  it("member-follow-invisible-404: fetchTaskStoreSession throwing is treated as invisible, and is logged", async () => {
    const consoleErrorSpy = spyOn(console, "error").mockImplementation(
      () => {},
    );
    try {
      const { app, sessionFollowService } = buildApp({
        agentMemberService: makeFakeAgentMemberService({
          [DEFAULT_EMAIL]: [{ agentId: "agent-1" }],
        }),
        agentService: makeFakeAgentService({ "agent-1": [] }),
        fetchTaskStoreSession: async () => {
          throw new Error("task-store unreachable");
        },
      });

      const res = await req(app, "/admin/sessions/boom-slug/follow", {
        isAdmin: false,
      });

      expect(res.status).toBe(404);
      expect(sessionFollowService.followCalls).toEqual([]);

      // Fail-closed must not be silent — a task-store outage needs an
      // operational signal, not an indistinguishable 404.
      expect(consoleErrorSpy).toHaveBeenCalled();
      const loggedArgs = consoleErrorSpy.mock.calls.flat().join(" ");
      expect(loggedArgs).toContain("fetchTaskStoreSession failed");
      expect(loggedArgs).toContain("task-store unreachable");
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });

  it("member-follow-visible: visibility via repos intersection (not just agentIds)", async () => {
    const { app, sessionFollowService } = buildApp({
      agentMemberService: makeFakeAgentMemberService({
        [DEFAULT_EMAIL]: [{ agentId: "agent-1" }],
      }),
      agentService: makeFakeAgentService({ "agent-1": ["org/repo"] }),
      fetchTaskStoreSession: async () => ({
        agentIds: ["agent-other"],
        repos: ["org/repo"],
      }),
    });

    const res = await req(app, "/admin/sessions/repo-visible-slug/follow", {
      isAdmin: false,
    });

    expect(res.status).toBe(200);
    expect(sessionFollowService.followCalls).toEqual([
      { userEmail: DEFAULT_EMAIL, sessionSlug: "repo-visible-slug" },
    ]);
  });
});

// ─── POST /admin/sessions/:slug/unfollow ───────────────────────────────────

describe("POST /admin/sessions/:slug/unfollow", () => {
  it("unfollow-clears-alert-state (admin): unfollow succeeds with no visibility check and no fetchTaskStoreSession needed", async () => {
    const { app, sessionFollowService } = buildApp({ isAdmin: true });

    const res = await req(app, "/admin/sessions/some-slug/unfollow", {
      isAdmin: true,
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ sessionSlug: "some-slug", following: false });
    expect(sessionFollowService.unfollowCalls).toEqual([
      { userEmail: DEFAULT_EMAIL, sessionSlug: "some-slug" },
    ]);
  });

  it("unfollow-clears-alert-state (member): a member can unfollow any slug for themselves, no visibility gate", async () => {
    const { app, sessionFollowService } = buildApp({ isAdmin: false });

    const res = await req(app, "/admin/sessions/member-slug/unfollow", {
      isAdmin: false,
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ sessionSlug: "member-slug", following: false });
    expect(sessionFollowService.unfollowCalls).toEqual([
      { userEmail: DEFAULT_EMAIL, sessionSlug: "member-slug" },
    ]);
  });
});
