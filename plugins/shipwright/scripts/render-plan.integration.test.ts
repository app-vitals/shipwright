/**
 * plugins/shipwright/scripts/render-plan.integration.test.ts
 *
 * Integration tests: parse the committed PLAN.md and PRODUCT-SPEC.md fixtures
 * end-to-end into a full HTML document and assert the rendered output contains
 * the expected title, task rows, and dependency edges.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { renderPlanHtml } from "./render-plan-html.ts";
import { parsePlan, parseSpec } from "./render-plan.ts";

const FIXTURES = join(import.meta.dir, "test-helpers", "fixtures");

function readFixture(name: string): string {
  return readFileSync(join(FIXTURES, name), "utf-8");
}

// ---------------------------------------------------------------------------
// PLAN fixture
// ---------------------------------------------------------------------------

describe("render-plan integration — PLAN fixture", () => {
  const md = readFixture("sample-plan.md");
  const plan = parsePlan(md, {});
  const html = renderPlanHtml(plan);

  test("produces a complete HTML document", () => {
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("</html>");
  });

  test("renders the session title from '# Plan:'", () => {
    expect(plan.session).toBe("widget-dashboard");
    expect(html).toContain("widget-dashboard");
  });

  test("renders the repo from the Repo: line", () => {
    expect(plan.repo).toBe("example-app");
    expect(html).toContain("example-app");
  });

  test("parses every task row", () => {
    const ids = plan.tasks.map((t) => t.id);
    expect(ids).toEqual(["WID-1.1", "WID-1.2", "WID-1.3", "WID-2.1"]);
  });

  test("HTML contains each task ID and title", () => {
    for (const t of plan.tasks) {
      expect(html).toContain(t.id);
      expect(html).toContain(t.title);
    }
  });

  test("maps columns by header name (layer, model, hours)", () => {
    const card = plan.tasks.find((t) => t.id === "WID-1.2");
    expect(card?.layer).toBe("Frontend");
    expect(card?.model).toBe("sonnet");
    expect(card?.hours).toBe(4);
  });

  test("parses dependency edges and renders them", () => {
    const nav = plan.tasks.find((t) => t.id === "WID-2.1");
    expect(nav?.dependencies).toEqual(["WID-1.2", "WID-1.3"]);
    // The dependency-flow section renders dep ids as edges into WID-2.1.
    const depsSection = html.slice(html.indexOf("plan-deps"));
    expect(depsSection).toContain("WID-1.2");
    expect(depsSection).toContain("WID-1.3");
  });

  test("the '—' deps marker yields no dependencies", () => {
    const first = plan.tasks.find((t) => t.id === "WID-1.1");
    expect(first?.dependencies).toEqual([]);
  });

  test("description comes from the Technical Design prose", () => {
    expect(plan.description).toContain("widget dashboard");
  });

  test("key decisions are parsed", () => {
    expect(plan.keyDecisions.length).toBeGreaterThan(0);
    expect(html).toContain("plan-decisions");
  });
});

// ---------------------------------------------------------------------------
// SPEC fixture
// ---------------------------------------------------------------------------

describe("render-plan integration — SPEC fixture", () => {
  const md = readFixture("sample-spec.md");
  const spec = parseSpec(md, {});
  const html = renderPlanHtml(spec);

  test("produces a complete HTML document", () => {
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("</html>");
  });

  test("renders the spec title from the H1 heading", () => {
    expect(spec.session).toBe("Example Platform — Widget Analytics Service");
    expect(html).toContain("Widget Analytics Service");
  });

  test("description comes from the Context & Problem section", () => {
    expect(spec.description).toContain("durable record");
  });

  test("renders at least one goal string", () => {
    expect(spec.keyDecisions.length).toBeGreaterThanOrEqual(1);
    expect(spec.keyDecisions.join(" ")).toContain("Durable storage");
    expect(html).toContain("Durable storage");
  });

  test("a spec carries no task rows", () => {
    expect(spec.tasks).toEqual([]);
  });
});
