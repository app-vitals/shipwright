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

test("docs page ships zero <script> tags", async ({ page }) => {
  await page.goto("/docs/getting-started");
  const scriptCount = await page.locator("script").count();
  expect(scriptCount).toBe(0);
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
