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

// CFG-2.2: /docs/reference smoke tests.

test("config route responds 200", async ({ page }) => {
  const response = await page.goto("/docs/reference");
  expect(response?.status()).toBe(200);
});

test("config page contains the main Configuration Reference heading", async ({
  page,
}) => {
  await page.goto("/docs/reference");
  const heading = page
    .getByRole("heading", { name: /^Configuration Reference$/i })
    .first();
  await expect(heading).toBeVisible();
});

test("config page renders Plugin Config section", async ({ page }) => {
  await page.goto("/docs/reference");
  await expect(
    page.getByRole("heading", { name: /Plugin Config/i }),
  ).toBeVisible();
});

test("config page renders Agent Config section", async ({ page }) => {
  await page.goto("/docs/reference");
  await expect(
    page.getByRole("heading", { name: /Agent Config/i }),
  ).toBeVisible();
});

test("config page renders Policy Config section", async ({ page }) => {
  await page.goto("/docs/reference");
  await expect(
    page.getByRole("heading", { name: /Policy Config/i }),
  ).toBeVisible();
});

test("footer nav has a link to /docs/reference", async ({ page }) => {
  await page.goto("/");
  const footer = page.locator("footer");
  await expect(footer).toBeVisible();
  await expect(
    footer.getByRole("link", { name: /Configuration/i }),
  ).toHaveAttribute("href", "/docs/reference");
});

test("config page renders Task store service section", async ({ page }) => {
  await page.goto("/docs/reference");
  await expect(
    page.getByRole("heading", { name: /Task store service/i }),
  ).toBeVisible();
});

test("config page renders Agent provisioning section", async ({ page }) => {
  await page.goto("/docs/reference");
  await expect(
    page.getByRole("heading", { name: /Agent provisioning/i }),
  ).toBeVisible();
});
