/**
 * render-plan-html.sample.ts
 *
 * Generates the sample render for visual review.
 * Run: bun plugins/shipwright/scripts/render-plan-html.sample.ts
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { type PlanData, renderPlanHtml } from "./render-plan-html.ts";

const FIXTURE: PlanData = {
  session: "one-pager-plan",
  repo: "app-vitals/shipwright",
  date: "2026-06-26",
  description:
    "Add visual plan/spec rendering: HTML template + task-store /docs endpoint for ephemeral hosting",
  tasks: [
    {
      id: "PV-1.1",
      title: "Shipwright-branded plan/spec HTML template",
      layer: "Frontend",
      dependencies: [],
      hours: 3,
      status: "in_progress",
      model: "sonnet",
    },
    {
      id: "PV-2.1",
      title: "task-store ephemeral /docs endpoint",
      layer: "API",
      dependencies: [],
      hours: 4,
      status: "pending",
      model: "sonnet",
    },
    {
      id: "PV-3.1",
      title: "plan-session --visual flag",
      layer: "Plugin",
      dependencies: ["PV-1.1", "PV-2.1"],
      hours: 2,
      status: "pending",
      model: "haiku",
    },
  ],
  keyDecisions: [
    "Brand CSS inlined per plugin constraint (no filesystem access at runtime)",
    "In-memory /docs TTL store — single-replica acceptable for ephemeral MVP",
    "plan-session flag is --visual, not --html, to match existing CLI conventions",
  ],
};

const html = renderPlanHtml(FIXTURE);
const outPath = join(import.meta.dir, "render-plan-html.sample.html");
writeFileSync(outPath, html, "utf-8");
console.log(`Sample written to: ${outPath}`);
