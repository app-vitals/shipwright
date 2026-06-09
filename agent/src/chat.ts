/**
 * agent/src/chat.ts
 *
 * Dev-only local chat transport.
 *
 * Exports:
 *   createChatApp({ runner }) — Hono app with POST /chat
 *   checkDevChatGuard(env)    — doctor guard: fails if SHIPWRIGHT_DEV_CHAT is set
 *
 * The /chat endpoint is only mounted when devChat: true is passed to
 * createComposedApp in run-agent.ts. Default is off (gated).
 *
 * Session model:
 *   - Request body: { message: string, session?: string }
 *   - Response body: { result: string, sessionId: string }
 *   - `session` in the request is the chat-level session key (a UUID).
 *     If absent, a fresh UUID is generated.
 *   - The in-memory Map<sessionKey, claudeSessionId> stores the Claude internal
 *     session ID for continuation — never exposed in the response.
 *   - The `sessionId` in the response is always the chat-level session key
 *     (the UUID), which the caller passes back on the next request.
 */

import { randomUUID } from "node:crypto";
import { Hono } from "hono";

// ─── Types ────────────────────────────────────────────────────────────────────

export type Runner = (
  message: string,
  sessionKey?: string,
) => Promise<{ result: string; sessionId?: string; usage?: unknown }>;

export interface ChatAppDeps {
  runner: Runner;
}

// ─── Guard ────────────────────────────────────────────────────────────────────

/**
 * Doctor guard — fails if SHIPWRIGHT_DEV_CHAT is set in the environment.
 *
 * This is a production config guard: the dev chat endpoint must never be
 * accidentally enabled in a production deployment. Any non-empty value for
 * SHIPWRIGHT_DEV_CHAT is treated as a failure.
 */
export function checkDevChatGuard(
  env: Record<string, string | undefined>,
): { ok: boolean; reason?: string } {
  const val = env.SHIPWRIGHT_DEV_CHAT;
  if (val !== undefined && val !== "") {
    return {
      ok: false,
      reason: `SHIPWRIGHT_DEV_CHAT is set to "${val}" — dev chat endpoint must not be enabled in production. Unset SHIPWRIGHT_DEV_CHAT before deploying.`,
    };
  }
  return { ok: true };
}

// ─── Chat app factory ─────────────────────────────────────────────────────────

/**
 * Create the dev chat Hono sub-app.
 *
 * In-memory Map tracks chat sessionKey → Claude internal sessionId.
 * This Map lives for the lifetime of the app instance.
 */
export function createChatApp(deps: ChatAppDeps): Hono {
  const { runner } = deps;

  // chat sessionKey (UUID) → Claude internal session ID
  const claudeSessions = new Map<string, string>();

  const app = new Hono();

  app.post("/chat", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }

    if (
      typeof body !== "object" ||
      body === null ||
      typeof (body as Record<string, unknown>).message !== "string"
    ) {
      return c.json({ error: "missing required field: message" }, 400);
    }

    const { message, session } = body as { message: string; session?: string };

    // Use provided session key or generate a fresh one
    const sessionKey =
      typeof session === "string" && session.length > 0 ? session : randomUUID();

    // Call runner with the chat-level session key
    const output = await runner(message, sessionKey);

    // Store the Claude internal session ID for future continuation
    if (output.sessionId) {
      claudeSessions.set(sessionKey, output.sessionId);
    }

    // Return result + chat-level session key (NOT the Claude internal session ID)
    return c.json({ result: output.result, sessionId: sessionKey });
  });

  return app;
}
