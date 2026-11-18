import { expect, test } from "@playwright/test";
import { adminSessionToken, authenticate, requireEnv } from "./helpers.ts";

test("the metrics dashboard renders", async ({ page, context }) => {
  const adminUrl = requireEnv("PREVIEW_ADMIN_URL");
  // Already includes the metrics basePath (written by `task preview:up`).
  const metricsUrl = requireEnv("PREVIEW_METRICS_URL").replace(/\/+$/, "");
  await authenticate(context, await adminSessionToken(adminUrl), [
    adminUrl,
    metricsUrl,
  ]);

  const response = await page.goto(`${metricsUrl}/dashboard`);
  expect(response?.status()).toBe(200);
  expect(page.url()).not.toContain("/admin/login");
  await expect(page.locator(".kpi-grid")).toBeVisible();
});
