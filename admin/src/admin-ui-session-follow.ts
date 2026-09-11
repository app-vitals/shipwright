/**
 * admin/src/admin-ui-session-follow.ts
 * POST /admin/sessions/:slug/follow and /unfollow (SESH-6.2).
 *
 * Mirrors admin-ui-sessions.ts's shape (a self-contained, injectable
 * route-registration module registered into admin-ui.ts's app), but for
 * the follow/unfollow actions rather than the settings page.
 *
 * Follow enforces session visibility for non-admin members via
 * session-scope.ts's pure visibleAgentIdsFor()/isSessionVisible() helpers —
 * admins always pass without any session lookup. Unfollow does not: removing
 * your own follow state doesn't require re-proving visibility, mirroring the
 * existing POST /admin/settings/notifications/unfollow route in
 * admin-ui-sessions.ts, which also skips the visibility check.
 */

import type { Hono, MiddlewareHandler } from "hono";
import type { AdminUIEnv } from "./admin-ui.ts";
import type { AgentMemberService } from "./agent-members.ts";
import type { AgentService } from "./agents.ts";
import type { SessionFollowService } from "./session-follow-service.ts";
import {
  type SessionForVisibility,
  isSessionVisible,
  visibleAgentIdsFor,
} from "./session-scope.ts";

export interface SessionFollowRoutesDeps {
  requireAuth: MiddlewareHandler<AdminUIEnv>;
  sessionFollowService: Pick<SessionFollowService, "follow" | "unfollow">;
  agentMemberService: Pick<AgentMemberService, "listByEmail">;
  agentService: Pick<AgentService, "listByIds">;
  /**
   * Resolve a session's agentIds/repos for visibility checks. Only consulted
   * on the member path — admins always pass. If absent, members always get
   * 404 on follow (fail-closed — cannot verify visibility without it).
   */
  fetchTaskStoreSession?: (
    slug: string,
  ) => Promise<SessionForVisibility | null>;
}

/**
 * Resolves whether the given non-admin member can see the session at `slug`.
 * Fails closed (returns false) whenever the session can't be confidently
 * resolved as visible — absent fetcher, missing session, or a lookup error.
 */
async function memberCanSeeSession(
  slug: string,
  userEmail: string,
  deps: SessionFollowRoutesDeps,
): Promise<boolean> {
  if (!deps.fetchTaskStoreSession) return false;

  let session: SessionForVisibility | null;
  try {
    session = await deps.fetchTaskStoreSession(slug);
  } catch (err) {
    // Fail closed, but leave an operational signal: without this, a task-store
    // outage degrades every member's follow into an indistinguishable 404.
    console.error("[session-follow] fetchTaskStoreSession failed:", err);
    return false;
  }
  if (!session) return false;

  const memberships = await deps.agentMemberService.listByEmail(
    userEmail.toLowerCase(),
  );
  const agentIds = visibleAgentIdsFor(false, memberships);
  const agents =
    memberships.length === 0
      ? []
      : await deps.agentService.listByIds(memberships.map((m) => m.agentId));
  const repos = agents.flatMap((agent) => agent.repos ?? []);

  return isSessionVisible(session, { agentIds, repos });
}

/**
 * Registers POST /admin/sessions/:slug/follow and /unfollow onto the given
 * app. Called from admin-ui.ts's createAdminUIApp() alongside its other
 * route-registration blocks.
 */
export function registerSessionFollowRoutes(
  app: Hono<AdminUIEnv>,
  deps: SessionFollowRoutesDeps,
): void {
  app.post("/admin/sessions/:slug/follow", deps.requireAuth, async (c) => {
    const slug = c.req.param("slug");
    const userEmail = c.var.userEmail;

    if (!c.var.isAdmin) {
      const visible = await memberCanSeeSession(slug, userEmail, deps);
      if (!visible) return new Response("Not Found", { status: 404 });
    }

    await deps.sessionFollowService.follow(userEmail, slug);
    return c.json({ sessionSlug: slug, following: true }, 200);
  });

  app.post("/admin/sessions/:slug/unfollow", deps.requireAuth, async (c) => {
    const slug = c.req.param("slug");
    const userEmail = c.var.userEmail;

    await deps.sessionFollowService.unfollow(userEmail, slug);
    return c.json({ sessionSlug: slug, following: false }, 200);
  });
}
