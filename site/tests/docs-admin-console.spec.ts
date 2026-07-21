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

// Admin Console walkthrough page tests (UDG-1.2)

test("GET /docs/admin-console returns 200", async ({ page }) => {
  const response = await page.goto("/docs/admin-console");
  expect(response?.status()).toBe(200);
});

test("admin-console page has h1 heading", async ({ page }) => {
  await page.goto("/docs/admin-console");
  const h1 = page.locator("h1");
  await expect(h1).toBeVisible();
});

test("admin-console sidebar is present", async ({ page }) => {
  await page.goto("/docs/admin-console");
  const sidebar = page.locator("nav[aria-label='Docs navigation']");
  await expect(sidebar).toBeVisible();
});

// One heading-presence check per major admin section the brief requires
// coverage for — sourced from admin-ui.ts / admin-ui-pages.ts routes.
const MAJOR_SECTIONS: Array<[string, RegExp]> = [
  ["Agents", /agents/i],
  ["Cron Logs", /cron/i],
  ["Work Queue", /work queue/i],
  ["Provisioning", /provision/i],
  ["Tasks", /tasks/i],
  ["PRs", /prs|pull requests/i],
  ["Chat", /chat/i],
  ["Tokens", /tokens/i],
];

for (const [label, pattern] of MAJOR_SECTIONS) {
  test(`admin-console page has a heading for ${label}`, async ({ page }) => {
    await page.goto("/docs/admin-console");
    const heading = page.locator("h2, h3", { hasText: pattern });
    await expect(heading.first()).toBeVisible();
  });
}
