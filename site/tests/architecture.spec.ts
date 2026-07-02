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

// /architecture smoke tests — static Astro page with no logic.

test("architecture route responds 200", async ({ page }) => {
  const response = await page.goto("/architecture");
  expect(response?.status()).toBe(200);
});

test("architecture page has the correct heading", async ({ page }) => {
  await page.goto("/architecture");
  await expect(
    page
      .getByRole("heading", { name: /Shipwright.*Agent Model|Architecture/i })
      .first(),
  ).toBeVisible();
});

test("architecture diagram shows all 5 sections", async ({ page }) => {
  await page.goto("/architecture");
  const text = (await page.locator("main").textContent())?.toLowerCase() ?? "";
  expect(text).toContain("human input");
  // Maintenance Crons or "Background hygiene" (the subtitle)
  const hasMaintCrons =
    text.includes("maintenance crons") || text.includes("background hygiene");
  expect(hasMaintCrons).toBe(true);
  expect(text).toContain("task store");
  expect(text).toContain("core loop");
  expect(text).toContain("memory");
});

test("component reference lists all 12 components", async ({ page }) => {
  await page.goto("/architecture");
  const text = (await page.locator("main").textContent())?.toLowerCase() ?? "";
  for (const component of [
    "plan-session",
    "entropy-patrol",
    "docs-refresh",
    "test-audit",
    "dependabot-triage",
    "migrations",
    "task-store",
    "dev-task",
    "review",
    "patch",
    "deploy",
    "memory",
  ]) {
    expect(text, `expected component "${component}" to be visible`).toContain(
      component.toLowerCase(),
    );
  }
});

test("architecture page ships no runtime JS beyond the analytics tag", async ({
  page,
}) => {
  await page.goto("/architecture");
  await expectNoRuntimeJsBeyondAnalytics(page);
});
