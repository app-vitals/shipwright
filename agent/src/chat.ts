/**
 * agent/src/chat.ts
 *
 * Dev-only local chat transport.
 *
 * Exports:
 *   ChatRunner            — the runner type (matches the createRunClaude seam)
 *   createChatApp         — Hono sub-app with POST /chat
 *   checkDevChatProductionGuard — doctor/CI predicate
 *
 * Mount point: root /chat (mounted via run-agent.ts when devChat:true).
 * Session continuity: client passes back the sessionId returned on the first
 * call as the `session` field on subsequent calls. The value is used directly
 * as the sessionKey passed to the runner, which manages Claude session IDs
 * internally via its injected session store.
 */

import { Hono } from "hono";

// ─── Types ─────────────────────────────────────────────────────────────────

export type ChatRunner = (
  message: string,
  sessionKey: string,
) => Promise<{ result: string; sessionId?: string }>;

interface ChatAppDeps {
  runner: ChatRunner;
}

// ─── App factory ────────────────────────────────────────────────────────────

/**
 * Creates a Hono app with a single POST /chat route.
 *
 * Request body:  { message: string; session?: string }
 * Response body: { result: string; sessionId: string }
 *
 * The `session` field in the request is the token the client received from a
 * prior call. On the first call, omit it — a new UUID is generated. Pass the
 * returned `sessionId` back as `session` on subsequent calls to continue the
 * same Claude session.
 */
export function createChatApp({ runner }: ChatAppDeps): Hono {
  const app = new Hono();

  app.post("/chat", async (c) => {
    let body: { message?: unknown; session?: unknown };
    try {
      body = (await c.req.json()) as { message?: unknown; session?: unknown };
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const message = body.message;
    if (typeof message !== "string" || message.length === 0) {
      return c.json({ error: "message is required" }, 400);
    }

    // If client supplied a session token, reuse it as the sessionKey.
    // Otherwise, generate a new UUID — this becomes the continuity handle.
    const sessionKey =
      typeof body.session === "string" && body.session.length > 0
        ? body.session
        : crypto.randomUUID();

    const output = await runner(message, sessionKey);

    return c.json({
      result: output.result,
      sessionId: sessionKey,
    });
  });

  return app;
}

// ─── Doctor guard ────────────────────────────────────────────────────────────

/**
 * Validate that SHIPWRIGHT_DEV_CHAT is not enabled in a production config.
 *
 * "Production" is detected by NODE_ENV==="production" OR
 * SHIPWRIGHT_ENV==="production".
 *
 * Returns { ok: true } when safe, { ok: false, reason: string } otherwise.
 */
export function checkDevChatProductionGuard(
  env: Record<string, string | undefined>,
): { ok: boolean; reason?: string } {
  const devChatEnabled = env.SHIPWRIGHT_DEV_CHAT === "true";
  const isProduction =
    env.NODE_ENV === "production" || env.SHIPWRIGHT_ENV === "production";

  if (devChatEnabled && isProduction) {
    return {
      ok: false,
      reason:
        "SHIPWRIGHT_DEV_CHAT=true is set in a production config. " +
        "The /chat endpoint is dev-only and must not be enabled in production. " +
        "Unset SHIPWRIGHT_DEV_CHAT or set it to 'false'.",
    };
  }

  return { ok: true };
}
