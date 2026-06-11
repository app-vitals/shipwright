import { expect, test } from "@playwright/test";

// Fulfill external font CDN requests immediately so the page's 'load' event
// fires even when CI can't reach external networks.
test.beforeEach(async ({ page }) => {
  await page.route(
    /fonts\.googleapis\.com|fonts\.gstatic\.com|api\.fontshare\.com/,
    (route) => route.fulfill({ status: 200, contentType: "text/css", body: "" }),
  );
});

// CFG-2.2: /docs/configuration smoke tests.

test("config route responds 200", async ({ page }) => {
  const response = await page.goto("/docs/configuration");
  expect(response?.status()).toBe(200);
});

test("config page contains the main Configuration heading", async ({ page }) => {
  await page.goto("/docs/configuration");
  const heading = page.getByRole("heading", { name: /^Configuration$/i }).first();
  await expect(heading).toBeVisible();
});

test("config page renders Plugin Config section", async ({ page }) => {
  await page.goto("/docs/configuration");
  await expect(
    page.getByRole("heading", { name: /Plugin Config/i }),
  ).toBeVisible();
});

test("config page renders Agent Config section", async ({ page }) => {
  await page.goto("/docs/configuration");
  await expect(
    page.getByRole("heading", { name: /Agent Config/i }),
  ).toBeVisible();
});

test("config page renders Policy Config section", async ({ page }) => {
  await page.goto("/docs/configuration");
  await expect(
    page.getByRole("heading", { name: /Policy Config/i }),
  ).toBeVisible();
});

test("config page ships NO runtime JS (zero <script> tags)", async ({
  page,
}) => {
  await page.goto("/docs/configuration");
  const scriptCount = await page.locator("script").count();
  expect(scriptCount).toBe(0);
});

test("footer nav has a link to /docs/configuration", async ({ page }) => {
  await page.goto("/");
  const footer = page.locator("footer");
  await expect(footer).toBeVisible();
  await expect(
    footer.getByRole("link", { name: /Configuration/i }),
  ).toHaveAttribute("href", "/docs/configuration");
});
