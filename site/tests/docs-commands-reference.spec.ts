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

// Commands reference page e2e tests (UDG-2.2).

test("GET /docs/commands-reference returns 200", async ({ page }) => {
  const response = await page.goto("/docs/commands-reference");
  expect(response?.status()).toBe(200);
});

test("h1 is present on commands-reference page", async ({ page }) => {
  await page.goto("/docs/commands-reference");
  const h1 = page.locator("h1");
  await expect(h1.first()).toBeVisible();
});

test("sidebar is present on commands-reference page", async ({ page }) => {
  await page.goto("/docs/commands-reference");
  const sidebar = page.locator("nav[aria-label='Docs navigation']");
  await expect(sidebar).toBeVisible();
});

test("Core/Delivery Loop group heading appears before other category headings", async ({
  page,
}) => {
  await page.goto("/docs/commands-reference");
  const h2 = page.locator("h2");
  const headings = (await h2.allTextContents()).map((h) => h.trim());
  const coreIndex = headings.findIndex((h) =>
    /core\s*\/\s*delivery loop|core.*delivery loop/i.test(h),
  );
  expect(coreIndex).toBe(0);
  expect(headings.length).toBeGreaterThan(1);
});

// Every command in the-plugin.mdx's existing 9-command table must also
// appear somewhere on this new catalog page.
const existingTableCommands = [
  "prd",
  "plan-session",
  "dev-task",
  "review",
  "patch",
  "deploy",
  "metrics",
  "research",
  "research-docs",
];

for (const command of existingTableCommands) {
  test(`the-plugin.mdx table command "${command}" appears on commands-reference page`, async ({
    page,
  }) => {
    await page.goto("/docs/commands-reference");
    const body = page.locator("body");
    await expect(body).toContainText(`/shipwright:${command}`);
  });
}
