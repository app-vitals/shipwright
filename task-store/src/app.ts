/**
 * task-store/src/app.ts
 * Compose the task-store Hono app from injected services.
 *
 * The factory accepts service interfaces (not concrete classes) so tests can
 * inject in-memory fakes without a real database. Production wiring in main.ts
 * passes the real TaskService / TaskTokenService backed by PrismaClient.
 *
 * Mount order:
 *   GET /health        — unauthenticated liveness probe
 *   * /*               — bearer auth middleware (everything else)
 *   * /tasks/*         — task CRUD + claim/heartbeat/complete/fail/release
 *   * /tokens/*        — token create/list/revoke
 *
 * Thrown ApiError subclasses are mapped to HTTP responses by the onError hook.
 */

import { Hono } from "hono";
import { type TaskStoreAuthEnv, createBearerAuthMiddleware } from "./auth.ts";
import { ApiError } from "./errors.ts";
import type { PullRequestServiceLike } from "./pull-request-service.ts";
import { createPrsRoutes } from "./routes/prs.ts";
import { createTasksRoutes } from "./routes/tasks.ts";
import { createTokensRoutes } from "./routes/tokens.ts";
import type { TaskServiceLike } from "./task-service.ts";
import type { TokenServiceLike } from "./token-service.ts";

/** No-op PullRequestService used when the feature is not wired up in a test context. */
const noopPrService: PullRequestServiceLike = {
  async list() {
    return { prs: [], total: 0, limit: 50, offset: 0 };
  },
  async get() {
    return null;
  },
  async update(_id, _data) {
    return {} as never;
  },
  async claim(_repo, _prNumber, _commitSha, _claimedBy) {
    return { status: 201 as const, record: {} as never };
  },
  async heartbeat(_id) {
    return {} as never;
  },
  async complete(_id) {
    return {} as never;
  },
  async patch(_id) {
    return {} as never;
  },
  async release(_id) {
    return {} as never;
  },
};

export interface TaskStoreDeps {
  taskService: TaskServiceLike;
  tokenService: TokenServiceLike;
  pullRequestService?: PullRequestServiceLike;
  /** Optional scope resolver for agent tokens — returns repos from agents service. */
  scopeResolver?: (agentId: string) => Promise<string[]>;
}

export function createTaskStoreApp(
  deps: TaskStoreDeps,
): Hono<TaskStoreAuthEnv> {
  const app = new Hono<TaskStoreAuthEnv>();

  // Map typed errors to responses; everything else is a 500.
  app.onError((err, c) => {
    if (err instanceof ApiError) {
      return c.json({ error: err.message }, err.statusCode as 400);
    }
    console.error("[task-store] unhandled error:", err);
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: message }, 500);
  });

  // Health check — no auth.
  app.get("/health", (c) =>
    c.json({ status: "ok", service: "task-store" }, 200),
  );

  // Everything below requires a valid bearer token.
  app.use(
    "*",
    createBearerAuthMiddleware({
      tokenService: deps.tokenService,
      scopeResolver: deps.scopeResolver,
    }),
  );

  app.route("/tasks", createTasksRoutes(deps.taskService));
  app.route("/tokens", createTokensRoutes(deps.tokenService));
  app.route("/prs", createPrsRoutes(deps.pullRequestService ?? noopPrService));

  return app;
}
