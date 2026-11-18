/**
 * metrics/src/dashboard-coverage-range.smoke.test.ts
 * Smoke (SCM-5.1): in a real headless browser (launchBrowser), toggling the
 * dashboard date range refetches /metrics/coverage with the selected preset.
 * Skipped when Chromium is unavailable. DI seam only; no mock.module().
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
    console.warn("[coverage-range smoke] Chromium unavailable, skipping", err);
    return;
  }
  const app = createMetricsApp(
    new Map(),
    makeAccountsClientMock(async () => []),
    {
      provider: createFixtureTaskStoreProvider(),
      sessionSecret: "",
      dashboardDevAuth: true,
    },
  );
  server = Bun.serve({ port: 0, fetch: app.fetch });
});

afterAll(async () => {
  await browser?.close();
  server?.stop(true);
});

describe("dashboard coverage range toggle", () => {
  test("switching 7D/30D/90D refetches /metrics/coverage with that preset", async () => {
    if (!browser || !server) return;
    const page = await browser.newPage();
    try {
      await page.goto(`http://localhost:${server.port}/dashboard`, {
        waitUntil: "networkidle",
      });
      for (const preset of ["7d", "30d", "90d"]) {
        const [req] = await Promise.all([
          page.waitForRequest(
            (r) => r.url().includes(`/metrics/coverage?preset=${preset}`),
            { timeout: 10_000 },
          ),
          page.click(`.date-btn[data-range="${preset}"]`),
        ]);
        expect(req.url()).toContain(`preset=${preset}`);
      }
    } finally {
      await page.close();
    }
  });
});
