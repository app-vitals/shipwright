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

// /agent-model smoke tests — static Astro page with no logic. Formerly
// /architecture (UGD-3.1 renamed it to make room for /service-architecture).

test("agent-model route responds 200", async ({ page }) => {
  const response = await page.goto("/agent-model");
  expect(response?.status()).toBe(200);
});

test("agent-model page has the correct heading", async ({ page }) => {
  await page.goto("/agent-model");
  await expect(
    page
      .getByRole("heading", { name: /Shipwright.*Agent Model|Architecture/i })
      .first(),
  ).toBeVisible();
});

test("agent-model diagram shows all 5 sections", async ({ page }) => {
  await page.goto("/agent-model");
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

test("component reference lists all 11 components", async ({ page }) => {
  await page.goto("/agent-model");
  const text = (await page.locator("main").textContent())?.toLowerCase() ?? "";
  for (const component of [
    "plan-session",
    "entropy-patrol",
    "docs-refresh",
    "test-audit",
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

test("agent-model page ships no runtime JS beyond the analytics tag", async ({
  page,
}) => {
  await page.goto("/agent-model");
  await expectNoRuntimeJsBeyondAnalytics(page);
});

test("agent-model page links to the new operator docs pages", async ({
  page,
}) => {
  await page.goto("/agent-model");
  // Core Loop section -> the-shipwright-loop
  await expect(
    page.locator('a[href="/docs/the-shipwright-loop"]'),
  ).toHaveCount(1);
  // Maintenance Crons chips -> cron-jobs and agent-skills
  await expect(page.locator('a[href="/docs/cron-jobs"]')).toHaveCount(1);
  // agent-skills is linked from both the Maintenance Crons chips and the
  // Memory Component Reference row.
  await expect(page.locator('a[href="/docs/agent-skills"]')).toHaveCount(2);
  // dev-task/review/patch/deploy Component Reference rows -> commands-reference
  await expect(
    page.locator('a[href="/docs/commands-reference"]'),
  ).toHaveCount(4);
  // Task Store row reuses the existing task-store-api link target
  await expect(page.locator('a[href="/docs/task-store-api"]')).toHaveCount(1);
});

test("agent-model page cross-links to service-architecture", async ({
  page,
}) => {
  await page.goto("/agent-model");
  await expect(
    page.locator('a[href="/service-architecture"]'),
  ).toHaveCount(1);
});
