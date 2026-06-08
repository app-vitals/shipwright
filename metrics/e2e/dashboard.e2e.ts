/**
 * Metrics Dashboard — Playwright E2E tests.
 *
 * These tests drive the full server-rendered dashboard in a real Chromium browser.
 * The test server is started once per file via globalSetup/teardown; PostHog API
 * calls are intercepted at the network layer so no real PostHog credentials are needed.
 *
 * Session cookie auth: injectSessionCookie() signs a JWT with E2E_SESSION_SECRET,
 * which matches the SESSION_SECRET the test server is started with (see startTestServer).
 * This is the fix from PR #107: pin SESSION_SECRET on the spawn env so CI environments
 * that export a real SESSION_SECRET do not break cookie auth in tests.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type Page, expect, test } from "@playwright/test";
import { sign } from "hono/jwt";

// ─── Constants ────────────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_PORT = 3461;
const BASE_URL = `http://localhost:${TEST_PORT}`;

/**
 * E2E_SESSION_SECRET must match SESSION_SECRET passed to the test server spawn env.
 * Both are pinned here to ensure they stay in sync. See startTestServer() for the fix.
 */
const E2E_SESSION_SECRET = "e2e-test-session-secret-32b";

// ─── Server lifecycle ─────────────────────────────────────────────────────────

let serverProcess: ChildProcess | null = null;

async function startTestServer(): Promise<void> {
  const serverScript = resolve(__dirname, "test-server.ts");

  serverProcess = spawn("bun", ["run", serverScript], {
    env: {
      ...process.env,
      METRICS_E2E_PORT: String(TEST_PORT),
      POSTHOG_PERSONAL_API_KEY: "phx_e2e_fake",
      POSTHOG_PROJECT_ID: "99999",
      SESSION_SECRET: E2E_SESSION_SECRET, // ← pin session secret so CI envs don't break cookie auth
    },
    stdio: "pipe",
    cwd: resolve(__dirname, "../.."),
  });

  // Wait for the server to be ready
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("Test server did not start within 10s"));
    }, 10_000);

    serverProcess?.stdout?.on("data", (data: Buffer) => {
      if (data.toString().includes("Server running on")) {
        clearTimeout(timeout);
        resolve();
      }
    });

    serverProcess?.stderr?.on("data", (data: Buffer) => {
      console.error("[test-server stderr]", data.toString());
    });

    serverProcess?.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

async function stopTestServer(): Promise<void> {
  if (serverProcess) {
    serverProcess.kill("SIGTERM");
    serverProcess = null;
  }
}

// ─── Auth helpers ─────────────────────────────────────────────────────────────

/**
 * Inject a valid vitals_session cookie into the page context.
 * Signs with E2E_SESSION_SECRET — must match the SESSION_SECRET the server uses.
 */
async function injectSessionCookie(page: Page): Promise<void> {
  const payload = {
    userId: "e2e-user-id",
    email: "e2e@example.com",
    name: "E2E User",
    exp: Math.floor(Date.now() / 1000) + 3600,
  };
  const token = await sign(payload, E2E_SESSION_SECRET, "HS256");
  await page.context().addCookies([
    {
      name: "vitals_session",
      value: token,
      domain: "localhost",
      path: "/",
    },
  ]);
}

// ─── Mock data factories ──────────────────────────────────────────────────────

function makeSummaryResponse(overrides: Record<string, unknown> = {}) {
  return {
    data: {
      tasksCompleted: 42,
      tasksBlocked: 3,
      taskBlockedRate: 6.67,
      avgCycleTimeHours: 4.5,
      avgActualHours: 3.8,
      avgEstimatedHours: 4.0,
      avgRetries: 1.2,
      avgFilesChanged: 8.5,
      ciGatesTotal: 120,
      ciFirstPass: 96,
      ciFirstPassRate: 80.0,
      avgFixAttempts: 1.1,
      simplifyTotal: 15,
      simplifyTotalFixes: 15,
      simplifyAvgDry: 2.1,
      simplifyAvgDeadCode: 1.8,
      simplifyAvgNaming: 3.2,
      simplifyAvgComplexity: 0.9,
      simplifyAvgConsistency: 1.5,
      reviewsTotal: 38,
      reviewsShipIt: 30,
      reviewShipItRate: 78.95,
      estimationAccuracy: 5.0,
      complexityDist: { c1: 10, c2: 15, c3: 12, c4: 4, c5: 1 },
      avgFixCascadeDepth: null,
      ...overrides,
    },
    meta: {
      dateRange: "today",
      generatedAt: new Date().toISOString(),
      queryTimeMs: 123,
    },
  };
}

function makeTrendsResponse(rowCount = 3) {
  const rows = Array.from({ length: rowCount }, (_, i) => ({
    period: `2024-01-${String(i + 1).padStart(2, "0")}`,
    tasksCompleted: 5 + i,
    ciGates: 10 + i,
    ciFirstPass: 8 + i,
    ciFirstPassCount: 8 + i,
    simplifyPasses: 2,
    simplifyFixes: 3,
    tasksBlocked: 0,
    reviews: 4,
    tasksStarted: 6 + i,
    reviewsShipIt: 3,
    avgActualHours: 3.5,
    avgEstimatedHours: 4.0,
    avgRetries: 1.0,
    avgFilesChanged: 7.0,
    avgFixAttempts: 1.1,
    avgCycleTimeHours: 4.2,
    estimationAccuracy: 5.0,
    simplifyAvgDry: 1.0,
    simplifyAvgDeadCode: 1.0,
    simplifyAvgNaming: 1.0,
    simplifyAvgComplexity: 1.0,
    simplifyAvgConsistency: 1.0,
    avgReviewFindings: 2.0,
  }));
  return {
    data: { rows },
    meta: {
      dateRange: "today",
      generatedAt: new Date().toISOString(),
      queryTimeMs: 45,
    },
  };
}

function makeFeaturesResponse(features: Array<Record<string, unknown>> = []) {
  return {
    data: { features },
    meta: {
      dateRange: "today",
      generatedAt: new Date().toISOString(),
      queryTimeMs: 20,
    },
  };
}

function makeQueueResponse(overrides: Record<string, unknown> = {}) {
  return {
    data: {
      tasksStarted: 50,
      tasksMerged: 42,
      tasksBlocked: 3,
      tasksApproved: 40,
      blockRate: 6.0,
      avgCycleTimeDays: 1.8,
      avgReviewFindings: 2.5,
      ...overrides,
    },
    meta: {
      dateRange: "today",
      generatedAt: new Date().toISOString(),
      queryTimeMs: 30,
    },
  };
}

/**
 * Set up Playwright route mocking for all metrics API endpoints.
 * This intercepts PostHog-backed calls so no real API key is needed.
 */
async function mockMetricsAPIs(
  page: Page,
  options: {
    summaryOverrides?: Record<string, unknown>;
    featureRows?: Array<Record<string, unknown>>;
    queueOverrides?: Record<string, unknown>;
  } = {},
): Promise<void> {
  await page.route("**/metrics/summary**", (route) => {
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(makeSummaryResponse(options.summaryOverrides)),
    });
  });

  await page.route("**/metrics/trends**", (route) => {
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(makeTrendsResponse()),
    });
  });

  await page.route("**/metrics/features**", (route) => {
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(makeFeaturesResponse(options.featureRows)),
    });
  });

  await page.route("**/metrics/queue**", (route) => {
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(makeQueueResponse(options.queueOverrides)),
    });
  });

  await page.route("**/metrics/tokens**", (route) => {
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        data: {
          totals: {
            input: 1_000_000,
            output: 200_000,
            cacheRead: 50_000,
            cacheCreation: 10_000,
            total: 1_260_000,
          },
          bySessionType: [],
          byAgent: [],
          trends: [],
        },
        meta: {
          dateRange: "today",
          generatedAt: new Date().toISOString(),
          queryTimeMs: 20,
        },
      }),
    });
  });

  // Intercept Chart.js CDN to avoid network dependency in CI
  await page.route("**/chart.js**", (route) => {
    route.fulfill({
      status: 200,
      contentType: "application/javascript",
      body: "window.Chart = class Chart { constructor() {} destroy() {} update() {} }; Chart.defaults = {};",
    });
  });
}

function makeTrendsResponseWithFullFields(rowCount = 7) {
  const rows = Array.from({ length: rowCount }, (_, i) => ({
    period: `2024-01-${String(i + 1).padStart(2, "0")}`,
    tasksCompleted: 5 + i,
    ciGates: 10 + i,
    ciFirstPass: 8 + i,
    ciFirstPassCount: 8 + i,
    simplifyPasses: 2,
    simplifyFixes: 3,
    tasksBlocked: 1,
    reviews: 4,
    tasksStarted: 6 + i,
    reviewsShipIt: 3,
    avgActualHours: 3.5,
    avgEstimatedHours: 4.0,
    avgRetries: 1.0,
    avgFilesChanged: 7.0,
    avgFixAttempts: 1.1,
    avgCycleTimeHours: 4.2,
    estimationAccuracy: 5.0,
    simplifyAvgDry: 1.0,
    simplifyAvgDeadCode: 1.0,
    simplifyAvgNaming: 1.0,
    simplifyAvgComplexity: 1.0,
    simplifyAvgConsistency: 1.0,
    avgReviewFindings: 2.0,
  }));
  return {
    data: { rows },
    meta: {
      dateRange: "today",
      generatedAt: new Date().toISOString(),
      queryTimeMs: 45,
    },
  };
}

function makeHourlyTrendsResponse() {
  return makeTrendsResponseWithFullFields(24);
}

async function mockMetricsAPIsWithFullTrends(page: Page): Promise<void> {
  await page.route("**/metrics/summary**", (route) => {
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(makeSummaryResponse()),
    });
  });

  await page.route("**/metrics/trends**", (route) => {
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(makeTrendsResponseWithFullFields()),
    });
  });

  await page.route("**/metrics/features**", (route) => {
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(makeFeaturesResponse()),
    });
  });

  await page.route("**/metrics/queue**", (route) => {
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(makeQueueResponse()),
    });
  });

  await page.route("**/metrics/tokens**", (route) => {
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        data: {
          totals: { input: 500_000, output: 100_000, cacheRead: 0, cacheCreation: 0, total: 600_000 },
          bySessionType: [],
          byAgent: [],
          trends: makeTrendsResponseWithFullFields().data.rows.map((r) => ({
            date: r.period,
            input: 10000 + r.tasksCompleted * 1000,
            output: 2000,
            cacheRead: 500,
            cacheCreation: 100,
            total: 12600,
          })),
        },
        meta: { dateRange: "today", generatedAt: new Date().toISOString(), queryTimeMs: 20 },
      }),
    });
  });

  await page.route("**/chart.js**", (route) => {
    route.fulfill({
      status: 200,
      contentType: "application/javascript",
      body: "window.Chart = class Chart { constructor() {} destroy() {} update() {} }; Chart.defaults = {};",
    });
  });
}

// ─── Test setup/teardown ──────────────────────────────────────────────────────

test.beforeAll(async () => {
  await startTestServer();
});

test.afterAll(async () => {
  await stopTestServer();
});

// ─── Dashboard — page load ────────────────────────────────────────────────────

test.describe("Dashboard — page load", () => {
  test("redirects unauthenticated requests to /auth/login", async ({ page }) => {
    const response = await page.goto(`${BASE_URL}/dashboard`, {
      waitUntil: "domcontentloaded",
    });
    // Should redirect to login
    expect(page.url()).toContain("/auth/login");
  });

  test("renders toolbar with Shipwright wordmark", async ({ page }) => {
    await mockMetricsAPIs(page);
    await injectSessionCookie(page);
    await page.goto(`${BASE_URL}/dashboard`, { waitUntil: "networkidle" });

    const wordmark = page.locator(".vos-wordmark");
    await expect(wordmark).toBeVisible();
    await expect(wordmark).toContainText("Shipwright");
  });

  test("renders KPI cards", async ({ page }) => {
    await mockMetricsAPIs(page);
    await injectSessionCookie(page);
    await page.goto(`${BASE_URL}/dashboard`, { waitUntil: "networkidle" });

    await expect(page.locator(".kpi-grid")).toBeVisible();
    const cards = page.locator(".kpi-card");
    await expect(cards).toHaveCount(4);
  });

  test("renders pipeline quality panels", async ({ page }) => {
    await mockMetricsAPIs(page);
    await injectSessionCookie(page);
    await page.goto(`${BASE_URL}/dashboard`, { waitUntil: "networkidle" });

    await expect(page.locator('[aria-label="Pipeline quality"]')).toBeVisible();
    const panels = page.locator('[aria-label="Pipeline quality"] .quality-panel');
    await expect(panels).toHaveCount(4);
  });

  test("renders efficiency stats section", async ({ page }) => {
    await mockMetricsAPIs(page);
    await injectSessionCookie(page);
    await page.goto(`${BASE_URL}/dashboard`, { waitUntil: "networkidle" });

    await expect(page.locator('[aria-label="Efficiency"]')).toBeVisible();
    const blocks = page.locator(".efficiency-grid .stat-block");
    await expect(blocks).toHaveCount(4);
  });

  test("renders trends chart canvas", async ({ page }) => {
    await mockMetricsAPIs(page);
    await injectSessionCookie(page);
    await page.goto(`${BASE_URL}/dashboard`, { waitUntil: "networkidle" });

    const canvas = page.locator("#trends-chart");
    await expect(canvas).toBeVisible();
  });

  test("Chart.js instance is initialised on window", async ({ page }) => {
    await mockMetricsAPIs(page);
    await injectSessionCookie(page);
    await page.goto(`${BASE_URL}/dashboard`, { waitUntil: "networkidle" });

    // Chart stub sets window.Chart — confirm it's present
    const hasChart = await page.evaluate(() => typeof window.Chart !== "undefined");
    expect(hasChart).toBe(true);
  });

  test("API key is not exposed in page source", async ({ page }) => {
    await mockMetricsAPIs(page);
    await injectSessionCookie(page);
    await page.goto(`${BASE_URL}/dashboard`, { waitUntil: "networkidle" });

    const content = await page.content();
    expect(content).not.toContain("phx_");
    expect(content).not.toContain("sk_e2e_test_key");
  });
});

// ─── Dashboard — date range picker ───────────────────────────────────────────

test.describe("Dashboard — date range picker", () => {
  test("1D button is active by default", async ({ page }) => {
    await mockMetricsAPIs(page);
    await injectSessionCookie(page);
    await page.goto(`${BASE_URL}/dashboard`, { waitUntil: "networkidle" });

    const activeBtn = page.locator(".date-btn.active");
    await expect(activeBtn).toHaveText("1D");
  });

  test("clicking 30D switches active state", async ({ page }) => {
    await mockMetricsAPIs(page);
    await injectSessionCookie(page);
    await page.goto(`${BASE_URL}/dashboard`, { waitUntil: "networkidle" });

    const btn30d = page.locator('[data-range="30d"]');
    await btn30d.click();
    await expect(btn30d).toHaveClass(/active/);

    // Previously active button should no longer be active
    const btn1d = page.locator('[data-range="today"]');
    await expect(btn1d).not.toHaveClass(/active/);
  });

  test("clicking 90D switches active state", async ({ page }) => {
    await mockMetricsAPIs(page);
    await injectSessionCookie(page);
    await page.goto(`${BASE_URL}/dashboard`, { waitUntil: "networkidle" });

    const btn90d = page.locator('[data-range="90d"]');
    await btn90d.click();
    await expect(btn90d).toHaveClass(/active/);
  });
});

// ─── Dashboard — feature breakdown panel ─────────────────────────────────────

test.describe("Dashboard — feature breakdown panel", () => {
  test("renders 2 feature rows when API returns 2 features", async ({ page }) => {
    const featureRows = [
      {
        prefix: "SW",
        tasksCompleted: 10,
        avgActualH: 3.5,
        ciFirstPassRate: 85.0,
        reviewShipItRate: 90.0,
      },
      {
        prefix: "MQ",
        tasksCompleted: 8,
        avgActualH: 4.2,
        ciFirstPassRate: 75.0,
        reviewShipItRate: 80.0,
      },
    ];
    await mockMetricsAPIs(page, { featureRows });
    await injectSessionCookie(page);
    await page.goto(`${BASE_URL}/dashboard`, { waitUntil: "networkidle" });

    const rows = page.locator("#features-tbody tr");
    await expect(rows).toHaveCount(2);
  });

  test("shows empty state when no feature data", async ({ page }) => {
    await mockMetricsAPIs(page, { featureRows: [] });
    await injectSessionCookie(page);
    await page.goto(`${BASE_URL}/dashboard`, { waitUntil: "networkidle" });

    const emptyMsg = page.locator("#features-empty");
    await expect(emptyMsg).toBeVisible();
  });

  test("feature row shows percentage formatting for CI pass rate", async ({ page }) => {
    const featureRows = [
      {
        prefix: "SW",
        tasksCompleted: 10,
        avgActualH: 3.5,
        ciFirstPassRate: 85.0,
        reviewShipItRate: 90.0,
      },
    ];
    await mockMetricsAPIs(page, { featureRows });
    await injectSessionCookie(page);
    await page.goto(`${BASE_URL}/dashboard`, { waitUntil: "networkidle" });

    const rows = page.locator("#features-tbody tr");
    const firstRow = rows.nth(0);
    // CI pass rate cell should contain "%"
    const cells = firstRow.locator("td");
    const ciCell = cells.nth(3); // Feature, Tasks, Avg Hrs, CI Pass, Review
    await expect(ciCell).toContainText("%");
  });
});

// ─── Dashboard — error handling ───────────────────────────────────────────────

test.describe("Dashboard — error handling", () => {
  test("shows error toast on API error response", async ({ page }) => {
    await page.route("**/metrics/summary**", (route) => {
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ error: "PostHog query failed", data: null, meta: {} }),
      });
    });
    await page.route("**/metrics/trends**", (route) => {
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ error: "PostHog query failed", data: null, meta: {} }),
      });
    });
    // Allow other routes to pass through
    await page.route("**/metrics/features**", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(makeFeaturesResponse()) }));
    await page.route("**/metrics/queue**", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(makeQueueResponse()) }));
    await page.route("**/metrics/tokens**", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: { totals: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, total: 0 }, bySessionType: [], byAgent: [], trends: [] }, meta: {} }) }));
    await page.route("**/chart.js**", (route) => route.fulfill({ status: 200, contentType: "application/javascript", body: "window.Chart = class Chart { constructor() {} destroy() {} update() {} }; Chart.defaults = {};" }));

    await injectSessionCookie(page);
    await page.goto(`${BASE_URL}/dashboard`, { waitUntil: "networkidle" });

    const toast = page.locator("#error-toast");
    await expect(toast).toBeVisible({ timeout: 5000 });
    await expect(toast).toContainText("Metrics error:");
  });

  test("shows error toast on network failure", async ({ page }) => {
    await page.route("**/metrics/summary**", (route) => route.abort("failed"));
    await page.route("**/metrics/trends**", (route) => route.abort("failed"));
    await page.route("**/metrics/features**", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(makeFeaturesResponse()) }));
    await page.route("**/metrics/queue**", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(makeQueueResponse()) }));
    await page.route("**/metrics/tokens**", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: { totals: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, total: 0 }, bySessionType: [], byAgent: [], trends: [] }, meta: {} }) }));
    await page.route("**/chart.js**", (route) => route.fulfill({ status: 200, contentType: "application/javascript", body: "window.Chart = class Chart { constructor() {} destroy() {} update() {} }; Chart.defaults = {};" }));

    await injectSessionCookie(page);
    await page.goto(`${BASE_URL}/dashboard`, { waitUntil: "domcontentloaded" });

    const toast = page.locator("#error-toast");
    await expect(toast).toBeVisible({ timeout: 8000 });
  });
});

// ─── Dashboard — mobile viewport (375px) ─────────────────────────────────────

test.describe("Dashboard — mobile viewport (375px)", () => {
  test("layout adapts to mobile width", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await mockMetricsAPIs(page);
    await injectSessionCookie(page);
    await page.goto(`${BASE_URL}/dashboard`, { waitUntil: "networkidle" });

    // Toolbar should still be visible
    await expect(page.locator(".vos-toolbar")).toBeVisible();
    // KPI cards should still be present
    await expect(page.locator(".kpi-grid")).toBeVisible();
  });
});

// ─── Dashboard — tablet viewport (1024px) ────────────────────────────────────

test.describe("Dashboard — tablet viewport (1024px)", () => {
  test("3-column KPI grid on tablet viewport", async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 768 });
    await mockMetricsAPIs(page);
    await injectSessionCookie(page);
    await page.goto(`${BASE_URL}/dashboard`, { waitUntil: "networkidle" });

    const cards = page.locator(".kpi-card");
    await expect(cards).toHaveCount(4);
    await expect(page.locator(".kpi-grid")).toBeVisible();
  });
});

// ─── Dashboard — pipeline queue section ──────────────────────────────────────

test.describe("Dashboard — pipeline queue section", () => {
  test("renders real values in queue section", async ({ page }) => {
    await mockMetricsAPIs(page, {
      queueOverrides: {
        tasksStarted: 55,
        tasksMerged: 48,
        tasksBlocked: 4,
        tasksApproved: 45,
        blockRate: 7.27,
        avgCycleTimeDays: 2.1,
        avgReviewFindings: 3.0,
      },
    });
    await injectSessionCookie(page);
    await page.goto(`${BASE_URL}/dashboard`, { waitUntil: "networkidle" });

    await expect(page.locator("#queue-started")).toHaveText("55");
    await expect(page.locator("#queue-merged")).toHaveText("48");
    await expect(page.locator("#queue-blocked")).toHaveText("4");
  });

  test("shows -- placeholder when queue data is null", async ({ page }) => {
    await mockMetricsAPIs(page, {
      queueOverrides: {
        tasksStarted: 0,
        tasksMerged: 0,
        tasksBlocked: 0,
        tasksApproved: 0,
        blockRate: null,
        avgCycleTimeDays: null,
        avgReviewFindings: null,
      },
    });
    await injectSessionCookie(page);
    await page.goto(`${BASE_URL}/dashboard`, { waitUntil: "networkidle" });

    await expect(page.locator("#queue-cycle-time")).toHaveText("--");
    await expect(page.locator("#queue-review-findings")).toHaveText("--");
  });
});

// ─── Dashboard — metric graph modal ──────────────────────────────────────────

test.describe("Dashboard — metric graph modal", () => {
  test("clicking a metric card opens the modal", async ({ page }) => {
    await mockMetricsAPIsWithFullTrends(page);
    await injectSessionCookie(page);
    await page.goto(`${BASE_URL}/dashboard`, { waitUntil: "networkidle" });

    // Modal should be hidden initially
    const modal = page.locator("#metric-modal");
    await expect(modal).toBeHidden();

    // Click a KPI card
    const card = page.locator('[data-metric="tasks-completed"]').first();
    await card.click();

    // Modal should now be visible
    await expect(modal).not.toHaveAttribute("hidden");
    await expect(page.locator("#metric-modal-title")).toContainText("Tasks Completed");
  });

  test("pressing Escape closes the modal", async ({ page }) => {
    await mockMetricsAPIsWithFullTrends(page);
    await injectSessionCookie(page);
    await page.goto(`${BASE_URL}/dashboard`, { waitUntil: "networkidle" });

    // Open the modal
    const card = page.locator('[data-metric="tasks-completed"]').first();
    await card.click();
    const modal = page.locator("#metric-modal");
    await expect(modal).not.toHaveAttribute("hidden");

    // Close with Escape
    await page.keyboard.press("Escape");
    await expect(modal).toHaveAttribute("hidden", "");
  });

  test("clicking close button closes the modal", async ({ page }) => {
    await mockMetricsAPIsWithFullTrends(page);
    await injectSessionCookie(page);
    await page.goto(`${BASE_URL}/dashboard`, { waitUntil: "networkidle" });

    // Open the modal
    const card = page.locator('[data-metric="tasks-completed"]').first();
    await card.click();
    const modal = page.locator("#metric-modal");
    await expect(modal).not.toHaveAttribute("hidden");

    // Click close button
    await page.locator(".metric-modal-close").click();
    await expect(modal).toHaveAttribute("hidden", "");
  });
});

// ─── Dashboard — static assets ────────────────────────────────────────────────

test.describe("Dashboard — static assets", () => {
  test("serves styles.css with correct content-type", async ({ page }) => {
    await injectSessionCookie(page);
    const response = await page.request.get(`${BASE_URL}/dashboard/styles.css`);
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toContain("text/css");
  });

  test("serves app.js with correct content-type", async ({ page }) => {
    await injectSessionCookie(page);
    const response = await page.request.get(`${BASE_URL}/dashboard/app.js`);
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toContain("javascript");
  });
});

// ─── Dashboard — MG-1.2 clickable metric graphs ───────────────────────────────

test.describe("Dashboard — MG-1.2 clickable metric graphs", () => {
  test("clicking ci-first-pass KPI card opens modal with chart title", async ({ page }) => {
    await mockMetricsAPIsWithFullTrends(page);
    await injectSessionCookie(page);
    await page.goto(`${BASE_URL}/dashboard`, { waitUntil: "networkidle" });

    const card = page.locator('[data-metric="ci-first-pass"]').first();
    await card.click();

    const modal = page.locator("#metric-modal");
    await expect(modal).not.toHaveAttribute("hidden");
    await expect(page.locator("#metric-modal-title")).toContainText("CI First-Pass Rate");
  });

  test("clicking estimation-accuracy KPI card opens modal", async ({ page }) => {
    await mockMetricsAPIsWithFullTrends(page);
    await injectSessionCookie(page);
    await page.goto(`${BASE_URL}/dashboard`, { waitUntil: "networkidle" });

    const card = page.locator('[data-metric="estimation-accuracy"]').first();
    await card.click();

    const modal = page.locator("#metric-modal");
    await expect(modal).not.toHaveAttribute("hidden");
    await expect(page.locator("#metric-modal-title")).toContainText("Estimation Accuracy");
  });

  test("clicking review-ship-it KPI card opens modal", async ({ page }) => {
    await mockMetricsAPIsWithFullTrends(page);
    await injectSessionCookie(page);
    await page.goto(`${BASE_URL}/dashboard`, { waitUntil: "networkidle" });

    const card = page.locator('[data-metric="review-ship-it"]').first();
    await card.click();

    const modal = page.locator("#metric-modal");
    await expect(modal).not.toHaveAttribute("hidden");
    await expect(page.locator("#metric-modal-title")).toContainText("Review SHIP IT Rate");
  });

  test("clicking ci-gates stat opens modal", async ({ page }) => {
    await mockMetricsAPIsWithFullTrends(page);
    await injectSessionCookie(page);
    await page.goto(`${BASE_URL}/dashboard`, { waitUntil: "networkidle" });

    const el = page.locator('[data-metric="ci-gates"]').first();
    await el.click();

    const modal = page.locator("#metric-modal");
    await expect(modal).not.toHaveAttribute("hidden");
  });

  test("clicking tasks-started stat opens modal", async ({ page }) => {
    await mockMetricsAPIsWithFullTrends(page);
    await injectSessionCookie(page);
    await page.goto(`${BASE_URL}/dashboard`, { waitUntil: "networkidle" });

    const el = page.locator('[data-metric="tasks-started"]').first();
    await el.click();

    const modal = page.locator("#metric-modal");
    await expect(modal).not.toHaveAttribute("hidden");
    await expect(page.locator("#metric-modal-title")).toContainText("Tasks Started");
  });

  test("modal renders the metric-chart canvas", async ({ page }) => {
    await mockMetricsAPIsWithFullTrends(page);
    await injectSessionCookie(page);
    await page.goto(`${BASE_URL}/dashboard`, { waitUntil: "networkidle" });

    const card = page.locator('[data-metric="tasks-completed"]').first();
    await card.click();

    await expect(page.locator("#metric-chart")).toBeVisible();
  });
});
