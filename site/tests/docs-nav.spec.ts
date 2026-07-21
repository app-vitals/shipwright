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

// SWD-1.2: DocsLayout's header nav, mobile sidebar nav, and footer had
// drifted from BaseLayout's and were silently missing the "vs Devin" and
// "Architecture" links. SiteHeader/SiteFooter now back both layouts, so
// these links can no longer drift out of docs pages unnoticed.

test("docs desktop header nav includes vs Devin and Architecture links", async ({
  page,
}) => {
  await page.goto("/docs/getting-started");
  const nav = page.getByRole("navigation", { name: "Primary" });
  await expect(nav.getByRole("link", { name: /vs Devin/i })).toHaveAttribute(
    "href",
    "/vs/devin",
  );
  await expect(
    nav.getByRole("link", { name: /Architecture/i }),
  ).toHaveAttribute("href", "/architecture");
});

test("docs mobile sidebar nav includes vs Devin and Architecture links", async ({
  page,
}) => {
  // The sidebar's mobile nav is "md:hidden" — only in the a11y tree below
  // the md breakpoint, so it needs a mobile viewport to be queryable.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/docs/getting-started");
  const nav = page.getByRole("navigation", { name: "Mobile top navigation" });
  await expect(nav.getByRole("link", { name: /vs Devin/i })).toHaveAttribute(
    "href",
    "/vs/devin",
  );
  await expect(
    nav.getByRole("link", { name: /Architecture/i }),
  ).toHaveAttribute("href", "/architecture");
});

test("docs footer includes a vs Devin link", async ({ page }) => {
  await page.goto("/docs/getting-started");
  const footer = page.getByRole("navigation", { name: "Footer" });
  await expect(
    footer.getByRole("link", { name: /vs Devin/i }),
  ).toHaveAttribute("href", "/vs/devin");
});
