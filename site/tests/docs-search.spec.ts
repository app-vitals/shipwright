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

// Pagefind search integration e2e tests.
// Verifies the search widget is present and functional on docs pages,
// and that non-docs pages are excluded from the index.

test("search input is present on /docs/getting-started", async ({ page }) => {
  await page.goto("/docs/getting-started");
  // Pagefind renders a search input inside the #search container.
  const searchInput = page.locator("#search input[type='text'], #search input:not([type])");
  await expect(searchInput).toBeVisible({ timeout: 10_000 });
});

test("searching 'getting started' returns at least one result", async ({
  page,
}) => {
  await page.goto("/docs/getting-started");

  // Wait for Pagefind UI to initialise (the DOMContentLoaded script fires).
  const searchInput = page.locator("#search input[type='text'], #search input:not([type])");
  await expect(searchInput).toBeVisible({ timeout: 10_000 });

  // Type the search term.
  await searchInput.fill("getting started");
  await searchInput.press("Enter");

  // Pagefind renders results inside the widget container.
  // At least one result link should appear.
  const results = page.locator("#search .pagefind-ui__result, #search [class*='result']");
  await expect(results.first()).toBeVisible({ timeout: 10_000 });
});

test("home page (/) is excluded from docs search results for 'getting started'", async ({
  page,
}) => {
  await page.goto("/docs/getting-started");

  const searchInput = page.locator("#search input[type='text'], #search input:not([type])");
  await expect(searchInput).toBeVisible({ timeout: 10_000 });

  await searchInput.fill("getting started");
  await searchInput.press("Enter");

  // Wait for results to render.
  const results = page.locator("#search .pagefind-ui__result, #search [class*='result']");
  await expect(results.first()).toBeVisible({ timeout: 10_000 });

  // Home page (/) should NOT appear in the results — it has data-pagefind-ignore.
  const resultLinks = page.locator("#search a[href='/'], #search a[href='http://localhost:4321/']");
  await expect(resultLinks).toHaveCount(0);
});

test("compare page (/compare) is excluded from docs search", async ({
  page,
}) => {
  await page.goto("/docs/getting-started");

  const searchInput = page.locator("#search input[type='text'], #search input:not([type])");
  await expect(searchInput).toBeVisible({ timeout: 10_000 });

  await searchInput.fill("compare");
  await searchInput.press("Enter");

  // Wait for Pagefind to settle — results-area is always rendered once search completes.
  await expect(
    page.locator("#search .pagefind-ui__results-area")
  ).toBeVisible({ timeout: 10_000 });

  // /compare should NOT appear — it has data-pagefind-ignore.
  const compareLinks = page.locator("#search a[href='/compare'], #search a[href='http://localhost:4321/compare']");
  await expect(compareLinks).toHaveCount(0);
});
