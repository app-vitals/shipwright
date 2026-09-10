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

// /autonomy — the staged-rollout marketing page (MKT-AUTONOMY-PAGE-1). Every
// factual claim on this page traces to src/content/docs/configuring-autonomy.mdx.
// It is not a D10-designated competitor-naming surface, so no competitor
// names may appear here, and (D5) no prices or tier names.

test("autonomy route responds 200", async ({ page }) => {
  const response = await page.goto("/autonomy");
  expect(response?.status()).toBe(200);
});

test("page title targets the staged-rollout page", async ({ page }) => {
  await page.goto("/autonomy");
  expect(await page.title()).toMatch(/Roll it out in stages/i);
});

test("page ships no runtime JS beyond the analytics tag", async ({ page }) => {
  await page.goto("/autonomy");
  await expectNoRuntimeJsBeyondAnalytics(page);
});

test("H1 states trust, not tooling, is the bottleneck", async ({ page }) => {
  await page.goto("/autonomy");
  await expect(page.locator("h1")).toHaveText(
    "Trust is the bottleneck, not the tooling.",
  );
});

test("hero explains the dial-not-switch framing", async ({ page }) => {
  await page.goto("/autonomy");
  const text = (await page.locator("main, body").first().textContent()) ?? "";
  expect(text).toContain(
    "Shipwright is built to be dialled up, not switched on.",
  );
});

test("all three stages render with their crons", async ({ page }) => {
  await page.goto("/autonomy");
  const section = page.locator("#stages");
  const text = (await section.textContent())?.toLowerCase() ?? "";

  expect(text).toContain("plan and build.");
  expect(text).toContain("the agent cannot merge anything");
  expect(text).toContain("dev-task");

  expect(text).toContain("add review and patch.");
  expect(text).toContain("your engineers still control every merge");

  expect(text).toContain("close the loop.");
  expect(text).toContain(
    "plan, build, review, patch, deploy, without manual intervention",
  );

  // Stage 3 safeguards callout.
  expect(text).toContain("ci gates, required reviewers");
  expect(text).toContain("deploy pre-check");
});

test("the dial-in-detail table lists the four agent-policy settings", async ({
  page,
}) => {
  await page.goto("/autonomy");
  const section = page.locator("#dial");
  const text = (await section.textContent()) ?? "";

  expect(text).toContain("auto_post_reviews: false");
  expect(text).toContain("allowed_events");
  expect(text).toContain("REQUEST_CHANGES");
  expect(text).toContain("allow_self_review: false");
  expect(text).toContain("min_confidence");
  expect(text).toContain("max_findings");
  expect(text).toContain("state/agent-policy.md");
});

test("what-does-not-change section lists tests, infra, and the record", async ({
  page,
}) => {
  await page.goto("/autonomy");
  const section = page.locator("#constants");
  const text = (await section.textContent()) ?? "";

  expect(text).toContain("Tests come first, always.");
  expect(text).toContain("It runs on your infrastructure.");
  expect(text).toContain("You keep the record.");
});

test("two-ways-in section covers hands-off and bring-your-own-PR", async ({
  page,
}) => {
  await page.goto("/autonomy");
  const section = page.locator("#two-ways-in");
  const text = (await section.textContent())?.toLowerCase() ?? "";

  expect(text).toContain("hands-off:");
  expect(text).toContain("bring your own pr:");
});

test("page links to the full configuration reference doc", async ({
  page,
}) => {
  await page.goto("/autonomy");
  await expect(
    page.getByRole("link", { name: /full configuration reference/i }),
  ).toHaveAttribute("href", "/docs/configuring-autonomy");
});

test("CTA at the bottom of the page books a rollout conversation", async ({
  page,
}) => {
  await page.goto("/autonomy");
  await expect(
    page.locator("#cta").getByRole("link", { name: /talk through a rollout/i }),
  ).toHaveAttribute("href", BOOKING_URL);
});

test("page names no competitors (not a D10-designated surface)", async ({
  page,
}) => {
  await page.goto("/autonomy");
  // Scoped to <main> — the site-wide nav/footer is itself a D10-designated
  // surface (it carries the single "vs Devin" link on every page), so this
  // check is about the page's own content, not the shared chrome.
  const text = (await page.locator("main").textContent())?.toLowerCase() ?? "";
  for (const name of [
    "devin",
    "cursor",
    "openhands",
    "coder",
    "factory",
    "cognition",
    "augment",
    "copilot",
    "opencode",
  ]) {
    expect(text).not.toContain(name);
  }
});

test("page markets no pricing, tiers, or compliance certifications", async ({
  page,
}) => {
  await page.goto("/autonomy");
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
    "enterprise plan",
    "soc 2",
    "soc2",
    "iso 27001",
    "hipaa",
    "pci",
  ]);
  await expectNoDollarFigures(page);
});

test("page contains no services/engagement-model copy", async ({ page }) => {
  await page.goto("/autonomy");
  await expectBannedPhrasesAbsent(page, [
    "engagement",
    "consulting",
    "our services",
    "professional services",
  ]);
});

test("homepage differentiators section links to /autonomy additively", async ({
  page,
}) => {
  await page.goto("/");
  const section = page.locator("#differentiators");
  // The pre-existing PR #3263 card is untouched.
  await expect(section.getByText("Run our loop on day one")).toBeVisible();
  await expect(
    section.getByRole("link", { name: /roll it out in stages/i }),
  ).toHaveAttribute("href", "/autonomy");
});
