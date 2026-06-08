/**
 * agent/src/cutover-validate.integration.test.ts
 * Integration tests for cutover-validate using in-memory doubles.
 * No database or network required — runs unconditionally.
 */

import { describe, expect, it } from "bun:test";
import type { AgentCronJob } from "@shipwright/admin";
import type { AgentConfigResponse } from "@shipwright/admin";
import {
  type ShipwrightConfigClient,
  validateCutover,
} from "./cutover-validate.ts";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const AGENT_ID = "agent-cutover-test";

function makeCron(id: string): AgentCronJob {
  return {
    id,
    agentId: AGENT_ID,
    schedule: "0 9 * * *",
    prompt: "/shipwright:dev-task",
    channel: "C123456",
    user: null,
    silent: false,
    enabled: true,
    preCheck: null,
    name: "dev-task",
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-01"),
    system: false,
  };
}

function makeConfig(
  env: Record<string, string>,
): AgentConfigResponse {
  return { env, allowedTools: [], plugins: [] };
}

// ─── Recorded double ──────────────────────────────────────────────────────────

class RecordedShipwrightConfigClient implements ShipwrightConfigClient {
  constructor(
    private readonly config: AgentConfigResponse,
    private readonly crons: AgentCronJob[],
  ) {}

  async getConfig(_agentId: string): Promise<AgentConfigResponse> {
    return this.config;
  }

  async getCrons(_agentId: string): Promise<AgentCronJob[]> {
    return this.crons;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeAppAuthEnv(): Record<string, string> {
  return {
    SLACK_BOT_TOKEN: "xoxb-test-token",
    GH_APP_ID: "12345",
    GH_APP_PRIVATE_KEY: "-----BEGIN RSA PRIVATE KEY-----\nfake\n-----END RSA PRIVATE KEY-----",
    GH_APP_INSTALLATION_ID: "67890",
  };
}

function makePatEnv(): Record<string, string> {
  return {
    SLACK_BOT_TOKEN: "xoxb-test-token",
    GH_TOKEN: "ghp_faketoken123",
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("validateCutover", () => {
  it("returns all passing when SLACK_BOT_TOKEN + GitHub App creds + crons present", async () => {
    const client = new RecordedShipwrightConfigClient(
      makeConfig(makeAppAuthEnv()),
      [makeCron("cron-1")],
    );
    const results = await validateCutover(client, AGENT_ID);
    expect(results.every((r) => r.passed)).toBe(true);
  });

  it("returns all passing when SLACK_BOT_TOKEN + GH_TOKEN (PAT) + crons present", async () => {
    const client = new RecordedShipwrightConfigClient(
      makeConfig(makePatEnv()),
      [makeCron("cron-1")],
    );
    const results = await validateCutover(client, AGENT_ID);
    expect(results.every((r) => r.passed)).toBe(true);
  });

  it("fails when SLACK_BOT_TOKEN is missing", async () => {
    const { SLACK_BOT_TOKEN: _s, ...env } = makeAppAuthEnv();
    const client = new RecordedShipwrightConfigClient(
      makeConfig(env),
      [makeCron("cron-1")],
    );
    const results = await validateCutover(client, AGENT_ID);
    const slackCheck = results.find((r) => r.name === "SLACK_BOT_TOKEN");
    expect(slackCheck).toBeDefined();
    expect(slackCheck?.passed).toBe(false);
  });

  it("names the failing check when SLACK_BOT_TOKEN is missing", async () => {
    const { SLACK_BOT_TOKEN: _s, ...env } = makeAppAuthEnv();
    const client = new RecordedShipwrightConfigClient(
      makeConfig(env),
      [makeCron("cron-1")],
    );
    const results = await validateCutover(client, AGENT_ID);
    const failed = results.filter((r) => !r.passed);
    expect(failed.length).toBe(1);
    expect(failed[0].name).toBe("SLACK_BOT_TOKEN");
  });

  it("fails when GitHub auth credentials are missing", async () => {
    const client = new RecordedShipwrightConfigClient(
      makeConfig({ SLACK_BOT_TOKEN: "xoxb-token" }),
      [makeCron("cron-1")],
    );
    const results = await validateCutover(client, AGENT_ID);
    const githubCheck = results.find((r) => r.name === "github_auth");
    expect(githubCheck).toBeDefined();
    expect(githubCheck?.passed).toBe(false);
  });

  it("fails when no crons are present", async () => {
    const client = new RecordedShipwrightConfigClient(
      makeConfig(makeAppAuthEnv()),
      [],
    );
    const results = await validateCutover(client, AGENT_ID);
    const cronCheck = results.find((r) => r.name === "crons");
    expect(cronCheck).toBeDefined();
    expect(cronCheck?.passed).toBe(false);
  });

  it("reports all failing checks when multiple checks fail", async () => {
    const client = new RecordedShipwrightConfigClient(
      makeConfig({}),
      [],
    );
    const results = await validateCutover(client, AGENT_ID);
    const failed = results.filter((r) => !r.passed);
    expect(failed.length).toBeGreaterThanOrEqual(3);
    const names = failed.map((r) => r.name);
    expect(names).toContain("SLACK_BOT_TOKEN");
    expect(names).toContain("github_auth");
    expect(names).toContain("crons");
  });

  it("fails when GH_APP_INSTALLATION_ID is missing (partial App creds)", async () => {
    const env: Record<string, string> = {
      SLACK_BOT_TOKEN: "xoxb-test-token",
      GH_APP_ID: "12345",
      GH_APP_PRIVATE_KEY: "some-key",
      // GH_APP_INSTALLATION_ID intentionally omitted
    };
    const client = new RecordedShipwrightConfigClient(
      makeConfig(env),
      [makeCron("cron-1")],
    );
    const results = await validateCutover(client, AGENT_ID);
    const githubCheck = results.find((r) => r.name === "github_auth");
    expect(githubCheck).toBeDefined();
    expect(githubCheck?.passed).toBe(false);
  });

  it("fails when only disabled crons are present", async () => {
    const disabledCron: AgentCronJob = { ...makeCron("cron-disabled"), enabled: false };
    const client = new RecordedShipwrightConfigClient(
      makeConfig(makeAppAuthEnv()),
      [disabledCron],
    );
    const results = await validateCutover(client, AGENT_ID);
    const cronCheck = results.find((r) => r.name === "crons");
    expect(cronCheck).toBeDefined();
    expect(cronCheck?.passed).toBe(false);
  });

  it("accepts GitHub App creds with only the three required fields", async () => {
    const env: Record<string, string> = {
      SLACK_BOT_TOKEN: "xoxb-test-token",
      GH_APP_ID: "99999",
      GH_APP_PRIVATE_KEY: "some-key",
      GH_APP_INSTALLATION_ID: "11111",
    };
    const client = new RecordedShipwrightConfigClient(
      makeConfig(env),
      [makeCron("cron-1")],
    );
    const results = await validateCutover(client, AGENT_ID);
    expect(results.every((r) => r.passed)).toBe(true);
  });
});
