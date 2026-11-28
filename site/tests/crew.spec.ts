import { expect, test } from "@playwright/test";
import { CREW_APPLY_URL } from "../src/consts";
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

test("crew route responds 200 with the h1", async ({ page }) => {
  const response = await page.goto("/crew/");
  expect(response?.status()).toBe(200);
  await expect(
    page.getByRole("heading", { level: 1, name: "Join the Crew." }),
  ).toBeVisible();
});

test("crew page renders the three levels in order", async ({ page }) => {
  await page.goto("/crew/");
  const levels = await page.getByRole("heading", { level: 3 }).allTextContents();
  expect(levels).toEqual(["Deckhand", "First Mate", "Master Builder"]);
});

test("Apply CTA links out with the crew_page UTM, or shows coming soon", async ({
  page,
}) => {
  await page.goto("/crew/");
  const cta = page.locator("main a", { hasText: "Apply to the Crew" });
  if (CREW_APPLY_URL === null) {
    await expect(cta).toHaveCount(0);
    await expect(page.getByTestId("crew-apply-soon")).toHaveText(
      "Applications open soon.",
    );
    return;
  }
  const href = await cta.getAttribute("href");
  expect(href?.startsWith(CREW_APPLY_URL.split("?")[0])).toBe(true);
  expect(href).toContain("utm_content=crew_page");
});

test("crew page has no form and no email input (MESSAGING.md §4)", async ({
  page,
}) => {
  await page.goto("/crew/");
  await expect(page.locator("form")).toHaveCount(0);
  await expect(page.locator("input[type=email]")).toHaveCount(0);
});

test("crew page ships no runtime JS beyond the analytics tag", async ({
  page,
}) => {
  await page.goto("/crew/");
  await expectNoRuntimeJsBeyondAnalytics(page);
});

test("footer links Crew to /crew/", async ({ page }) => {
  await page.goto("/crew/");
  await expect(
    page.getByRole("navigation", { name: "Footer" }).getByRole("link", {
      name: "Crew",
      exact: true,
    }),
  ).toHaveAttribute("href", "/crew/");
});
