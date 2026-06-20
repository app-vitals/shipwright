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
 *   admin    → POST/PATCH/DELETE /agents/:id/envs, /crons, /tools, /tokens, /plugins
 */

import { join } from "node:path";
import { Hono } from "hono";
import { PrismaClient } from "../prisma/client/index.js";
import { createAdminApp, parseAdminApiKeys } from "./agents-api.ts";
import { createAdminUIApp } from "./admin-ui.ts";
import { AgentCronJobService } from "./agent-cron-jobs.ts";
import { AgentEnvService } from "./agent-envs.ts";
import { AgentPluginService } from "./agent-plugins.ts";
import type { AgentProvisioner } from "./agent-provisioner.ts";
import {
  KubernetesAgentProvisioner,
  NoopAgentProvisioner,
} from "./agent-provisioner.ts";
import { AgentTokenService } from "./agent-tokens.ts";
import { AgentToolService } from "./agent-tools.ts";
import { createAgentRuntimeApp } from "./api.ts";
import { isDevAuthAllowed } from "./dev-auth-guard.ts";
import { HttpGoogleAuthClient } from "./google-auth-client.ts";
import { HttpKubernetesClient } from "./kubernetes-client.ts";
import { HttpSlackProvisioningClient } from "./slack-provisioning-client.ts";
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
  const adminDeploymentName = env.SHIPWRIGHT_ADMIN_DEPLOYMENT_NAME ?? "";
  const adminDeploymentUid = env.SHIPWRIGHT_ADMIN_DEPLOYMENT_UID ?? "";
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

  const k8s = new HttpKubernetesClient();

  return new KubernetesAgentProvisioner(k8s, agentTokenService, {
    namespace,
    image,
    imageTag,
    apiUrl,
    adminDeploymentName,
    adminDeploymentUid,
    ...(replicas !== undefined && Number.isFinite(replicas)
      ? { replicas }
      : {}),
    ...(pvcStorageGi !== undefined && Number.isFinite(pvcStorageGi)
      ? { pvcStorageGi }
      : {}),
    ...(Object.keys(voice).length > 0 ? { voice } : {}),
    ...(pvcNameTemplate
      ? { pvcName: (name: string) => pvcNameTemplate.replace("{name}", name) }
      : {}),
  });
}

// ─── Server entry ─────────────────────────────────────────────────────────────

const DEFAULT_PORT = 3000;

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
  const agentToolService = new AgentToolService(prisma);
  const agentTokenService = new AgentTokenService(prisma);
  const agentPluginService = new AgentPluginService(prisma);

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
    agentToolService,
    agentTokenService,
    agentPluginService,
    prisma,
    provisioner,
    sessionSecret,
    adminApiKeys,
  });
  root.route("/", adminApiApp);

  // 4. Admin UI — /admin/* — session JWT
  const adminUIApp = createAdminUIApp({
    prisma: prisma as never,
    agentEnvService,
    agentCronJobService,
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
    devAuthEnabled: isDevAuthAllowed(process.env),
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
