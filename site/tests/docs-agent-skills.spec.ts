import { expect, test } from "@playwright/test";

// Fulfill external font CDN requests immediately so the page's 'load' event
// fires even when CI can't reach external networks.
test.beforeEach(async ({ page }) => {
  await page.route(
    /fonts\.googleapis\.com|fonts\.gstatic\.com|api\.fontshare\.com|googletagmanager\.com/,
    (route) =>
      route.fulfill({ status: 200, contentType: "text/css", body: "" }),
  );
});

// Agent skills catalog page e2e tests (UDG-2.1).

test("GET /docs/agent-skills returns 200", async ({ page }) => {
  const response = await page.goto("/docs/agent-skills");
  expect(response?.status()).toBe(200);
});

test("h1 is present on agent-skills page", async ({ page }) => {
  await page.goto("/docs/agent-skills");
  const h1 = page.locator("h1");
  await expect(h1.first()).toBeVisible();
});

test("sidebar is present on agent-skills page", async ({ page }) => {
  await page.goto("/docs/agent-skills");
  const sidebar = page.locator("nav[aria-label='Docs navigation']");
  await expect(sidebar).toBeVisible();
});

test("Core/Delivery Loop group heading appears before other category headings", async ({
  page,
}) => {
  await page.goto("/docs/agent-skills");
  const h2 = page.locator("h2");
  const headings = (await h2.allTextContents()).map((h) => h.trim());
  const coreIndex = headings.findIndex((h) =>
    /core\s*\/\s*delivery loop|core.*delivery loop/i.test(h),
  );
  expect(coreIndex).toBe(0);
  expect(headings.length).toBeGreaterThan(1);
});

test("cross-links to the commands reference page are present", async ({
  page,
}) => {
  await page.goto("/docs/agent-skills");
  const link = page.locator('a[href*="/docs/commands-reference"]');
  expect(await link.count()).toBeGreaterThan(0);
});

// Every one of the 27 skills under plugins/shipwright/skills/ must be
// catalogued on this page.
const allSkillNames = [
  "agent-admin",
  "canary-execution",
  "consolidation-fix",
  "consolidation-scan",
  "entropy-fix",
  "entropy-scan",
  "error-fix",
  "error-resolve",
  "error-scan",
  "investigate-cron",
  "learning-capture",
  "pull-requests",
  "repo-config",
  "review-staged",
  "security-fix",
  "security-scan",
  "speed-budgets",
  "task-store",
  "test-debt",
  "test-design",
  "test-fix",
  "test-inventory",
  "test-migration",
  "test-readiness",
  "test-roadmap",
  "triage-dependabot-pr",
  "triage-dependabot-prs",
];

test("all 27 skill names appear on the agent-skills page", async ({
  page,
}) => {
  await page.goto("/docs/agent-skills");
  const body = await page.textContent("body");
  for (const name of allSkillNames) {
    expect(body).toContain(name);
  }
});
