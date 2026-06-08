/**
 * agent/src/migrate.integration.test.ts
 * Integration tests for the data migration script.
 *
 * Uses in-memory recorded doubles — no database or network required.
 * Runs unconditionally.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import type { AccountsMigrationClient, VitalsAgentRecord, VitalsAgentConfig, VitalsAgentCron } from "./accounts-migration-client.ts";
import type { ShipwrightAdminMigrationClient } from "./shipwright-admin-client.ts";
import { runMigration } from "./migrate.ts";

// ─── Fixture data ─────────────────────────────────────────────────────────────

const AGENTS: VitalsAgentRecord[] = [
  { id: "agent-001", name: "Warchild" },
  { id: "agent-002", name: "Backup Agent" },
];

const CONFIGS: Record<string, VitalsAgentConfig> = {
  "agent-001": {
    env: { SLACK_BOT_TOKEN: "xoxb-test-001", ANTHROPIC_API_KEY: "sk-ant-001" },
    tools: ["Read", "Write", "Bash"],
  },
  "agent-002": {
    env: { SLACK_BOT_TOKEN: "xoxb-test-002" },
    tools: ["Read"],
  },
};

const CRONS: Record<string, VitalsAgentCron[]> = {
  "agent-001": [
    {
      schedule: "30 19 * * *",
      prompt: "/shipwright:dev-task",
      channel: "C123456",
      user: null,
      silent: false,
      enabled: true,
      preCheck: null,
      name: "dev-task",
    },
  ],
  "agent-002": [],
};

// ─── Recorded doubles ─────────────────────────────────────────────────────────

class RecordedAccountsClient implements AccountsMigrationClient {
  async listAgents(): Promise<VitalsAgentRecord[]> {
    return [...AGENTS];
  }

  async getAgentConfig(agentId: string): Promise<VitalsAgentConfig> {
    const config = CONFIGS[agentId];
    if (!config) throw new Error(`No config for agent ${agentId}`);
    return { ...config, env: { ...config.env }, tools: [...config.tools] };
  }

  async getAgentCrons(agentId: string): Promise<VitalsAgentCron[]> {
    const crons = CRONS[agentId] ?? [];
    return crons.map((c) => ({ ...c }));
  }
}

interface UpsertEnvsCall { agentId: string; env: Record<string, string>; }
interface AddToolCall { agentId: string; pattern: string; }
interface CreateCronCall { agentId: string; cron: VitalsAgentCron; }

class RecordedShipwrightAdminClient implements ShipwrightAdminMigrationClient {
  upsertEnvsCalls: UpsertEnvsCall[] = [];
  addToolCalls: AddToolCall[] = [];
  createCronCalls: CreateCronCall[] = [];

  /** Set to an agentId to make the next upsertEnvs call for that agent throw. */
  failNextEnvsForAgent: string | null = null;

  private cronStore: Map<string, VitalsAgentCron[]> = new Map();

  async upsertEnvs(agentId: string, env: Record<string, string>): Promise<void> {
    if (this.failNextEnvsForAgent === agentId) {
      this.failNextEnvsForAgent = null;
      throw new Error(`Simulated upsertEnvs failure for agent ${agentId}`);
    }
    this.upsertEnvsCalls.push({ agentId, env: { ...env } });
  }

  async listCrons(agentId: string): Promise<VitalsAgentCron[]> {
    return [...(this.cronStore.get(agentId) ?? [])];
  }

  async createCron(agentId: string, cron: VitalsAgentCron): Promise<void> {
    this.createCronCalls.push({ agentId, cron: { ...cron } });
    const existing = this.cronStore.get(agentId) ?? [];
    this.cronStore.set(agentId, [...existing, { ...cron }]);
  }

  async addTool(agentId: string, pattern: string): Promise<void> {
    this.addToolCalls.push({ agentId, pattern });
  }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("runMigration (integration)", () => {
  let accountsClient: RecordedAccountsClient;
  let adminClient: RecordedShipwrightAdminClient;

  beforeEach(() => {
    accountsClient = new RecordedAccountsClient();
    adminClient = new RecordedShipwrightAdminClient();
  });

  it("migrates all agents with env vars, tools, and crons", async () => {
    const result = await runMigration(accountsClient, adminClient);

    expect(result.migrated).toBe(2);
    expect(result.failed).toHaveLength(0);

    // agent-001: SLACK_BOT_TOKEN and ANTHROPIC_API_KEY in upsertEnvs call
    const env001Call = adminClient.upsertEnvsCalls.find(
      (c) => c.agentId === "agent-001",
    );
    expect(env001Call).toBeDefined();
    expect(env001Call?.env.SLACK_BOT_TOKEN).toBe("xoxb-test-001");
    expect(env001Call?.env.ANTHROPIC_API_KEY).toBe("sk-ant-001");

    // agent-001: 3 addTool calls (Read, Write, Bash)
    const tools001 = adminClient.addToolCalls.filter(
      (c) => c.agentId === "agent-001",
    );
    expect(tools001).toHaveLength(3);
    const patterns001 = tools001.map((c) => c.pattern);
    expect(patterns001).toContain("Read");
    expect(patterns001).toContain("Write");
    expect(patterns001).toContain("Bash");

    // agent-001: 1 createCron call
    const crons001 = adminClient.createCronCalls.filter(
      (c) => c.agentId === "agent-001",
    );
    expect(crons001).toHaveLength(1);
    expect(crons001[0]?.cron.schedule).toBe("30 19 * * *");
    expect(crons001[0]?.cron.prompt).toBe("/shipwright:dev-task");
  });

  it("re-running is idempotent — crons not duplicated", async () => {
    // First run
    const result1 = await runMigration(accountsClient, adminClient);
    expect(result1.migrated).toBe(2);
    const createCronCountAfterFirst = adminClient.createCronCalls.length;

    // Second run (crons already in cronStore from first run)
    const result2 = await runMigration(accountsClient, adminClient);
    expect(result2.migrated).toBe(2);

    // No new crons should have been created
    const createCronCountAfterSecond = adminClient.createCronCalls.length;
    expect(createCronCountAfterSecond).toBe(createCronCountAfterFirst);
  });

  it("continues processing remaining agents when one fails, reports failure", async () => {
    // Make upsertEnvs fail for agent-001
    adminClient.failNextEnvsForAgent = "agent-001";

    const result = await runMigration(accountsClient, adminClient);

    // agent-001 should fail, agent-002 should succeed
    expect(result.migrated).toBe(1);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.agentId).toBe("agent-001");
    expect(result.failed[0]?.field).toBe("env");
    expect(typeof result.failed[0]?.error).toBe("string");

    // agent-002 envs should still have been written
    const env002Call = adminClient.upsertEnvsCalls.find(
      (c) => c.agentId === "agent-002",
    );
    expect(env002Call).toBeDefined();
    expect(env002Call?.env.SLACK_BOT_TOKEN).toBe("xoxb-test-002");
  });
});
