/**
 * app.js — Shipwright Metrics Dashboard
 * Single JS file: data fetching, KPI updates, chart rendering, date picker.
 * Fetches /metrics/summary, /metrics/trends, and /metrics/features (3 endpoints).
 */
(() => {
  const REFRESH_INTERVAL = 60;

  let currentRange = "today";
  let refreshTimer = null;
  let countdown = REFRESH_INTERVAL;
  let countdownTimer = null;
  let trendsChart = null;
  let lastTrendsRows = [];
  let lastTokensTrends = [];
  let tokenTrendsChart = null;
  let activeTokenSeries = "input";
  let modalChart = null;

  // ─── Date range helpers ───────────────────────────────────────────────────

  function buildQuery(range) {
    if (typeof range === "string") return `preset=${range}`;
    return `from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}`;
  }

  function groupByForRange(range) {
    if (range === "today") return "hour";
    if (range === "90d") return "week";
    return "day"; // 7d, 30d, custom
  }

  function rangeFromButton(btn) {
    const r = btn.dataset.range;
    if (r === "today" || r === "7d" || r === "30d" || r === "90d") return r;
    return "today";
  }

  // ─── Loading / Error ──────────────────────────────────────────────────────

  function setLoading(loading) {
    for (const card of document.querySelectorAll(".kpi-card")) {
      card.classList.toggle("kpi-card--loading", loading);
    }
    const chart = document.querySelector(".chart-container");
    if (chart) chart.classList.toggle("chart--loading", loading);
  }

  function showError(message) {
    let toast = document.getElementById("error-toast");
    if (!toast) {
      toast = document.createElement("div");
      toast.id = "error-toast";
      toast.setAttribute("role", "alert");
      document.body.appendChild(toast);
    }
    toast.textContent = message;
    toast.classList.add("visible");
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => toast.classList.remove("visible"), 5000);
  }

  // ─── Freshness / Countdown ────────────────────────────────────────────────

  function updateFreshness(generatedAt) {
    const el = document.getElementById("freshness-indicator");
    if (!el || !generatedAt) return;
    const ageSec = Math.round(
      (Date.now() - new Date(generatedAt).getTime()) / 1000,
    );
    el.textContent =
      ageSec < 60 ? `${ageSec}s ago` : `${Math.round(ageSec / 60)}m ago`;
  }

  function startCountdown() {
    stopCountdown();
    countdown = REFRESH_INTERVAL;
    _tick();
    countdownTimer = setInterval(_tick, 1000);
  }

  function stopCountdown() {
    clearInterval(countdownTimer);
    countdownTimer = null;
  }

  function _tick() {
    const el = document.getElementById("refresh-countdown");
    if (el) el.textContent = `${countdown}s`;
    countdown = Math.max(0, countdown - 1);
  }

  // ─── Fetch ────────────────────────────────────────────────────────────────

  const API_BASE = `${window.__METRICS_BASE__ || ""}/metrics`;

  async function fetchAll(range) {
    const q = buildQuery(range);
    const [summary, trends, featuresRes, queueRes, tokensRes] =
      await Promise.all([
        fetch(`${API_BASE}/summary?${q}`).then((r) => r.json()),
        fetch(`${API_BASE}/trends?${q}&groupBy=${groupByForRange(range)}`).then(
          (r) => r.json(),
        ),
        fetch(`${API_BASE}/features?${q}`)
          .then((r) => r.json())
          .catch((err) => {
            console.error("Features fetch failed:", err);
            return null;
          }),
        fetch(`${API_BASE}/queue?${q}`)
          .then((r) => r.json())
          .catch((err) => {
            console.error("Queue fetch failed:", err);
            return null;
          }),
        fetch(`${API_BASE}/tokens?${q}`)
          .then((r) => r.json())
          .catch((err) => {
            console.error("Tokens fetch failed:", err);
            return null;
          }),
      ]);
    return { summary, trends, featuresRes, queueRes, tokensRes };
  }

  // ─── Formatters ───────────────────────────────────────────────────────────

  function fmtPct(v) {
    return v !== null && v !== undefined ? `${Math.round(v)}%` : "--%";
  }

  function fmtNum(v, decimals = 1) {
    if (v === null || v === undefined) return "--";
    return Number(v).toFixed(decimals);
  }

  function fmtInt(v) {
    if (v === null || v === undefined) return "--";
    return String(Math.round(Number(v)));
  }

  function fmtEstError(v) {
    if (v === null || v === undefined) return "--";
    const n = Number(v);
    const sign = n > 0 ? "+" : "";
    return `${sign}${Math.round(n)}%`;
  }

  function fmtHours(v) {
    return v != null ? `${fmtNum(v)}h` : "--";
  }

  function fmtTokens(v) {
    if (v === null || v === undefined) return "--";
    const n = Math.round(Number(v));
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
    return String(n);
  }

  // ─── Update KPI Cards ────────────────────────────────────────────────────

  function updateKPIs(data) {
    const $ = (id) => document.getElementById(id);

    $("kpi-tasks").textContent = fmtInt(data.tasksCompleted);
    $("kpi-ci-rate").textContent = fmtPct(data.ciFirstPassRate);
    $("kpi-estimation").textContent = fmtEstError(data.estimationAccuracy);
    $("kpi-review-rate").textContent = fmtPct(data.reviewShipItRate);
    $("task-count-badge").textContent = `${fmtInt(data.tasksCompleted)} tasks`;
  }

  // ─── Update Quality Panels ───────────────────────────────────────────────

  function updateQuality(data) {
    const $ = (id) => document.getElementById(id);

    // CI
    $("ci-total").textContent = fmtInt(data.ciGatesTotal);
    $("ci-first").textContent = fmtInt(data.ciFirstPass);
    $("ci-fix-avg").textContent = fmtNum(data.avgFixAttempts);

    // Simplify
    $("simplify-total").textContent = fmtInt(data.simplifyTotalFixes);
    const cats = [
      ["dry", data.simplifyAvgDry],
      ["dead", data.simplifyAvgDeadCode],
      ["naming", data.simplifyAvgNaming],
      ["complexity", data.simplifyAvgComplexity],
      ["consistency", data.simplifyAvgConsistency],
    ];
    const maxCat = Math.max(...cats.map(([, v]) => Number(v) || 0), 0.01);
    for (const [key, val] of cats) {
      const n = Number(val) || 0;
      $(`val-${key}`).textContent = fmtNum(val);
      $(`bar-${key}`).style.width = `${Math.round((n / maxCat) * 100)}%`;
    }

    // Reviews
    $("review-total").textContent = fmtInt(data.reviewsTotal);
    $("review-ship-it").textContent = fmtInt(data.reviewsShipIt);

    // Coverage
    $("coverage-reports").textContent = fmtInt(data.coverageReports);
    const delta = data.avgCoverageDelta;
    const deltaEl = $("coverage-delta");
    if (delta !== null && delta !== undefined) {
      const sign = delta > 0 ? "+" : "";
      deltaEl.textContent = `${sign}${fmtNum(delta)}%`;
      deltaEl.className = `stat-value ${delta > 0 ? "good" : delta < 0 ? "critical" : ""}`;
    } else {
      deltaEl.textContent = "--";
    }
  }

  // ─── Update Efficiency ───────────────────────────────────────────────────

  function updateEfficiency(data) {
    const $ = (id) => document.getElementById(id);
    $("eff-avg-hours").textContent =
      data.avgActualHours !== null ? `${fmtNum(data.avgActualHours)}h` : "--";
    $("eff-est-hours").textContent =
      data.avgEstimatedHours !== null
        ? `${fmtNum(data.avgEstimatedHours)}h`
        : "--";
    $("eff-retries").textContent = fmtNum(data.avgRetries);
    $("eff-files").textContent = fmtNum(data.avgFilesChanged);
  }

  // ─── Update Queue Panels ─────────────────────────────────────────────────

  function updateQueue(data) {
    const $ = (id) => document.getElementById(id);

    $("queue-started").textContent = fmtInt(data.tasksStarted);
    $("queue-approved").textContent = fmtInt(data.tasksApproved);
    $("queue-merged").textContent = fmtInt(data.tasksMerged);
    $("queue-blocked").textContent = fmtInt(data.tasksBlocked);
    $("queue-cycle-time").textContent =
      data.avgCycleTimeDays !== null && data.avgCycleTimeDays !== undefined
        ? `${fmtNum(data.avgCycleTimeDays)} days`
        : "--";
    $("queue-block-rate").textContent = fmtPct(data.blockRate);
    $("queue-review-findings").textContent = fmtNum(data.avgReviewFindings);
  }

  // ─── Update Feature Breakdown ────────────────────────────────────────────

  function updateFeatures(features) {
    const tbody = document.getElementById("features-tbody");
    const emptyMsg = document.getElementById("features-empty");
    const table = document.querySelector(".features-table");
    if (!tbody) return;

    tbody.innerHTML = "";

    if (!features || features.length === 0) {
      if (table) table.style.display = "none";
      if (emptyMsg) emptyMsg.style.display = "";
      return;
    }

    if (table) table.style.display = "";
    if (emptyMsg) emptyMsg.style.display = "none";

    for (const f of features) {
      const tr = document.createElement("tr");
      const cells = [
        { text: f.prefix, cls: "features-prefix" },
        { text: fmtInt(f.tasksCompleted) },
        {
          text:
            f.avgActualH !== null && f.avgActualH !== undefined
              ? `${fmtNum(f.avgActualH)}h`
              : "--",
        },
        {
          text:
            f.ciFirstPassRate !== null && f.ciFirstPassRate !== undefined
              ? fmtPct(f.ciFirstPassRate)
              : "--",
        },
        {
          text:
            f.reviewShipItRate !== null && f.reviewShipItRate !== undefined
              ? fmtPct(f.reviewShipItRate)
              : "--",
        },
      ];
      for (const { text, cls } of cells) {
        const td = document.createElement("td");
        td.textContent = text;
        if (cls) td.className = cls;
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
  }

  // ─── Update Token Usage ──────────────────────────────────────────────────

  function updateTokens(res) {
    const $ = (id) => document.getElementById(id);
    if (!res || res.error || !res.data) {
      $("token-input").textContent = "--";
      $("token-output").textContent = "--";
      $("token-cache").textContent = "--";
      return;
    }
    const { totals, bySessionType, byAgent } = res.data;
    $("token-input").textContent = fmtTokens(totals.input);
    $("token-output").textContent = fmtTokens(totals.output);
    $("token-cache").textContent = fmtTokens(
      (totals.cacheRead || 0) + (totals.cacheCreation || 0),
    );

    const sessionTbody = $("token-session-tbody");
    const sessionEmpty = $("token-session-empty");
    if (sessionTbody) {
      sessionTbody.innerHTML = "";
      if (!bySessionType || bySessionType.length === 0) {
        if (sessionEmpty) sessionEmpty.style.display = "";
      } else {
        if (sessionEmpty) sessionEmpty.style.display = "none";
        for (const row of bySessionType) {
          const tr = document.createElement("tr");
          const tdType = document.createElement("td");
          const tdInput = document.createElement("td");
          const tdOutput = document.createElement("td");
          const tdTotal = document.createElement("td");
          tdType.textContent = row.sessionType;
          tdInput.textContent = fmtTokens(row.input);
          tdOutput.textContent = fmtTokens(row.output);
          tdTotal.textContent = fmtTokens(row.total);
          tr.appendChild(tdType);
          tr.appendChild(tdInput);
          tr.appendChild(tdOutput);
          tr.appendChild(tdTotal);
          sessionTbody.appendChild(tr);
        }
      }
    }

    const agentTbody = $("token-agent-tbody");
    const agentEmpty = $("token-agent-empty");
    if (agentTbody) {
      agentTbody.innerHTML = "";
      if (!byAgent || byAgent.length === 0) {
        if (agentEmpty) agentEmpty.style.display = "";
      } else {
        if (agentEmpty) agentEmpty.style.display = "none";
        for (const row of byAgent) {
          const tr = document.createElement("tr");
          const tdAgent = document.createElement("td");
          const tdInput = document.createElement("td");
          const tdOutput = document.createElement("td");
          const tdTotal = document.createElement("td");
          tdAgent.textContent = row.agentName ?? row.agentId;
          tdInput.textContent = fmtTokens(row.input);
          tdOutput.textContent = fmtTokens(row.output);
          tdTotal.textContent = fmtTokens(row.total);
          tr.appendChild(tdAgent);
          tr.appendChild(tdInput);
          tr.appendChild(tdOutput);
          tr.appendChild(tdTotal);
          agentTbody.appendChild(tr);
        }
      }
    }
  }

  // ─── Chart.js Trends Chart ───────────────────────────────────────────────

  function makeDataset(label, data, color) {
    return {
      label,
      data,
      borderColor: color,
      backgroundColor: `${color}14`,
      pointBackgroundColor: color,
      borderWidth: 2,
      pointRadius: 3,
      tension: 0.3,
    };
  }

  function drawChart(rows) {
    const canvas = document.getElementById("trends-chart");
    if (!canvas) return;

    const ctx = canvas.getContext("2d");

    if (trendsChart) {
      trendsChart.destroy();
      trendsChart = window.trendsChart = null;
    }

    if (!rows || rows.length === 0) {
      ctx.font = "14px var(--mono)";
      ctx.fillStyle = "var(--text-dim)";
      ctx.textAlign = "center";
      ctx.fillText(
        "No data for this period",
        canvas.width / 2,
        canvas.height / 2,
      );
      return;
    }

    try {
      trendsChart = window.trendsChart = new Chart(ctx, {
        type: "line",
        data: {
          labels: rows.map((r) => r.period),
          datasets: [
            makeDataset(
              "Tasks",
              rows.map((r) => r.tasksCompleted),
              "#00ccaa",
            ),
            makeDataset(
              "CI Gates",
              rows.map((r) => r.ciGates),
              "#4488ff",
            ),
            makeDataset(
              "CI Pass",
              rows.map((r) => r.ciFirstPass || 0),
              "#00cc88",
            ),
          ],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: {
              labels: {
                color: "var(--text)",
                font: { family: "'JetBrains Mono', monospace", size: 11 },
                boxWidth: 12,
              },
            },
          },
          scales: {
            x: {
              ticks: {
                color: "var(--text-dim)",
                font: { family: "'JetBrains Mono', monospace", size: 10 },
                maxRotation: 45,
              },
              grid: { color: "var(--surface-raised)" },
            },
            y: {
              ticks: {
                color: "var(--text-dim)",
                font: { family: "'JetBrains Mono', monospace", size: 10 },
              },
              grid: { color: "var(--surface-raised)" },
            },
          },
        },
      });
    } catch (err) {
      showError("Failed to render chart");
    }
  }

  // ─── Token Trends Chart ───────────────────────────────────────────────────

  function renderTokenTrendsChart(rows, series) {
    const canvas = document.getElementById("token-trends-chart");
    if (!canvas) return;

    const ctx = canvas.getContext("2d");

    if (tokenTrendsChart) {
      tokenTrendsChart.destroy();
      tokenTrendsChart = window.tokenTrendsChart = null;
    }

    if (!rows || rows.length === 0) {
      ctx.font = "14px var(--mono)";
      ctx.fillStyle = "var(--text-dim)";
      ctx.textAlign = "center";
      ctx.fillText(
        "No data for this period",
        canvas.width / 2,
        canvas.height / 2,
      );
      return;
    }

    const labels = rows.map((r) => r.date ?? "");
    const SERIES_CONFIG = {
      input: {
        label: "Input",
        color: "#00ccaa",
        getValue: (r) => r.input ?? 0,
      },
      output: {
        label: "Output",
        color: "#4488ff",
        getValue: (r) => r.output ?? 0,
      },
      total: {
        label: "Total",
        color: "#cc44aa",
        getValue: (r) => r.total ?? (r.input ?? 0) + (r.output ?? 0),
      },
    };
    const seriesKeys =
      series === "all" ? ["input", "output", "total"] : [series];
    const datasets = seriesKeys.map((key) => {
      const { label, color, getValue } = SERIES_CONFIG[key];
      return makeDataset(label, rows.map(getValue), color);
    });

    try {
      tokenTrendsChart = window.tokenTrendsChart = new Chart(ctx, {
        type: "line",
        data: { labels, datasets },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: {
              labels: {
                color: "var(--text)",
                font: { family: "'JetBrains Mono', monospace", size: 11 },
                boxWidth: 12,
              },
            },
          },
          scales: {
            x: {
              ticks: {
                color: "var(--text-dim)",
                font: { family: "'JetBrains Mono', monospace", size: 10 },
                maxRotation: 45,
              },
              grid: { color: "var(--surface-raised)" },
            },
            y: {
              ticks: {
                color: "var(--text-dim)",
                font: { family: "'JetBrains Mono', monospace", size: 10 },
              },
              grid: { color: "var(--surface-raised)" },
            },
          },
        },
      });
    } catch (err) {
      showError("Failed to render token trends chart");
    }
  }

  function initTokenTrendsToggles() {
    const group = document.querySelector(".token-trends-toggles");
    if (!group) return;
    group.addEventListener("click", (e) => {
      const btn = e.target.closest(".token-series-btn");
      if (!btn) return;
      for (const b of group.querySelectorAll(".token-series-btn"))
        b.classList.remove("active");
      btn.classList.add("active");
      activeTokenSeries = btn.dataset.tokenSeries;
      renderTokenTrendsChart(lastTokensTrends, activeTokenSeries);
    });
  }

  // ─── Metric Registry ─────────────────────────────────────────────────────

  const METRIC_REGISTRY = {
    "tasks-completed": {
      label: "Tasks Completed",
      series: (r) => r.tasksCompleted,
      fmt: fmtInt,
    },
    "ci-first-pass": {
      label: "CI First-Pass Rate",
      numerator: (r) => r.ciFirstPassCount,
      denominator: (r) => r.ciGates,
      fmt: fmtPct,
    },
    "estimation-accuracy": {
      label: "Estimation Accuracy",
      series: (r) => r.estimationAccuracy,
      fmt: fmtEstError,
    },
    "review-ship-it": {
      label: "Review SHIP IT Rate",
      numerator: (r) => r.reviewsShipIt,
      denominator: (r) => r.reviews,
      fmt: fmtPct,
    },
    "tasks-started": {
      label: "Tasks Started",
      series: (r) => r.tasksStarted,
      fmt: fmtInt,
    },
    "tasks-blocked": {
      label: "Tasks Blocked",
      series: (r) => r.tasksBlocked,
      fmt: fmtInt,
    },
    "avg-cycle-time": {
      label: "Avg Cycle Time (h)",
      series: (r) => r.avgCycleTimeHours,
      fmt: fmtHours,
    },
    "block-rate": {
      label: "Block Rate",
      numerator: (r) => r.tasksBlocked,
      denominator: (r) => r.tasksStarted,
      fmt: fmtPct,
    },
    "avg-review-findings": {
      label: "Avg Review Findings",
      series: (r) => r.avgReviewFindings,
      fmt: fmtNum,
    },
    "ci-gates": { label: "CI Gates", series: (r) => r.ciGates, fmt: fmtInt },
    "ci-first-pass-count": {
      label: "CI First-Pass Count",
      series: (r) => r.ciFirstPassCount,
      fmt: fmtInt,
    },
    "avg-fix-attempts": {
      label: "Avg Fix Attempts",
      series: (r) => r.avgFixAttempts,
      fmt: fmtNum,
    },
    "simplify-total": {
      label: "Simplify Fixes",
      series: (r) => r.simplifyFixes,
      fmt: fmtNum,
    },
    "simplify-dry": {
      label: "Simplify: DRY",
      series: (r) => r.simplifyAvgDry,
      fmt: fmtNum,
    },
    "simplify-dead": {
      label: "Simplify: Dead Code",
      series: (r) => r.simplifyAvgDeadCode,
      fmt: fmtNum,
    },
    "simplify-naming": {
      label: "Simplify: Naming",
      series: (r) => r.simplifyAvgNaming,
      fmt: fmtNum,
    },
    "simplify-complexity": {
      label: "Simplify: Complexity",
      series: (r) => r.simplifyAvgComplexity,
      fmt: fmtNum,
    },
    "simplify-consistency": {
      label: "Simplify: Consistency",
      series: (r) => r.simplifyAvgConsistency,
      fmt: fmtNum,
    },
    "reviews-total": {
      label: "Total Reviews",
      series: (r) => r.reviews,
      fmt: fmtInt,
    },
    "reviews-ship-it": {
      label: "Reviews SHIP IT",
      series: (r) => r.reviewsShipIt,
      fmt: fmtInt,
    },
    "avg-actual-hours": {
      label: "Avg Actual Hours",
      series: (r) => r.avgActualHours,
      fmt: fmtHours,
    },
    "avg-estimated-hours": {
      label: "Avg Estimated Hours",
      series: (r) => r.avgEstimatedHours,
      fmt: fmtHours,
    },
    "avg-retries": {
      label: "Avg Retries",
      series: (r) => r.avgRetries,
      fmt: fmtNum,
    },
    "avg-files-changed": {
      label: "Avg Files Changed",
      series: (r) => r.avgFilesChanged,
      fmt: fmtNum,
    },
    "token-input": {
      label: "Input Tokens",
      source: "tokens",
      series: (r) => r.input,
      fmt: fmtTokens,
    },
    "token-output": {
      label: "Output Tokens",
      source: "tokens",
      series: (r) => r.output,
      fmt: fmtTokens,
    },
    "token-cache": {
      label: "Cache Tokens",
      source: "tokens",
      series: (r) => (r.cacheRead || 0) + (r.cacheCreation || 0),
      fmt: fmtTokens,
    },
  };

  // ─── Metric Modal ─────────────────────────────────────────────────────────

  function getSeriesData(metricKey) {
    const entry = METRIC_REGISTRY[metricKey];
    if (!entry) return { labels: [], data: [] };
    const rows = entry.source === "tokens" ? lastTokensTrends : lastTrendsRows;
    const labels = rows.map((r) => r.period ?? r.date ?? "");
    let data;
    if (entry.numerator && entry.denominator) {
      data = rows.map((r) => {
        const denom = entry.denominator(r);
        return denom > 0
          ? Math.round((entry.numerator(r) / denom) * 10000) / 100
          : null;
      });
    } else {
      data = rows.map((r) => entry.series(r));
    }
    return { labels, data };
  }

  function openMetricModal(metricKey) {
    const entry = METRIC_REGISTRY[metricKey];
    if (!entry) return;
    const modal = document.getElementById("metric-modal");
    const titleEl = document.getElementById("metric-modal-title");
    if (!modal || !titleEl) return;
    titleEl.textContent = entry.label;
    modal.removeAttribute("hidden");

    // Destroy previous modal chart if any
    if (modalChart) {
      modalChart.destroy();
      modalChart = null;
    }
    const canvas = document.getElementById("metric-chart");
    if (!canvas) return;
    const { labels, data } = getSeriesData(metricKey);
    try {
      modalChart = new Chart(canvas.getContext("2d"), {
        type: "line",
        data: {
          labels,
          datasets: [makeDataset(entry.label, data, "#4f46e5")],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: { display: false },
          },
          scales: {
            x: {
              ticks: {
                color: "var(--text-dim)",
                font: { family: "'JetBrains Mono', monospace", size: 10 },
                maxRotation: 45,
              },
              grid: { color: "var(--surface-raised)" },
            },
            y: {
              ticks: {
                color: "var(--text-dim)",
                font: { family: "'JetBrains Mono', monospace", size: 10 },
              },
              grid: { color: "var(--surface-raised)" },
            },
          },
        },
      });
    } catch (err) {
      showError("Failed to render metric chart");
    }
  }

  function closeMetricModal() {
    const modal = document.getElementById("metric-modal");
    if (modal) modal.setAttribute("hidden", "");
    if (modalChart) {
      modalChart.destroy();
      modalChart = null;
    }
  }

  function initMetricClicks() {
    document.addEventListener("click", (e) => {
      const el = e.target.closest("[data-metric]");
      if (el) {
        openMetricModal(el.dataset.metric);
      }
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") closeMetricModal();
    });

    // Direct listeners on backdrop and close button — sole close path
    // (direct dispatch handles Chart.js pointer-event retargeting reliably)
    const backdrop = document.querySelector(".metric-modal-backdrop");
    const closeBtn = document.querySelector(".metric-modal-close");
    if (backdrop) backdrop.addEventListener("click", closeMetricModal);
    if (closeBtn) closeBtn.addEventListener("click", closeMetricModal);
  }

  // ─── Main Refresh ─────────────────────────────────────────────────────────

  async function refresh() {
    setLoading(true);
    try {
      const { summary, trends, featuresRes, queueRes, tokensRes } =
        await fetchAll(currentRange);
      const firstError = summary.error || trends.error;
      if (firstError) {
        showError(`Metrics error: ${firstError}`);
      } else {
        updateKPIs(summary.data);
        updateQuality(summary.data);
        updateEfficiency(summary.data);
        drawChart(trends.data?.rows ?? []);
        lastTrendsRows = trends.data?.rows ?? [];
        updateFreshness(summary.meta?.generatedAt);
      }
      if (featuresRes && !featuresRes.error) {
        updateFeatures(featuresRes.data?.features ?? []);
      } else {
        if (featuresRes?.error) {
          console.error("Features error:", featuresRes.error);
        }
        updateFeatures([]);
      }
      if (queueRes && !queueRes.error) {
        updateQueue(queueRes.data);
      } else if (queueRes?.error) {
        console.error("Queue error:", queueRes.error);
      }
      if (tokensRes && !tokensRes.error && tokensRes.data) {
        lastTokensTrends = tokensRes.data.trends ?? [];
      }
      updateTokens(tokensRes);
      renderTokenTrendsChart(lastTokensTrends, activeTokenSeries);
    } catch (err) {
      showError(`Failed to load metrics: ${err.message}`);
    } finally {
      setLoading(false);
    }
    startCountdown();
    scheduleRefresh();
  }

  function scheduleRefresh() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(refresh, REFRESH_INTERVAL * 1000);
  }

  // ─── Date Range Picker ────────────────────────────────────────────────────

  function initDateRangePicker() {
    const picker = document.querySelector(".date-range-picker");
    if (!picker) return;
    picker.addEventListener("click", (e) => {
      const btn = e.target.closest(".date-btn");
      if (!btn) return;
      for (const b of picker.querySelectorAll(".date-btn"))
        b.classList.remove("active");
      btn.classList.add("active");
      currentRange = rangeFromButton(btn);
      stopCountdown();
      clearTimeout(refreshTimer);
      refresh();
    });
  }

  // ─── Boot ─────────────────────────────────────────────────────────────────

  document.addEventListener("DOMContentLoaded", () => {
    const activeBtn = document.querySelector(".date-btn.active");
    if (activeBtn) currentRange = rangeFromButton(activeBtn);
    initDateRangePicker();
    initMetricClicks();
    initTokenTrendsToggles();
    refresh();
  });
})();
