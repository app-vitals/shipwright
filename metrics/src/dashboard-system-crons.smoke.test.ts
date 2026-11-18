/**
 * metrics/src/dashboard-system-crons.smoke.test.ts
 * Smoke (SCM-8.4): in a real headless browser (launchBrowser), the dashboard
 * renders the system-cron tile (one row per cron, lead shipped number, as-of
 * time + repo scope), each number links to the admin tasks list filtered to its
 * rows, and toggling the date range refetches /metrics/system-crons.
 * Skipped when Chromium is unavailable. Fixture provider DI only; no mock.module().
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { launchBrowser } from "@app-vitals/agent-runtime/browser";
import { createMetricsApp } from "./api.ts";
import { createFixtureTaskStoreProvider } from "./fixtures/task-store-fixtures.ts";
import { makeAccountsClientMock } from "./lib/test-helpers.ts";

type Browser = Awaited<ReturnType<typeof launchBrowser>>;

let browser: Browser | null = null;
let server: ReturnType<typeof Bun.serve> | null = null;

beforeAll(async () => {
  try {
    browser = await launchBrowser();
  } catch (err) {
    console.warn("[system-crons smoke] Chromium unavailable, skipping", err);
    return;
  }
  const app = createMetricsApp(
    new Map(),
    makeAccountsClientMock(async () => []),
    {
      provider: createFixtureTaskStoreProvider(),
      sessionSecret: "",
      dashboardDevAuth: true,
      adminBaseUrl: "http://admin.test:3001",
    },
  );
  server = Bun.serve({ port: 0, fetch: app.fetch });
});

afterAll(async () => {
  await browser?.close();
  server?.stop(true);
});

// Fixture tasks are created ~2h before "now"; the default "today" range can
// start after that (00:00-02:00 PT), so pin a wide range to stay time-stable.
async function selectWideRange(page: Awaited<ReturnType<Browser["newPage"]>>) {
  await Promise.all([
    page.waitForResponse((r) =>
      r.url().includes("/metrics/system-crons?preset=7d"),
    ),
    page.click('.date-btn[data-range="7d"]'),
  ]);
}

describe("dashboard system crons tile", () => {
  test("renders one row per cron with shipped, stuck, failed, follow-ons, as-of and repo scope", async () => {
    if (!browser || !server) return;
    const page = await browser.newPage();
    try {
      await page.goto(`http://localhost:${server.port}/dashboard`, {
        waitUntil: "networkidle",
      });
      await selectWideRange(page);
      await page.waitForSelector('tr[data-cron="test-readiness"]');
      expect(await page.locator("#system-crons-tbody tr").count()).toBe(1);
      const text = (field: string) =>
        page
          .locator(`tr[data-cron="test-readiness"] a[data-field="${field}"]`)
          .innerText();
      expect(await text("shipped")).toBe("1");
      expect(await text("stuck")).toBe("1");
      expect(await text("failed")).toBe("1");
      expect(await text("followOnCreated")).toBe("2");
      expect(await text("followOnShipped")).toBe("1");
      expect(await text("noOp")).toBe("1");
      const meta = await page.locator("#system-crons-meta").innerText();
      expect(meta).toContain("2 repos");
      expect(meta).toMatch(/as of \d+[sm] ago/);
    } finally {
      await page.close();
    }
  }, 30_000);

  test("each number links to the admin tasks list filtered to its rows", async () => {
    if (!browser || !server) return;
    const page = await browser.newPage();
    try {
      await page.goto(`http://localhost:${server.port}/dashboard`, {
        waitUntil: "networkidle",
      });
      await selectWideRange(page);
      await page.waitForSelector('tr[data-cron="test-readiness"]');
      const href = async (field: string) =>
        new URL(
          (await page
            .locator(`tr[data-cron="test-readiness"] a[data-field="${field}"]`)
            .getAttribute("href")) as string,
        );
      const shipped = await href("shipped");
      expect(shipped.origin).toBe("http://admin.test:3001");
      expect(shipped.pathname).toBe("/admin/tasks");
      expect(shipped.searchParams.get("originKind")).toBe("cron");
      expect(shipped.searchParams.get("originRef")).toBe("test-readiness");
      expect(shipped.searchParams.get("source")).toBe("system-cron");
      expect(shipped.searchParams.get("bucket")).toBe("shipped");
      const failed = await href("failed");
      expect(failed.searchParams.get("status")).toBe("cancelled");
      const followOn = await href("followOnShipped");
      expect(followOn.searchParams.get("sourceNot")).toBe("system-cron");
      expect(followOn.searchParams.get("bucket")).toBe("shipped");
      expect(followOn.searchParams.get("source")).toBeNull();
    } finally {
      await page.close();
    }
  }, 30_000);

  test("switching the date range refetches /metrics/system-crons with that preset", async () => {
    if (!browser || !server) return;
    const page = await browser.newPage();
    try {
      await page.goto(`http://localhost:${server.port}/dashboard`, {
        waitUntil: "networkidle",
      });
      for (const preset of ["7d", "30d", "90d"]) {
        const [req] = await Promise.all([
          page.waitForRequest(
            (r) => r.url().includes(`/metrics/system-crons?preset=${preset}`),
            { timeout: 10_000 },
          ),
          page.click(`.date-btn[data-range="${preset}"]`),
        ]);
        expect(req.url()).toContain(`preset=${preset}`);
      }
    } finally {
      await page.close();
    }
  }, 30_000);
});
