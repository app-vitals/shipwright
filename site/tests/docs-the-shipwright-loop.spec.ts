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

// The Shipwright Loop dispatcher explainer page tests

test("GET /docs/the-shipwright-loop returns 200", async ({ page }) => {
  const response = await page.goto("/docs/the-shipwright-loop");
  expect(response?.status()).toBe(200);
});

test("the-shipwright-loop page has h1 heading", async ({ page }) => {
  await page.goto("/docs/the-shipwright-loop");
  const h1 = page.locator("h1");
  await expect(h1).toBeVisible();
});

test("the-shipwright-loop sidebar is present", async ({ page }) => {
  await page.goto("/docs/the-shipwright-loop");
  const sidebar = page.locator("nav[aria-label='Docs navigation']");
  await expect(sidebar).toBeVisible();
});

test("the-shipwright-loop page has a dispatch/drain-until-dry heading", async ({
  page,
}) => {
  await page.goto("/docs/the-shipwright-loop");
  const heading = page.locator("h2, h3", {
    hasText: /dispatch|drain.until.dry/i,
  });
  await expect(heading.first()).toBeVisible();
});

test("the-shipwright-loop page names the four phase toggles", async ({
  page,
}) => {
  await page.goto("/docs/the-shipwright-loop");
  const body = await page.textContent("body");
  expect(body).toContain("shipwright-dev-task");
  expect(body).toContain("shipwright-review");
  expect(body).toContain("shipwright-patch");
  expect(body).toContain("shipwright-deploy");
});

test("the-shipwright-loop page describes the FIFO work-selector", async ({
  page,
}) => {
  await page.goto("/docs/the-shipwright-loop");
  const body = await page.textContent("body");
  expect(body?.toLowerCase()).toContain("fifo");
  expect(body?.toLowerCase()).toContain("age");
  // No phase-priority bias is a load-bearing claim from work-selector.ts
  expect(body?.toLowerCase()).toMatch(/no phase (bias|priority|-priority bias)/);
});

test("the-shipwright-loop page describes pre-claim before dispatch", async ({
  page,
}) => {
  await page.goto("/docs/the-shipwright-loop");
  const body = await page.textContent("body");
  expect(body?.toLowerCase()).toContain("pre-claim");
  expect(body).toContain("409");
});

test("the-shipwright-loop page cross-links to configuring-autonomy instead of duplicating it", async ({
  page,
}) => {
  await page.goto("/docs/the-shipwright-loop");
  const link = page.locator('a[href="/docs/configuring-autonomy"]');
  await expect(link.first()).toBeAttached();
});
