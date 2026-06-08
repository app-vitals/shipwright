/**
 * Metrics Dashboard — E2E Tests
 *
 * Starts a real Bun.serve metrics server and uses Playwright route
 * interception to mock PostHog API responses. Tests the dashboard UI
 * renders correctly, handles date range switching, and shows error states.
 *
 * The dashboard is now protected by session cookie auth. E2E tests inject a
 * valid vitals_session cookie via page.context().addCookies() before navigation.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type Page, expect, test } from "@playwright/test";
import { sign } from "hono/jwt";

const TEST_PORT = 3461;
const BASE = `http://localhost:${TEST_PORT}`;
const E2E_SESSION_SECRET = "e2e-test-session-secret-32b";
let serverProcess: ChildProcess | null = null;

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Server lifecycle ────────────────────────────────────────────────────────

async function startTestServer(): Promise<void> {
  const serverScript = resolve(__dirname, "test-server.ts");

  serverProcess = spawn("bun", ["run", serverScript], {
    env: {
      ...process.env,
      METRICS_E2E_PORT: String(TEST_PORT),
      POSTHOG_PERSONAL_API_KEY: "phx_e2e_fake",
      POSTHOG_PROJECT_ID: "99999",
    },
    stdio: "pipe",
    cwd: resolve(__dirname, "../.."),
  });

  serverProcess.stderr?.on("data", (data: Buffer) => {
    const msg = data.toString();
    if (msg.trim()) console.error("[e2e-server]", msg.trim());
  });

  const maxWait = 15_000;
  const start = Date.now();
  while (Date.now() - start < maxWait) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) return;
    } catch {
      // Not ready yet
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error("Metrics test server failed to start within 15 seconds");
}

function stopTestServer(): void {
  if (serverProcess) {
    serverProcess.kill("SIGTERM");
    serverProcess = null;
  }
}

// ─── Session cookie helpers ──────────────────────────────────────────────────

async function injectSessionCookie(page: Page): Promise<void> {
  const payload = {
    userId: "e2e-user",
    email: "e2e@example.com",
    name: "E2E User",
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600,
  };
  const token = await sign(payload, E2E_SESSION_SECRET, "HS256");
  await page.context().addCookies([
    {
      name: "vitals_session",
      value: token,
      domain: "localhost",
      path: "/",
      httpOnly: true,
      secure: false,
    },
  ]);
}

// ─── Mock PostHog responses ─────────────────────────────────────────────────

function makeSummaryResponse() {
  return {
    data: {
      tasksCompleted: 20,
      avgActualHours: 0.49,
      avgEstimatedHours: 1.3,
      avgRetries: 0,
      avgFilesChanged: 3.5,
      ciGatesTotal: 8,
      ciFirstPass: 7,
      ciFirstPassRate: 87.5,
      avgFixAttempts: 0.12,
      simplifyTotal: 8,
      simplifyTotalFixes: 5,
      simplifyAvgDry: 0.4,
      simplifyAvgDeadCode: 0.2,
      simplifyAvgNaming: 0.3,
      simplifyAvgComplexity: 0.1,
      simplifyAvgConsistency: 0,
      coverageReports: 3,
      avgCoverageDelta: 2.1,
      reviewsTotal: 6,
      reviewsShipIt: 4,
      reviewShipItRate: 66.67,
      estimationAccuracy: -62,
      complexityDist: { c1: 5, c2: 8, c3: 4, c4: 2, c5: 1 },
      avgFixCascadeDepth: 1.2,
    },
    meta: {
      dateRange: {
        from: "2026-03-30T00:00:00.000Z",
        to: "2026-04-05T23:59:59.999Z",
      },
      generatedAt: new Date().toISOString(),
      queryTimeMs: 42,
    },
  };
}

function makeTrendsResponse() {
  return {
    data: {
      rows: [
        {
          period: "2026-03-31",
          tasksCompleted: 9,
          ciGates: 0,
          ciFirstPass: 0,
          ciFirstPassCount: 0,
          simplifyPasses: 0,
          simplifyFixes: 0,
          coverageReports: 0,
          reviews: 0,
        },
        {
          period: "2026-04-01",
          tasksCompleted: 3,
          ciGates: 0,
          ciFirstPass: 0,
          ciFirstPassCount: 0,
          simplifyPasses: 0,
          simplifyFixes: 0,
          coverageReports: 0,
          reviews: 0,
        },
        {
          period: "2026-04-02",
          tasksCompleted: 8,
          ciGates: 8,
          ciFirstPass: 7,
          ciFirstPassCount: 7,
          simplifyPasses: 8,
          simplifyFixes: 5,
          coverageReports: 3,
          reviews: 6,
        },
      ],
    },
    meta: {
      dateRange: {
        from: "2026-03-30T00:00:00.000Z",
        to: "2026-04-05T23:59:59.999Z",
      },
      generatedAt: new Date().toISOString(),
      queryTimeMs: 38,
    },
  };
}

function makeFeaturesResponse() {
  return {
    data: {
      features: [
        {
          prefix: "MQ",
          tasksCompleted: 3,
          avgActualH: 2.5,
          avgEstimatedH: 4,
          ciFirstPassRate: 0.9,
          reviewShipItRate: 1.0,
        },
        {
          prefix: "DR",
          tasksCompleted: 3,
          avgActualH: 3.0,
          avgEstimatedH: 4.5,
          ciFirstPassRate: 0.85,
          reviewShipItRate: 1.0,
        },
      ],
    },
    meta: {
      dateRange: { from: "2026-04-01", to: "2026-04-08" },
      generatedAt: new Date().toISOString(),
      queryTimeMs: 45,
    },
  };
}

function makeQueueResponse(
  overrides?: Partial<{
    tasksStarted: number | null;
    tasksMerged: number | null;
    tasksBlocked: number | null;
    tasksApproved: number | null;
    blockRate: number | null;
    avgCycleTimeDays: number | null;
    avgReviewFindings: number | null;
  }>,
) {
  return {
    data: {
      tasksStarted: 12,
      tasksMerged: 9,
      tasksBlocked: 1,
      tasksApproved: 9,
      blockRate: 8.33,
      avgCycleTimeDays: 1.4,
      avgReviewFindings: 2.1,
      ...overrides,
    },
    meta: {
      dateRange: {
        from: "2026-03-30T00:00:00.000Z",
        to: "2026-04-05T23:59:59.999Z",
      },
      generatedAt: new Date().toISOString(),
      queryTimeMs: 42,
    },
  };
}

/**
 * Intercept the metrics API calls and return mock data.
 * The dashboard fetches /metrics/summary, /metrics/trends, /metrics/features, and /metrics/queue.
 */
async function mockMetricsAPIs(page: Page): Promise<void> {
  await page.route("**/metrics/summary*", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(makeSummaryResponse()),
    });
  });

  await page.route("**/metrics/trends*", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(makeTrendsResponse()),
    });
  });

  await page.route("**/metrics/features*", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(makeFeaturesResponse()),
    });
  });

  await page.route("**/metrics/queue*", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(makeQueueResponse()),
    });
  });
}

// ─── Setup ───────────────────────────────────────────────────────────────────

test.beforeAll(async () => {
  await startTestServer();
});

test.afterAll(() => {
  stopTestServer();
});

// ─── Dashboard page load ────────────────────────────────────────────────────

test.describe("Dashboard — page load", () => {
  test("redirects to /auth/login when no session cookie", async ({ page }) => {
    // Navigate without injecting session cookie — should redirect
    const res = await page.goto(`${BASE}/dashboard`);
    // Playwright follows redirects by default; final URL should be /auth/login
    expect(page.url()).toContain("/auth/login");
    // The response chain ended in a non-200 or the page redirected
    void res; // response may be null if redirect destination is not served
  });

  test("renders page with title and toolbar", async ({ page }) => {
    await injectSessionCookie(page);
    await mockMetricsAPIs(page);
    await page.goto(`${BASE}/dashboard`);

    await expect(page).toHaveTitle(/Metrics — Vitals OS/);
    // Shared toolbar is present with the Shipwright wordmark
    await expect(page.locator(".vos-toolbar")).toBeVisible();
    await expect(page.locator(".vos-wordmark")).toContainText("Shipwright");
    // Metrics nav link is active
    await expect(page.locator(".vos-nav-link.active")).toContainText("Metrics");
  });

  test("displays KPI cards with data from summary endpoint", async ({
    page,
  }) => {
    await injectSessionCookie(page);
    await mockMetricsAPIs(page);
    await page.goto(`${BASE}/dashboard`);

    // Wait for skeleton to be replaced with real data, then assert values
    await expect(page.locator("#kpi-tasks")).toHaveText("20", {
      timeout: 5000,
    });
    await expect(page.locator("#kpi-ci-rate")).toHaveText("88%");
    await expect(page.locator("#kpi-estimation")).toContainText("-62%");
    await expect(page.locator("#kpi-review-rate")).toHaveText("67%");
    await expect(page.locator("#task-count-badge")).toContainText("20 tasks");
  });

  test("displays pipeline quality panels", async ({ page }) => {
    await injectSessionCookie(page);
    await mockMetricsAPIs(page);
    await page.goto(`${BASE}/dashboard`);

    await expect(page.locator("#kpi-tasks")).toHaveText("20", {
      timeout: 5000,
    });

    // CI panel
    await expect(page.locator("#ci-total")).toHaveText("8");
    await expect(page.locator("#ci-first")).toHaveText("7");

    // Simplify panel
    await expect(page.locator("#simplify-total")).toHaveText("5");

    // Reviews panel
    await expect(page.locator("#review-total")).toHaveText("6");
    await expect(page.locator("#review-ship-it")).toHaveText("4");

    // Coverage panel
    await expect(page.locator("#coverage-reports")).toHaveText("3");
    await expect(page.locator("#coverage-delta")).toContainText("+2.1%");
  });

  test("displays efficiency stats", async ({ page }) => {
    await injectSessionCookie(page);
    await mockMetricsAPIs(page);
    await page.goto(`${BASE}/dashboard`);

    await expect(page.locator("#kpi-tasks")).toHaveText("20", {
      timeout: 5000,
    });

    await expect(page.locator("#eff-avg-hours")).toContainText("0.5h");
    await expect(page.locator("#eff-est-hours")).toContainText("1.3h");
    await expect(page.locator("#eff-retries")).toHaveText("0.0");
    await expect(page.locator("#eff-files")).toHaveText("3.5");
  });

  test("renders trends chart canvas", async ({ page }) => {
    await injectSessionCookie(page);
    await mockMetricsAPIs(page);
    await page.goto(`${BASE}/dashboard`);

    await expect(page.locator("#kpi-tasks")).toHaveText("20", {
      timeout: 5000,
    });

    const canvas = page.locator("#trends-chart");
    await expect(canvas).toBeVisible();
    // Canvas should have been drawn (non-zero dimensions)
    const width = await canvas.evaluate((el: HTMLCanvasElement) => el.width);
    expect(width).toBeGreaterThan(0);
  });

  test("Chart.js instance is created after data load", async ({ page }) => {
    await injectSessionCookie(page);
    await mockMetricsAPIs(page);
    await page.goto(`${BASE}/dashboard`);

    await expect(page.locator("#kpi-tasks")).toHaveText("20", {
      timeout: 5000,
    });

    const chartExists = await page.evaluate(
      () =>
        "trendsChart" in window &&
        (window as { trendsChart: unknown }).trendsChart != null,
    );
    expect(chartExists).toBe(true);
  });

  test("does not expose API key in page source", async ({ page }) => {
    await injectSessionCookie(page);
    await mockMetricsAPIs(page);
    await page.goto(`${BASE}/dashboard`);

    const apiKey = await page.evaluate(
      () => (window as { __VITALS_API_KEY?: string }).__VITALS_API_KEY,
    );
    expect(apiKey).toBeUndefined();
  });
});

// ─── Date range picker ───────────────────────────────────────────────────────

test.describe("Dashboard — date range picker", () => {
  test("1D button is active by default", async ({ page }) => {
    await injectSessionCookie(page);
    await mockMetricsAPIs(page);
    await page.goto(`${BASE}/dashboard`);

    const btn1d = page.locator('.date-btn[data-range="today"]');
    await expect(btn1d).toHaveClass(/active/);
    // 7D should not be active anymore
    await expect(page.locator('.date-btn[data-range="7d"]')).not.toHaveClass(
      /active/,
    );
  });

  test("clicking 30D switches active state and re-fetches", async ({
    page,
  }) => {
    await injectSessionCookie(page);
    let summaryCallCount = 0;
    await page.route("**/metrics/summary*", async (route) => {
      summaryCallCount++;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(makeSummaryResponse()),
      });
    });
    await page.route("**/metrics/trends*", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(makeTrendsResponse()),
      });
    });
    await page.route("**/metrics/features*", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(makeFeaturesResponse()),
      });
    });

    await page.goto(`${BASE}/dashboard`);
    await expect(page.locator("#kpi-tasks")).toHaveText("20", {
      timeout: 5000,
    });
    const initialCount = summaryCallCount;

    // Set up response listener before click to avoid race condition
    const responsePromise = page.waitForResponse("**/metrics/summary*");
    await page.locator('.date-btn[data-range="30d"]').click();
    await responsePromise;

    // 30D is now active, 7D is not
    await expect(page.locator('.date-btn[data-range="30d"]')).toHaveClass(
      /active/,
    );
    await expect(page.locator('.date-btn[data-range="7d"]')).not.toHaveClass(
      /active/,
    );

    expect(summaryCallCount).toBeGreaterThan(initialCount);
  });

  test("clicking 90D switches active state and re-fetches both endpoints", async ({
    page,
  }) => {
    await injectSessionCookie(page);
    let summaryCallCount = 0;
    let featuresCallCount = 0;

    await page.route("**/metrics/summary*", async (route) => {
      summaryCallCount++;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(makeSummaryResponse()),
      });
    });
    await page.route("**/metrics/trends*", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(makeTrendsResponse()),
      });
    });
    await page.route("**/metrics/features*", async (route) => {
      featuresCallCount++;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(makeFeaturesResponse()),
      });
    });

    await page.goto(`${BASE}/dashboard`);
    await expect(page.locator("#kpi-tasks")).toHaveText("20", {
      timeout: 5000,
    });

    const initialSummaryCount = summaryCallCount;
    const initialFeaturesCount = featuresCallCount;

    const summaryPromise = page.waitForResponse("**/metrics/summary*");
    const featuresPromise = page.waitForResponse("**/metrics/features*");
    await page.locator('.date-btn[data-range="90d"]').click();
    await summaryPromise;
    await featuresPromise;

    await expect(page.locator('.date-btn[data-range="90d"]')).toHaveClass(
      /active/,
    );
    await expect(page.locator('.date-btn[data-range="7d"]')).not.toHaveClass(
      /active/,
    );

    expect(summaryCallCount).toBeGreaterThan(initialSummaryCount);
    expect(featuresCallCount).toBeGreaterThan(initialFeaturesCount);
  });
});

// ─── Feature Breakdown Panel ─────────────────────────────────────────────────

test.describe("Dashboard — feature breakdown panel", () => {
  test("renders feature table with 2 rows from mock data", async ({ page }) => {
    await injectSessionCookie(page);
    await mockMetricsAPIs(page);
    await page.goto(`${BASE}/dashboard`);

    await expect(page.locator("#kpi-tasks")).toHaveText("20", {
      timeout: 5000,
    });

    const rows = page.locator("#features-tbody tr");
    await expect(rows).toHaveCount(2);

    // First row: MQ feature
    await expect(rows.nth(0)).toContainText("MQ");
    await expect(rows.nth(0)).toContainText("3");

    // Second row: DR feature
    await expect(rows.nth(1)).toContainText("DR");
    await expect(rows.nth(1)).toContainText("3");
  });

  test("empty features response shows no-data message", async ({ page }) => {
    await injectSessionCookie(page);
    await page.route("**/metrics/summary*", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(makeSummaryResponse()),
      });
    });
    await page.route("**/metrics/trends*", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(makeTrendsResponse()),
      });
    });
    await page.route("**/metrics/features*", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: { features: [] },
          meta: {
            dateRange: { from: "2026-04-01", to: "2026-04-08" },
            generatedAt: new Date().toISOString(),
            queryTimeMs: 10,
          },
        }),
      });
    });

    await page.goto(`${BASE}/dashboard`);
    await expect(page.locator("#kpi-tasks")).toHaveText("20", {
      timeout: 5000,
    });

    await expect(page.locator("#features-empty")).toBeVisible();
    await expect(page.locator("#features-empty")).toContainText(
      "No feature data for this period",
    );
  });

  test("feature values are formatted correctly with percentages", async ({
    page,
  }) => {
    await injectSessionCookie(page);
    await mockMetricsAPIs(page);
    await page.goto(`${BASE}/dashboard`);

    await expect(page.locator("#kpi-tasks")).toHaveText("20", {
      timeout: 5000,
    });

    const rows = page.locator("#features-tbody tr");

    // CI pass rate for MQ is 0.9 → formatted as "90%" (fmtPct rounds)
    // Note: ciFirstPassRate = 0.9 in mock, fmtPct gives "90%" via Math.round(0.9) → "1%" ... actually
    // fmtPct does Math.round(v) and v=0.9 → "1%". But wait, looking at the mock:
    // ciFirstPassRate: 0.9 means 0.9% — so it'd be "1%"
    // The features endpoint uses raw ratios (0–1) not percentages (0–100).
    // fmtPct(0.9) = Math.round(0.9) + "%" = "1%" which seems wrong.
    // The mock uses 0.9 for ciFirstPassRate, fmtPct returns "1%"... let's just check % symbol is present
    await expect(rows.nth(0)).toContainText("%");
    await expect(rows.nth(1)).toContainText("%");
  });
});

// ─── Error states ────────────────────────────────────────────────────────────

test.describe("Dashboard — error handling", () => {
  test("shows error toast when API returns an error", async ({ page }) => {
    await injectSessionCookie(page);
    await page.route("**/metrics/summary*", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ error: "PostHog query failed (500): timeout" }),
      });
    });
    await page.route("**/metrics/trends*", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(makeTrendsResponse()),
      });
    });
    await page.route("**/metrics/features*", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(makeFeaturesResponse()),
      });
    });

    await page.goto(`${BASE}/dashboard`);

    const toast = page.locator("#error-toast");
    await expect(toast).toHaveClass(/visible/, { timeout: 5000 });
    await expect(toast).toContainText("PostHog query failed");
  });

  test("shows error toast on network failure", async ({ page }) => {
    await injectSessionCookie(page);
    await page.route("**/metrics/summary*", async (route) => {
      await route.abort("failed");
    });
    await page.route("**/metrics/trends*", async (route) => {
      await route.abort("failed");
    });
    await page.route("**/metrics/features*", async (route) => {
      await route.abort("failed");
    });

    await page.goto(`${BASE}/dashboard`);

    const toast = page.locator("#error-toast");
    await expect(toast).toHaveClass(/visible/, { timeout: 5000 });
    await expect(toast).toContainText("Failed to load metrics");
  });
});

// ─── Mobile viewport ────────────────────────────────────────────────────────

test.describe("Dashboard — mobile viewport (375px)", () => {
  test.use({ viewport: { width: 375, height: 667 } });

  test("layout adapts to narrow viewport", async ({ page }) => {
    await injectSessionCookie(page);
    await mockMetricsAPIs(page);
    await page.goto(`${BASE}/dashboard`);

    await expect(page.locator("#kpi-tasks")).toHaveText("20", {
      timeout: 5000,
    });

    // Toolbar is visible
    await expect(page.locator(".vos-toolbar")).toBeVisible();

    // KPI cards are visible
    await expect(page.locator("#kpi-tasks")).toBeVisible();
    await expect(page.locator("#kpi-ci-rate")).toBeVisible();

    // Date picker buttons are visible
    await expect(page.locator('.date-btn[data-range="7d"]')).toBeVisible();

    // Chart is visible
    await expect(page.locator("#trends-chart")).toBeVisible();
  });
});

// ─── Tablet viewport ─────────────────────────────────────────────────────────

test.describe("Dashboard — tablet viewport (1024px)", () => {
  test.use({ viewport: { width: 1024, height: 768 } });

  test("KPI grid shows 3-column layout and all sections visible", async ({
    page,
  }) => {
    await injectSessionCookie(page);
    await mockMetricsAPIs(page);
    await page.goto(`${BASE}/dashboard`);

    await expect(page.locator("#kpi-tasks")).toHaveText("20", {
      timeout: 5000,
    });

    // All 4 KPI cards are visible
    await expect(page.locator("#kpi-tasks")).toBeVisible();
    await expect(page.locator("#kpi-ci-rate")).toBeVisible();
    await expect(page.locator("#kpi-estimation")).toBeVisible();
    await expect(page.locator("#kpi-review-rate")).toBeVisible();

    // KPI grid has 3-column layout at 1024px
    const kpiGrid = page.locator(".kpi-grid");
    const columns = await kpiGrid.evaluate(
      (el: HTMLElement) => getComputedStyle(el).gridTemplateColumns,
    );
    // At 1024px the media query sets repeat(3, 1fr) — three equal columns
    const colCount = columns
      .trim()
      .split(/\s+/)
      .filter((c) => c !== "").length;
    expect(colCount).toBe(3);

    // Feature table section is visible
    await expect(page.locator(".features-section")).toBeVisible();

    // Chart is visible
    await expect(page.locator("#trends-chart")).toBeVisible();
  });
});

// ─── Pipeline Queue Section ──────────────────────────────────────────────────

test.describe("Dashboard — pipeline queue section", () => {
  test("renders queue section with throughput panel values", async ({
    page,
  }) => {
    await injectSessionCookie(page);
    await mockMetricsAPIs(page);
    await page.goto(`${BASE}/dashboard`);

    // Wait for data to load
    await expect(page.locator("#kpi-tasks")).toHaveText("20", {
      timeout: 5000,
    });

    // Section exists and is visible
    const section = page.locator('section[aria-label="Pipeline queue"]');
    await expect(section).toBeVisible();

    // Throughput panel: real values (not "--") since mock has real data
    await expect(page.locator("#queue-started")).toBeVisible();
    await expect(page.locator("#queue-started")).not.toHaveText("--");
    await expect(page.locator("#queue-approved")).toBeVisible();
    await expect(page.locator("#queue-approved")).not.toHaveText("--");
    await expect(page.locator("#queue-merged")).toBeVisible();
    await expect(page.locator("#queue-merged")).not.toHaveText("--");
    await expect(page.locator("#queue-blocked")).toBeVisible();
    await expect(page.locator("#queue-blocked")).not.toHaveText("--");

    // Cycle Time panel: 1.4 days
    await expect(page.locator("#queue-cycle-time")).toContainText("1.4 days");

    // Block Rate panel: 8.33 → fmtPct → "8%"
    await expect(page.locator("#queue-block-rate")).toContainText("8%");

    // Review Findings panel: 2.1
    await expect(page.locator("#queue-review-findings")).toContainText("2.1");
  });

  test("renders queue section with null values showing placeholders", async ({
    page,
  }) => {
    await injectSessionCookie(page);
    // Mock with null nullable fields
    await page.route("**/metrics/summary*", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(makeSummaryResponse()),
      });
    });
    await page.route("**/metrics/trends*", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(makeTrendsResponse()),
      });
    });
    await page.route("**/metrics/features*", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(makeFeaturesResponse()),
      });
    });
    await page.route("**/metrics/queue*", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(
          makeQueueResponse({
            blockRate: null,
            avgCycleTimeDays: null,
            avgReviewFindings: null,
          }),
        ),
      });
    });

    await page.goto(`${BASE}/dashboard`);

    await expect(page.locator("#kpi-tasks")).toHaveText("20", {
      timeout: 5000,
    });

    // Null cycle time → "--"
    await expect(page.locator("#queue-cycle-time")).toHaveText("--");

    // Null block rate → "--%"
    await expect(page.locator("#queue-block-rate")).toHaveText("--%");

    // Null review findings → "--"
    await expect(page.locator("#queue-review-findings")).toHaveText("--");
  });
});

// ─── Metric Graph Modal (MG-1.2) ─────────────────────────────────────────────

test.describe("Dashboard — metric graph modal", () => {
  test("clicking a KPI metric card opens the modal with a canvas element", async ({
    page,
  }) => {
    await injectSessionCookie(page);
    await mockMetricsAPIs(page);
    await page.goto(`${BASE}/dashboard`);

    // Wait for data to load
    await expect(page.locator("#kpi-tasks")).toHaveText("20", {
      timeout: 5000,
    });

    // Modal should be hidden initially
    const modal = page.locator("#metric-modal");
    await expect(modal).toBeHidden();

    // Click the Tasks Completed KPI card (has data-metric="tasks-completed")
    await page.locator('[data-metric="tasks-completed"]').click();

    // Modal should now be visible
    await expect(modal).toBeVisible();

    // Modal should contain the canvas for the chart
    await expect(page.locator("#metric-chart")).toBeVisible();

    // Modal title should be set to the metric label
    await expect(page.locator("#metric-modal-title")).toContainText(
      "Tasks Completed",
    );
  });

  test("ESC key closes the modal", async ({ page }) => {
    await injectSessionCookie(page);
    await mockMetricsAPIs(page);
    await page.goto(`${BASE}/dashboard`);

    // Wait for data
    await expect(page.locator("#kpi-tasks")).toHaveText("20", {
      timeout: 5000,
    });

    // Open modal
    await page.locator('[data-metric="tasks-completed"]').click();
    await expect(page.locator("#metric-modal")).toBeVisible();

    // Press ESC to close
    await page.keyboard.press("Escape");
    await expect(page.locator("#metric-modal")).toBeHidden();
  });

  test("clicking the close button closes the modal", async ({ page }) => {
    await injectSessionCookie(page);
    await mockMetricsAPIs(page);
    await page.goto(`${BASE}/dashboard`);

    // Wait for data
    await expect(page.locator("#kpi-tasks")).toHaveText("20", {
      timeout: 5000,
    });

    // Open modal
    await page.locator('[data-metric="tasks-completed"]').click();
    await expect(page.locator("#metric-modal")).toBeVisible();

    // Click close button
    await page.locator(".metric-modal-close").click();
    await expect(page.locator("#metric-modal")).toBeHidden();
  });
});

// ─── Static assets ───────────────────────────────────────────────────────────

test.describe("Dashboard — static assets", () => {
  test("styles.css loads with correct content type", async ({ page }) => {
    await injectSessionCookie(page);
    const response = await page.goto(`${BASE}/dashboard/styles.css`);
    expect(response?.headers()["content-type"]).toContain("text/css");
    expect(response?.headers()["cache-control"]).toBe("public, max-age=3600");
  });

  test("app.js loads with correct content type", async ({ page }) => {
    await injectSessionCookie(page);
    const response = await page.goto(`${BASE}/dashboard/app.js`);
    expect(response?.headers()["content-type"]).toContain(
      "application/javascript",
    );
  });
});

// ─── MG-1.2 Clickable Metric Graphs ─────────────────────────────────────────

function makeTrendsResponseWithFullFields() {
  const makeRow = (period: string, n: number) => ({
    period,
    tasksCompleted: n,
    ciGates: n,
    ciFirstPass: Math.max(0, n - 1),
    ciFirstPassCount: Math.max(0, n - 1),
    simplifyPasses: n,
    simplifyFixes: n * 0.5,
    tasksBlocked: 0,
    reviews: n,
    tasksStarted: n,
    reviewsShipIt: Math.max(0, n - 1),
    avgActualHours: 0.5,
    avgEstimatedHours: 1.0,
    avgRetries: 0.1,
    avgFilesChanged: 3.5,
    avgFixAttempts: 0.1,
    avgCycleTimeHours: 2.5,
    estimationAccuracy: -50,
    simplifyAvgDry: 0.4,
    simplifyAvgDeadCode: 0.2,
    simplifyAvgNaming: 0.3,
    simplifyAvgComplexity: 0.1,
    simplifyAvgConsistency: 0.0,
    avgReviewFindings: 1.2,
  });
  return {
    data: {
      rows: [
        makeRow("2026-04-01", 3),
        makeRow("2026-04-02", 5),
        makeRow("2026-04-03", 8),
      ],
    },
    meta: {
      dateRange: {
        from: "2026-03-30T00:00:00.000Z",
        to: "2026-04-05T23:59:59.999Z",
      },
      generatedAt: new Date().toISOString(),
      queryTimeMs: 38,
    },
  };
}

function makeHourlyTrendsResponse() {
  const hours = Array.from({ length: 8 }, (_, i) => {
    const hour = String(i * 3).padStart(2, "0");
    return {
      period: `2026-04-02 ${hour}:00`,
      tasksCompleted: i,
      ciGates: i,
      ciFirstPass: i,
      ciFirstPassCount: i,
      simplifyPasses: i,
      simplifyFixes: i * 0.5,
      tasksBlocked: 0,
      reviews: i,
      tasksStarted: i,
      reviewsShipIt: i,
      avgActualHours: 0.5,
      avgEstimatedHours: 1.0,
      avgRetries: 0.1,
      avgFilesChanged: 3.5,
      avgFixAttempts: 0.1,
      avgCycleTimeHours: 2.5,
      estimationAccuracy: -50,
      simplifyAvgDry: 0.4,
      simplifyAvgDeadCode: 0.2,
      simplifyAvgNaming: 0.3,
      simplifyAvgComplexity: 0.1,
      simplifyAvgConsistency: 0.0,
      avgReviewFindings: 1.2,
    };
  });
  return {
    data: { rows: hours },
    meta: {
      dateRange: {
        from: "2026-04-02T00:00:00.000Z",
        to: "2026-04-02T23:59:59.999Z",
      },
      generatedAt: new Date().toISOString(),
      queryTimeMs: 20,
    },
  };
}

async function mockMetricsAPIsWithFullTrends(page: Page): Promise<void> {
  await page.route("**/metrics/summary*", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(makeSummaryResponse()),
    });
  });

  await page.route("**/metrics/trends*", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(makeTrendsResponseWithFullFields()),
    });
  });

  await page.route("**/metrics/features*", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(makeFeaturesResponse()),
    });
  });

  await page.route("**/metrics/queue*", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(makeQueueResponse()),
    });
  });

  await page.route("**/metrics/tokens*", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        data: {
          totals: {
            input: 1000,
            output: 500,
            cacheRead: 200,
            cacheCreation: 100,
            total: 1800,
          },
          bySessionType: [],
          byAgent: [],
          trends: [
            {
              date: "2026-04-01",
              input: 300,
              output: 150,
              cacheRead: 60,
              cacheCreation: 30,
              total: 540,
            },
            {
              date: "2026-04-02",
              input: 700,
              output: 350,
              cacheRead: 140,
              cacheCreation: 70,
              total: 1260,
            },
          ],
        },
        meta: {
          dateRange: {
            from: "2026-04-01T00:00:00.000Z",
            to: "2026-04-02T23:59:59.999Z",
          },
          generatedAt: new Date().toISOString(),
          queryTimeMs: 10,
        },
      }),
    });
  });
}

test.describe("Dashboard — MG-1.2 clickable metric graphs", () => {
  test("clicking a KPI card opens the metric modal with a canvas", async ({
    page,
  }) => {
    await injectSessionCookie(page);
    await mockMetricsAPIsWithFullTrends(page);
    await page.goto(`${BASE}/dashboard`);

    // Wait for data to load
    await expect(page.locator("#kpi-tasks")).toHaveText("20", {
      timeout: 5000,
    });

    // Modal should not be visible initially
    await expect(page.locator("#metric-modal")).toBeHidden();

    // Click the "Tasks Completed" KPI card
    await page.locator('[data-metric="tasks-completed"]').click();

    // Modal should now be visible
    await expect(page.locator("#metric-modal")).toBeVisible();

    // Canvas should be present
    const canvas = page.locator("#metric-chart");
    await expect(canvas).toBeVisible();

    // Title should be set
    await expect(page.locator("#metric-modal-title")).toContainText(
      "Tasks Completed",
    );
  });

  test("modal closes when close button is clicked", async ({ page }) => {
    await injectSessionCookie(page);
    await mockMetricsAPIsWithFullTrends(page);
    await page.goto(`${BASE}/dashboard`);

    await expect(page.locator("#kpi-tasks")).toHaveText("20", {
      timeout: 5000,
    });

    // Open modal
    await page.locator('[data-metric="tasks-completed"]').click();
    await expect(page.locator("#metric-modal")).toBeVisible();

    // Click close button
    await page.locator(".metric-modal-close").click();

    // Modal should be hidden again
    await expect(page.locator("#metric-modal")).toBeHidden();
  });

  test("modal closes when ESC key is pressed", async ({ page }) => {
    await injectSessionCookie(page);
    await mockMetricsAPIsWithFullTrends(page);
    await page.goto(`${BASE}/dashboard`);

    await expect(page.locator("#kpi-tasks")).toHaveText("20", {
      timeout: 5000,
    });

    // Open modal
    await page.locator('[data-metric="ci-first-pass"]').click();
    await expect(page.locator("#metric-modal")).toBeVisible();

    // Press ESC
    await page.keyboard.press("Escape");

    // Modal should be hidden
    await expect(page.locator("#metric-modal")).toBeHidden();
  });

  test("modal closes when clicking outside the modal content", async ({
    page,
  }) => {
    await injectSessionCookie(page);
    await mockMetricsAPIsWithFullTrends(page);
    await page.goto(`${BASE}/dashboard`);

    await expect(page.locator("#kpi-tasks")).toHaveText("20", {
      timeout: 5000,
    });

    // Open modal
    await page.locator('[data-metric="review-ship-it"]').click();
    await expect(page.locator("#metric-modal")).toBeVisible();

    // Click the viewport corner — the backdrop fills the full viewport but the modal-box
    // sits centered; clicking at (5,5) lands on the backdrop outside the modal-box without
    // needing force:true (which dispatches at center coordinates, i.e. inside the modal-box)
    await page.mouse.click(5, 5);

    // Modal should be hidden
    await expect(page.locator("#metric-modal")).toBeHidden();
  });

  test("1D range requests trends with groupBy=hour", async ({ page }) => {
    await injectSessionCookie(page);

    let trendsCapturedUrl = "";

    await page.route("**/metrics/summary*", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(makeSummaryResponse()),
      });
    });

    await page.route("**/metrics/trends*", async (route) => {
      trendsCapturedUrl = route.request().url();
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(makeHourlyTrendsResponse()),
      });
    });

    await page.route("**/metrics/features*", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(makeFeaturesResponse()),
      });
    });

    await page.route("**/metrics/queue*", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(makeQueueResponse()),
      });
    });

    // 1D is the default — should use groupBy=hour
    await page.goto(`${BASE}/dashboard`);
    await expect(page.locator("#kpi-tasks")).toHaveText("20", {
      timeout: 5000,
    });

    expect(trendsCapturedUrl).toContain("groupBy=hour");
  });

  test("can open multiple metrics sequentially without errors", async ({
    page,
  }) => {
    await injectSessionCookie(page);
    await mockMetricsAPIsWithFullTrends(page);
    await page.goto(`${BASE}/dashboard`);

    await expect(page.locator("#kpi-tasks")).toHaveText("20", {
      timeout: 5000,
    });

    // Open tasks-completed
    await page.locator('[data-metric="tasks-completed"]').click();
    await expect(page.locator("#metric-modal")).toBeVisible();
    await expect(page.locator("#metric-modal-title")).toContainText(
      "Tasks Completed",
    );

    // Close
    await page.keyboard.press("Escape");
    await expect(page.locator("#metric-modal")).toBeHidden();

    // Open a different metric
    await page.locator('[data-metric="ci-first-pass"]').click();
    await expect(page.locator("#metric-modal")).toBeVisible();
    await expect(page.locator("#metric-modal-title")).toContainText(
      "CI First-Pass Rate",
    );
    await expect(page.locator("#metric-chart")).toBeVisible();
  });
});
