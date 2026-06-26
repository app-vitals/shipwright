/**
 * plugins/shipwright/scripts/render-plan-html.unit.test.ts
 *
 * Unit tests for renderPlanHtml() — verifies required HTML sections,
 * brand-fidelity invariants, self-containment, and print-safety.
 */

import { describe, expect, test } from "bun:test";
import { type PlanData, renderPlanHtml } from "./render-plan-html.ts";

// ---------------------------------------------------------------------------
// Fixture data
// ---------------------------------------------------------------------------

const FIXTURE: PlanData = {
  session: "test-session",
  repo: "app-vitals/shipwright",
  date: "2026-06-26",
  description: "Test plan for unit testing the HTML template",
  tasks: [
    {
      id: "T-1",
      title: "Write the thing",
      layer: "Frontend",
      dependencies: [],
      hours: 2,
      status: "in_progress",
      model: "sonnet",
    },
    {
      id: "T-2",
      title: "Connect the thing",
      layer: "API",
      dependencies: ["T-1"],
      hours: 3,
      status: "pending",
      model: "haiku",
    },
    {
      id: "T-3",
      title: "Ship the thing",
      layer: "Plugin",
      dependencies: ["T-1", "T-2"],
      hours: 1,
      status: "pending",
      model: "sonnet",
    },
  ],
  keyDecisions: [
    "Brand CSS inlined per plugin constraint",
    "In-memory TTL store for ephemeral MVP",
  ],
};

// ---------------------------------------------------------------------------
// Section presence
// ---------------------------------------------------------------------------

describe("renderPlanHtml — required sections", () => {
  let html: string;

  test("renders without throwing", () => {
    html = renderPlanHtml(FIXTURE);
    expect(typeof html).toBe("string");
    expect(html.length).toBeGreaterThan(500);
  });

  test("contains header with session name", () => {
    const html = renderPlanHtml(FIXTURE);
    expect(html).toContain("test-session");
  });

  test("contains header with repo name", () => {
    const html = renderPlanHtml(FIXTURE);
    expect(html).toContain("app-vitals/shipwright");
  });

  test("contains header with date", () => {
    const html = renderPlanHtml(FIXTURE);
    expect(html).toContain("2026-06-26");
  });

  test("contains stat cards section", () => {
    const html = renderPlanHtml(FIXTURE);
    expect(html).toContain("plan-stats");
  });

  test("stat cards show total task count", () => {
    const html = renderPlanHtml(FIXTURE);
    // 3 tasks in fixture
    expect(html).toContain(">3<");
  });

  test("stat cards show total estimated hours", () => {
    const html = renderPlanHtml(FIXTURE);
    // 2 + 3 + 1 = 6 hours
    expect(html).toContain(">6<");
  });

  test("contains task table section", () => {
    const html = renderPlanHtml(FIXTURE);
    expect(html).toContain("plan-tasks");
  });

  test("task table contains all task IDs", () => {
    const html = renderPlanHtml(FIXTURE);
    expect(html).toContain("T-1");
    expect(html).toContain("T-2");
    expect(html).toContain("T-3");
  });

  test("task table contains task titles", () => {
    const html = renderPlanHtml(FIXTURE);
    expect(html).toContain("Write the thing");
    expect(html).toContain("Connect the thing");
    expect(html).toContain("Ship the thing");
  });

  test("task table contains layer labels", () => {
    const html = renderPlanHtml(FIXTURE);
    expect(html).toContain("Frontend");
    expect(html).toContain("API");
    expect(html).toContain("Plugin");
  });

  test("contains dependency flow section", () => {
    const html = renderPlanHtml(FIXTURE);
    expect(html).toContain("plan-deps");
  });

  test("dependency flow lists tasks with dependencies", () => {
    const html = renderPlanHtml(FIXTURE);
    // T-2 depends on T-1 — both should appear in deps section
    expect(html).toContain("T-1");
    expect(html).toContain("T-2");
  });

  test("contains key decisions section", () => {
    const html = renderPlanHtml(FIXTURE);
    expect(html).toContain("plan-decisions");
  });

  test("key decisions text is present", () => {
    const html = renderPlanHtml(FIXTURE);
    expect(html).toContain("Brand CSS inlined per plugin constraint");
    expect(html).toContain("In-memory TTL store for ephemeral MVP");
  });

  test("contains footer", () => {
    const html = renderPlanHtml(FIXTURE);
    expect(html.toLowerCase()).toContain("<footer");
  });

  test("footer mentions Shipwright Harness", () => {
    const html = renderPlanHtml(FIXTURE);
    expect(html).toContain("Shipwright Harness");
  });
});

// ---------------------------------------------------------------------------
// Brand fidelity
// ---------------------------------------------------------------------------

describe("renderPlanHtml — brand fidelity", () => {
  test("contains brand green #34c77b (lowercase)", () => {
    const html = renderPlanHtml(FIXTURE).toLowerCase();
    expect(html).toContain("#34c77b");
  });

  test("contains navy background #080e1e (lowercase)", () => {
    const html = renderPlanHtml(FIXTURE).toLowerCase();
    expect(html).toContain("#080e1e");
  });

  test("contains Space Grotesk font reference", () => {
    const html = renderPlanHtml(FIXTURE);
    expect(html).toContain("Space Grotesk");
  });

  test("contains JetBrains Mono font reference", () => {
    const html = renderPlanHtml(FIXTURE);
    expect(html).toContain("JetBrains Mono");
  });

  test("uses brand name 'Shipwright Harness' (not bare lowercase)", () => {
    const html = renderPlanHtml(FIXTURE);
    expect(html).toContain("Shipwright Harness");
  });

  test("does not contain off-brand orange color", () => {
    // Orange is not in the brand palette — check common orange hex values
    const html = renderPlanHtml(FIXTURE).toLowerCase();
    expect(html).not.toContain("#ff6600");
    expect(html).not.toContain("#f97316");
    expect(html).not.toContain("#ea580c");
  });

  test("contains gradient for headline", () => {
    const html = renderPlanHtml(FIXTURE);
    // Brand gradient uses green -> cyan
    expect(html).toContain("#34c77b");
    expect(html).toContain("#22d3ee");
  });

  test("contains dual glow orbs", () => {
    const html = renderPlanHtml(FIXTURE);
    expect(html).toContain("sw-orb-brand");
    expect(html).toContain("sw-orb-support");
  });
});

// ---------------------------------------------------------------------------
// Self-containment (no external brand file links)
// ---------------------------------------------------------------------------

describe("renderPlanHtml — self-contained", () => {
  test("does not link to brand.css", () => {
    const html = renderPlanHtml(FIXTURE);
    expect(html).not.toContain("brand.css");
  });

  test("does not contain <link rel=stylesheet> pointing to external brand files", () => {
    const html = renderPlanHtml(FIXTURE);
    // Should not have any stylesheet link (fonts via @import inside <style> is OK)
    const linkTags = html.match(/<link[^>]+rel=["']stylesheet["'][^>]*>/gi) ?? [];
    expect(linkTags.length).toBe(0);
  });

  test("CSS is inlined in <style> block", () => {
    const html = renderPlanHtml(FIXTURE);
    expect(html).toContain("<style>");
    // Inline CSS should reference the brand variables
    expect(html).toContain("--sw-color-bg-base");
  });
});

// ---------------------------------------------------------------------------
// Print safety
// ---------------------------------------------------------------------------

describe("renderPlanHtml — print safety", () => {
  test("contains @page rule", () => {
    const html = renderPlanHtml(FIXTURE);
    expect(html).toContain("@page");
  });

  test("contains print-color-adjust declaration", () => {
    const html = renderPlanHtml(FIXTURE);
    expect(html).toContain("print-color-adjust");
  });

  test("orbs are hidden on print", () => {
    const html = renderPlanHtml(FIXTURE);
    // There should be a print media block hiding orbs
    expect(html).toContain("@media print");
  });
});

// ---------------------------------------------------------------------------
// Status pill colors
// ---------------------------------------------------------------------------

describe("renderPlanHtml — status pill colors", () => {
  test("in_progress task uses progress color", () => {
    const html = renderPlanHtml(FIXTURE);
    // #4f8ef7 is the progress state color
    expect(html.toLowerCase()).toContain("#4f8ef7");
  });

  test("pending task uses pending color", () => {
    const html = renderPlanHtml(FIXTURE);
    // #475569 is the pending state color
    expect(html.toLowerCase()).toContain("#475569");
  });

  test("done/merged task uses success color", () => {
    const donePlan: PlanData = {
      ...FIXTURE,
      tasks: [{ ...FIXTURE.tasks[0], status: "merged" }],
    };
    const html = renderPlanHtml(donePlan);
    // success = brand green #34c77b
    expect(html.toLowerCase()).toContain("#34c77b");
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("renderPlanHtml — edge cases", () => {
  test("renders with empty tasks array", () => {
    const emptyPlan: PlanData = { ...FIXTURE, tasks: [] };
    const html = renderPlanHtml(emptyPlan);
    expect(html).toContain("plan-tasks");
    // stat card for 0 tasks
    expect(html).toContain(">0<");
  });

  test("renders with no key decisions", () => {
    const noDecisions: PlanData = { ...FIXTURE, keyDecisions: [] };
    const html = renderPlanHtml(noDecisions);
    // Should still render without error
    expect(html.length).toBeGreaterThan(500);
  });

  test("escapes HTML in task titles", () => {
    const xssPlan: PlanData = {
      ...FIXTURE,
      tasks: [
        {
          ...FIXTURE.tasks[0],
          title: "<script>alert('xss')</script>",
        },
      ],
    };
    const html = renderPlanHtml(xssPlan);
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;script&gt;");
  });

  test("escapes HTML in session name", () => {
    const xssPlan: PlanData = {
      ...FIXTURE,
      session: '<img src=x onerror="alert(1)">',
    };
    const html = renderPlanHtml(xssPlan);
    expect(html).not.toContain('<img src=x onerror=');
  });
});
