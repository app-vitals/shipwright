import type {
  VitalsAgentCron,
  VitalsAgentRecord,
} from "../agent/src/accounts-migration-client.ts";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface AgentConfig {
  agent: VitalsAgentRecord;
  config: {
    env: Record<string, string>;
    tools: string[];
  };
  crons: VitalsAgentCron[];
  plugins: Array<{ name: string; version: string | null }>;
}

export interface MigrateOptions {
  dryRun: boolean;
  log: (msg: string) => void;
}

export interface VitalsOsClient {
  getAgent(): Promise<AgentConfig["agent"]>;
  getConfig(): Promise<AgentConfig["config"]>;
  getCrons(): Promise<AgentConfig["crons"]>;
  getPlugins(): Promise<AgentConfig["plugins"]>;
}

export interface AdminClient {
  upsertEnvs(env: Record<string, string>): Promise<void>;
  listCrons(): Promise<AgentConfig["crons"]>;
  createCron(cron: AgentConfig["crons"][number]): Promise<void>;
  addTool(pattern: string): Promise<void>;
  addPlugin(name: string, version: string | null | undefined): Promise<void>;
}

// ─── Client factories ─────────────────────────────────────────────────────────

export function buildVitalsOsClient(
  baseUrl: string,
  apiKey: string,
): VitalsOsClient {
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };

  async function apiFetch(url: string): Promise<unknown> {
    const res = await globalThis.fetch(url, { headers });
    if (!res.ok) {
      throw new Error(
        `vitals-os request failed: ${res.status} ${await res.text()}`,
      );
    }
    return res.json();
  }

  return {
    async getAgent(): Promise<AgentConfig["agent"]> {
      return (await apiFetch(baseUrl)) as VitalsAgentRecord;
    },

    async getConfig(): Promise<AgentConfig["config"]> {
      const data = (await apiFetch(`${baseUrl}/config`)) as {
        env?: Record<string, string>;
        tools?: string[];
      };
      return {
        env: data.env ?? {},
        tools: data.tools ?? [],
      };
    },

    async getCrons(): Promise<AgentConfig["crons"]> {
      const data = (await apiFetch(`${baseUrl}/crons`)) as
        | { crons?: VitalsAgentCron[] }
        | VitalsAgentCron[];
      if (Array.isArray(data)) return data;
      return data.crons ?? [];
    },

    async getPlugins(): Promise<AgentConfig["plugins"]> {
      const data = (await apiFetch(`${baseUrl}/plugins`)) as
        | { plugins?: AgentConfig["plugins"] }
        | AgentConfig["plugins"];
      if (Array.isArray(data)) return data;
      return (data as { plugins?: AgentConfig["plugins"] }).plugins ?? [];
    },
  };
}

export function buildAdminClient(
  baseUrl: string,
  bearerToken: string,
): AdminClient {
  const headers = {
    Authorization: `Bearer ${bearerToken}`,
    "Content-Type": "application/json",
  };

  async function apiFetch(
    url: string,
    init?: RequestInit,
  ): Promise<unknown> {
    const res = await globalThis.fetch(url, {
      ...init,
      headers: { ...headers, ...(init?.headers as Record<string, string> | undefined) },
    });
    if (!res.ok) {
      throw new Error(
        `admin API request failed: ${res.status} ${await res.text()}`,
      );
    }
    return res.status === 204 ? null : res.json();
  }

  return {
    async upsertEnvs(env: Record<string, string>): Promise<void> {
      await apiFetch(`${baseUrl}/envs`, {
        method: "POST",
        body: JSON.stringify(env),
      });
    },

    async listCrons(): Promise<AgentConfig["crons"]> {
      const data = (await apiFetch(`${baseUrl}/crons`)) as {
        crons: VitalsAgentCron[];
      };
      return data.crons;
    },

    async createCron(cron: AgentConfig["crons"][number]): Promise<void> {
      await apiFetch(`${baseUrl}/crons`, {
        method: "POST",
        body: JSON.stringify(cron),
      });
    },

    async addTool(pattern: string): Promise<void> {
      await apiFetch(`${baseUrl}/tools`, {
        method: "POST",
        body: JSON.stringify({ pattern }),
      });
    },

    async addPlugin(name: string, version: string | null | undefined): Promise<void> {
      await apiFetch(`${baseUrl}/plugins`, {
        method: "POST",
        body: JSON.stringify({ name, version: version ?? null }),
      });
    },
  };
}

// ─── Core migration logic ─────────────────────────────────────────────────────

export async function migrateAgent(
  agentId: string,
  vitals: VitalsOsClient,
  admin: AdminClient,
  opts: MigrateOptions,
): Promise<void> {
  const { dryRun, log } = opts;

  function wrapErr(resource: string, err: unknown): Error {
    return new Error(
      `Failed to read ${resource} from vitals-os for agent ${agentId}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  let agent: AgentConfig["agent"];
  try {
    agent = await vitals.getAgent();
  } catch (err) {
    throw wrapErr("agent record", err);
  }

  let config: AgentConfig["config"];
  try {
    config = await vitals.getConfig();
  } catch (err) {
    throw wrapErr("config", err);
  }

  let crons: AgentConfig["crons"];
  try {
    crons = await vitals.getCrons();
  } catch (err) {
    throw wrapErr("crons", err);
  }

  let plugins: AgentConfig["plugins"];
  try {
    plugins = await vitals.getPlugins();
  } catch (err) {
    throw wrapErr("plugins", err);
  }

  if (dryRun) {
    log(`[dry-run] agent: ${agent.id} (${agent.name})`);
    log(`[dry-run] env vars (${Object.keys(config.env).length}): ${Object.keys(config.env).join(", ")}`);
    log(`[dry-run] tools (${config.tools.length}): ${config.tools.join(", ")}`);
    log(`[dry-run] plugins (${plugins.length}): ${plugins.map((p) => p.name).join(", ")}`);
    log(`[dry-run] crons (${crons.length}):`);
    for (const cron of crons) {
      log(`[dry-run]   ${cron.name ?? cron.schedule}: ${cron.schedule} → ${cron.prompt.slice(0, 60)}`);
    }
    return;
  }

  await admin.upsertEnvs(config.env);
  log(`[migrate-agent] upserted ${Object.keys(config.env).length} env vars`);

  for (const pattern of config.tools) {
    await admin.addTool(pattern);
  }
  log(`[migrate-agent] added ${config.tools.length} tools`);

  for (const plugin of plugins) {
    await admin.addPlugin(plugin.name, plugin.version);
  }
  log(`[migrate-agent] added ${plugins.length} plugins`);

  const existingCrons = await admin.listCrons();
  let cronsCreated = 0;
  let cronsSkipped = 0;

  for (const cron of crons) {
    const isDuplicate = existingCrons.some(
      (e) => e.schedule === cron.schedule && e.prompt === cron.prompt,
    );
    if (isDuplicate) {
      cronsSkipped++;
      continue;
    }
    await admin.createCron(cron);
    cronsCreated++;
  }

  log(`[migrate-agent] crons: ${cronsCreated} created, ${cronsSkipped} skipped (already exist)`);
  log(`[migrate-agent] done — ${agent.name} (${agentId}) migrated`);
}

// ─── CLI flag parsing ─────────────────────────────────────────────────────────

function parseArgs(argv: string[]): {
  agentId: string;
  vitalsOsUrl: string;
  vitalsOsApiKey: string;
  adminUrl: string;
  adminToken: string;
  dryRun: boolean;
} {
  const flags: Record<string, string> = {};
  let dryRun = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg?.startsWith("--") && argv[i + 1] && !argv[i + 1].startsWith("--")) {
      const key = arg.slice(2);
      flags[key] = argv[i + 1];
      i++;
    }
  }

  const required = [
    "agent-id",
    "vitals-os-url",
    "vitals-os-api-key",
    "admin-url",
    "admin-token",
  ];

  for (const key of required) {
    if (!flags[key]) {
      console.error(
        `Error: missing required flag --${key}. Usage:\n  bun scripts/migrate-agent.ts \\\n    --agent-id <id> \\\n    --vitals-os-url <url> \\\n    --vitals-os-api-key <key> \\\n    --admin-url <url> \\\n    --admin-token <token> \\\n    [--dry-run]`,
      );
      process.exit(1);
    }
  }

  return {
    agentId: flags["agent-id"],
    vitalsOsUrl: flags["vitals-os-url"],
    vitalsOsApiKey: flags["vitals-os-api-key"],
    adminUrl: flags["admin-url"],
    adminToken: flags["admin-token"],
    dryRun,
  };
}

// ─── Entrypoint ───────────────────────────────────────────────────────────────

if (import.meta.main) {
  const args = parseArgs(process.argv.slice(2));

  const agentBase = `${args.vitalsOsUrl}/accounts/agents/${args.agentId}`;
  const adminBase = `${args.adminUrl}/admin/api/agents/${args.agentId}`;

  const vitalsClient = buildVitalsOsClient(agentBase, args.vitalsOsApiKey);
  const adminClient = buildAdminClient(adminBase, args.adminToken);

  await migrateAgent(args.agentId, vitalsClient, adminClient, {
    dryRun: args.dryRun,
    log: (msg) => console.log(msg),
  }).catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
