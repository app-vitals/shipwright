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

// PRs API reference page tests (DRR-2.2)

test("GET /docs/prs-api returns 200", async ({ page }) => {
  const response = await page.goto("/docs/prs-api");
  expect(response?.status()).toBe(200);
});

test("prs-api page has h1 heading", async ({ page }) => {
  await page.goto("/docs/prs-api");
  const h1 = page.locator("h1");
  await expect(h1).toBeVisible();
});

test("prs-api page contains '/prs' text", async ({ page }) => {
  await page.goto("/docs/prs-api");
  const body = await page.textContent("body");
  expect(body).toContain("/prs");
});

test("prs-api page has reviewState lifecycle section", async ({ page }) => {
  await page.goto("/docs/prs-api");
  // Must have a heading referencing reviewState or lifecycle
  const lifecycleHeading = page.locator("h2, h3", {
    hasText: /lifecycle|reviewState/i,
  });
  await expect(lifecycleHeading.first()).toBeVisible();
  // The lifecycle diagram must reference the four states
  const body = await page.textContent("body");
  expect(body).toContain("pending");
  expect(body).toContain("in_progress");
  expect(body).toContain("posted");
  expect(body).toContain("approved");
});

test("prs-api page has curl examples", async ({ page }) => {
  await page.goto("/docs/prs-api");
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

test("prs-api page has PR schema section", async ({ page }) => {
  await page.goto("/docs/prs-api");
  // Must have a heading referencing schema or fields
  const schemaHeading = page.locator("h2, h3", {
    hasText: /schema|fields/i,
  });
  await expect(schemaHeading.first()).toBeVisible();
  // Schema must cover key fields
  const body = await page.textContent("body");
  expect(body).toContain("patchCycles");
  expect(body).toContain("reviewCycles");
  expect(body).toContain("claimedBy");
  expect(body).toContain("heartbeatAt");
});

test("prs-api page cross-links to task-store-api", async ({ page }) => {
  await page.goto("/docs/prs-api");
  // The page should contain a link to /docs/task-store-api
  const taskStoreLink = page.locator('a[href="/docs/task-store-api"]');
  await expect(taskStoreLink.first()).toBeAttached();
});

test("prs-api page has StaleClaimReaper / heartbeat TTL section", async ({
  page,
}) => {
  await page.goto("/docs/prs-api");
  const body = await page.textContent("body");
  // Must explain the reaper / TTL behavior
  expect(body?.toLowerCase()).toContain("reaper");
  expect(body).toContain("heartbeat");
});

test("prs-api sidebar is present", async ({ page }) => {
  await page.goto("/docs/prs-api");
  const sidebar = page.locator("nav[aria-label='Docs navigation']");
  await expect(sidebar).toBeVisible();
});
