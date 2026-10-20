import { afterEach, describe, expect, it } from "bun:test";
import type { PrismaClient } from "../prisma/client/client.ts";
import { collectServiceIntegrations } from "./admin-extension.ts";
import { AgentAnthropicIdentityService } from "./agent-anthropic-identity.ts";
import type {
  AgentProvisioner,
  KubernetesAgentProvisionerConfig,
} from "./agent-provisioner.ts";
import {
  KubernetesAgentProvisioner,
  NoopAgentProvisioner,
} from "./agent-provisioner.ts";
import type { AgentTokenService } from "./agent-tokens.ts";
import { HttpAnthropicIdentityClient } from "./anthropic-identity-client.ts";
import { AnthropicIdentityNameAllocator } from "./anthropic-identity-name.ts";
import {
  adminExtensions,
  buildProvisioner,
  checkDbReady,
  DEFAULT_SESSION_ALERT_INTERVAL_MS,
  isAnthropicFederationEnabled,
  parseAnthropicFederation,
  resolvePublicRepo,
  resolveSessionAlertIntervalMs,
  resolveTrialExpiryWarningDays,
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
    expect(config.serviceIntegrations).toBeUndefined();
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

  it("passes claudePolicy through when the policy ConfigMap env is set", () => {
    const provisioner = buildProvisioner(
      {
        SHIPWRIGHT_K8S_PROVISIONING: "enabled",
        SHIPWRIGHT_K8S_AGENT_CLAUDE_POLICY_CONFIGMAP: "claude-policy",
        SHIPWRIGHT_K8S_AGENT_CLAUDE_POLICY_HASH: "abc123",
      },
      stubAgentTokenService(),
    );
    expect(configOf(provisioner).claudePolicy).toEqual({
      configMapName: "claude-policy",
      hash: "abc123",
    });
  });

  it("omits the hash when only the ConfigMap env is set", () => {
    const provisioner = buildProvisioner(
      {
        SHIPWRIGHT_K8S_PROVISIONING: "enabled",
        SHIPWRIGHT_K8S_AGENT_CLAUDE_POLICY_CONFIGMAP: "claude-policy",
      },
      stubAgentTokenService(),
    );
    expect(configOf(provisioner).claudePolicy).toEqual({
      configMapName: "claude-policy",
    });
  });

  it("omits claudePolicy when the ConfigMap env is unset or empty", () => {
    for (const cm of [undefined, ""]) {
      const provisioner = buildProvisioner(
        {
          SHIPWRIGHT_K8S_PROVISIONING: "enabled",
          SHIPWRIGHT_K8S_AGENT_CLAUDE_POLICY_CONFIGMAP: cm,
          SHIPWRIGHT_K8S_AGENT_CLAUDE_POLICY_HASH: "abc123",
        },
        stubAgentTokenService(),
      );
      expect(configOf(provisioner).claudePolicy).toBeUndefined();
    }
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

  it("wires the coding extension's task-store integration only when both URL and admin token are set", () => {
    const withEnv = {
      SHIPWRIGHT_K8S_PROVISIONING: "enabled",
      SHIPWRIGHT_TASK_STORE_URL: "http://task-store.svc:3002",
      SHIPWRIGHT_TASK_STORE_ADMIN_TOKEN: "ts-admin-token",
    };
    const withTaskStore = buildProvisioner(
      withEnv,
      stubAgentTokenService(),
      undefined,
      collectServiceIntegrations(adminExtensions, withEnv),
    );
    const integrations = configOf(withTaskStore).serviceIntegrations ?? [];
    expect(integrations.map((i) => i.name)).toEqual(["task-store"]);
    expect(integrations[0]?.url).toBe("http://task-store.svc:3002");

    // Admin token missing: the integration is still registered (so deletion
    // keeps its step) but carries no URL, so provisioning skips it.
    const withoutEnv = {
      SHIPWRIGHT_K8S_PROVISIONING: "enabled",
      SHIPWRIGHT_TASK_STORE_URL: "http://task-store.svc:3002",
    };
    const withoutTaskStore = buildProvisioner(
      withoutEnv,
      stubAgentTokenService(),
      undefined,
      collectServiceIntegrations(adminExtensions, withoutEnv),
    );
    const skipped = configOf(withoutTaskStore).serviceIntegrations ?? [];
    expect(skipped.map((i) => i.url)).toEqual([undefined]);
  });

  it("registers no integration for a bare platform (no extensions)", () => {
    const provisioner = buildProvisioner(
      {
        SHIPWRIGHT_K8S_PROVISIONING: "enabled",
        SHIPWRIGHT_TASK_STORE_URL: "http://task-store.svc:3002",
        SHIPWRIGHT_TASK_STORE_ADMIN_TOKEN: "ts-admin-token",
      },
      stubAgentTokenService(),
    );
    expect(configOf(provisioner).serviceIntegrations).toBeUndefined();
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

  it("omits the resources block entirely when no SHIPWRIGHT_K8S_AGENT_* vars are set", () => {
    const provisioner = buildProvisioner(
      { SHIPWRIGHT_K8S_PROVISIONING: "enabled" },
      stubAgentTokenService(),
    );
    expect(configOf(provisioner).resources).toBeUndefined();
  });

  it("parses SHIPWRIGHT_K8S_AGENT_CPU_REQUEST individually", () => {
    const provisioner = buildProvisioner(
      {
        SHIPWRIGHT_K8S_PROVISIONING: "enabled",
        SHIPWRIGHT_K8S_AGENT_CPU_REQUEST: "1000m",
      },
      stubAgentTokenService(),
    );
    expect(configOf(provisioner).resources).toEqual({ cpuRequest: "1000m" });
  });

  it("parses SHIPWRIGHT_K8S_AGENT_MEMORY_REQUEST individually", () => {
    const provisioner = buildProvisioner(
      {
        SHIPWRIGHT_K8S_PROVISIONING: "enabled",
        SHIPWRIGHT_K8S_AGENT_MEMORY_REQUEST: "4Gi",
      },
      stubAgentTokenService(),
    );
    expect(configOf(provisioner).resources).toEqual({
      memoryRequest: "4Gi",
    });
  });

  it("parses SHIPWRIGHT_K8S_AGENT_MEMORY_LIMIT individually", () => {
    const provisioner = buildProvisioner(
      {
        SHIPWRIGHT_K8S_PROVISIONING: "enabled",
        SHIPWRIGHT_K8S_AGENT_MEMORY_LIMIT: "16Gi",
      },
      stubAgentTokenService(),
    );
    expect(configOf(provisioner).resources).toEqual({
      memoryLimit: "16Gi",
    });
  });

  it("parses SHIPWRIGHT_K8S_AGENT_EPHEMERAL_STORAGE individually", () => {
    const provisioner = buildProvisioner(
      {
        SHIPWRIGHT_K8S_PROVISIONING: "enabled",
        SHIPWRIGHT_K8S_AGENT_EPHEMERAL_STORAGE: "8Gi",
      },
      stubAgentTokenService(),
    );
    expect(configOf(provisioner).resources).toEqual({
      ephemeralStorage: "8Gi",
    });
  });

  it("parses all four SHIPWRIGHT_K8S_AGENT_* vars together", () => {
    const provisioner = buildProvisioner(
      {
        SHIPWRIGHT_K8S_PROVISIONING: "enabled",
        SHIPWRIGHT_K8S_AGENT_CPU_REQUEST: "2000m",
        SHIPWRIGHT_K8S_AGENT_MEMORY_REQUEST: "3Gi",
        SHIPWRIGHT_K8S_AGENT_MEMORY_LIMIT: "10Gi",
        SHIPWRIGHT_K8S_AGENT_EPHEMERAL_STORAGE: "6Gi",
      },
      stubAgentTokenService(),
    );
    expect(configOf(provisioner).resources).toEqual({
      cpuRequest: "2000m",
      memoryRequest: "3Gi",
      memoryLimit: "10Gi",
      ephemeralStorage: "6Gi",
    });
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

  // ─── Anthropic workload identity federation ───────────────────────────────

  const FEDERATION_ENV = {
    SHIPWRIGHT_K8S_PROVISIONING: "enabled",
    SHIPWRIGHT_K8S_AGENT_SERVICE_ACCOUNT: "shipwright-agent",
    SHIPWRIGHT_K8S_AGENT_ANTHROPIC_FEDERATION_RULE_ID: "fdrl_1",
    SHIPWRIGHT_K8S_AGENT_ANTHROPIC_FEDERATION_ORGANIZATION_ID: "org-1",
    SHIPWRIGHT_K8S_AGENT_ANTHROPIC_FEDERATION_SERVICE_ACCOUNT_ID: "svac_1",
  };

  it("leaves federation disabled when the rule ID is unset", () => {
    const { SHIPWRIGHT_K8S_AGENT_ANTHROPIC_FEDERATION_RULE_ID: _, ...rest } =
      FEDERATION_ENV;
    for (const env of [
      rest,
      { ...rest, SHIPWRIGHT_K8S_AGENT_ANTHROPIC_FEDERATION_RULE_ID: "" },
    ]) {
      const config = configOf(buildProvisioner(env, stubAgentTokenService()));
      expect(config.anthropicFederation).toBeUndefined();
      expect("anthropicFederation" in config).toBe(false);
    }
  });

  it("parses the federation config with default audience and expiration", () => {
    const provisioner = buildProvisioner(
      FEDERATION_ENV,
      stubAgentTokenService(),
    );
    expect(configOf(provisioner).anthropicFederation).toEqual({
      serviceAccountName: "shipwright-agent",
      ruleId: "fdrl_1",
      organizationId: "org-1",
      serviceAccountId: "svac_1",
      audience: "https://api.anthropic.com",
      expirationSeconds: 600,
    });
  });

  it("parses the optional workspace, audience and expiration overrides", () => {
    const provisioner = buildProvisioner(
      {
        ...FEDERATION_ENV,
        SHIPWRIGHT_K8S_AGENT_ANTHROPIC_FEDERATION_WORKSPACE_ID: "wrkspc_1",
        SHIPWRIGHT_K8S_AGENT_ANTHROPIC_FEDERATION_AUDIENCE:
          "https://example.test",
        SHIPWRIGHT_K8S_AGENT_ANTHROPIC_FEDERATION_TOKEN_EXPIRATION_SECONDS:
          "3600",
      },
      stubAgentTokenService(),
    );
    expect(configOf(provisioner).anthropicFederation).toEqual({
      serviceAccountName: "shipwright-agent",
      ruleId: "fdrl_1",
      organizationId: "org-1",
      serviceAccountId: "svac_1",
      workspaceId: "wrkspc_1",
      audience: "https://example.test",
      expirationSeconds: 3600,
    });
  });

  for (const missing of [
    "SHIPWRIGHT_K8S_AGENT_SERVICE_ACCOUNT",
    "SHIPWRIGHT_K8S_AGENT_ANTHROPIC_FEDERATION_ORGANIZATION_ID",
    "SHIPWRIGHT_K8S_AGENT_ANTHROPIC_FEDERATION_SERVICE_ACCOUNT_ID",
  ] as const) {
    it(`fails startup on a partial federation config (missing ${missing})`, () => {
      const env = { ...FEDERATION_ENV, [missing]: "" };
      expect(() => buildProvisioner(env, stubAgentTokenService())).toThrow(
        missing,
      );
    });
  }

  it("names every missing variable in a single error", () => {
    expect(() =>
      buildProvisioner(
        {
          SHIPWRIGHT_K8S_PROVISIONING: "enabled",
          SHIPWRIGHT_K8S_AGENT_ANTHROPIC_FEDERATION_RULE_ID: "fdrl_1",
        },
        stubAgentTokenService(),
      ),
    ).toThrow(
      /SHIPWRIGHT_K8S_AGENT_SERVICE_ACCOUNT.*ORGANIZATION_ID.*SERVICE_ACCOUNT_ID/,
    );
  });

  for (const bad of ["abc", "599", "0", "-600", "600.5"]) {
    it(`rejects token expiration ${JSON.stringify(bad)}`, () => {
      expect(() =>
        buildProvisioner(
          {
            ...FEDERATION_ENV,
            SHIPWRIGHT_K8S_AGENT_ANTHROPIC_FEDERATION_TOKEN_EXPIRATION_SECONDS:
              bad,
          },
          stubAgentTokenService(),
        ),
      ).toThrow(
        "SHIPWRIGHT_K8S_AGENT_ANTHROPIC_FEDERATION_TOKEN_EXPIRATION_SECONDS",
      );
    });
  }

  it("ignores federation env when Kubernetes provisioning is disabled", () => {
    const { SHIPWRIGHT_K8S_PROVISIONING: _, ...rest } = FEDERATION_ENV;
    expect(
      buildProvisioner(
        { ...rest, SHIPWRIGHT_K8S_AGENT_SERVICE_ACCOUNT: "" },
        stubAgentTokenService(),
      ),
    ).toBeInstanceOf(NoopAgentProvisioner);
  });
});

// ─── resolveSessionAlertIntervalMs ──────────────────────────────────────────

// The pure env rule behind the session-alert sweeper's setInterval cadence in
// startServer() (SESH-7.4). Tested without touching process.env.
describe("resolveSessionAlertIntervalMs", () => {
  it("defaults to 60s when unset", () => {
    expect(resolveSessionAlertIntervalMs({})).toBe(
      DEFAULT_SESSION_ALERT_INTERVAL_MS,
    );
    expect(DEFAULT_SESSION_ALERT_INTERVAL_MS).toBe(60_000);
  });

  it("uses an explicit positive override", () => {
    expect(
      resolveSessionAlertIntervalMs({
        SHIPWRIGHT_ADMIN_SESSION_ALERT_INTERVAL_MS: "5000",
      }),
    ).toBe(5000);
  });

  it("falls back to the default for blank, non-numeric, zero, or negative values", () => {
    for (const raw of ["", "   ", "soon", "0", "-1"]) {
      expect(
        resolveSessionAlertIntervalMs({
          SHIPWRIGHT_ADMIN_SESSION_ALERT_INTERVAL_MS: raw,
        }),
      ).toBe(DEFAULT_SESSION_ALERT_INTERVAL_MS);
    }
  });
});

// ─── resolveTrialExpiryWarningDays ──────────────────────────────────────────

// The pure env rule behind the trial-expiry sweeper's warning window
// (ATE-2.1). Tested without touching process.env. Unlike
// resolveSessionAlertIntervalMs, returning `undefined` on an unset/invalid
// override is intentional: TrialExpiryWarningSweeper's own constructor
// applies DEFAULT_TRIAL_EXPIRY_WARNING_DAYS when its `warningDays` option is
// omitted, so this resolver stays a thin env-parsing layer rather than
// duplicating that default.
describe("resolveTrialExpiryWarningDays", () => {
  it("returns undefined when unset, letting the sweeper apply its own default", () => {
    expect(resolveTrialExpiryWarningDays({})).toBeUndefined();
  });

  it("uses an explicit positive override", () => {
    expect(
      resolveTrialExpiryWarningDays({
        SHIPWRIGHT_ADMIN_TRIAL_EXPIRY_WARNING_DAYS: "7",
      }),
    ).toBe(7);
  });

  it("returns undefined for blank, non-numeric, zero, or negative values", () => {
    for (const raw of ["", "   ", "soon", "0", "-1"]) {
      expect(
        resolveTrialExpiryWarningDays({
          SHIPWRIGHT_ADMIN_TRIAL_EXPIRY_WARNING_DAYS: raw,
        }),
      ).toBeUndefined();
    }
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
      delete process.env.DATABASE_URL_SHIPWRIGHT_ADMIN;
    } else {
      process.env.DATABASE_URL_SHIPWRIGHT_ADMIN = originalUrl;
    }
  });

  it("returns early without spawning a process when DATABASE_URL_SHIPWRIGHT_ADMIN is unset", async () => {
    delete process.env.DATABASE_URL_SHIPWRIGHT_ADMIN;
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

// ─── isAnthropicFederationEnabled (WIF-2.1) ─────────────────────────────────

describe("isAnthropicFederationEnabled", () => {
  const RULE = "SHIPWRIGHT_K8S_AGENT_ANTHROPIC_FEDERATION_RULE_ID";

  it("false by default", () => {
    expect(isAnthropicFederationEnabled({})).toBe(false);
  });

  it("true when provisioning is enabled and the rule ID is set", () => {
    expect(
      isAnthropicFederationEnabled({
        SHIPWRIGHT_K8S_PROVISIONING: "enabled",
        [RULE]: "rule-1",
      }),
    ).toBe(true);
  });

  it("false when the rule ID is set but provisioning is not enabled", () => {
    expect(isAnthropicFederationEnabled({ [RULE]: "rule-1" })).toBe(false);
  });

  it("false when the rule ID is empty", () => {
    expect(
      isAnthropicFederationEnabled({
        SHIPWRIGHT_K8S_PROVISIONING: "enabled",
        [RULE]: "",
      }),
    ).toBe(false);
  });
});

// ─── perAgent identity mode (PAI-2.1) ───────────────────────────────────────

describe("parseAnthropicFederation identity modes", () => {
  const P = "SHIPWRIGHT_K8S_AGENT_ANTHROPIC_FEDERATION_";
  const SHARED_ENV = {
    SHIPWRIGHT_K8S_PROVISIONING: "enabled",
    SHIPWRIGHT_K8S_AGENT_SERVICE_ACCOUNT: "shipwright-agent",
    [`${P}RULE_ID`]: "fdrl_1",
    [`${P}ORGANIZATION_ID`]: "org-1",
    [`${P}SERVICE_ACCOUNT_ID`]: "svac_1",
  };
  const PER_AGENT_ENV = {
    SHIPWRIGHT_K8S_PROVISIONING: "enabled",
    [`${P}IDENTITY_MODE`]: "perAgent",
    [`${P}ORGANIZATION_ID`]: "org-1",
    [`${P}ISSUER_ID`]: "issuer-1",
  };

  it("returns undefined when nothing is configured", () => {
    expect(parseAnthropicFederation({})).toBeUndefined();
  });

  it("returns the shared shape tagged mode=shared for the shared config", () => {
    expect(parseAnthropicFederation(SHARED_ENV)).toEqual({
      mode: "shared",
      serviceAccountName: "shipwright-agent",
      ruleId: "fdrl_1",
      organizationId: "org-1",
      serviceAccountId: "svac_1",
      audience: "https://api.anthropic.com",
      expirationSeconds: 600,
    });
  });

  it("treats an explicit IDENTITY_MODE=shared like the default", () => {
    expect(
      parseAnthropicFederation({
        ...SHARED_ENV,
        [`${P}IDENTITY_MODE`]: "shared",
      })?.mode,
    ).toBe("shared");
    expect(
      parseAnthropicFederation({ [`${P}IDENTITY_MODE`]: "shared" }),
    ).toBeUndefined();
  });

  it("parses the perAgent config without any shared rule ID", () => {
    expect(parseAnthropicFederation(PER_AGENT_ENV)).toEqual({
      mode: "perAgent",
      organizationId: "org-1",
      issuerId: "issuer-1",
      audience: "https://api.anthropic.com",
      expirationSeconds: 600,
    });
  });

  it("parses the perAgent optional workspace, suffix, audience and expiration", () => {
    expect(
      parseAnthropicFederation({
        ...PER_AGENT_ENV,
        [`${P}WORKSPACE_ID`]: "wrkspc_1",
        [`${P}NAME_SUFFIX`]: "-dev-1",
        [`${P}AUDIENCE`]: "https://example.test",
        [`${P}TOKEN_EXPIRATION_SECONDS`]: "3600",
      }),
    ).toEqual({
      mode: "perAgent",
      organizationId: "org-1",
      workspaceId: "wrkspc_1",
      issuerId: "issuer-1",
      nameSuffix: "-dev-1",
      audience: "https://example.test",
      expirationSeconds: 3600,
    });
  });

  for (const missing of ["ORGANIZATION_ID", "ISSUER_ID"]) {
    it(`throws when perAgent mode is missing ${missing}`, () => {
      expect(() =>
        parseAnthropicFederation({ ...PER_AGENT_ENV, [`${P}${missing}`]: "" }),
      ).toThrow(new RegExp(`partially configured.*${P}${missing}`));
    });
  }

  it("throws on an unknown IDENTITY_MODE", () => {
    expect(() =>
      parseAnthropicFederation({
        ...PER_AGENT_ENV,
        [`${P}IDENTITY_MODE`]: "both",
      }),
    ).toThrow(/IDENTITY_MODE.*"both"/);
  });

  it("throws on a NAME_SUFFIX outside [a-z0-9-]", () => {
    for (const bad of ["Dev", "a_b", "x.y", "a b"]) {
      expect(() =>
        parseAnthropicFederation({
          ...PER_AGENT_ENV,
          [`${P}NAME_SUFFIX`]: bad,
        }),
      ).toThrow(/NAME_SUFFIX/);
    }
  });

  it("applies the token-expiration floor in perAgent mode too", () => {
    expect(() =>
      parseAnthropicFederation({
        ...PER_AGENT_ENV,
        [`${P}TOKEN_EXPIRATION_SECONDS`]: "599",
      }),
    ).toThrow(/TOKEN_EXPIRATION_SECONDS/);
  });

  it("derives the enabled flag from the mode: true for perAgent without a rule ID", () => {
    expect(isAnthropicFederationEnabled(PER_AGENT_ENV)).toBe(true);
  });

  it("is disabled for perAgent mode when provisioning is not enabled", () => {
    const { SHIPWRIGHT_K8S_PROVISIONING: _, ...rest } = PER_AGENT_ENV;
    expect(isAnthropicFederationEnabled(rest)).toBe(false);
  });

  it("buildProvisioner passes the shared shape (no mode) in shared mode", () => {
    const config = configOf(
      buildProvisioner(SHARED_ENV, stubAgentTokenService()),
    );
    expect(config.anthropicFederation).not.toHaveProperty("mode");
    expect(config.anthropicFederation?.ruleId).toBe("fdrl_1");
  });

  // The admin pod's own sign-in (chart-rendered in perAgent mode).
  const ADMIN_SIGN_IN_ENV = {
    ANTHROPIC_IDENTITY_TOKEN_FILE: "/var/run/secrets/anthropic.com/token",
    ANTHROPIC_FEDERATION_RULE_ID: "fdrl_admin",
    ANTHROPIC_ORGANIZATION_ID: "org-1",
    ANTHROPIC_SERVICE_ACCOUNT_ID: "svac_admin",
  };

  /** Prisma stub — the identity services only keep the reference at build time. */
  function stubPrisma(): PrismaClient {
    return {} as unknown as PrismaClient;
  }

  it("buildProvisioner wires the per-agent identity deps in perAgent mode", () => {
    const config = configOf(
      buildProvisioner(
        {
          ...PER_AGENT_ENV,
          ...ADMIN_SIGN_IN_ENV,
          [`${P}WORKSPACE_ID`]: "wrkspc_1",
          [`${P}AUDIENCE`]: "https://example.test",
          [`${P}TOKEN_EXPIRATION_SECONDS`]: "900",
        },
        stubAgentTokenService(),
        stubPrisma(),
      ),
    );
    expect("anthropicFederation" in config).toBe(false);
    const perAgent = config.perAgentIdentity;
    expect(perAgent).toMatchObject({
      organizationId: "org-1",
      workspaceId: "wrkspc_1",
      issuerId: "issuer-1",
      audience: "https://example.test",
      expirationSeconds: 900,
    });
    expect(perAgent?.client).toBeInstanceOf(HttpAnthropicIdentityClient);
    expect(perAgent?.identities).toBeInstanceOf(AgentAnthropicIdentityService);
    expect(perAgent?.names).toBeInstanceOf(AnthropicIdentityNameAllocator);
  });

  it("buildProvisioner leaves per-agent identity unset in shared mode", () => {
    const config = configOf(
      buildProvisioner(SHARED_ENV, stubAgentTokenService(), stubPrisma()),
    );
    expect("perAgentIdentity" in config).toBe(false);
  });

  for (const missing of [
    "ANTHROPIC_IDENTITY_TOKEN_FILE",
    "ANTHROPIC_FEDERATION_RULE_ID",
    "ANTHROPIC_ORGANIZATION_ID",
  ] as const) {
    it(`buildProvisioner fails startup in perAgent mode without the admin's ${missing}`, () => {
      expect(() =>
        buildProvisioner(
          { ...PER_AGENT_ENV, ...ADMIN_SIGN_IN_ENV, [missing]: "" },
          stubAgentTokenService(),
          stubPrisma(),
        ),
      ).toThrow(missing);
    });
  }

  it("buildProvisioner fails in perAgent mode without a database client", () => {
    expect(() =>
      buildProvisioner(
        { ...PER_AGENT_ENV, ...ADMIN_SIGN_IN_ENV },
        stubAgentTokenService(),
      ),
    ).toThrow(/perAgent/);
  });
});
