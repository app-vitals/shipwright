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
 * Who may act (SSP-6.8): a platform admin, on any account's session (a
 * `?accountId=` query addresses a non-default account's same-slug row); an
 * account user (self-serve flag on), on their own account's sessions only —
 * the patch is pinned to their account, so another account's slug is a 404.
 * Everyone else gets 403, exactly as before. Purge/delete is explicitly out
 * of scope (see SESH-5.2's task description) — this module offers no delete
 * action anywhere.
 */

import type { Context, Hono, MiddlewareHandler } from "hono";
import type { AdminUIEnv } from "./admin-ui.ts";
import {
  type CallerScopeResolver,
  taskStoreViewScope,
} from "./caller-scope.ts";

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
    accountId?: string,
  ) => Promise<unknown>;
  /**
   * Account-aware caller-scope resolver (SSP-2.1). Absent → only platform
   * admins may act (the pre-SSP-6.8 behavior).
   */
  callerScopeResolver?: CallerScopeResolver;
}

/** Whose session a request may act on: an account, every account, or none. */
type ActionScope =
  | { allowed: false }
  | { allowed: true; accountId: string | undefined; pinned: boolean };

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

function sessionDetailPath(slug: string, accountId?: string): string {
  const base = `/admin/sessions/${encodeURIComponent(slug)}`;
  return accountId
    ? `${base}?accountId=${encodeURIComponent(accountId)}`
    : base;
}

/** Appends a `?success=`/`?error=` flash to a detail path. */
function withFlash(path: string, flash: string): string {
  return `${path}${path.includes("?") ? "&" : "?"}${flash}`;
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
    accountId: string | undefined,
  ): Promise<"ok" | "not_found" | "failed"> {
    if (!deps.patchTaskStoreSession) return "failed";
    try {
      const updated = await deps.patchTaskStoreSession(slug, patch, accountId);
      return updated === null ? "not_found" : "ok";
    } catch (err) {
      console.error(
        `[session-admin-actions] patchTaskStoreSession failed for "${slug}":`,
        err,
      );
      return "failed";
    }
  }

  async function resolveActionScope(
    c: Context<AdminUIEnv>,
  ): Promise<ActionScope> {
    if (c.var.isAdmin) {
      return {
        allowed: true,
        accountId: c.req.query("accountId") || undefined,
        pinned: false,
      };
    }
    if (!deps.callerScopeResolver) return { allowed: false };
    const view = taskStoreViewScope(
      await deps.callerScopeResolver(c.var.userEmail, false),
    );
    return view.kind === "account"
      ? { allowed: true, accountId: view.accountId, pinned: true }
      : { allowed: false };
  }

  /** Shared body of all three routes: gate, patch, redirect with a flash. */
  async function act(
    c: Context<AdminUIEnv>,
    patch: { title?: string | null; archived?: boolean },
    success: string,
    failure: string,
  ): Promise<Response> {
    const scope = await resolveActionScope(c);
    if (!scope.allowed) return new Response("Forbidden", { status: 403 });
    const slug = c.req.param("slug") ?? "";
    const outcome = await applyPatch(slug, patch, scope.accountId);
    // For an account user, "not in my account" is a 404 — never a hint that
    // the slug exists in another account.
    if (outcome === "not_found" && scope.pinned) {
      return new Response("Not Found", { status: 404 });
    }
    const path = sessionDetailPath(
      slug,
      scope.pinned ? undefined : scope.accountId,
    );
    return c.redirect(
      withFlash(
        path,
        outcome === "ok" ? `success=${success}` : `error=${failure}`,
      ),
      302,
    );
  }

  app.post("/admin/sessions/:slug/archive", deps.requireAuth, (c) =>
    act(c, { archived: true }, "archived", "archive_failed"),
  );

  app.post("/admin/sessions/:slug/unarchive", deps.requireAuth, (c) =>
    act(c, { archived: false }, "unarchived", "unarchive_failed"),
  );

  app.post("/admin/sessions/:slug/rename", deps.requireAuth, async (c) => {
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

    return act(c, { title: newTitle }, "renamed", "rename_failed");
  });
}
