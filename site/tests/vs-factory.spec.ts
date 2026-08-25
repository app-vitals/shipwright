import { expect, test } from "@playwright/test";
import { BOOKING_URL } from "../src/consts";
import {
  expectBannedPhrasesAbsent,
  expectNoDollarFigures,
  expectNoRuntimeJsBeyondAnalytics,
} from "./helpers";

// Fulfill external font CDN requests immediately so the page's 'load' event
// fires even when CI can't reach external networks.
test.beforeEach(async ({ page }) => {
  await page.route(
    /fonts\.googleapis\.com|fonts\.gstatic\.com|api\.fontshare\.com|googletagmanager\.com/,
    (route) =>
      route.fulfill({ status: 200, contentType: "text/css", body: "" }),
  );
});

// /vs/factory — the dedicated Shipwright-vs-Factory comparison page (VFC-1).
// Copy discipline enforced here mirrors compare.spec.ts and vs-devin.spec.ts:
// a verified-as-of date on every Factory claim, no pricing figures, and no
// overstated Shipwright enterprise-security claims (SOC 2 / ISO / SCIM /
// secret-scanning / OpenTelemetry / airgapped are Factory-only, not shipped).

test("vs/factory route responds 200", async ({ page }) => {
  const response = await page.goto("/vs/factory");
  expect(response?.status()).toBe(200);
});

test("page title targets the open, tests-first alternative to Factory Missions", async ({
  page,
}) => {
  await page.goto("/vs/factory");
  expect(await page.title()).toContain("tests-first alternative to Factory Missions");
});

test("page ships no runtime JS beyond the analytics tag", async ({ page }) => {
  await page.goto("/vs/factory");
  await expectNoRuntimeJsBeyondAnalytics(page);
});

test("H1 leads with the Shipwright vs Factory framing", async ({ page }) => {
  await page.goto("/vs/factory");
  await expect(page.locator("h1")).toContainText(/Shipwright vs Factory/i);
});

test("dimension table covers plan approval and tests-first", async ({
  page,
}) => {
  await page.goto("/vs/factory");
  const tableText =
    (await page.locator("table").first().textContent())?.toLowerCase() ?? "";
  expect(tableText).toContain("plan approval");
  expect(tableText).toContain("tests-first");
  expect(tableText).toContain("license");
  expect(tableText).toContain("deployment");
});

test("does not overstate Shipwright's enterprise security — Factory-only claims stay on Factory's side", async ({
  page,
}) => {
  await page.goto("/vs/factory");
  const text = (await page.locator("main").textContent()) ?? "";
  expect(text).toContain("SSO via Okta OIDC");
  // Factory-only certifications/features must not be claimed for Shipwright.
  const shipwrightCellText =
    (await page
      .locator("table tr", { hasText: "Enterprise security" })
      .locator("td")
      .nth(1)
      .textContent()) ?? "";
  expect(shipwrightCellText).not.toMatch(/SOC 2|ISO|SCIM|secret-scanning|OpenTelemetry|airgapped/i);
});

test("'Choose Factory when' section is present", async ({ page }) => {
  await page.goto("/vs/factory");
  await expect(
    page.getByRole("heading", { name: /Choose Factory when/i }).first(),
  ).toBeVisible();
  const text = (await page.locator("main").textContent())?.toLowerCase() ?? "";
  expect(text).toContain("choose shipwright when");
});

test("every Factory claim carries a citation link, and the page shows a verified-as-of date", async ({
  page,
}) => {
  await page.goto("/vs/factory");
  await expect(page.getByText(/facts verified as of/i)).toBeVisible();
  await expect(
    page.locator('a[href*="factory.ai"]').first(),
  ).toBeVisible();
});

test("specific, non-obvious Factory product claims (Tests-first, Slack workflow) carry a citation link in their row", async ({
  page,
}) => {
  await page.goto("/vs/factory");
  for (const dimension of ["Tests-first", "Slack workflow"]) {
    const row = page.locator("table tr", { hasText: dimension });
    await expect(
      row.locator('td a[href*="factory.ai"]'),
    ).toHaveCount(1);
  }
});

test("page markets no pricing anywhere", async ({ page }) => {
  await page.goto("/vs/factory");
  await expectBannedPhrasesAbsent(page, [
    "pricing",
    "per month",
    "per seat",
    "per user",
    "/month",
    "/mo",
    "subscription",
    "free trial",
    "billed annually",
  ]);
  await expectNoDollarFigures(page);
});

test("CTA repeats the install command and links GitHub + discovery call", async ({
  page,
}) => {
  await page.goto("/vs/factory");
  await expect(
    page.getByText("/plugin install shipwright@app-vitals/shipwright", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: /github/i }).first(),
  ).toHaveAttribute("href", /github\.com\/app-vitals\/shipwright/);
  await expect(
    page.locator("#cta").getByRole("link", { name: /discovery call/i }),
  ).toHaveAttribute("href", BOOKING_URL);
});

test("/compare links to the full /vs/factory comparison", async ({ page }) => {
  await page.goto("/compare");
  await expect(
    page.getByRole("link", { name: /full.*Shipwright vs Factory comparison/i }),
  ).toHaveAttribute("href", "/vs/factory");
});
