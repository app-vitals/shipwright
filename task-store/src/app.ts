/**
 * task-store/src/app.ts
 * Compose the task-store Hono app from injected services.
 *
 * The factory accepts service interfaces (not concrete classes) so tests can
 * inject in-memory fakes without a real database. Production wiring in main.ts
 * passes the real TaskService / TaskTokenService backed by PrismaClient.
 *
 * Mount order:
 *   GET /health        — unauthenticated liveness probe (DB-independent)
 *   GET /health/ready  — unauthenticated readiness probe (DB-aware, via
 *                        the injected `checkDbReady` dep)
 *   * /*               — bearer auth middleware (everything else)
 *   * /tasks/*         — task CRUD + claim/heartbeat/complete/fail/release
 *   * /tokens/*        — token create/list/revoke
 *
 * Thrown ApiError subclasses are mapped to HTTP responses by the onError hook.
 */

import { sentry } from "@sentry/hono/bun";
import { callerLabel } from "@shipwright/lib/request-context";
import {
  type ErrorCapturingClient,
  buildSentryInitOptions,
} from "@shipwright/lib/sentry";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
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
  async recordSkip(_id) {
    return {} as never;
  },
  async resetSkip(_id) {
    return {} as never;
  },
  async claimNext(_agentId, _maxConcurrent, _repos?) {
    return null;
  },
  async appendFinding(_prId, _data) {
    return {} as never;
  },
  async getEvents(_prId, _opts?) {
    return { events: [], total: 0 };
  },
};

export interface TaskStoreDeps {
  taskService: TaskServiceLike;
  tokenService: TokenServiceLike;
  pullRequestService?: PullRequestServiceLike;
  /** Optional scope resolver for agent tokens — returns repos from agents service. */
  scopeResolver?: (agentId: string) => Promise<string[]>;
  /**
   * Optional Sentry client for reporting unhandled errors. Undefined means
   * Sentry is not initialized (SENTRY_DSN unset) — onError simply skips the
   * capture call. Production wiring in main.ts passes the real `Sentry` from
   * `@sentry/bun` only when SENTRY_DSN is set.
   */
  sentryClient?: ErrorCapturingClient;
  /**
   * Optional DB-aware readiness check backing GET /health/ready. Production
   * wiring in main.ts passes a closure over the real `prisma` instance
   * (`SELECT 1`, never throws — returns false on any failure). Omitted in
   * most tests, which default to always-ready so existing callers that don't
   * inject it are unaffected.
   */
  checkDbReady?: () => Promise<boolean>;
}

export function createTaskStoreApp(
  deps: TaskStoreDeps,
): Hono<TaskStoreAuthEnv> {
  const app = new Hono<TaskStoreAuthEnv>();

  // Only mounted when SENTRY_DSN is set — a complete no-op otherwise, matching
  // the app's behavior with Sentry absent. `@sentry/hono`'s `sentry()`
  // middleware performs its own `Sentry.init` call internally (that's how the
  // SDK integrates with Hono), so it must be the *sole* init site — main.ts
  // does not also call `initSentry()` when serving this app. Options are
  // built via the same `buildSentryInitOptions` helper `initSentry` uses, so
  // scrub hooks / environment / service tag stay identical across services.
  const sentryInitOptions = buildSentryInitOptions({ service: "task-store" });
  if (sentryInitOptions) {
    app.use("*", sentry(app, sentryInitOptions));
  }

  // Map typed errors to responses; everything else is a 500.
  app.onError((err, c) => {
    if (err instanceof ApiError) {
      return c.json({ error: err.message }, err.statusCode as 400);
    }
    // hono/@hono/zod-openapi throws a bare HTTPException (not an ApiError)
    // when the request body isn't valid JSON at all — e.g.
    // `hono/dist/validator/validator.js`'s own `c.req.json()` parse-failure
    // path. It already carries the correct client-error status (400), so
    // treat it like an ApiError: no Sentry capture, respond with its own
    // status. A >=500 HTTPException (rare — not raised by this parse path)
    // still falls through to the generic unhandled-error handling below.
    if (err instanceof HTTPException && err.status < 500) {
      return c.json({ error: err.message }, err.status as 400);
    }
    deps.sentryClient?.captureException(err);
    console.error(
      `[task-store] unhandled error (caller: ${callerLabel(c.get("caller"))}):`,
      err,
    );
    const message = err instanceof Error ? err.message : String(err);
    const status = err instanceof HTTPException ? err.status : 500;
    return c.json({ error: message }, status as 500);
  });

  // Health checks — no auth.
  //   /health       — liveness: process-alive only, independent of DB state.
  //                   A transient DB blip must never trigger a
  //                   liveness-driven restart.
  //   /health/ready — readiness: DB-aware. Used by the chart's readinessProbe
  //                   so Kubernetes doesn't route traffic to this pod before
  //                   Postgres is actually reachable. Defaults to always-ready
  //                   when `checkDbReady` is omitted.
  app.get("/health", (c) =>
    c.json({ status: "ok", service: "task-store" }, 200),
  );
  app.get("/health/ready", async (c) => {
    const ready = deps.checkDbReady ? await deps.checkDbReady() : true;
    return c.json({ status: ready ? "ok" : "not_ready" }, ready ? 200 : 503);
  });

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
