import { expect, test } from "@playwright/test";
import { BOOKING_URL } from "../src/consts";

// The marketing pages and the docs pages render from two *different* layouts
// (BaseLayout and DocsLayout) that each carry their own header and footer. A CTA
// added to one does not appear in the other, so every page below is checked:
// /, /compare and /architecture come from BaseLayout; /docs and /docs/* from
// DocsLayout. Losing the docs half is the regression this guards against.
const PAGES = [
  "/",
  "/compare",
  "/architecture",
  "/docs",
  "/docs/introduction",
];

for (const path of PAGES) {
  test(`header books a call on ${path}`, async ({ page }) => {
    await page.goto(path);
    await expect(
      page.locator("header").getByRole("link", { name: /^Book a call$/i }),
    ).toHaveAttribute("href", BOOKING_URL);
  });

  test(`footer books a call on ${path}`, async ({ page }) => {
    await page.goto(path);
    await expect(
      page.locator("footer").getByRole("link", { name: /^Book a call$/i }),
    ).toHaveAttribute("href", BOOKING_URL);
  });
}
