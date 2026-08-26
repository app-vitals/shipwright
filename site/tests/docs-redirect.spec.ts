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

// DLS-1.1: /docs is a static build (no server adapter), so Astro's `redirects`
// config emits a static meta-refresh page at /docs/index.html rather than a
// true HTTP 301. Assert both the meta-refresh target and the final resolved
// URL after the browser follows it.

test("GET /docs redirects to /docs/introduction", async ({ page }) => {
  await page.goto("/docs");
  await page.waitForURL("/docs/introduction");
  expect(new URL(page.url()).pathname).toBe("/docs/introduction");
});

test("/docs ships a meta-refresh pointing at /docs/introduction", async ({
  request,
}) => {
  const response = await request.get("/docs");
  expect(response.status()).toBe(200);
  const body = await response.text();
  expect(body).toContain('<meta http-equiv="refresh"');
  expect(body).toMatch(/url=\/docs\/introduction/);
});
