/**
 * admin/src/admin-ui-session-admin-actions.ts
 * POST /admin/sessions/:slug/{archive,unarchive,rename} (SESH-5.2).
 *
 * Mirrors admin-ui-session-follow.ts's shape (a self-contained, injectable
 * route-registration module registered into admin-ui.ts's app), but unlike
 * follow/unfollow's JSON responses, these three routes are form posts from
 * the session detail page header — each mutates the session via the
 * task-store's `PATCH /sessions/:slug` (SESH-3.1) and redirects back to the
 * detail page with a `?success=`/`?error=` flash-message query param, per
 * the established convention elsewhere in admin-ui.ts (e.g. the agent detail
 * page's `?success=manifest_synced`/`?error=...` handling).
 *
 * Admin-only: every route 403s outright for a non-admin caller. Purge/delete
 * is explicitly out of scope (see SESH-5.2's task description) — this module
 * offers no delete action anywhere.
 */

import type { Hono, MiddlewareHandler } from "hono";
import type { AdminUIEnv } from "./admin-ui.ts";

export interface SessionAdminActionsDeps {
  requireAuth: MiddlewareHandler<AdminUIEnv>;
  /**
   * Apply a rename/archive patch to a session via the task-store's
   * `PATCH /sessions/:slug` (SESH-3.1, admin-token only). If absent (the
   * admin service has no task-store configured) or if it throws, the route
   * redirects back to the detail page with an `?error=` flash rather than
   * throwing.
   */
  patchTaskStoreSession?: (
    slug: string,
    patch: { title?: string | null; archived?: boolean },
  ) => Promise<unknown>;
}

/**
 * Maps the `?success=`/`?error=` query-param slugs this module redirects
 * with to a human-readable banner message. Exported so admin-ui.ts's
 * GET /admin/sessions/:id route can render the same messages in the notice
 * banner without duplicating the mapping.
 */
export const SESSION_ADMIN_ACTION_MESSAGES: Record<string, string> = {
  archived: "Session archived.",
  unarchived: "Session unarchived.",
  renamed: "Session renamed.",
  archive_failed: "Failed to archive the session. Please try again.",
  unarchive_failed: "Failed to unarchive the session. Please try again.",
  rename_failed: "Failed to rename the session. Please try again.",
};

function sessionDetailPath(slug: string): string {
  return `/admin/sessions/${encodeURIComponent(slug)}`;
}

/**
 * Registers POST /admin/sessions/:slug/{archive,unarchive,rename} onto the
 * given app. Called from admin-ui.ts's createAdminUIApp() alongside its
 * other route-registration blocks.
 */
export function registerSessionAdminActionsRoutes(
  app: Hono<AdminUIEnv>,
  deps: SessionAdminActionsDeps,
): void {
  /** Applies the patch, swallowing failures into a boolean so every route
   * below can redirect with an error flash instead of throwing/crashing —
   * whether the failure is a missing dependency (task-store not configured)
   * or the fetcher itself throwing (task-store unreachable). */
  async function applyPatch(
    slug: string,
    patch: { title?: string | null; archived?: boolean },
  ): Promise<boolean> {
    if (!deps.patchTaskStoreSession) return false;
    try {
      await deps.patchTaskStoreSession(slug, patch);
      return true;
    } catch (err) {
      console.error(
        `[session-admin-actions] patchTaskStoreSession failed for "${slug}":`,
        err,
      );
      return false;
    }
  }

  app.post("/admin/sessions/:slug/archive", deps.requireAuth, async (c) => {
    if (!c.var.isAdmin) return new Response("Forbidden", { status: 403 });
    const slug = c.req.param("slug");
    const ok = await applyPatch(slug, { archived: true });
    return c.redirect(
      `${sessionDetailPath(slug)}?${ok ? "success=archived" : "error=archive_failed"}`,
      302,
    );
  });

  app.post("/admin/sessions/:slug/unarchive", deps.requireAuth, async (c) => {
    if (!c.var.isAdmin) return new Response("Forbidden", { status: 403 });
    const slug = c.req.param("slug");
    const ok = await applyPatch(slug, { archived: false });
    return c.redirect(
      `${sessionDetailPath(slug)}?${ok ? "success=unarchived" : "error=unarchive_failed"}`,
      302,
    );
  });

  app.post("/admin/sessions/:slug/rename", deps.requireAuth, async (c) => {
    if (!c.var.isAdmin) return new Response("Forbidden", { status: 403 });
    const slug = c.req.param("slug");

    // A missing/blank submitted title clears the title (title: null),
    // consistent with SessionUpdatePatch's documented null-clears-title
    // semantics (task-store/src/session-service.ts) — this is not a silent
    // no-op, it's an intentional clear.
    let newTitle: string | null = null;
    try {
      const formData = await c.req.formData();
      const raw = formData.get("newTitle")?.toString().trim();
      newTitle = raw ? raw : null;
    } catch {
      // Malformed/missing body — falls through to the clear-title default.
    }

    const ok = await applyPatch(slug, { title: newTitle });
    return c.redirect(
      `${sessionDetailPath(slug)}?${ok ? "success=renamed" : "error=rename_failed"}`,
      302,
    );
  });
}
