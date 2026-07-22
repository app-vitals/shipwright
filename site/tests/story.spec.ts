import { expect, test } from "@playwright/test";
import { expectNoRuntimeJsBeyondAnalytics } from "./helpers";

// Fulfill external font CDN requests immediately so the page's 'load' event
// fires even when CI can't reach external networks.
test.beforeEach(async ({ page }) => {
  await page.route(
    /fonts\.googleapis\.com|fonts\.gstatic\.com|api\.fontshare\.com|googletagmanager\.com/,
    (route) =>
      route.fulfill({ status: 200, contentType: "text/css", body: "" }),
  );
});

// /story — origin-story timeline page (STY-1.1). Approved copy verbatim
// from planning/site-timeline/PLAN.md; presentation-only, zero runtime JS.

test("story route responds 200", async ({ page }) => {
  const response = await page.goto("/story");
  expect(response?.status()).toBe(200);
});

test("story page has a visible h1", async ({ page }) => {
  await page.goto("/story");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
});

test("story page renders all 8 timeline dates", async ({ page }) => {
  await page.goto("/story");
  const text = (await page.locator("main").textContent()) ?? "";
  for (const date of [
    "November 2025",
    "January 2026",
    "March 2026",
    "April 2026",
    "May 2026",
    "June 2026",
    "Late June 2026",
    "Today",
  ]) {
    expect(text, `expected timeline date "${date}" to be present`).toContain(
      date,
    );
  }
});

test("story nav link is present in the header", async ({ page }) => {
  await page.goto("/story");
  const nav = page.getByRole("navigation", { name: "Primary" });
  await expect(nav.getByRole("link", { name: "Story", exact: true })).toHaveAttribute(
    "href",
    "/story",
  );
});

test("story page ships no runtime JS beyond the analytics tag", async ({
  page,
}) => {
  await page.goto("/story");
  await expectNoRuntimeJsBeyondAnalytics(page);
});
