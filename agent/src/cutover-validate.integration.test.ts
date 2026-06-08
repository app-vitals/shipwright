/**
 * agent/src/cutover-validate.integration.test.ts
 * Integration tests for cutover validation logic.
 *
 * Uses RecordedShipwrightConfigClient with in-memory fixture data — no network.
 * Runs unconditionally.
 */

import { describe, it, expect } from "bun:test";
import type { ShipwrightConfigClient, ShipwrightConfigResponse, ShipwrightCronEntry } from "./shipwright-config-client.ts";
import { RecordedShipwrightConfigClient } from "./shipwright-config-client.ts";
import { validateCutover } from "./cutover-validate.ts";

// ─── Fixture helpers ──────────────────────────────────────────────────────────

function makeConfig(env: Record<string, string>): ShipwrightConfigResponse {
  return { env, allowedTools: ["Read", "Write", "Bash"] };
}

function makeCron(id: string): ShipwrightCronEntry {
  return { id, schedule: "0 * * * *", prompt: "/shipwright:dev-task" };
}

const FULL_CONFIG = makeConfig({
  SLACK_BOT_TOKEN: "xoxb-test-token",
  GH_TOKEN: "ghp-test-token",
  ANTHROPIC_API_KEY: "sk-ant-test",
});

const FULL_CRONS = [makeCron("cron-001")];

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("validateCutover (integration)", () => {
  const AGENT_ID = "agent-test-001";

  it("passes all checks when SLACK_BOT_TOKEN + GH_TOKEN + crons present", async () => {
    const client = new RecordedShipwrightConfigClient(FULL_CONFIG, FULL_CRONS);
    const result = await validateCutover(client, AGENT_ID);

    expect(result.passed).toBe(true);
    expect(result.checks).toHaveLength(3);
    for (const check of result.checks) {
      expect(check.passed).toBe(true);
    }
  });

  it("fails slack-token check when SLACK_BOT_TOKEN missing", async () => {
    const config = makeConfig({ GH_TOKEN: "ghp-test" });
    const client = new RecordedShipwrightConfigClient(config, FULL_CRONS);
    const result = await validateCutover(client, AGENT_ID);

    expect(result.passed).toBe(false);

    const slackCheck = result.checks.find((c) => c.name === "slack-token");
    expect(slackCheck).toBeDefined();
    expect(slackCheck?.passed).toBe(false);
  });

  it("fails github-auth check when no GitHub credentials present", async () => {
    const config = makeConfig({ SLACK_BOT_TOKEN: "xoxb-test" });
    const client = new RecordedShipwrightConfigClient(config, FULL_CRONS);
    const result = await validateCutover(client, AGENT_ID);

    expect(result.passed).toBe(false);

    const ghCheck = result.checks.find((c) => c.name === "github-auth");
    expect(ghCheck).toBeDefined();
    expect(ghCheck?.passed).toBe(false);
  });

  it("passes github-auth check for any supported GitHub credential", async () => {
    const credNames = ["GH_TOKEN", "GITHUB_TOKEN", "GITHUB_APP_PRIVATE_KEY", "GITHUB_APP_ID"];

    for (const cred of credNames) {
      const config = makeConfig({ SLACK_BOT_TOKEN: "xoxb-test", [cred]: "some-value" });
      const client = new RecordedShipwrightConfigClient(config, FULL_CRONS);
      const result = await validateCutover(client, AGENT_ID);

      const ghCheck = result.checks.find((c) => c.name === "github-auth");
      expect(ghCheck?.passed).toBe(true);
    }
  });

  it("fails crons check when crons array is empty", async () => {
    const client = new RecordedShipwrightConfigClient(FULL_CONFIG, []);
    const result = await validateCutover(client, AGENT_ID);

    expect(result.passed).toBe(false);

    const cronsCheck = result.checks.find((c) => c.name === "crons");
    expect(cronsCheck).toBeDefined();
    expect(cronsCheck?.passed).toBe(false);
  });

  it("names all three checks correctly", async () => {
    const client = new RecordedShipwrightConfigClient(FULL_CONFIG, FULL_CRONS);
    const result = await validateCutover(client, AGENT_ID);

    const checkNames = result.checks.map((c) => c.name);
    expect(checkNames).toContain("slack-token");
    expect(checkNames).toContain("github-auth");
    expect(checkNames).toContain("crons");
  });

  it("overall result is false when multiple checks fail", async () => {
    const config = makeConfig({});
    const client = new RecordedShipwrightConfigClient(config, []);
    const result = await validateCutover(client, AGENT_ID);

    expect(result.passed).toBe(false);
    const failedChecks = result.checks.filter((c) => !c.passed);
    expect(failedChecks.length).toBeGreaterThanOrEqual(2);
  });
});
