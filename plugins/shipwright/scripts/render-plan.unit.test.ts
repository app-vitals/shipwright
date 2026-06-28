/**
 * plugins/shipwright/scripts/render-plan.unit.test.ts
 *
 * Unit tests for the markdown section parser and table parser used by
 * render-plan.ts. Focuses on MALFORMED / degenerate input — the parsers
 * must degrade to empty/sensible defaults and never throw.
 */

import { describe, expect, test } from "bun:test";
import {
  openCommand,
  parseMarkdownTable,
  parsePlan,
  parseSections,
  parseSpec,
  shouldOpenLocally,
} from "./render-plan.ts";

// ---------------------------------------------------------------------------
// parseSections
// ---------------------------------------------------------------------------

describe("parseSections — malformed input", () => {
  test("empty string yields no sections and does not throw", () => {
    expect(parseSections("")).toEqual([]);
  });

  test("whitespace-only string yields no sections", () => {
    expect(parseSections("   \n\n  \t\n")).toEqual([]);
  });

  test("heading with no body yields a section with empty body", () => {
    const sections = parseSections("## Lonely Heading\n");
    expect(sections.length).toBe(1);
    expect(sections[0].heading).toBe("Lonely Heading");
    expect(sections[0].level).toBe(2);
    expect(sections[0].body.trim()).toBe("");
  });

  test("body before the first heading is ignored, not crashed on", () => {
    const sections = parseSections("preamble prose\n\n## Real Heading\nbody");
    expect(sections.length).toBe(1);
    expect(sections[0].heading).toBe("Real Heading");
  });

  test("handles CRLF line endings", () => {
    const sections = parseSections("## H1\r\nbody one\r\n## H2\r\nbody two");
    expect(sections.length).toBe(2);
    expect(sections[0].heading).toBe("H1");
    expect(sections[1].heading).toBe("H2");
    expect(sections[0].body).toContain("body one");
  });
});

// ---------------------------------------------------------------------------
// parseMarkdownTable
// ---------------------------------------------------------------------------

describe("parseMarkdownTable — malformed input", () => {
  test("empty block yields no rows", () => {
    expect(parseMarkdownTable("")).toEqual([]);
  });

  test("header + separator but no data rows yields no rows", () => {
    const block = "| ID | Title |\n|----|-------|\n";
    expect(parseMarkdownTable(block)).toEqual([]);
  });

  test("a row with fewer cells than the header degrades — missing cols are empty", () => {
    const block = ["| ID | Title | Layer |", "|----|-------|-------|", "| A-1 | Only two |"].join(
      "\n",
    );
    const rows = parseMarkdownTable(block);
    expect(rows.length).toBe(1);
    expect(rows[0].ID).toBe("A-1");
    expect(rows[0].Title).toBe("Only two");
    expect(rows[0].Layer).toBe("");
  });

  test("a row with more cells than the header ignores the extras", () => {
    const block = ["| ID | Title |", "|----|-------|", "| A-1 | T | extra | more |"].join("\n");
    const rows = parseMarkdownTable(block);
    expect(rows.length).toBe(1);
    expect(rows[0].ID).toBe("A-1");
    expect(rows[0].Title).toBe("T");
  });

  test("non-table text yields no rows and does not throw", () => {
    expect(parseMarkdownTable("just some prose\nwith no pipes")).toEqual([]);
  });

  test("columns are keyed by header name regardless of order", () => {
    const block = ["| Title | ID |", "|-------|----|", "| Hello | X-9 |"].join("\n");
    const rows = parseMarkdownTable(block);
    expect(rows[0].ID).toBe("X-9");
    expect(rows[0].Title).toBe("Hello");
  });
});

// ---------------------------------------------------------------------------
// parsePlan — degraded inputs
// ---------------------------------------------------------------------------

describe("parsePlan — degraded inputs", () => {
  test("empty markdown produces a PlanData with empty tasks and does not throw", () => {
    const plan = parsePlan("", {});
    expect(plan.tasks).toEqual([]);
    expect(plan.keyDecisions).toEqual([]);
    expect(typeof plan.date).toBe("string");
  });

  test("missing Task Table yields empty tasks", () => {
    const md = "# Plan: thing\nRepo: r\n\n## Technical Design\n\nSome design prose.";
    const plan = parsePlan(md, {});
    expect(plan.session).toBe("thing");
    expect(plan.repo).toBe("r");
    expect(plan.description).toContain("Some design prose");
    expect(plan.tasks).toEqual([]);
  });

  test("missing Repo: line yields empty repo, not a crash", () => {
    const md = "# Plan: thing\n\n## Technical Design\n\nDesign prose.";
    const plan = parsePlan(md, {});
    expect(plan.repo).toBe("");
  });

  test("session and repo overrides win", () => {
    const md = "# Plan: thing\nRepo: r\n";
    const plan = parsePlan(md, { session: "override-session", repo: "override-repo" });
    expect(plan.session).toBe("override-session");
    expect(plan.repo).toBe("override-repo");
  });

  test("deps dash markers are treated as no dependency", () => {
    const md = [
      "# Plan: t",
      "Repo: r",
      "## Task Table",
      "| ID | Title | Layer | Model | Hours | Deps |",
      "|----|-------|-------|-------|-------|------|",
      "| A-1 | First | API | sonnet | 2 | — |",
      "| A-2 | Second | API | sonnet | 1 | A-1 |",
    ].join("\n");
    const plan = parsePlan(md, {});
    expect(plan.tasks.length).toBe(2);
    expect(plan.tasks[0].dependencies).toEqual([]);
    expect(plan.tasks[1].dependencies).toEqual(["A-1"]);
    expect(plan.tasks[0].status).toBe("pending");
    expect(plan.tasks[0].hours).toBe(2);
  });

  test("non-numeric hours degrades to 0", () => {
    const md = [
      "# Plan: t",
      "## Task Table",
      "| ID | Title | Hours |",
      "|----|-------|-------|",
      "| A-1 | First | n/a |",
    ].join("\n");
    const plan = parsePlan(md, {});
    expect(plan.tasks[0].hours).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// parseSpec — degraded inputs
// ---------------------------------------------------------------------------

describe("parseSpec — degraded inputs", () => {
  test("empty markdown produces empty PlanData and does not throw", () => {
    const spec = parseSpec("", {});
    expect(spec.tasks).toEqual([]);
    expect(spec.keyDecisions).toEqual([]);
  });

  test("title comes from the H1 heading", () => {
    const spec = parseSpec("# My Spec Title\n\n## 1. Problem\n\nThe problem.", {});
    expect(spec.session).toBe("My Spec Title");
  });

  test("description pulls from a Problem/Context section", () => {
    const spec = parseSpec("# T\n\n## 1. Context & Problem\n\nThe core problem.", {});
    expect(spec.description).toContain("The core problem");
  });

  test("goals become keyDecisions, Non-Goals excluded", () => {
    const md = [
      "# T",
      "## 2. Goals",
      "1. **First goal** — do a thing.",
      "2. **Second goal** — do another.",
      "## 3. Non-Goals",
      "- Not this.",
    ].join("\n");
    const spec = parseSpec(md, {});
    expect(spec.keyDecisions.length).toBe(2);
    expect(spec.keyDecisions[0]).toContain("First goal");
    expect(spec.keyDecisions.join(" ")).not.toContain("Not this");
  });

  test("specs always have empty tasks", () => {
    const spec = parseSpec("# T\n## 2. Goals\n- x", {});
    expect(spec.tasks).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// shouldOpenLocally — context detection
// ---------------------------------------------------------------------------

describe("shouldOpenLocally — context detection", () => {
  test("no TTY → false (cloud / Slack context)", () => {
    expect(
      shouldOpenLocally({ platform: "darwin", isTTY: false, display: "" }),
    ).toBe(false);
    expect(
      shouldOpenLocally({ platform: "linux", isTTY: false, display: ":0" }),
    ).toBe(false);
  });

  test("TTY + darwin → true (no display var needed on macOS)", () => {
    expect(
      shouldOpenLocally({ platform: "darwin", isTTY: true, display: "" }),
    ).toBe(true);
  });

  test("TTY + linux + DISPLAY → true", () => {
    expect(
      shouldOpenLocally({ platform: "linux", isTTY: true, display: ":0" }),
    ).toBe(true);
  });

  test("TTY + linux + no DISPLAY → false", () => {
    expect(
      shouldOpenLocally({ platform: "linux", isTTY: true, display: "" }),
    ).toBe(false);
  });

  test("non-tty cloud → false regardless of platform", () => {
    expect(
      shouldOpenLocally({ platform: "win32", isTTY: false, display: "" }),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// openCommand — open-command selection
// ---------------------------------------------------------------------------

describe("openCommand — command selection", () => {
  test("darwin → open", () => {
    expect(openCommand("darwin")).toBe("open");
  });

  test("linux → xdg-open", () => {
    expect(openCommand("linux")).toBe("xdg-open");
  });

  test("win32 → null", () => {
    expect(openCommand("win32")).toBeNull();
  });

  test("other platforms → null", () => {
    expect(openCommand("freebsd")).toBeNull();
  });
});
