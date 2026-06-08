import { expect, test } from "@playwright/test";

// Smoke test for the Shipwright Harness marketing site (SWW-1.1).
// Relies on playwright.config.ts `webServer` to build + preview the site.

test("home route responds 200", async ({ page }) => {
  const response = await page.goto("/");
  expect(response?.status()).toBe(200);
});

test("hero heading renders the brand tagline", async ({ page }) => {
  await page.goto("/");
  const heading = page.locator("h1");
  await expect(heading).toBeVisible();
  await expect(heading).toContainText(/autonomous delivery agent/i);
});

test("dark-premium navy base background is applied", async ({ page }) => {
  await page.goto("/");
  // brand.css sets body background to --sw-color-bg-base (#080E1E => rgb(8, 14, 30)).
  const bg = await page.evaluate(() =>
    getComputedStyle(document.body).backgroundColor,
  );
  expect(bg).toBe("rgb(8, 14, 30)");
  // The brand CSS variable must be present on :root.
  const baseVar = await page.evaluate(() =>
    getComputedStyle(document.documentElement)
      .getPropertyValue("--sw-color-bg-base")
      .trim(),
  );
  expect(baseVar.toUpperCase()).toBe("#080E1E");
});

test("home document ships NO runtime JS (zero <script> tags)", async ({
  page,
}) => {
  await page.goto("/");
  const scriptCount = await page.locator("script").count();
  expect(scriptCount).toBe(0);
});

// SWW-2.1: Hero + install section.

test("primary 'Get started' CTA renders", async ({ page }) => {
  await page.goto("/");
  const cta = page.getByRole("link", { name: "Get started" });
  await expect(cta).toBeVisible();
  await expect(cta).toHaveAttribute("href", "#install");
});

test("exact install command string renders", async ({ page }) => {
  await page.goto("/");
  await expect(
    page.getByText("/plugin install shipwright@app-vitals/shipwright", {
      exact: true,
    }),
  ).toBeVisible();
});

test("secondary 'View on GitHub' CTA points at the repo", async ({ page }) => {
  await page.goto("/");
  const cta = page.getByRole("link", { name: "View on GitHub" });
  await expect(cta).toBeVisible();
  await expect(cta).toHaveAttribute(
    "href",
    "https://github.com/app-vitals/shipwright",
  );
});

test("eyebrow features 'Built on Claude Code'", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText(/Built on Claude Code/i)).toBeVisible();
});
