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

// Task Store API reference page tests (DRR-2.1)

test("GET /docs/task-store-api returns 200", async ({ page }) => {
  const response = await page.goto("/docs/task-store-api");
  expect(response?.status()).toBe(200);
});

test("task-store-api page has /tasks heading", async ({ page }) => {
  await page.goto("/docs/task-store-api");
  // The page must contain a heading or prominent text referencing /tasks
  const body = await page.textContent("body");
  expect(body).toContain("/tasks");
});

test("task-store-api page has h1 heading", async ({ page }) => {
  await page.goto("/docs/task-store-api");
  const h1 = page.locator("h1");
  await expect(h1).toBeVisible();
});

test("task-store-api page has key sections", async ({ page }) => {
  await page.goto("/docs/task-store-api");
  // Authentication section
  const authHeading = page.locator("h2", { hasText: /auth/i });
  await expect(authHeading.first()).toBeVisible();
  // Status lifecycle section
  const lifecycleHeading = page.locator("h2, h3", { hasText: /lifecycle|status/i });
  await expect(lifecycleHeading.first()).toBeVisible();
});

test("task-store-api page has curl examples", async ({ page }) => {
  await page.goto("/docs/task-store-api");
  // Must have at least one code block with curl
  const codeBlocks = page.locator("pre code");
  const count = await codeBlocks.count();
  expect(count).toBeGreaterThan(0);
  // At least one code block should contain curl
  let hasCurl = false;
  for (let i = 0; i < count; i++) {
    const text = await codeBlocks.nth(i).textContent();
    if (text?.includes("curl")) {
      hasCurl = true;
      break;
    }
  }
  expect(hasCurl).toBe(true);
});

test("task-store-api page cross-links to prs-api", async ({ page }) => {
  await page.goto("/docs/task-store-api");
  // The page should contain a link to /docs/prs-api
  const prsLink = page.locator('a[href="/docs/prs-api"]');
  await expect(prsLink.first()).toBeAttached();
});

test("task-store-api page has ready=true semantics section", async ({ page }) => {
  await page.goto("/docs/task-store-api");
  const readyHeading = page.locator("h2, h3", { hasText: /ready/i });
  await expect(readyHeading.first()).toBeVisible();
});

test("task-store-api sidebar is present", async ({ page }) => {
  await page.goto("/docs/task-store-api");
  const sidebar = page.locator("nav[aria-label='Docs navigation']");
  await expect(sidebar).toBeVisible();
});
