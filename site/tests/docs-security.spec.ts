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

// Security docs page tests (SDP-1.1)

test("GET /docs/security returns 200", async ({ page }) => {
  const response = await page.goto("/docs/security");
  expect(response?.status()).toBe(200);
});

test("security page has h1 heading", async ({ page }) => {
  await page.goto("/docs/security");
  const h1 = page.locator("h1");
  await expect(h1).toBeVisible();
});

test("security sidebar is present", async ({ page }) => {
  await page.goto("/docs/security");
  const sidebar = page.locator("nav[aria-label='Docs navigation']");
  await expect(sidebar).toBeVisible();
});

// One heading-presence check per major section the brief requires coverage
// for.
const MAJOR_SECTIONS: Array<[string, RegExp]> = [
  ["Deployment architecture", /deployment architecture/i],
  ["Network & egress controls", /network.*egress|egress/i],
  ["Human access", /human access/i],
  ["Kubernetes service accounts & RBAC", /service accounts|rbac/i],
  ["Secrets & service-to-service auth", /secrets|service-to-service/i],
  ["GitHub App integration", /github app/i],
  ["Slack App integration", /slack app/i],
  ["One agent per user", /one agent per user/i],
  ["Admins vs. agent members", /admins.*members|agent members/i],
  ["Logging, monitoring & observability", /observability|logging/i],
  ["Compliance posture", /compliance/i],
  ["FAQ", /faq/i],
];

for (const [label, pattern] of MAJOR_SECTIONS) {
  test(`security page has a heading for ${label}`, async ({ page }) => {
    await page.goto("/docs/security");
    const heading = page.locator("h2, h3", { hasText: pattern });
    await expect(heading.first()).toBeVisible();
  });
}

test("security page prev link points to the-shipwright-loop", async ({
  page,
}) => {
  await page.goto("/docs/security");
  const prev = page.locator('a[data-nav="prev"]');
  await expect(prev).toHaveAttribute("href", "/docs/the-shipwright-loop");
});

test("security page next link points to reference", async ({ page }) => {
  await page.goto("/docs/security");
  const next = page.locator('a[data-nav="next"]');
  await expect(next).toHaveAttribute("href", "/docs/reference");
});
