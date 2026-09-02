/**
 * admin/e2e/chat-progress.e2e.ts
 * Admin UI — Chat Live Progress E2E Tests (CFB-2.3)
 *
 * Proves the two live-progress guarantees the owner asked for, in a real
 * browser against the mock chat server (ADMIN_E2E_CHAT_PENDING=1 makes the
 * thread's last message an UNREPLIED user message whose progressSeq is FROZEN):
 *
 *   1. Layer-1 elapsed ticker: the "working… (Ns)" value visibly increments
 *      across two DOM reads ~2s apart. The ticker computes now - createdAt on a
 *      1s client-side interval with ZERO network dependency — so this is a real
 *      wall-clock assertion, not a fake-clock unit test.
 *
 *   2. Stall state: because progressSeq never advances, the live status bubble
 *      gains .chat-stall-indicator once STALL_WARN_AFTER_MS elapses. A real
 *      120s wait would be a bad test, so the route accepts a
 *      ?stallWarnAfterMs=<small> override (production defaults to 120000).
 *
 * Architecture mirrors chat-thread-page.e2e.ts: spawns admin/e2e/test-server.ts
 * via Bun as a child process, mints session cookies via hono/jwt.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type BrowserContext, type Page, expect, test } from "@playwright/test";
import { sign } from "hono/jwt";

// ─── Constants ────────────────────────────────────────────────────────────────

const PORT = 3494;
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
      // Make the thread's last message a frozen-progress pending user message.
      ADMIN_E2E_CHAT_PENDING: "1",
    },
    stdio: "pipe",
    cwd: resolve(__dirname, "../.."),
  });

  serverProcess.stderr?.on("data", (data: Buffer) => {
    const msg = data.toString();
    if (msg.trim())
      console.error("[admin-e2e-chat-progress-server]", msg.trim());
  });

  serverProcess.stdout?.on("data", (data: Buffer) => {
    const msg = data.toString();
    if (msg.trim()) console.log("[admin-e2e-chat-progress-server]", msg.trim());
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

async function loadThread(
  page: Page,
  context: BrowserContext,
  query = "",
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
  await page.goto(
    `${BASE_URL}/admin/chat/${AGENT_ID}/threads/${THREAD_ID}${query}`,
  );
}

/** Parse the integer seconds out of "working… (12s)". */
function parseElapsedSeconds(text: string | null): number {
  const m = (text ?? "").match(/\((\d+)s\)/);
  return m ? Number.parseInt(m[1], 10) : Number.NaN;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

test.describe("GET /admin/chat/:agentId/threads/:threadId — CFB-2.3 live progress", () => {
  test("the server renders the live status bubble for a pending message", async ({
    page,
    context,
  }) => {
    await loadThread(page, context);
    await expect(page.locator("#live-status-bubble")).toBeVisible();
    await expect(page.locator("#live-status-elapsed")).toBeVisible();
    // progressPhase "reading" → "Reading files…" milestone.
    await expect(page.locator("#live-status-milestone")).toHaveText(
      "Reading files…",
    );
  });

  test("elapsed ticker visibly increments across two DOM reads ~2s apart", async ({
    page,
    context,
  }) => {
    await loadThread(page, context);

    const elapsed = page.locator("#live-status-elapsed");
    await expect(elapsed).toBeVisible();

    const first = parseElapsedSeconds(await elapsed.textContent());
    expect(Number.isNaN(first)).toBe(false);

    // Real-time wait — the 1s ticker must advance the value with no network.
    await page.waitForTimeout(2500);

    const second = parseElapsedSeconds(await elapsed.textContent());
    expect(Number.isNaN(second)).toBe(false);
    expect(second).toBeGreaterThan(first);
  });

  test("elapsed keeps ticking even with the poll endpoint failing (zero network dependency)", async ({
    page,
    context,
  }) => {
    // Block the messages.json poll entirely — Layer 1 must be immune.
    await context.route("**/messages.json*", (route) => route.abort());
    await loadThread(page, context);

    const elapsed = page.locator("#live-status-elapsed");
    await expect(elapsed).toBeVisible();
    const first = parseElapsedSeconds(await elapsed.textContent());
    await page.waitForTimeout(2500);
    const second = parseElapsedSeconds(await elapsed.textContent());
    expect(second).toBeGreaterThan(first);
  });

  test("stall state appears once progressSeq stays frozen past the threshold", async ({
    page,
    context,
  }) => {
    // Shrink the stall threshold so we don't wait a real 120s. progressSeq is
    // frozen in the fixture, so the stall class should appear shortly after.
    await loadThread(page, context, "?stallWarnAfterMs=1000");

    const live = page.locator("#live-status-bubble");
    await expect(live).toBeVisible();

    // Not stalled immediately on load.
    await expect(live).not.toHaveClass(/chat-stall-indicator/);

    // After the (shortened) threshold elapses with progressSeq frozen, the
    // stall indicator class is applied by the 1s ticker.
    await expect(live).toHaveClass(/chat-stall-indicator/, { timeout: 5000 });
  });
});
