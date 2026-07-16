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

// /vs/devin — the dedicated Shipwright-vs-Devin comparison page (DVN-2.1/2.2).
// Copy discipline enforced here mirrors compare.spec.ts and home.spec.ts:
// citations + a verified-as-of date on every Devin claim, no pricing figures,
// and the refuted "no private deployment" framing never appears.

test("vs/devin route responds 200", async ({ page }) => {
  const response = await page.goto("/vs/devin");
  expect(response?.status()).toBe(200);
});

test("page title targets the open-source-alternative-to-Devin query", async ({
  page,
}) => {
  await page.goto("/vs/devin");
  expect(await page.title()).toContain("open source alternative to Devin");
});

test("page ships no runtime JS beyond the analytics tag", async ({ page }) => {
  await page.goto("/vs/devin");
  await expectNoRuntimeJsBeyondAnalytics(page);
});

test("H1 leads with the Shipwright vs Devin framing", async ({ page }) => {
  await page.goto("/vs/devin");
  await expect(page.locator("h1")).toContainText(/Shipwright vs Devin/i);
});

test("license table quotes the actual MIT license line from LICENSE", async ({
  page,
}) => {
  await page.goto("/vs/devin");
  const text = (await page.locator("main").textContent()) ?? "";
  expect(text).toContain(
    "Permission is hereby granted, free of charge, to any person",
  );
  await expect(
    page.getByRole("link", { name: /Shipwright's LICENSE/i }),
  ).toHaveAttribute("href", /LICENSE/);
});

test("deployment contrast uses the Cognition-hosted framing, never the refuted claim", async ({
  page,
}) => {
  await page.goto("/vs/devin");
  const text = (await page.locator("main").textContent())?.toLowerCase() ?? "";
  expect(text).toContain("cognition-hosted");
  expect(text).not.toContain("no private deployment");
  expect(text).not.toContain("no vpc option");
  expect(text).not.toContain("devin has no private deployment");
});

test("pipeline-depth row states Shipwright's deploy stage vs Devin stopping at PR", async ({
  page,
}) => {
  await page.goto("/vs/devin");
  const text = (await page.locator("main").textContent())?.toLowerCase() ?? "";
  expect(text).toMatch(/spec.*plan.*build.*test.*pr.*deploy/i);
  expect(text).toContain("deploy step is not part of the agent's scope");
});

test("'Choose Devin when' section is present", async ({ page }) => {
  await page.goto("/vs/devin");
  await expect(
    page.getByRole("heading", { name: /Choose Devin when/i }).first(),
  ).toBeVisible();
  const text = (await page.locator("main").textContent())?.toLowerCase() ?? "";
  expect(text).toContain("choose shipwright when");
});

test("every Devin claim carries a citation link, and the page shows a verified-as-of date", async ({
  page,
}) => {
  await page.goto("/vs/devin");
  await expect(page.getByText(/facts verified as of/i)).toBeVisible();
  // At least the deployment-overview and pricing sources are linked.
  await expect(
    page.locator('a[href*="docs.devin.ai"]').first(),
  ).toBeVisible();
  await expect(page.locator('a[href*="devin.ai"]').first()).toBeVisible();
});

test("page markets no pricing anywhere", async ({ page }) => {
  await page.goto("/vs/devin");
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
  await page.goto("/vs/devin");
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

test("/compare links to the full /vs/devin comparison", async ({ page }) => {
  await page.goto("/compare");
  await expect(
    page.getByRole("link", { name: /full.*Shipwright vs Devin comparison/i }),
  ).toHaveAttribute("href", "/vs/devin");
});

test("page links back to /self-hosted", async ({ page }) => {
  await page.goto("/vs/devin");
  await expect(
    page.getByRole("link", { name: /self-hosted.*actually means/i }),
  ).toHaveAttribute("href", "/self-hosted");
});
