/**
 * admin/e2e/login-page.e2e.ts
 * Admin UI — Login Page E2E Tests (ADM-3.2)
 *
 * Tests the static render of GET /admin/login, covering:
 *   1. "Sign in with Google" button is present
 *   2. Error banner visible for ?error=invalid_state
 *   3. Error banner visible for ?error=access_denied
 *   4. Error banner visible for ?error=auth_failed
 *   5. Error banner visible for ?error=server_error
 *   6. No error banner when no ?error= param
 *   7. ?returnTo= param is preserved in the OAuth button href
 *   8. No ?returnTo= → OAuth button href is plain /admin/auth/google
 *
 * Architecture:
 *   - Spawns admin/e2e/test-server.ts via Bun as a child process.
 *   - The /admin/login route is a pure static render — no DB access.
 *   - No real OAuth flow is initiated.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

// ─── Port ─────────────────────────────────────────────────────────────────────

const PORT = 3490;
const BASE_URL = `http://localhost:${PORT}`;

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
  throw new Error(`Server at ${url} failed to start within ${maxWaitMs}ms`);
}

test.beforeAll(async () => {
  const serverScript = resolve(__dirname, "test-server.ts");

  serverProcess = spawn("bun", ["run", serverScript], {
    env: {
      ...process.env,
      ADMIN_E2E_PORT: String(PORT),
    },
    stdio: "pipe",
    cwd: resolve(__dirname, "../.."),
  });

  serverProcess.stderr?.on("data", (data: Buffer) => {
    const msg = data.toString();
    if (msg.trim()) console.error("[admin-e2e-login-server]", msg.trim());
  });

  await waitForServer(`${BASE_URL}/health`, 15_000);
});

test.afterAll(() => {
  if (serverProcess) {
    serverProcess.kill("SIGTERM");
    serverProcess = null;
  }
});

// ─── Tests ────────────────────────────────────────────────────────────────────

test.describe("GET /admin/login — static render", () => {
  test('renders "Sign in with Google" button', async ({ page }) => {
    await page.goto(`${BASE_URL}/admin/login`);

    const btn = page.locator(".btn.btn-primary");
    await expect(btn).toBeVisible();
    await expect(btn).toContainText("Sign in with Google");
  });

  test("no error banner when no ?error= param", async ({ page }) => {
    await page.goto(`${BASE_URL}/admin/login`);
    await expect(page.locator(".alert.alert-error")).not.toBeVisible();
  });

  test("?error=invalid_state shows error banner", async ({ page }) => {
    await page.goto(`${BASE_URL}/admin/login?error=invalid_state`);
    const banner = page.locator(".alert.alert-error");
    await expect(banner).toBeVisible();
    await expect(banner).toContainText("invalid_state");
  });

  test("?error=access_denied shows error banner", async ({ page }) => {
    await page.goto(`${BASE_URL}/admin/login?error=access_denied`);
    const banner = page.locator(".alert.alert-error");
    await expect(banner).toBeVisible();
    await expect(banner).toContainText("access_denied");
  });

  test("?error=auth_failed shows error banner", async ({ page }) => {
    await page.goto(`${BASE_URL}/admin/login?error=auth_failed`);
    const banner = page.locator(".alert.alert-error");
    await expect(banner).toBeVisible();
    await expect(banner).toContainText("auth_failed");
  });

  test("?error=server_error shows error banner", async ({ page }) => {
    await page.goto(`${BASE_URL}/admin/login?error=server_error`);
    const banner = page.locator(".alert.alert-error");
    await expect(banner).toBeVisible();
    await expect(banner).toContainText("server_error");
  });

  test("?returnTo= param is preserved in OAuth button href", async ({
    page,
  }) => {
    const returnTo = "/admin/agents";
    await page.goto(
      `${BASE_URL}/admin/login?returnTo=${encodeURIComponent(returnTo)}`,
    );

    const btn = page.locator(".btn.btn-primary");
    const href = await btn.getAttribute("href");

    expect(href).not.toBeNull();
    expect(href).toContain("/admin/auth/google");
    expect(href).toContain(`returnTo=${encodeURIComponent(returnTo)}`);
  });

  test("no ?returnTo= → OAuth button href is plain /admin/auth/google", async ({
    page,
  }) => {
    await page.goto(`${BASE_URL}/admin/login`);

    const btn = page.locator(".btn.btn-primary");
    const href = await btn.getAttribute("href");

    expect(href).toBe("/admin/auth/google");
  });
});
