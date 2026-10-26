/**
 * admin/src/coding/coding-admin-extension.ts
 *
 * Shipwright's coding AdminExtension: the home for the coding agent's admin
 * surfaces. Everything coding-shaped in the admin is contributed from here:
 *
 *   serviceIntegrations — the task-store integration (per-agent task-store
 *                         tokens minted on provision, revoked on delete)
 *   services            — the agent detail page's coding `?error=` messages
 *   apiRoutes           — work-queue snapshots, phase-methodology overrides and
 *                         dev-task adherence (coding/agents-api-coding.ts)
 *   adminUiRoutes       — Queue & Activity, tasks, sessions (+ follow, actions,
 *                         notification settings), PRs, the phase-methodology
 *                         form and the public task board
 *                         (coding/admin-ui-coding.ts)
 *   agentDetailCards    — Recent Verification Activity, GitHub Installations
 *                         and Phase Methodology (coding/admin-ui-agent-cards.ts)
 *   openApi             — the coding API routes' fragment of admin/openapi.json,
 *                         placed where they sat before the split
 *   backgroundPasses    — the session alert sweeper
 *
 * The task-store reads use SHIPWRIGHT_TASK_STORE_URL +
 * SHIPWRIGHT_TASK_STORE_ADMIN_TOKEN; with either unset those views render
 * degraded. With this extension absent the admin is the bare platform.
 */

import {
  resolvePublicRepo,
  resolveSessionAlertIntervalMs,
  SESSION_ALERT_FETCH_TIMEOUT_MS,
} from "@app-vitals/agent-admin/admin-boot-config";
import type {
  AdminBackgroundPass,
  AdminExtension,
  AdminExtensionContext,
} from "@app-vitals/agent-admin/admin-extension";
import {
  HttpTaskStoreProvisioningClient,
  NoopTaskStoreProvisioningClient,
} from "@app-vitals/agent-admin/coding-task-store-provisioning-client";
import type { ServiceIntegration } from "@app-vitals/agent-admin/service-integration";
import { codingAgentDetailCards } from "./admin-ui-agent-cards.ts";
import {
  CODING_AGENT_DETAIL_ERROR_MESSAGES,
  createCodingAdminUIApp,
} from "./admin-ui-coding.ts";
import { AgentPhaseMethodologyService } from "./agent-phase-methodology.ts";
import { AgentWorkQueueService } from "./agent-work-queue.ts";
import {
  codingAdminOpenApi,
  createCodingAdminApiApp,
} from "./agents-api-coding.ts";
import { DevTaskAdherenceService } from "./dev-task-adherence.ts";
import {
  SessionAlertSweeper,
  type SessionForAlert,
} from "./session-alert-sweeper.ts";
import { ShipwrightLoopJobService } from "./shipwright-loop-jobs.ts";
import { createTaskStoreFetchers } from "./task-store-fetchers.ts";

/**
 * The task-store integration, built from SHIPWRIGHT_TASK_STORE_URL and
 * SHIPWRIGHT_TASK_STORE_ADMIN_TOKEN. Always returned so agent deletion still
 * runs its `task-store-tokens` step; with either var unset it carries a no-op
 * client and no URL, so provisioning skips it (no token, no env).
 */
export function taskStoreServiceIntegration(
  env: NodeJS.ProcessEnv,
): ServiceIntegration {
  const url = env.SHIPWRIGHT_TASK_STORE_URL;
  const adminToken = env.SHIPWRIGHT_TASK_STORE_ADMIN_TOKEN;
  const configured = Boolean(url && adminToken);
  const client =
    url && adminToken
      ? new HttpTaskStoreProvisioningClient(url, adminToken)
      : new NoopTaskStoreProvisioningClient();
  return {
    name: "task-store",
    tokenEnv: "SHIPWRIGHT_TASK_STORE_TOKEN",
    urlEnv: "SHIPWRIGHT_TASK_STORE_URL",
    secretKey: "task-store-token",
    ...(configured ? { url } : {}),
    mintToken: (label, agentId) => client.mintToken(label, agentId),
    revokeToken: (id) => client.revokeToken(id),
    listTokensForAgent: (agentId) => client.listTokensForAgent(agentId),
  };
}

/**
 * The session alert sweeper (SESH-7.4). Gated on BOTH push being enabled and
 * the task-store client being configured: without either, every tick would be
 * a guaranteed no-op (or a guaranteed error log), so no pass is registered.
 */
function sessionAlertPass(
  ctx: AdminExtensionContext,
): AdminBackgroundPass | undefined {
  const taskStoreUrl = ctx.env.SHIPWRIGHT_TASK_STORE_URL;
  const taskStoreAdminToken = ctx.env.SHIPWRIGHT_TASK_STORE_ADMIN_TOKEN;
  if (!ctx.push || !taskStoreUrl || !taskStoreAdminToken) return undefined;
  const { agentMemberService, agentService, callerScopeResolver } =
    ctx.services;
  const adminTz = ctx.env.SHIPWRIGHT_ADMIN_TZ;
  const sweeper = new SessionAlertSweeper({
    prisma: ctx.prisma as never,
    pushService: ctx.push.service,
    agentMemberService,
    agentService,
    // SSP-6.8: account users are alerted only for their own account's
    // sessions (fetchSessions below lists every account's).
    callerScopeResolver,
    fetchSessions: async (state) => {
      const res = await fetch(
        `${taskStoreUrl}/sessions?state=${state}&limit=500`,
        {
          headers: { Authorization: `Bearer ${taskStoreAdminToken}` },
          // Bound the call so a hung task-store can't hold a sweep open past
          // the tick interval — tick()'s in-flight guard would then skip
          // every subsequent tick for as long as the socket stayed open.
          signal: AbortSignal.timeout(SESSION_ALERT_FETCH_TIMEOUT_MS),
        },
      );
      if (!res.ok) {
        throw new Error(
          `task-store GET /sessions?state=${state} → ${res.status}`,
        );
      }
      const body = (await res.json()) as { sessions?: SessionForAlert[] };
      return body.sessions ?? [];
    },
    // Same operator ceiling PushService got — without this the sweeper would
    // cap session pushes at DEFAULT_MAX_DETAIL ("title"), silently ignoring a
    // SHIPWRIGHT_ADMIN_PUSH_MAX_DETAIL=preview configuration.
    detailLevel: ctx.push.maxDetail,
    // Same allowlist createAdminUIApp gates on — an operator listed here sees
    // (and is alerted for) every session, membership or not.
    adminAllowedEmails: ctx.adminAllowedEmails,
    ...(adminTz ? { timezone: adminTz } : {}),
  });
  return {
    name: "session alert sweeper",
    logPrefix: "[session-alert-sweeper]",
    intervalMs: resolveSessionAlertIntervalMs(ctx.env),
    tick: () => sweeper.tick(),
  };
}

/**
 * The admin UI's task-store fetchers, built from SHIPWRIGHT_TASK_STORE_URL and
 * SHIPWRIGHT_TASK_STORE_ADMIN_TOKEN. Single admin token; each fetcher takes an
 * optional trailing accountId forwarded as ?accountId= so account users' views
 * are filtered by the task-store itself (SSP-6.8). Unconfigured → {} and the
 * task-store views render degraded.
 */
export function taskStoreFetchers(
  env: NodeJS.ProcessEnv,
): Partial<ReturnType<typeof createTaskStoreFetchers>> {
  const url = env.SHIPWRIGHT_TASK_STORE_URL;
  const adminToken = env.SHIPWRIGHT_TASK_STORE_ADMIN_TOKEN;
  return url && adminToken ? createTaskStoreFetchers({ url, adminToken }) : {};
}

// One AgentPhaseMethodologyService per Prisma client, shared by every hook.
const phaseMethodologyServices = new WeakMap<
  object,
  AgentPhaseMethodologyService
>();
function phaseMethodologyService(
  ctx: AdminExtensionContext,
): AgentPhaseMethodologyService {
  let service = phaseMethodologyServices.get(ctx.prisma);
  if (!service) {
    service = new AgentPhaseMethodologyService(ctx.prisma);
    phaseMethodologyServices.set(ctx.prisma, service);
  }
  return service;
}

export const codingAdminExtension: AdminExtension = {
  name: "coding",
  serviceIntegrations: (env) => [taskStoreServiceIntegration(env)],
  services: (ctx) => ({
    ui: {
      agentDetailErrorMessages: CODING_AGENT_DETAIL_ERROR_MESSAGES,
      queueActivityLinks: true,
    },
    agentPhaseMethodologyService: phaseMethodologyService(ctx),
  }),
  apiRoutes: (ctx) => [
    {
      path: "/",
      app: createCodingAdminApiApp({
        agentService: ctx.services.agentService,
        agentPhaseMethodologyService: phaseMethodologyService(ctx),
        agentWorkQueueService: new AgentWorkQueueService(ctx.prisma),
        devTaskAdherenceService: new DevTaskAdherenceService(
          ctx.prisma,
          undefined,
          taskStoreFetchers(ctx.env),
        ),
        agentTokenService: ctx.services.agentTokenService,
        agentMemberService: ctx.services.agentMemberService,
        callerScopeResolver: ctx.services.callerScopeResolver,
        sessionSecret: ctx.sessionSecret,
        adminApiKeys: ctx.adminApiKeys,
        ...(ctx.sentryClient ? { sentryClient: ctx.sentryClient } : {}),
        ...(ctx.pool ? { pool: ctx.pool } : {}),
      }),
    },
  ],
  adminUiRoutes: (ctx) => [
    {
      path: "/",
      app: createCodingAdminUIApp({
        ...taskStoreFetchers(ctx.env),
        prisma: ctx.prisma,
        sessionSecret: ctx.sessionSecret,
        appBaseUrl: ctx.appBaseUrl,
        ...(ctx.timezone ? { timezone: ctx.timezone } : {}),
        agentService: ctx.services.agentService,
        agentCronJobService: ctx.services.agentCronJobService,
        shipwrightLoopJobService: new ShipwrightLoopJobService(ctx.prisma),
        agentCronRunService: ctx.services.agentCronRunService,
        agentWorkQueueService: new AgentWorkQueueService(ctx.prisma),
        agentPhaseMethodologyService: phaseMethodologyService(ctx),
        agentMemberService: ctx.services.agentMemberService,
        callerScopeResolver: ctx.services.callerScopeResolver,
        // Repo slug for the public read-only task board (GET /public/tasks).
        // When set, the board renders unauthenticated, scoped to this repo;
        // when absent the route stays in degraded mode (no tasks).
        publicRepo: resolvePublicRepo(ctx.env),
        ...(ctx.push
          ? {
              pushService: ctx.push.service,
              vapidPublicKey: ctx.push.vapidPublicKey,
            }
          : {}),
      }),
    },
  ],
  agentDetailCards: (ctx) => {
    const { fetchVerificationChecks, fetchTaskStorePrs } = taskStoreFetchers(
      ctx.env,
    );
    return codingAgentDetailCards({
      agentCronRunService: ctx.services.agentCronRunService,
      agentGitHubInstallationsService:
        ctx.services.agentGitHubInstallationsService,
      agentPhaseMethodologyService: phaseMethodologyService(ctx),
      ...(fetchVerificationChecks ? { fetchVerificationChecks } : {}),
      ...(fetchTaskStorePrs ? { fetchTaskStorePrs } : {}),
    });
  },
  openApi: codingAdminOpenApi,
  backgroundPasses: (ctx) => {
    const pass = sessionAlertPass(ctx);
    return pass ? [pass] : [];
  },
};
