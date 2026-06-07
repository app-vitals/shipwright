/**
 * metrics/src/dashboard/dashboard-page.ts
 * Server-rendered HTML for the Shipwright metrics dashboard.
 * Uses the shared Vitals OS toolbar and light theme.
 */

import { baseStyles, renderToolbar } from "../lib/web/toolbar.ts";

export interface DashboardPageOptions {
  userName: string;
  isOwner?: boolean;
}

function infoIcon(tip: string): string {
  return `<span class="info-icon" data-tooltip="${tip}" tabindex="0" aria-label="${tip}">i</span>`;
}

export function renderDashboardPage(opts: DashboardPageOptions): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Metrics — Vitals OS</title>
  <style>${baseStyles()}</style>
  <link rel="stylesheet" href="/dashboard/styles.css" />
</head>
<body>
  ${renderToolbar({ userName: opts.userName, activePage: "metrics", isOwner: opts.isOwner })}
  <div class="app">

    <!-- Page Controls -->
    <div class="page-controls">
      <div class="date-range-picker" role="group" aria-label="Date range">
        <button class="date-btn active" data-range="today" type="button">1D</button>
        <button class="date-btn" data-range="7d" type="button">7D</button>
        <button class="date-btn" data-range="30d" type="button">30D</button>
        <button class="date-btn" data-range="90d" type="button">90D</button>
      </div>
      <div class="page-meta">
        <span id="freshness-indicator" class="freshness" aria-live="polite"></span>
        <span id="refresh-countdown" class="countdown" aria-live="polite"></span>
      </div>
    </div>

    <!-- Main -->
    <main class="main">

      <!-- KPI Cards -->
      <section class="section" aria-label="Key performance indicators">
        <div class="section-header">
          <h2 class="section-title">Overview</h2>
          <span class="section-badge" id="task-count-badge">0 tasks</span>
        </div>
        <div class="kpi-grid">
          <div class="kpi-card" data-metric="tasks-completed">
            <div class="kpi-label">Tasks Completed${infoIcon("Total tasks shipped as merged PRs in the selected period")}</div>
            <div class="kpi-value" id="kpi-tasks"><span class="skeleton">&nbsp;</span></div>
            <div class="kpi-meta">shipwright_task_completed events</div>
          </div>
          <div class="kpi-card" data-metric="ci-first-pass">
            <div class="kpi-label">CI First-Pass Rate${infoIcon("% of CI gate runs that passed without any fix attempts")}</div>
            <div class="kpi-value" id="kpi-ci-rate"><span class="skeleton">&nbsp;</span></div>
            <div class="kpi-meta">passed_first_try / total gates</div>
          </div>
          <div class="kpi-card" data-metric="estimation-accuracy">
            <div class="kpi-label">Estimation Accuracy${infoIcon("How close estimated hours are to actual — 0% is perfect")}</div>
            <div class="kpi-value" id="kpi-estimation"><span class="skeleton">&nbsp;</span></div>
            <div class="kpi-meta">mean (actual_h / estimated_h - 1)</div>
          </div>
          <div class="kpi-card" data-metric="review-ship-it">
            <div class="kpi-label">Review SHIP IT Rate${infoIcon("% of code reviews that received an immediate ship-it verdict")}</div>
            <div class="kpi-value" id="kpi-review-rate"><span class="skeleton">&nbsp;</span></div>
            <div class="kpi-meta">SHIP IT / total reviews</div>
          </div>
        </div>
      </section>

      <!-- Pipeline Queue -->
      <section class="section" aria-label="Pipeline queue">
        <div class="section-header">
          <h2 class="section-title">Pipeline Queue</h2>
        </div>
        <div class="queue-grid">

          <!-- Throughput -->
          <div class="quality-panel">
            <h3 class="panel-title">Throughput</h3>
            <div class="stat-row" data-metric="tasks-started">
              <span class="stat-label">Started${infoIcon("Tasks that moved from pending to in_progress in the period")}</span>
              <span class="stat-value" id="queue-started">--</span>
            </div>
            <div class="stat-row">
              <span class="stat-label">Approved${infoIcon("PRs that received a SHIP IT review verdict")}</span>
              <span class="stat-value" id="queue-approved">--</span>
            </div>
            <div class="stat-row">
              <span class="stat-label">Merged${infoIcon("PRs merged to main in the selected period")}</span>
              <span class="stat-value" id="queue-merged">--</span>
            </div>
            <div class="stat-row" data-metric="tasks-blocked">
              <span class="stat-label">Blocked${infoIcon("Tasks stuck on a human-blocking issue")}</span>
              <span class="stat-value" id="queue-blocked">--</span>
            </div>
          </div>

          <!-- Cycle Time -->
          <div class="quality-panel">
            <h3 class="panel-title">Cycle Time</h3>
            <div class="stat-row" data-metric="avg-cycle-time">
              <span class="stat-label">Avg cycle time${infoIcon("Mean wall-clock hours from task start to PR merge")}</span>
              <span class="stat-value" id="queue-cycle-time">--</span>
            </div>
          </div>

          <!-- Block Rate -->
          <div class="quality-panel">
            <h3 class="panel-title">Block Rate</h3>
            <div class="stat-row" data-metric="block-rate">
              <span class="stat-label">Rate${infoIcon("% of started tasks that ended up in a blocked state")}</span>
              <span class="stat-value" id="queue-block-rate">--%</span>
            </div>
          </div>

          <!-- Review Findings -->
          <div class="quality-panel">
            <h3 class="panel-title">Review Findings</h3>
            <div class="stat-row" data-metric="avg-review-findings">
              <span class="stat-label">Avg per task${infoIcon("Mean number of review findings (bugs/suggestions) per task")}</span>
              <span class="stat-value" id="queue-review-findings">--</span>
            </div>
          </div>

        </div>
      </section>

      <!-- Pipeline Quality -->
      <section class="section" aria-label="Pipeline quality">
        <div class="section-header">
          <h2 class="section-title">Pipeline Quality</h2>
        </div>
        <div class="quality-grid">

          <!-- CI Gates -->
          <div class="quality-panel">
            <h3 class="panel-title">CI Gates</h3>
            <div class="stat-row" data-metric="ci-gates">
              <span class="stat-label">Total gates${infoIcon("Total CI runs triggered by PRs in the period")}</span>
              <span class="stat-value" id="ci-total">--</span>
            </div>
            <div class="stat-row" data-metric="ci-first-pass-count">
              <span class="stat-label">First-pass${infoIcon("CI runs that passed without any fix commits")}</span>
              <span class="stat-value" id="ci-first">--</span>
            </div>
            <div class="stat-row" data-metric="avg-fix-attempts">
              <span class="stat-label">Avg fix attempts${infoIcon("Mean number of fix commits needed before CI passed")}</span>
              <span class="stat-value" id="ci-fix-avg">--</span>
            </div>
          </div>

          <!-- Simplify -->
          <div class="quality-panel">
            <h3 class="panel-title">Simplify Fixes</h3>
            <div class="stat-row" data-metric="simplify-total">
              <span class="stat-label">Total fixes${infoIcon("Code simplifications applied automatically after implementation")}</span>
              <span class="stat-value" id="simplify-total">--</span>
            </div>
            <div class="simplify-breakdown" id="simplify-breakdown">
              <div class="bar-item" data-metric="simplify-dry"><span class="bar-label">DRY${infoIcon("Duplicated code extractions applied")}</span><div class="bar-track"><div class="bar-fill" id="bar-dry"></div></div><span class="bar-val" id="val-dry">--</span></div>
              <div class="bar-item" data-metric="simplify-dead"><span class="bar-label">Dead code${infoIcon("Unused imports, variables, or functions removed")}</span><div class="bar-track"><div class="bar-fill" id="bar-dead"></div></div><span class="bar-val" id="val-dead">--</span></div>
              <div class="bar-item" data-metric="simplify-naming"><span class="bar-label">Naming${infoIcon("Variable and function name improvements applied")}</span><div class="bar-track"><div class="bar-fill" id="bar-naming"></div></div><span class="bar-val" id="val-naming">--</span></div>
              <div class="bar-item" data-metric="simplify-complexity"><span class="bar-label">Complexity${infoIcon("Over-engineered patterns simplified")}</span><div class="bar-track"><div class="bar-fill" id="bar-complexity"></div></div><span class="bar-val" id="val-complexity">--</span></div>
              <div class="bar-item" data-metric="simplify-consistency"><span class="bar-label">Consistency${infoIcon("Style or pattern inconsistencies corrected")}</span><div class="bar-track"><div class="bar-fill" id="bar-consistency"></div></div><span class="bar-val" id="val-consistency">--</span></div>
            </div>
          </div>

          <!-- Reviews -->
          <div class="quality-panel">
            <h3 class="panel-title">Reviews</h3>
            <div class="stat-row" data-metric="reviews-total">
              <span class="stat-label">Total reviews${infoIcon("Code reviews run by the shipwright review agent")}</span>
              <span class="stat-value" id="review-total">--</span>
            </div>
            <div class="stat-row" data-metric="reviews-ship-it">
              <span class="stat-label">SHIP IT${infoIcon("Reviews where no blocking issues were found")}</span>
              <span class="stat-value good" id="review-ship-it">--</span>
            </div>
          </div>

          <!-- Coverage -->
          <div class="quality-panel">
            <h3 class="panel-title">Coverage</h3>
            <div class="stat-row">
              <span class="stat-label">Reports${infoIcon("Tasks with a measured coverage delta")}</span>
              <span class="stat-value" id="coverage-reports">--</span>
            </div>
            <div class="stat-row">
              <span class="stat-label">Avg delta${infoIcon("Mean change in line coverage % across all reports")}</span>
              <span class="stat-value" id="coverage-delta">--</span>
            </div>
          </div>

        </div>
      </section>

      <!-- Token Usage -->
      <section class="section" aria-label="Token usage">
        <div class="section-header">
          <h2 class="section-title">Token Usage</h2>
        </div>
        <div class="token-kpi-row">
          <div class="kpi-card" data-metric="token-input">
            <div class="kpi-label">Input Tokens</div>
            <div class="kpi-value" id="token-input"><span class="skeleton">&nbsp;</span></div>
            <div class="kpi-meta">total input tokens</div>
          </div>
          <div class="kpi-card" data-metric="token-output">
            <div class="kpi-label">Output Tokens</div>
            <div class="kpi-value" id="token-output"><span class="skeleton">&nbsp;</span></div>
            <div class="kpi-meta">total output tokens</div>
          </div>
          <div class="kpi-card" data-metric="token-cache">
            <div class="kpi-label">Cache Tokens</div>
            <div class="kpi-value" id="token-cache"><span class="skeleton">&nbsp;</span></div>
            <div class="kpi-meta">cache read + creation</div>
          </div>
        </div>
        <div class="token-breakdown-grid">
          <div class="quality-panel">
            <h3 class="panel-title">By Session Type</h3>
            <table class="token-table" id="token-session-table">
              <thead>
                <tr><th>Session Type</th><th>Input</th><th>Output</th><th>Total</th></tr>
              </thead>
              <tbody id="token-session-tbody"></tbody>
            </table>
            <p id="token-session-empty" class="empty-state" style="display:none">No data</p>
          </div>
          <div class="quality-panel">
            <h3 class="panel-title">By Agent</h3>
            <table class="token-table" id="token-agent-table">
              <thead>
                <tr><th>Agent</th><th>Input</th><th>Output</th><th>Total</th></tr>
              </thead>
              <tbody id="token-agent-tbody"></tbody>
            </table>
            <p id="token-agent-empty" class="empty-state" style="display:none">No data</p>
          </div>
        </div>
        <div class="token-trends-section">
          <div class="token-trends-toggles" role="group" aria-label="Token series">
            <button class="token-series-btn active" data-token-series="input" type="button">Input</button>
            <button class="token-series-btn" data-token-series="output" type="button">Output</button>
            <button class="token-series-btn" data-token-series="total" type="button">Total</button>
            <button class="token-series-btn" data-token-series="all" type="button">All</button>
          </div>
          <div class="chart-container token-trends-chart-container">
            <canvas id="token-trends-chart" aria-label="Token usage trends chart"></canvas>
          </div>
        </div>
      </section>

      <!-- Feature Breakdown -->
      <section class="section features-section" aria-label="Feature breakdown">
        <div class="section-header">
          <h2 class="section-title">Feature Breakdown</h2>
        </div>
        <div class="features-table-wrapper">
          <table class="features-table">
            <thead>
              <tr>
                <th>Feature${infoIcon("Planning session or feature group name")}</th>
                <th>Tasks${infoIcon("Number of tasks shipped in this feature")}</th>
                <th>Avg Hrs${infoIcon("Mean actual hours per task")}</th>
                <th>CI Pass${infoIcon("CI first-pass rate for this feature's tasks")}</th>
                <th>Review${infoIcon("SHIP IT rate for this feature's tasks")}</th>
              </tr>
            </thead>
            <tbody id="features-tbody"></tbody>
          </table>
        </div>
        <p id="features-empty" class="empty-state" style="display:none">No feature data for this period</p>
      </section>

      <!-- Efficiency -->
      <section class="section" aria-label="Efficiency">
        <div class="section-header">
          <h2 class="section-title">Efficiency</h2>
        </div>
        <div class="efficiency-grid">
          <div class="stat-block" data-metric="avg-actual-hours">
            <span class="stat-block-value" id="eff-avg-hours">--</span>
            <span class="stat-block-label">Avg actual hours${infoIcon("Mean wall-clock hours per task from start to PR merge")}</span>
          </div>
          <div class="stat-block" data-metric="avg-estimated-hours">
            <span class="stat-block-value" id="eff-est-hours">--</span>
            <span class="stat-block-label">Avg estimated hours${infoIcon("Mean planned hours per task from the planning doc")}</span>
          </div>
          <div class="stat-block" data-metric="avg-retries">
            <span class="stat-block-value" id="eff-retries">--</span>
            <span class="stat-block-label">Avg retries${infoIcon("Mean CI fix attempts needed before the CI gate passed")}</span>
          </div>
          <div class="stat-block" data-metric="avg-files-changed">
            <span class="stat-block-value" id="eff-files">--</span>
            <span class="stat-block-label">Avg files changed${infoIcon("Mean files modified per task")}</span>
          </div>
        </div>
      </section>

      <!-- Trends -->
      <section class="section" aria-label="Trends">
        <div class="section-header">
          <h2 class="section-title">Trends</h2>
        </div>
        <div class="chart-container">
          <canvas id="trends-chart" aria-label="Pipeline trends chart"></canvas>
        </div>
      </section>

    </main>

    <!-- Metric Graph Modal -->
    <div id="metric-modal" class="metric-modal" role="dialog" aria-modal="true" aria-labelledby="metric-modal-title" hidden>
      <div class="metric-modal-backdrop"></div>
      <div class="metric-modal-box">
        <div class="metric-modal-header">
          <h3 class="metric-modal-title" id="metric-modal-title">Metric</h3>
          <button class="metric-modal-close" type="button" aria-label="Close modal">×</button>
        </div>
        <div class="metric-modal-body">
          <canvas id="metric-chart" aria-label="Metric trend chart"></canvas>
        </div>
      </div>
    </div>

  </div>

  <script src="https://cdn.jsdelivr.net/npm/chart.js@4/dist/chart.umd.min.js"></script>
  <script src="/dashboard/app.js"></script>
</body>
</html>`;
}
