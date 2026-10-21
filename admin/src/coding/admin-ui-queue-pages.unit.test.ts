/**
 * admin/src/coding/admin-ui-queue-pages.unit.test.ts
 * Pure unit tests for the Queue & Activity render functions in
 * admin-ui-queue-pages.ts (relocated from admin-ui-pages.unit.test.ts,
 * AEP-3.2).
 *
 * Strategy: call render functions directly, assert on returned HTML strings.
 * No I/O, no Hono, no HTTP — pure string → string.
 */

import { describe, expect, test } from "bun:test";
import {
  buildMergedWorkQueueRows,
  type CronRunItem,
  type MergedWorkQueueRow,
  partitionCronsForActivityDisplay,
  renderMergedQueueActivityPage,
  renderQueueActivityPage,
  type WorkQueueItem,
  type WorkQueueSnapshotItem,
} from "./admin-ui-queue-pages.ts";

// ─── renderQueueActivityPage — Past section (cron run history) ─────────────
//
// AXR-3.1 merged the former standalone renderCronLogsPage into
// renderQueueActivityPage's "Past" section — outcome/skipped/skipReason/error
// rendering is unchanged from the pre-merge implementation, so these cases
// are adapted (not duplicated) from the original renderCronLogsPage suite.

describe("renderQueueActivityPage — Past section", () => {
  const CRON_AGENT = { id: "agent-123", name: "Test Agent" };
  const CRON = {
    id: "cron-456",
    name: "shipwright-loop",
    schedule: "*/5 * * * *",
  };
  const OTHER_CRON = {
    id: "cron-789",
    name: null,
    schedule: "*/15 * * * *",
  };
  // Named non-loop cron for filtering/dropdown tests
  const NAMED_NON_LOOP_CRON = {
    id: "cron-999",
    name: "status check",
    schedule: "0 * * * *",
  };

  function makeRun(overrides?: Partial<CronRunItem>): CronRunItem {
    return {
      startedAt: new Date("2026-06-01T10:00:00Z"),
      completedAt: new Date("2026-06-01T10:00:02Z"),
      outcome: "posted",
      skipped: false,
      skipReason: null,
      error: null,
      cron: CRON,
      modelBreakdown: [
        {
          model: "claude-sonnet-4-5",
          inputTokens: 1200,
          outputTokens: 340,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          costUsd: 0.001,
        },
      ],
      ...overrides,
    };
  }

  function render(
    runs: CronRunItem[],
    opts?: {
      filters?: { cronId?: string; outcome?: string };
      pagination?: { total: number; limit: number; page: number };
      crons?: { id: string; name: string | null; schedule: string }[];
      now?: Date;
    },
  ): string {
    return renderQueueActivityPage({
      agent: CRON_AGENT,
      snapshot: null,
      crons: opts?.crons ?? [CRON, OTHER_CRON, NAMED_NON_LOOP_CRON],
      runs,
      filters: opts?.filters ?? {},
      pagination: opts?.pagination ?? {
        total: runs.length,
        limit: 20,
        page: 1,
      },
      userName: "admin@example.com",
      timezone: "America/Los_Angeles",
      now: opts?.now,
    });
  }

  // ─── Grouping function tests (partitionCronsForActivityDisplay) ──────────

  test("partitionCronsForActivityDisplay: shipwright-loop cron appears in visibleCronIds", () => {
    const crons = [CRON, OTHER_CRON, NAMED_NON_LOOP_CRON];
    const result = partitionCronsForActivityDisplay(crons);
    expect(result.visibleCronIds.has(CRON.id)).toBe(true);
  });

  test("partitionCronsForActivityDisplay: non-shipwright-loop crons appear in collapsedCronIds", () => {
    const crons = [CRON, OTHER_CRON, NAMED_NON_LOOP_CRON];
    const result = partitionCronsForActivityDisplay(crons);
    expect(result.collapsedCronIds.has(OTHER_CRON.id)).toBe(true);
    expect(result.collapsedCronIds.has(NAMED_NON_LOOP_CRON.id)).toBe(true);
  });

  test("partitionCronsForActivityDisplay: shipwright-loop does not appear in collapsedCronIds", () => {
    const crons = [CRON, OTHER_CRON];
    const result = partitionCronsForActivityDisplay(crons);
    expect(result.collapsedCronIds.has(CRON.id)).toBe(false);
  });

  test("partitionCronsForActivityDisplay: empty crons returns empty sets", () => {
    const result = partitionCronsForActivityDisplay([]);
    expect(result.visibleCronIds.size).toBe(0);
    expect(result.collapsedCronIds.size).toBe(0);
  });

  // ─── Grouping behavior in renderQueueActivityPage ──────────────────────

  test("shipwright-loop run appears in the primary visible table", () => {
    const html = render([makeRun({ cron: CRON })]);
    const tbodyMatch = html.match(/<tbody>([\s\S]*?)<\/tbody>/);
    expect(tbodyMatch).not.toBeNull();
    // The primary tbody should contain the shipwright-loop run
    expect(tbodyMatch?.[1]).toContain("shipwright-loop");
  });

  test("non-shipwright-loop run appears in a collapsed <details> block, not in primary table", () => {
    const html = render([makeRun({ cron: OTHER_CRON })]);
    // The primary tbody should be empty or contain only empty-state
    const tbodyMatches = html.match(/<tbody>([\s\S]*?)<\/tbody>/g);
    expect(tbodyMatches).not.toBeNull();
    // First tbody (primary table) should not contain the non-loop cron run
    expect(tbodyMatches?.[0]).not.toContain("*/15 * * * *");
    // There should be a <details> block with the collapsed group
    expect(html).toContain('<details class="more-filters"');
    expect(html).toContain("<summary>");
  });

  test("collapsed <details> block has no 'open' attribute (collapsed by default)", () => {
    const html = render([makeRun({ cron: OTHER_CRON })]);
    const detailsMatch = html.match(/<details[^>]*>(?!.*open)/);
    expect(detailsMatch).not.toBeNull();
  });

  test("collapsed group summary contains the cron name or schedule", () => {
    const html = render([makeRun({ cron: NAMED_NON_LOOP_CRON })]);
    expect(html).toContain("<summary>");
    expect(html).toContain("status check");
  });

  test("collapsed group contains the run rows in a separate table", () => {
    const html = render([makeRun({ cron: OTHER_CRON })]);
    // Should have a <details> with a nested table
    expect(html).toContain('<details class="more-filters"');
    // Extract the details section
    const detailsMatch = html.match(/<details[^>]*>[\s\S]*?<\/details>/);
    expect(detailsMatch).not.toBeNull();
    // The details should contain a table
    expect(detailsMatch?.[0]).toContain('<table class="data-table">');
  });

  test("multiple runs from the same non-loop cron are in the same <details> group", () => {
    const run1 = makeRun({ cron: NAMED_NON_LOOP_CRON });
    const run2 = makeRun({
      cron: NAMED_NON_LOOP_CRON,
      startedAt: new Date("2026-06-02T10:00:00Z"),
    });
    const html = render([run1, run2]);
    // Count <details> blocks - should be exactly 1 for NAMED_NON_LOOP_CRON
    const detailsMatches = html.match(/<details/g);
    expect((detailsMatches ?? []).length).toBeGreaterThanOrEqual(1);
  });

  test("runs from different non-loop crons produce separate <details> blocks", () => {
    const run1 = makeRun({ cron: NAMED_NON_LOOP_CRON });
    const run2 = makeRun({
      cron: OTHER_CRON,
      startedAt: new Date("2026-06-02T10:00:00Z"),
    });
    const html = render([run1, run2]);
    // Should have 2 <details> blocks (one per non-loop cron)
    const detailsMatches = html.match(/<details/g);
    expect((detailsMatches ?? []).length).toBeGreaterThanOrEqual(2);
  });

  test("when no runs match filters, primary table shows empty state", () => {
    const html = render([]);
    expect(html).toContain("No runs");
  });

  test("filtering to a non-loop cron renders its runs in the primary table, not a collapsed block", () => {
    // filters.cronId narrows `runs` server-side to a single cron — the
    // visible/collapsed split must not re-hide those already-filtered runs
    // inside a closed <details> block (the bug this test guards against).
    const html = render([makeRun({ cron: OTHER_CRON })], {
      filters: { cronId: OTHER_CRON.id },
    });
    const tbodyMatch = html.match(/<tbody>([\s\S]*?)<\/tbody>/);
    expect(tbodyMatch).not.toBeNull();
    expect(tbodyMatch?.[1]).toContain("*/15 * * * *");
    expect(html).not.toContain("No runs match the selected filters.");
    expect(html).not.toContain('<details class="more-filters"');
  });

  test("renders the column headers", () => {
    const html = render([makeRun()]);
    expect(html).toContain("Outcome");
    expect(html).toContain("<th>Cron</th>");
    expect(html).toContain("Started");
    expect(html).toContain("Duration");
    expect(html).toContain("<th>Last Heartbeat</th>");
    expect(html).toContain("Tokens");
    expect(html).toContain("Model");
    expect(html).toContain("<th>Phase</th>");
    expect(html).toContain("<th>Item</th>");
    expect(html).toContain("<th>Session</th>");
    expect(html).toContain("<th>Detail</th>");
    // Cost is shown inline within the Model column's badges, not as its own column.
    expect(html).not.toContain("<th>Cost</th>");
  });

  test("wraps the table in a .data-table-wrapper and uses the shared .data-table class instead of the bespoke .runs-table", () => {
    const html = render([makeRun()]);
    expect(html).toContain('<div class="data-table-wrapper">');
    expect(html).toContain('<table class="data-table">');
    expect(html).not.toContain('class="runs-table"');
  });

  test("renders per-model badges with cost for a multi-model run", () => {
    const html = render([
      makeRun({
        modelBreakdown: [
          {
            model: "claude-sonnet-4-5",
            inputTokens: 200,
            outputTokens: 100,
            cacheReadTokens: 8,
            cacheCreationTokens: 4,
            costUsd: 0.002,
          },
          {
            model: "claude-haiku-4-5",
            inputTokens: 50,
            outputTokens: 20,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
            costUsd: 0.0005,
          },
        ],
      }),
    ]);
    expect(html).toContain("claude-sonnet-4-5");
    expect(html).toContain("claude-haiku-4-5");
    expect(html).toContain("$0.0020");
    expect(html).toContain("$0.0005");
  });

  test("renders em-dash in the Model column when modelBreakdown is empty or undefined", () => {
    const htmlEmpty = render([makeRun({ modelBreakdown: [] })]);
    const htmlUndefined = render([makeRun({ modelBreakdown: undefined })]);
    expect(htmlEmpty).toContain("—");
    expect(htmlUndefined).toContain("—");
  });

  test("renders populated runs with outcome and tokens", () => {
    const html = render([makeRun()]);
    expect(html).toContain("posted");
    // tokens rendered
    expect(html).toContain("1200");
    expect(html).toContain("340");
  });

  test("renders a back link to the agent detail page", () => {
    const html = render([makeRun()]);
    expect(html).toContain('href="/admin/agents/agent-123"');
    expect(html).toContain("Test Agent");
  });

  test("renders the owning cron's name/schedule in the Cron column", () => {
    const html = render([makeRun({ cron: NAMED_NON_LOOP_CRON })]);
    expect(html).toContain("status check");
  });

  test("renders the cron schedule when the owning cron has no name", () => {
    const html = render([makeRun({ cron: OTHER_CRON })]);
    expect(html).toContain("*/15 * * * *");
  });

  test("Cron column links to the same page filtered to that cron's id", () => {
    const html = render([makeRun({ cron: CRON })]);
    expect(html).toContain(
      `<a href="/admin/agents/${CRON_AGENT.id}/queue-activity?cronId=${CRON.id}"`,
    );
  });

  test("Cron column renders plain '—' with no link when the run has no cron", () => {
    const html = render([makeRun({ cron: undefined })]);
    expect(html).not.toContain("queue-activity?cronId=");
  });

  test("renders empty state when no runs match", () => {
    const html = render([]);
    expect(html).toContain("No runs");
  });

  test("renders em-dash for empty token breakdown and no duration", () => {
    const html = render([
      makeRun({
        modelBreakdown: [],
        completedAt: null,
      }),
    ]);
    expect(html).toContain("—");
  });

  // ─── Last Heartbeat / in-progress duration (CRH-1.1) ────────────────────

  test("renders a '~'-prefixed duration from startedAt to lastHeartbeatAt when completedAt is null but a heartbeat exists", () => {
    const html = render([
      makeRun({
        completedAt: null,
        startedAt: new Date("2026-06-01T10:00:00Z"),
        lastHeartbeatAt: new Date("2026-06-01T10:00:07Z"),
      }),
    ]);
    const bodyRowMatch = html.match(/<tbody>([\s\S]*?)<\/tbody>/);
    expect(bodyRowMatch).not.toBeNull();
    expect(bodyRowMatch?.[1]).toContain("~7.0s");
  });

  test("renders a plain (non-'~') duration when completedAt is set, even if lastHeartbeatAt is also present", () => {
    const html = render([
      makeRun({
        startedAt: new Date("2026-06-01T10:00:00Z"),
        completedAt: new Date("2026-06-01T10:00:02Z"),
        lastHeartbeatAt: new Date("2026-06-01T10:00:07Z"),
      }),
    ]);
    const bodyRowMatch = html.match(/<tbody>([\s\S]*?)<\/tbody>/);
    expect(bodyRowMatch).not.toBeNull();
    expect(bodyRowMatch?.[1]).toContain("2.0s");
    expect(bodyRowMatch?.[1]).not.toContain("~2.0s");
    expect(bodyRowMatch?.[1]).not.toContain("~7.0s");
  });

  test("renders em-dash for duration when neither completedAt nor lastHeartbeatAt is set", () => {
    const html = render([
      makeRun({
        completedAt: null,
        lastHeartbeatAt: null,
      }),
    ]);
    const bodyRowMatch = html.match(/<tbody>([\s\S]*?)<\/tbody>/);
    expect(bodyRowMatch).not.toBeNull();
    expect(bodyRowMatch?.[1]).toContain("—");
  });

  test("renders the Last Heartbeat cell as a relative time when lastHeartbeatAt is present", () => {
    const html = render(
      [
        makeRun({
          lastHeartbeatAt: new Date("2026-06-01T09:55:00Z"),
        }),
      ],
      { now: new Date("2026-06-01T10:00:00Z") },
    );
    expect(html).toContain("5 minutes ago");
  });

  test("renders an em-dash for the Last Heartbeat cell when lastHeartbeatAt is absent", () => {
    const html = render([makeRun({ lastHeartbeatAt: undefined })]);
    const bodyRowMatch = html.match(/<tbody>([\s\S]*?)<\/tbody>/);
    expect(bodyRowMatch).not.toBeNull();
    expect(bodyRowMatch?.[1]).toContain("—");
  });

  test("renders the run's phase (via phaseCron, prefix stripped) when set", () => {
    const html = render([
      makeRun({
        phaseId: "some-id",
        phaseCron: { id: "some-id", name: "shipwright-dev-task" },
      }),
    ]);
    expect(html).toContain("dev-task");
  });

  test("renders an em-dash for the phase cell when phaseCron is null (legacy run or no phase attribution)", () => {
    const html = render([makeRun({ phaseId: null, phaseCron: null })]);
    // Locate the tbody row specifically (not the thead row) to check the
    // phase cell — the last <td> in the row.
    const bodyRowMatch = html.match(/<tbody>([\s\S]*?)<\/tbody>/);
    expect(bodyRowMatch).not.toBeNull();
    expect(bodyRowMatch?.[1]).toContain("—");
  });

  test("renders the run's itemType/itemId as a labeled Task badge when set", () => {
    const html = render([makeRun({ itemType: "task", itemId: "WLS-2.2" })]);
    // Must render a distinctly-labeled "Task" badge, not the bare "task: WLS-2.2" string.
    expect(html).not.toContain("task: WLS-2.2");
    expect(html).toContain("Task");
    expect(html).toContain("WLS-2.2");
    expect(html).toMatch(/badge[^>]*>\s*Task/);
  });

  test("Task item id links to its task detail page", () => {
    const html = render([makeRun({ itemType: "task", itemId: "WLS-2.2" })]);
    expect(html).toContain('<a href="/admin/tasks/WLS-2.2"');
  });

  test("renders the run's itemType/itemId as a labeled PR badge when set", () => {
    const html = render([
      makeRun({ itemType: "pr", itemId: "app-vitals/shipwright#1234" }),
    ]);
    // Must render a distinctly-labeled "PR" badge, clearly distinguished from "Task".
    expect(html).toContain("PR");
    expect(html).toContain("app-vitals/shipwright#1234");
    expect(html).toMatch(/badge[^>]*>\s*PR/);
    const bodyRowMatch = html.match(/<tbody>([\s\S]*?)<\/tbody>/);
    expect(bodyRowMatch).not.toBeNull();
    expect(bodyRowMatch?.[1]).not.toContain(">Task<");
  });

  test("PR item id links out to the GitHub PR", () => {
    const html = render([
      makeRun({ itemType: "pr", itemId: "app-vitals/shipwright#1234" }),
    ]);
    expect(html).toContain(
      '<a href="https://github.com/app-vitals/shipwright/pull/1234"',
    );
  });

  test("renders em-dash for the Item cell when itemType/itemId are null (no dispatch)", () => {
    const html = render([makeRun({ itemType: null, itemId: null })]);
    const bodyRowMatch = html.match(/<tbody>([\s\S]*?)<\/tbody>/);
    expect(bodyRowMatch).not.toBeNull();
    expect(bodyRowMatch?.[1]).toContain("—");
  });

  test("Tokens column sums input/output across modelBreakdown rows", () => {
    const html = render([
      makeRun({
        modelBreakdown: [
          {
            model: "claude-sonnet-4-5",
            inputTokens: 200,
            outputTokens: 100,
            cacheReadTokens: 8,
            cacheCreationTokens: 4,
            costUsd: 0.002,
          },
          {
            model: "claude-haiku-4-5",
            inputTokens: 50,
            outputTokens: 20,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
            costUsd: 0.0005,
          },
        ],
      }),
    ]);
    // 200 + 50 = 250 in, 100 + 20 = 120 out
    expect(html).toContain("250 in / 120 out");
  });

  test("escapes XSS in the outcome field", () => {
    const html = render([makeRun({ outcome: '"><script>alert(2)</script>' })]);
    expect(html).not.toContain("<script>alert(2)</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  test("escapes XSS in the agent name", () => {
    const html = renderQueueActivityPage({
      agent: { id: "agent-123", name: "<img src=x onerror=alert(3)>" },
      snapshot: null,
      crons: [CRON],
      runs: [makeRun()],
      filters: {},
      pagination: { total: 1, limit: 20, page: 1 },
      userName: "admin@example.com",
      timezone: "America/Los_Angeles",
    });
    expect(html).not.toContain("<img src=x onerror=alert(3)>");
    expect(html).toContain("&lt;img");
  });

  test("uses renderAdminToolbar with /admin/agents active path", () => {
    const html = render([makeRun()]);
    expect(html).toContain('href="/admin/agents" class="vos-nav-link active"');
  });

  test("renders error message in the title tooltip for a failed non-skipped run", () => {
    const html = render([
      makeRun({
        outcome: "error",
        skipped: false,
        error: "Database connection timeout",
      }),
    ]);
    expect(html).toContain('title="Database connection timeout"');
  });

  test("renders outcome label in the title tooltip for a failed run with no error message", () => {
    const html = render([
      makeRun({
        outcome: "error",
        skipped: false,
        error: null,
      }),
    ]);
    expect(html).toContain('title="error"');
  });

  test("renders skipReason in the title tooltip for a skipped run, even if error is set", () => {
    const html = render([
      makeRun({
        outcome: "error",
        skipped: true,
        skipReason: "Rate limit exceeded",
        error: "Database connection timeout",
      }),
    ]);
    // The outcome badge (first title attribute in the row) should show skipReason.
    const badgeMatch = html.match(
      /<span class="badge"[^>]*title="([^"]*)"[^>]*>([^<]*)<\/span>/,
    );
    expect(badgeMatch).not.toBeNull();
    expect(badgeMatch?.[1]).toBe("Rate limit exceeded");
  });

  test("escapes XSS in the error field within the title attribute", () => {
    const html = render([
      makeRun({
        outcome: "error",
        skipped: false,
        error: '"><script>alert(4)</script>',
      }),
    ]);
    expect(html).not.toContain("<script>alert(4)</script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain('title="');
  });

  // ─── Filter form ────────────────────────────────────────────────────────────

  test("filter form renders a cron dropdown option for each cron, labeled by name or schedule", () => {
    const html = render([makeRun()]);
    expect(html).toContain(`value="${CRON.id}"`);
    expect(html).toContain(`value="${NAMED_NON_LOOP_CRON.id}"`);
    expect(html).toContain("status check");
    expect(html).toContain(`value="${OTHER_CRON.id}"`);
    expect(html).toContain("*/15 * * * *");
  });

  test("filter form preserves the selected cronId as 'selected' on the matching option", () => {
    const html = render([makeRun()], { filters: { cronId: CRON.id } });
    const optionMatch = html.match(
      new RegExp(`<option value="${CRON.id}"[^>]*>`),
    );
    expect(optionMatch).not.toBeNull();
    expect(optionMatch?.[0]).toContain("selected");
  });

  test("filter form renders an outcome dropdown with Any/posted/dm/silent/skipped/error options", () => {
    const html = render([makeRun()]);
    expect(html).toContain(">Any<");
    expect(html).toContain('value="posted"');
    expect(html).toContain('value="dm"');
    expect(html).toContain('value="silent"');
    expect(html).toContain('value="skipped"');
    expect(html).toContain('value="error"');
  });

  test("filter form preserves the selected outcome as 'selected' on the matching option", () => {
    const html = render([makeRun()], { filters: { outcome: "error" } });
    const optionMatch = html.match(/<option value="error"[^>]*>/);
    expect(optionMatch).not.toBeNull();
    expect(optionMatch?.[0]).toContain("selected");
  });

  // ─── Pagination ─────────────────────────────────────────────────────────────

  test("pagination links preserve active cronId/outcome filters as query params", () => {
    const html = render([makeRun()], {
      filters: { cronId: CRON.id, outcome: "posted" },
      pagination: { total: 100, limit: 20, page: 2 },
    });
    expect(html).toContain(`cronId=${CRON.id}`);
    expect(html).toContain("outcome=posted");
    // Prev (page 1) omits the page param, mirroring renderPrsPage's convention
    // that page=1 is the implicit default; Next (page 3) is explicit.
    expect(html).toContain("page=3"); // Next
    const prevMatch = html.match(/← Prev/);
    expect(prevMatch).not.toBeNull();
  });

  test("pagination shows the X-Y of Z summary", () => {
    const html = render([makeRun()], {
      pagination: { total: 45, limit: 20, page: 2 },
    });
    expect(html).toContain("21");
    expect(html).toContain("40");
    expect(html).toContain("45");
  });

  test("no pagination summary when total is 0", () => {
    const html = render([], { pagination: { total: 0, limit: 20, page: 1 } });
    expect(html).not.toContain("of 0");
  });

  // ─── Outcome badge priority ────────────────────────────────────────────────

  test("outcome badge shows 'skipped' ahead of the outcome column value when skipped is true", () => {
    const html = render([
      makeRun({
        skipped: true,
        outcome: "error",
        skipReason: "pre-check failed",
      }),
    ]);
    // The badge itself renders "skipped", not "error" — mirrors
    // cronRunOutcomeLabel's skipped-takes-priority convention.
    const badgeMatch = html.match(/<span class="badge"[^>]*>([^<]*)<\/span>/);
    expect(badgeMatch).not.toBeNull();
    expect(badgeMatch?.[1]).toBe("skipped");
  });

  // ─── Detail column ────────────────────────────────────────────────────────────

  test("renders the Detail column header", () => {
    const html = render([makeRun()]);
    expect(html).toContain("<th>Detail</th>");
  });

  test("renders error text in the Detail column when error is set", () => {
    const html = render([makeRun({ error: "boom: connection refused" })]);
    expect(html).toContain("boom: connection refused");
  });

  test("falls back to skipReason in the Detail column when skipped is true and error is null", () => {
    const html = render([
      makeRun({ skipped: true, skipReason: "queue empty", error: null }),
    ]);
    expect(html).toContain("queue empty");
  });

  test("shows skipReason (not error) in the Detail column when skipped is true and both are set", () => {
    const html = render([
      makeRun({
        skipped: true,
        skipReason: "Rate limit exceeded",
        error: "Database connection timeout",
      }),
    ]);
    expect(html).toContain(
      '<span title="Rate limit exceeded">Rate limit exceeded</span>',
    );
    expect(html).not.toContain("Database connection timeout");
  });

  test("renders an em-dash in the Detail cell when both error and skipReason are null", () => {
    const html = render([makeRun({ error: null, skipReason: null })]);
    // The Detail cell's exact style attributes make this substring unique to it.
    expect(html).toContain(
      '<td style="font-size:12px;max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">—</td>',
    );
  });

  test("a long/multi-line error string is fully present in a title attribute", () => {
    const longError =
      "Error: something failed\n    at foo (file.ts:10)\n    at bar (file.ts:20)";
    const html = render([makeRun({ error: longError })]);
    // The Detail cell renders `<span title="{full}">{full}</span>` with no other
    // attributes, so this exact substring uniquely identifies it (the outcome
    // badge span also carries a title but has class/style attrs and different
    // inner text). Visual truncation is CSS-only (max-width/ellipsis) — the
    // full, untruncated string must appear in both the title and the span body.
    expect(html).toContain(`<span title="${longError}">${longError}</span>`);
  });

  test("empty-state colspan updates from 9 to 10 for the new Session column", () => {
    const html = render([]);
    expect(html).toContain('colspan="10"');
  });

  // ─── Session column ────────────────────────────────────────────────────────────

  test("renders the Session column header", () => {
    const html = render([makeRun()]);
    expect(html).toContain("<th>Session</th>");
  });

  test("renders a truncated sessionId (first 8 chars) with the full id in a title= tooltip", () => {
    const html = render([makeRun({ sessionId: "session-123456789abcdef" })]);
    // Should render first 8 chars: "session-"
    expect(html).toContain('title="session-123456789abcdef"');
    // Must have a monospace cell with truncated value
    expect(html).toMatch(
      /<span[^>]*class="[^"]*mono[^"]*"[^>]*title="session-123456789abcdef"[^>]*>session-<\/span>/,
    );
  });

  test("renders an em-dash when sessionId is null", () => {
    const html = render([makeRun({ sessionId: null })]);
    // Extract the session cell from the tbody
    const bodyRowMatch = html.match(/<tbody>([\s\S]*?)<\/tbody>/);
    expect(bodyRowMatch).not.toBeNull();
    // Check that the row contains an em-dash (should have 9 columns as per the new table)
    expect(bodyRowMatch?.[1]).toContain("—");
  });

  test("renders an em-dash when sessionId is undefined", () => {
    const html = render([makeRun({ sessionId: undefined })]);
    // Extract the session cell from the tbody
    const bodyRowMatch = html.match(/<tbody>([\s\S]*?)<\/tbody>/);
    expect(bodyRowMatch).not.toBeNull();
    // Check that the row contains an em-dash
    expect(bodyRowMatch?.[1]).toContain("—");
  });

  test("renders an em-dash when sessionId is an empty string", () => {
    const html = render([makeRun({ sessionId: "" })]);
    // Extract the session cell from the tbody
    const bodyRowMatch = html.match(/<tbody>([\s\S]*?)<\/tbody>/);
    expect(bodyRowMatch).not.toBeNull();
    // Check that the row contains an em-dash
    expect(bodyRowMatch?.[1]).toContain("—");
  });

  test("table has a Session column header in the table header row", () => {
    const html = render([makeRun()]);
    // Extract the table header row
    const theadMatch = html.match(/<thead>([\s\S]*?)<\/thead>/);
    expect(theadMatch).not.toBeNull();
    // Count <th> elements within the thead
    const headers = theadMatch?.[1].match(/<th[^>]*>/g);
    expect(headers?.length).toBe(11);
  });

  test("escapes XSS in sessionId within the title attribute", () => {
    const html = render([
      makeRun({
        sessionId: '"><script>alert(99)</script>',
      }),
    ]);
    expect(html).not.toContain("<script>alert(99)</script>");
    expect(html).toContain("&lt;script&gt;");
  });
});

// AXR-3.1 merged the former standalone renderWorkQueuePage into
// renderQueueActivityPage's "Upcoming" section — these cases are adapted
// (not duplicated) from the original renderWorkQueuePage suite.
describe("renderQueueActivityPage — Upcoming section", () => {
  const QUEUE_AGENT = { id: "agent-123", name: "Test Agent" };

  function makeItem(overrides?: Partial<WorkQueueItem>): WorkQueueItem {
    return {
      type: "task",
      id: "TSK-1",
      title: "Sample task",
      phase: "dev-task",
      age: "2026-06-01T09:00:00Z",
      ...overrides,
    };
  }

  function render(
    snapshot: WorkQueueSnapshotItem | null,
    opts?: { now?: Date },
  ): string {
    return renderQueueActivityPage({
      agent: QUEUE_AGENT,
      snapshot,
      crons: [],
      runs: [],
      filters: {},
      pagination: { total: 0, limit: 20, page: 1 },
      userName: "admin@example.com",
      now: opts?.now ?? new Date("2026-06-01T10:00:00Z"),
    });
  }

  test("renders a valid HTML document", () => {
    const html = render({
      computedAt: new Date("2026-06-01T09:55:00Z"),
      items: [makeItem()],
    });
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("<html");
    expect(html).toContain("</html>");
    expect(html).toContain(
      "<title>Queue &amp; Activity — Test Agent — Shipwright Admin</title>",
    );
  });

  test("renders empty state when snapshot is null", () => {
    const html = render(null);
    expect(html).toContain("No work queue snapshot yet");
    expect(html).toContain("shipwright-loop cron ticks");
  });

  test("renders empty state when snapshot has no items", () => {
    const html = render({
      computedAt: new Date("2026-06-01T09:55:00Z"),
      items: [],
    });
    expect(html).toContain("Queue is empty — nothing pending");
  });

  test("renders table wrapped in data-table-wrapper with class data-table", () => {
    const html = render({
      computedAt: new Date("2026-06-01T09:55:00Z"),
      items: [makeItem()],
    });
    expect(html).toContain('<div class="data-table-wrapper">');
    expect(html).toContain('<table class="data-table">');
  });

  test("renders queue items with correct columns", () => {
    const html = render({
      computedAt: new Date("2026-06-01T09:55:00Z"),
      items: [
        makeItem({
          type: "task",
          id: "TSK-1",
          title: "First task",
          phase: "dev-task",
          age: "2026-06-01T09:00:00Z",
        }),
        makeItem({
          type: "pr",
          id: "PR-123",
          title: "Review PR",
          phase: "review",
          age: "2026-06-01T08:30:00Z",
        }),
      ],
    });
    expect(html).toContain("<th>#</th>");
    expect(html).toContain("<th>Type</th>");
    expect(html).toContain("<th>Phase</th>");
    expect(html).toContain("<th>Item</th>");
    expect(html).toContain("<th>Age</th>");
    expect(html).toContain("First task");
    expect(html).toContain("Review PR");
  });

  test("renders a back link to the agent detail page", () => {
    const html = render({
      computedAt: new Date("2026-06-01T09:55:00Z"),
      items: [makeItem()],
    });
    expect(html).toContain('href="/admin/agents/agent-123"');
    expect(html).toContain("Test Agent");
  });
});

// ─── renderQueueActivityPage — agent selector (AXR-3.4) ─────────────────────

describe("renderQueueActivityPage — agent selector", () => {
  const BASE_OPTS = {
    snapshot: null,
    crons: [],
    runs: [],
    filters: {},
    pagination: { total: 0, limit: 20, page: 1 },
    userName: "admin@example.com",
  };

  test("admin fixture: renders every accessible agent as an option, with the viewed agent pre-selected", () => {
    const html = renderQueueActivityPage({
      ...BASE_OPTS,
      agent: { id: "agent-123", name: "Test Agent" },
      agents: [
        { id: "agent-123", name: "Test Agent" },
        { id: "agent-456", name: "Other Agent" },
        { id: "agent-789", name: "Third Agent" },
      ],
    });
    expect(html).toContain(
      '<option value="agent-123" selected>Test Agent</option>',
    );
    expect(html).toContain('<option value="agent-456">Other Agent</option>');
    expect(html).toContain('<option value="agent-789">Third Agent</option>');
    expect(html).toContain(
      '<form method="GET" action="/admin/agents/agent-123/queue-activity"',
    );
  });

  test("non-admin/AgentMember fixture: renders only the caller's scoped agents, none of the inaccessible fleet", () => {
    const html = renderQueueActivityPage({
      ...BASE_OPTS,
      agent: { id: "agent-456", name: "Other Agent" },
      agents: [
        { id: "agent-123", name: "Test Agent" },
        { id: "agent-456", name: "Other Agent" },
      ],
    });
    expect(html).toContain('<option value="agent-123">Test Agent</option>');
    expect(html).toContain(
      '<option value="agent-456" selected>Other Agent</option>',
    );
    expect(html).not.toContain("agent-789");
  });

  test("falls back to a single-option selector (just the viewed agent) when agents is omitted", () => {
    const html = renderQueueActivityPage({
      ...BASE_OPTS,
      agent: { id: "agent-123", name: "Test Agent" },
    });
    expect(html).toContain(
      '<option value="agent-123" selected>Test Agent</option>',
    );
  });

  test("includes an 'All agents' option that navigates to the merged /admin/queue-activity view (AAV-2)", () => {
    const html = renderQueueActivityPage({
      ...BASE_OPTS,
      agent: { id: "agent-123", name: "Test Agent" },
      agents: [
        { id: "agent-123", name: "Test Agent" },
        { id: "agent-456", name: "Other Agent" },
      ],
    });
    expect(html).toContain('<option value="__all__">All agents</option>');
    // Per-agent options are still rendered as before.
    expect(html).toContain(
      '<option value="agent-123" selected>Test Agent</option>',
    );
    expect(html).toContain('<option value="agent-456">Other Agent</option>');
    // The onchange handler branches to the merged view for the sentinel...
    expect(html).toContain(
      "if (this.value === '__all__') { this.form.action = '/admin/queue-activity'; }",
    );
    // ...and still supports per-agent navigation for any other selection.
    expect(html).toContain(
      "this.form.action = '/admin/agents/' + this.value + '/queue-activity';",
    );
  });
});

// ─── renderQueueActivityPage — sectioning (AXR-3.1) ─────────────────────────

describe("renderQueueActivityPage — Upcoming/Past sectioning", () => {
  const AGENT = { id: "agent-123", name: "Test Agent" };
  const CRON = { id: "cron-1", name: "status check", schedule: "0 * * * *" };

  test("renders an 'Upcoming' heading before a 'Past' heading, with the work-queue snapshot before the cron-run table", () => {
    const html = renderQueueActivityPage({
      agent: AGENT,
      snapshot: {
        computedAt: new Date("2026-06-01T09:55:00Z"),
        items: [
          {
            type: "task",
            id: "TSK-1",
            title: "Queued task",
            phase: "dev-task",
            age: "2026-06-01T09:00:00Z",
          },
        ],
      },
      crons: [CRON],
      runs: [
        {
          startedAt: new Date("2026-06-01T08:00:00Z"),
          completedAt: new Date("2026-06-01T08:00:02Z"),
          outcome: "posted",
          skipped: false,
          skipReason: null,
          error: null,
          cron: CRON,
        },
      ],
      filters: {},
      pagination: { total: 1, limit: 20, page: 1 },
      userName: "admin@example.com",
      now: new Date("2026-06-01T10:00:00Z"),
    });

    const upcomingHeadingIndex = html.indexOf("Upcoming");
    const pastHeadingIndex = html.indexOf("Past");
    const upcomingItemIndex = html.indexOf("TSK-1");
    const pastRunIndex = html.indexOf("posted");

    expect(upcomingHeadingIndex).toBeGreaterThan(-1);
    expect(pastHeadingIndex).toBeGreaterThan(-1);
    expect(upcomingHeadingIndex).toBeLessThan(pastHeadingIndex);
    expect(upcomingItemIndex).toBeGreaterThan(-1);
    expect(pastRunIndex).toBeGreaterThan(-1);
    // The Upcoming table's item content must appear before the Past
    // heading, and the Past table's content must appear after it — proving
    // the two sections aren't interleaved.
    expect(upcomingItemIndex).toBeLessThan(pastHeadingIndex);
    expect(pastRunIndex).toBeGreaterThan(pastHeadingIndex);
  });

  test("renders the Upcoming empty state and Past empty state independently when both are empty", () => {
    const html = renderQueueActivityPage({
      agent: AGENT,
      snapshot: null,
      crons: [],
      runs: [],
      filters: {},
      pagination: { total: 0, limit: 20, page: 1 },
      userName: "admin@example.com",
    });
    expect(html).toContain("No work queue snapshot yet");
    expect(html).toContain("No runs match the selected filters.");
  });
});

// ─── buildMergedWorkQueueRows (AAV-2.1) ─────────────────────────────────────

describe("buildMergedWorkQueueRows", () => {
  function prItem(overrides?: Partial<WorkQueueItem>): WorkQueueItem {
    return {
      type: "pr",
      id: "app-vitals/shipwright#100",
      title: "Shared PR",
      phase: "review",
      age: "2026-06-01T08:00:00Z",
      ...overrides,
    };
  }

  test("dedupes an item queued by multiple agents into a single row with queuedByAgentIds", () => {
    const rows = buildMergedWorkQueueRows(
      [
        { agentId: "agent-a", items: [prItem()] },
        { agentId: "agent-b", items: [prItem()] },
      ],
      [
        { id: "agent-a", repos: ["app-vitals/shipwright"], loopEnabled: true },
        { id: "agent-b", repos: ["app-vitals/shipwright"], loopEnabled: true },
      ],
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].queuedByAgentIds).toEqual(["agent-a", "agent-b"]);
  });

  test("annotates eligibleAgentIds from each agent's repos[] via the PR item's embedded repo", () => {
    const rows = buildMergedWorkQueueRows(
      [{ agentId: "agent-a", items: [prItem()] }],
      [
        { id: "agent-a", repos: ["app-vitals/shipwright"], loopEnabled: true },
        { id: "agent-b", repos: ["app-vitals/shipwright"], loopEnabled: true },
        { id: "agent-c", repos: ["app-vitals/other-repo"], loopEnabled: true },
      ],
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].eligibleAgentIds).toEqual(["agent-a", "agent-b"]);
  });

  test("a task item (no repo field available) gets zero eligible agents rather than a guessed answer", () => {
    const rows = buildMergedWorkQueueRows(
      [
        {
          agentId: "agent-a",
          items: [
            {
              type: "task",
              id: "WLS-2.2",
              title: "A task",
              phase: "dev-task",
              age: "2026-06-01T08:00:00Z",
            },
          ],
        },
      ],
      [{ id: "agent-a", repos: ["app-vitals/shipwright"], loopEnabled: true }],
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].eligibleAgentIds).toEqual([]);
  });

  test("keeps distinct (type, id) items as separate rows", () => {
    const rows = buildMergedWorkQueueRows(
      [
        {
          agentId: "agent-a",
          items: [prItem({ id: "app-vitals/shipwright#100" })],
        },
        {
          agentId: "agent-b",
          items: [
            prItem({
              id: "app-vitals/other-repo#5",
              age: "2026-06-01T07:00:00Z",
            }),
          ],
        },
      ],
      [
        { id: "agent-a", repos: ["app-vitals/shipwright"], loopEnabled: true },
        { id: "agent-b", repos: ["app-vitals/other-repo"], loopEnabled: true },
      ],
    );

    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.id).sort()).toEqual([
      "app-vitals/other-repo#5",
      "app-vitals/shipwright#100",
    ]);
  });

  test("sorts merged rows oldest-first by age, matching rankWorkItems()'s convention", () => {
    const rows = buildMergedWorkQueueRows(
      [
        {
          agentId: "agent-a",
          items: [
            prItem({
              id: "app-vitals/shipwright#1",
              age: "2026-06-01T09:00:00Z",
            }),
          ],
        },
        {
          agentId: "agent-b",
          items: [
            prItem({
              id: "app-vitals/shipwright#2",
              age: "2026-06-01T07:00:00Z",
            }),
          ],
        },
      ],
      [
        { id: "agent-a", repos: [], loopEnabled: true },
        { id: "agent-b", repos: [], loopEnabled: true },
      ],
    );

    expect(rows.map((r) => r.id)).toEqual([
      "app-vitals/shipwright#2",
      "app-vitals/shipwright#1",
    ]);
  });

  test("returns an empty array for zero agents/snapshots", () => {
    expect(buildMergedWorkQueueRows([], [])).toEqual([]);
  });
});

// ─── renderMergedQueueActivityPage (AAV-2.1) ────────────────────────────────

describe("renderMergedQueueActivityPage", () => {
  const AGENTS = [
    { id: "agent-alpha", name: "Alpha Agent" },
    { id: "agent-beta", name: "Beta Agent" },
  ];
  const AGENT_NAMES = {
    "agent-alpha": "Alpha Agent",
    "agent-beta": "Beta Agent",
  };

  function mergedRow(
    overrides?: Partial<MergedWorkQueueRow>,
  ): MergedWorkQueueRow {
    return {
      type: "pr",
      id: "app-vitals/shipwright#100",
      title: "Shared PR",
      phase: "review",
      age: "2026-06-01T08:00:00Z",
      queuedByAgentIds: ["agent-alpha", "agent-beta"],
      eligibleAgentIds: ["agent-alpha", "agent-beta"],
      ...overrides,
    };
  }

  function baseRun(overrides?: Partial<CronRunItem>): CronRunItem {
    return {
      agentId: "agent-alpha",
      startedAt: new Date("2026-06-01T08:00:00Z"),
      completedAt: new Date("2026-06-01T08:00:02Z"),
      outcome: "posted",
      skipped: false,
      skipReason: null,
      error: null,
      cron: { id: "cron-1", name: "shipwright-loop", schedule: "0 * * * *" },
      ...overrides,
    };
  }

  test("renders a valid HTML document titled for the merged fleet-wide view", () => {
    const html = renderMergedQueueActivityPage({
      agents: AGENTS,
      agentNames: AGENT_NAMES,
      workQueueRows: [],
      workQueuePagination: { total: 0, limit: 20, page: 1 },
      runs: [],
      runsPagination: { total: 0, limit: 20, page: 1 },
      userName: "admin@example.com",
    });
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain(
      "<title>Queue &amp; Activity — All Agents — Shipwright Admin</title>",
    );
  });

  test("the agent selector defaults to 'All agents' selected and lists every accessible agent", () => {
    const html = renderMergedQueueActivityPage({
      agents: AGENTS,
      agentNames: AGENT_NAMES,
      workQueueRows: [],
      workQueuePagination: { total: 0, limit: 20, page: 1 },
      runs: [],
      runsPagination: { total: 0, limit: 20, page: 1 },
      userName: "admin@example.com",
    });
    expect(html).toContain(
      '<option value="__all__" selected>All agents</option>',
    );
    expect(html).toContain('<option value="agent-alpha">Alpha Agent</option>');
    expect(html).toContain('<option value="agent-beta">Beta Agent</option>');
    // Choosing a specific agent still navigates to its own queue-activity page.
    expect(html).toContain(
      "this.form.action = '/admin/agents/' + this.value + '/queue-activity';",
    );
  });

  test("renders the merged work-queue table with Eligible agents and Queued by columns populated", () => {
    const html = renderMergedQueueActivityPage({
      agents: AGENTS,
      agentNames: AGENT_NAMES,
      workQueueRows: [mergedRow()],
      workQueuePagination: { total: 1, limit: 20, page: 1 },
      runs: [],
      runsPagination: { total: 0, limit: 20, page: 1 },
      userName: "admin@example.com",
      now: new Date("2026-06-01T10:00:00Z"),
    });
    expect(html).toContain("<th>Eligible agents</th>");
    expect(html).toContain("<th>Queued by</th>");
    expect(html).toContain(
      '<a href="/admin/agents/agent-alpha" style="color:#6366f1;text-decoration:none">Alpha Agent</a>',
    );
    expect(html).toContain(
      '<a href="/admin/agents/agent-beta" style="color:#6366f1;text-decoration:none">Beta Agent</a>',
    );
  });

  test("renders an em-dash for Eligible agents / Queued by when both lists are empty", () => {
    const html = renderMergedQueueActivityPage({
      agents: AGENTS,
      agentNames: AGENT_NAMES,
      workQueueRows: [
        mergedRow({ queuedByAgentIds: [], eligibleAgentIds: [] }),
      ],
      workQueuePagination: { total: 1, limit: 20, page: 1 },
      runs: [],
      runsPagination: { total: 0, limit: 20, page: 1 },
      userName: "admin@example.com",
    });
    expect(html).toContain("—");
  });

  test("renders the merged cron-run table with a resolved Agent column", () => {
    const html = renderMergedQueueActivityPage({
      agents: AGENTS,
      agentNames: AGENT_NAMES,
      workQueueRows: [],
      workQueuePagination: { total: 0, limit: 20, page: 1 },
      runs: [baseRun({ agentId: "agent-beta" })],
      runsPagination: { total: 1, limit: 20, page: 1 },
      userName: "admin@example.com",
    });
    expect(html).toContain("<th>Agent</th>");
    expect(html).toContain(
      '<a href="/admin/agents/agent-beta" style="color:#6366f1;text-decoration:none">Beta Agent</a>',
    );
    // Cron-filter link is scoped to the run's own agent, not a single agent.
    expect(html).toContain(
      "/admin/agents/agent-beta/queue-activity?cronId=cron-1",
    );
  });

  test("renders pagination controls for the Upcoming table when total exceeds one page", () => {
    const html = renderMergedQueueActivityPage({
      agents: AGENTS,
      agentNames: AGENT_NAMES,
      workQueueRows: [mergedRow()],
      workQueuePagination: { total: 25, limit: 20, page: 1 },
      runs: [],
      runsPagination: { total: 0, limit: 20, page: 1 },
      userName: "admin@example.com",
    });
    expect(html).toContain("1–20 of 25");
    expect(html).toContain("Next →");
    expect(html).toContain("/admin/queue-activity?queuePage=2");
  });

  test("Upcoming pagination Prev link appears on page 2 and not page 1", () => {
    const page1 = renderMergedQueueActivityPage({
      agents: AGENTS,
      agentNames: AGENT_NAMES,
      workQueueRows: [mergedRow()],
      workQueuePagination: { total: 25, limit: 20, page: 1 },
      runs: [],
      runsPagination: { total: 0, limit: 20, page: 1 },
      userName: "admin@example.com",
    });
    expect(page1).not.toContain("← Prev");

    const page2 = renderMergedQueueActivityPage({
      agents: AGENTS,
      agentNames: AGENT_NAMES,
      workQueueRows: [mergedRow()],
      workQueuePagination: { total: 25, limit: 20, page: 2 },
      runs: [],
      runsPagination: { total: 0, limit: 20, page: 1 },
      userName: "admin@example.com",
    });
    expect(page2).toContain("← Prev");
    // Page 1 omits the queuePage param entirely (same convention as the
    // single-agent page's makePageUrl).
    expect(page2).toContain(
      '<a href="/admin/queue-activity" class="btn btn-secondary"',
    );
  });

  test("renders empty states for both sections when there is nothing across the fleet", () => {
    const html = renderMergedQueueActivityPage({
      agents: AGENTS,
      agentNames: AGENT_NAMES,
      workQueueRows: [],
      workQueuePagination: { total: 0, limit: 20, page: 1 },
      runs: [],
      runsPagination: { total: 0, limit: 20, page: 1 },
      userName: "admin@example.com",
    });
    expect(html).toContain("No work queue items across any accessible agent");
    expect(html).toContain("No runs across any accessible agent");
  });
});
