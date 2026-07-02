/**
 * chat/src/app.ts
 * Compose the chat service Hono app from injected services.
 *
 * The factory accepts service interfaces (not concrete classes) so tests can
 * inject in-memory fakes without a real database. Production wiring in main.ts
 * passes the real implementations backed by PrismaClient.
 *
 * Mount order:
 *   GET /health                     — unauthenticated liveness probe
 *   * /*                            — bearer auth middleware (everything else)
 *   * /tokens/*                     — token create/list/revoke/update (admin only)
 *   * /threads/*                    — thread CRUD
 *   * /threads/:threadId/messages/* — message CRUD + queue API
 *
 * Thrown ApiError subclasses are mapped to HTTP responses by the onError hook.
 */

import { Hono } from "hono";
import { type ChatAuthEnv, createBearerAuthMiddleware } from "./auth.ts";
import { ApiError } from "./errors.ts";
import type { MessageServiceLike } from "./message-service.ts";
import { createMessagesRoutes } from "./routes/messages.ts";
import { createThreadsRoutes } from "./routes/threads.ts";
import { createTokensRoutes } from "./routes/tokens.ts";
import type { ThreadServiceLike } from "./thread-service.ts";
import type { ChatTokenServiceLike } from "./token-service.ts";

export interface ChatServiceDeps {
  tokenService: ChatTokenServiceLike;
  threadService: ThreadServiceLike;
  messageService: MessageServiceLike;
  /** Optional scope resolver for agent tokens — returns repos from agents service. */
  scopeResolver?: (agentId: string) => Promise<string[]>;
}

export function createChatServiceApp(
  deps: ChatServiceDeps,
): Hono<ChatAuthEnv> {
  const app = new Hono<ChatAuthEnv>();

  // Map typed errors to responses; everything else is a 500.
  app.onError((err, c) => {
    if (err instanceof ApiError) {
      return c.json({ error: err.message }, err.statusCode as 400);
    }
    console.error("[chat] unhandled error:", err);
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: message }, 500);
  });

  // Health check — no auth.
  app.get("/health", (c) =>
    c.json({ status: "ok", service: "chat" }, 200),
  );

  // Everything below requires a valid bearer token.
  app.use(
    "*",
    createBearerAuthMiddleware({
      tokenService: deps.tokenService,
      scopeResolver: deps.scopeResolver,
    }),
  );

  app.route("/tokens", createTokensRoutes(deps.tokenService));
  app.route("/threads", createThreadsRoutes(deps.threadService));
  app.route(
    "/threads/:threadId/messages",
    createMessagesRoutes(deps.threadService, deps.messageService),
  );

  return app;
}
