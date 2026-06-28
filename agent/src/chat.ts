/**
 * agent/src/chat.ts
 *
 * Dev-only local chat transport for the Shipwright agent.
 *
 * Exposes POST /chat — a thin transport over the same Claude runner seam used
 * for Slack DMs. It maps a caller-supplied opaque `session` key to a stable
 * internal sessionKey (mirroring the threadKey pattern in sessions.ts), and the
 * runner persists/resumes the underlying Claude sessionId behind that key so
 * successive calls with the same `session` resume the same conversation.
 *
 * This endpoint is gated OFF by default (see run-agent.ts `devChat`) and must
 * never be enabled in production (see chat-guard.ts). It returns raw markdown —
 * no Slack marker dispatch, no new "brain".
 */

import { Hono } from "hono";
import { ClaudeRunError, ClaudeTimeoutError } from "./claude.ts";
import type { TokenUsage } from "./claude.ts";

/**
 * The Claude runner seam — exactly what createRunClaude(...) returns.
 */
export type ChatRunner = (
  message: string,
  sessionKey?: string,
) => Promise<{ result: string; sessionId?: string; usage?: TokenUsage }>;

export interface ChatAppDeps {
  runner: ChatRunner;
}

/** Namespace the opaque caller session into the runner's sessionKey space. */
function chatSessionKey(session: string): string {
  return `chat:${session}`;
}

/**
 * Create the dev chat Hono sub-app.
 *
 * POST /chat  body: { message: string, session?: string }
 *   → 200 { result, sessionId }   on success
 *   → 400 { error }               when message is missing/empty
 */
export function createChatApp(deps: ChatAppDeps): Hono {
  const { runner } = deps;

  // In-memory map: opaque session key → resolved internal sessionKey.
  // Mirrors the get/set semantics of the file session store but stays in
  // process — the runner itself persists the Claude sessionId behind the key.
  const sessions = new Map<string, string>();

  const app = new Hono();

  app.post("/chat", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }

    const record = (body ?? {}) as Record<string, unknown>;
    const message = record.message;
    if (typeof message !== "string" || message.trim() === "") {
      return c.json({ error: "missing or empty 'message'" }, 400);
    }

    const session =
      typeof record.session === "string" && record.session !== ""
        ? record.session
        : undefined;

    // Resolve the runner sessionKey: reuse the prior one for continuity, or
    // derive a fresh one from the opaque session key on first use.
    let sessionKey: string | undefined;
    if (session) {
      sessionKey = sessions.get(session) ?? chatSessionKey(session);
      sessions.set(session, sessionKey);
    }

    // The runner spawns the Claude CLI, which can fail for reasons the caller
    // needs to see (usage limit, auth, timeout). Without this catch any throw
    // becomes a bare Hono 500 with an empty body — the REPL then shows only
    // "non-2xx response: 500" and the real cause is buried in container logs.
    let output: Awaited<ReturnType<typeof runner>>;
    try {
      output = await runner(message, sessionKey);
    } catch (err) {
      if (err instanceof ClaudeRunError) {
        // Surface the upstream message (e.g. "You've hit your Sonnet limit").
        // Pass a 429 through verbatim; map other CLI failures to 502 (the
        // agent's upstream dependency failed, not the request itself).
        return c.json(
          { error: err.resultMessage },
          err.apiErrorStatus === 429 ? 429 : 502,
        );
      }
      if (err instanceof ClaudeTimeoutError) {
        return c.json({ error: err.message }, 504);
      }
      return c.json(
        { error: err instanceof Error ? err.message : String(err) },
        500,
      );
    }

    return c.json({ result: output.result, sessionId: output.sessionId });
  });

  return app;
}
