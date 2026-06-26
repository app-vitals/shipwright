/**
 * plugins/shipwright/scripts/render-plan-html.ts
 *
 * Renders a self-contained HTML document visualising a Shipwright plan or
 * product spec. All brand CSS is INLINED — the plugin cannot read brand/ at
 * runtime.
 *
 * Usage:
 *   import { renderPlanHtml } from "./render-plan-html.ts";
 *   const html = renderPlanHtml(planData);
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TaskStatus =
  | "pending"
  | "in_progress"
  | "pr_open"
  | "merged"
  | "done"
  | "blocked"
  | "cancelled";

export interface PlanTask {
  id: string;
  title: string;
  layer: string;
  dependencies: string[];
  hours: number;
  status: TaskStatus;
  model: string;
}

export interface PlanData {
  session: string;
  repo: string;
  date: string;
  description: string;
  tasks: PlanTask[];
  keyDecisions: string[];
}

// ---------------------------------------------------------------------------
// HTML escaping
// ---------------------------------------------------------------------------

function esc(raw: string): string {
  return raw
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ---------------------------------------------------------------------------
// Status pill
// ---------------------------------------------------------------------------

type PillStyle = { bg: string; color: string; label: string };

function statusPill(status: TaskStatus): PillStyle {
  switch (status) {
    case "merged":
    case "done":
      return { bg: "#0f2d1e", color: "#34c77b", label: status };
    case "in_progress":
    case "pr_open":
      return { bg: "#002244", color: "#4f8ef7", label: status.replace("_", " ") };
    case "blocked":
    case "cancelled":
      return { bg: "rgba(248,113,113,0.12)", color: "#f87171", label: status };
    default:
      return { bg: "rgba(71,85,105,0.25)", color: "#475569", label: "pending" };
  }
}

// ---------------------------------------------------------------------------
// Model pill
// ---------------------------------------------------------------------------

function modelPill(model: string): string {
  return `<span style="display:inline-block;padding:0.15rem 0.5rem;border-radius:9999px;font-family:'JetBrains Mono',ui-monospace,monospace;font-size:0.75rem;letter-spacing:0.04em;background:rgba(79,142,247,0.12);color:#4f8ef7;">${esc(model)}</span>`;
}

// ---------------------------------------------------------------------------
// Section: Header
// ---------------------------------------------------------------------------

function renderHeader(plan: PlanData): string {
  return `
    <header style="padding:2.5rem 0 1.5rem;border-bottom:1px solid #1e293b;margin-bottom:2rem;">
      <div style="display:flex;align-items:center;gap:0.75rem;margin-bottom:0.75rem;flex-wrap:wrap;">
        <span style="font-family:'JetBrains Mono',ui-monospace,monospace;font-size:0.8125rem;text-transform:uppercase;letter-spacing:0.08em;color:rgba(255,255,255,0.25);">Shipwright Harness</span>
        <span style="font-family:'JetBrains Mono',ui-monospace,monospace;font-size:0.8125rem;text-transform:uppercase;letter-spacing:0.08em;color:rgba(255,255,255,0.25);">·</span>
        <span style="display:inline-block;padding:0.2rem 0.7rem;border-radius:9999px;font-family:'JetBrains Mono',ui-monospace,monospace;font-size:0.75rem;letter-spacing:0.06em;text-transform:uppercase;background:#0f2d1e;color:#34c77b;">Plan</span>
      </div>
      <h1 style="font-family:'Space Grotesk',system-ui,sans-serif;font-size:2.25rem;font-weight:700;letter-spacing:-0.01em;line-height:1.15;margin:0 0 0.5rem;background:linear-gradient(135deg,#34c77b,#22d3ee);-webkit-background-clip:text;background-clip:text;color:transparent;">
        ${esc(plan.session)}
      </h1>
      <p style="margin:0 0 1rem;color:rgba(255,255,255,0.8);font-size:1rem;line-height:1.6;">${esc(plan.description)}</p>
      <div style="display:flex;gap:1.5rem;flex-wrap:wrap;">
        <span style="font-family:'JetBrains Mono',ui-monospace,monospace;font-size:0.8125rem;color:rgba(255,255,255,0.5);">
          <span style="color:rgba(255,255,255,0.25);text-transform:uppercase;letter-spacing:0.06em;font-size:0.75rem;">Repo&nbsp;</span>${esc(plan.repo)}
        </span>
        <span style="font-family:'JetBrains Mono',ui-monospace,monospace;font-size:0.8125rem;color:rgba(255,255,255,0.5);">
          <span style="color:rgba(255,255,255,0.25);text-transform:uppercase;letter-spacing:0.06em;font-size:0.75rem;">Date&nbsp;</span>${esc(plan.date)}
        </span>
      </div>
    </header>`;
}

// ---------------------------------------------------------------------------
// Section: Stat cards
// ---------------------------------------------------------------------------

function renderStatCards(plan: PlanData): string {
  const totalTasks = plan.tasks.length;
  const totalHours = plan.tasks.reduce((s, t) => s + t.hours, 0);
  const layers = [...new Set(plan.tasks.map((t) => t.layer))];

  function statCard(value: string | number, label: string, accent?: string): string {
    const valueStr = String(value);
    return `
      <div class="sw-card" style="background:#0f172a;border:1px solid #1e293b;border-radius:16px;padding:1.5rem;">
        <div style="font-family:'Space Grotesk',system-ui,sans-serif;font-size:3rem;font-weight:700;line-height:1.08;color:${accent ?? "#ffffff"};">${esc(valueStr)}</div>
        <div style="font-family:'JetBrains Mono',ui-monospace,monospace;font-size:0.8125rem;text-transform:uppercase;letter-spacing:0.08em;color:rgba(255,255,255,0.25);margin-top:0.25rem;">${esc(label)}</div>
      </div>`;
  }

  return `
    <section class="plan-stats" style="margin-bottom:2rem;">
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:1rem;">
        ${statCard(totalTasks, "Total Tasks", "#34c77b")}
        ${statCard(totalHours, "Est. Hours")}
        ${statCard(layers.length, "Layers")}
      </div>
    </section>`;
}

// ---------------------------------------------------------------------------
// Section: Design-by-layer grid
// ---------------------------------------------------------------------------

function renderLayerGrid(plan: PlanData): string {
  if (plan.tasks.length === 0) return "";

  const byLayer = new Map<string, PlanTask[]>();
  for (const task of plan.tasks) {
    const group = byLayer.get(task.layer) ?? [];
    group.push(task);
    byLayer.set(task.layer, group);
  }

  const cards = [...byLayer.entries()]
    .map(([layer, tasks]) => {
      const rows = tasks
        .map((t) => {
          const pill = statusPill(t.status);
          return `<div style="display:flex;align-items:center;gap:0.5rem;padding:0.4rem 0;border-bottom:1px solid #1e293b;">
            <span style="font-family:'JetBrains Mono',ui-monospace,monospace;font-size:0.8125rem;color:rgba(255,255,255,0.25);min-width:3.5rem;">${esc(t.id)}</span>
            <span style="flex:1;font-size:0.875rem;color:rgba(255,255,255,0.8);">${esc(t.title)}</span>
            <span style="display:inline-block;padding:0.15rem 0.5rem;border-radius:9999px;font-family:'JetBrains Mono',ui-monospace,monospace;font-size:0.72rem;letter-spacing:0.06em;text-transform:uppercase;background:${pill.bg};color:${pill.color};">${esc(pill.label)}</span>
          </div>`;
        })
        .join("");
      return `
        <div style="background:#0f172a;border:1px solid #1e293b;border-radius:16px;padding:1.25rem;">
          <div style="font-family:'JetBrains Mono',ui-monospace,monospace;font-size:0.8125rem;text-transform:uppercase;letter-spacing:0.08em;color:rgba(255,255,255,0.25);margin-bottom:0.75rem;">${esc(layer)}</div>
          ${rows}
        </div>`;
    })
    .join("");

  return `
    <section class="plan-layers" style="margin-bottom:2rem;">
      <h2 style="font-family:'Space Grotesk',system-ui,sans-serif;font-size:1.375rem;font-weight:600;color:#ffffff;margin:0 0 1rem;">By Layer</h2>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:1rem;">
        ${cards}
      </div>
    </section>`;
}

// ---------------------------------------------------------------------------
// Section: Task table
// ---------------------------------------------------------------------------

function renderTaskTable(plan: PlanData): string {
  const rows = plan.tasks
    .map((task) => {
      const pill = statusPill(task.status);
      const deps = task.dependencies.length > 0 ? task.dependencies.join(", ") : "—";
      return `
        <tr>
          <td style="font-family:'JetBrains Mono',ui-monospace,monospace;font-size:0.8125rem;color:rgba(255,255,255,0.5);white-space:nowrap;">${esc(task.id)}</td>
          <td style="color:rgba(255,255,255,0.8);">${esc(task.title)}</td>
          <td style="font-family:'JetBrains Mono',ui-monospace,monospace;font-size:0.8125rem;color:rgba(255,255,255,0.5);white-space:nowrap;">${esc(task.layer)}</td>
          <td style="font-family:'JetBrains Mono',ui-monospace,monospace;font-size:0.8125rem;color:rgba(255,255,255,0.35);">${esc(deps)}</td>
          <td style="font-family:'JetBrains Mono',ui-monospace,monospace;font-size:0.8125rem;color:rgba(255,255,255,0.5);text-align:right;white-space:nowrap;">${task.hours}h</td>
          <td><span style="display:inline-block;padding:0.15rem 0.5rem;border-radius:9999px;font-family:'JetBrains Mono',ui-monospace,monospace;font-size:0.72rem;letter-spacing:0.06em;text-transform:uppercase;background:${pill.bg};color:${pill.color};">${esc(pill.label)}</span></td>
          <td>${modelPill(task.model)}</td>
        </tr>`;
    })
    .join("");

  return `
    <section class="plan-tasks" style="margin-bottom:2rem;overflow-x:auto;">
      <h2 style="font-family:'Space Grotesk',system-ui,sans-serif;font-size:1.375rem;font-weight:600;color:#ffffff;margin:0 0 1rem;">Tasks</h2>
      <table style="width:100%;border-collapse:collapse;font-size:0.875rem;">
        <thead>
          <tr style="border-bottom:1px solid #1e293b;">
            <th style="text-align:left;font-family:'JetBrains Mono',ui-monospace,monospace;font-size:0.75rem;text-transform:uppercase;letter-spacing:0.08em;color:rgba(255,255,255,0.25);padding:0.5rem 0.75rem 0.5rem 0;white-space:nowrap;">ID</th>
            <th style="text-align:left;font-family:'JetBrains Mono',ui-monospace,monospace;font-size:0.75rem;text-transform:uppercase;letter-spacing:0.08em;color:rgba(255,255,255,0.25);padding:0.5rem 0.75rem;white-space:nowrap;">Title</th>
            <th style="text-align:left;font-family:'JetBrains Mono',ui-monospace,monospace;font-size:0.75rem;text-transform:uppercase;letter-spacing:0.08em;color:rgba(255,255,255,0.25);padding:0.5rem 0.75rem;white-space:nowrap;">Layer</th>
            <th style="text-align:left;font-family:'JetBrains Mono',ui-monospace,monospace;font-size:0.75rem;text-transform:uppercase;letter-spacing:0.08em;color:rgba(255,255,255,0.25);padding:0.5rem 0.75rem;white-space:nowrap;">Deps</th>
            <th style="text-align:right;font-family:'JetBrains Mono',ui-monospace,monospace;font-size:0.75rem;text-transform:uppercase;letter-spacing:0.08em;color:rgba(255,255,255,0.25);padding:0.5rem 0.75rem;white-space:nowrap;">Hrs</th>
            <th style="text-align:left;font-family:'JetBrains Mono',ui-monospace,monospace;font-size:0.75rem;text-transform:uppercase;letter-spacing:0.08em;color:rgba(255,255,255,0.25);padding:0.5rem 0.75rem;white-space:nowrap;">Status</th>
            <th style="text-align:left;font-family:'JetBrains Mono',ui-monospace,monospace;font-size:0.75rem;text-transform:uppercase;letter-spacing:0.08em;color:rgba(255,255,255,0.25);padding:0.5rem 0.75rem;white-space:nowrap;">Model</th>
          </tr>
        </thead>
        <tbody>
          ${rows}
        </tbody>
      </table>
    </section>`;
}

// ---------------------------------------------------------------------------
// Section: Dependency flow
// ---------------------------------------------------------------------------

function renderDependencyFlow(plan: PlanData): string {
  const tasksWithDeps = plan.tasks.filter((t) => t.dependencies.length > 0);
  const taskIndex = new Map(plan.tasks.map((t) => [t.id, t]));

  if (tasksWithDeps.length === 0) {
    return `
      <section class="plan-deps" style="margin-bottom:2rem;">
        <h2 style="font-family:'Space Grotesk',system-ui,sans-serif;font-size:1.375rem;font-weight:600;color:#ffffff;margin:0 0 1rem;">Dependencies</h2>
        <p style="color:rgba(255,255,255,0.35);font-family:'JetBrains Mono',ui-monospace,monospace;font-size:0.8125rem;">No dependencies — all tasks are independent.</p>
      </section>`;
  }

  const rows = tasksWithDeps
    .map((task) => {
      const arrows = task.dependencies
        .map((depId) => {
          const dep = taskIndex.get(depId);
          const depPill = dep ? statusPill(dep.status) : statusPill("pending");
          return `<span style="display:inline-flex;align-items:center;gap:0.4rem;margin-right:0.75rem;">
            <span style="display:inline-block;padding:0.15rem 0.5rem;border-radius:9999px;font-family:'JetBrains Mono',ui-monospace,monospace;font-size:0.72rem;letter-spacing:0.06em;background:${depPill.bg};color:${depPill.color};">${esc(depId)}</span>
            <span style="color:rgba(255,255,255,0.25);">→</span>
          </span>`;
        })
        .join("");
      const taskPill = statusPill(task.status);
      return `
        <div style="display:flex;align-items:center;gap:0.5rem;padding:0.6rem 0;border-bottom:1px solid #1e293b;flex-wrap:wrap;">
          <div style="display:flex;align-items:center;flex-wrap:wrap;gap:0.25rem;flex:1;">
            ${arrows}
          </div>
          <span style="display:inline-block;padding:0.15rem 0.5rem;border-radius:9999px;font-family:'JetBrains Mono',ui-monospace,monospace;font-size:0.72rem;letter-spacing:0.06em;text-transform:uppercase;background:${taskPill.bg};color:${taskPill.color};">${esc(task.id)}</span>
          <span style="font-size:0.875rem;color:rgba(255,255,255,0.6);">${esc(task.title)}</span>
        </div>`;
    })
    .join("");

  return `
    <section class="plan-deps" style="margin-bottom:2rem;">
      <h2 style="font-family:'Space Grotesk',system-ui,sans-serif;font-size:1.375rem;font-weight:600;color:#ffffff;margin:0 0 1rem;">Dependencies</h2>
      <div style="background:#0f172a;border:1px solid #1e293b;border-radius:16px;padding:1.25rem;">
        ${rows}
      </div>
    </section>`;
}

// ---------------------------------------------------------------------------
// Section: Key decisions callout
// ---------------------------------------------------------------------------

function renderKeyDecisions(plan: PlanData): string {
  if (plan.keyDecisions.length === 0) return "";

  const items = plan.keyDecisions
    .map(
      (d) =>
        `<li style="padding:0.35rem 0;color:rgba(255,255,255,0.8);">${esc(d)}</li>`,
    )
    .join("");

  return `
    <section class="plan-decisions" style="margin-bottom:2rem;">
      <div style="border-left:3px solid #34c77b;background:#0f2d1e;border-radius:10px;padding:1rem 1.25rem;">
        <div style="font-family:'JetBrains Mono',ui-monospace,monospace;font-size:0.8125rem;text-transform:uppercase;letter-spacing:0.08em;color:#34c77b;margin-bottom:0.75rem;">Key Decisions</div>
        <ul style="margin:0;padding-left:1.25rem;">
          ${items}
        </ul>
      </div>
    </section>`;
}

// ---------------------------------------------------------------------------
// Section: Footer
// ---------------------------------------------------------------------------

function renderFooter(plan: PlanData): string {
  return `
    <footer style="padding:1.5rem 0;border-top:1px solid #1e293b;margin-top:2rem;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:0.75rem;">
      <span style="font-family:'JetBrains Mono',ui-monospace,monospace;font-size:0.8125rem;color:rgba(255,255,255,0.25);">
        Generated by <span style="color:#34c77b;">Shipwright Harness</span>
      </span>
      <span style="font-family:'JetBrains Mono',ui-monospace,monospace;font-size:0.8125rem;color:rgba(255,255,255,0.25);">${esc(plan.date)}</span>
    </footer>`;
}

// ---------------------------------------------------------------------------
// Inlined brand CSS (from brand/brand.css — generated from tokens.json)
// ---------------------------------------------------------------------------

const BRAND_CSS = `
/* INLINE: Shipwright Harness brand CSS — from brand/tokens.json */
@import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap');

:root {
  color-scheme: dark;
  --sw-color-bg-base: #080e1e;
  --sw-color-bg-raised: #0f172a;
  --sw-color-bg-overlay: #1e293b;
  --sw-color-border-subtle: #1e293b;
  --sw-color-border-muted: #334155;
  --sw-color-border-strong: #475569;
  --sw-color-brand-default: #34c77b;
  --sw-color-brand-strong: #2bae6e;
  --sw-color-brand-soft: #0f2d1e;
  --sw-color-brand-on-brand-text: #080e1e;
  --sw-color-support-patriot: #002244;
  --sw-color-support-patriot-bright: #4f8ef7;
  --sw-color-support-cyan: #22d3ee;
  --sw-color-support-violet: #8b5cf6;
  --sw-color-text-heading: #ffffff;
  --sw-color-text-body: rgba(255, 255, 255, 0.8);
  --sw-color-text-editorial: rgba(255, 255, 255, 0.5);
  --sw-color-text-muted: rgba(255, 255, 255, 0.25);
  --sw-color-state-success: #34c77b;
  --sw-color-state-progress: #4f8ef7;
  --sw-color-state-pending: #475569;
  --sw-color-state-warning: #f5b544;
  --sw-color-state-danger: #f87171;
  --sw-gradient-brand: linear-gradient(135deg, #34c77b, #22d3ee);
  --sw-gradient-support: linear-gradient(135deg, #4f8ef7, #8b5cf6);
  --sw-gradient-deep: linear-gradient(135deg, #002244, #080e1e);
  --sw-glow-brand: rgba(52, 199, 123, 0.25);
  --sw-glow-support: rgba(79, 142, 247, 0.22);
  --sw-font-display: "Space Grotesk", system-ui, sans-serif;
  --sw-font-body: "General Sans", "DM Sans", system-ui, sans-serif;
  --sw-font-mono: "JetBrains Mono", ui-monospace, monospace;
  --sw-radius-sm: 6px;
  --sw-radius-md: 10px;
  --sw-radius-lg: 16px;
  --sw-radius-pill: 9999px;
  --sw-layout-max-width: 72rem;
  --sw-layout-section-padding-y: 6rem;
  --sw-layout-gutter: 1.5rem;
  --sw-text-display-xl-size: 4.5rem;
  --sw-text-display-xl-line: 1.05;
  --sw-text-display-xl-weight: 700;
  --sw-text-display-xl-tracking: -0.02em;
  --sw-text-display-l-size: 3rem;
  --sw-text-display-l-line: 1.08;
  --sw-text-display-l-weight: 700;
  --sw-text-display-l-tracking: -0.02em;
  --sw-text-h1-size: 2.25rem;
  --sw-text-h1-line: 1.15;
  --sw-text-h1-weight: 700;
  --sw-text-h1-tracking: -0.01em;
  --sw-text-h2-size: 1.75rem;
  --sw-text-h2-line: 1.2;
  --sw-text-h2-weight: 600;
  --sw-text-h2-tracking: -0.01em;
  --sw-text-h3-size: 1.375rem;
  --sw-text-h3-line: 1.25;
  --sw-text-h3-weight: 600;
  --sw-text-h3-tracking: 0;
  --sw-text-body-l-size: 1.125rem;
  --sw-text-body-l-line: 1.6;
  --sw-text-body-l-weight: 400;
  --sw-text-body-l-tracking: 0;
  --sw-text-body-size: 1rem;
  --sw-text-body-line: 1.6;
  --sw-text-body-weight: 400;
  --sw-text-body-tracking: 0;
  --sw-text-small-size: 0.875rem;
  --sw-text-small-line: 1.5;
  --sw-text-small-weight: 400;
  --sw-text-small-tracking: 0;
  --sw-text-label-size: 0.8125rem;
  --sw-text-label-line: 1.4;
  --sw-text-label-weight: 500;
  --sw-text-label-tracking: 0.08em;
}

*, *::before, *::after { box-sizing: border-box; }

body {
  margin: 0;
  background: var(--sw-color-bg-base);
  color: var(--sw-color-text-body);
  font-family: var(--sw-font-body);
  font-size: var(--sw-text-body-size);
  line-height: var(--sw-text-body-line);
  -webkit-font-smoothing: antialiased;
}
h1, h2, h3 {
  font-family: var(--sw-font-display);
  color: var(--sw-color-text-heading);
  margin: 0 0 0.5em;
}
h1 {
  font-size: var(--sw-text-h1-size);
  line-height: var(--sw-text-h1-line);
  font-weight: var(--sw-text-h1-weight);
  letter-spacing: var(--sw-text-h1-tracking);
}
h2 {
  font-size: var(--sw-text-h2-size);
  line-height: var(--sw-text-h2-line);
  font-weight: var(--sw-text-h2-weight);
  letter-spacing: var(--sw-text-h2-tracking);
}
h3 {
  font-size: var(--sw-text-h3-size);
  line-height: var(--sw-text-h3-line);
  font-weight: var(--sw-text-h3-weight);
}
a {
  color: var(--sw-color-support-patriot-bright);
  text-decoration: none;
}
a:hover { color: var(--sw-color-support-cyan); }
code, .sw-mono { font-family: var(--sw-font-mono); }

.sw-container {
  max-width: var(--sw-layout-max-width);
  margin: 0 auto;
  padding: 0 var(--sw-layout-gutter);
  position: relative;
}
.sw-display {
  font-family: var(--sw-font-display);
  font-size: var(--sw-text-display-xl-size);
  line-height: var(--sw-text-display-xl-line);
  font-weight: var(--sw-text-display-xl-weight);
  letter-spacing: var(--sw-text-display-xl-tracking);
  color: var(--sw-color-text-heading);
}
.sw-label {
  font-family: var(--sw-font-mono);
  text-transform: uppercase;
  letter-spacing: var(--sw-text-label-tracking);
  font-size: var(--sw-text-label-size);
  font-weight: var(--sw-text-label-weight);
  color: var(--sw-color-text-muted);
}
.sw-stat {
  font-family: var(--sw-font-display);
  font-size: var(--sw-text-display-l-size);
  line-height: var(--sw-text-display-l-line);
  font-weight: var(--sw-text-display-l-weight);
  color: var(--sw-color-text-heading);
}
.sw-muted { color: var(--sw-color-text-muted); }
.sw-editorial { color: var(--sw-color-text-editorial); }

.sw-btn {
  display: inline-block;
  padding: 0.75rem 1.25rem;
  border-radius: var(--sw-radius-md);
  background: var(--sw-color-brand-default);
  color: var(--sw-color-brand-on-brand-text);
  font-family: var(--sw-font-body);
  font-weight: 600;
  border: 0;
  cursor: pointer;
}
.sw-btn:hover { background: var(--sw-color-brand-strong); }
.sw-btn-secondary {
  background: transparent;
  color: var(--sw-color-text-heading);
  border: 1px solid var(--sw-color-border-strong);
}

.sw-card {
  background: var(--sw-color-bg-raised);
  border: 1px solid var(--sw-color-border-muted);
  border-radius: var(--sw-radius-lg);
  padding: 1.5rem;
}
.sw-callout {
  border-left: 3px solid var(--sw-color-brand-default);
  background: var(--sw-color-brand-soft);
  border-radius: var(--sw-radius-md);
  padding: 1rem 1.25rem;
}
.sw-callout-info {
  border-left-color: var(--sw-color-support-patriot-bright);
  background: color-mix(in srgb, var(--sw-color-support-patriot) 45%, transparent);
}
.sw-callout-warn {
  border-left-color: var(--sw-color-state-warning);
  background: color-mix(in srgb, var(--sw-color-state-warning) 12%, transparent);
}

.sw-pill {
  display: inline-block;
  padding: 0.2rem 0.6rem;
  border-radius: var(--sw-radius-pill);
  font-family: var(--sw-font-mono);
  font-size: var(--sw-text-label-size);
  text-transform: uppercase;
  letter-spacing: 0.06em;
}
.sw-pill-success { background: var(--sw-color-brand-soft); color: var(--sw-color-brand-default); }
.sw-pill-progress { background: var(--sw-color-support-patriot); color: var(--sw-color-support-patriot-bright); }

.sw-h1 {
  font-family: var(--sw-font-display);
  font-size: var(--sw-text-h1-size);
  line-height: var(--sw-text-h1-line);
  font-weight: var(--sw-text-h1-weight);
  letter-spacing: var(--sw-text-h1-tracking);
  color: var(--sw-color-text-heading);
}
.sw-code {
  background: var(--sw-color-bg-overlay);
  border-radius: var(--sw-radius-md);
  padding: 0.85rem 1rem;
  font-family: var(--sw-font-mono);
  color: var(--sw-color-text-body);
  overflow: auto;
}
.sw-gradient-text {
  background: var(--sw-gradient-brand);
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
}
.sw-orb {
  position: absolute;
  border-radius: 50%;
  filter: blur(80px);
  pointer-events: none;
  z-index: 0;
}
.sw-orb-brand { background: var(--sw-glow-brand); }
.sw-orb-support { background: var(--sw-glow-support); }

/* Plan-specific layout */
td, th { padding: 0.5rem 0.75rem; vertical-align: middle; }
tr:last-child td { border-bottom: none; }
`;

// ---------------------------------------------------------------------------
// Print CSS
// ---------------------------------------------------------------------------

const PRINT_CSS = `
@media print {
  .sw-orb { display: none !important; }
  @page { size: A4; margin: 1.5cm; }
  * { print-color-adjust: exact; -webkit-print-color-adjust: exact; }
  body { background: #080e1e !important; }
}
`;

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Render a complete, self-contained HTML document for a Shipwright plan.
 * All brand CSS is inlined — no external file references.
 */
export function renderPlanHtml(plan: PlanData): string {
  const title = `${esc(plan.session)} — Shipwright Harness Plan`;

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title}</title>
    <style>
${BRAND_CSS}
    </style>
  </head>
  <body>
    <!-- Dual glow orbs: dominant brand green + smaller support blue -->
    <div class="sw-orb sw-orb-brand" style="width:500px;height:500px;top:-150px;right:-100px;opacity:0.7;"></div>
    <div class="sw-orb sw-orb-support" style="width:280px;height:280px;bottom:80px;left:-80px;opacity:0.5;"></div>

    <div class="sw-container" style="padding-bottom:3rem;">
      ${renderHeader(plan)}
      ${renderStatCards(plan)}
      ${renderLayerGrid(plan)}
      ${renderTaskTable(plan)}
      ${renderDependencyFlow(plan)}
      ${renderKeyDecisions(plan)}
      ${renderFooter(plan)}
    </div>

    <style>
${PRINT_CSS}
    </style>
  </body>
</html>`;
}
