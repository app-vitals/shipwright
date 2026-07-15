import { afterEach, describe, expect, it } from "bun:test";
import type {
  AgentProvisioner,
  KubernetesAgentProvisionerConfig,
} from "./agent-provisioner.ts";
import {
  KubernetesAgentProvisioner,
  NoopAgentProvisioner,
} from "./agent-provisioner.ts";
import type { AgentTokenService } from "./agent-tokens.ts";
import {
  buildProvisioner,
  checkDbReady,
  resolvePublicRepo,
  resolveTaskStoreBaseUrl,
  runMigrations,
} from "./main.ts";

/** Stub token service — buildProvisioner only threads it through, never calls it. */
function stubAgentTokenService(): AgentTokenService {
  return {} as unknown as AgentTokenService;
}

/** Reaches into the private `config` field so branch behavior is actually verifiable. */
function configOf(
  provisioner: AgentProvisioner,
): KubernetesAgentProvisionerConfig {
  return (
    provisioner as unknown as { config: KubernetesAgentProvisionerConfig }
  ).config;
}

// resolvePublicRepo is the pure env rule wired into main.ts startServer():
// it sources SHIPWRIGHT_ADMIN_PUBLIC_REPO and feeds createAdminUIApp's
// publicRepo option, which gates the unauthenticated GET /public/tasks board.
// Tested without touching process.env.
describe("resolvePublicRepo", () => {
  it("returns the repo slug when set", () => {
    expect(
      resolvePublicRepo({
        SHIPWRIGHT_ADMIN_PUBLIC_REPO: "app-vitals/shipwright",
      }),
    ).toBe("app-vitals/shipwright");
  });

  it("returns undefined when unset (board stays in degraded mode)", () => {
    expect(resolvePublicRepo({})).toBeUndefined();
  });

  it("treats an empty string as unset", () => {
    expect(
      resolvePublicRepo({ SHIPWRIGHT_ADMIN_PUBLIC_REPO: "" }),
    ).toBeUndefined();
  });

  it("treats whitespace-only as unset rather than an empty repo filter", () => {
    expect(
      resolvePublicRepo({ SHIPWRIGHT_ADMIN_PUBLIC_REPO: "   " }),
    ).toBeUndefined();
  });

  it("trims surrounding whitespace from a valid value", () => {
    expect(
      resolvePublicRepo({
        SHIPWRIGHT_ADMIN_PUBLIC_REPO: "  app-vitals/shipwright  ",
      }),
    ).toBe("app-vitals/shipwright");
  });
});

// ─── resolveTaskStoreBaseUrl ────────────────────────────────────────────────

// resolveTaskStoreBaseUrl is the pure env rule feeding the admin mint-token
// display block: prefers the externally-reachable PUBLIC url, falls back to
// the internal one, and is undefined when neither is set.
describe("resolveTaskStoreBaseUrl", () => {
  it("prefers SHIPWRIGHT_TASK_STORE_PUBLIC_URL when both are set", () => {
    expect(
      resolveTaskStoreBaseUrl({
        SHIPWRIGHT_TASK_STORE_PUBLIC_URL: "https://public.example.com",
        SHIPWRIGHT_TASK_STORE_URL: "http://internal.svc.cluster.local:3002",
      }),
    ).toBe("https://public.example.com");
  });

  it("falls back to SHIPWRIGHT_TASK_STORE_URL when the public url is unset", () => {
    expect(
      resolveTaskStoreBaseUrl({
        SHIPWRIGHT_TASK_STORE_URL: "http://internal.svc.cluster.local:3002",
      }),
    ).toBe("http://internal.svc.cluster.local:3002");
  });

  it("returns undefined when neither is set", () => {
    expect(resolveTaskStoreBaseUrl({})).toBeUndefined();
  });
});

// ─── buildProvisioner ───────────────────────────────────────────────────────

describe("buildProvisioner", () => {
  it("returns a NoopAgentProvisioner when SHIPWRIGHT_K8S_PROVISIONING is unset", () => {
    const provisioner = buildProvisioner({}, stubAgentTokenService());
    expect(provisioner).toBeInstanceOf(NoopAgentProvisioner);
  });

  it("returns a NoopAgentProvisioner for any value other than 'enabled'", () => {
    const provisioner = buildProvisioner(
      { SHIPWRIGHT_K8S_PROVISIONING: "true" },
      stubAgentTokenService(),
    );
    expect(provisioner).toBeInstanceOf(NoopAgentProvisioner);
  });

  it("returns a KubernetesAgentProvisioner when SHIPWRIGHT_K8S_PROVISIONING=enabled", () => {
    const provisioner = buildProvisioner(
      { SHIPWRIGHT_K8S_PROVISIONING: "enabled" },
      stubAgentTokenService(),
    );
    expect(provisioner).toBeInstanceOf(KubernetesAgentProvisioner);
  });

  it("builds with defaults when only the flag is set", () => {
    const provisioner = buildProvisioner(
      { SHIPWRIGHT_K8S_PROVISIONING: "enabled" },
      stubAgentTokenService(),
    );
    const config = configOf(provisioner);
    expect(config.namespace).toBe("default");
    expect(config.image).toBe("");
    expect(config.imageTag).toBe("latest");
    expect(config.apiUrl).toBe("");
    expect(config.replicas).toBeUndefined();
    expect(config.pvcStorageGi).toBeUndefined();
    expect(config.voice).toBeUndefined();
    expect(config.taskStore).toBeUndefined();
    expect(config.chatService).toBeUndefined();
    expect(config.pvcName).toBeUndefined();
  });

  it("parses numeric env (replicas, pvcStorageGi) when set and finite", () => {
    const provisioner = buildProvisioner(
      {
        SHIPWRIGHT_K8S_PROVISIONING: "enabled",
        SHIPWRIGHT_AGENT_REPLICAS: "3",
        SHIPWRIGHT_AGENT_PVC_STORAGE_GI: "80",
      },
      stubAgentTokenService(),
    );
    const config = configOf(provisioner);
    expect(config.replicas).toBe(3);
    expect(config.pvcStorageGi).toBe(80);
  });

  it("ignores non-finite numeric env (NaN) rather than passing it through", () => {
    const provisioner = buildProvisioner(
      {
        SHIPWRIGHT_K8S_PROVISIONING: "enabled",
        SHIPWRIGHT_AGENT_REPLICAS: "not-a-number",
      },
      stubAgentTokenService(),
    );
    const config = configOf(provisioner);
    expect(config.replicas).toBeUndefined();
  });

  it("builds a voice env block only from the voice vars that are set", () => {
    const provisioner = buildProvisioner(
      {
        SHIPWRIGHT_K8S_PROVISIONING: "enabled",
        WHISPER_SERVICE_URL: "http://whisper.svc:9000",
        GROQ_API_KEY: "groq-key",
        ELEVENLABS_API_KEY: "elevenlabs-key",
        ELEVENLABS_VOICE_ID: "voice-1",
      },
      stubAgentTokenService(),
    );
    const config = configOf(provisioner);
    expect(config.voice).toEqual({
      whisperServiceUrl: "http://whisper.svc:9000",
      groqApiKey: "groq-key",
      elevenLabsApiKey: "elevenlabs-key",
      voiceId: "voice-1",
    });
  });

  it("omits the voice block entirely when no voice env vars are set", () => {
    const provisioner = buildProvisioner(
      { SHIPWRIGHT_K8S_PROVISIONING: "enabled" },
      stubAgentTokenService(),
    );
    expect(configOf(provisioner).voice).toBeUndefined();
  });

  it("wires a task-store client only when both URL and admin token are set", () => {
    const withTaskStore = buildProvisioner(
      {
        SHIPWRIGHT_K8S_PROVISIONING: "enabled",
        SHIPWRIGHT_TASK_STORE_URL: "http://task-store.svc:3002",
        SHIPWRIGHT_TASK_STORE_ADMIN_TOKEN: "ts-admin-token",
      },
      stubAgentTokenService(),
    );
    const withConfig = configOf(withTaskStore);
    expect(withConfig.taskStore).toBeDefined();
    expect(withConfig.taskStoreUrl).toBe("http://task-store.svc:3002");

    const withoutTaskStore = buildProvisioner(
      {
        SHIPWRIGHT_K8S_PROVISIONING: "enabled",
        SHIPWRIGHT_TASK_STORE_URL: "http://task-store.svc:3002",
        // admin token missing
      },
      stubAgentTokenService(),
    );
    expect(configOf(withoutTaskStore).taskStore).toBeUndefined();
    expect(configOf(withoutTaskStore).taskStoreUrl).toBeUndefined();
  });

  it("wires a chat-service client only when both URL and admin token are set", () => {
    const withChatService = buildProvisioner(
      {
        SHIPWRIGHT_K8S_PROVISIONING: "enabled",
        SHIPWRIGHT_CHAT_SERVICE_URL: "http://chat.svc:3003",
        SHIPWRIGHT_CHAT_SERVICE_ADMIN_TOKEN: "chat-admin-token",
      },
      stubAgentTokenService(),
    );
    const withConfig = configOf(withChatService);
    expect(withConfig.chatService).toBeDefined();
    expect(withConfig.chatServiceUrl).toBe("http://chat.svc:3003");

    const withoutChatService = buildProvisioner(
      {
        SHIPWRIGHT_K8S_PROVISIONING: "enabled",
        SHIPWRIGHT_CHAT_SERVICE_URL: "http://chat.svc:3003",
        // admin token missing
      },
      stubAgentTokenService(),
    );
    expect(configOf(withoutChatService).chatService).toBeUndefined();
    expect(configOf(withoutChatService).chatServiceUrl).toBeUndefined();
  });

  it("sets a pvcName template function when SHIPWRIGHT_AGENT_PVC_NAME_TEMPLATE is set", () => {
    const provisioner = buildProvisioner(
      {
        SHIPWRIGHT_K8S_PROVISIONING: "enabled",
        SHIPWRIGHT_AGENT_PVC_NAME_TEMPLATE: "acme-agent-{name}-home",
      },
      stubAgentTokenService(),
    );
    const config = configOf(provisioner);
    expect(config.pvcName).toBeDefined();
    expect(config.pvcName?.("my-agent")).toBe("acme-agent-my-agent-home");
  });
});

// ─── runMigrations ──────────────────────────────────────────────────────────

// Only the early-return branch (DATABASE_URL_SHIPWRIGHT_ADMIN unset) is safe
// to unit-test directly — it returns before touching Prisma or Bun.spawn. The
// Bun.spawn("bunx prisma migrate deploy") path requires a real Postgres and is
// process-wiring / real-I/O, exercised in deployed environments instead.
describe("runMigrations", () => {
  const originalUrl = process.env.DATABASE_URL_SHIPWRIGHT_ADMIN;

  afterEach(() => {
    if (originalUrl === undefined) {
      process.env.DATABASE_URL_SHIPWRIGHT_ADMIN = undefined;
    } else {
      process.env.DATABASE_URL_SHIPWRIGHT_ADMIN = originalUrl;
    }
  });

  it("returns early without spawning a process when DATABASE_URL_SHIPWRIGHT_ADMIN is unset", async () => {
    process.env.DATABASE_URL_SHIPWRIGHT_ADMIN = undefined;
    await expect(runMigrations()).resolves.toBeUndefined();
  });
});

// ─── checkDbReady ────────────────────────────────────────────────────────────

// Backs GET /health/ready. Exercised here with a mocked $queryRaw (no real
// Postgres) — the real query is a plain `SELECT 1` ping.
describe("checkDbReady", () => {
  it("returns true when the DB is reachable", async () => {
    const prisma = { $queryRaw: async () => [{ "?column?": 1 }] };
    await expect(checkDbReady(prisma)).resolves.toBe(true);
  });

  it("returns false when the DB is unreachable", async () => {
    const prisma = {
      $queryRaw: async () => {
        throw new Error("Can't reach database server at 127.0.0.1:5432");
      },
    };
    await expect(checkDbReady(prisma)).resolves.toBe(false);
  });
});
