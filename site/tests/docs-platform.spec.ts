import { expect, test } from "@playwright/test";

// Fulfill external font CDN requests immediately so the page's 'load' event
// fires even when CI can't reach external networks.
test.beforeEach(async ({ page }) => {
  await page.route(
    /fonts\.googleapis\.com|fonts\.gstatic\.com|api\.fontshare\.com/,
    (route) =>
      route.fulfill({ status: 200, contentType: "text/css", body: "" }),
  );
});

// Docs platform e2e tests (SD-platform-syntax-theme).
// These tests cover the MDX content collection, DocsLayout, and syntax theme.

test("GET /docs/getting-started returns 200", async ({ page }) => {
  const response = await page.goto("/docs/getting-started");
  expect(response?.status()).toBe(200);
});

test("sidebar is present on docs page", async ({ page }) => {
  await page.goto("/docs/getting-started");
  const sidebar = page.locator("nav[aria-label='Docs navigation']");
  await expect(sidebar).toBeVisible();
});

test("TOC (table of contents) is present on docs page", async ({ page }) => {
  await page.goto("/docs/getting-started");
  const toc = page.locator("nav[aria-label='On this page']");
  await expect(toc).toBeVisible();
});

// prev/next navigation test removed: getting-started.mdx no longer has a `next`
// frontmatter field (configuration.mdx does not exist yet). Re-add once a second
// docs page exists so the nav link can actually render.

test("docs page ships exactly ONE <script> tag (Pagefind UI)", async ({ page }) => {
  await page.goto("/docs/getting-started");
  const scriptCount = await page.locator("script").count();
  expect(scriptCount).toBe(1);
});

test("sidebar lists at least one docs section", async ({ page }) => {
  await page.goto("/docs/getting-started");
  const sidebar = page.locator("nav[aria-label='Docs navigation']");
  const links = sidebar.locator("a");
  const count = await links.count();
  expect(count).toBeGreaterThan(0);
});

test("TOC lists headings of the current page", async ({ page }) => {
  await page.goto("/docs/getting-started");
  const toc = page.locator("nav[aria-label='On this page']");
  const links = toc.locator("a");
  const count = await links.count();
  expect(count).toBeGreaterThan(0);
});

test("mobile sidebar toggle uses CSS-only checkbox pattern (no inline onclick)", async ({
  page,
}) => {
  await page.goto("/docs/getting-started");
  // The mobile toggle must be a checkbox or label — no onclick attributes
  const interactiveElements = await page
    .locator("[onclick]")
    .count();
  expect(interactiveElements).toBe(0);
  // There must be a checkbox or label for the mobile toggle
  const toggleCheckbox = page.locator(
    "input[type='checkbox']#docs-sidebar-toggle",
  );
  await expect(toggleCheckbox).toHaveCount(1);
});

test("fenced code block is present in getting-started page", async ({
  page,
}) => {
  await page.goto("/docs/getting-started");
  // The MDX page has a bash code block
  const codeBlock = page.locator("pre code");
  await expect(codeBlock.first()).toBeVisible();
});

// Introduction page tests (SD-4.1)

test("GET /docs/introduction returns 200", async ({ page }) => {
  const response = await page.goto("/docs/introduction");
  expect(response?.status()).toBe(200);
});

test("fenced code block is present in introduction page", async ({ page }) => {
  await page.goto("/docs/introduction");
  const codeBlock = page.locator("pre code");
  await expect(codeBlock.first()).toBeVisible();
});

test("key headings visible in introduction page", async ({ page }) => {
  await page.goto("/docs/introduction");
  // At least one h2 heading must be present
  const h2 = page.locator("h2");
  await expect(h2.first()).toBeVisible();
});

test("key headings visible in getting-started page", async ({ page }) => {
  await page.goto("/docs/getting-started");
  // Prerequisites or Getting Started h2 must be present
  const h2 = page.locator("h2");
  await expect(h2.first()).toBeVisible();
  // Specifically check for Prerequisites heading
  const prerequisites = page.locator("h2", { hasText: /prerequisites/i });
  await expect(prerequisites).toBeVisible();
});

test("prev/next navigation links are present on getting-started page", async ({
  page,
}) => {
  await page.goto("/docs/getting-started");
  // Should have a prev link back to introduction
  const prevLink = page.locator("a[data-nav='prev']");
  await expect(prevLink).toBeVisible();
  const href = await prevLink.getAttribute("href");
  expect(href).toBe("/docs/introduction");
});

test("prev/next navigation links are present on introduction page", async ({
  page,
}) => {
  await page.goto("/docs/introduction");
  // Should have a next link to getting-started
  const nextLink = page.locator("a[data-nav='next']");
  await expect(nextLink).toBeVisible();
  const href = await nextLink.getAttribute("href");
  expect(href).toBe("/docs/getting-started");
});
