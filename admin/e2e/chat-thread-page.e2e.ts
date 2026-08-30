/**
 * admin/e2e/chat-thread-page.e2e.ts
 * Admin UI — Chat Thread Page E2E Tests (CFB-1.3)
 *
 * Proves the inline-style → class migration produced no visual change: at a
 * desktop viewport, `.chat-bubble-inner`'s computed width must still be 70%
 * of its containing block (`#messages-container`), matching the value that
 * used to be set via an inline `style="max-width:70%"` before the migration
 * moved it into the `.chat-bubble-inner` CSS class.
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

const PORT = 3492;
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
    },
    stdio: "pipe",
    cwd: resolve(__dirname, "../.."),
  });

  serverProcess.stderr?.on("data", (data: Buffer) => {
    const msg = data.toString();
    if (msg.trim()) console.error("[admin-e2e-chat-thread-server]", msg.trim());
  });

  serverProcess.stdout?.on("data", (data: Buffer) => {
    const msg = data.toString();
    if (msg.trim()) console.log("[admin-e2e-chat-thread-server]", msg.trim());
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

// ─── Helper: load chat thread page with auth ──────────────────────────────────

async function loadChatThreadPage(
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
  await page.goto(`${BASE_URL}/admin/chat/${AGENT_ID}/threads/${THREAD_ID}`);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

test.describe("GET /admin/chat/:agentId/threads/:threadId — CFB-1.3 class migration", () => {
  test("page renders the fixture message inside a .chat-bubble-inner element", async ({
    page,
    context,
  }) => {
    await loadChatThreadPage(page, context);
    await expect(page.locator(".chat-bubble-inner").first()).toBeVisible();
    await expect(page.locator("body")).toContainText(
      "Hello from the e2e test suite",
      { useInnerText: true },
    );
  });

  test("no style attribute on the migrated elements (page wrapper, header, messages container, bubble, bubble inner)", async ({
    page,
    context,
  }) => {
    await loadChatThreadPage(page, context);

    await expect(
      page.locator(".vos-page.chat-thread-page"),
    ).not.toHaveAttribute("style", /.+/);
    await expect(
      page.locator(".page-header.chat-thread-header"),
    ).not.toHaveAttribute("style", /.+/);
    await expect(page.locator("#messages-container")).not.toHaveAttribute(
      "style",
      /.+/,
    );
    await expect(page.locator(".chat-bubble").first()).not.toHaveAttribute(
      "style",
      /.+/,
    );
    await expect(
      page.locator(".chat-bubble-inner").first(),
    ).not.toHaveAttribute("style", /.+/);
  });

  test("at 1280px viewport, .chat-bubble-inner computed width is 70% of #messages-container", async ({
    page,
    context,
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await loadChatThreadPage(page, context);

    const bubbleInner = page.locator(".chat-bubble-inner").first();
    await expect(bubbleInner).toBeVisible();

    const bubbleWidth = await bubbleInner.evaluate(
      (el) => el.getBoundingClientRect().width,
    );
    const containerWidth = await page
      .locator("#messages-container")
      .evaluate((el) => el.getBoundingClientRect().width);

    const ratio = bubbleWidth / containerWidth;
    // The bubble inner's max-width:70% caps it at 70% of the container, but
    // an unconstrained (narrow) message could render narrower still — assert
    // it's at/near the 70% cap, not merely "less than" some looser bound.
    expect(ratio).toBeGreaterThan(0.65);
    expect(ratio).toBeLessThanOrEqual(0.71);
  });

  test("at 375px mobile viewport, .chat-bubble-inner computed width is 90% of #messages-container", async ({
    page,
    context,
  }) => {
    // Regression guard: chatPageStyles's @media (max-width:640px) override
    // (.chat-bubble-inner { max-width:90% }) must win the cascade over
    // chatThreadStyles's unconditional base rule (max-width:70%) at mobile
    // widths — see CFB-1.3 review discussion on concatenation order.
    await page.setViewportSize({ width: 375, height: 812 });
    await loadChatThreadPage(page, context);

    const bubbleInner = page.locator(".chat-bubble-inner").first();
    await expect(bubbleInner).toBeVisible();

    const bubbleWidth = await bubbleInner.evaluate(
      (el) => el.getBoundingClientRect().width,
    );
    const containerWidth = await page
      .locator("#messages-container")
      .evaluate((el) => el.getBoundingClientRect().width);

    const ratio = bubbleWidth / containerWidth;
    expect(ratio).toBeGreaterThan(0.85);
    expect(ratio).toBeLessThanOrEqual(0.91);
  });
});

// ─── CFB-3.1 — mobile responsive defects ───────────────────────────────────────

test.describe("GET /admin/chat/:agentId/threads/:threadId — CFB-3.1 mobile responsive", () => {
  test("at 375px, every visible input/textarea/select computes font-size >= 16px", async ({
    page,
    context,
  }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await loadChatThreadPage(page, context);

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
            (el as HTMLInputElement).type !== "hidden" &&
            (el as HTMLInputElement).type !== "checkbox" &&
            (el as HTMLInputElement).type !== "file"
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
      await loadChatThreadPage(page, context);

      const { scrollWidth, clientWidth } = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      }));
      expect(scrollWidth, `width=${width}`).toBeLessThanOrEqual(clientWidth);
    }
  });

  test("at a mobile viewport, touch targets are >= 44px except .data-table .btn", async ({
    page,
    context,
  }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await loadChatThreadPage(page, context);

    const heights = await page.evaluate(() => {
      const els = Array.from(
        document.querySelectorAll(".btn, .thread-pane-link"),
      ) as HTMLElement[];
      return els
        .filter((el) => {
          const rect = el.getBoundingClientRect();
          // offsetParent is null when the element (or an ancestor) is
          // display:none — e.g. .chat-thread-sidebar collapses on mobile,
          // which zeroes out its descendants' rects without those elements
          // themselves being display:none. Skip anything not actually
          // rendered rather than asserting on a phantom 0-height box.
          return el.offsetParent !== null && rect.width > 0 && rect.height > 0;
        })
        .map((el) => ({
          className: el.className,
          height: el.getBoundingClientRect().height,
        }));
    });

    expect(heights.length).toBeGreaterThan(0);
    for (const { className, height } of heights) {
      expect(height, className).toBeGreaterThanOrEqual(44);
    }
  });

  test("the rename/delete forms are collapsed behind a <details> element by default", async ({
    page,
    context,
  }) => {
    await loadChatThreadPage(page, context);

    const details = page.locator("details.chat-thread-actions");
    await expect(details).toBeAttached();
    const isOpen = await details.evaluate(
      (el) => (el as HTMLDetailsElement).open,
    );
    expect(isOpen).toBe(false);

    // The rename/delete forms exist in the DOM but aren't visible until expanded.
    await expect(page.locator('form[action*="/rename"]')).not.toBeVisible();
    await expect(page.locator('form[action*="/delete"]')).not.toBeVisible();
  });

  test("the chat-thread-page layout does not collapse to zero height at a mobile viewport", async ({
    page,
    context,
  }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await loadChatThreadPage(page, context);

    const pageHeight = await page
      .locator(".chat-thread-page")
      .evaluate((el) => el.getBoundingClientRect().height);
    expect(pageHeight).toBeGreaterThan(400);
  });
});
