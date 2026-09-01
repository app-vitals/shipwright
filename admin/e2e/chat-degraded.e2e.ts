/**
 * admin/e2e/chat-degraded.e2e.ts
 * Admin UI — Chat Degraded Mode E2E Tests (CFB-2.3)
 *
 * Proves that `chatClient` is a genuinely injectable dependency of the test
 * server, not a hardcoded mock — and that the three other chat e2e suites
 * (chat-page.e2e.ts, chat-thread-page.e2e.ts, chat-progress.e2e.ts) are
 * exercising the real chat UI rather than silently passing against a
 * degraded fallback page.
 *
 * When the server is spawned with ADMIN_E2E_CHAT_CLIENT_ABSENT=1, test-server.ts
 * builds AdminUIDeps with chatClient: undefined, which is the same condition
 * production hits when SHIPWRIGHT_CHAT_SERVICE_URL /
 * SHIPWRIGHT_CHAT_SERVICE_ADMIN_TOKEN are unset. Both /admin/chat and the
 * per-thread route must then render the "Chat service not configured." alert
 * instead of the real thread list / message UI.
 *
 * Architecture mirrors chat-progress.e2e.ts: spawns admin/e2e/test-server.ts
 * via Bun as a child process, mints session cookies via hono/jwt.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type BrowserContext, type Page, expect, test } from "@playwright/test";
import { sign } from "hono/jwt";

// ─── Constants ────────────────────────────────────────────────────────────────

const PORT = 3495;
const BASE_URL = `http://localhost:${PORT}`;
const SESSION_SECRET = "e2e-admin-test-secret-32chars!!!";
const SESSION_COOKIE = "admin_session";
const AGENT_ID = "agent-e2e-1";
// Matches MOCK_CHAT_THREAD.id in test-server.ts.
const THREAD_ID = "thread-e2e-1";

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
      // Configure this spawned server to run with no chatClient at all, so
      // the /admin/chat* routes fall back to degraded-mode rendering.
      ADMIN_E2E_CHAT_CLIENT_ABSENT: "1",
    },
    stdio: "pipe",
    cwd: resolve(__dirname, "../.."),
  });

  serverProcess.stderr?.on("data", (data: Buffer) => {
    const msg = data.toString();
    if (msg.trim()) console.error("[admin-e2e-chat-degraded-server]", msg.trim());
  });

  serverProcess.stdout?.on("data", (data: Buffer) => {
    const msg = data.toString();
    if (msg.trim()) console.log("[admin-e2e-chat-degraded-server]", msg.trim());
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

async function authenticate(context: BrowserContext): Promise<void> {
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
}

// ─── Tests ────────────────────────────────────────────────────────────────────

test.describe("GET /admin/chat* — CFB-2.3 degraded mode (chatClient absent)", () => {
  test("the chat list page renders the degraded alert instead of the thread list", async ({
    page,
    context,
  }) => {
    await authenticate(context);
    await page.goto(`${BASE_URL}/admin/chat?agentId=${AGENT_ID}`);

    await expect(page.locator(".alert.alert-error")).toContainText(
      "Chat service not configured.",
    );
    await expect(page.locator(".thread-pane-list")).toHaveCount(0);
  });

  test("the thread detail page renders the degraded alert instead of the message UI", async ({
    page,
    context,
  }) => {
    await authenticate(context);
    await page.goto(
      `${BASE_URL}/admin/chat/${AGENT_ID}/threads/${THREAD_ID}`,
    );

    await expect(page.locator(".alert.alert-error")).toContainText(
      "Chat service not configured.",
    );
    await expect(page.locator("#live-status-bubble")).toHaveCount(0);
    await expect(page.locator("#messages-container")).toHaveCount(0);
  });
});
