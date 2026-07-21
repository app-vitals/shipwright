import { expect, test } from "@playwright/test";

// Fulfill external font CDN requests immediately so the page's 'load' event
// fires even when CI can't reach external networks.
test.beforeEach(async ({ page }) => {
  await page.route(
    /fonts\.googleapis\.com|fonts\.gstatic\.com|api\.fontshare\.com|googletagmanager\.com/,
    (route) =>
      route.fulfill({ status: 200, contentType: "text/css", body: "" }),
  );
});

// Cron jobs guide page tests (UDG-1.3)

test("GET /docs/cron-jobs returns 200", async ({ page }) => {
  const response = await page.goto("/docs/cron-jobs");
  expect(response?.status()).toBe(200);
});

test("cron-jobs page has h1 heading", async ({ page }) => {
  await page.goto("/docs/cron-jobs");
  const h1 = page.locator("h1");
  await expect(h1).toBeVisible();
});

test("sidebar is present on cron-jobs page", async ({ page }) => {
  await page.goto("/docs/cron-jobs");
  const sidebar = page.locator("nav[aria-label='Docs navigation']");
  await expect(sidebar).toBeVisible();
});

test("cron-jobs page has a 'how crons work' section", async ({ page }) => {
  await page.goto("/docs/cron-jobs");
  const heading = page.locator("h2", { hasText: /how crons work/i });
  await expect(heading).toBeVisible();
});

test("cron-jobs page has an 'investigating a cron' section", async ({
  page,
}) => {
  await page.goto("/docs/cron-jobs");
  const heading = page.locator("h2", { hasText: /investigating a cron/i });
  await expect(heading).toBeVisible();
});

test("prev navigation link is present on cron-jobs page", async ({
  page,
}) => {
  await page.goto("/docs/cron-jobs");
  // prev → slack-integration
  const prevLink = page.locator("a[data-nav='prev']");
  await expect(prevLink).toBeVisible();
  expect(await prevLink.getAttribute("href")).toBe("/docs/slack-integration");
});
