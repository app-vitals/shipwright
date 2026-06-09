/** Dev-only POST /chat transport, gated by devChat:true in ComposedAppDeps. */

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
