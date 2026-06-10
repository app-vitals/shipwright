/**
 * lib/session-middleware.ts
 * Shared Hono middleware factory for session cookie verification.
 *
 * Usage:
 *   app.use('*', createSessionMiddleware(process.env.SHIPWRIGHT_SESSION_SECRET ?? ''))
 *
 * On success: sets c.get('session') with { userId, email, name } and calls next().
 * On Bearer token present: calls next() without setting session (API calls bypass
 *   session auth — the JSON API layer handles authentication via its own middleware).
 * On missing/invalid session: redirects to /auth/login?returnTo=<encoded-path>.
 * On missing secret: returns 500 Internal Server Error (not a redirect).
 *
 * The session cookie is "vitals_session" — a HS256 JWT signed with SHIPWRIGHT_SESSION_SECRET
 * containing { userId, email, name, iat, exp }.
 */

import { getCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";
import { verify } from "hono/jwt";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SessionPayload {
  userId: string;
  email: string;
  name: string;
}

// Hono context variables type — services use this to type c.get('session')
export type SessionEnv = { Variables: { session: SessionPayload } };

// ─── Factory ──────────────────────────────────────────────────────────────────

/**
 * Creates a Hono middleware that reads and verifies the vitals_session cookie.
 *
 * @param secret - The JWT signing secret (SHIPWRIGHT_SESSION_SECRET). Pass empty string to
 *                 trigger a 500 response (guards against missing env var at call site).
 */
export function createSessionMiddleware(secret: string) {
  return createMiddleware<SessionEnv>(async (c, next) => {
    // Bearer token requests are API calls — skip session auth.
    // Routes like /billing/invoices and /cal/overview serve both a browser web UI
    // (session-cookie auth) and a JSON API (bearer-token auth) on the same path.
    // The JSON API layer handles bearer auth via its own middleware.
    if (c.req.header("Authorization")?.startsWith("Bearer ")) {
      return next();
    }

    // Missing secret is a server misconfiguration — return 500, not a login redirect
    if (!secret) {
      console.error("[session-middleware] SHIPWRIGHT_SESSION_SECRET is not set");
      return c.text("Internal Server Error", 500);
    }

    const token = getCookie(c, "vitals_session");
    const returnTo = encodeURIComponent(c.req.path);
    const loginRedirect = `/auth/login?returnTo=${returnTo}`;

    // Missing or empty cookie → redirect to login
    if (!token) {
      return c.redirect(loginRedirect, 302);
    }

    // Verify JWT — any error (expired, malformed, wrong secret) → redirect
    let payload: Record<string, unknown>;
    try {
      payload = (await verify(token, secret, "HS256")) as Record<
        string,
        unknown
      >;
    } catch (err) {
      // Log the error type at debug level — don't expose details to the client
      const errType = err instanceof Error ? err.constructor.name : "unknown";
      console.debug(`[session-middleware] JWT verify failed: ${errType}`);
      return c.redirect(loginRedirect, 302);
    }

    // Validate required fields are present — treat partial payloads as invalid
    const { userId, email, name } = payload;
    if (
      typeof userId !== "string" ||
      !userId ||
      typeof email !== "string" ||
      !email ||
      typeof name !== "string" ||
      !name
    ) {
      console.debug("[session-middleware] JWT missing required fields");
      return c.redirect(loginRedirect, 302);
    }

    c.set("session", { userId, email, name });
    await next();
  });
}
