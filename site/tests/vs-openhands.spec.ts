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

// /vs/openhands — the dedicated Shipwright-vs-OpenHands comparison page.
// Unlike /vs/devin and /vs/factory, OpenHands is itself MIT-licensed, so this
// page cannot lean on an "open vs. commercial" framing — the differentiation
// is tests-first enforcement (centerpiece) and plan-approval-by-default vs.
// OpenHands' opt-in QA agent and richer model/VCS flexibility. Copy
// discipline mirrors vs-factory.spec.ts and compare.spec.ts: a verified-as-of
// date on every OpenHands claim, no pricing figures, no tier names, no
// SWE-bench numbers, and no star-count digs.

test("vs/openhands route responds 200", async ({ page }) => {
  const response = await page.goto("/vs/openhands");
  expect(response?.status()).toBe(200);
});

test("page title targets the tests-first framing against the open-source category leader", async ({
  page,
}) => {
  await page.goto("/vs/openhands");
  expect(await page.title()).toContain(
    "tests-first alternative to the open-source category leader",
  );
});

test("page ships no runtime JS beyond the analytics tag", async ({ page }) => {
  await page.goto("/vs/openhands");
  await expectNoRuntimeJsBeyondAnalytics(page);
});

test("H1 leads with the Shipwright vs OpenHands framing", async ({ page }) => {
  await page.goto("/vs/openhands");
  await expect(page.locator("h1")).toContainText(/Shipwright vs OpenHands/i);
});

test("dimension table covers tests-first and other key dimensions", async ({
  page,
}) => {
  await page.goto("/vs/openhands");
  const tableText =
    (await page.locator("table").first().textContent())?.toLowerCase() ?? "";
  expect(tableText).toContain("tests-first");
  expect(tableText).toContain("license");
  expect(tableText).toContain("deployment");
  expect(tableText).toContain("task queue");
  expect(tableText).toContain("team visibility");
  expect(tableText).toContain("policy controls");
  expect(tableText).toContain("slack workflow");
  expect(tableText).toContain("open source");
});

test("tests-first row is the visual centerpiece — highlighted and specific about the QA agent's limits", async ({
  page,
}) => {
  await page.goto("/vs/openhands");
  const row = page.locator("table tr").filter({
    has: page.locator("td").first().getByText("Tests-first", { exact: true }),
  });
  // Visual emphasis: the row uses the shared brand-soft highlight background,
  // same mechanism compare.astro/self-hosted.astro use for their "self" row.
  await expect(row).toHaveAttribute("style", /brand-soft/);
  const text = (await row.textContent()) ?? "";
  expect(text).toMatch(/does not run the test suite/i);
});

test("'where OpenHands is ahead' passage covers model/agent flexibility, VCS breadth, managed hosting, and benchmark publishing", async ({
  page,
}) => {
  await page.goto("/vs/openhands");
  const text = (await page.locator("main").textContent()) ?? "";
  // ACP driving Claude Code (model/agent flexibility).
  expect(text).toMatch(/ACP/);
  expect(text).toMatch(/Claude Code/);
  // VCS breadth, phrased conservatively per the source material.
  expect(text).toMatch(/GitLab/);
  expect(text).toMatch(/Bitbucket/);
  expect(text).toMatch(/Azure Repos/);
  // Managed hosting.
  expect(text.toLowerCase()).toMatch(/managed hosting/);
  // Benchmark publishing — generic, no name or number (NEVER-PRINT).
  expect(text.toLowerCase()).toMatch(/publishes? (their )?(own )?(an )?(agentic-coding )?benchmark/);
});

test("'Choose OpenHands when' section is present", async ({ page }) => {
  await page.goto("/vs/openhands");
  await expect(
    page.getByRole("heading", { name: /Choose OpenHands when/i }).first(),
  ).toBeVisible();
  const text = (await page.locator("main").textContent())?.toLowerCase() ?? "";
  expect(text).toContain("choose shipwright when");
});

test("every OpenHands claim carries a citation link, and the page shows a verified-as-of date", async ({
  page,
}) => {
  await page.goto("/vs/openhands");
  await expect(page.getByText(/facts verified as of September 5, 2026/i)).toBeVisible();
  await expect(
    page.locator('a[href*="openhands.dev"]').first(),
  ).toBeVisible();
});

// Every dimension row in the page's source data (comparisonRows), mapped to
// how many citation links that row's OpenHands cell must render. Sources
// span openhands.dev, docs.openhands.dev, and github.com/OpenHands/OpenHands
// — so the citation selector below matches either host. Kept in sync
// manually with site/src/pages/vs/openhands.astro's comparisonRows: a future
// edit that silently drops a citation from any of these rows will fail this
// test.
const CITED_ROWS: Record<string, number> = {
  License: 1,
  Deployment: 1,
  Models: 2,
  "Task queue": 1,
  "Team visibility": 1,
  "Policy controls": 1,
  "Tests-first": 1,
  "Slack workflow": 1,
  "Open source": 1,
};

test("every cited OpenHands claim row renders its citation link(s) — per row, not just anywhere on the page", async ({
  page,
}) => {
  await page.goto("/vs/openhands");
  for (const [dimension, expectedLinkCount] of Object.entries(CITED_ROWS)) {
    const row = page.locator("table tr").filter({
      has: page.locator("td").first().getByText(dimension, { exact: true }),
    });
    await expect(
      row.locator(
        'td a[href*="openhands.dev"], td a[href*="github.com/OpenHands"]',
      ),
    ).toHaveCount(expectedLinkCount);
  }
});

test("page markets no pricing, no tier names, no SWE-bench numbers, and no star-count digs", async ({
  page,
}) => {
  await page.goto("/vs/openhands");
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
    "enterprise tier",
    "cloud plan",
    "swe-bench",
  ]);
  await expectNoDollarFigures(page);
  const text = (await page.locator("body").textContent()) ?? "";
  // No star-count dig (e.g. "78K stars" / "~78,000 stars").
  expect(text).not.toMatch(/[\d,.]+\s*[kK]?\s*(github )?stars?\b/);
});

test("CTA repeats the install command and links GitHub + discovery call", async ({
  page,
}) => {
  await page.goto("/vs/openhands");
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

test("/compare links to the full /vs/openhands comparison", async ({
  page,
}) => {
  await page.goto("/compare");
  await expect(
    page.getByRole("link", { name: /full.*Shipwright vs OpenHands comparison/i }),
  ).toHaveAttribute("href", "/vs/openhands");
});
