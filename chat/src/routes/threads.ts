/**
 * chat/src/routes/threads.ts
 * Thread CRUD routes.
 *
 * Routes:
 *   GET    /threads         list (scoped to agentId for agent tokens)
 *   POST   /threads         create
 *   GET    /threads/:id     get
 *   PATCH  /threads/:id     update title / memberId
 *   DELETE /threads/:id     delete
 *
 * Agent token: all operations are scoped to threads owned by that agentId.
 * Admin token: full access; can filter by ?agentId or ?memberId.
 */

import { Hono } from "hono";
import type { ChatAuthEnv } from "../auth.ts";
import { BadRequestError, ForbiddenError, NotFoundError } from "../errors.ts";
import type { ThreadServiceLike } from "../thread-service.ts";
import { parseIntParam } from "./utils.ts";

export function createThreadsRoutes(
  threadService: ThreadServiceLike,
): Hono<ChatAuthEnv> {
  const app = new Hono<ChatAuthEnv>();

  // ─── List ──────────────────────────────────────────────────────────────────
  app.get("/", async (c) => {
    const callerAgentId = c.get("agentId");
    const limit = parseIntParam(c.req.query("limit"), 50);
    const offset = parseIntParam(c.req.query("offset"), 0);

    // Agent tokens are restricted to their own threads.
    const agentId =
      callerAgentId !== null
        ? callerAgentId
        : (c.req.query("agentId") ?? undefined);
    const memberId = c.req.query("memberId") ?? undefined;

    const { threads, total } = await threadService.list({
      agentId,
      memberId,
      limit,
      offset,
    });
    return c.json({ threads, total, limit, offset }, 200);
  });

  // ─── Create ────────────────────────────────────────────────────────────────
  app.post("/", async (c) => {
    const callerAgentId = c.get("agentId");

    let body: Record<string, unknown> = {};
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      // empty body → fall through to validation below
    }

    const agentId =
      typeof body.agentId === "string" ? body.agentId : undefined;
    if (!agentId) throw new BadRequestError("agentId is required");

    // Agent tokens can only create threads for themselves.
    if (callerAgentId !== null && callerAgentId !== agentId) {
      throw new ForbiddenError(
        "agent token may only create threads for its own agentId",
      );
    }

    const memberId =
      typeof body.memberId === "string" ? body.memberId : undefined;
    const title = typeof body.title === "string" ? body.title : undefined;

    const thread = await threadService.create({ agentId, memberId, title });
    return c.json(thread, 201);
  });

  // ─── Stats ─────────────────────────────────────────────────────────────────
  app.get("/:id/stats", async (c) => {
    const thread = await threadService.findById(c.req.param("id"));
    if (!thread) throw new NotFoundError("thread not found");
    enforceAgentScope(c.get("agentId"), thread.agentId);
    const stats = await threadService.getStats(thread);
    return c.json(stats, 200);
  });

  // ─── Get ───────────────────────────────────────────────────────────────────
  app.get("/:id", async (c) => {
    const thread = await threadService.findById(c.req.param("id"));
    if (!thread) throw new NotFoundError("thread not found");
    enforceAgentScope(c.get("agentId"), thread.agentId);
    return c.json(thread, 200);
  });

  // ─── Update ────────────────────────────────────────────────────────────────
  app.patch("/:id", async (c) => {
    const thread = await threadService.findById(c.req.param("id"));
    if (!thread) throw new NotFoundError("thread not found");
    enforceAgentScope(c.get("agentId"), thread.agentId);

    let body: Record<string, unknown> = {};
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      // empty body → no-op update
    }

    const title = "title" in body ? (body.title as string | null) : undefined;
    const memberId =
      "memberId" in body ? (body.memberId as string | null) : undefined;

    const updated = await threadService.update(c.req.param("id"), {
      title,
      memberId,
    });
    if (!updated) throw new NotFoundError("thread not found");
    return c.json(updated, 200);
  });

  // ─── Delete ────────────────────────────────────────────────────────────────
  app.delete("/:id", async (c) => {
    const thread = await threadService.findById(c.req.param("id"));
    if (!thread) throw new NotFoundError("thread not found");
    enforceAgentScope(c.get("agentId"), thread.agentId);

    const deleted = await threadService.delete(c.req.param("id"));
    if (!deleted) throw new NotFoundError("thread not found");
    return c.json(deleted, 200);
  });

  return app;
}

function enforceAgentScope(
  callerAgentId: string | null,
  threadAgentId: string,
): void {
  if (callerAgentId !== null && callerAgentId !== threadAgentId) {
    throw new ForbiddenError("agent token may not access this thread");
  }
}
