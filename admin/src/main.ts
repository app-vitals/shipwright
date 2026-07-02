/**
 * admin/src/main.ts
 *
 * Standalone admin service entrypoint.
 * Runs migrations, creates services, and mounts all admin + runtime routes.
 *
 * Route mount order (important — avoids shadowing):
 *   GET  /health                 — health check (no auth)
 *   *    /agents/*               — runtime API  (admin key | per-agent bearer | session JWT)
 *                                  + admin CRUD API (admin key | per-agent bearer | session JWT)
 *   *    /admin/*                — admin UI       (session JWT)
 *
 * Both runtimeApp and adminApiApp serve routes under /agents/*.
 * They use non-overlapping sub-paths so Hono resolves them correctly:
 *   runtime  → GET  /agents/:id/config, GET /agents/:id/crons
 *   admin    → GET /agents/:id/crons/summary (enriched with run stats)
 *              POST/PATCH/DELETE /agents/:id/envs, /crons, /tools, /tokens, /plugins
 */

import { join } from "node:path";
import { Hono } from "hono";
import { PrismaClient } from "../prisma/client/index.js";
import type { PullRequestItem } from "./admin-ui-pages.ts";
import { createAdminUIApp } from "./admin-ui.ts";
import { AgentChatTokenService } from "./agent-chat-tokens.ts";
import { AgentCronJobService } from "./agent-cron-jobs.ts";
import { AgentCronRunStatsService } from "./agent-cron-run-stats.ts";
import { AgentCronRunService } from "./agent-cron-runs.ts";
import { AgentEnvService } from "./agent-envs.ts";
import { AgentPluginService } from "./agent-plugins.ts";
import type { AgentProvisioner } from "./agent-provisioner.ts";
import {
  KubernetesAgentProvisioner,
  NoopAgentProvisioner,
} from "./agent-provisioner.ts";
import { AgentTokenService } from "./agent-tokens.ts";
import { AgentToolService } from "./agent-tools.ts";
import { createAdminApp, parseAdminApiKeys } from "./agents-api.ts";
import { createAgentRuntimeApp } from "./api.ts";
import { isDevAuthAllowed } from "./dev-auth-guard.ts";
import { HttpGoogleAuthClient } from "./google-auth-client.ts";
import { HttpKubernetesClient } from "./kubernetes-client.ts";
import { HttpChatServiceProvisioningClient } from "./chat-service-provisioning-client.ts";
import { HttpSlackProvisioningClient } from "./slack-provisioning-client.ts";
import { HttpTaskStoreProvisioningClient } from "./task-store-provisioning-client.ts";
import { makeTokenCrypto } from "./token-crypto.ts";

// ─── Migration preflight ──────────────────────────────────────────────────────

/**
 * Runs `prisma migrate deploy` as a boot preflight.
 * Idempotent — safe to call on every startup. Throws on migration failure.
 */
async function runMigrations(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL_SHIPWRIGHT_ADMIN;
  if (!databaseUrl) {
    console.warn(
      "[admin] DATABASE_URL_SHIPWRIGHT_ADMIN not set — skipping prisma migrate deploy",
    );
    return;
  }

  console.log("[admin] running prisma migrate deploy...");

  const proc = Bun.spawn(
    ["bunx", "prisma", "migrate", "deploy", "--schema=prisma/schema.prisma"],
    {
      cwd: join(import.meta.dir, ".."),
      env: { ...process.env, DATABASE_URL_SHIPWRIGHT_ADMIN: databaseUrl },
      stdout: "pipe",
      stderr: "pipe",
    },
  );

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  await proc.exited;

  if (proc.exitCode !== 0) {
    console.error("[admin] prisma migrate deploy failed:");
    console.error(stderr);
    throw new Error(`prisma migrate deploy exited with code ${proc.exitCode}`);
  }

  if (stdout.trim()) {
    console.log("[admin]", stdout.trim());
  }

  console.log("[admin] migrations complete");
}

// ─── Provisioner selection ────────────────────────────────────────────────────

/**
 * Select the agent provisioner from the environment.
 *
 * When `SHIPWRIGHT_K8S_PROVISIONING=enabled`, construct a real
 * `KubernetesAgentProvisioner` that mints a per-agent token and creates the
 * backing Secret + Deployment in the cluster. Otherwise (unset / any other
 * value) return a `NoopAgentProvisioner` so create/delete behave exactly as
 * before — no cluster required. This keeps the new wiring safe to deploy
 * standalone behind the flag's default.
 */
function buildProvisioner(
  env: NodeJS.ProcessEnv,
  agentTokenService: AgentTokenService,
): AgentProvisioner {
  if (env.SHIPWRIGHT_K8S_PROVISIONING !== "enabled") {
    return new NoopAgentProvisioner();
  }

  const namespace = env.SHIPWRIGHT_K8S_NAMESPACE ?? "default";
  const image = env.SHIPWRIGHT_AGENT_IMAGE ?? "";
  const imageTag = env.SHIPWRIGHT_AGENT_IMAGE_TAG ?? "latest";
  const apiUrl = env.SHIPWRIGHT_API_URL ?? "";
  const replicasRaw = env.SHIPWRIGHT_AGENT_REPLICAS;
  const replicas = replicasRaw ? Number(replicasRaw) : undefined;
  const pvcStorageGiRaw = env.SHIPWRIGHT_AGENT_PVC_STORAGE_GI;
  const pvcStorageGi = pvcStorageGiRaw ? Number(pvcStorageGiRaw) : undefined;
  const pvcNameTemplate = env.SHIPWRIGHT_AGENT_PVC_NAME_TEMPLATE;

  // Agent-voice (STT/TTS) env flowed into provisioned agent pods. The chart's
  // voice Secret + Whisper Service URL land in the admin's env when
  // agent.voice.enabled; absent → voice disabled and no voice env is injected.
  const voice = {
    ...(env.WHISPER_SERVICE_URL
      ? { whisperServiceUrl: env.WHISPER_SERVICE_URL }
      : {}),
    ...(env.GROQ_API_KEY ? { groqApiKey: env.GROQ_API_KEY } : {}),
    ...(env.ELEVENLABS_API_KEY
      ? { elevenLabsApiKey: env.ELEVENLABS_API_KEY }
      : {}),
    ...(env.ELEVENLABS_VOICE_ID ? { voiceId: env.ELEVENLABS_VOICE_ID } : {}),
  };

  const taskStoreUrl = env.SHIPWRIGHT_TASK_STORE_URL;
  const taskStoreAdminToken = env.SHIPWRIGHT_TASK_STORE_ADMIN_TOKEN;
  const taskStore =
    taskStoreUrl && taskStoreAdminToken
      ? new HttpTaskStoreProvisioningClient(taskStoreUrl, taskStoreAdminToken)
      : undefined;

  const chatServiceUrl = env.SHIPWRIGHT_CHAT_SERVICE_URL;
  const chatServiceAdminToken = env.SHIPWRIGHT_CHAT_SERVICE_ADMIN_TOKEN;
  const chatService =
    chatServiceUrl && chatServiceAdminToken
      ? new HttpChatServiceProvisioningClient(
          chatServiceUrl,
          chatServiceAdminToken,
        )
      : undefined;

  const k8s = new HttpKubernetesClient();

  return new KubernetesAgentProvisioner(k8s, agentTokenService, {
    namespace,
    image,
    imageTag,
    apiUrl,
    ...(replicas !== undefined && Number.isFinite(replicas)
      ? { replicas }
      : {}),
    ...(pvcStorageGi !== undefined && Number.isFinite(pvcStorageGi)
      ? { pvcStorageGi }
      : {}),
    ...(Object.keys(voice).length > 0 ? { voice } : {}),
    // When SHIPWRIGHT_AGENT_PVC_NAME_TEMPLATE is set (e.g. "acme-agent-{name}-home"),
    // substitute {name} with the pre-sanitized name resolved by pvcNameFor()
    // (slug sanitized via sanitizeAgentName, or falls back to resourceName).
    // When unset, the provisioner uses the default `${resourceName}-home` naming.
    ...(pvcNameTemplate
      ? {
          pvcName: (name: string) => pvcNameTemplate.replace("{name}", name),
        }
      : {}),
    // Task-store token minting: when both SHIPWRIGHT_TASK_STORE_URL and
    // SHIPWRIGHT_TASK_STORE_ADMIN_TOKEN are set, mint a per-agent token on
    // provision and inject it into the agent Secret + Deployment.
    ...(taskStore ? { taskStore, taskStoreUrl } : {}),
    // Chat-service token minting: when both SHIPWRIGHT_CHAT_SERVICE_URL and
    // SHIPWRIGHT_CHAT_SERVICE_ADMIN_TOKEN are set, mint a per-agent token on
    // provision and inject it into the agent Secret + Deployment.
    ...(chatService ? { chatService, chatServiceUrl } : {}),
  });
}

// ─── Server entry ─────────────────────────────────────────────────────────────

const DEFAULT_PORT = 3000;

/**
 * Resolve the task-store base URL advertised in the admin mint-token env block.
 * Prefers the externally-reachable SHIPWRIGHT_TASK_STORE_PUBLIC_URL (so a
 * local/laptop agent can resolve it) and falls back to the internal
 * SHIPWRIGHT_TASK_STORE_URL when unset. The admin service's own in-cluster
 * task-store calls always use the internal URL — only the displayed value changes.
 */
export function resolveTaskStoreBaseUrl(
  env: Record<string, string | undefined>,
): string | undefined {
  return env.SHIPWRIGHT_TASK_STORE_PUBLIC_URL ?? env.SHIPWRIGHT_TASK_STORE_URL;
}

/**
 * Resolve the public read-only task board repo from the environment.
 * Reads SHIPWRIGHT_ADMIN_PUBLIC_REPO; trims whitespace so a blank/whitespace
 * value behaves like unset (returns undefined → board stays in degraded mode)
 * rather than producing an empty repo filter.
 */
export function resolvePublicRepo(
  env: Record<string, string | undefined>,
): string | undefined {
  return env.SHIPWRIGHT_ADMIN_PUBLIC_REPO?.trim() || undefined;
}

async function startServer(): Promise<void> {
  const port = Number(process.env.PORT ?? DEFAULT_PORT);

  console.log(`[admin] starting admin service on port ${port}`);

  // Run DB migrations as idempotent preflight
  await runMigrations();

  // Construct PrismaClient once at boot
  const prisma = new PrismaClient();

  // Construct TokenCrypto — reads SHIPWRIGHT_ENCRYPTION_KEY at call time
  const crypto = makeTokenCrypto();

  // Construct all services with injected deps
  const agentEnvService = new AgentEnvService(prisma, crypto);
  const agentCronJobService = new AgentCronJobService(prisma);
  const agentCronRunService = new AgentCronRunService(prisma);
  const agentToolService = new AgentToolService(prisma);
  const agentTokenService = new AgentTokenService(prisma);
  const agentPluginService = new AgentPluginService(prisma);
  const agentChatTokenService = new AgentChatTokenService(prisma);
  const agentCronRunStatsService = new AgentCronRunStatsService(prisma);

  // Real K8s provisioner when SHIPWRIGHT_K8S_PROVISIONING=enabled, else Noop.
  const provisioner = buildProvisioner(process.env, agentTokenService);

  // Read config values at call time (no module-level env reads)
  const sessionSecret = process.env.SHIPWRIGHT_SESSION_SECRET ?? "";
  const googleClientId = process.env.GOOGLE_CLIENT_ID ?? "";
  const googleClientSecret = process.env.GOOGLE_CLIENT_SECRET ?? "";
  const adminAllowedEmails = (process.env.SHIPWRIGHT_ADMIN_ALLOWED_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim())
    .filter(Boolean);
  const appBaseUrl =
    process.env.SHIPWRIGHT_ADMIN_APP_BASE_URL ?? `http://localhost:${port}`;
  const adminApiKeys = parseAdminApiKeys(process.env.SHIPWRIGHT_ADMIN_API_KEYS);
  // Repo slug for the public read-only task board (GET /public/tasks). When set,
  // the board renders unauthenticated, scoped to this repo; when absent the route
  // stays in degraded mode (no tasks).
  const publicRepo = resolvePublicRepo(process.env);

  const googleClient = new HttpGoogleAuthClient();
  const slackClient = new HttpSlackProvisioningClient();

  const root = new Hono();

  // 1. Health check — no auth
  root.get("/health", (c) => c.json({ status: "ok" }));

  // Redirect bare root to the login page — no handler exists at "/" otherwise.
  root.get("/", (c) => c.redirect("/admin/login", 302));

  // 2. Runtime API — admin key | per-agent bearer | session JWT
  //    Mounted via root.route("/agents", runtimeApp). Hono v4 strips the prefix
  //    before dispatching, so runtimeApp routes are registered as /:id/config
  //    and /:id/crons (without the /agents prefix) and resolve correctly at
  //    GET /agents/:id/config and GET /agents/:id/crons from root.
  const runtimeApp = createAgentRuntimeApp({
    agentEnvService,
    agentCronJobService,
    prisma: prisma as never,
    sessionSecret,
    adminApiKeys,
    agentTokenService,
  });

  root.route("/agents", runtimeApp);

  // 3. Admin CRUD API — /agents/:id/* — admin key | per-agent bearer | session JWT
  //    Routes are now at /agents/:id/* (same prefix as runtime, different sub-paths).
  //    MUST be mounted before admin-ui (/admin/*) to avoid shadowing.
  const adminApiApp = createAdminApp({
    agentEnvService,
    agentCronJobService,
    agentCronRunService,
    agentCronRunStatsService,
    agentToolService,
    agentTokenService,
    agentPluginService,
    agentChatTokenService,
    prisma,
    provisioner,
    sessionSecret,
    adminApiKeys,
  });
  root.route("/", adminApiApp);

  // 4. Admin UI — /admin/* — session JWT
  const taskStoreUrl = process.env.SHIPWRIGHT_TASK_STORE_URL;
  const taskStoreAdminToken = process.env.SHIPWRIGHT_TASK_STORE_ADMIN_TOKEN;
  const taskStoreFetchers =
    taskStoreUrl && taskStoreAdminToken
      ? {
          fetchTaskStoreTasks: async (params: URLSearchParams) => {
            const url = `${taskStoreUrl}/tasks${params.size > 0 ? `?${params}` : ""}`;
            const res = await fetch(url, {
              headers: { Authorization: `Bearer ${taskStoreAdminToken}` },
            });
            if (!res.ok)
              throw new Error(`task-store GET /tasks → ${res.status}`);
            return res.json();
          },
          fetchTaskStoreTask: async (id: string) => {
            const res = await fetch(`${taskStoreUrl}/tasks/${id}`, {
              headers: { Authorization: `Bearer ${taskStoreAdminToken}` },
            });
            if (res.status === 404) return null;
            if (!res.ok)
              throw new Error(`task-store GET /tasks/${id} → ${res.status}`);
            return res.json();
          },
          releaseTask: async (id: string) => {
            const res = await fetch(`${taskStoreUrl}/tasks/${id}/release`, {
              method: "POST",
              headers: { Authorization: `Bearer ${taskStoreAdminToken}` },
            });
            if (!res.ok)
              throw new Error(
                `task-store POST /tasks/${id}/release → ${res.status}`,
              );
          },
          fetchDistinctTaskValues: async () => {
            const res = await fetch(`${taskStoreUrl}/tasks/distinct`, {
              headers: { Authorization: `Bearer ${taskStoreAdminToken}` },
            });
            if (!res.ok)
              throw new Error(`task-store GET /tasks/distinct → ${res.status}`);
            return res.json() as Promise<{
              sessions: string[];
              repos: string[];
            }>;
          },
          fetchTaskStorePr: async (taskId: string) => {
            const res = await fetch(
              `${taskStoreUrl}/prs?taskId=${encodeURIComponent(taskId)}`,
              {
                headers: { Authorization: `Bearer ${taskStoreAdminToken}` },
              },
            );
            if (res.status === 404) return null;
            if (!res.ok)
              throw new Error(
                `task-store GET /prs?taskId=${taskId} → ${res.status}`,
              );
            const data = (await res.json()) as { prs?: unknown[] };
            const prs = data.prs ?? [];
            return prs.length > 0 ? (prs[0] as PullRequestItem) : null;
          },
          fetchTaskStorePrs: async (params: URLSearchParams) => {
            const url = `${taskStoreUrl}/prs${params.size > 0 ? `?${params}` : ""}`;
            const res = await fetch(url, {
              headers: { Authorization: `Bearer ${taskStoreAdminToken}` },
            });
            if (!res.ok) throw new Error(`task-store GET /prs → ${res.status}`);
            return res.json();
          },
          fetchTaskStorePrById: async (id: string) => {
            const res = await fetch(`${taskStoreUrl}/prs/${id}`, {
              headers: { Authorization: `Bearer ${taskStoreAdminToken}` },
            });
            if (res.status === 404) return null;
            if (!res.ok)
              throw new Error(`task-store GET /prs/${id} → ${res.status}`);
            return res.json();
          },
          adminListTokens: async () => {
            const res = await fetch(`${taskStoreUrl}/tokens`, {
              headers: { Authorization: `Bearer ${taskStoreAdminToken}` },
            });
            if (!res.ok)
              throw new Error(`task-store GET /tokens → ${res.status}`);
            return res.json();
          },
          adminCreateToken: async (label?: string, agentId?: string) => {
            const res = await fetch(`${taskStoreUrl}/tokens`, {
              method: "POST",
              headers: {
                Authorization: `Bearer ${taskStoreAdminToken}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({ label, agentId }),
            });
            if (!res.ok)
              throw new Error(`task-store POST /tokens → ${res.status}`);
            return res.json();
          },
          adminRevokeToken: async (id: string) => {
            const res = await fetch(`${taskStoreUrl}/tokens/${id}`, {
              method: "DELETE",
              headers: { Authorization: `Bearer ${taskStoreAdminToken}` },
            });
            if (!res.ok)
              throw new Error(
                `task-store DELETE /tokens/${id} → ${res.status}`,
              );
          },
          // Advertise the PUBLIC task-store URL in the mint-token env block so a
          // local/laptop agent can resolve it; the in-cluster fetchers above keep
          // using the internal SHIPWRIGHT_TASK_STORE_URL.
          taskStoreBaseUrl: resolveTaskStoreBaseUrl(process.env),
        }
      : {};

  // Validate SHIPWRIGHT_ADMIN_TZ at startup — toLocaleDateString/toLocaleString
  // will throw RangeError at render time if the timezone is invalid, causing a 500
  // on every admin page. Catch it early with a clean error and exit.
  const adminTz = process.env.SHIPWRIGHT_ADMIN_TZ;
  if (adminTz) {
    try {
      Intl.DateTimeFormat(undefined, { timeZone: adminTz });
    } catch {
      console.error("[admin] Invalid SHIPWRIGHT_ADMIN_TZ:", adminTz);
      process.exit(1);
    }
  }

  const adminUIApp = createAdminUIApp({
    prisma: prisma as never,
    agentEnvService,
    agentCronJobService,
    agentCronRunService,
    agentToolService,
    agentTokenService,
    agentPluginService,
    provisioner,
    sessionSecret,
    googleClientId,
    googleClientSecret,
    adminAllowedEmails,
    googleClient,
    slackClient,
    appBaseUrl,
    publicRepo,
    devAuthEnabled: isDevAuthAllowed(process.env),
    timezone: adminTz,
    ...taskStoreFetchers,
  });
  root.route("/", adminUIApp);

  Bun.serve({ fetch: root.fetch, port });

  console.log(`[admin] admin service listening on port ${port}`);
}

// Run directly when invoked as main entry
if (import.meta.main) {
  startServer().catch((err) => {
    console.error("[admin] fatal startup error:", err);
    process.exit(1);
  });
}
