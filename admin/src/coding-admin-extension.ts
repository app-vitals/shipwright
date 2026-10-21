/**
 * admin/src/coding-admin-extension.ts
 *
 * Shipwright's coding AdminExtension: the home for the coding agent's admin
 * surfaces (task-store views, dev-task adherence, work queue, sessions). Today
 * it registers the task-store service integration (per-agent task-store tokens
 * minted on provision and revoked on delete), the admin UI's task-store
 * fetchers, and the session alert sweeper. The routes and pages still mounted
 * by the platform UI/API files move here with the mixed-file split.
 */

import {
  resolveSessionAlertIntervalMs,
  SESSION_ALERT_FETCH_TIMEOUT_MS,
} from "./admin-boot-config.ts";
import type {
  AdminBackgroundPass,
  AdminExtension,
  AdminExtensionContext,
} from "./admin-extension.ts";
import { codingAgentDetailCards } from "./coding/admin-ui-agent-cards.ts";
import { AgentPhaseMethodologyService } from "./coding/agent-phase-methodology.ts";
import {
  SessionAlertSweeper,
  type SessionForAlert,
} from "./coding/session-alert-sweeper.ts";
import { createTaskStoreFetchers } from "./coding/task-store-fetchers.ts";
import {
  HttpTaskStoreProvisioningClient,
  NoopTaskStoreProvisioningClient,
} from "./coding-task-store-provisioning-client.ts";
import type { ServiceIntegration } from "./service-integration.ts";

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
function taskStoreFetchers(
  env: NodeJS.ProcessEnv,
): Partial<ReturnType<typeof createTaskStoreFetchers>> {
  const url = env.SHIPWRIGHT_TASK_STORE_URL;
  const adminToken = env.SHIPWRIGHT_TASK_STORE_ADMIN_TOKEN;
  return url && adminToken ? createTaskStoreFetchers({ url, adminToken }) : {};
}

export const codingAdminExtension: AdminExtension = {
  name: "coding",
  serviceIntegrations: (env) => [taskStoreServiceIntegration(env)],
  services: (ctx) => ({ ui: taskStoreFetchers(ctx.env) }),
  agentDetailCards: (ctx) => {
    const { fetchVerificationChecks, fetchTaskStorePrs } = taskStoreFetchers(
      ctx.env,
    );
    return codingAgentDetailCards({
      agentCronRunService: ctx.services.agentCronRunService,
      agentGitHubInstallationsService:
        ctx.services.agentGitHubInstallationsService,
      agentPhaseMethodologyService: new AgentPhaseMethodologyService(
        ctx.prisma,
      ),
      ...(fetchVerificationChecks ? { fetchVerificationChecks } : {}),
      ...(fetchTaskStorePrs ? { fetchTaskStorePrs } : {}),
    });
  },
  backgroundPasses: (ctx) => {
    const pass = sessionAlertPass(ctx);
    return pass ? [pass] : [];
  },
};
