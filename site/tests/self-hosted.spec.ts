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

// /self-hosted — the fully-in-your-cloud-vs-hybrid architecture comparison
// page (DVN-3.1/3.2). Copy discipline mirrors vs-devin.spec.ts: citations on
// every competitor claim, no pricing figures, and OpenCode is never named.

test("self-hosted route responds 200", async ({ page }) => {
  const response = await page.goto("/self-hosted");
  expect(response?.status()).toBe(200);
});

test("page title targets the self-hosted-AI-coding-agent query", async ({
  page,
}) => {
  await page.goto("/self-hosted");
  expect(await page.title()).toMatch(/self-hosted AI coding agent/i);
});

test("page ships no runtime JS beyond the analytics tag", async ({ page }) => {
  await page.goto("/self-hosted");
  await expectNoRuntimeJsBeyondAnalytics(page);
});

test("architecture comparison distinguishes fully-in-your-cloud from hybrid, with citations per competitor row", async ({
  page,
}) => {
  await page.goto("/self-hosted");
  const text = (await page.locator("main").textContent())?.toLowerCase() ?? "";
  expect(text).toContain("fully in your own cloud");
  expect(text).toContain("hybrid");
  for (const tool of ["shipwright", "cursor", "openhands", "coder agents", "devin"]) {
    expect(text).toContain(tool);
  }
  // Every non-Shipwright row carries a [source] citation link.
  const sourceLinks = await page.getByRole("link", { name: /source/i }).count();
  expect(sourceLinks).toBeGreaterThanOrEqual(4);
});

test("OpenCode is never named on this page", async ({ page }) => {
  await page.goto("/self-hosted");
  const text = (await page.locator("body").textContent())?.toLowerCase() ?? "";
  expect(text).not.toContain("opencode");
});

test("Devin row links out to the full /vs/devin comparison", async ({
  page,
}) => {
  await page.goto("/self-hosted");
  await expect(
    page.getByRole("link", { name: "/vs/devin →", exact: true }),
  ).toHaveAttribute("href", "/vs/devin");
});

test("page markets no pricing anywhere", async ({ page }) => {
  await page.goto("/self-hosted");
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

test("facts carry a verified-as-of date", async ({ page }) => {
  await page.goto("/self-hosted");
  await expect(page.getByText(/facts verified as of/i)).toBeVisible();
});

test("CTA repeats the install command and links GitHub + discovery call", async ({
  page,
}) => {
  await page.goto("/self-hosted");
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
