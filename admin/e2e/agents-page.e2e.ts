/**
 * admin/e2e/agents-page.e2e.ts
 * Admin UI — Agents Page E2E Tests (ADM-3.2)
 *
 * Tests the agent detail page at GET /admin/agents/:id, covering:
 *   1.  Unauthenticated GET /admin/agents → redirects to /admin/login
 *   2.  Authenticated → page title contains agent name
 *   3.  Authenticated → h1 contains agent name
 *   4.  Authenticated → agent card shows agent name "Test Agent"
 *   5.  Env var key "SLACK_BOT_TOKEN" is visible
 *   6.  Env var value is masked (••••••••), raw secret not present in page
 *   7.  Cron job schedule "0 9 * * 1" is visible
 *   8.  Cron job prompt is visible
 *   9.  Token label "Production token" is visible
 *   10. Env var add form is present (action contains /envs)
 *   11. Add cron form is present (action contains /crons)
 *   12. Token form is present (action contains /tokens)
 *   13. Mobile viewport (375px) — no horizontal overflow
 *
 * Architecture:
 *   - Spawns admin/e2e/test-server.ts via Bun as a child process.
 *   - Uses hono/jwt sign() to mint valid session cookies directly.
 *   - No real DB or OAuth flow is initiated.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type BrowserContext, type Page, expect, test } from "@playwright/test";
import { sign } from "hono/jwt";

// ─── Constants ────────────────────────────────────────────────────────────────

const PORT = 3491;
const BASE_URL = `http://localhost:${PORT}`;
const SESSION_SECRET = "e2e-admin-test-secret-32chars!!!";
const SESSION_COOKIE = "admin_session";
const AGENT_ID = "agent-e2e-1";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Server lifecycle ─────────────────────────────────────────────────────────

let serverProcess: ChildProcess | null = null;

async function waitForServer(url: string, maxWaitMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    try {
      const res = await fetch(url);
      if (res.status < 500) return;
    } catch {
      // Not ready yet
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`Server at ${url} did not start within ${maxWaitMs}ms`);
}

test.beforeAll(async () => {
  const serverScript = resolve(__dirname, "test-server.ts");

  serverProcess = spawn("bun", ["run", serverScript], {
    env: {
      ...process.env,
      ADMIN_E2E_PORT: String(PORT),
      ADMIN_E2E_SESSION_SECRET: SESSION_SECRET,
    },
    stdio: "pipe",
    cwd: resolve(__dirname, "../.."),
  });

  serverProcess.stderr?.on("data", (data: Buffer) => {
    const msg = data.toString();
    if (msg.trim()) console.error("[admin-e2e-agents-server]", msg.trim());
  });

  serverProcess.stdout?.on("data", (data: Buffer) => {
    const msg = data.toString();
    if (msg.trim()) console.log("[admin-e2e-agents-server]", msg.trim());
  });

  await waitForServer(`${BASE_URL}/health`, 15_000);
});

test.afterAll(() => {
  if (serverProcess) {
    serverProcess.kill("SIGTERM");
    serverProcess = null;
  }
});

// ─── Session cookie helper ────────────────────────────────────────────────────

async function mintSession(
  userId = "google-sub-e2e",
  email = "admin@example.com",
): Promise<string> {
  const nowSec = Math.floor(Date.now() / 1000);
  return sign(
    { userId, email, iat: nowSec, exp: nowSec + 3600 },
    SESSION_SECRET,
    "HS256",
  );
}

// ─── Helper: load agent detail page with auth ─────────────────────────────────

async function loadAgentDetailPage(
  page: Page,
  context: BrowserContext,
): Promise<void> {
  const token = await mintSession();
  await context.addCookies([
    {
      name: SESSION_COOKIE,
      value: token,
      domain: "localhost",
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
  await page.goto(`${BASE_URL}/admin/agents/${AGENT_ID}`);
}

// ─── 1. Unauthenticated redirect ──────────────────────────────────────────────

test.describe("GET /admin/agents — unauthenticated", () => {
  test("redirects to /admin/login when no session cookie", async ({ page }) => {
    await page.goto(`${BASE_URL}/admin/agents`);
    await expect(page).toHaveURL(/\/admin\/login/);
  });
});

// ─── 2–13. Authenticated tests ────────────────────────────────────────────────

test.describe("GET /admin/agents/:id — authenticated", () => {
  test("page title contains agent name", async ({ page, context }) => {
    await loadAgentDetailPage(page, context);
    await expect(page).toHaveTitle(/Test Agent/);
  });

  test("h1 contains agent name", async ({ page, context }) => {
    await loadAgentDetailPage(page, context);
    await expect(page.locator("h1")).toContainText("Test Agent");
  });

  test('agent name "Test Agent" is visible on the page', async ({
    page,
    context,
  }) => {
    await loadAgentDetailPage(page, context);
    await expect(page.locator("body")).toContainText("Test Agent");
  });

  test('env var key "SLACK_BOT_TOKEN" is visible', async ({
    page,
    context,
  }) => {
    await loadAgentDetailPage(page, context);
    await expect(page.locator("body")).toContainText("SLACK_BOT_TOKEN");
  });

  test("env var value is masked — shows •••••••• and not the raw secret", async ({
    page,
    context,
  }) => {
    await loadAgentDetailPage(page, context);
    const body = await page.locator("body").textContent();
    expect(body).toContain("••••••••");
    expect(body).not.toContain("xoxb-secret-value");
  });

  test('cron job schedule "0 9 * * 1" is visible', async ({
    page,
    context,
  }) => {
    await loadAgentDetailPage(page, context);
    await expect(page.locator("body")).toContainText("0 9 * * 1");
  });

  test("cron job prompt is visible", async ({ page, context }) => {
    await loadAgentDetailPage(page, context);
    await expect(page.locator("body")).toContainText("Send the weekly standup");
  });

  test('token label "Production token" is visible', async ({
    page,
    context,
  }) => {
    await loadAgentDetailPage(page, context);
    await expect(page.locator("body")).toContainText("Production token");
  });

  test("env var add form is present (action contains /envs)", async ({
    page,
    context,
  }) => {
    await loadAgentDetailPage(page, context);
    const envForm = page.locator('form[action*="/envs"]').first();
    await expect(envForm).toBeAttached();
  });

  test("add cron form is present (action contains /crons)", async ({
    page,
    context,
  }) => {
    await loadAgentDetailPage(page, context);
    const cronForm = page.locator('form[action*="/crons"]').first();
    await expect(cronForm).toBeAttached();
  });

  test("token form is present (action contains /tokens)", async ({
    page,
    context,
  }) => {
    await loadAgentDetailPage(page, context);
    const tokenForm = page.locator('form[action*="/tokens"]').first();
    await expect(tokenForm).toBeAttached();
  });

  test("mobile viewport (375px) — page renders without horizontal overflow", async ({
    page,
    context,
  }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await loadAgentDetailPage(page, context);

    const docScrollWidth = await page.evaluate(
      () => document.documentElement.scrollWidth,
    );
    const innerWidth = await page.evaluate(() => window.innerWidth);
    expect(docScrollWidth).toBeLessThanOrEqual(innerWidth + 1);
  });
});
