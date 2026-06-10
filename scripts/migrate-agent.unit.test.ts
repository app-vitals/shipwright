import { beforeEach, describe, expect, it, spyOn } from "bun:test";
import {
  type MigrateOptions,
  type AgentConfig,
  buildVitalsOsClient,
  buildAdminClient,
  migrateAgent,
} from "./migrate-agent.ts";

// ─── Fixture data ─────────────────────────────────────────────────────────────

const AGENT_ID = "agent-test-001";

const VITALS_CONFIG: AgentConfig["config"] = {
  env: { SLACK_BOT_TOKEN: "xoxb-test", ANTHROPIC_API_KEY: "sk-ant-test" },
  tools: ["Read", "Write", "Bash"],
};

const VITALS_CRONS: AgentConfig["crons"] = [
  {
    schedule: "0 6 * * *",
    prompt: "morning brief",
    channel: "C12345",
    user: null,
    silent: false,
    enabled: true,
    preCheck: null,
    name: "morning-brief",
  },
];

const VITALS_PLUGINS: AgentConfig["plugins"] = [
  { name: "shipwright", version: null },
];

const ADMIN_CRONS_EMPTY: AgentConfig["crons"] = [];

// ─── Client doubles ───────────────────────────────────────────────────────────

interface VitalsOsClientDouble {
  getConfig: () => Promise<AgentConfig["config"]>;
  getCrons: () => Promise<AgentConfig["crons"]>;
  getPlugins: () => Promise<AgentConfig["plugins"]>;
}

interface AdminClientDouble {
  upsertEnvs: (env: Record<string, string>) => Promise<void>;
  listCrons: () => Promise<AgentConfig["crons"]>;
  createCron: (cron: AgentConfig["crons"][number]) => Promise<void>;
  addTool: (pattern: string) => Promise<void>;
  addPlugin: (name: string, version: string | null | undefined) => Promise<void>;
}

interface RecordedAdminClient {
  upsertEnvsCalls: Array<Record<string, string>>;
  createCronCalls: Array<AgentConfig["crons"][number]>;
  addToolCalls: string[];
  addPluginCalls: Array<{ name: string; version: string | null | undefined }>;
  listCronsResult: AgentConfig["crons"];
  client: AdminClientDouble;
}

function makeAdminDouble(existingCrons: AgentConfig["crons"] = []): RecordedAdminClient {
  const upsertEnvsCalls: Array<Record<string, string>> = [];
  const createCronCalls: Array<AgentConfig["crons"][number]> = [];
  const addToolCalls: string[] = [];
  const addPluginCalls: Array<{ name: string; version: string | null | undefined }> = [];
  let listCronsResult = [...existingCrons];

  const client: AdminClientDouble = {
    upsertEnvs: async (env) => { upsertEnvsCalls.push({ ...env }); },
    listCrons: async () => [...listCronsResult],
    createCron: async (cron) => {
      createCronCalls.push({ ...cron });
      listCronsResult = [...listCronsResult, { ...cron }];
    },
    addTool: async (pattern) => { addToolCalls.push(pattern); },
    addPlugin: async (name, version) => { addPluginCalls.push({ name, version }); },
  };

  return { upsertEnvsCalls, createCronCalls, addToolCalls, addPluginCalls, listCronsResult, client };
}

function makeVitalsDouble(): VitalsOsClientDouble {
  return {
    getConfig: async () => ({ ...VITALS_CONFIG, env: { ...VITALS_CONFIG.env }, tools: [...VITALS_CONFIG.tools] }),
    getCrons: async () => VITALS_CRONS.map((c) => ({ ...c })),
    getPlugins: async () => VITALS_PLUGINS.map((p) => ({ ...p })),
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("migrateAgent — dry-run", () => {
  it("prints all resources read from vitals-os without writing to admin API", async () => {
    const vitals = makeVitalsDouble();
    const admin = makeAdminDouble();

    const logs: string[] = [];

    await migrateAgent(AGENT_ID, vitals, admin.client, { dryRun: true, log: (msg) => logs.push(msg) });

    expect(admin.upsertEnvsCalls).toHaveLength(0);
    expect(admin.createCronCalls).toHaveLength(0);
    expect(admin.addToolCalls).toHaveLength(0);
    expect(admin.addPluginCalls).toHaveLength(0);

    const logText = logs.join("\n");
    expect(logText).toContain("dry-run");
    expect(logText).toContain("SLACK_BOT_TOKEN");
    expect(logText).toContain("morning-brief");
    expect(logText).toContain("shipwright");
    expect(logText).toContain("Read");
  });
});

describe("migrateAgent — env vars", () => {
  it("writes env vars to admin API", async () => {
    const vitals = makeVitalsDouble();
    const admin = makeAdminDouble();

    await migrateAgent(AGENT_ID, vitals, admin.client, { dryRun: false, log: () => {} });

    expect(admin.upsertEnvsCalls).toHaveLength(1);
    expect(admin.upsertEnvsCalls[0]).toMatchObject({
      SLACK_BOT_TOKEN: "xoxb-test",
      ANTHROPIC_API_KEY: "sk-ant-test",
    });
  });
});

describe("migrateAgent — tools", () => {
  it("writes each tool to admin API", async () => {
    const vitals = makeVitalsDouble();
    const admin = makeAdminDouble();

    await migrateAgent(AGENT_ID, vitals, admin.client, { dryRun: false, log: () => {} });

    expect(admin.addToolCalls).toContain("Read");
    expect(admin.addToolCalls).toContain("Write");
    expect(admin.addToolCalls).toContain("Bash");
  });
});

describe("migrateAgent — plugins", () => {
  it("writes each plugin to admin API", async () => {
    const vitals = makeVitalsDouble();
    const admin = makeAdminDouble();

    await migrateAgent(AGENT_ID, vitals, admin.client, { dryRun: false, log: () => {} });

    expect(admin.addPluginCalls).toHaveLength(1);
    expect(admin.addPluginCalls[0]).toMatchObject({ name: "shipwright", version: null });
  });
});

describe("migrateAgent — crons", () => {
  it("creates new crons when none exist", async () => {
    const vitals = makeVitalsDouble();
    const admin = makeAdminDouble(ADMIN_CRONS_EMPTY);

    await migrateAgent(AGENT_ID, vitals, admin.client, { dryRun: false, log: () => {} });

    expect(admin.createCronCalls).toHaveLength(1);
    expect(admin.createCronCalls[0]).toMatchObject({
      schedule: "0 6 * * *",
      prompt: "morning brief",
    });
  });

  it("skips crons that already exist (idempotent — matched by schedule+prompt)", async () => {
    const vitals = makeVitalsDouble();
    const admin = makeAdminDouble([...VITALS_CRONS]);

    await migrateAgent(AGENT_ID, vitals, admin.client, { dryRun: false, log: () => {} });

    expect(admin.createCronCalls).toHaveLength(0);
  });
});

describe("migrateAgent — idempotent second run", () => {
  it("running twice produces same result — no duplicate crons", async () => {
    const vitals = makeVitalsDouble();
    const admin = makeAdminDouble(ADMIN_CRONS_EMPTY);

    await migrateAgent(AGENT_ID, vitals, admin.client, { dryRun: false, log: () => {} });
    const cronsAfterFirst = admin.createCronCalls.length;

    await migrateAgent(AGENT_ID, vitals, admin.client, { dryRun: false, log: () => {} });
    expect(admin.createCronCalls.length).toBe(cronsAfterFirst);
  });

  it("running twice produces same env upsert (replace-all is idempotent)", async () => {
    const vitals = makeVitalsDouble();
    const admin = makeAdminDouble();

    await migrateAgent(AGENT_ID, vitals, admin.client, { dryRun: false, log: () => {} });
    await migrateAgent(AGENT_ID, vitals, admin.client, { dryRun: false, log: () => {} });

    expect(admin.upsertEnvsCalls).toHaveLength(2);
    expect(admin.upsertEnvsCalls[0]).toEqual(admin.upsertEnvsCalls[1]);
  });
});

describe("migrateAgent — error handling", () => {
  it("throws with clear message when vitals-os config call fails", async () => {
    const vitals: VitalsOsClientDouble = {
      getConfig: async () => { throw new Error("ECONNREFUSED"); },
      getCrons: async () => [],
      getPlugins: async () => [],
    };
    const admin = makeAdminDouble();

    await expect(
      migrateAgent(AGENT_ID, vitals, admin.client, { dryRun: false, log: () => {} }),
    ).rejects.toThrow(/vitals-os|config|ECONNREFUSED/i);
  });

  it("throws with clear message when admin API env upsert fails (auth error)", async () => {
    const vitals = makeVitalsDouble();
    const admin = makeAdminDouble();
    admin.client.upsertEnvs = async () => {
      throw new Error("401 Unauthorized");
    };

    await expect(
      migrateAgent(AGENT_ID, vitals, admin.client, { dryRun: false, log: () => {} }),
    ).rejects.toThrow(/admin|401|Unauthorized/i);
  });
});

describe("buildVitalsOsClient", () => {
  it("constructs a client with expected methods", () => {
    const client = buildVitalsOsClient("https://example.com", "test-key");
    expect(typeof client.getConfig).toBe("function");
    expect(typeof client.getCrons).toBe("function");
    expect(typeof client.getPlugins).toBe("function");
  });
});

describe("buildAdminClient", () => {
  it("constructs a client with expected methods", () => {
    const client = buildAdminClient("https://example.com", "token");
    expect(typeof client.upsertEnvs).toBe("function");
    expect(typeof client.listCrons).toBe("function");
    expect(typeof client.createCron).toBe("function");
    expect(typeof client.addTool).toBe("function");
    expect(typeof client.addPlugin).toBe("function");
  });
});
