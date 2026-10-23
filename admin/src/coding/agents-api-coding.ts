/**
 * admin/src/coding/agents-api-coding.ts
 * The coding extension's admin API routes — OpenAPIHono app factory, mounted
 * by codingAdminExtension.apiRoutes after the platform APIs (AEP-3.2: split
 * out of agents-api.ts, which keeps the platform CRUD API).
 *
 * Routes:
 *   GET  /agents/{id}/phase-methodology          — list phase-methodology overrides
 *   PUT  /agents/{id}/phase-methodology/{phase}  — set/clear one phase's override
 *   GET  /agents/all/cron-runs/dev-task-adherence — fleet dev-task adherence (admin)
 *   GET  /agents/{id}/dev-task-adherence         — one agent's dev-task adherence
 *   POST /agents/{id}/work-queue                 — push a work-queue snapshot
 *   GET  /agents/{id}/work-queue                 — latest work-queue snapshot
 *
 * Auth and errors match the platform API exactly: the same combined auth
 * middleware (admin key | per-agent bearer | session cookie) and the same
 * OpenAPIHono defaults (createAdminApiHono). In the composed admin the
 * platform API's `/agents/*` middleware has already authenticated the request
 * by the time these routes run, so this app's own auth only runs when it
 * hasn't (e.g. mounted alone) — never twice.
 *
 * codingAdminOpenApi() contributes these routes and their schemas to the
 * generated admin/openapi.json at their historical positions, keeping the
 * document byte-identical to the pre-split one.
 */

import type { PoolLike } from "@app-vitals/agent-lib/pool-observability";
import type { ErrorCapturingClient } from "@app-vitals/agent-lib/sentry";
import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import type { MiddlewareHandler } from "hono";
import type { AdminOpenApiContribution } from "../admin-extension.ts";
import type { AgentMemberService } from "../agent-members.ts";
import type { AgentTokenService } from "../agent-tokens.ts";
import type { AgentService } from "../agents.ts";
import { createAdminApiHono, cronRunStatsQuerySchema } from "../agents-api.ts";
import {
  type AdminApiKey,
  type AdminAuthEnv,
  createAdminAuthMiddleware,
} from "../api-auth.ts";
import {
  type CallerScopeResolver,
  memberOnlyCallerScopeResolver,
} from "../caller-scope.ts";
import { ForbiddenError, NotFoundError } from "../errors.ts";
import { AgentIdParamSchema, ErrorSchema } from "../openapi-schemas.ts";
import type { AgentPhaseMethodologyService } from "./agent-phase-methodology.ts";
import type { AgentWorkQueueService } from "./agent-work-queue.ts";
import type { DevTaskAdherenceService } from "./dev-task-adherence.ts";
import {
  AgentPhaseMethodologySchema,
  AgentWorkQueueSnapshotSchema,
  PhaseParamSchema,
  PushWorkQueueSnapshotBodySchema,
  PutAgentPhaseMethodologyBodySchema,
} from "./openapi-schemas-coding.ts";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface CodingAdminApiDeps {
  agentService: Pick<AgentService, "exists">;
  agentPhaseMethodologyService: Pick<
    AgentPhaseMethodologyService,
    "list" | "upsert"
  >;
  agentWorkQueueService: Pick<AgentWorkQueueService, "push" | "get">;
  /** DTA-1.2 — optional; the adherence routes 404 when absent. */
  devTaskAdherenceService?: Pick<DevTaskAdherenceService, "report">;
  // Auth — the same deps the platform API's middleware is built from.
  agentTokenService: Pick<AgentTokenService, "validate">;
  agentMemberService: Pick<AgentMemberService, "listByEmail">;
  /** Account-aware caller-scope resolver (SSP-2.1); defaults to AgentMember-only. */
  callerScopeResolver?: CallerScopeResolver;
  sessionSecret: string;
  /** Parsed SHIPWRIGHT_ADMIN_API_KEYS — optional; absent means env key auth is disabled. */
  adminApiKeys?: Map<string, AdminApiKey>;
  /** Optional Sentry client for unhandled errors (see AdminDeps.sentryClient). */
  sentryClient?: ErrorCapturingClient;
  /** Admin's pg pool (see AdminDeps.pool) for pool-timeout capture context. */
  pool?: PoolLike;
}

// ─── Response schema helpers ────────────────────────────────────────────────────

const PhaseMethodologyWrapperSchema = z
  .object({ phaseMethodology: AgentPhaseMethodologySchema })
  .openapi("PhaseMethodologyWrapper");

const PhaseMethodologyListWrapperSchema = z
  .object({ phaseMethodology: z.array(AgentPhaseMethodologySchema) })
  .openapi("PhaseMethodologyListWrapper");

const jsonError = {
  content: { "application/json": { schema: ErrorSchema } },
};

const WorkQueueSnapshotWrapperSchema = z
  .object({ snapshot: AgentWorkQueueSnapshotSchema })
  .openapi("WorkQueueSnapshotWrapper");

// ─── Route definitions ──────────────────────────────────────────────────────────

const listPhaseMethodologyRoute = createRoute({
  method: "get",
  path: "/agents/{id}/phase-methodology",
  summary: "List phase-methodology overrides",
  description:
    "Returns every phase-methodology override configured for the agent — which subagent type handles each pipeline phase (prd, plan-session, review, patch, deploy, dev-task). A phase with no explicit override is simply absent from this list; see GET /agents/:id/config's `phaseMethodology` map for the full six-phase view with defaults filled in.",
  request: { params: AgentIdParamSchema },
  responses: {
    200: {
      description: "List of phase-methodology overrides",
      content: {
        "application/json": { schema: PhaseMethodologyListWrapperSchema },
      },
    },
    404: { description: "Agent not found", ...jsonError },
  },
});

const putPhaseMethodologyRoute = createRoute({
  method: "put",
  path: "/agents/{id}/phase-methodology/{phase}",
  summary: "Set a phase's subagent-type override",
  description:
    "Upserts the `subagentType` override for one pipeline phase. Passing `subagentType: null` clears the override (the phase falls back to its default methodology). `phase` must be one of prd, plan-session, review, patch, deploy, dev-task.",
  request: {
    params: PhaseParamSchema,
    body: {
      content: {
        "application/json": { schema: PutAgentPhaseMethodologyBodySchema },
      },
    },
  },
  responses: {
    200: {
      description: "Phase-methodology override upserted",
      content: {
        "application/json": { schema: PhaseMethodologyWrapperSchema },
      },
    },
    400: { description: "Bad request — invalid phase", ...jsonError },
    404: { description: "Agent not found", ...jsonError },
  },
});

const pushWorkQueueSnapshotRoute = createRoute({
  method: "post",
  path: "/agents/{id}/work-queue",
  summary: "Push a work-queue snapshot",
  description:
    "Upserts the agent's single ranked work-queue snapshot (tasks/PRs across pipeline phases), overwriting any prior snapshot — there is no history.",
  request: {
    params: AgentIdParamSchema,
    body: {
      content: {
        "application/json": { schema: PushWorkQueueSnapshotBodySchema },
      },
    },
  },
  responses: {
    200: {
      description:
        "Snapshot upserted (overwrites any prior snapshot for this agent)",
      content: {
        "application/json": { schema: WorkQueueSnapshotWrapperSchema },
      },
    },
    400: { description: "Bad request", ...jsonError },
  },
});

const getWorkQueueSnapshotRoute = createRoute({
  method: "get",
  path: "/agents/{id}/work-queue",
  summary: "Get the latest work-queue snapshot",
  description:
    "Returns the most recently pushed work-queue snapshot, or 404 if the agent has never pushed one.",
  request: { params: AgentIdParamSchema },
  responses: {
    200: {
      description: "Latest work-queue snapshot",
      content: {
        "application/json": { schema: WorkQueueSnapshotWrapperSchema },
      },
    },
    404: { description: "No snapshot pushed yet", ...jsonError },
  },
});

const devTaskAdherenceRoute = createRoute({
  method: "get",
  path: "/agents/all/cron-runs/dev-task-adherence",
  summary: "Get dev-task adherence report",
  description:
    "Admin-only. Per dev-task run, compares skill-usage subagent dispatches against the required-steps table and reports per-step ran/skipped, with per-step adherence rates overall, per variant (contextFingerprint) and per commandVariant (default vs alternate). Rates cover task-bearing runs only (dispatched against a work item); `counts` separates them from silent no-ready-task ticks. A dispatch proves a step started, not that it was done well. Optional `from`/`to` ISO datetime params bound startedAt.",
  request: {
    query: cronRunStatsQuerySchema,
  },
  responses: {
    200: {
      description: "Dev-task adherence report",
      content: {
        "application/json": { schema: z.record(z.string(), z.unknown()) },
      },
    },
    401: { description: "Unauthorized", ...jsonError },
    403: { description: "Forbidden — requires admin scope", ...jsonError },
    404: { description: "Adherence reporting not configured", ...jsonError },
  },
});

const selfDevTaskAdherenceRoute = createRoute({
  method: "get",
  path: "/agents/{id}/dev-task-adherence",
  summary: "Get this agent's dev-task adherence report",
  description:
    "Self-serve variant of the fleet-wide dev-task adherence report, scoped to the agent in the path. Access is gated by the generic agent-route auth (an agent's own bearer token, an admin, or a member session) — no admin scope required. Same report shape and optional `from`/`to` params as GET /agents/all/cron-runs/dev-task-adherence.",
  request: {
    params: AgentIdParamSchema,
    query: cronRunStatsQuerySchema,
  },
  responses: {
    200: {
      description: "Dev-task adherence report for this agent's runs only",
      content: {
        "application/json": { schema: z.record(z.string(), z.unknown()) },
      },
    },
    401: { description: "Unauthorized", ...jsonError },
    403: { description: "Forbidden", ...jsonError },
    404: { description: "Adherence reporting not configured", ...jsonError },
  },
});

// ─── App factory ──────────────────────────────────────────────────────────────

export function createCodingAdminApiApp(
  deps: CodingAdminApiDeps,
): OpenAPIHono<AdminAuthEnv> {
  const {
    agentService,
    agentPhaseMethodologyService,
    agentWorkQueueService,
    devTaskAdherenceService,
    agentTokenService,
    agentMemberService,
    sessionSecret,
    adminApiKeys,
    sentryClient,
    pool,
  } = deps;
  const callerScopeResolver =
    deps.callerScopeResolver ??
    memberOnlyCallerScopeResolver(agentMemberService);

  const app = createAdminApiHono(sentryClient, pool);

  const authMiddleware = createAdminAuthMiddleware({
    sessionSecret,
    agentTokenService,
    adminApiKeys,
    agentMemberService,
    callerScopeResolver,
  });
  // Skips when an earlier middleware in this request (the platform API's
  // `/agents/*` auth, same deps) already authenticated the caller.
  const auth: MiddlewareHandler<AdminAuthEnv> = (c, next) =>
    c.get("caller") !== undefined ? next() : authMiddleware(c, next);

  // Scoped to this app's own paths — a sub-app mounted at "/" shares the root
  // router, so a broader pattern would also run in front of platform routes.
  app.use("/agents/:id/phase-methodology", auth);
  app.use("/agents/:id/phase-methodology/:phase", auth);
  app.use("/agents/all/cron-runs/dev-task-adherence", auth);
  app.use("/agents/:id/dev-task-adherence", auth);
  app.use("/agents/:id/work-queue", auth);

  // ─── Phase Methodology ───────────────────────────────────────────────────────

  // GET /agents/:id/phase-methodology — list phase-methodology overrides
  app.openapi(listPhaseMethodologyRoute, async (c) => {
    const { id: agentId } = c.req.valid("param");
    if (!(await agentService.exists(agentId))) {
      throw new NotFoundError(`agent ${agentId} not found`);
    }
    const rows = await agentPhaseMethodologyService.list(agentId);
    return c.json(
      { phaseMethodology: rows.map(serializePhaseMethodology) },
      200,
    );
  });

  // PUT /agents/:id/phase-methodology/:phase — upsert a phase's override
  app.openapi(putPhaseMethodologyRoute, async (c) => {
    const { id: agentId, phase } = c.req.valid("param");
    if (!(await agentService.exists(agentId))) {
      throw new NotFoundError(`agent ${agentId} not found`);
    }
    const body = c.req.valid("json");
    const row = await agentPhaseMethodologyService.upsert(
      agentId,
      phase,
      body.subagentType,
    );
    return c.json({ phaseMethodology: serializePhaseMethodology(row) }, 200);
  });

  // ─── Dev-task adherence ────────────────────────────────────────────────────

  // GET /agents/all/cron-runs/dev-task-adherence — per-step dev-task adherence
  app.openapi(devTaskAdherenceRoute, async (c) => {
    if (c.get("isAdmin") !== true) {
      throw new ForbiddenError(
        "Only admin bearers and session users can access cross-agent stats",
      );
    }
    if (!devTaskAdherenceService) {
      return c.json({ error: "Adherence reporting not configured" }, 404);
    }
    const { from, to } = c.req.valid("query");
    const report = await devTaskAdherenceService.report(from, to);
    return c.json(report, 200);
  });

  // GET /agents/{id}/dev-task-adherence — same report scoped to one agent.
  // No isAdmin check: the generic agent-route auth middleware already rejects
  // a bearer whose agentId doesn't match the path. Registered after the static
  // /agents/all/... route above.
  app.openapi(selfDevTaskAdherenceRoute, async (c) => {
    if (!devTaskAdherenceService) {
      return c.json({ error: "Adherence reporting not configured" }, 404);
    }
    const { id: agentId } = c.req.valid("param");
    const { from, to } = c.req.valid("query");
    const report = await devTaskAdherenceService.report(from, to, agentId);
    return c.json(report, 200);
  });

  // ─── Work queue snapshot ───────────────────────────────────────────────────

  // POST /agents/:id/work-queue — push a snapshot (upserts the single row for
  // this agent, overwriting any prior snapshot)
  app.openapi(pushWorkQueueSnapshotRoute, async (c) => {
    const { id: agentId } = c.req.valid("param");
    const body = c.req.valid("json");
    const snapshot = await agentWorkQueueService.push(agentId, {
      computedAt: new Date(body.computedAt),
      items: body.items,
    });
    return c.json({ snapshot: serializeWorkQueueSnapshot(snapshot) }, 200);
  });

  // GET /agents/:id/work-queue — read the latest snapshot, 404 if none yet
  app.openapi(getWorkQueueSnapshotRoute, async (c) => {
    const { id: agentId } = c.req.valid("param");
    const snapshot = await agentWorkQueueService.get(agentId);
    if (!snapshot) {
      throw new NotFoundError(`no work-queue snapshot for agent ${agentId}`);
    }
    return c.json({ snapshot: serializeWorkQueueSnapshot(snapshot) }, 200);
  });

  return app;
}

// ─── Serializers ────────────────────────────────────────────────────────────────
//
// Prisma returns Date objects; the Zod response schemas expect ISO strings.

function serializePhaseMethodology(row: {
  updatedAt: Date;
  [k: string]: unknown;
}): z.infer<typeof AgentPhaseMethodologySchema> {
  return {
    ...row,
    updatedAt: row.updatedAt.toISOString(),
  } as z.infer<typeof AgentPhaseMethodologySchema>;
}

function serializeWorkQueueSnapshot(snapshot: {
  id: string;
  agentId: string;
  computedAt: Date;
  items: unknown;
  createdAt: Date;
}): z.infer<typeof AgentWorkQueueSnapshotSchema> {
  return {
    id: snapshot.id,
    agentId: snapshot.agentId,
    computedAt: snapshot.computedAt.toISOString(),
    items: snapshot.items as z.infer<
      typeof AgentWorkQueueSnapshotSchema
    >["items"],
    createdAt: snapshot.createdAt.toISOString(),
  };
}

// ─── OpenAPI contribution ───────────────────────────────────────────────────────

/**
 * The coding routes' fragment of admin/openapi.json, generated from the same
 * route definitions (no services needed). Each path and component is placed
 * where it sat before the split, so the composed document is byte-identical.
 */
export function codingAdminOpenApi(): AdminOpenApiContribution {
  const doc = createCodingAdminApiApp({
    agentService: { exists: async () => false },
    agentPhaseMethodologyService: {
      list: async () => [],
      upsert: async () => {
        throw new Error("spec generation only");
      },
    },
    agentWorkQueueService: {
      push: async () => {
        throw new Error("spec generation only");
      },
      get: async () => null,
    },
    agentTokenService: { validate: async () => null },
    agentMemberService: { listByEmail: async () => [] },
    sessionSecret: "openapi-spec-generation-only",
  }).getOpenAPI31Document({
    openapi: "3.1.0",
    info: { title: "coding (internal)", version: "0.1.0" },
  });
  return {
    paths: (doc.paths ?? {}) as Record<string, Record<string, unknown>>,
    schemas: (doc.components?.schemas ?? {}) as Record<string, unknown>,
    placeAfter: {
      paths: {
        "/agents/{id}/phase-methodology": "/agents/{id}/plugins",
        "/agents/{id}/phase-methodology/{phase}":
          "/agents/{id}/phase-methodology",
        "/agents/all/cron-runs/dev-task-adherence":
          "/agents/{id}/cron-runs/outcomes",
        "/agents/{id}/dev-task-adherence":
          "/agents/all/cron-runs/dev-task-adherence",
        "/agents/{id}/work-queue": "/agents/{id}/chat-tokens/daily",
      },
      schemas: {
        PhaseMethodologyListWrapper: "PatchAgentPluginBody",
        AgentPhaseMethodology: "PhaseMethodologyListWrapper",
        PhaseMethodologyWrapper: "AgentPhaseMethodology",
        PutAgentPhaseMethodologyBody: "PhaseMethodologyWrapper",
        WorkQueueSnapshotWrapper: "ChatTokenModelEntry",
        AgentWorkQueueSnapshot: "WorkQueueSnapshotWrapper",
        RankedWorkItem: "AgentWorkQueueSnapshot",
        PushWorkQueueSnapshotBody: "RankedWorkItem",
      },
    },
  };
}
