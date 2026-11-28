/**
 * metrics/src/dashboard-readiness.smoke.test.ts
 * Smoke (RDY-5.1): in a real headless browser (launchBrowser), the dashboard's
 * "Readiness by repo" section renders the headline percentage, a level per
 * repo and each failing check with its owner cron — or "no owner running" —
 * from the fixture summary, and the public dashboard omits it. Skipped when
 * Chromium is unavailable. Fixture provider DI only; no mock.module().
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
    console.warn("[readiness smoke] Chromium unavailable, skipping", err);
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
}, 30_000);

afterAll(async () => {
  await browser?.close();
  server?.stop(true);
});

describe("dashboard readiness section", () => {
  test("renders headline, level per repo and failing checks with owners", async () => {
    if (!browser || !server) return;
    const page = await browser.newPage();
    try {
      await page.goto(`http://localhost:${server.port}/dashboard`, {
        waitUntil: "networkidle",
      });
      await page.waitForSelector('#readiness-tbody tr[data-repo="org/beta"]');
      expect(await page.locator("#readiness-headline").innerText()).toBe(
        "50% of repos at Level 3+",
      );
      expect(await page.locator("#readiness-count").innerText()).toBe(
        "2 repos",
      );
      const beta = page.locator('#readiness-tbody tr[data-repo="org/beta"]');
      expect(await beta.locator("td").nth(1).innerText()).toBe("L2");
      const lockfile = await beta
        .locator('[data-check="lockfile"]')
        .innerText();
      expect(lockfile).toContain("test-readiness");
      const preview = await beta
        .locator('[data-check="preview-env"]')
        .innerText();
      expect(preview).toContain("no owner running");
    } finally {
      await page.close();
    }
  }, 30_000);

  test("public dashboard omits the section and never fetches /metrics/readiness", async () => {
    if (!browser || !server) return;
    const page = await browser.newPage();
    const seen: string[] = [];
    page.on("request", (r) => seen.push(r.url()));
    try {
      await page.goto(`http://localhost:${server.port}/public/dashboard`, {
        waitUntil: "networkidle",
      });
      expect(await page.locator("#readiness-section").count()).toBe(0);
      expect(seen.some((u) => u.includes("readiness"))).toBe(false);
    } finally {
      await page.close();
    }
  }, 30_000);
});
