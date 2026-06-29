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

// /docs landing page tests (SD-2.2)
// Tests cover the three persona cards (Evaluate, Adopt, Operate) on /docs index.

test("GET /docs returns 200", async ({ page }) => {
  const response = await page.goto("/docs");
  expect(response?.status()).toBe(200);
});

test("three persona cards are visible (Evaluate, Adopt, Operate)", async ({
  page,
}) => {
  await page.goto("/docs");

  const evaluateCard = page.locator("text=Evaluate").first();
  const adoptCard = page.locator("text=Adopt").first();
  const operateCard = page.locator("text=Operate").first();

  await expect(evaluateCard).toBeVisible();
  await expect(adoptCard).toBeVisible();
  await expect(operateCard).toBeVisible();
});

test("each persona card has a link with href starting with /docs/", async ({
  page,
}) => {
  await page.goto("/docs");

  // Find all cards and their links
  const cards = page.locator(".sw-card");
  const count = await cards.count();

  // Should have at least 3 cards for the persona paths
  expect(count).toBeGreaterThanOrEqual(3);

  // Verify first 3 cards have links pointing to /docs/*
  for (let i = 0; i < 3; i++) {
    const card = cards.nth(i);
    const link = card.locator("a.sw-btn-secondary");
    const href = await link.getAttribute("href");
    expect(href).toMatch(/^\/docs\//);
  }
});

test("/docs landing page ships zero <script> tags", async ({ page }) => {
  await page.goto("/docs");
  const scriptCount = await page.locator("script").count();
  expect(scriptCount).toBe(0);
});
