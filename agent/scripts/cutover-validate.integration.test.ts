/**
 * agent/scripts/cutover-validate.integration.test.ts
 * Integration tests for the cutover-validate CLI. The script runs as a real
 * subprocess (so exit codes and stdout/stderr are asserted end to end) with a
 * preloaded `fetch` stub standing in for the shipwright API — no network.
 *
 * Note: SLACK_BOT_TOKEN is informational in validateCutover (chat-only agents
 * are supported), so a missing token is reported but never fails the run.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "cutover-validate.ts");
const AGENT_ID = "agent-cutover-cli";

// Preload that replaces globalThis.fetch before the script (and its API
// client) loads. Behaviour is driven by the FAKE_API env var (JSON).
const PRELOAD = `
const fake = JSON.parse(process.env.FAKE_API ?? "{}");
globalThis.fetch = async (input) => {
  const req = input instanceof Request ? input : new Request(input);
  const path = new URL(req.url).pathname;
  const json = (status, body) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  if (path.endsWith("/config")) {
    return fake.configStatus && fake.configStatus !== 200
      ? json(fake.configStatus, { error: "boom" })
      : json(200, { env: fake.env ?? {} });
  }
  if (path.endsWith("/crons")) return json(200, fake.crons ?? []);
  return json(404, { error: "not found" });
};
`;

let dir: string;
let preloadPath: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "cutover-validate-"));
  preloadPath = join(dir, "fake-fetch.ts");
  writeFileSync(preloadPath, PRELOAD);
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

interface FakeApi {
  env?: Record<string, string>;
  crons?: Array<{ id: string; enabled: boolean }>;
  configStatus?: number;
}

async function run(
  fake: FakeApi,
  envOverrides: Record<string, string | undefined> = {},
) {
  const env: Record<string, string | undefined> = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    SHIPWRIGHT_API_URL: "http://shipwright.invalid",
    SHIPWRIGHT_AGENT_API_KEY: "test-key",
    AGENT_ID,
    FAKE_API: JSON.stringify(fake),
    ...envOverrides,
  };
  const proc = Bun.spawn(["bun", "--preload", preloadPath, SCRIPT], {
    env: env as Record<string, string>,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

const GOOD_ENV = { SLACK_BOT_TOKEN: "xoxb-1", GH_TOKEN: "ghp_1" };
const ONE_CRON = [{ id: "c1", enabled: true }];

describe("cutover-validate CLI", () => {
  it("exits 0 with a passing report when all checks pass", async () => {
    const r = await run({ env: GOOD_ENV, crons: ONE_CRON });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("✓ SLACK_BOT_TOKEN: SLACK_BOT_TOKEN is present");
    expect(r.stdout).toContain("✓ github_auth");
    expect(r.stdout).toContain("✓ crons: 1 enabled cron job(s) configured");
    expect(r.stdout).toContain("All checks passed");
  });

  it("accepts GitHub App credentials in place of a PAT", async () => {
    const r = await run({
      env: {
        SLACK_BOT_TOKEN: "xoxb-1",
        GH_APP_ID: "123",
        GH_APP_PRIVATE_KEY: "pem",
      },
      crons: ONE_CRON,
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("✓ github_auth");
  });

  it("reports missing SLACK_BOT_TOKEN as chat-only without failing", async () => {
    const r = await run({ env: { GH_TOKEN: "ghp_1" }, crons: ONE_CRON });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("✓ SLACK_BOT_TOKEN");
    expect(r.stdout).toContain("chat-only agent");
    expect(r.stdout).toContain("All checks passed");
  });

  it("exits 1 and reports github_auth failure when credentials are missing", async () => {
    const r = await run({
      env: { SLACK_BOT_TOKEN: "xoxb-1" },
      crons: ONE_CRON,
    });
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain(
      "✗ github_auth: GitHub auth credentials missing",
    );
    expect(r.stdout).toContain("✓ SLACK_BOT_TOKEN");
    expect(r.stdout).toContain("✓ crons");
    expect(r.stderr).toContain("Validation failed");
  });

  it("treats a partial GitHub App credential set as missing", async () => {
    const r = await run({
      env: { SLACK_BOT_TOKEN: "xoxb-1", GH_APP_ID: "123" },
      crons: ONE_CRON,
    });
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain("✗ github_auth");
  });

  it("exits 1 and reports crons failure when there are zero crons", async () => {
    const r = await run({ env: GOOD_ENV, crons: [] });
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain("✗ crons: No enabled cron jobs configured");
    expect(r.stdout).toContain("✓ github_auth");
    expect(r.stderr).toContain("Validation failed");
  });

  it("does not count disabled crons", async () => {
    const r = await run({
      env: GOOD_ENV,
      crons: [{ id: "c1", enabled: false }],
    });
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain("✗ crons");
  });

  it("reports every failing check in a single run", async () => {
    const r = await run({ env: {}, crons: [] });
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain("✓ SLACK_BOT_TOKEN");
    expect(r.stdout).toContain("✗ github_auth");
    expect(r.stdout).toContain("✗ crons");
  });

  it("exits 1 with an error when the config fetch fails", async () => {
    const r = await run({ configStatus: 500, crons: ONE_CRON });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("failed to fetch agent config");
  });

  it("exits 1 with usage when a required env var is missing", async () => {
    const r = await run(
      { env: GOOD_ENV, crons: ONE_CRON },
      { AGENT_ID: undefined },
    );
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("AGENT_ID is not set");
    expect(r.stderr).toContain("Usage:");
  });
});
