import { expect, test } from "@playwright/test";
import { QUICKSTART_URL } from "../src/consts";

// CRQ-3.2: the site install CTA links to the first-PR quickstart with
// UTM tagging (campaign=quickstart). No plugin telemetry — links only.

test.beforeEach(async ({ page }) => {
  await page.route(
    /fonts\.googleapis\.com|fonts\.gstatic\.com|api\.fontshare\.com|googletagmanager\.com/,
    (route) =>
      route.fulfill({ status: 200, contentType: "text/css", body: "" }),
  );
});

function expectQuickstartHref(href: string | null, content: string) {
  expect(href).toBeTruthy();
  const url = new URL(href ?? "");
  expect(`${url.origin}${url.pathname}`).toBe(QUICKSTART_URL);
  expect(url.searchParams.get("utm_source")).toBe("shipwrightharness.com");
  expect(url.searchParams.get("utm_medium")).toBe("site");
  expect(url.searchParams.get("utm_campaign")).toBe("quickstart");
  expect(url.searchParams.get("utm_content")).toBe(content);
}

test("homepage Install card links to the quickstart with UTM tagging", async ({
  page,
}) => {
  await page.goto("/");
  const link = page
    .locator(".sw-card")
    .filter({ hasText: "Install" })
    .getByRole("link", { name: /first-PR path/i });
  await expect(link).toBeVisible();
  expectQuickstartHref(await link.getAttribute("href"), "install_card");
});

test("Try it CTA links to the quickstart with UTM tagging", async ({
  page,
}) => {
  await page.goto("/compare");
  const link = page
    .locator("#cta")
    .getByRole("link", { name: /first-PR path/i });
  await expect(link).toBeVisible();
  expectQuickstartHref(await link.getAttribute("href"), "try_it_cta");
});
