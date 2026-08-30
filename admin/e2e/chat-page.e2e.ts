/**
 * admin/e2e/chat-page.e2e.ts
 * Admin UI — Chat List Page E2E Tests (CFB-3.1)
 *
 * Covers the mobile responsive defects on GET /admin/chat (the top-level
 * agent selector + thread list page, distinct from the per-thread page
 * covered by chat-thread-page.e2e.ts):
 *   - Every visible input/select computes font-size >= 16px at 375px (iOS
 *     Safari zoom-on-focus guard).
 *   - No horizontal overflow at 375px and 768px.
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

const PORT = 3493;
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
    if (msg.trim()) console.error("[admin-e2e-chat-page-server]", msg.trim());
  });

  serverProcess.stdout?.on("data", (data: Buffer) => {
    const msg = data.toString();
    if (msg.trim()) console.log("[admin-e2e-chat-page-server]", msg.trim());
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

// ─── Helper: load chat list page with auth ────────────────────────────────────

async function loadChatPage(
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
  await page.goto(`${BASE_URL}/admin/chat?agentId=${AGENT_ID}`);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

test.describe("GET /admin/chat — CFB-3.1 mobile responsive", () => {
  test("at 375px, every visible input/select computes font-size >= 16px", async ({
    page,
    context,
  }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await loadChatPage(page, context);

    const fontSizes = await page.evaluate(() => {
      const els = Array.from(
        document.querySelectorAll("input, textarea, select"),
      ) as HTMLElement[];
      return els
        .filter((el) => {
          const style = getComputedStyle(el);
          return (
            style.display !== "none" &&
            style.visibility !== "hidden" &&
            (el as HTMLInputElement).type !== "hidden"
          );
        })
        .map((el) => ({
          id: el.id || el.tagName,
          fontSize: Number.parseFloat(getComputedStyle(el).fontSize),
        }));
    });

    expect(fontSizes.length).toBeGreaterThan(0);
    for (const { id, fontSize } of fontSizes) {
      expect(fontSize, `${id} font-size`).toBeGreaterThanOrEqual(16);
    }
  });

  test("at 375px and 768px, no horizontal overflow", async ({
    page,
    context,
  }) => {
    for (const width of [375, 768]) {
      await page.setViewportSize({ width, height: 812 });
      await loadChatPage(page, context);

      const { scrollWidth, clientWidth } = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      }));
      expect(scrollWidth, `width=${width}`).toBeLessThanOrEqual(clientWidth);
    }
  });
});
