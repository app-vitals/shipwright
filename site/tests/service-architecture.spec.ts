import { expect, test } from "@playwright/test";
import { expectNoRuntimeJsBeyondAnalytics } from "./helpers";

// Fulfill external font CDN requests immediately so the page's 'load' event
// fires even when CI can't reach external networks.
test.beforeEach(async ({ page }) => {
  await page.route(
    /fonts\.googleapis\.com|fonts\.gstatic\.com|api\.fontshare\.com|googletagmanager\.com/,
    (route) =>
      route.fulfill({ status: 200, contentType: "text/css", body: "" }),
  );
});

// /service-architecture smoke tests — static Astro page with no logic, no
// client JS, no hover-only interactivity, no resize-driven redraw (UGD-3.1).

test("service-architecture route responds 200", async ({ page }) => {
  const response = await page.goto("/service-architecture");
  expect(response?.status()).toBe(200);
});

test("service-architecture page has the correct heading and eyebrow", async ({
  page,
}) => {
  await page.goto("/service-architecture");
  await expect(
    page.getByRole("heading", { name: "Service Architecture" }).first(),
  ).toBeVisible();
  const text = (await page.locator("main").textContent()) ?? "";
  expect(text).toContain("Shipwright Harness");
});

test("service-architecture page shows all 4 service clusters", async ({
  page,
}) => {
  await page.goto("/service-architecture");
  const text = (await page.locator("main").textContent()) ?? "";
  for (const cluster of ["Agent", "Admin", "Task Store", "Metrics"]) {
    expect(text, `expected cluster "${cluster}" to be visible`).toContain(
      cluster,
    );
  }
});

test("service-architecture page lists key third-party integrations", async ({
  page,
}) => {
  await page.goto("/service-architecture");
  const text = (await page.locator("main").textContent()) ?? "";
  for (const integration of [
    "GitHub",
    "Claude API",
    "Slack",
    "Sentry",
    "Kubernetes",
    "Google OAuth",
  ]) {
    expect(
      text,
      `expected integration "${integration}" to be visible`,
    ).toContain(integration);
  }
});

test("service-architecture page cross-links to agent-model", async ({
  page,
}) => {
  await page.goto("/service-architecture");
  // Scoped to <main> — the shared nav also links to /agent-model post-rename,
  // so this asserts the page body itself carries the cross-link.
  await expect(
    page.locator('main a[href="/agent-model"]'),
  ).toHaveCount(2);
});

test("service-architecture page ships no runtime JS beyond the analytics tag", async ({
  page,
}) => {
  await page.goto("/service-architecture");
  await expectNoRuntimeJsBeyondAnalytics(page);
});
