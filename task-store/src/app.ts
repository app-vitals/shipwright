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
 *   GET /docs/:id      — unauthenticated capability URL (ephemeral HTML doc)
 *   * /*               — bearer auth middleware (everything else)
 *   POST /docs         — store an ephemeral HTML doc (bearer auth)
 *   * /tasks/*         — task CRUD + claim/heartbeat/complete/fail/release
 *   * /tokens/*        — token create/list/revoke
 *
 * The /docs GET is registered BEFORE the bearer middleware (like /health) so the
 * capability URL is publicly fetchable; POST /docs is registered after, so it
 * requires a valid bearer token.
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
import { type TaskStoreAuthEnv, createBearerAuthMiddleware } from "./auth.ts";
import { type DocStoreLike, createDocStore } from "./doc-store.ts";
import { ApiError, BadRequestError, NotFoundError } from "./errors.ts";
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
  async claimNext(_agentId, _maxConcurrent, _repos?) {
    return null;
  },
};

export interface TaskStoreDeps {
  taskService: TaskServiceLike;
  tokenService: TokenServiceLike;
  pullRequestService?: PullRequestServiceLike;
  /** Optional scope resolver for agent tokens — returns repos from agents service. */
  scopeResolver?: (agentId: string) => Promise<string[]>;
  /** Ephemeral HTML doc store. Defaults to an in-memory system-clock store. */
  docStore?: DocStoreLike;
  /**
   * Externally-reachable base URL used to build the capability URL returned by
   * POST /docs. Falls back to the request's own origin when unset.
   */
  docPublicBaseUrl?: string;
  /**
   * Optional Sentry client for reporting unhandled errors. Undefined means
   * Sentry is not initialized (SENTRY_DSN unset) — onError simply skips the
   * capture call. Production wiring in main.ts passes the real `Sentry` from
   * `@sentry/bun` only when SENTRY_DSN is set.
   */
  sentryClient?: ErrorCapturingClient;
}

export function createTaskStoreApp(
  deps: TaskStoreDeps,
): Hono<TaskStoreAuthEnv> {
  const app = new Hono<TaskStoreAuthEnv>();
  const docStore = deps.docStore ?? createDocStore();

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
    deps.sentryClient?.captureException(err);
    console.error(
      `[task-store] unhandled error (caller: ${callerLabel(c.get("caller"))}):`,
      err,
    );
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: message }, 500);
  });

  // Health check — no auth.
  app.get("/health", (c) =>
    c.json({ status: "ok", service: "task-store" }, 200),
  );

  // Capability URL — no auth. The unguessable id IS the credential. Serves the
  // stored HTML, or 404 on miss/expiry. Registered before the bearer middleware.
  app.get("/docs/:id", (c) => {
    const html = docStore.get(c.req.param("id"));
    if (html === undefined) {
      throw new NotFoundError("document not found or expired");
    }
    return c.body(html, 200, { "Content-Type": "text/html; charset=utf-8" });
  });

  // Everything below requires a valid bearer token.
  app.use(
    "*",
    createBearerAuthMiddleware({
      tokenService: deps.tokenService,
      scopeResolver: deps.scopeResolver,
    }),
  );

  // Store an ephemeral HTML document (bearer auth). Body is the raw HTML string.
  app.post("/docs", async (c) => {
    const html = await c.req.text();
    if (html.length === 0) {
      throw new BadRequestError("empty document body");
    }
    // May throw PayloadTooLargeError (413) — mapped by onError.
    const { id } = docStore.put(html);
    const base = (deps.docPublicBaseUrl ?? new URL(c.req.url).origin).replace(
      /\/$/,
      "",
    );
    return c.json(
      { id, url: `${base}/docs/${id}`, expiresIn: docStore.ttlSeconds },
      201,
    );
  });

  app.route("/tasks", createTasksRoutes(deps.taskService));
  app.route("/tokens", createTokensRoutes(deps.tokenService));
  app.route("/prs", createPrsRoutes(deps.pullRequestService ?? noopPrService));

  return app;
}
