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

// Day-to-day operations quick-start guide page tests (UDG-1.1)

test("GET /docs/day-to-day-operations returns 200", async ({ page }) => {
  const response = await page.goto("/docs/day-to-day-operations");
  expect(response?.status()).toBe(200);
});

test("day-to-day-operations page has h1 heading", async ({ page }) => {
  await page.goto("/docs/day-to-day-operations");
  const h1 = page.locator("h1");
  await expect(h1).toBeVisible();
});

test("day-to-day-operations sidebar is present", async ({ page }) => {
  await page.goto("/docs/day-to-day-operations");
  const sidebar = page.locator("nav[aria-label='Docs navigation']");
  await expect(sidebar).toBeVisible();
});

test("day-to-day-operations page has key section headings", async ({ page }) => {
  await page.goto("/docs/day-to-day-operations");
  // What you need section
  const needHeading = page.locator("h2", { hasText: /what you need/i });
  await expect(needHeading.first()).toBeVisible();
  // Day one checklist section
  const checklistHeading = page.locator("h2", { hasText: /day one checklist/i });
  await expect(checklistHeading.first()).toBeVisible();
  // Ongoing loop section
  const loopHeading = page.locator("h2", { hasText: /the ongoing loop/i });
  await expect(loopHeading.first()).toBeVisible();
});

test("day-to-day-operations page covers cron health, PR queue, and HITL", async ({
  page,
}) => {
  await page.goto("/docs/day-to-day-operations");
  const cronHeading = page.locator("h3, h2", { hasText: /cron health/i });
  await expect(cronHeading.first()).toBeVisible();
  const prQueueHeading = page.locator("h3, h2", { hasText: /pr queue/i });
  await expect(prQueueHeading.first()).toBeVisible();
  const hitlHeading = page.locator("h3, h2", { hasText: /hitl/i });
  await expect(hitlHeading.first()).toBeVisible();
});

test("day-to-day-operations prev/next navigation links", async ({ page }) => {
  await page.goto("/docs/day-to-day-operations");
  // prev → slack-integration
  const prevLink = page.locator("a[data-nav='prev']");
  await expect(prevLink).toBeVisible();
  expect(await prevLink.getAttribute("href")).toBe("/docs/slack-integration");
});

test("slack-integration page now links forward to day-to-day-operations", async ({
  page,
}) => {
  await page.goto("/docs/slack-integration");
  const nextLink = page.locator("a[data-nav='next']");
  await expect(nextLink).toBeVisible();
  expect(await nextLink.getAttribute("href")).toBe(
    "/docs/day-to-day-operations",
  );
});
