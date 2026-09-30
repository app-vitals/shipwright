/**
 * agent/src/api.ts
 * Hono runtime API — GET /:id/config and GET /:id/crons.
 *
 * Mounted at /agents/* via root.route("/agents", runtimeApp).
 * Hono v4's .route() strips the prefix before dispatching — routes must be
 * registered without the /agents prefix so they resolve correctly at
 * GET /agents/:id/config and GET /agents/:id/crons from the root.
 *
 * Auth: same admin-key / per-agent-token / session-cookie middleware as the
 * CRUD routes (SHIPWRIGHT_INTERNAL_API_KEY removed in UNI-1.2).
 * This is the endpoint the harness polls every 60s.
 *
 * NOTE: Auth middleware is scoped per-route (not global app.use("*")).
 * Using app.use("*") in a sub-app mounted via root.route("/agents", runtimeApp)
 * causes Hono v4 to hoist the middleware as a /agents/* guard in root — which
 * blocks all admin CRUD requests (POST/PATCH/DELETE /agents/:id/*) before they
 * reach the admin handlers. Per-route middleware confines the check to only the
 * two routes that need it.
 */

import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { AgentCronJob } from "./agent-cron-jobs.ts";
import type { AgentEnvBundle } from "./agent-envs.ts";
import type { AgentTokenService } from "./agent-tokens.ts";
import { type AdminApiKey, createAdminAuthMiddleware } from "./api-auth.ts";
import {
  AGENT_PHASES,
  AgentConfigResponseSchema,
  AgentCronJobSchema,
  AgentIdParamSchema,
  RuntimeErrorSchema,
} from "./openapi-schemas.ts";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface AgentPlugin {
  marketplace: string;
  plugin: string;
}

export interface AgentConfigResponse {
  env: Record<string, string>;
  allowedTools: string[];
  plugins: AgentPlugin[];
  repos: string[];
  reviewAuthorAllowlist: string[];
  patchAuthorAllowlist: string[];
  restrictSlackToMembers: boolean;
  memberEmails: string[];
  /**
   * ATE-3.1: ISO timestamp of trial expiry, or null/absent when no trial is
   * configured. Optional (rather than a required nullable field) so existing
   * fixtures/doubles built against this interface before ATE-3.1 keep
   * compiling unchanged. Read by agent/src/index.ts's syncConfig() to sync
   * agent-trial-expiry-ref.ts's live ref, which agent/src/slack.ts's
   * isTrialExpired() gate reads to block Slack access post-expiry.
   */
  trialExpiresAt?: string | null;
  /**
   * PMC-1.1: phase -> subagentType (or null) map, covering all six pipeline
   * phases regardless of whether the agent has an explicit override row for
   * each — phases without a row default to null. The live handler always
   * populates this (see AgentConfigResponseSchema, which requires it), but
   * the TS interface field stays optional — mirroring trialExpiresAt above —
   * so existing fixtures/doubles built against this interface before PMC-1.1
   * (and lib/admin-types.ts's openapi-fetch `paths` type, regenerated
   * separately from admin/openapi.json) keep compiling unchanged.
   */
  phaseMethodology?: Record<string, string | null>;
  /**
   * APM-1.5: direct passthrough of the 6 agent-policy fields APM-1.1 added
   * to the Agent row. Required fields — no prior-fixture-compat concern
   * since they didn't exist before this task.
   */
  autoPostReviews: boolean;
  allowSelfReview: boolean;
  minConfidence: number;
  maxFindings: number;
  cleanupMergedWorktrees: boolean;
  cleanupAfterDays: number;
}

interface AgentEnvServiceLike {
  getConfigBundle(agentId: string): Promise<AgentEnvBundle | null>;
}

interface AgentCronJobServiceLike {
  list(agentId: string): Promise<AgentCronJob[]>;
  listWithRunSummary?(agentId: string): Promise<
    Array<
      AgentCronJob & {
        lastRun: null | {
          startedAt: Date;
          completedAt: Date | null;
          skipped: boolean;
          outcome: string | null;
        };
        runCountToday: number;
      }
    >
  >;
}

interface AgentServiceLike {
  getById(agentId: string): Promise<{
    id: string;
    repos: string[];
    reviewAuthorAllowlist: string[];
    patchAuthorAllowlist: string[];
    restrictSlackToMembers: boolean;
    memberEmails: string[];
    /** ATE-3.1: optional so pre-existing test doubles built against this interface keep compiling unchanged. */
    trialExpiresAt?: Date | null;
    /** APM-1.5: the 6 agent-policy fields, direct-passthrough into the response. */
    autoPostReviews: boolean;
    allowSelfReview: boolean;
    minConfidence: number;
    maxFindings: number;
    cleanupMergedWorktrees: boolean;
    cleanupAfterDays: number;
  } | null>;
}

interface AgentPluginServiceLike {
  listEnabled(agentId: string): Promise<Array<{ name: string }>>;
}

interface AgentPhaseMethodologyServiceLike {
  list(
    agentId: string,
  ): Promise<Array<{ phase: string; subagentType: string | null }>>;
}

export interface AgentRuntimeDeps {
  agentEnvService: AgentEnvServiceLike;
  agentCronJobService: AgentCronJobServiceLike;
  agentService: AgentServiceLike;
  agentPluginService: AgentPluginServiceLike;
  agentPhaseMethodologyService: AgentPhaseMethodologyServiceLike;
  /** Session secret for cookie auth (SHIPWRIGHT_SESSION_SECRET). */
  sessionSecret: string;
  /** Parsed SHIPWRIGHT_ADMIN_API_KEYS — optional; absent means env key auth is disabled. */
  adminApiKeys?: Map<string, AdminApiKey>;
  /** Token service for per-agent bearer token validation. */
  agentTokenService: Pick<AgentTokenService, "validate">;
}

// ─── Route definitions ────────────────────────────────────────────────────────

const getConfigRoute = createRoute({
  method: "get",
  path: "/:id/config",
  tags: ["runtime"],
  summary: "Get agent config bundle",
  description:
    "Returns the agent's full runtime config bundle — decrypted env vars, allowed-tools patterns, installed plugins (with derived marketplace), scoped repos, review/patch author allowlists, and Slack membership-restriction settings. Polled by the agent harness on startup and during its config sync loop. Returns 404 if the agent doesn't exist.",
  security: [{ bearerAuth: [] }],
  request: {
    params: AgentIdParamSchema,
  },
  responses: {
    200: {
      description: "Agent config bundle",
      content: { "application/json": { schema: AgentConfigResponseSchema } },
    },
    401: {
      description: "Unauthorized",
      content: { "application/json": { schema: RuntimeErrorSchema } },
    },
    404: {
      description: "Agent not found",
      content: { "application/json": { schema: RuntimeErrorSchema } },
    },
  },
});

const getCronsRoute = createRoute({
  method: "get",
  path: "/:id/crons",
  tags: ["runtime"],
  summary: "List agent cron jobs",
  description:
    "Returns the agent's cron jobs as a plain array (not wrapped), used by the agent harness's scheduler. Returns 404 if the agent doesn't exist.",
  security: [{ bearerAuth: [] }],
  request: {
    params: AgentIdParamSchema,
  },
  responses: {
    200: {
      description: "Array of cron jobs",
      content: {
        "application/json": { schema: z.array(AgentCronJobSchema) },
      },
    },
    401: {
      description: "Unauthorized",
      content: { "application/json": { schema: RuntimeErrorSchema } },
    },
    404: {
      description: "Agent not found",
      content: { "application/json": { schema: RuntimeErrorSchema } },
    },
  },
});

// ─── Factory ──────────────────────────────────────────────────────────────────

/**
 * Creates the OpenAPIHono runtime API app.
 *
 * Inject real services for production; inject mocks for tests.
 */
export function createAgentRuntimeApp(deps: AgentRuntimeDeps): OpenAPIHono {
  const {
    agentEnvService,
    agentCronJobService,
    agentService,
    agentPluginService,
    agentPhaseMethodologyService,
  } = deps;

  const app = new OpenAPIHono();

  // Auth middleware — applied per-route, NOT as app.use("*").
  // See file-level comment for why global middleware is avoided here.
  const requireAuth = createAdminAuthMiddleware({
    sessionSecret: deps.sessionSecret,
    adminApiKeys: deps.adminApiKeys,
    agentTokenService: deps.agentTokenService,
  });

  // ─── GET /:id/config ─────────────────────────────────────────────────────
  //     Reachable from root as GET /agents/:id/config (Hono v4 strips prefix)

  app.use("/:id/config", requireAuth);

  app.openapi(getConfigRoute, async (c) => {
    const { id } = c.req.valid("param");

    // Check agent existence
    const agent = await agentService.getById(id);
    if (!agent) {
      return c.json({ error: "Not found" }, 404);
    }

    // Fetch env bundle, plugins, and phase-methodology overrides in parallel
    const [bundle, plugins, phaseMethodologyRows] = await Promise.all([
      agentEnvService.getConfigBundle(id),
      agentPluginService.listEnabled(id),
      agentPhaseMethodologyService.list(id),
    ]);

    // Every phase defaults to null; override rows (if any) fill in the rest.
    const phaseMethodology: Record<string, string | null> = Object.fromEntries(
      AGENT_PHASES.map((phase) => [phase, null]),
    );
    for (const row of phaseMethodologyRows) {
      phaseMethodology[row.phase] = row.subagentType;
    }

    // Not annotated as `: AgentConfigResponse` — that interface's
    // phaseMethodology field is deliberately optional (see its doc comment)
    // for downstream consumer/fixture compatibility, but this handler always
    // populates every field, so leaving the literal un-annotated lets it
    // infer the fully-required shape the route's Zod response schema (which
    // requires phaseMethodology) expects. `c.json()` below still structurally
    // checks this literal against that schema-derived type.
    const response = {
      env: bundle?.env ?? {},
      allowedTools: bundle?.allowedTools ?? [],
      plugins: plugins.map((p) => {
        // The stored name is the canonical Claude plugin spec — exactly what
        // you'd pass to `claude plugin install`: "<plugin>@<marketplace>"
        // (e.g. "shipwright@shipwright"), or a bare "<plugin>" that defaults to
        // the bundled "shipwright" marketplace. The harness reassembles
        // "<plugin>@<marketplace>" from these two fields.
        const at = p.name.indexOf("@");
        return at === -1
          ? { marketplace: "shipwright", plugin: p.name }
          : { plugin: p.name.slice(0, at), marketplace: p.name.slice(at + 1) };
      }),
      repos: agent.repos,
      reviewAuthorAllowlist: agent.reviewAuthorAllowlist,
      patchAuthorAllowlist: agent.patchAuthorAllowlist,
      restrictSlackToMembers: agent.restrictSlackToMembers ?? false,
      memberEmails: agent.memberEmails ?? [],
      trialExpiresAt: agent.trialExpiresAt
        ? agent.trialExpiresAt.toISOString()
        : null,
      phaseMethodology,
      // APM-1.5: direct passthrough — the DB column always has a value
      // (Prisma schema default), so no `??` fallback is needed.
      autoPostReviews: agent.autoPostReviews,
      allowSelfReview: agent.allowSelfReview,
      minConfidence: agent.minConfidence,
      maxFindings: agent.maxFindings,
      cleanupMergedWorktrees: agent.cleanupMergedWorktrees,
      cleanupAfterDays: agent.cleanupAfterDays,
    };

    return c.json(response, 200);
  });

  // ─── GET /:id/crons ──────────────────────────────────────────────────────
  //     Reachable from root as GET /agents/:id/crons (Hono v4 strips prefix)

  app.use("/:id/crons", requireAuth);

  app.openapi(getCronsRoute, async (c) => {
    const { id } = c.req.valid("param");

    // Check agent existence
    const agent = await agentService.getById(id);
    if (!agent) {
      return c.json({ error: "Not found" }, 404);
    }

    const crons = await agentCronJobService.list(id);
    return c.json(crons, 200);
  });

  return app;
}
