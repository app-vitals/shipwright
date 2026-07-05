/**
 * metrics/src/dashboard/dashboard-page.test.ts
 * Snapshot tests for renderDashboardPage.
 *
 * To regenerate snapshots after intentional template changes:
 *   bun test --update-snapshots metrics/src/dashboard/dashboard-page.test.ts
 */

import { describe, expect, test } from "bun:test";
import {
  type DashboardPageOptions,
  renderDashboardPage,
} from "./dashboard-page.ts";

const BASE_OPTS: DashboardPageOptions = {
  userName: "Alice",
};

describe("renderDashboardPage — snapshot", () => {
  test("renders full page for a regular user", () => {
    const html = renderDashboardPage(BASE_OPTS);
    expect(html).toMatchSnapshot();
  });

  test("renders full page for an owner", () => {
    const html = renderDashboardPage({ ...BASE_OPTS, isOwner: true });
    expect(html).toMatchSnapshot();
  });
});

describe("renderDashboardPage — structural invariants", () => {
  test("returns a valid HTML document", () => {
    const html = renderDashboardPage(BASE_OPTS);
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("<html");
    expect(html).toContain("</html>");
  });

  test("includes the page title", () => {
    const html = renderDashboardPage(BASE_OPTS);
    expect(html).toContain("Metrics — Vitals OS");
  });

  test("includes the user name in the toolbar", () => {
    const html = renderDashboardPage({ userName: "Bob" });
    expect(html).toContain("Bob");
  });

  test("includes KPI card structure", () => {
    const html = renderDashboardPage(BASE_OPTS);
    expect(html).toContain("kpi-card");
    expect(html).toContain("Tasks Completed");
    expect(html).toContain("CI First-Pass Rate");
  });

  test("includes pipeline queue section", () => {
    const html = renderDashboardPage(BASE_OPTS);
    expect(html).toContain("Pipeline Queue");
  });

  test("includes feature breakdown table", () => {
    const html = renderDashboardPage(BASE_OPTS);
    expect(html).toContain("Feature Breakdown");
    expect(html).toContain("features-table");
  });
});

describe("renderDashboardPage — Token Usage section", () => {
  test("includes Token Usage section heading", () => {
    const html = renderDashboardPage(BASE_OPTS);
    expect(html).toContain("Token Usage");
  });

  test("includes token KPI card elements", () => {
    const html = renderDashboardPage(BASE_OPTS);
    expect(html).toContain('id="token-input"');
    expect(html).toContain('id="token-output"');
    expect(html).toContain('id="token-cache"');
  });

  test("does not include session type breakdown table", () => {
    const html = renderDashboardPage(BASE_OPTS);
    expect(html).not.toContain('id="token-session-table"');
    expect(html).not.toContain('id="token-session-tbody"');
  });

  test("includes agent breakdown table", () => {
    const html = renderDashboardPage(BASE_OPTS);
    expect(html).toContain('id="token-agent-table"');
    expect(html).toContain('id="token-agent-tbody"');
  });
});

describe("renderDashboardPage — info icons: present in every section", () => {
  test("Overview KPIs section has at least one info icon", () => {
    const html = renderDashboardPage(BASE_OPTS);
    const overviewSection = html.slice(
      html.indexOf('aria-label="Key performance indicators"'),
      html.indexOf('aria-label="Pipeline queue"'),
    );
    expect(overviewSection).toContain('class="info-icon"');
  });

  test("Pipeline Queue section has at least one info icon", () => {
    const html = renderDashboardPage(BASE_OPTS);
    const queueSection = html.slice(
      html.indexOf('aria-label="Pipeline queue"'),
      html.indexOf('aria-label="Pipeline quality"'),
    );
    expect(queueSection).toContain('class="info-icon"');
  });

  test("Pipeline Quality section has at least one info icon", () => {
    const html = renderDashboardPage(BASE_OPTS);
    const qualitySection = html.slice(
      html.indexOf('aria-label="Pipeline quality"'),
      html.indexOf('aria-label="Feature breakdown"'),
    );
    expect(qualitySection).toContain('class="info-icon"');
  });

  test("Feature Breakdown section has at least one info icon", () => {
    const html = renderDashboardPage(BASE_OPTS);
    const featuresSection = html.slice(
      html.indexOf('aria-label="Feature breakdown"'),
      html.indexOf('aria-label="Efficiency"'),
    );
    expect(featuresSection).toContain('class="info-icon"');
  });

  test("Efficiency section has at least one info icon", () => {
    const html = renderDashboardPage(BASE_OPTS);
    const efficiencySection = html.slice(
      html.indexOf('aria-label="Efficiency"'),
      html.indexOf('aria-label="Trends"'),
    );
    expect(efficiencySection).toContain('class="info-icon"');
  });
});

describe("renderDashboardPage — MG-1.2 clickable metrics: data-metric attributes", () => {
  test("tasks-started stat-row has data-metric attribute", () => {
    const html = renderDashboardPage(BASE_OPTS);
    expect(html).toContain('data-metric="tasks-started"');
  });

  test("tasks-blocked stat-row has data-metric attribute", () => {
    const html = renderDashboardPage(BASE_OPTS);
    expect(html).toContain('data-metric="tasks-blocked"');
  });

  test("ci-gates stat-row has data-metric attribute", () => {
    const html = renderDashboardPage(BASE_OPTS);
    expect(html).toContain('data-metric="ci-gates"');
  });

  test("simplify-total stat-row has data-metric attribute", () => {
    const html = renderDashboardPage(BASE_OPTS);
    expect(html).toContain('data-metric="simplify-total"');
  });

  test("avg-actual-hours efficiency stat-block has data-metric attribute", () => {
    const html = renderDashboardPage(BASE_OPTS);
    expect(html).toContain('data-metric="avg-actual-hours"');
  });

  test("avg-cycle-time stat-row has data-metric attribute", () => {
    const html = renderDashboardPage(BASE_OPTS);
    expect(html).toContain('data-metric="avg-cycle-time"');
  });

  test("block-rate stat-row has data-metric attribute", () => {
    const html = renderDashboardPage(BASE_OPTS);
    expect(html).toContain('data-metric="block-rate"');
  });

  test("avg-review-findings stat-row has data-metric attribute", () => {
    const html = renderDashboardPage(BASE_OPTS);
    expect(html).toContain('data-metric="avg-review-findings"');
  });

  test("ci-first-pass-count stat-row has data-metric attribute", () => {
    const html = renderDashboardPage(BASE_OPTS);
    expect(html).toContain('data-metric="ci-first-pass-count"');
  });

  test("avg-fix-attempts stat-row has data-metric attribute", () => {
    const html = renderDashboardPage(BASE_OPTS);
    expect(html).toContain('data-metric="avg-fix-attempts"');
  });

  test("simplify bar-items have data-metric attributes", () => {
    const html = renderDashboardPage(BASE_OPTS);
    expect(html).toContain('data-metric="simplify-dry"');
    expect(html).toContain('data-metric="simplify-dead"');
    expect(html).toContain('data-metric="simplify-naming"');
    expect(html).toContain('data-metric="simplify-complexity"');
    expect(html).toContain('data-metric="simplify-consistency"');
  });

  test("reviews-total and reviews-ship-it stat-rows have data-metric attributes", () => {
    const html = renderDashboardPage(BASE_OPTS);
    expect(html).toContain('data-metric="reviews-total"');
    expect(html).toContain('data-metric="reviews-ship-it"');
  });

  test("review-iterations stat-row is labeled honestly as an iteration proxy", () => {
    const html = renderDashboardPage(BASE_OPTS);
    expect(html).toContain('data-metric="review-iterations"');
    expect(html).toContain("Review Iterations");
    const iterationsRow = html
      .split('data-metric="review-iterations"')[1]
      ?.split("</div>")[0];
    expect(iterationsRow).not.toContain("Findings");
  });

  test("efficiency stat-blocks have data-metric attributes", () => {
    const html = renderDashboardPage(BASE_OPTS);
    expect(html).toContain('data-metric="avg-estimated-hours"');
    expect(html).toContain('data-metric="avg-retries"');
    expect(html).toContain('data-metric="avg-files-changed"');
  });
});

describe("renderDashboardPage — MG-1.2 modal scaffold", () => {
  test("includes the metric modal container with correct id", () => {
    const html = renderDashboardPage(BASE_OPTS);
    expect(html).toContain('id="metric-modal"');
  });

  test("includes the metric-chart canvas", () => {
    const html = renderDashboardPage(BASE_OPTS);
    expect(html).toContain('id="metric-chart"');
  });

  test("includes the metric-modal-title element", () => {
    const html = renderDashboardPage(BASE_OPTS);
    expect(html).toContain('id="metric-modal-title"');
  });

  test("includes the metric-modal-backdrop element", () => {
    const html = renderDashboardPage(BASE_OPTS);
    expect(html).toContain('class="metric-modal-backdrop"');
  });

  test("modal has hidden attribute by default", () => {
    const html = renderDashboardPage(BASE_OPTS);
    // The modal element should include the hidden attribute on the same opening tag
    expect(html).toContain(
      'id="metric-modal" class="metric-modal" role="dialog" aria-modal="true" aria-labelledby="metric-modal-title" hidden',
    );
  });

  test("modal has role=dialog for accessibility", () => {
    const html = renderDashboardPage(BASE_OPTS);
    expect(html).toContain('role="dialog"');
  });

  test("modal has close button", () => {
    const html = renderDashboardPage(BASE_OPTS);
    expect(html).toContain('class="metric-modal-close"');
  });
});

describe("renderDashboardPage — info icons: approved copy", () => {
  test("Tasks Completed has the approved tooltip text", () => {
    const html = renderDashboardPage(BASE_OPTS);
    expect(html).toContain(
      'data-tooltip="Total tasks shipped as merged PRs in the selected period"',
    );
  });

  test("Avg cycle time has the approved tooltip text", () => {
    const html = renderDashboardPage(BASE_OPTS);
    expect(html).toContain(
      'data-tooltip="Mean wall-clock hours from task start to PR merge"',
    );
  });

  test("Total fixes has the approved tooltip text", () => {
    const html = renderDashboardPage(BASE_OPTS);
    expect(html).toContain(
      'data-tooltip="Code simplifications applied automatically after implementation"',
    );
  });

  test("Avg actual hours has the approved tooltip text", () => {
    const html = renderDashboardPage(BASE_OPTS);
    expect(html).toContain(
      'data-tooltip="Mean wall-clock hours per task from start to PR merge"',
    );
  });
});

describe("renderDashboardPage — TK-1.1 token table columns", () => {
  test("agent table does not have Input or Output column headers (replaced by Cron/DM)", () => {
    const html = renderDashboardPage(BASE_OPTS);
    const tokenSection = html.slice(
      html.indexOf('aria-label="Token usage"'),
      html.indexOf('aria-label="Feature breakdown"'),
    );
    const agentTable = tokenSection.slice(
      tokenSection.indexOf('id="token-agent-table"'),
    );
    expect(agentTable).not.toContain("<th>Input</th>");
    expect(agentTable).not.toContain("<th>Output</th>");
  });

  test("agent table Total column is labeled 'Total' not 'Total Tokens'", () => {
    const html = renderDashboardPage(BASE_OPTS);
    const tokenSection = html.slice(
      html.indexOf('aria-label="Token usage"'),
      html.indexOf('aria-label="Feature breakdown"'),
    );
    const agentTable = tokenSection.slice(
      tokenSection.indexOf('id="token-agent-table"'),
    );
    expect(agentTable).not.toContain("<th>Total Tokens</th>");
    expect(agentTable).toContain("<th>Total</th>");
  });
});

describe("renderDashboardPage — MG-1.2 clickable metric graphs", () => {
  test("includes modal container markup", () => {
    const html = renderDashboardPage(BASE_OPTS);
    expect(html).toContain('id="metric-modal"');
    expect(html).toContain('class="metric-modal"');
    expect(html).toContain('id="metric-chart"');
    expect(html).toContain('class="metric-modal-close"');
  });

  test("KPI cards have data-metric attributes", () => {
    const html = renderDashboardPage(BASE_OPTS);
    // Overview KPI cards
    expect(html).toContain('data-metric="tasks-completed"');
    expect(html).toContain('data-metric="ci-first-pass"');
    expect(html).toContain('data-metric="estimation-accuracy"');
    expect(html).toContain('data-metric="review-ship-it"');
  });

  test("stat-row values have data-metric attributes", () => {
    const html = renderDashboardPage(BASE_OPTS);
    // Queue throughput (only graphable scalars get data-metric; approved/merged excluded)
    expect(html).toContain('data-metric="tasks-started"');
    expect(html).toContain('data-metric="tasks-blocked"');
    // Queue pipeline
    expect(html).toContain('data-metric="avg-cycle-time"');
    expect(html).toContain('data-metric="block-rate"');
    expect(html).toContain('data-metric="avg-review-findings"');
    // CI Gates
    expect(html).toContain('data-metric="ci-gates"');
    expect(html).toContain('data-metric="ci-first-pass-count"');
    expect(html).toContain('data-metric="avg-fix-attempts"');
    // Reviews
    expect(html).toContain('data-metric="reviews-total"');
    expect(html).toContain('data-metric="reviews-ship-it"');
    // Simplify
    expect(html).toContain('data-metric="simplify-total"');
    // Excluded: queue-approved, queue-merged (no backend time-series)
    expect(html).not.toContain('data-metric="queue-approved"');
    expect(html).not.toContain('data-metric="queue-merged"');
  });

  test("efficiency stat-blocks have data-metric attributes", () => {
    const html = renderDashboardPage(BASE_OPTS);
    expect(html).toContain('data-metric="avg-actual-hours"');
    expect(html).toContain('data-metric="avg-estimated-hours"');
    expect(html).toContain('data-metric="avg-retries"');
    expect(html).toContain('data-metric="avg-files-changed"');
  });

  test("token KPI cards have data-metric attributes", () => {
    const html = renderDashboardPage(BASE_OPTS);
    expect(html).toContain('data-metric="token-input"');
    expect(html).toContain('data-metric="token-output"');
    expect(html).toContain('data-metric="token-cache"');
  });

  test("simplify category bar-vals have data-metric attributes", () => {
    const html = renderDashboardPage(BASE_OPTS);
    expect(html).toContain('data-metric="simplify-dry"');
    expect(html).toContain('data-metric="simplify-dead"');
    expect(html).toContain('data-metric="simplify-naming"');
    expect(html).toContain('data-metric="simplify-complexity"');
    expect(html).toContain('data-metric="simplify-consistency"');
  });

  test("Coverage metrics do NOT have data-metric attributes", () => {
    const html = renderDashboardPage(BASE_OPTS);
    expect(html).not.toContain('data-metric="coverage-reports"');
    expect(html).not.toContain('data-metric="coverage-delta"');
  });

  test("snapshot matches after MG-1.2 changes", () => {
    const html = renderDashboardPage(BASE_OPTS);
    expect(html).toMatchSnapshot();
  });
});

describe("renderDashboardPage — CCT-2.2 cost KPI and table columns", () => {
  test("Total Cost KPI card heading is present", () => {
    const html = renderDashboardPage(BASE_OPTS);
    expect(html).toContain("Total Cost");
  });

  test("session type table is absent (removed in ATB-2.2)", () => {
    const html = renderDashboardPage(BASE_OPTS);
    expect(html).not.toContain('id="token-session-table"');
  });

  test("agent table has Cost ($) column header", () => {
    const html = renderDashboardPage(BASE_OPTS);
    const tokenStart = html.indexOf('aria-label="Token usage"');
    const tokenEnd = html.indexOf("</section>", tokenStart);
    const tokenSection = html.slice(tokenStart, tokenEnd);
    const agentTable = tokenSection.slice(
      tokenSection.indexOf('id="token-agent-table"'),
    );
    expect(agentTable).toContain("<th>Cost ($)</th>");
  });

  test("Total Cost KPI card has id token-cost", () => {
    const html = renderDashboardPage(BASE_OPTS);
    expect(html).toContain('id="token-cost"');
  });
});

describe("renderDashboardPage — adminBaseUrl cross-origin nav (local stack)", () => {
  test("admin nav links are absolute when adminBaseUrl is set", () => {
    const html = renderDashboardPage({
      userName: "Alice",
      adminBaseUrl: "http://localhost:3001",
    });
    expect(html).toContain('href="http://localhost:3001/admin/agents"');
    expect(html).toContain('href="http://localhost:3001/admin/tasks?state=ready"');
    expect(html).toContain('href="http://localhost:3001/admin/prs"');
  });

  test("admin nav links stay relative when adminBaseUrl is omitted (prod default unchanged)", () => {
    const html = renderDashboardPage({ userName: "Alice" });
    expect(html).toContain('href="/admin/agents"');
    expect(html).not.toContain('href="http://localhost:3001/admin/agents"');
  });

  test("the Metrics link stays same-origin even when adminBaseUrl is set", () => {
    const html = renderDashboardPage({
      userName: "Alice",
      adminBaseUrl: "http://localhost:3001",
    });
    // Metrics points back at this service's own /dashboard, not the admin host.
    expect(html).toContain('href="/dashboard"');
  });
});

describe("renderDashboardPage — basePath", () => {
  test("sets window.__METRICS_BASE__ to the provided basePath", () => {
    const html = renderDashboardPage({ userName: "Alice", basePath: "/sw" });
    expect(html).toContain('window.__METRICS_BASE__ = "/sw";');
  });

  test("prefixes the stylesheet href with basePath", () => {
    const html = renderDashboardPage({ userName: "Alice", basePath: "/sw" });
    expect(html).toContain('href="/sw/dashboard/styles.css"');
  });

  test("prefixes the app script src with basePath", () => {
    const html = renderDashboardPage({ userName: "Alice", basePath: "/sw" });
    expect(html).toContain('src="/sw/dashboard/app.js"');
  });
});

describe("renderDashboardPage — ATB-2.2 hierarchical token breakdown", () => {
  test("By Session Type panel is removed", () => {
    const html = renderDashboardPage(BASE_OPTS);
    expect(html).not.toContain("By Session Type");
  });

  test("agent table has Agent Cron DM/Mention Total Cost columns", () => {
    const html = renderDashboardPage(BASE_OPTS);
    const tokenStart = html.indexOf('aria-label="Token usage"');
    const tokenEnd = html.indexOf("</section>", tokenStart);
    const tokenSection = html.slice(tokenStart, tokenEnd);
    const agentTable = tokenSection.slice(
      tokenSection.indexOf('id="token-agent-table"'),
    );
    expect(agentTable).toContain("<th>Agent</th>");
    expect(agentTable).toContain("<th>Cron</th>");
    expect(agentTable).toContain("<th>DM/Mention</th>");
    expect(agentTable).toContain("<th>Total</th>");
    expect(agentTable).toContain("<th>Cost ($)</th>");
  });
});

describe("renderDashboardPage — TK-1.2 token trends chart", () => {
  test("includes token trends chart canvas in Token Usage section", () => {
    const html = renderDashboardPage(BASE_OPTS);
    expect(html).toContain('id="token-trends-chart"');
  });

  test("includes token trends toggle button for Input", () => {
    const html = renderDashboardPage(BASE_OPTS);
    expect(html).toContain('data-token-series="input"');
  });

  test("includes token trends toggle button for Output", () => {
    const html = renderDashboardPage(BASE_OPTS);
    expect(html).toContain('data-token-series="output"');
  });

  test("includes token trends toggle button for Total", () => {
    const html = renderDashboardPage(BASE_OPTS);
    expect(html).toContain('data-token-series="total"');
  });

  test("includes token trends toggle button for All", () => {
    const html = renderDashboardPage(BASE_OPTS);
    expect(html).toContain('data-token-series="all"');
  });

  test("token trends chart container is inside the Token Usage section", () => {
    const html = renderDashboardPage(BASE_OPTS);
    const tokenStart = html.indexOf('aria-label="Token usage"');
    const tokenEnd = html.indexOf("</section>", tokenStart);
    const tokenSection = html.slice(tokenStart, tokenEnd);
    expect(tokenSection).toContain('id="token-trends-chart"');
  });

  test("token trends toggle buttons are inside the Token Usage section", () => {
    const html = renderDashboardPage(BASE_OPTS);
    const tokenStart = html.indexOf('aria-label="Token usage"');
    const tokenEnd = html.indexOf("</section>", tokenStart);
    const tokenSection = html.slice(tokenStart, tokenEnd);
    expect(tokenSection).toContain('data-token-series="input"');
    expect(tokenSection).toContain('data-token-series="output"');
    expect(tokenSection).toContain('data-token-series="total"');
    expect(tokenSection).toContain('data-token-series="all"');
  });

  test("snapshot matches after TK-1.2 changes", () => {
    const html = renderDashboardPage(BASE_OPTS);
    expect(html).toMatchSnapshot();
  });
});

describe("renderDashboardPage — PCE-1.4 Cost Efficiency card", () => {
  test("renders Cost Efficiency section when readOnly: true", () => {
    const html = renderDashboardPage({ userName: "Public", readOnly: true });
    expect(html).toContain('id="cost-efficiency-section"');
    expect(html).toContain("Cost Efficiency");
  });

  test("does NOT render Cost Efficiency section when readOnly: false (default)", () => {
    const html = renderDashboardPage({ userName: "Alice" });
    expect(html).not.toContain('id="cost-efficiency-section"');
  });

  test("does NOT render Cost Efficiency section when readOnly is explicitly false", () => {
    const html = renderDashboardPage({ userName: "Alice", readOnly: false });
    expect(html).not.toContain('id="cost-efficiency-section"');
  });

  test("Cost Efficiency section contains model-mix bar", () => {
    const html = renderDashboardPage({ userName: "Public", readOnly: true });
    expect(html).toContain('class="model-mix-bar"');
  });

  test("Cost Efficiency section contains savings line elements", () => {
    const html = renderDashboardPage({ userName: "Public", readOnly: true });
    expect(html).toContain('id="ce-savings-line"');
  });

  test("Cost Efficiency section contains the static caveat", () => {
    const html = renderDashboardPage({ userName: "Public", readOnly: true });
    expect(html).toContain("all-Opus assumes identical token counts");
  });

  test("readOnly page snapshot matches", () => {
    const html = renderDashboardPage({ userName: "Public", readOnly: true });
    expect(html).toMatchSnapshot();
  });
});

describe("renderDashboardPage — PPL-1.2 readOnly variant", () => {
  const html = renderDashboardPage({
    userName: "Public",
    isOwner: false,
    readOnly: true,
  });

  test("omits the Token Usage section and by-agent table", () => {
    expect(html).not.toContain("Token Usage");
    expect(html).not.toContain('id="token-agent-table"');
    expect(html).not.toContain('id="token-input"');
  });

  test("keeps the pipeline KPI cards", () => {
    expect(html).toContain("Tasks Completed");
    expect(html).toContain("CI First-Pass Rate");
    expect(html).toContain("Estimation Accuracy");
    expect(html).toContain("Review SHIP IT Rate");
  });

  test("keeps the pipeline metric panels", () => {
    expect(html).toContain("Pipeline Queue");
    expect(html).toContain("Pipeline Quality");
    expect(html).toContain("Feature Breakdown");
    expect(html).toContain("Trends");
  });

  test("default (readOnly unset) still renders the Token Usage section", () => {
    const full = renderDashboardPage(BASE_OPTS);
    expect(full).toContain("Token Usage");
    expect(full).toContain('id="token-agent-table"');
  });
});
