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
  let mergedPrsBarChart = null;
  let mergedPrsTrendChart = null;
  let lastMergedPrsTrend = [];
  let coverageTrendChart = null;
  let lastCoverageTrend = [];

  // ─── Theme ───────────────────────────────────────────────────────────────

  // Must match THEME_STORAGE_KEY in dashboard-page.ts (the <head> boot script).
  const THEME_STORAGE_KEY = "shipwright-theme";

  /** A saved choice wins; otherwise the system preference; otherwise light. */
  function resolveTheme(stored, prefersDark) {
    if (stored === "dark" || stored === "light") return stored;
    return prefersDark ? "dark" : "light";
  }

  function nextTheme(current) {
    return current === "dark" ? "light" : "dark";
  }

  function readStoredTheme() {
    try {
      return localStorage.getItem(THEME_STORAGE_KEY);
    } catch {
      return null; // storage blocked (private mode, sandboxed frame)
    }
  }

  // A canvas cannot resolve CSS custom properties, so chart colours are read
  // from the computed style of <html> when a chart is drawn or re-themed.
  function themeColor(name) {
    return getComputedStyle(document.documentElement)
      .getPropertyValue(name)
      .trim();
  }

  /** Re-colour a live chart's legend, ticks and grid for the current theme. */
  function applyChartTheme(chart) {
    if (!chart) return;
    const legend = chart.options?.plugins?.legend?.labels;
    if (legend) legend.color = themeColor("--text");
    for (const scale of Object.values(chart.options?.scales ?? {})) {
      if (scale?.ticks) scale.ticks.color = themeColor("--text-dim");
      if (scale?.grid) scale.grid.color = themeColor("--surface-raised");
    }
    chart.update("none");
  }

  function applyTheme(theme) {
    document.documentElement.setAttribute("data-theme", theme);
    const btn = document.getElementById("theme-toggle");
    if (btn) btn.setAttribute("aria-pressed", String(theme === "dark"));
    for (const chart of [
      trendsChart,
      tokenTrendsChart,
      modalChart,
      mergedPrsBarChart,
      mergedPrsTrendChart,
      coverageTrendChart,
    ]) {
      applyChartTheme(chart);
    }
  }

  function initThemeToggle() {
    const root = document.documentElement;
    const mq = window.matchMedia?.("(prefers-color-scheme: dark)");
    // When the shared toolbar ships its own site-wide toggle, it owns the
    // theme (same storage key, same data-theme attribute). The dashboard then
    // drops its own button and only re-colours its charts on each change.
    if (document.getElementById("vos-theme-toggle")) {
      const own = document.getElementById("theme-toggle");
      if (own) own.hidden = true;
      document.addEventListener("vos-theme-change", (e) => {
        applyTheme(e.detail?.theme === "dark" ? "dark" : "light");
      });
      applyTheme(root.getAttribute("data-theme") === "dark" ? "dark" : "light");
      return;
    }
    applyTheme(
      root.getAttribute("data-theme") ??
        resolveTheme(readStoredTheme(), Boolean(mq?.matches)),
    );
    const btn = document.getElementById("theme-toggle");
    if (btn) {
      btn.addEventListener("click", () => {
        const theme = nextTheme(root.getAttribute("data-theme"));
        try {
          localStorage.setItem(THEME_STORAGE_KEY, theme);
        } catch {
          // storage blocked: the choice still applies for this page view
        }
        applyTheme(theme);
      });
    }
    // With no saved choice, keep following the system setting as it changes.
    mq?.addEventListener?.("change", (e) => {
      if (readStoredTheme() === null) applyTheme(resolveTheme(null, e.matches));
    });
  }

  // Fixed origin taxonomy + colors, shared by the bar and trend charts so
  // legend/tooltip semantics stay identical across both (unknown is grey).
  const ORIGIN_KEYS = [
    "shipwright",
    "ci",
    "dependency_bot",
    "human",
    "unknown",
  ];
  const ORIGIN_COLORS = {
    shipwright: "#00ccaa",
    ci: "#4488ff",
    dependency_bot: "#cc8844",
    human: "#cc44aa",
    unknown: "#888888",
  };

  function originLabel(origin) {
    if (origin === "ci") return "CI";
    return origin
      .split("_")
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(" ");
  }

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

  // /metrics/merged-prs only accepts day|week (no hour bucket) — map "today"
  // down to "day" rather than changing groupByForRange, which /metrics/trends
  // still relies on for its hourly bucket.
  function mergedPrsGroupByForRange(range) {
    const gb = groupByForRange(range);
    return gb === "hour" ? "day" : gb;
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

  function updateFreshness(
    generatedAt,
    elId = "freshness-indicator",
    prefix = "",
  ) {
    const el = document.getElementById(elId);
    if (!el || !generatedAt) return;
    const ageSec = Math.round(
      (Date.now() - new Date(generatedAt).getTime()) / 1000,
    );
    el.textContent = `${prefix}${
      ageSec < 60 ? `${ageSec}s ago` : `${Math.round(ageSec / 60)}m ago`
    }`;
    el.title = String(generatedAt);
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

  function getApiBase() {
    return `${window.__METRICS_BASE__ || ""}/metrics`;
  }

  /**
   * Runs an ordered list of `{ url, parse, onError? }` entries one at a time —
   * the next entry's `fetchImpl` call isn't issued until the previous entry's
   * promise (fetch + parse) has settled. Pure and DOM-free: takes an
   * injectable `fetchImpl` so it's unit-testable without browser globals.
   *
   * Per-entry error handling: if `onError` is provided, a rejection from
   * either `fetchImpl(url)` or `parse(response)` is passed to it and its
   * return value becomes that entry's result (e.g. fall back to null).
   * Without `onError`, a rejection propagates immediately and aborts any
   * remaining entries — matching a plain `await` with no `.catch()`.
   */
  async function fetchSequential(entries, fetchImpl) {
    const results = [];
    for (const { url, parse, onError } of entries) {
      try {
        const response = await fetchImpl(url);
        results.push(await parse(response));
      } catch (err) {
        if (!onError) throw err;
        results.push(onError(err));
      }
    }
    return results;
  }

  async function fetchAll(range) {
    const API_BASE = getApiBase();
    const q = buildQuery(range);
    const [summary, trends, featuresRes, tokensRes, mergedPrsRes] =
      await fetchSequential(
        [
          { url: `${API_BASE}/summary?${q}`, parse: (r) => r.json() },
          {
            url: `${API_BASE}/trends?${q}&groupBy=${groupByForRange(range)}`,
            parse: (r) => r.json(),
          },
          {
            url: `${API_BASE}/features?${q}`,
            parse: (r) => r.json(),
            onError: (err) => {
              console.error("Features fetch failed:", err);
              return null;
            },
          },
          {
            url: `${API_BASE}/tokens?${q}`,
            parse: (r) => r.json(),
            onError: (err) => {
              console.error("Tokens fetch failed:", err);
              return null;
            },
          },
          {
            url: `${API_BASE}/merged-prs?${q}&groupBy=${mergedPrsGroupByForRange(range)}`,
            parse: (r) => r.json(),
            onError: (err) => {
              console.error("Merged PRs fetch failed:", err);
              return null;
            },
          },
        ],
        fetch,
      );
    // Cost efficiency is only fetched on the public (read-only) dashboard,
    // guarded by element presence so the authenticated page never fetches it.
    const costEffEl = document.getElementById("cost-efficiency-section");
    const costEffRes = costEffEl
      ? await fetch(`${API_BASE}/cost-efficiency?${q}`)
          .then((r) => r.json())
          .catch((err) => {
            console.error("Cost efficiency fetch failed:", err);
            return null;
          })
      : null;
    // Coverage by repo is authenticated-only (no public endpoint); the section
    // is omitted from the public page, so fetch only when it is present.
    const coverageEl = document.getElementById("coverage-section");
    const coverageRes = coverageEl
      ? await fetch(`${API_BASE}/coverage?${q}`)
          .then((r) => r.json())
          .catch((err) => {
            console.error("Coverage fetch failed:", err);
            return null;
          })
      : null;
    // System-cron work (SCM-8.4) is authenticated-only like coverage; refetched
    // with the selected range on every refresh / range toggle.
    const systemCronsEl = document.getElementById("system-crons-section");
    const systemCronsRes = systemCronsEl
      ? await fetch(`${API_BASE}/system-crons?${q}`)
          .then((r) => r.json())
          .catch((err) => {
            console.error("System crons fetch failed:", err);
            return null;
          })
      : null;
    return {
      summary,
      trends,
      featuresRes,
      tokensRes,
      mergedPrsRes,
      coverageRes,
      systemCronsRes,
      costEffRes,
    };
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

  function fmtCost(v) {
    if (v === null || v === undefined) return "$0.00";
    return `$${Number(v).toFixed(2)}`;
  }

  // ─── Update KPI Cards ────────────────────────────────────────────────────

  function updateKPIs(data) {
    const $ = (id) => document.getElementById(id);

    $("kpi-tasks").textContent = fmtInt(data.tasksCompleted);
    $("kpi-ci-rate").textContent = fmtPct(data.ciFirstPassRate);
    $("kpi-shipwright-prs").textContent = fmtInt(data.shipwrightPrsMerged);
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
    $("review-iterations").textContent = fmtNum(data.avgReviewIterations);

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

  // ─── Update PR Commits Panel ──────────────────────────────────────────────

  function updatePRCommits(fleetStats) {
    const $ = (id) => document.getElementById(id);

    if (!fleetStats || fleetStats.avgCommitCount === null) {
      $("pr-commits-total").textContent = "--";
      const phases = [
        "docs-refresh",
        "review-patch",
        "ci-fix",
        "implementation",
      ];
      for (const phase of phases) {
        const val = $(`val-pr-commits-${phase}`);
        if (val) val.textContent = "--";
        const bar = $(`bar-pr-commits-${phase}`);
        if (bar) bar.style.width = "0%";
      }
      return;
    }

    $("pr-commits-total").textContent = fmtNum(fleetStats.avgCommitCount);
    const breakdown = fleetStats.commitBreakdown || {};
    const phaseMap = [
      ["docs-refresh", "docsRefresh"],
      ["review-patch", "reviewPatch"],
      ["ci-fix", "ciFix"],
      ["implementation", "implementation"],
    ];

    const breakdownValues = [
      breakdown.docsRefresh || 0,
      breakdown.reviewPatch || 0,
      breakdown.ciFix || 0,
      breakdown.implementation || 0,
    ];
    const maxBreakdown = Math.max(...breakdownValues, 0.01);

    for (const [idKey, breakdownKey] of phaseMap) {
      const val = breakdown[breakdownKey] || 0;
      $(`val-pr-commits-${idKey}`).textContent = fmtNum(val);
      $(`bar-pr-commits-${idKey}`).style.width =
        `${Math.round((val / maxBreakdown) * 100)}%`;
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
    // Read-only/public dashboard omits the token-usage section entirely, so its
    // elements don't exist — skip rather than crash on a null textContent set.
    if (!$("token-input")) return;
    if (!res || res.error || !res.data) {
      $("token-input").textContent = "--";
      $("token-output").textContent = "--";
      $("token-cache").textContent = "--";
      $("token-cost").textContent = "$0.00";
      return;
    }
    const {
      totals,
      byAgent,
      byAgentCron,
      byAgentCronModel,
      byAgentSessionType,
    } = res.data;
    $("token-input").textContent = fmtTokens(totals.input);
    $("token-output").textContent = fmtTokens(totals.output);
    $("token-cache").textContent = fmtTokens(
      (totals.cacheRead || 0) + (totals.cacheCreation || 0),
    );
    $("token-cost").textContent = fmtCost(totals.cost);

    const agentTbody = $("token-agent-tbody");
    const agentEmpty = $("token-agent-empty");
    if (agentTbody) {
      agentTbody.innerHTML = "";
      if (!byAgent || byAgent.length === 0) {
        if (agentEmpty) agentEmpty.style.display = "";
      } else {
        if (agentEmpty) agentEmpty.style.display = "none";
        for (const agent of byAgent) {
          const agentCronRows = (byAgentCron || []).filter(
            (r) => r.agentId === agent.agentId,
          );
          const agentSessionRows = (byAgentSessionType || []).filter(
            (r) => r.agentId === agent.agentId,
          );

          const cronTotal = agentCronRows.reduce(
            (sum, r) => sum + (r.total || 0),
            0,
          );
          let dmTotal;
          if (agentSessionRows.length > 0) {
            dmTotal = agentSessionRows
              .filter((r) => r.sessionType !== "cron")
              .reduce((sum, r) => sum + (r.total || 0), 0);
          } else {
            dmTotal = (agent.total || 0) - cronTotal;
          }

          const agentLabel = agent.agentName ?? agent.agentId.slice(0, 8);

          // Agent header row
          const headerTr = document.createElement("tr");
          headerTr.className = "agent-header-row";
          const cells = [
            agentLabel,
            fmtTokens(cronTotal),
            fmtTokens(dmTotal),
            fmtTokens(agent.total),
            fmtCost(agent.cost),
          ];
          for (const text of cells) {
            const td = document.createElement("td");
            td.textContent = text;
            headerTr.appendChild(td);
          }
          agentTbody.appendChild(headerTr);

          // Cron sub-rows. byAgentCron is grouped by (agentId, cronId, phase)
          // server-side: a legacy (no-phase) cron yields exactly one row here,
          // identical to before WL-3.5; a phase-tagged cron (e.g. the unified
          // shipwright-loop) yields one row per phase, so the per-phase
          // breakdown falls out of this same loop with no extra grouping.
          for (const cronRow of agentCronRows) {
            const tr = document.createElement("tr");
            tr.className = "agent-cron-row";
            const cronLabel = cronRow.phase
              ? `› ${cronRow.cronName} — ${cronRow.phase}`
              : `› ${cronRow.cronName}`;
            const cronCells = [
              cronLabel,
              fmtTokens(cronRow.total),
              "--",
              fmtTokens(cronRow.total),
              fmtCost(cronRow.cost),
            ];
            for (const text of cronCells) {
              const td = document.createElement("td");
              td.textContent = text;
              tr.appendChild(td);
            }
            agentTbody.appendChild(tr);

            // Model sub-rows nested under this cron (+ phase) sub-row. Both
            // byAgentCronModel and byAgentCron are mapped through
            // cronDisplayNameMap in api.ts before reaching the client, so
            // comparing cronName here is safe — keep both sides mapped
            // consistently if this logic changes. Phase must also match so a
            // phase-tagged cron's model rows aren't double-counted under
            // every one of its phase sub-rows.
            const cronModelRows = (byAgentCronModel || []).filter(
              (r) =>
                r.agentId === agent.agentId &&
                r.cronName === cronRow.cronName &&
                (r.phase ?? null) === (cronRow.phase ?? null),
            );
            for (const modelRow of cronModelRows) {
              const modelTr = document.createElement("tr");
              modelTr.className = "agent-cron-model-row";
              const modelCells = [
                `  ◦ ${modelRow.model}`,
                "--",
                "--",
                fmtTokens(modelRow.total),
                fmtCost(modelRow.cost),
              ];
              for (const text of modelCells) {
                const td = document.createElement("td");
                td.textContent = text;
                modelTr.appendChild(td);
              }
              agentTbody.appendChild(modelTr);
            }
          }
        }
      }
    }
  }

  // ─── Update Cost Efficiency ──────────────────────────────────────────────

  function updateCostEfficiency(res) {
    const $ = (id) => document.getElementById(id);
    // Read-only/public dashboard renders this section; authenticated page does not.
    if (!$("cost-efficiency-section")) return;

    const data = res && !res.error ? res.data : null;
    const emptyEl = $("ce-empty");
    const limitedEl = $("ce-limited");

    if (!data || data.runsWithCostData === 0) {
      if (emptyEl) emptyEl.style.display = "";
      if ($("ce-routed")) $("ce-routed").textContent = "--";
      if ($("ce-opus")) $("ce-opus").textContent = "--";
      if ($("ce-savings-text")) $("ce-savings-text").textContent = "--";
      return;
    }

    if (emptyEl) emptyEl.style.display = "none";

    const fleet = data.fleet;
    const smallN = data.runsWithCostData > 0 && data.runsWithCostData < 3;

    // Routed/Opus KPIs
    if ($("ce-routed"))
      $("ce-routed").textContent = smallN ? "--" : fmtCost(fleet.routedUsd);
    if ($("ce-opus"))
      $("ce-opus").textContent = smallN
        ? "--"
        : fmtCost(fleet.counterfactualOpusUsd);

    // Savings line
    if ($("ce-savings-text")) {
      if (
        smallN &&
        fleet.savingsPct !== null &&
        fleet.savingsPct !== undefined
      ) {
        $("ce-savings-text").textContent =
          `${Math.round(fleet.savingsPct)}% saved`;
        if (limitedEl) limitedEl.style.display = "";
      } else if (
        !smallN &&
        fleet.savingsUsd !== null &&
        fleet.savingsPct !== null
      ) {
        $("ce-savings-text").textContent =
          `${fmtCost(fleet.savingsUsd)} saved · ${Math.round(fleet.savingsPct)}%`;
        if (limitedEl) limitedEl.style.display = "none";
      } else {
        $("ce-savings-text").textContent = "--";
      }
    }

    // Model-mix bar: classify by modelFamily
    const byModel = fleet.byModel || [];
    let haikuUsd = 0;
    let sonnetUsd = 0;
    let opusUsd = 0;
    for (const m of byModel) {
      const mf = m.modelFamily || "";
      if (mf.includes("haiku")) haikuUsd += m.routedUsd;
      else if (mf.includes("opus")) opusUsd += m.routedUsd;
      else sonnetUsd += m.routedUsd;
    }
    const total = haikuUsd + sonnetUsd + opusUsd || 1;
    const pct = (v) => `${Math.round((v / total) * 100)}%`;

    if ($("ce-bar-haiku")) $("ce-bar-haiku").style.flexBasis = pct(haikuUsd);
    if ($("ce-bar-sonnet")) $("ce-bar-sonnet").style.flexBasis = pct(sonnetUsd);
    if ($("ce-bar-opus")) $("ce-bar-opus").style.flexBasis = pct(opusUsd);

    if ($("ce-legend-haiku"))
      $("ce-legend-haiku").textContent = `Haiku ${pct(haikuUsd)}`;
    if ($("ce-legend-sonnet"))
      $("ce-legend-sonnet").textContent = `Sonnet ${pct(sonnetUsd)}`;
    if ($("ce-legend-opus"))
      $("ce-legend-opus").textContent = `Opus ${pct(opusUsd)}`;
  }

  // ─── Update Merged PRs by Repo ───────────────────────────────────────────

  function destroyMergedPrsCharts() {
    if (mergedPrsBarChart) {
      mergedPrsBarChart.destroy();
      mergedPrsBarChart = window.mergedPrsBarChart = null;
    }
    if (mergedPrsTrendChart) {
      mergedPrsTrendChart.destroy();
      mergedPrsTrendChart = window.mergedPrsTrendChart = null;
    }
  }

  function populateMergedPrsRepoSelect(repos) {
    const picker = document.getElementById("merged-prs-repo-picker");
    const select = document.getElementById("merged-prs-repo-select");
    if (!picker || !select) return;

    if (!repos || repos.length <= 1) {
      picker.style.display = "none";
      select.innerHTML = "";
      return;
    }

    const previousValue = select.value;
    select.innerHTML = "";
    const allOption = document.createElement("option");
    allOption.value = "";
    allOption.textContent = "All repos";
    select.appendChild(allOption);
    for (const r of repos) {
      const opt = document.createElement("option");
      opt.value = r.repo;
      opt.textContent = r.repo;
      select.appendChild(opt);
    }
    select.value = repos.some((r) => r.repo === previousValue)
      ? previousValue
      : "";
    picker.style.display = "";
  }

  function updateMergedPrs(res) {
    const contentEl = document.getElementById("merged-prs-content");
    const emptyEl = document.getElementById("merged-prs-empty");
    if (!contentEl) return;

    const data = res && !res.error ? res.data : null;
    const repos = data?.repos ?? [];
    const trend = data?.trend ?? [];
    lastMergedPrsTrend = trend;

    if (!data || repos.length === 0) {
      contentEl.style.display = "none";
      if (emptyEl) emptyEl.style.display = "";
      destroyMergedPrsCharts();
      return;
    }

    contentEl.style.display = "";
    if (emptyEl) emptyEl.style.display = "none";

    populateMergedPrsRepoSelect(repos);
    drawMergedPrsBarChart(repos);
    const select = document.getElementById("merged-prs-repo-select");
    drawMergedPrsTrendChart(trend, select ? select.value : "");
  }

  function initMergedPrsRepoSelect() {
    const select = document.getElementById("merged-prs-repo-select");
    if (!select) return;
    select.addEventListener("change", () => {
      drawMergedPrsTrendChart(lastMergedPrsTrend, select.value);
    });
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

  // Bar-shaped dataset (solid fill, no border/point styling) — distinct from
  // makeDataset's line shape, reused by the Merged PRs stacked bar chart.
  function makeBarDataset(label, data, color) {
    return {
      label,
      data,
      backgroundColor: color,
    };
  }

  function drawMergedPrsBarChart(repos) {
    const canvas = document.getElementById("merged-prs-bar-chart");
    if (!canvas) return;
    const ctx = canvas.getContext("2d");

    if (mergedPrsBarChart) {
      mergedPrsBarChart.destroy();
      mergedPrsBarChart = window.mergedPrsBarChart = null;
    }

    const labels = repos.map((r) => r.repo);
    const totals = repos.map((r) => r.total);
    const datasets = ORIGIN_KEYS.map((origin) =>
      makeBarDataset(
        originLabel(origin),
        repos.map((r) => r.byOrigin?.[origin] ?? 0),
        ORIGIN_COLORS[origin],
      ),
    );

    try {
      mergedPrsBarChart = window.mergedPrsBarChart = new Chart(ctx, {
        type: "bar",
        data: { labels, datasets },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: {
              labels: {
                color: themeColor("--text"),
                font: { family: "'JetBrains Mono', monospace", size: 11 },
                boxWidth: 12,
              },
            },
            tooltip: {
              callbacks: {
                label: (ctx) => {
                  const count = ctx.raw ?? 0;
                  const total = totals[ctx.dataIndex] || 0;
                  const pct = total > 0 ? Math.round((count / total) * 100) : 0;
                  return `${ctx.dataset.label}: ${count} (${pct}% of repo total)`;
                },
              },
            },
          },
          scales: {
            x: {
              stacked: true,
              ticks: {
                color: themeColor("--text-dim"),
                font: { family: "'JetBrains Mono', monospace", size: 10 },
                maxRotation: 45,
              },
              grid: { color: themeColor("--surface-raised") },
            },
            y: {
              stacked: true,
              ticks: {
                color: themeColor("--text-dim"),
                font: { family: "'JetBrains Mono', monospace", size: 10 },
              },
              grid: { color: themeColor("--surface-raised") },
            },
          },
        },
      });
    } catch (_err) {
      showError("Failed to render merged PRs chart");
    }
  }

  function drawMergedPrsTrendChart(trendRows, repoFilter) {
    const canvas = document.getElementById("merged-prs-trend-chart");
    if (!canvas) return;
    const ctx = canvas.getContext("2d");

    if (mergedPrsTrendChart) {
      mergedPrsTrendChart.destroy();
      mergedPrsTrendChart = window.mergedPrsTrendChart = null;
    }

    const rows = repoFilter
      ? (trendRows || []).filter((r) => r.repo === repoFilter)
      : trendRows || [];
    const periods = [...new Set(rows.map((r) => r.period))].sort();

    if (periods.length === 0) {
      ctx.font = "14px var(--mono)";
      ctx.fillStyle = themeColor("--text-dim");
      ctx.textAlign = "center";
      ctx.fillText(
        "No data for this period",
        canvas.width / 2,
        canvas.height / 2,
      );
      return;
    }

    const datasets = ORIGIN_KEYS.map((origin) => {
      const values = periods.map((period) =>
        rows
          .filter((r) => r.period === period)
          .reduce((sum, r) => sum + (r.byOrigin?.[origin] ?? 0), 0),
      );
      return makeDataset(originLabel(origin), values, ORIGIN_COLORS[origin]);
    });

    try {
      mergedPrsTrendChart = window.mergedPrsTrendChart = new Chart(ctx, {
        type: "line",
        data: { labels: periods, datasets },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: {
              labels: {
                color: themeColor("--text"),
                font: { family: "'JetBrains Mono', monospace", size: 11 },
                boxWidth: 12,
              },
            },
          },
          scales: {
            x: {
              ticks: {
                color: themeColor("--text-dim"),
                font: { family: "'JetBrains Mono', monospace", size: 10 },
                maxRotation: 45,
              },
              grid: { color: themeColor("--surface-raised") },
            },
            y: {
              ticks: {
                color: themeColor("--text-dim"),
                font: { family: "'JetBrains Mono', monospace", size: 10 },
              },
              grid: { color: themeColor("--surface-raised") },
            },
          },
        },
      });
    } catch (_err) {
      showError("Failed to render merged PRs trend chart");
    }
  }

  // ─── Coverage by Repo (CVT-3.2) ──────────────────────────────────────────

  const COVERAGE_COLORS = [
    "#4f46e5",
    "#00ccaa",
    "#cc8844",
    "#cc44aa",
    "#4488ff",
    "#888888",
  ];

  // Signed percentage-point change; null (single snapshot) renders an em dash.
  function fmtCoverageDelta(delta) {
    if (delta === null || delta === undefined) return { text: "—", cls: "" };
    const n = Number(delta);
    const fixed = n.toFixed(1);
    if (Number(fixed) === 0) return { text: "0.0 pp", cls: "" };
    return n > 0
      ? { text: `+${fixed} pp`, cls: "good" }
      : { text: `${fixed} pp`, cls: "critical" };
  }

  // One dataset per repo (or only the picked repo), one point per snapshot.
  // Labels are the sorted distinct snapshot timestamps; a repo without a
  // snapshot at a label gets null there (spanGaps joins its line).
  function buildCoverageTrend(trendRows, repoFilter) {
    const rows = repoFilter
      ? (trendRows || []).filter((r) => r.repo === repoFilter)
      : trendRows || [];
    const times = [...new Set(rows.map((r) => r.measuredAt))].sort();
    const repos = [...new Set(rows.map((r) => r.repo))].sort();
    const datasets = repos.map((repo, i) => {
      const byTime = new Map(
        rows
          .filter((r) => r.repo === repo)
          .map((r) => [r.measuredAt, r.linesPct]),
      );
      return {
        ...makeDataset(
          repo,
          times.map((t) => (byTime.has(t) ? byTime.get(t) : null)),
          COVERAGE_COLORS[i % COVERAGE_COLORS.length],
        ),
        spanGaps: true,
      };
    });
    return {
      labels: times.map((t) => t.slice(0, 16).replace("T", " ")),
      datasets,
    };
  }

  function destroyCoverageChart() {
    if (coverageTrendChart) {
      coverageTrendChart.destroy();
      coverageTrendChart = window.coverageTrendChart = null;
    }
  }

  function populateCoverageRepoSelect(repos) {
    const picker = document.getElementById("coverage-repo-picker");
    const select = document.getElementById("coverage-repo-select");
    if (!picker || !select) return;
    if (!repos || repos.length <= 1) {
      picker.style.display = "none";
      select.innerHTML = "";
      return;
    }
    const previousValue = select.value;
    select.innerHTML = "";
    const allOption = document.createElement("option");
    allOption.value = "";
    allOption.textContent = "All repos";
    select.appendChild(allOption);
    for (const r of repos) {
      const opt = document.createElement("option");
      opt.value = r.repo;
      opt.textContent = r.repo;
      select.appendChild(opt);
    }
    select.value = repos.some((r) => r.repo === previousValue)
      ? previousValue
      : "";
    picker.style.display = "";
  }

  function renderCoverageTable(repos) {
    const tbody = document.getElementById("coverage-tbody");
    if (!tbody) return;
    tbody.innerHTML = "";
    for (const r of repos) {
      const tr = document.createElement("tr");
      tr.dataset.repo = r.repo;
      if (r.stale) tr.classList.add("coverage-row-stale");
      const cells = [r.repo, `${fmtNum(r.linesPct)}%`];
      for (const text of cells) {
        const td = document.createElement("td");
        td.textContent = text;
        tr.appendChild(td);
      }
      const delta = fmtCoverageDelta(r.deltaVsPrevious);
      const deltaTd = document.createElement("td");
      deltaTd.textContent = delta.text;
      if (delta.cls) deltaTd.classList.add(`stat-value`, delta.cls);
      tr.appendChild(deltaTd);
      const dateTd = document.createElement("td");
      dateTd.textContent = String(r.measuredAt).slice(0, 10);
      if (r.stale) {
        const badge = document.createElement("span");
        badge.className = "coverage-stale-badge";
        badge.textContent = "stale";
        badge.title = "Last measured more than 14 days ago";
        dateTd.appendChild(badge);
      }
      tr.appendChild(dateTd);
      tbody.appendChild(tr);
    }
  }

  function drawCoverageTrendChart(trendRows, repoFilter) {
    const canvas = document.getElementById("coverage-trend-chart");
    if (!canvas) return;
    destroyCoverageChart();
    const { labels, datasets } = buildCoverageTrend(trendRows, repoFilter);
    // The repo table is range-independent but the trend is not: a range with
    // no snapshots (e.g. "today" before any CI run) would otherwise leave a
    // blank canvas, so swap it for an explicit message.
    const hasTrend = datasets.length > 0;
    const trendEmptyEl = document.getElementById("coverage-trend-empty");
    if (canvas.parentElement) {
      canvas.parentElement.style.display = hasTrend ? "" : "none";
    }
    if (trendEmptyEl) trendEmptyEl.style.display = hasTrend ? "none" : "";
    if (!hasTrend) return;
    const tickStyle = {
      color: themeColor("--text-dim"),
      font: { family: "'JetBrains Mono', monospace", size: 10 },
    };
    try {
      coverageTrendChart = window.coverageTrendChart = new Chart(
        canvas.getContext("2d"),
        {
          type: "line",
          data: { labels, datasets },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
              legend: {
                labels: {
                  color: themeColor("--text"),
                  font: { family: "'JetBrains Mono', monospace", size: 11 },
                  boxWidth: 12,
                },
              },
            },
            scales: {
              x: {
                ticks: { ...tickStyle, maxRotation: 45 },
                grid: { color: themeColor("--surface-raised") },
              },
              y: {
                ticks: tickStyle,
                grid: { color: themeColor("--surface-raised") },
              },
            },
          },
        },
      );
    } catch (_err) {
      showError("Failed to render coverage trend chart");
    }
  }

  function updateCoverage(res) {
    const contentEl = document.getElementById("coverage-content");
    const emptyEl = document.getElementById("coverage-empty");
    if (!contentEl) return;

    const data = res && !res.error ? res.data : null;
    const repos = data?.repos ?? [];
    lastCoverageTrend = data?.trend ?? [];

    if (!data || repos.length === 0) {
      contentEl.style.display = "none";
      if (emptyEl) emptyEl.style.display = "";
      destroyCoverageChart();
      return;
    }

    contentEl.style.display = "";
    if (emptyEl) emptyEl.style.display = "none";
    renderCoverageTable(repos);
    populateCoverageRepoSelect(repos);
    const select = document.getElementById("coverage-repo-select");
    drawCoverageTrendChart(lastCoverageTrend, select ? select.value : "");
  }

  function initCoverageRepoSelect() {
    const select = document.getElementById("coverage-repo-select");
    if (!select) return;
    select.addEventListener("change", () => {
      drawCoverageTrendChart(lastCoverageTrend, select.value);
    });
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
      ctx.fillStyle = themeColor("--text-dim");
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
                color: themeColor("--text"),
                font: { family: "'JetBrains Mono', monospace", size: 11 },
                boxWidth: 12,
              },
            },
          },
          scales: {
            x: {
              ticks: {
                color: themeColor("--text-dim"),
                font: { family: "'JetBrains Mono', monospace", size: 10 },
                maxRotation: 45,
              },
              grid: { color: themeColor("--surface-raised") },
            },
            y: {
              ticks: {
                color: themeColor("--text-dim"),
                font: { family: "'JetBrains Mono', monospace", size: 10 },
              },
              grid: { color: themeColor("--surface-raised") },
            },
          },
        },
      });
    } catch (_err) {
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
      ctx.fillStyle = themeColor("--text-dim");
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
                color: themeColor("--text"),
                font: { family: "'JetBrains Mono', monospace", size: 11 },
                boxWidth: 12,
              },
            },
          },
          scales: {
            x: {
              ticks: {
                color: themeColor("--text-dim"),
                font: { family: "'JetBrains Mono', monospace", size: 10 },
                maxRotation: 45,
              },
              grid: { color: themeColor("--surface-raised") },
            },
            y: {
              ticks: {
                color: themeColor("--text-dim"),
                font: { family: "'JetBrains Mono', monospace", size: 10 },
              },
              grid: { color: themeColor("--surface-raised") },
            },
          },
        },
      });
    } catch (_err) {
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
    "shipwright-prs-merged": {
      label: "Shipwright PRs Merged",
      series: (r) => r.shipwrightPrsMerged,
      fmt: fmtInt,
    },
    "review-ship-it": {
      label: "Review SHIP IT Rate",
      numerator: (r) => r.reviewsShipIt,
      denominator: (r) => r.reviews,
      fmt: fmtPct,
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
          datasets: [makeDataset(entry.label, data, themeColor("--accent"))],
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
                color: themeColor("--text-dim"),
                font: { family: "'JetBrains Mono', monospace", size: 10 },
                maxRotation: 45,
              },
              grid: { color: themeColor("--surface-raised") },
            },
            y: {
              ticks: {
                color: themeColor("--text-dim"),
                font: { family: "'JetBrains Mono', monospace", size: 10 },
              },
              grid: { color: themeColor("--surface-raised") },
            },
          },
        },
      });
    } catch (_err) {
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

  // ─── System crons (SCM-8.4) ──────────────────────────────────────────────

  /**
   * Maps a FilteredCount.filter (task-store GET /tasks params, plus the
   * metrics-side `bucket` / `sourceNot` derivation rules) to an admin tasks
   * list URL. Pure.
   *
   * Params the admin /admin/tasks route honors today: `source`, `status`
   * (plus `repo`, `org`, `session`, `hitl`, `kind`, `owner`, `view`).
   * Params it does NOT yet honor: `originKind`, `originRef`, `createdFrom`,
   * `createdTo`, `sourceNot` and `bucket`. They are still forwarded verbatim so
   * the URL fully describes the row set and starts narrowing as soon as the
   * admin list reads them; until then the list shows the wider
   * source/status-filtered set. `view=table` (the default board hides closed
   * tasks, which shipped rows are) and `owner=all` (skip the Mine default)
   * are added so the list is not silently narrowed.
   */
  function buildAdminTasksHref(adminBase, filter) {
    const params = new URLSearchParams({ view: "table", owner: "all" });
    for (const [k, v] of Object.entries(filter ?? {})) params.set(k, v);
    return `${String(adminBase ?? "").replace(/\/+$/, "")}/admin/tasks?${params.toString()}`;
  }

  function fmtAsOfMeta(meta) {
    const n = meta?.repoCount ?? 0;
    return `${n} ${n === 1 ? "repo" : "repos"}`;
  }

  function countLink(label, fc, cls, field) {
    const a = document.createElement("a");
    a.className = cls;
    a.dataset.field = field;
    a.textContent = fmtInt(fc?.count);
    a.href = buildAdminTasksHref(window.__ADMIN_BASE__ || "", fc?.filter);
    a.title = `${label}: ${fmtInt(fc?.count)}`;
    return a;
  }

  function renderSystemCronsTable(crons) {
    const tbody = document.getElementById("system-crons-tbody");
    if (!tbody) return;
    tbody.innerHTML = "";
    for (const c of crons) {
      const tr = document.createElement("tr");
      tr.dataset.cron = c.id;
      const nameTd = document.createElement("td");
      nameTd.textContent = c.name || c.id;
      if (!c.enabled) nameTd.title = "disabled";
      tr.appendChild(nameTd);

      const lead = document.createElement("td");
      lead.appendChild(
        countLink("Shipped", c.buckets.shipped, "stat-value good", "shipped"),
      );
      tr.appendChild(lead);
      for (const key of ["stuck", "failed"]) {
        const td = document.createElement("td");
        const cls = c.buckets[key].count > 0 ? "stat-value warn" : "stat-value";
        td.appendChild(countLink(key, c.buckets[key], cls, key));
        tr.appendChild(td);
      }

      const fo = document.createElement("td");
      fo.appendChild(
        countLink(
          "Follow-ons created",
          c.followOn.created,
          "stat-value",
          "followOnCreated",
        ),
      );
      fo.appendChild(document.createTextNode(" / "));
      fo.appendChild(
        countLink(
          "Follow-ons shipped",
          c.followOn.shipped,
          "stat-value",
          "followOnShipped",
        ),
      );
      tr.appendChild(fo);

      const other = document.createElement("td");
      other.className = "stat-label";
      [
        ["noOp", "no-op"],
        ["inFlight", "in flight"],
        ["pending", "pending"],
      ].forEach(([key, label], i) => {
        if (i > 0) other.appendChild(document.createTextNode(" \u00b7 "));
        other.appendChild(document.createTextNode(`${label} `));
        other.appendChild(countLink(label, c.buckets[key], "stat-label", key));
      });
      tr.appendChild(other);
      tbody.appendChild(tr);
    }
  }

  function updateSystemCrons(res) {
    const contentEl = document.getElementById("system-crons-content");
    const emptyEl = document.getElementById("system-crons-empty");
    const metaEl = document.getElementById("system-crons-meta");
    if (!contentEl || !emptyEl) return;
    if (!res || res.error || !Array.isArray(res.crons)) {
      if (res?.error) console.error("System crons error:", res.error);
      contentEl.style.display = "none";
      emptyEl.style.display = "none";
      if (metaEl) metaEl.textContent = "";
      return;
    }
    const empty = res.crons.length === 0;
    contentEl.style.display = empty ? "none" : "";
    emptyEl.style.display = empty ? "" : "none";
    if (metaEl) {
      metaEl.textContent = `${fmtAsOfMeta(res.meta)} \u00b7 as of `;
      const asOf = document.createElement("span");
      asOf.id = "system-crons-asof";
      metaEl.appendChild(asOf);
      updateFreshness(res.meta?.generatedAt, "system-crons-asof");
    }
    renderSystemCronsTable(res.crons);
  }

  // ─── Main Refresh ─────────────────────────────────────────────────────────

  async function refresh() {
    setLoading(true);
    try {
      const {
        summary,
        trends,
        featuresRes,
        tokensRes,
        mergedPrsRes,
        coverageRes,
        systemCronsRes,
        costEffRes,
      } = await fetchAll(currentRange);
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
      if (tokensRes && !tokensRes.error && tokensRes.data) {
        lastTokensTrends = tokensRes.data.trends ?? [];
      }
      updateTokens(tokensRes);
      renderTokenTrendsChart(lastTokensTrends, activeTokenSeries);
      updateMergedPrs(mergedPrsRes);
      if (mergedPrsRes && !mergedPrsRes.error && mergedPrsRes.data) {
        const fleetStats = computeFleetWeightedAvgCommits(
          mergedPrsRes.data.repos ?? [],
        );
        updatePRCommits(fleetStats);
      } else {
        updatePRCommits(null);
      }
      updateCoverage(coverageRes);
      updateSystemCrons(systemCronsRes);
      updateCostEfficiency(costEffRes);
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

  // ─── Commits-per-PR aggregation (CPP-1.4) ───────────────────────────────────

  /**
   * Compute fleet-wide weighted-average commits-per-PR, weighting each repo by
   * its shipwright origin count (byOrigin.shipwright). Skips repos with zero
   * shipwright PRs or null avgCommitCount, returning null if no qualifying repos.
   *
   * @param {Array} repos - Array of repo objects from /metrics/merged-prs
   * @returns {Object} { avgCommitCount, commitBreakdown } or both null
   */
  function computeFleetWeightedAvgCommits(repos) {
    if (!repos || repos.length === 0) {
      return { avgCommitCount: null, commitBreakdown: null };
    }

    // Filter to repos with qualifying data: shipwright PRs + non-null avgCommitCount
    const qualifying = repos.filter(
      (r) =>
        (r.byOrigin?.shipwright ?? 0) > 0 &&
        r.avgCommitCount !== null &&
        r.avgCommitCount !== undefined,
    );

    if (qualifying.length === 0) {
      return { avgCommitCount: null, commitBreakdown: null };
    }

    // Compute weights (shipwright PR counts)
    let totalWeight = 0;
    qualifying.forEach((r) => {
      totalWeight += r.byOrigin?.shipwright ?? 0;
    });

    if (totalWeight === 0) {
      return { avgCommitCount: null, commitBreakdown: null };
    }

    // Weighted average of avgCommitCount
    let weightedAvgCommits = 0;
    qualifying.forEach((r) => {
      const weight = r.byOrigin?.shipwright ?? 0;
      weightedAvgCommits += r.avgCommitCount * weight;
    });
    weightedAvgCommits = weightedAvgCommits / totalWeight;

    // Weighted average of commitBreakdown fields
    const phases = ["docsRefresh", "reviewPatch", "ciFix", "implementation"];
    const weightedBreakdown = {};
    phases.forEach((phase) => {
      let weighted = 0;
      qualifying.forEach((r) => {
        const weight = r.byOrigin?.shipwright ?? 0;
        weighted += (r.commitBreakdown?.[phase] ?? 0) * weight;
      });
      weightedBreakdown[phase] = weighted / totalWeight;
    });

    return {
      avgCommitCount: weightedAvgCommits,
      commitBreakdown: weightedBreakdown,
    };
  }

  // ─── Boot ─────────────────────────────────────────────────────────────────

  // Guarded so this file can be `import`-ed under bun:test (no DOM globals)
  // purely to reach the pure fetchSequential helper below — see the test-only
  // export block at the bottom of this IIFE.
  if (typeof window !== "undefined") {
    document.addEventListener("DOMContentLoaded", () => {
      const activeBtn = document.querySelector(".date-btn.active");
      if (activeBtn) currentRange = rangeFromButton(activeBtn);
      initThemeToggle();
      initDateRangePicker();
      initMetricClicks();
      initTokenTrendsToggles();
      initMergedPrsRepoSelect();
      initCoverageRepoSelect();
      refresh();
    });
  } else {
    // Test-only escape hatch: app.js is loaded as a plain (non-module)
    // browser <script>, so it can't use `export`. Under bun:test there's no
    // `window`, so instead of booting the dashboard we expose the pure,
    // DOM-free fetchSequential helper on globalThis for
    // app.unit.test.js to import and exercise directly.
    globalThis.__dashboardAppTestExports = {
      fetchSequential,
      computeFleetWeightedAvgCommits,
      buildCoverageTrend,
      fmtCoverageDelta,
      buildAdminTasksHref,
      fmtAsOfMeta,
      resolveTheme,
      nextTheme,
    };
  }
})();
