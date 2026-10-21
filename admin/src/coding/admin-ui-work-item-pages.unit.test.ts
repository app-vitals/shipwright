/**
 * admin/src/coding/admin-ui-work-item-pages.unit.test.ts
 * Pure unit tests for the task/session/PR render functions in
 * admin-ui-work-item-pages.ts (relocated from admin-ui-pages.unit.test.ts,
 * AEP-3.2).
 *
 * Strategy: call render functions directly, assert on returned HTML strings.
 * No I/O, no Hono, no HTTP — pure string → string.
 */

import { describe, expect, test } from "bun:test";
import { renderQueueActivityPage } from "./admin-ui-queue-pages.ts";
import type { VerificationCheckItem } from "./admin-ui-verification-cards.ts";
import {
  bucketTaskColumn,
  classifyTaskState,
  computeDependencyLayout,
  computeDependencyNodes,
  type DependencyNode,
  heartbeatFreshness,
  type PrListItem,
  type PullRequestItem,
  renderPrDetailPage,
  renderPrsPage,
  renderSessionDetailPage,
  renderTaskDetailPage,
  renderTasksPage,
  resolveAgentNameFilterAndPaginate,
  type TaskItem,
} from "./admin-ui-work-item-pages.ts";

// ─── Shared fixtures ──────────────────────────────────────────────────────────

const USER_NAME = "alice";

// ─── renderTasksPage — row click navigation ──────────────────────────────────

const TASK_ITEM: TaskItem = {
  id: "TASK-1",
  title: "Build the thing",
  status: "in_progress",
  session: "session-abc",
  repo: "org/repo",
  assignee: null,
  claimedBy: null,
};

const TASK_ITEM_PENDING: TaskItem = {
  id: "TASK-2",
  title: "Plan the thing",
  status: "pending",
  session: null,
  repo: null,
  assignee: null,
  claimedBy: null,
};

describe("renderTasksPage — row click navigation", () => {
  function render(
    tasks: TaskItem[] = [TASK_ITEM],
    opts?: Parameters<typeof renderTasksPage>[6],
  ): string {
    return renderTasksPage(
      tasks,
      {},
      false,
      USER_NAME,
      {},
      { total: tasks.length, limit: 50, page: 1 },
      opts,
      undefined,
    );
  }

  // TBF-1.1: this describe block's render() defaults to the table view (no
  // explicit `view` opt threads through to a "board"), so — matching
  // makePageUrl always carrying ?view=table forward — every row's `from`
  // link now carries the table view even with no other filters active.
  const TABLE_VIEW_FROM = encodeURIComponent("/admin/tasks?view=table");

  // AC1: clicking anywhere on a task row navigates to the task detail page
  test("each task row has a data-href that navigates to the task detail URL", () => {
    const html = render([TASK_ITEM]);
    expect(html).toContain(
      `data-href="/admin/tasks/${TASK_ITEM.id}?from=${TABLE_VIEW_FROM}"`,
    );
  });

  test("data-href URL uses the escaped task id", () => {
    const xssTask: TaskItem = { ...TASK_ITEM, id: "TASK-XSS" };
    const html = render([xssTask]);
    expect(html).toContain(
      `data-href="/admin/tasks/TASK-XSS?from=${TABLE_VIEW_FROM}"`,
    );
  });

  test("data-href URL escapes single quotes in task id", () => {
    const singleQuoteTask: TaskItem = { ...TASK_ITEM, id: "TASK-IT'S" };
    const html = render([singleQuoteTask]);
    // Single quote must be encoded as &#39; — raw ' in the attribute would break HTML parsing
    expect(html).toContain(
      `data-href="/admin/tasks/TASK-IT&#39;S?from=${TABLE_VIEW_FROM}"`,
    );
    expect(html).not.toContain(`data-href="/admin/tasks/TASK-IT'S"`);
  });

  // AC2: cursor changes to pointer on row hover
  test("task row has cursor:pointer style", () => {
    const html = render([TASK_ITEM]);
    // The <tr> element for a task row must carry cursor:pointer
    expect(html).toMatch(/<tr[^>]*cursor:\s*pointer/);
  });

  // AC3: buttons/links within the row still handle their own click events
  // The script block uses event delegation on data-href rows and skips clicks on
  // A, BUTTON, FORM, INPUT elements — no inline stopPropagation needed.
  test("row click handler script is present and delegates via data-href attribute", () => {
    const html = render([TASK_ITEM]);
    expect(html).toContain("data-href");
    expect(html).toContain(`getAttribute("data-href")`);
  });

  test("Release button is still present for in_progress tasks", () => {
    const html = render([TASK_ITEM]);
    expect(html).toContain("Release");
    // TBF-1.1: the release form's `from` carries the current table-view list
    // URL so the Task Detail page's back link returns to this view.
    expect(html).toContain(
      `action="/admin/tasks/${TASK_ITEM.id}/release?from=${TABLE_VIEW_FROM}"`,
    );
  });

  test("no Release button for non-in_progress tasks, but row is still navigable", () => {
    const html = render([TASK_ITEM_PENDING]);
    expect(html).not.toContain("Release");
    expect(html).toContain(
      `data-href="/admin/tasks/${TASK_ITEM_PENDING.id}?from=${TABLE_VIEW_FROM}"`,
    );
  });

  test("empty task list renders no clickable rows", () => {
    const html = render([]);
    expect(html).not.toContain('data-href="/admin/tasks/');
    expect(html).toContain("No tasks found");
  });

  test("multiple tasks each get their own data-href pointing to their detail URL", () => {
    const html = render([TASK_ITEM, TASK_ITEM_PENDING]);
    expect(html).toContain(
      `data-href="/admin/tasks/${TASK_ITEM.id}?from=${TABLE_VIEW_FROM}"`,
    );
    expect(html).toContain(
      `data-href="/admin/tasks/${TASK_ITEM_PENDING.id}?from=${TABLE_VIEW_FROM}"`,
    );
  });
});

// ─── renderTasksPage — back-link context (TBL-1.1) ───────────────────────────

describe("renderTasksPage — back-link context (TBL-1.1)", () => {
  // AC1 (TBF-1.1 update): bare /admin/tasks now defaults to the board
  // (AXR-1.3), so even the "default" table-view case (no filters, page 1)
  // can no longer omit ?from= — falling back to a bare link would bounce
  // the user off the table view. Row links always carry ?from=<current
  // table-view URL>, which is at minimum `/admin/tasks?view=table`.
  test("default list view (no filters, page 1) still carries ?from= to preserve table view", () => {
    const html = renderTasksPage(
      [TASK_ITEM],
      {},
      false,
      USER_NAME,
      {},
      { total: 1, limit: 50, page: 1 },
      undefined,
      undefined,
    );
    const expectedFrom = encodeURIComponent("/admin/tasks?view=table");
    expect(html).toContain(
      `data-href="/admin/tasks/${TASK_ITEM.id}?from=${expectedFrom}"`,
    );
  });

  // AC1: a non-default filter (status) causes row links to carry ?from=<current list URL>
  test("row links carry ?from=<current list URL> when a status filter is active", () => {
    const html = renderTasksPage(
      [TASK_ITEM],
      { status: "in_progress" },
      false,
      USER_NAME,
      {},
      { total: 1, limit: 50, page: 1 },
      undefined,
      undefined,
    );
    const expectedFrom = encodeURIComponent(
      "/admin/tasks?status=in_progress&view=table",
    );
    expect(html).toContain(
      `data-href="/admin/tasks/${TASK_ITEM.id}?from=${expectedFrom}"`,
    );
    expect(html).toContain(
      `<a href="/admin/tasks/${TASK_ITEM.id}?from=${expectedFrom}"`,
    );
  });

  // AC1: state filter also triggers ?from=
  test("row links carry ?from= when a state filter is active", () => {
    const html = renderTasksPage(
      [TASK_ITEM],
      { state: "blocked" },
      false,
      USER_NAME,
      {},
      { total: 1, limit: 50, page: 1 },
      undefined,
      undefined,
    );
    const expectedFrom = encodeURIComponent(
      "/admin/tasks?state=blocked&view=table",
    );
    expect(html).toContain(
      `data-href="/admin/tasks/${TASK_ITEM.id}?from=${expectedFrom}"`,
    );
  });

  // AC1: page > 1 also triggers ?from=
  test("row links carry ?from= when page is greater than 1", () => {
    const html = renderTasksPage(
      [TASK_ITEM],
      {},
      false,
      USER_NAME,
      {},
      { total: 100, limit: 50, page: 2 },
      undefined,
      undefined,
    );
    const expectedFrom = encodeURIComponent("/admin/tasks?page=2&view=table");
    expect(html).toContain(
      `data-href="/admin/tasks/${TASK_ITEM.id}?from=${expectedFrom}"`,
    );
  });

  // AC1: the title link (second <td>) also carries ?from=
  test("title link also carries ?from= when filters are active", () => {
    const html = renderTasksPage(
      [TASK_ITEM],
      { repo: "org/repo" },
      false,
      USER_NAME,
      {},
      { total: 1, limit: 50, page: 1 },
      undefined,
      undefined,
    );
    const expectedFrom = encodeURIComponent(
      "/admin/tasks?repo=org%2Frepo&view=table",
    );
    expect(html).toContain(
      `<a href="/admin/tasks/${TASK_ITEM.id}?from=${expectedFrom}" style="color:inherit;text-decoration:none">${TASK_ITEM.title}</a>`,
    );
  });
});

// ─── renderTasksPage — hitl filter ───────────────────────────────────────────

describe("renderTasksPage — hitl filter", () => {
  test("renders a hitl select with Any/Yes/No options next to Status", () => {
    const html = renderTasksPage(
      [TASK_ITEM],
      {},
      false,
      USER_NAME,
      {},
      { total: 1, limit: 50, page: 1 },
      undefined,
      undefined,
    );
    expect(html).toContain('<select name="hitl"');
    expect(html).toMatch(/<option value=""[^>]*>Any<\/option>/);
    expect(html).toMatch(/<option value="true"[^>]*>Yes<\/option>/);
    expect(html).toMatch(/<option value="false"[^>]*>No<\/option>/);
  });

  test("selects 'Yes' option when filters.hitl is 'true'", () => {
    const html = renderTasksPage(
      [TASK_ITEM],
      { hitl: "true" },
      false,
      USER_NAME,
      {},
      { total: 1, limit: 50, page: 1 },
      undefined,
      undefined,
    );
    expect(html).toContain('<option value="true" selected>Yes</option>');
  });

  test("selects 'No' option when filters.hitl is 'false'", () => {
    const html = renderTasksPage(
      [TASK_ITEM],
      { hitl: "false" },
      false,
      USER_NAME,
      {},
      { total: 1, limit: 50, page: 1 },
      undefined,
      undefined,
    );
    expect(html).toContain('<option value="false" selected>No</option>');
  });

  test("defaults to 'Any' with no explicit hitl option selected when filters.hitl is undefined", () => {
    const html = renderTasksPage(
      [TASK_ITEM],
      {},
      false,
      USER_NAME,
      {},
      { total: 1, limit: 50, page: 1 },
      undefined,
      undefined,
    );
    expect(html).toMatch(/<option value=""[^>]*>Any<\/option>/);
    expect(html).not.toMatch(
      /<option value="true"[^>]*selected[^>]*>Yes<\/option>/,
    );
    expect(html).not.toMatch(
      /<option value="false"[^>]*selected[^>]*>No<\/option>/,
    );
  });

  test("makePageUrl preserves hitl filter across pagination links", () => {
    const html = renderTasksPage(
      [TASK_ITEM],
      { hitl: "true" },
      false,
      USER_NAME,
      {},
      { total: 100, limit: 50, page: 1 },
      undefined,
      undefined,
    );
    expect(html).toContain('href="/admin/tasks?hitl=true&page=2&view=table"');
  });

  test("makeStateParams preserves hitl filter in state-tab links", () => {
    const html = renderTasksPage(
      [TASK_ITEM],
      { hitl: "true" },
      false,
      USER_NAME,
      {},
      { total: 1, limit: 50, page: 1 },
      undefined,
      undefined,
    );
    expect(html).toContain(
      'href="/admin/tasks?state=ready&hitl=true&view=table"',
    );
    expect(html).toContain(
      'href="/admin/tasks?state=in_progress&hitl=true&view=table"',
    );
    expect(html).toContain(
      'href="/admin/tasks?state=blocked&hitl=true&view=table"',
    );
    expect(html).toContain(
      'href="/admin/tasks?state=closed&hitl=true&view=table"',
    );
  });

  test("row links carry ?from= including hitl when a hitl filter is active", () => {
    const html = renderTasksPage(
      [TASK_ITEM],
      { hitl: "true" },
      false,
      USER_NAME,
      {},
      { total: 1, limit: 50, page: 1 },
      undefined,
      undefined,
    );
    const expectedFrom = encodeURIComponent(
      "/admin/tasks?hitl=true&view=table",
    );
    expect(html).toContain(
      `data-href="/admin/tasks/${TASK_ITEM.id}?from=${expectedFrom}"`,
    );
  });
});

// ─── renderTasksPage — datalist autocomplete (AFA-1.2) ───────────────────────

describe("renderTasksPage — datalist autocomplete", () => {
  const pagination = { total: 0, limit: 50, page: 1 };

  test("renderTasksPage with sessions suggestions renders session datalist", () => {
    const html = renderTasksPage(
      [],
      {},
      false,
      "user@test.com",
      {},
      pagination,
      undefined,
      { sessions: ["session-abc", "session-xyz"] },
    );
    expect(html).toContain('<datalist id="sessions-list">');
    expect(html).toContain('<option value="session-abc">');
    expect(html).toContain('<option value="session-xyz">');
    expect(html).toContain('list="sessions-list"');
  });

  test("renderTasksPage with agents suggestions renders agent datalist", () => {
    const html = renderTasksPage(
      [],
      {},
      false,
      "user@test.com",
      {},
      pagination,
      undefined,
      { agents: ["Agent Alpha", "Agent Beta"] },
    );
    expect(html).toContain('<datalist id="agents-list">');
    expect(html).toContain('<option value="Agent Alpha">');
    expect(html).toContain('list="agents-list"');
  });

  test("renderTasksPage without suggestions renders plain text session input (no datalist)", () => {
    const html = renderTasksPage(
      [],
      {},
      false,
      "user@test.com",
      {},
      pagination,
      undefined,
      undefined,
    );
    expect(html).not.toContain('list="sessions-list"');
    expect(html).not.toContain('list="agents-list"');
  });

  test("renderTasksPage escapes suggestion values to prevent XSS", () => {
    const html = renderTasksPage(
      [],
      {},
      false,
      "user@test.com",
      {},
      pagination,
      undefined,
      { sessions: ['<script>alert("xss")</script>'] },
    );
    expect(html).not.toContain('<script>alert("xss")</script>');
    expect(html).toContain("&lt;script&gt;");
  });
});

// ─── renderTasksPage — org/repo multiselect filters (ORF-2.1) ────────────────

describe("renderTasksPage — org/repo multiselect filters", () => {
  const pagination = { total: 0, limit: 50, page: 1 };

  test("renders both an Org and a Repo select-multiple element", () => {
    const html = renderTasksPage(
      [],
      {},
      false,
      "user@test.com",
      {},
      pagination,
      undefined,
      { orgs: ["app-vitals", "other-org"], repos: ["app-vitals/repo-a"] },
    );
    expect(html).toContain('<select name="org" multiple');
    expect(html).toContain('<select name="repo" multiple');
  });

  test("populates Org options from suggestions.orgs", () => {
    const html = renderTasksPage(
      [],
      {},
      false,
      "user@test.com",
      {},
      pagination,
      undefined,
      { orgs: ["app-vitals", "other-org"] },
    );
    expect(html).toContain('<option value="app-vitals">');
    expect(html).toContain('<option value="other-org">');
  });

  test("populates Repo options from suggestions.repos", () => {
    const html = renderTasksPage(
      [],
      {},
      false,
      "user@test.com",
      {},
      pagination,
      undefined,
      { repos: ["app-vitals/repo-a", "app-vitals/repo-b"] },
    );
    expect(html).toContain('<option value="app-vitals/repo-a">');
    expect(html).toContain('<option value="app-vitals/repo-b">');
  });

  test("Org and Repo multiselects carry the new scope-select pill/tag styling class (AXR-1.1)", () => {
    const html = renderTasksPage(
      [],
      {},
      false,
      "user@test.com",
      {},
      pagination,
      undefined,
      { orgs: ["app-vitals"], repos: ["app-vitals/repo-a"] },
    );
    expect(html).toContain(
      '<select name="org" multiple class="form-input scope-select"',
    );
    expect(html).toContain(
      '<select name="repo" multiple class="form-input scope-select"',
    );
  });

  test("Org and Repo stay independent multiselect fields, not merged into one combined scope pill", () => {
    const html = renderTasksPage(
      [],
      {},
      false,
      "user@test.com",
      {},
      pagination,
      undefined,
      { orgs: ["app-vitals"], repos: ["app-vitals/repo-a"] },
    );
    const selectCount = (html.match(/<select /g) ?? []).length;
    expect(selectCount).toBeGreaterThanOrEqual(2);
    expect(html).toContain('<select name="org" multiple');
    expect(html).toContain('<select name="repo" multiple');
  });

  test("marks currently-active repo filter values as selected (array)", () => {
    const html = renderTasksPage(
      [],
      { repo: ["app-vitals/repo-a", "app-vitals/repo-b"] },
      false,
      "user@test.com",
      {},
      pagination,
      undefined,
      {
        repos: ["app-vitals/repo-a", "app-vitals/repo-b", "app-vitals/repo-c"],
      },
    );
    expect(html).toContain(
      '<option value="app-vitals/repo-a" selected>app-vitals/repo-a</option>',
    );
    expect(html).toContain(
      '<option value="app-vitals/repo-b" selected>app-vitals/repo-b</option>',
    );
    expect(html).toContain(
      '<option value="app-vitals/repo-c">app-vitals/repo-c</option>',
    );
  });

  test("marks currently-active org filter values as selected (array)", () => {
    const html = renderTasksPage(
      [],
      { org: ["app-vitals"] },
      false,
      "user@test.com",
      {},
      pagination,
      undefined,
      { orgs: ["app-vitals", "other-org"] },
    );
    expect(html).toContain(
      '<option value="app-vitals" selected>app-vitals</option>',
    );
    expect(html).toContain('<option value="other-org">other-org</option>');
  });

  test("backward compat: a single-value repo filter (string, not array) is still marked selected", () => {
    const html = renderTasksPage(
      [],
      { repo: "app-vitals/repo-a" },
      false,
      "user@test.com",
      {},
      pagination,
      undefined,
      { repos: ["app-vitals/repo-a", "app-vitals/repo-b"] },
    );
    expect(html).toContain(
      '<option value="app-vitals/repo-a" selected>app-vitals/repo-a</option>',
    );
    expect(html).toContain(
      '<option value="app-vitals/repo-b">app-vitals/repo-b</option>',
    );
  });

  test("an active filter value not present in suggestions still renders as a selected option", () => {
    const html = renderTasksPage(
      [],
      { repo: ["app-vitals/stale-repo"] },
      false,
      "user@test.com",
      {},
      pagination,
      undefined,
      { repos: ["app-vitals/repo-a"] },
    );
    expect(html).toContain(
      '<option value="app-vitals/stale-repo" selected>app-vitals/stale-repo</option>',
    );
  });

  test("no repo/org filter active renders no selected options", () => {
    const html = renderTasksPage(
      [],
      {},
      false,
      "user@test.com",
      {},
      pagination,
      undefined,
      { orgs: ["app-vitals"], repos: ["app-vitals/repo-a"] },
    );
    expect(html).not.toContain("selected>");
  });

  test("removes the legacy single-value repo <input>+<datalist> markup", () => {
    const html = renderTasksPage(
      [],
      {},
      false,
      "user@test.com",
      {},
      pagination,
      undefined,
      { repos: ["app-vitals/repo-a"] },
    );
    expect(html).not.toContain('name="repo" type="text"');
    expect(html).not.toContain('<datalist id="repos-list">');
    expect(html).not.toContain('list="repos-list"');
  });

  test("escapes org/repo suggestion and filter values to prevent XSS", () => {
    const html = renderTasksPage(
      [],
      { org: ['<script>alert("xss")</script>'] },
      false,
      "user@test.com",
      {},
      pagination,
      undefined,
      { orgs: ['<script>alert("xss")</script>'] },
    );
    expect(html).not.toContain('<script>alert("xss")</script>');
    expect(html).toContain("&lt;script&gt;");
  });
});

// ─── renderTasksPage — blocker badges ────────────────────────────────────────

describe("renderTasksPage — blocker badges", () => {
  function render(tasks: TaskItem[]): string {
    return renderTasksPage(
      tasks,
      {},
      false,
      USER_NAME,
      {},
      { total: tasks.length, limit: 50, page: 1 },
      undefined,
      undefined,
    );
  }

  const PENDING_TASK_NO_BLOCKERS: TaskItem = {
    id: "TASK-3",
    title: "Pending nothing",
    status: "pending",
    session: null,
    repo: null,
    assignee: null,
    claimedBy: null,
    blockedBy: [],
  };

  const PENDING_TASK_HITL: TaskItem = {
    id: "TASK-4",
    title: "Waiting on human",
    status: "pending",
    session: null,
    repo: null,
    assignee: null,
    claimedBy: null,
    blockedBy: [{ type: "hitl" }],
  };

  const PENDING_TASK_DEP: TaskItem = {
    id: "TASK-5",
    title: "Blocked by dep",
    status: "pending",
    session: null,
    repo: null,
    assignee: null,
    claimedBy: null,
    blockedBy: [{ type: "dependency", id: "REL-2.2", status: "pending" }],
  };

  const PENDING_TASK_MULTI: TaskItem = {
    id: "TASK-6",
    title: "Multiple blockers",
    status: "pending",
    session: null,
    repo: null,
    assignee: null,
    claimedBy: null,
    blockedBy: [
      { type: "hitl" },
      { type: "dependency", id: "REL-3.1", status: "in_progress" },
    ],
  };

  // AC1: pending task with blockedBy entries shows badge(s) in the list view
  test("pending task with HITL block shows a blocker badge", () => {
    const html = render([PENDING_TASK_HITL]);
    expect(html).toContain("Waiting: HITL");
  });

  // AC2: HITL block renders as a distinct badge "Waiting: HITL"
  test("HITL badge renders as 'Waiting: HITL'", () => {
    const html = render([PENDING_TASK_HITL]);
    expect(html).toContain("Waiting: HITL");
    expect(html).toContain("badge-hitl");
  });

  // AC3: dep block renders with the dep ID "Blocked: REL-2.2", linked to the dep's task page
  test("dep block renders as 'Blocked: <dep-id>' linked to the dep's task page", () => {
    const html = render([PENDING_TASK_DEP]);
    expect(html).toContain("Blocked:");
    expect(html).toContain('<a href="/admin/tasks/REL-2.2"');
    expect(html).toContain(">REL-2.2</a>");
    expect(html).toContain("badge-dep");
  });

  // AC4: tasks with blockedBy: [] show no blocker badges
  test("empty blockedBy shows no blocker badges", () => {
    const html = render([PENDING_TASK_NO_BLOCKERS]);
    expect(html).not.toContain("Waiting: HITL");
    expect(html).not.toContain("Blocked:");
  });

  // AC5: multiple blockers all render
  test("task with multiple blockers renders all badges", () => {
    const html = render([PENDING_TASK_MULTI]);
    expect(html).toContain("Waiting: HITL");
    expect(html).toContain("Blocked:");
    expect(html).toContain('<a href="/admin/tasks/REL-3.1"');
    expect(html).toContain(">REL-3.1</a>");
  });

  // AC5: badges are visually distinct from status badges (different CSS class)
  test("blocker badges use different CSS classes than status badges", () => {
    const html = render([PENDING_TASK_HITL]);
    // Status badge uses badge-blue/badge-green/badge-red/badge-gray
    // Blocker badges must use badge-hitl or badge-dep — not the status classes
    expect(html).toContain("badge-hitl");
    expect(html).not.toContain('<span class="badge badge-blue">pending</span>');
    // The status badge for pending should use badge-gray
    expect(html).toContain('<span class="badge badge-gray">pending</span>');
  });

  // Task with undefined blockedBy shows no badges (backward compat)
  test("task without blockedBy field shows no blocker badges", () => {
    const taskNoBLockedBy: TaskItem = {
      id: "TASK-7",
      title: "Old task no blockedBy",
      status: "pending",
      session: null,
      repo: null,
      assignee: null,
      claimedBy: null,
    };
    const html = render([taskNoBLockedBy]);
    expect(html).not.toContain("Waiting: HITL");
    expect(html).not.toContain("Blocked:");
  });

  // XSS: dep id is escaped
  test("dep id is HTML-escaped in the badge", () => {
    const xssTask: TaskItem = {
      id: "TASK-8",
      title: "XSS task",
      status: "pending",
      session: null,
      repo: null,
      assignee: null,
      claimedBy: null,
      blockedBy: [
        {
          type: "dependency",
          id: "<script>alert(1)</script>",
          status: "pending",
        },
      ],
    };
    const html = render([xssTask]);
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  // Regression test for Sentry issue 7665355727: a {type:"blocked"} entry
  // (status:"blocked" tasks) previously fell through to the dependency
  // branch and crashed on taskLink(b.id)/escapeHtml(undefined).
  test("blocked entry with a populated reason renders the reason, not a crash", () => {
    const taskBlockedWithReason: TaskItem = {
      id: "TASK-9",
      title: "Explicitly blocked",
      status: "blocked",
      session: null,
      repo: null,
      assignee: null,
      claimedBy: null,
      blockedBy: [{ type: "blocked", reason: "Waiting on external vendor" }],
    };
    expect(() => render([taskBlockedWithReason])).not.toThrow();
    const html = render([taskBlockedWithReason]);
    expect(html).toContain("Waiting on external vendor");
    expect(html).not.toContain("undefined");
  });

  test("blocked entry with a null reason renders a fallback label, not a crash", () => {
    const taskBlockedNoReason: TaskItem = {
      id: "TASK-10",
      title: "Blocked, no reason recorded",
      status: "blocked",
      session: null,
      repo: null,
      assignee: null,
      claimedBy: null,
      blockedBy: [{ type: "blocked", reason: null }],
    };
    expect(() => render([taskBlockedNoReason])).not.toThrow();
    const html = render([taskBlockedNoReason]);
    expect(html).toContain("Blocked");
    expect(html).not.toContain("undefined");
  });

  test("blocked entry's reason is HTML-escaped", () => {
    const taskBlockedXss: TaskItem = {
      id: "TASK-11",
      title: "Blocked with unsafe reason",
      status: "blocked",
      session: null,
      repo: null,
      assignee: null,
      claimedBy: null,
      blockedBy: [{ type: "blocked", reason: "<script>alert(1)</script>" }],
    };
    const html = render([taskBlockedXss]);
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });
});

// ─── renderTasksPage — kind badge ──────────────────────────────────────────────

describe("renderTasksPage — kind badge (TKD-1.4)", () => {
  function render(tasks: TaskItem[]): string {
    return renderTasksPage(
      tasks,
      {},
      false,
      USER_NAME,
      {},
      { total: tasks.length, limit: 50, page: 1 },
      undefined,
      undefined,
    );
  }

  function renderBoard(
    tasks: TaskItem[],
    filters: Parameters<typeof renderTasksPage>[1] = {},
    suggestions: Parameters<typeof renderTasksPage>[7] = undefined,
    prsByTaskId: Parameters<typeof renderTasksPage>[10] = {},
    now?: Parameters<typeof renderTasksPage>[12],
  ): string {
    return renderTasksPage(
      tasks,
      filters,
      false,
      USER_NAME,
      {},
      { total: tasks.length, limit: 50, page: 1 },
      undefined,
      suggestions,
      false,
      "America/Los_Angeles",
      prsByTaskId,
      "board",
      now,
    );
  }

  // AC2: table view shows a "PRD" badge only for kind === "prd" tasks
  test("table view: task with kind 'prd' shows a PRD badge", () => {
    const prdTask: TaskItem = {
      id: "TASK-PRD-1",
      title: "PRD kind task",
      status: "pending",
      session: null,
      repo: null,
      assignee: null,
      claimedBy: null,
      kind: "prd",
    };
    const html = render([prdTask]);
    expect(html).toContain("PRD");
    expect(html).toContain("badge-purple");
  });

  // AC2: table view does NOT show a PRD badge for kind === "dev"
  test("table view: task with kind 'dev' does not show a PRD badge", () => {
    const devTask: TaskItem = {
      id: "TASK-DEV-1",
      title: "Dev kind task",
      status: "pending",
      session: null,
      repo: null,
      assignee: null,
      claimedBy: null,
      kind: "dev",
    };
    const html = render([devTask]);
    // The specific PRD badge should NOT be present (but there will be status badges, etc.)
    // To be precise: no PRD badge for dev kind
    const hasPrdBadgeSpan = html.includes(
      '<span class="badge badge-purple" style="font-size:10px;margin-left:6px">PRD</span>',
    );
    expect(hasPrdBadgeSpan).toBe(false);
  });

  // AC2: table view does NOT show a PRD badge for undefined/missing kind (backward compat)
  test("table view: task without kind field shows no PRD badge", () => {
    const taskNoKind: TaskItem = {
      id: "TASK-NO-KIND",
      title: "No kind task",
      status: "pending",
      session: null,
      repo: null,
      assignee: null,
      claimedBy: null,
    };
    const html = render([taskNoKind]);
    const hasPrdBadgeSpan = html.includes(
      '<span class="badge badge-purple" style="font-size:10px;margin-left:6px">PRD</span>',
    );
    expect(hasPrdBadgeSpan).toBe(false);
  });

  // AC2: board view shows a "PRD" badge only for kind === "prd" tasks
  test("board view: task with kind 'prd' shows a PRD badge", () => {
    const prdTask: TaskItem = {
      id: "BOARD-PRD-1",
      title: "Board PRD task",
      status: "pending",
      session: null,
      repo: null,
      assignee: null,
      claimedBy: null,
      kind: "prd",
    };
    const html = renderBoard([prdTask]);
    expect(html).toContain("PRD");
    expect(html).toContain("badge-purple");
  });

  // AC2: board view does NOT show a PRD badge for kind === "dev"
  test("board view: task with kind 'dev' does not show a PRD badge", () => {
    const devTask: TaskItem = {
      id: "BOARD-DEV-1",
      title: "Board dev task",
      status: "pending",
      session: null,
      repo: null,
      assignee: null,
      claimedBy: null,
      kind: "dev",
    };
    const html = renderBoard([devTask]);
    const hasPrdBadgeSpan = html.includes(
      '<span class="badge badge-purple" style="font-size:10px;margin-left:6px">PRD</span>',
    );
    expect(hasPrdBadgeSpan).toBe(false);
  });

  // AC2: board view does NOT show a PRD badge for undefined/missing kind (backward compat)
  test("board view: task without kind field shows no PRD badge", () => {
    const taskNoKind: TaskItem = {
      id: "BOARD-NO-KIND",
      title: "Board no kind task",
      status: "pending",
      session: null,
      repo: null,
      assignee: null,
      claimedBy: null,
    };
    const html = renderBoard([taskNoKind]);
    const hasPrdBadgeSpan = html.includes(
      '<span class="badge badge-purple" style="font-size:10px;margin-left:6px">PRD</span>',
    );
    expect(hasPrdBadgeSpan).toBe(false);
  });

  // XSS: kind value is escaped (even though it should only be "dev" | "prd")
  test("table view: kind value is HTML-escaped", () => {
    const xssTask = {
      id: "TASK-XSS",
      title: "XSS task",
      status: "pending",
      session: null,
      repo: null,
      assignee: null,
      claimedBy: null,
      kind: "<script>alert(1)</script>",
    } as TaskItem;
    const html = render([xssTask]);
    expect(html).not.toContain("<script>alert(1)</script>");
  });
});

// ─── renderTasksPage — PR column ──────────────────────────────────────────────

describe("renderTasksPage — PR column", () => {
  function render(tasks: TaskItem[]): string {
    return renderTasksPage(
      tasks,
      {},
      false,
      USER_NAME,
      {},
      { total: tasks.length, limit: 50, page: 1 },
      undefined,
      undefined,
    );
  }

  test("PR column header is present after Repo column", () => {
    const html = render([]);
    // Check for PR header in the table
    expect(html).toContain("<th>PR</th>");
  });

  test("task with pr value shows linked #N to GitHub PR", () => {
    const taskWithPr: TaskItem = {
      ...TASK_ITEM,
      pr: 42,
      repo: "org/repo",
    };
    const html = render([taskWithPr]);
    // Should render a link to the PR
    expect(html).toContain("https://github.com/org/repo/pull/42");
    expect(html).toContain("#42");
    expect(html).toContain('style="color:#6366f1;text-decoration:none"');
  });

  test("task without pr value shows em-dash", () => {
    const taskWithoutPr: TaskItem = {
      ...TASK_ITEM,
      pr: null,
      repo: "org/repo",
    };
    const html = render([taskWithoutPr]);
    // Should render an em-dash for no PR
    expect(html).toContain("—");
  });

  test("empty state colspan is 10 (9 columns + 1 for new Source column)", () => {
    const html = render([]);
    expect(html).toContain('colspan="10"');
  });

  test("task with pr value uses indigo link color matching ID column style", () => {
    const taskWithPr: TaskItem = {
      ...TASK_ITEM,
      pr: 99,
      repo: "app-vitals/shipwright",
    };
    const html = render([taskWithPr]);
    // PR link should match ID link style: color:#6366f1
    const prLinkMatch = html.match(
      /<a href="https:\/\/github\.com\/[^"]*"[^>]*>.*#99.*<\/a>/,
    );
    expect(prLinkMatch).not.toBeNull();
    if (prLinkMatch) {
      expect(prLinkMatch[0]).toContain("color:#6366f1");
    }
  });

  test("PR URL is correctly formatted with repo and pr number", () => {
    const taskWithPr: TaskItem = {
      ...TASK_ITEM,
      pr: 123,
      repo: "my-org/my-repo",
    };
    const html = render([taskWithPr]);
    expect(html).toContain("https://github.com/my-org/my-repo/pull/123");
  });

  test("XSS: repo in PR link is escaped", () => {
    const xssTask: TaskItem = {
      ...TASK_ITEM,
      pr: 1,
      repo: 'evil"><script>xss()</script>',
    };
    const html = render([xssTask]);
    expect(html).not.toContain("<script>xss");
    expect(html).toContain("&lt;script&gt;");
  });
});

// ─── renderTasksPage — source filter (CTV-4.2) ───────────────────────────────

describe("renderTasksPage — source filter", () => {
  function render(
    tasks: TaskItem[],
    filters: Parameters<typeof renderTasksPage>[1] = {},
  ): string {
    return renderTasksPage(
      tasks,
      filters,
      false,
      USER_NAME,
      {},
      { total: tasks.length, limit: 50, page: 1 },
      undefined,
      undefined,
    );
  }

  test("filter form has a source text input", () => {
    const html = render([]);
    expect(html).toContain('name="source"');
    expect(html).toContain('placeholder="source"');
  });

  test("source input value round-trips from filters.source", () => {
    const html = render([], { source: "entropy-fix" });
    expect(html).toContain('value="entropy-fix"');
  });

  test("source input escapes HTML in filters.source", () => {
    const html = render([], { source: '"><script>xss()</script>' });
    expect(html).not.toContain('"><script>xss()</script>');
    expect(html).toContain("&lt;script&gt;");
  });

  test("table header includes a Source column", () => {
    const html = render([]);
    expect(html).toContain('<th class="col-source">Source</th>');
  });

  test("row renders task.source value in the Source column", () => {
    const taskWithSource: TaskItem = { ...TASK_ITEM, source: "entropy-fix" };
    const html = render([taskWithSource]);
    expect(html).toContain("entropy-fix");
  });

  test("row without source shows em-dash placeholder", () => {
    const taskWithoutSource: TaskItem = { ...TASK_ITEM, source: null };
    const html = render([taskWithoutSource]);
    expect(html).toContain('<span style="color:#9ca3af">—</span>');
  });

  test("row escapes HTML in task.source", () => {
    const xssTask: TaskItem = {
      ...TASK_ITEM,
      source: '"><script>xss()</script>',
    };
    const html = render([xssTask]);
    expect(html).not.toContain('"><script>xss()</script>');
    expect(html).toContain("&lt;script&gt;");
  });

  test("makePageUrl carries filters.source into pagination links", () => {
    const html = renderTasksPage(
      [TASK_ITEM],
      { source: "entropy-fix" },
      false,
      USER_NAME,
      {},
      { total: 100, limit: 50, page: 1 },
      undefined,
      undefined,
    );
    expect(html).toContain("source=entropy-fix");
  });

  test("makeStateParams carries filters.source into state-tab links", () => {
    const html = renderTasksPage(
      [TASK_ITEM],
      { state: "ready", source: "entropy-fix" },
      false,
      USER_NAME,
      {},
      { total: 1, limit: 50, page: 1 },
      undefined,
      undefined,
    );
    expect(html).toContain(
      `href="/admin/tasks?state=in_progress&source=entropy-fix&view=table"`,
    );
  });

  test("makePageUrl carries multi-value filters.repo as repeated repo= params into pagination links, not comma-joined", () => {
    const html = renderTasksPage(
      [TASK_ITEM],
      { repo: ["app-vitals/repo-a", "app-vitals/repo-b"] },
      false,
      USER_NAME,
      {},
      { total: 100, limit: 50, page: 1 },
      undefined,
      undefined,
    );
    expect(html).toContain(
      'href="/admin/tasks?repo=app-vitals%2Frepo-a&repo=app-vitals%2Frepo-b&page=2&view=table"',
    );
    expect(html).not.toContain("app-vitals/repo-a,app-vitals/repo-b");
  });

  test("makePageUrl carries multi-value filters.org as repeated org= params into pagination links", () => {
    const html = renderTasksPage(
      [TASK_ITEM],
      { org: ["app-vitals", "other-org"] },
      false,
      USER_NAME,
      {},
      { total: 100, limit: 50, page: 1 },
      undefined,
      undefined,
    );
    expect(html).toContain(
      'href="/admin/tasks?org=app-vitals&org=other-org&page=2&view=table"',
    );
  });

  test("makeStateParams carries multi-value filters.repo as repeated repo= params into state-tab links", () => {
    const html = renderTasksPage(
      [TASK_ITEM],
      { state: "ready", repo: ["app-vitals/repo-a", "app-vitals/repo-b"] },
      false,
      USER_NAME,
      {},
      { total: 1, limit: 50, page: 1 },
      undefined,
      undefined,
    );
    expect(html).toContain(
      'href="/admin/tasks?state=in_progress&repo=app-vitals%2Frepo-a&repo=app-vitals%2Frepo-b&view=table"',
    );
  });

  test("makeStateParams carries multi-value filters.org as repeated org= params into state-tab links", () => {
    const html = renderTasksPage(
      [TASK_ITEM],
      { state: "ready", org: ["app-vitals", "other-org"] },
      false,
      USER_NAME,
      {},
      { total: 1, limit: 50, page: 1 },
      undefined,
      undefined,
    );
    expect(html).toContain(
      'href="/admin/tasks?state=in_progress&org=app-vitals&org=other-org&view=table"',
    );
  });

  test("makePageUrl backward-compat: a single-value (string) filters.repo still round-trips as one repo= param", () => {
    const html = renderTasksPage(
      [TASK_ITEM],
      { repo: "app-vitals/repo-a" },
      false,
      USER_NAME,
      {},
      { total: 100, limit: 50, page: 1 },
      undefined,
      undefined,
    );
    expect(html).toContain(
      'href="/admin/tasks?repo=app-vitals%2Frepo-a&page=2&view=table"',
    );
  });
});

// ─── renderTasksPage — Created column (ATC-1.5) ──────────────────────────────

describe("renderTasksPage — Created column", () => {
  function render(tasks: TaskItem[]): string {
    return renderTasksPage(
      tasks,
      {},
      false,
      USER_NAME,
      {},
      { total: tasks.length, limit: 50, page: 1 },
      undefined,
      undefined,
    );
  }

  test("Created column header is present with col-created class", () => {
    const html = render([]);
    expect(html).toContain('<th class="col-created">Created</th>');
  });

  test("task with createdAt renders formatted date in Created cell", () => {
    const taskWithCreatedAt: TaskItem = {
      ...TASK_ITEM,
      createdAt: "2026-07-10T09:30:00.000Z",
    };
    const html = render([taskWithCreatedAt]);
    const expected = new Date(
      taskWithCreatedAt.createdAt as string,
    ).toLocaleString("en-US", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: "America/Los_Angeles",
    });
    expect(html).toContain(expected);
  });

  test("task without createdAt shows em-dash in Created cell", () => {
    const taskWithoutCreatedAt: TaskItem = {
      ...TASK_ITEM,
      createdAt: null,
    };
    const html = render([taskWithoutCreatedAt]);
    const createdTdPattern =
      /<td class="col-created"[^>]*>\s*<span style="color:#9ca3af">—<\/span>\s*<\/td>/;
    expect(html).toMatch(createdTdPattern);
  });

  test("task with invalid createdAt falls back to raw string (NaN guard)", () => {
    const taskWithInvalidCreatedAt: TaskItem = {
      ...TASK_ITEM,
      createdAt: "not-a-date",
    };
    const html = render([taskWithInvalidCreatedAt]);
    expect(html).toContain("not-a-date");
  });

  test("Created <th> and <td> join the col-session/col-repo mobile-hide set", () => {
    const html = render([
      { ...TASK_ITEM, createdAt: "2026-07-10T09:30:00.000Z" },
    ]);
    expect(html).toContain('<th class="col-created">Created</th>');
    const createdTdPattern = /<td[^>]*class="[^"]*col-created[^"]*"[^>]*>/;
    expect(html).toMatch(createdTdPattern);
  });
});

// ─── renderTasksPage — PR column: renderer guard + prUrl fallback ─────────────

describe("renderTasksPage — PR column: renderer guard + prUrl fallback", () => {
  function render(tasks: TaskItem[]): string {
    return renderTasksPage(
      tasks,
      {},
      false,
      USER_NAME,
      {},
      { total: tasks.length, limit: 50, page: 1 },
      undefined,
      undefined,
    );
  }

  // (1) pr set + repo null → '--' (never github.com//pull/)
  test("pr set + repo null renders '--' (never github.com//pull/)", () => {
    const task: TaskItem = {
      ...TASK_ITEM,
      pr: 7,
      repo: null,
    };
    const html = render([task]);
    expect(html).not.toContain("github.com//pull/");
    expect(html).toContain("—");
    expect(html).not.toContain("github.com/null/pull/");
  });

  // (2) pr set + repo set → valid github link
  test("pr set + repo set renders valid github link", () => {
    const task: TaskItem = {
      ...TASK_ITEM,
      pr: 42,
      repo: "my-org/my-repo",
    };
    const html = render([task]);
    expect(html).toContain("https://github.com/my-org/my-repo/pull/42");
    expect(html).toContain("#42");
  });

  // (3) only prUrl set → link to prUrl
  test("only prUrl set renders a link to prUrl", () => {
    const task: TaskItem = {
      ...TASK_ITEM,
      pr: null,
      repo: null,
      prUrl: "https://github.com/org/repo/pull/99",
    };
    const html = render([task]);
    expect(html).toContain("https://github.com/org/repo/pull/99");
  });

  // (4) neither pr nor prUrl → '--'
  test("neither pr nor prUrl renders '--'", () => {
    const task: TaskItem = {
      ...TASK_ITEM,
      pr: null,
      repo: null,
      prUrl: null,
    };
    const html = render([task]);
    // em-dash for no PR
    expect(html).toContain("—");
    expect(html).not.toContain("github.com");
  });
});

// ─── renderTasksPage — 4-state toggle ────────────────────────────────────────

const EMPTY_PAGINATION = { total: 0, limit: 50, page: 1 };

describe("renderTasksPage — 4-state toggle", () => {
  test("no tab highlighted when no state filter (show all)", () => {
    const html = renderTasksPage(
      [],
      {},
      false,
      USER_NAME,
      {},
      EMPTY_PAGINATION,
      undefined,
      undefined,
    );
    // No tab should have active (indigo) styling
    expect(html).not.toContain("background:#6366f1;color:#fff");
    // All tabs are present
    expect(html).toContain("Ready");
    expect(html).toContain("In Progress");
    expect(html).toContain("Blocked");
    expect(html).toContain("Closed");
  });

  // TBF-1.1: Reset must stay in table view — a bare /admin/tasks link would
  // land on the board (AXR-1.3) instead of clearing filters within the
  // current table view.
  test("Reset button links to /admin/tasks?view=table with no other params", () => {
    const html = renderTasksPage(
      [],
      {},
      false,
      USER_NAME,
      {},
      EMPTY_PAGINATION,
      undefined,
      undefined,
    );
    expect(html).toContain(
      '<a href="/admin/tasks?view=table" class="btn btn-secondary" style="font-size:12px">Reset</a>',
    );
  });

  test("In Progress tab is active when state=in_progress", () => {
    const html = renderTasksPage(
      [],
      { state: "in_progress" },
      false,
      USER_NAME,
      {},
      EMPTY_PAGINATION,
      undefined,
      undefined,
    );
    // In Progress tab link contains ?state=in_progress
    expect(html).toContain("state=in_progress");
    // In Progress tab has active styling — find the active tab text near the indigo bg
    const activePattern = /background:#6366f1;color:#fff[^>]*>In Progress/;
    expect(html).toMatch(activePattern);
    // Ready, Blocked, Closed tabs are not active (no indigo on those links)
    // They should be white background
    expect(html).toMatch(/background:#fff;color:#374151[^>]*>Ready/);
    expect(html).toMatch(/background:#fff;color:#374151[^>]*>Blocked/);
    expect(html).toMatch(/background:#fff;color:#374151[^>]*>Closed/);
  });

  test("Blocked tab is active when state=blocked", () => {
    const html = renderTasksPage(
      [],
      { state: "blocked" },
      false,
      USER_NAME,
      {},
      EMPTY_PAGINATION,
      undefined,
      undefined,
    );
    expect(html).toContain("state=blocked");
    expect(html).toMatch(/background:#6366f1;color:#fff[^>]*>Blocked/);
    expect(html).toMatch(/background:#fff;color:#374151[^>]*>Ready/);
    expect(html).toMatch(/background:#fff;color:#374151[^>]*>In Progress/);
    expect(html).toMatch(/background:#fff;color:#374151[^>]*>Closed/);
  });

  test("Closed tab is active when state=closed", () => {
    const html = renderTasksPage(
      [],
      { state: "closed" },
      false,
      USER_NAME,
      {},
      EMPTY_PAGINATION,
      undefined,
      undefined,
    );
    expect(html).toContain("state=closed");
    expect(html).toMatch(/background:#6366f1;color:#fff[^>]*>Closed/);
    expect(html).toMatch(/background:#fff;color:#374151[^>]*>Ready/);
    expect(html).toMatch(/background:#fff;color:#374151[^>]*>In Progress/);
    expect(html).toMatch(/background:#fff;color:#374151[^>]*>Blocked/);
  });

  test("Ready tab is active and links to ?state=ready when state=ready", () => {
    const html = renderTasksPage(
      [],
      { state: "ready" },
      false,
      USER_NAME,
      {},
      EMPTY_PAGINATION,
      undefined,
      undefined,
    );
    // Ready tab has active (indigo) styling
    expect(html).toContain("background:#6366f1;color:#fff");
    // Ready tab href contains state=ready and stays in table view
    expect(html).toMatch(
      /href="\/admin\/tasks\?state=ready&view=table"[^>]*>Ready</,
    );
    // Other tabs are not active
    expect(html).toMatch(/background:#fff;color:#374151[^>]*>In Progress/);
    expect(html).toMatch(/background:#fff;color:#374151[^>]*>Blocked/);
    expect(html).toMatch(/background:#fff;color:#374151[^>]*>Closed/);
  });

  test("Tab links preserve session and repo query params", () => {
    const html = renderTasksPage(
      [],
      { state: "in_progress", session: "my-session", repo: "org/repo" },
      false,
      USER_NAME,
      {},
      EMPTY_PAGINATION,
      undefined,
      undefined,
    );
    // All tab links should contain session and repo params
    const tabLinkPattern =
      /href="\/admin\/tasks\?[^"]*session=my-session[^"]*"/g;
    const matches = html.match(tabLinkPattern);
    // We expect at least 3 tab links (Ready, Blocked, Closed) to preserve session (In Progress is active tab)
    expect(matches).not.toBeNull();
    expect((matches ?? []).length).toBeGreaterThanOrEqual(3);
    expect(html).toContain("repo=org");
  });

  test("Pagination URL carries correct ?state param for non-default states", () => {
    const html = renderTasksPage(
      [],
      { state: "blocked" },
      false,
      USER_NAME,
      {},
      { total: 100, limit: 50, page: 1 },
      undefined,
      undefined,
    );
    // Next button should link to page 2 with state=blocked
    expect(html).toContain("state=blocked");
    expect(html).toContain("page=2");
  });
});

// ─── renderTasksPage — board view (AXR-1.3) ──────────────────────────────────

describe("renderTasksPage — board view (AXR-1.3)", () => {
  const BOARD_PAGINATION = { total: 0, limit: 50, page: 1 };

  function renderBoard(
    tasks: TaskItem[],
    filters: Parameters<typeof renderTasksPage>[1] = {},
    suggestions: Parameters<typeof renderTasksPage>[7] = undefined,
    prsByTaskId: Parameters<typeof renderTasksPage>[10] = {},
    now?: Parameters<typeof renderTasksPage>[12],
  ): string {
    return renderTasksPage(
      tasks,
      filters,
      false,
      USER_NAME,
      {},
      { total: tasks.length, limit: 50, page: 1 },
      undefined,
      suggestions,
      false,
      "America/Los_Angeles",
      prsByTaskId,
      "board",
      now,
    );
  }

  test("renders 3 board columns in order: Queued, In Progress, Blocked-HITL (TBC-2.1)", () => {
    const html = renderBoard([]);
    expect(html).toContain('class="board"');
    expect(html).toContain("Queued");
    expect(html).toContain("In Progress");
    expect(html).toContain("Blocked-HITL");
    expect(html).not.toContain("Claimed");
    expect(html).not.toContain(">Done<");
    // Exactly 3 column containers
    expect((html.match(/class="column"/g) ?? []).length).toBe(3);
    // Columns must render left-to-right in this exact order.
    const dataColumnSequence = [...html.matchAll(/data-column="([^"]+)"/g)].map(
      (m) => m[1],
    );
    expect(dataColumnSequence).toEqual([
      "queued",
      "in_progress",
      "blocked_hitl",
    ]);
  });

  function extractColumn(html: string, key: string): string {
    const marker = `<div class="column" data-column="${key}">`;
    const start = html.indexOf(marker);
    if (start === -1) return "";
    const nextMarkerIndex = html.indexOf(
      '<div class="column" data-column="',
      start + marker.length,
    );
    const end = nextMarkerIndex === -1 ? html.length : nextMarkerIndex;
    return html.slice(start, end);
  }

  test("buckets a pending unclaimed task into Queued", () => {
    const task: TaskItem = {
      id: "T-QUEUED",
      title: "Queued task title",
      status: "pending",
      claimedBy: null,
      assignee: null,
    };
    const html = renderBoard([task]);
    expect(extractColumn(html, "queued")).toContain("Queued task title");
    expect(extractColumn(html, "claimed")).not.toContain("Queued task title");
  });

  test("a pending claimed task is absent from the default board — Claimed is no longer rendered (TBC-2.1)", () => {
    const task: TaskItem = {
      id: "T-CLAIMED",
      title: "Claimed task title",
      status: "pending",
      claimedBy: "agent-1",
      assignee: null,
    };
    const html = renderBoard([task]);
    expect(html).not.toContain('data-column="claimed"');
    expect(html).not.toContain("Claimed task title");
  });

  test("buckets an in_progress task into In Progress", () => {
    const task: TaskItem = {
      id: "T-INPROG",
      title: "In progress task title",
      status: "in_progress",
      claimedBy: "agent-1",
      assignee: null,
    };
    const html = renderBoard([task]);
    expect(extractColumn(html, "in_progress")).toContain(
      "In progress task title",
    );
  });

  test("buckets a blocked task into Blocked-HITL", () => {
    const task: TaskItem = {
      id: "T-BLOCKED",
      title: "Blocked task title",
      status: "blocked",
      claimedBy: null,
      assignee: null,
    };
    const html = renderBoard([task]);
    expect(extractColumn(html, "blocked_hitl")).toContain("Blocked task title");
  });

  test("buckets a hitl:true task into Blocked-HITL even when in_progress", () => {
    const task: TaskItem = {
      id: "T-HITL",
      title: "HITL task title",
      status: "in_progress",
      hitl: true,
      claimedBy: "agent-1",
      assignee: null,
    };
    const html = renderBoard([task]);
    expect(extractColumn(html, "blocked_hitl")).toContain("HITL task title");
    expect(extractColumn(html, "in_progress")).not.toContain("HITL task title");
  });

  test("a done task is absent from the default board — Done is no longer rendered (TBC-2.1)", () => {
    const task: TaskItem = {
      id: "T-DONE",
      title: "Done task title",
      status: "deployed",
      claimedBy: null,
      assignee: null,
    };
    const html = renderBoard([task]);
    expect(html).not.toContain('data-column="done"');
    expect(html).not.toContain("Done task title");
  });

  test("a task with a blocked joined PR lands in Blocked-HITL, matching bucketTaskColumn", () => {
    const task: TaskItem = {
      id: "T-PR-BLOCKED",
      title: "PR blocked task title",
      status: "in_progress",
      claimedBy: "agent-1",
      assignee: null,
      repo: "org/repo",
      pr: 5,
    };
    const pr: PrListItem = {
      id: "pr-1",
      repo: "org/repo",
      prNumber: 5,
      staged: false,
      state: "open",
      reviewState: "pending",
      patchCycles: 0,
      reviewCycles: 0,
      blocked: true,
      blockedReason: "Waiting on CI",
    };
    const html = renderBoard([task], {}, undefined, { [task.id]: pr });
    expect(extractColumn(html, "blocked_hitl")).toContain(
      "PR blocked task title",
    );
  });

  test("card shows the linked PR's blocked/HITL state inline, without a page navigation", () => {
    const task: TaskItem = {
      id: "T-PR-INLINE",
      title: "Inline PR badge task",
      status: "in_progress",
      claimedBy: "agent-1",
      assignee: null,
      repo: "org/repo",
      pr: 7,
    };
    const pr: PrListItem = {
      id: "pr-2",
      repo: "org/repo",
      prNumber: 7,
      staged: false,
      state: "open",
      reviewState: "pending",
      patchCycles: 0,
      reviewCycles: 0,
      blocked: true,
      blockedReason: "Needs human review",
    };
    const html = renderBoard([task], {}, undefined, { [task.id]: pr });
    // The badge/reason is rendered directly in the card's HTML (no separate
    // fetch or navigation required to see the blocked/HITL state).
    expect(html).toContain("Needs human review");
    expect(html).toContain('data-pr-blocked="true"');
  });

  test("default board filter row shows only Org and Repo selects — status/hitl/session/source/agent are collapsed under a <details> more-filters disclosure", () => {
    const html = renderBoard(
      [],
      {},
      { orgs: ["app-vitals"], repos: ["app-vitals/repo-a"] },
    );
    expect(html).toContain('<select name="org" multiple');
    expect(html).toContain('<select name="repo" multiple');
    expect(html).toContain('<details class="more-filters">');

    const detailsMatch = html.match(
      /<details class="more-filters">([\s\S]*?)<\/details>/,
    );
    expect(detailsMatch).not.toBeNull();
    const detailsHtml = detailsMatch ? detailsMatch[1] : "";
    expect(detailsHtml).toContain('name="status"');
    expect(detailsHtml).toContain('name="hitl"');
    expect(detailsHtml).toContain('name="session"');
    expect(detailsHtml).toContain('name="source"');
    expect(detailsHtml).toContain('name="agent"');

    // Org/Repo selects are not nested inside the disclosure — they render
    // ahead of it, in the always-visible filter row.
    const detailsIndex = html.indexOf('<details class="more-filters">');
    const orgIndex = html.indexOf('<select name="org" multiple');
    const repoIndex = html.indexOf('<select name="repo" multiple');
    expect(orgIndex).toBeGreaterThanOrEqual(0);
    expect(repoIndex).toBeGreaterThanOrEqual(0);
    expect(orgIndex).toBeLessThan(detailsIndex);
    expect(repoIndex).toBeLessThan(detailsIndex);
  });

  // TBC-2.1 follow-up: the board's Status dropdown must not offer a closed
  // status. Picking one would set `?status=…`, bypassing the board's
  // `state=open` default query, and every returned task buckets to the
  // "done" column — which TASK_BOARD_COLUMNS no longer renders — so the
  // board would silently show "No tasks" in all 3 columns.
  test("board Status dropdown omits closed statuses (merged/done/deploying/deployed/cancelled) but keeps the active ones", () => {
    const html = renderBoard([]);
    const statusSelect = html.match(
      /<select name="status"[^>]*>([\s\S]*?)<\/select>/,
    );
    expect(statusSelect).not.toBeNull();
    const statusHtml = statusSelect ? statusSelect[1] : "";

    for (const closed of [
      "merged",
      "done",
      "deploying",
      "deployed",
      "cancelled",
    ]) {
      expect(statusHtml).not.toContain(`value="${closed}"`);
    }

    expect(statusHtml).toContain("Any status");
    for (const active of [
      "pending",
      "in_progress",
      "pr_open",
      "approved",
      "blocked",
    ]) {
      expect(statusHtml).toContain(`value="${active}"`);
    }
  });

  test("table view's Status dropdown still offers every status, including the closed ones", () => {
    const html = renderTasksPage(
      [],
      {},
      false,
      USER_NAME,
      {},
      BOARD_PAGINATION,
      undefined,
      undefined,
      false,
      "America/Los_Angeles",
      {},
      "table",
    );
    const statusSelect = html.match(
      /<select name="status"[^>]*>([\s\S]*?)<\/select>/,
    );
    expect(statusSelect).not.toBeNull();
    const statusHtml = statusSelect ? statusSelect[1] : "";
    for (const status of [
      "pending",
      "in_progress",
      "pr_open",
      "approved",
      "merged",
      "done",
      "deploying",
      "deployed",
      "blocked",
      "cancelled",
    ]) {
      expect(statusHtml).toContain(`value="${status}"`);
    }
  });

  test("Org and Repo remain two independent multiselects on the board, not merged into one combined scope-pill selector", () => {
    const html = renderBoard(
      [],
      {},
      { orgs: ["app-vitals"], repos: ["app-vitals/repo-a"] },
    );
    const selectCount = (html.match(/<select /g) ?? []).length;
    // org, repo, plus status + hitl inside <details> == 4 total <select>s
    expect(selectCount).toBeGreaterThanOrEqual(2);
    expect(html).toContain('<select name="org" multiple');
    expect(html).toContain('<select name="repo" multiple');
  });

  test("selecting an org with no repo selected renders all repo options unfiltered (org and repo stay independent dimensions)", () => {
    const html = renderBoard(
      [],
      { org: ["app-vitals"] },
      {
        orgs: ["app-vitals", "other-org"],
        repos: ["app-vitals/repo-a", "app-vitals/repo-b", "other-org/repo-c"],
      },
    );
    // Org is selected...
    expect(html).toContain(
      '<option value="app-vitals" selected>app-vitals</option>',
    );
    // ...but the Repo select still lists every repo, including ones under
    // other orgs, and none of them are pre-selected — selecting an org does
    // not narrow or auto-select repo options.
    expect(html).toContain('<option value="app-vitals/repo-a">');
    expect(html).toContain('<option value="app-vitals/repo-b">');
    expect(html).toContain('<option value="other-org/repo-c">');
    const repoSelectMatch = html.match(
      /<select name="repo" multiple[^>]*>([\s\S]*?)<\/select>/,
    );
    expect(repoSelectMatch).not.toBeNull();
    expect(repoSelectMatch ? repoSelectMatch[1] : "").not.toContain("selected");
  });

  test("view: 'board' is reachable via a link back to the table view (?view=table)", () => {
    const html = renderBoard([]);
    expect(html).toContain("view=table");
  });

  // ─── Task board card slide-over drawer (AXR-1.4) ───────────────────────────────
  // Each card opens a drawer showing full task + joined PR detail via a checkbox-driven
  // off-canvas pattern, reusing the existing chat-drawer mechanics.

  test("each board card renders a hidden checkbox with id=task-drawer-toggle-{taskId}", () => {
    const task: TaskItem = {
      id: "DRAWER-TEST",
      title: "Drawer test task",
      status: "pending",
      claimedBy: null,
      assignee: null,
    };
    const html = renderBoard([task]);
    expect(html).toContain('id="task-drawer-toggle-DRAWER-TEST"');
    expect(html).toContain('class="task-drawer-toggle"');
    expect(html).toContain('aria-hidden="true"');
  });

  // aria-hidden only removes the checkbox from the accessibility tree, not the
  // tab order — without tabindex="-1" a keyboard user can Tab to the hidden
  // per-card checkbox and Space-check it directly, bypassing the card's click
  // handler (the only place that closes any other already-open drawer) and
  // ending up with two stacked .task-drawer panels.
  test("hidden drawer checkbox is removed from tab order via tabindex=-1", () => {
    const task: TaskItem = {
      id: "TABINDEX-TEST",
      title: "Tabindex test task",
      status: "pending",
      claimedBy: null,
      assignee: null,
    };
    const html = renderBoard([task]);
    expect(html).toContain('id="task-drawer-toggle-TABINDEX-TEST"');
    expect(html).toContain('tabindex="-1"');
  });

  test("drawer checkbox appears before the drawer panel in DOM order", () => {
    const task: TaskItem = {
      id: "DOM-ORDER-TEST",
      title: "DOM order test",
      status: "pending",
      claimedBy: null,
      assignee: null,
    };
    const html = renderBoard([task]);
    const checkboxIndex = html.indexOf(
      'id="task-drawer-toggle-DOM-ORDER-TEST"',
    );
    const drawerPanelIndex = html.indexOf('class="task-drawer"');
    expect(checkboxIndex).toBeGreaterThanOrEqual(0);
    expect(drawerPanelIndex).toBeGreaterThanOrEqual(0);
    expect(checkboxIndex).toBeLessThan(drawerPanelIndex);
  });

  test("drawer renders a scrim label bound to the drawer toggle", () => {
    const task: TaskItem = {
      id: "SCRIM-TEST",
      title: "Scrim test task",
      status: "pending",
      claimedBy: null,
      assignee: null,
    };
    const html = renderBoard([task]);
    expect(html).toContain('class="task-drawer-scrim"');
    expect(html).toContain('for="task-drawer-toggle-SCRIM-TEST"');
  });

  test("drawer panel renders the task title and id", () => {
    const task: TaskItem = {
      id: "TITLE-ID-TEST",
      title: "My task title",
      status: "pending",
      claimedBy: null,
      assignee: null,
    };
    const html = renderBoard([task]);
    const drawerPanel = html.match(
      /class="task-drawer"[^>]*>([\s\S]*?)<\/div>\s*<\/div>\s*<\/div>/,
    );
    expect(drawerPanel).not.toBeNull();
    if (drawerPanel) {
      expect(drawerPanel[1]).toContain("My task title");
      expect(drawerPanel[1]).toContain("TITLE-ID-TEST");
    }
  });

  test("drawer panel includes PR state and reviewState when a joined PR exists", () => {
    const task: TaskItem = {
      id: "PR-STATE-TEST",
      title: "PR state test",
      status: "in_progress",
      claimedBy: "agent-1",
      assignee: null,
      repo: "org/repo",
      pr: 42,
    };
    const pr: PrListItem = {
      id: "pr-1",
      repo: "org/repo",
      prNumber: 42,
      staged: false,
      state: "open",
      reviewState: "approved",
      patchCycles: 1,
      reviewCycles: 2,
      blocked: false,
    };
    const html = renderBoard([task], {}, undefined, { [task.id]: pr });
    const drawerPanel = html.match(
      /class="task-drawer"[^>]*>([\s\S]*?)<\/div>\s*<\/div>\s*<\/div>/,
    );
    expect(drawerPanel).not.toBeNull();
    if (drawerPanel) {
      // The drawer should show the PR state and review state
      expect(drawerPanel[1]).toContain("open");
      expect(drawerPanel[1]).toContain("approved");
    }
  });

  test("multiple cards each get unique drawer checkbox ids", () => {
    const tasks: TaskItem[] = [
      {
        id: "TASK-1",
        title: "Task 1",
        status: "pending",
        claimedBy: null,
        assignee: null,
      },
      {
        id: "TASK-2",
        title: "Task 2",
        status: "pending",
        claimedBy: null,
        assignee: null,
      },
      {
        id: "TASK-3",
        title: "Task 3",
        status: "pending",
        claimedBy: null,
        assignee: null,
      },
    ];
    const html = renderBoard(tasks);
    expect(html).toContain('id="task-drawer-toggle-TASK-1"');
    expect(html).toContain('id="task-drawer-toggle-TASK-2"');
    expect(html).toContain('id="task-drawer-toggle-TASK-3"');
    // Verify no duplicate ids
    const idMatches = html.match(/id="task-drawer-toggle-[^"]+"/g) ?? [];
    expect(idMatches.length).toBe(3);
    expect(new Set(idMatches).size).toBe(3);
  });

  test("readOnly board rendering does not render drawer toggles or scrims", () => {
    const task: TaskItem = {
      id: "READONLY-TEST",
      title: "Readonly task",
      status: "pending",
      claimedBy: null,
      assignee: null,
    };
    const html = renderTasksPage(
      [task],
      {},
      false,
      USER_NAME,
      {},
      BOARD_PAGINATION,
      undefined,
      undefined,
      true, // readOnly = true
      "America/Los_Angeles",
      {},
      "board",
    );
    // Check that the HTML elements are not rendered (the class definitions in CSS are OK)
    expect(html).not.toContain('id="task-drawer-toggle-');
    expect(html).not.toContain('class="task-drawer-scrim"');
    expect(html).not.toContain('class="task-drawer"');
    expect(html).not.toContain("data-drawer-toggle=");
  });

  // Opening a card's drawer must close any other drawer already open — two
  // .task-drawer panels are both position:fixed at the same spot, so leaving
  // a prior toggle checked would stack an invisible-but-still-checked drawer
  // behind the new one instead of a clean single-drawer UX.
  test("click handler closes any other open drawer before opening the clicked card's", () => {
    const html = renderBoard([
      {
        id: "T-A",
        title: "A",
        status: "pending",
        claimedBy: null,
        assignee: null,
      },
      {
        id: "T-B",
        title: "B",
        status: "pending",
        claimedBy: null,
        assignee: null,
      },
    ]);
    expect(html).toContain(
      '.task-drawer-toggle:checked").forEach(function(openToggle)',
    );
    expect(html).toContain(
      "if (openToggle.id !== toggleId) openToggle.checked = false;",
    );
  });

  // ─── board card age badge (TBC-1.1) ─────────────────────────────────────
  // The board card should surface a relative age derived from createdAt,
  // using the same <span title="{ISO}">{relative}</span> pattern as the
  // Queue/Activity table's ageCell (~line 4108) and cron last-run age
  // (~line 1191), driven by an explicitly-injected `now` (t2_clock_injection
  // — no `new Date()` inside the render chain itself). Nested here (rather
  // than a sibling top-level describe) so it can reuse this block's local
  // `renderBoard` helper.
  describe("board card age badge (TBC-1.1)", () => {
    const NOW = new Date("2026-09-04T12:00:00.000Z");

    test("createdAt a few seconds before now renders 'just now' with the ISO timestamp in a title attribute", () => {
      const createdAt = new Date(NOW.getTime() - 5_000).toISOString();
      const task: TaskItem = {
        id: "T-AGE-NOW",
        title: "Fresh task",
        status: "pending",
        claimedBy: null,
        assignee: null,
        createdAt,
      };
      const html = renderBoard([task], {}, undefined, {}, NOW);
      expect(html).toContain(`title="${createdAt}"`);
      expect(html).toContain(">just now<");
    });

    test("createdAt several hours before now renders 'N hours ago' with the ISO timestamp in a title attribute", () => {
      const createdAt = new Date(
        NOW.getTime() - 5 * 60 * 60 * 1000,
      ).toISOString();
      const task: TaskItem = {
        id: "T-AGE-HOURS",
        title: "Hours-old task",
        status: "pending",
        claimedBy: null,
        assignee: null,
        createdAt,
      };
      const html = renderBoard([task], {}, undefined, {}, NOW);
      expect(html).toContain(`title="${createdAt}"`);
      expect(html).toContain(">5 hours ago<");
    });

    test("createdAt several days before now renders 'N days ago' with the ISO timestamp in a title attribute", () => {
      const createdAt = new Date(
        NOW.getTime() - 3 * 24 * 60 * 60 * 1000,
      ).toISOString();
      const task: TaskItem = {
        id: "T-AGE-DAYS",
        title: "Days-old task",
        status: "pending",
        claimedBy: null,
        assignee: null,
        createdAt,
      };
      const html = renderBoard([task], {}, undefined, {}, NOW);
      expect(html).toContain(`title="${createdAt}"`);
      expect(html).toContain(">3 days ago<");
    });

    test("missing createdAt renders the card without throwing and without an age badge", () => {
      const task: TaskItem = {
        id: "T-AGE-MISSING",
        title: "No createdAt task",
        status: "pending",
        claimedBy: null,
        assignee: null,
        createdAt: null,
      };
      expect(() => renderBoard([task], {}, undefined, {}, NOW)).not.toThrow();
      const html = renderBoard([task], {}, undefined, {}, NOW);
      expect(html).toContain("No createdAt task");
      expect(html).not.toContain("ago<");
      expect(html).not.toContain("just now<");
    });

    test("undefined createdAt (field entirely absent) renders the card without throwing and without an age badge", () => {
      const task: TaskItem = {
        id: "T-AGE-UNDEFINED",
        title: "Undefined createdAt task",
        status: "pending",
        claimedBy: null,
        assignee: null,
      };
      expect(() => renderBoard([task], {}, undefined, {}, NOW)).not.toThrow();
      const html = renderBoard([task], {}, undefined, {}, NOW);
      expect(html).toContain("Undefined createdAt task");
      expect(html).not.toContain("ago<");
      expect(html).not.toContain("just now<");
    });
  });
});

// ─── renderTasksPage — board full page width (TBF-1.2) ──────────────────────
// The board (default view) should stretch past the shared 960px .vos-page
// cap; table view must stay untouched. Mirrors the .vos-page inline-style
// assertion pattern at ~line 7236.

describe("renderTasksPage — board full page width (TBF-1.2)", () => {
  test("board view's .vos-page wrapper carries the tasks-board-page modifier class", () => {
    const html = renderTasksPage(
      [],
      {},
      false,
      USER_NAME,
      {},
      { total: 0, limit: 50, page: 1 },
      undefined,
      undefined,
      false,
      "America/Los_Angeles",
      {},
      "board",
    );
    const match = html.match(/<div class="vos-page[^"]*">/);
    expect(match).not.toBeNull();
    expect(match?.[0]).toContain("tasks-board-page");
  });

  test("table view's .vos-page wrapper does not carry the tasks-board-page modifier class", () => {
    const html = renderTasksPage(
      [],
      {},
      false,
      USER_NAME,
      {},
      { total: 0, limit: 50, page: 1 },
      undefined,
      undefined,
      false,
      "America/Los_Angeles",
      {},
      "table",
    );
    const match = html.match(/<div class="vos-page[^"]*">/);
    expect(match).not.toBeNull();
    expect(match?.[0]).not.toContain("tasks-board-page");
  });
});

// ─── renderTasksPage — ?view=table toggle (AXR-1.3) ──────────────────────────

describe("renderTasksPage — ?view=table toggle (AXR-1.3)", () => {
  test("view: 'table' produces identical output to the default (omitted) view — the pre-redesign table renderer is preserved and reachable, not deleted", () => {
    const tasks: TaskItem[] = [
      {
        id: "T-1",
        title: "Some task",
        status: "in_progress",
        session: "s-1",
        repo: "org/repo",
        assignee: null,
        claimedBy: "agent-1",
        pr: 9,
      },
    ];
    const filters: Parameters<typeof renderTasksPage>[1] = {
      status: "in_progress",
    };
    const agentNames = { "agent-1": "Agent One" };
    const pagination = { total: 1, limit: 50, page: 1 };
    const suggestions = { orgs: ["org"], repos: ["org/repo"] };
    const prsByTaskId: Record<string, PrListItem> = {};

    const withoutView = renderTasksPage(
      tasks,
      filters,
      false,
      USER_NAME,
      agentNames,
      pagination,
      undefined,
      suggestions,
      false,
      "America/Los_Angeles",
      prsByTaskId,
    );
    const withExplicitTable = renderTasksPage(
      tasks,
      filters,
      false,
      USER_NAME,
      agentNames,
      pagination,
      undefined,
      suggestions,
      false,
      "America/Los_Angeles",
      prsByTaskId,
      "table",
    );

    expect(withExplicitTable).toEqual(withoutView);
    // Sanity: this is genuinely the dense table markup, not the board.
    expect(withExplicitTable).toContain('<table class="data-table">');
    expect(withExplicitTable).toContain("<th>ID</th>");
    expect(withExplicitTable).toContain("<th>PR</th>");
  });

  test("view: 'board' output is structurally different from view: 'table' output for the same data", () => {
    const tasks: TaskItem[] = [
      {
        id: "T-2",
        title: "Another task",
        status: "pending",
        claimedBy: null,
        assignee: null,
      },
    ];
    const pagination = { total: 1, limit: 50, page: 1 };
    const table = renderTasksPage(
      tasks,
      {},
      false,
      USER_NAME,
      {},
      pagination,
      undefined,
      undefined,
      false,
      "America/Los_Angeles",
      {},
      "table",
    );
    const board = renderTasksPage(
      tasks,
      {},
      false,
      USER_NAME,
      {},
      pagination,
      undefined,
      undefined,
      false,
      "America/Los_Angeles",
      {},
      "board",
    );
    expect(table).not.toEqual(board);
    expect(table).toContain('<table class="data-table">');
    expect(board).not.toContain('<table class="data-table">');
    expect(board).toContain('class="board"');
  });
});

// ─── renderTaskDetailPage ────────────────────────────────────────────────────

const TASK_DETAIL: TaskItem = {
  id: "TS-1",
  title: "Do the thing",
  status: "blocked",
  description: "## Overview\nThis task does something.",
  acceptanceCriteria: [
    "AC1: `foo` is set",
    "AC2: List works:\n- item one\n- item two",
  ],
  blockedBy: [
    { type: "dependency", id: "TS-dep", status: "pending" },
    { type: "hitl" },
  ],
};

describe("renderTaskDetailPage — blockers", () => {
  function render(task: Partial<TaskItem> = {}): string {
    return renderTaskDetailPage(
      { ...TASK_DETAIL, ...task },
      "user@example.com",
      {},
      "UTC",
    );
  }

  test("shows blockers section when blockedBy is non-empty", () => {
    const html = render();
    expect(html.toLowerCase()).toContain("blocker");
  });

  test("shows dependency blocker with dep id and status", () => {
    const html = render();
    expect(html).toContain("TS-dep");
    expect(html).toContain("pending");
  });

  test("dependency blocker id links to its task detail page", () => {
    const html = render();
    expect(html).toContain('<a href="/admin/tasks/TS-dep"');
  });

  test("shows hitl blocker type", () => {
    const html = render();
    expect(html.toLowerCase()).toContain("hitl");
  });

  test("no blockers section when blockedBy is empty", () => {
    const html = render({ blockedBy: [] });
    expect(html).not.toMatch(/Blockers<\/div>/i);
  });

  test("no blockers section when blockedBy is null", () => {
    const html = render({ blockedBy: null });
    expect(html).not.toMatch(/Blockers<\/div>/i);
  });

  test("no blockers section when blockedBy is undefined", () => {
    const html = render({ blockedBy: undefined });
    expect(html).not.toMatch(/Blockers<\/div>/i);
  });

  test("hitl notified variant shows different text", () => {
    const html = render({
      blockedBy: [{ type: "hitl", notified: true }],
    });
    expect(html.toLowerCase()).toContain("hitl");
  });

  test("XSS: dep id in blockers is escaped", () => {
    const html = render({
      blockedBy: [
        { type: "dependency", id: "<script>xss()</script>", status: "pending" },
      ],
    });
    expect(html).not.toContain("<script>xss");
    expect(html).toContain("&lt;script&gt;");
  });

  // Regression test for Sentry issue 7665355727: a {type:"blocked"} entry
  // previously fell through to the dependency branch and crashed on
  // taskLink(b.id)/escapeHtml(b.status), both undefined for this variant.
  test("blocked entry with a populated reason renders the reason, not a crash", () => {
    expect(() =>
      render({
        blockedBy: [{ type: "blocked", reason: "Waiting on external vendor" }],
      }),
    ).not.toThrow();
    const html = render({
      blockedBy: [{ type: "blocked", reason: "Waiting on external vendor" }],
    });
    expect(html).toContain("Waiting on external vendor");
    expect(html).not.toContain("undefined");
  });

  test("blocked entry with a null reason renders a fallback label, not a crash", () => {
    expect(() =>
      render({ blockedBy: [{ type: "blocked", reason: null }] }),
    ).not.toThrow();
    const html = render({ blockedBy: [{ type: "blocked", reason: null }] });
    expect(html).toContain("Blocked");
    expect(html).not.toContain("undefined");
  });

  test("blocked entry's reason is HTML-escaped in the blockers list", () => {
    const html = render({
      blockedBy: [{ type: "blocked", reason: "<script>xss()</script>" }],
    });
    expect(html).not.toContain("<script>xss");
    expect(html).toContain("&lt;script&gt;");
  });

  test("blockers card appears before description card when blockedBy is set", () => {
    const html = render();
    const blockersIdx = html.indexOf("Blockers");
    const descriptionIdx = html.indexOf("Description");
    expect(blockersIdx).toBeGreaterThan(-1);
    expect(descriptionIdx).toBeGreaterThan(-1);
    expect(blockersIdx).toBeLessThan(descriptionIdx);
  });
});

describe("renderTaskDetailPage — dependencies", () => {
  function render(task: Partial<TaskItem> = {}): string {
    return renderTaskDetailPage(
      { ...TASK_DETAIL, ...task },
      "user@example.com",
      {},
      "UTC",
    );
  }

  test("dependency ids link to their task detail pages", () => {
    const html = render({ dependencies: ["TASK-A", "TASK-B"] });
    expect(html).toContain('<a href="/admin/tasks/TASK-A"');
    expect(html).toContain('<a href="/admin/tasks/TASK-B"');
  });

  test("no dependencies field when dependencies is empty", () => {
    const html = render({ dependencies: [] });
    expect(html).not.toContain("Dependencies");
  });
});

describe("renderTaskDetailPage — agent field linkability", () => {
  function render(
    task: Partial<TaskItem> = {},
    agentNames: Record<string, string> = {},
  ): string {
    return renderTaskDetailPage(
      { ...TASK_DETAIL, ...task },
      "user@example.com",
      agentNames,
      "UTC",
    );
  }

  test("Assignee links to the agent detail page", () => {
    const html = render({ assignee: "agent-a" });
    expect(html).toContain('<a href="/admin/agents/agent-a"');
  });

  test("Agent Hint links to the agent detail page", () => {
    const html = render({ agentHint: "agent-b" });
    expect(html).toContain('<a href="/admin/agents/agent-b"');
  });

  test("Claimed By links to the agent detail page and shows display name", () => {
    const html = render(
      { claimedBy: "agent-c" },
      { "agent-c": "Agent Charlie" },
    );
    expect(html).toContain('<a href="/admin/agents/agent-c"');
    expect(html).toContain("Agent Charlie (agent-c)");
  });

  test("no Assignee/Agent Hint/Claimed By rows when unset", () => {
    const html = render({ assignee: null, agentHint: null, claimedBy: null });
    expect(html).not.toContain("/admin/agents/");
  });
});

describe("renderTaskDetailPage — markdown", () => {
  function render(task: Partial<TaskItem> = {}): string {
    return renderTaskDetailPage(
      { ...TASK_DETAIL, ...task },
      "user@example.com",
      {},
      "UTC",
    );
  }

  test("description headings rendered as HTML heading tags", () => {
    const html = render({ description: "## My heading\nsome text" });
    expect(html).toMatch(/<h[1-6][^>]*>.*My heading.*<\/h[1-6]>/s);
  });

  test("description code block rendered as pre/code", () => {
    const html = render({ description: "```\nconst x = 1;\n```" });
    expect(html).toContain("<pre");
    expect(html).toContain("<code");
  });

  test("description inline code rendered as code tag", () => {
    const html = render({ description: "Use `foo()` here." });
    expect(html).toContain("<code>");
  });

  test("description lists rendered as ul/li", () => {
    const html = render({ description: "- item one\n- item two" });
    expect(html).toContain("<ul");
    expect(html).toContain("<li");
  });

  test("acceptance criteria items support inline code", () => {
    const html = render({
      acceptanceCriteria: ["AC with `code` inside"],
    });
    expect(html).toContain("<code>");
    expect(html).toContain("code");
  });

  test("acceptance criteria items support bold", () => {
    const html = render({
      acceptanceCriteria: ["AC with **bold** text"],
    });
    expect(html).toContain("<strong>");
  });

  test("plain text fields (title, id, status) are not treated as markdown", () => {
    const html = render({ title: "## Not a heading", id: "TS-**bold**-1" });
    expect(html).toContain("## Not a heading");
    expect(html).toContain("TS-**bold**-1");
  });

  test("XSS: markdown description with script tag is escaped", () => {
    const html = render({ description: "<script>evil()</script>" });
    expect(html).not.toContain("<script>evil");
    expect(html).toContain("&lt;script&gt;");
  });

  test("XSS: markdown description with img onerror is escaped", () => {
    const html = render({ description: "<img src=x onerror=bad()>" });
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img");
  });

  test("multi-line code block: interior lines starting with '- ' are not wrapped in <li>", () => {
    // Regression: before the placeholder fix, lines inside a fenced block that
    // started with "- " or "* " were handed to the line loop and wrapped in <li>.
    // Use a minimal task with no blockers/AC so the only <li>s come from the description.
    const html = renderTaskDetailPage(
      {
        id: "TS-CB",
        title: "Code block test",
        status: "pending",
        description: "```\n- item one\n- item two\n```",
        acceptanceCriteria: [],
        blockedBy: [],
      },
      "user@example.com",
      {},
      "UTC",
    );
    // Content must be inside <pre><code>, not broken out into list items
    expect(html).toContain("<pre>");
    expect(html).toContain("<code>");
    // The raw list-like text should appear inside the code block, not as HTML list markup
    expect(html).toContain("- item one");
    expect(html).toContain("- item two");
    // The interior lines must NOT produce orphaned <li> tags — there is no actual
    // list in this input, so no <li> should appear anywhere in the rendered page.
    expect(html).not.toContain("<li>");
  });
});

// ─── renderTaskDetailPage — back link (TBL-1.1) ──────────────────────────────

describe("renderTaskDetailPage — back link (TBL-1.1)", () => {
  // AC3: default back link is the bare /admin/tasks URL when backHref is omitted
  test("defaults to bare /admin/tasks when backHref is not provided", () => {
    const html = renderTaskDetailPage(
      TASK_DETAIL,
      "user@example.com",
      {},
      "UTC",
    );
    expect(html).toContain(
      `<a href="/admin/tasks" style="color:#6b7280;font-size:13px;text-decoration:none">← Tasks</a>`,
    );
  });

  // AC3: a provided backHref is rendered (HTML-escaped) for the ← Tasks anchor
  test("renders the given backHref for the ← Tasks anchor", () => {
    const backHref = "/admin/tasks?status=in_progress&page=2";
    const html = renderTaskDetailPage(
      TASK_DETAIL,
      "user@example.com",
      {},
      "UTC",
      undefined,
      backHref,
    );
    expect(html).toContain(
      `<a href="${backHref.replace(/&/g, "&amp;")}" style="color:#6b7280;font-size:13px;text-decoration:none">← Tasks</a>`,
    );
  });

  // AC3: backHref is HTML-escaped to prevent attribute-breakout XSS
  test("HTML-escapes a malicious backHref", () => {
    const html = renderTaskDetailPage(
      TASK_DETAIL,
      "user@example.com",
      {},
      "UTC",
      undefined,
      '/admin/tasks"><script>xss()</script>',
    );
    expect(html).not.toContain('"><script>xss()</script>');
    expect(html).toContain("&lt;script&gt;");
  });
});

// ─── renderSessionDetailPage — back link (ABL-1.1) ───────────────────────────

describe("renderSessionDetailPage — back link (ABL-1.1)", () => {
  // AC3: default back link is the bare /admin/tasks URL when backHref is omitted
  test("defaults to bare /admin/tasks when backHref is not provided", () => {
    const html = renderSessionDetailPage("session-abc", [], "user@example.com");
    expect(html).toContain(
      `<a href="/admin/tasks" style="color:#6b7280;font-size:13px;text-decoration:none">← Tasks</a>`,
    );
  });

  // AC3/AC4: a provided backHref is rendered (HTML-escaped) for the ← Tasks anchor
  test("renders the given backHref for the ← Tasks anchor", () => {
    const backHref = "/admin/tasks?status=in_progress&page=2";
    const html = renderSessionDetailPage(
      "session-abc",
      [],
      "user@example.com",
      false,
      backHref,
    );
    expect(html).toContain(
      `<a href="${backHref.replace(/&/g, "&amp;")}" style="color:#6b7280;font-size:13px;text-decoration:none">← Tasks</a>`,
    );
  });

  // AC3: backHref is HTML-escaped to prevent attribute-breakout XSS
  test("HTML-escapes a malicious backHref", () => {
    const html = renderSessionDetailPage(
      "session-abc",
      [],
      "user@example.com",
      false,
      '/admin/tasks"><script>xss()</script>',
    );
    expect(html).not.toContain('"><script>xss()</script>');
    expect(html).toContain("&lt;script&gt;");
  });
});

// ─── renderTaskDetailPage — timezone formatting ───────────────────────────────

describe("renderTaskDetailPage — timezone formatting", () => {
  test("dateField renders timestamp in Pacific time for America/Los_Angeles", () => {
    // 2025-01-15T20:00:00Z = Jan 15 8pm UTC = Jan 15 12pm Pacific (UTC-8 in January)
    // So this should show Jan 15 in both UTC and Pacific. Use a time that crosses midnight.
    // 2025-01-16T05:00:00Z = Jan 16 5am UTC = Jan 15 9pm Pacific (UTC-8)
    const html = renderTaskDetailPage(
      {
        id: "TZ-1",
        title: "Timezone test",
        status: "pending",
        createdAt: "2025-01-16T05:00:00Z", // Jan 16 UTC, Jan 15 Pacific
      },
      "user@example.com",
      {},
      "America/Los_Angeles",
    );
    // In Pacific time (UTC-8), 2025-01-16T05:00:00Z is Jan 15 9pm → displays Jan 15
    // toLocaleString("en-US", { dateStyle:"medium", timeStyle:"short", timeZone:"America/Los_Angeles" })
    // produces something like "Jan 15, 2025 at 9:00 PM"
    expect(html).toContain("Jan 15, 2025");
  });

  test("dateField renders timestamp in UTC when timezone is UTC", () => {
    // Same timestamp: 2025-01-16T05:00:00Z = Jan 16 in UTC
    const html = renderTaskDetailPage(
      {
        id: "TZ-2",
        title: "Timezone test UTC",
        status: "pending",
        createdAt: "2025-01-16T05:00:00Z",
      },
      "user@example.com",
      {},
      "UTC",
    );
    // In UTC, 2025-01-16T05:00:00Z displays as Jan 16, 2025
    expect(html).toContain("Jan 16, 2025");
  });
});

// ─── renderTaskDetailPage — Pull Request Review section ──────────────────────

const PR_ITEM: PullRequestItem = {
  id: "pr-123",
  repo: "my-org/my-repo",
  prNumber: 42,
  state: "open",
  reviewState: "posted",
  patchCycles: 2,
  reviewCycles: 1,
  reviewedAt: "2026-06-01T10:00:00Z",
  patchedAt: "2026-06-02T11:00:00Z",
};

describe("renderTaskDetailPage — Pull Request Review section", () => {
  function render(pr?: PullRequestItem): string {
    return renderTaskDetailPage(
      { ...TASK_DETAIL, id: "TS-PR-1" },
      "user@example.com",
      {},
      "America/Los_Angeles",
      pr,
    );
  }

  test("renders PR section heading when pullRequest is present", () => {
    const html = render(PR_ITEM);
    expect(html).toContain("Pull Request Review");
  });

  test("renders state badge when pullRequest is present", () => {
    const html = render(PR_ITEM);
    expect(html).toContain("open");
  });

  test("renders reviewState badge when pullRequest is present", () => {
    const html = render(PR_ITEM);
    expect(html).toContain("posted");
  });

  test("renders patchCycles count when pullRequest is present", () => {
    const html = render(PR_ITEM);
    expect(html).toContain("Patch Cycles");
    expect(html).toContain("2");
  });

  test("renders reviewCycles count when pullRequest is present", () => {
    const html = render(PR_ITEM);
    expect(html).toContain("Review Cycles");
    expect(html).toContain("1");
  });

  test("renders reviewedAt when pullRequest is present", () => {
    const html = render(PR_ITEM);
    // The date is formatted; at minimum the year should be visible
    expect(html).toContain("2026");
  });

  test("renders patchedAt when pullRequest is present", () => {
    const html = render(PR_ITEM);
    // patchedAt is also formatted; year is sufficient
    expect(html).toContain("2026");
  });

  test("renders GitHub PR link with correct URL format", () => {
    const html = render(PR_ITEM);
    expect(html).toContain("https://github.com/my-org/my-repo/pull/42");
  });

  test("GitHub PR link opens in new tab (target=_blank)", () => {
    const html = render(PR_ITEM);
    expect(html).toContain('target="_blank"');
  });

  test("no PR section when pullRequest is undefined", () => {
    const html = render(undefined);
    expect(html).not.toContain("Pull Request Review");
  });

  test("no empty placeholder when pullRequest is absent", () => {
    const html = render(undefined);
    // The section heading should not appear at all — no placeholder text either
    expect(html).not.toContain("Pull Request Review");
    expect(html).not.toContain("No pull request");
  });

  test("XSS: repo field in PR link is escaped", () => {
    const xssPr: PullRequestItem = {
      ...PR_ITEM,
      repo: 'evil"><script>xss()</script>',
    };
    const html = render(xssPr);
    expect(html).not.toContain("<script>xss");
    expect(html).toContain("&lt;script&gt;");
  });
});

function mkVerificationCheck(
  overrides: Partial<VerificationCheckItem> = {},
): VerificationCheckItem {
  return {
    id: "vc-1",
    taskId: "TS-PR-1",
    prRecordId: null,
    repo: "my-org/my-repo",
    checkName: "unit",
    status: "ran_passed",
    reasonCategory: null,
    learnedFromCategory: null,
    durationMs: 4200,
    at: "2026-06-01T10:00:00.000Z",
    createdAt: "2026-06-01T10:00:00.000Z",
    ...overrides,
  };
}

describe("renderTaskDetailPage — Verification Checks section", () => {
  function render(checks: VerificationCheckItem[] = []): string {
    return renderTaskDetailPage(
      { ...TASK_DETAIL, id: "TS-PR-1" },
      "user@example.com",
      {},
      "UTC",
      undefined,
      "/admin/tasks",
      checks,
    );
  }

  test("renders section heading when checks are present", () => {
    const html = render([mkVerificationCheck()]);
    expect(html).toContain("Verification Checks");
  });

  test("renders checkName and status for a single check", () => {
    const html = render([
      mkVerificationCheck({ checkName: "typecheck", status: "ran_passed" }),
    ]);
    expect(html).toContain("typecheck");
    expect(html).toContain("passed");
  });

  test("no section when checks array is empty", () => {
    const html = render([]);
    expect(html).not.toContain("Verification Checks");
  });

  test("no section when checks argument is omitted (defaults to empty)", () => {
    const html = renderTaskDetailPage(
      { ...TASK_DETAIL, id: "TS-PR-1" },
      "user@example.com",
    );
    expect(html).not.toContain("Verification Checks");
  });

  test("only the most recent run per checkName is shown, not older runs", () => {
    const html = render([
      mkVerificationCheck({
        checkName: "unit",
        status: "ran_failed",
        at: "2026-06-01T09:00:00.000Z",
      }),
      mkVerificationCheck({
        checkName: "unit",
        status: "ran_passed",
        at: "2026-06-01T11:00:00.000Z",
      }),
    ]);
    expect(html).toContain("passed");
    expect(html).not.toContain("failed");
  });

  test("a skipped check with a reasonCategory renders the reason", () => {
    const html = render([
      mkVerificationCheck({
        checkName: "lint",
        status: "skipped",
        reasonCategory: "missing_tool",
      }),
    ]);
    expect(html).toContain("skipped");
    expect(html).toContain("missing_tool");
  });

  test("a ran_passed check renders with no reasonCategory text", () => {
    const html = render([
      mkVerificationCheck({
        checkName: "unit",
        status: "ran_passed",
        reasonCategory: null,
      }),
    ]);
    expect(html).toContain("passed");
    expect(html).not.toContain("missing_tool");
  });

  test("multiple distinct checkNames each render their own row", () => {
    const html = render([
      mkVerificationCheck({ checkName: "lint", status: "ran_passed" }),
      mkVerificationCheck({ checkName: "typecheck", status: "ran_failed" }),
    ]);
    expect(html).toContain("lint");
    expect(html).toContain("typecheck");
  });

  test("XSS: checkName is escaped", () => {
    const html = render([
      mkVerificationCheck({ checkName: "<script>xss()</script>" }),
    ]);
    expect(html).not.toContain("<script>xss");
    expect(html).toContain("&lt;script&gt;");
  });

  test("XSS: reasonCategory is escaped", () => {
    const html = render([
      mkVerificationCheck({
        status: "skipped",
        reasonCategory:
          "<script>xss()</script>" as VerificationCheckItem["reasonCategory"],
      }),
    ]);
    expect(html).not.toContain("<script>xss");
    expect(html).toContain("&lt;script&gt;");
  });
});

describe("renderTaskDetailPage — Skip Count / Last Skipped", () => {
  function render(task: Partial<TaskItem> = {}): string {
    return renderTaskDetailPage(
      { ...TASK_DETAIL, ...task },
      "user@example.com",
      {},
      "UTC",
    );
  }

  test("renders Skip Count field when skipCount > 0", () => {
    const html = render({ skipCount: 3 });
    expect(html).toContain("Skip Count");
    expect(html).toMatch(/Skip Count<\/td>\s*<td[^>]*>3<\/td>/);
  });

  test("omits Skip Count field when skipCount is 0", () => {
    const html = render({ skipCount: 0 });
    expect(html).not.toContain("Skip Count");
  });

  test("omits Skip Count field when skipCount is null/undefined", () => {
    const html = render({ skipCount: null });
    expect(html).not.toContain("Skip Count");
  });

  test("renders Last Skipped field when skipCount > 0 and lastSkippedAt is set", () => {
    const html = render({
      skipCount: 2,
      lastSkippedAt: "2026-06-12T10:00:00Z",
    });
    expect(html).toContain("Last Skipped");
  });

  test("omits Last Skipped field when skipCount is 0 even if lastSkippedAt is set", () => {
    const html = render({
      skipCount: 0,
      lastSkippedAt: "2026-06-12T10:00:00Z",
    });
    expect(html).not.toContain("Last Skipped");
  });

  test("omits Last Skipped field when lastSkippedAt is null/undefined", () => {
    const html = render({ skipCount: 2, lastSkippedAt: null });
    expect(html).not.toContain("Last Skipped");
  });
});

// ─── renderPrsPage ────────────────────────────────────────────────────────────

const PR_LIST_ITEM_1: PrListItem = {
  id: "pr-001",
  repo: "org/repo-a",
  prNumber: 10,
  staged: false,
  state: "open",
  reviewState: "pending",
  commitSha: "abc123",
  patchCycles: 0,
  reviewCycles: 0,
  agentId: "agent-001",
  claimedBy: "agent-001",
  reviewedAt: null,
  patchedAt: null,
  mergedAt: null,
  claimedAt: "2026-06-01T10:00:00Z",
  heartbeatAt: null,
  createdAt: "2026-06-01T09:00:00Z",
  updatedAt: "2026-06-01T10:00:00Z",
};

const PR_LIST_ITEM_2: PrListItem = {
  id: "pr-002",
  repo: "org/repo-b",
  prNumber: 20,
  staged: true,
  state: "closed",
  reviewState: "in_review",
  commitSha: null,
  patchCycles: 3,
  reviewCycles: 2,
  agentId: null,
  claimedBy: null,
  reviewedAt: "2026-06-02T10:00:00Z",
  patchedAt: "2026-06-02T11:00:00Z",
  mergedAt: "2026-06-03T09:00:00Z",
  claimedAt: null,
  heartbeatAt: null,
  createdAt: "2026-06-01T08:00:00Z",
  updatedAt: "2026-06-03T09:00:00Z",
};

const EMPTY_PR_PAGINATION = { total: 0, limit: 50, page: 1 };

// ─── heartbeatFreshness (AXR-2.1) ────────────────────────────────────────────

describe("heartbeatFreshness", () => {
  test("returns null when both claimedAt and heartbeatAt are absent", () => {
    expect(heartbeatFreshness(null, null, new Date())).toBeNull();
  });

  test("returns null when both claimedAt and heartbeatAt are undefined", () => {
    expect(heartbeatFreshness(undefined, undefined, new Date())).toBeNull();
  });

  test("falls back to claimedAt when heartbeatAt is absent", () => {
    const now = new Date("2026-06-01T10:05:00Z");
    expect(heartbeatFreshness("2026-06-01T10:00:00Z", null, now)).toBe("fresh");
  });

  test("prefers heartbeatAt over claimedAt when both are present", () => {
    const now = new Date("2026-06-01T10:05:00Z");
    expect(
      heartbeatFreshness(
        "2026-01-01T00:00:00Z", // very stale on its own
        "2026-06-01T10:00:00Z", // fresh
        now,
      ),
    ).toBe("fresh");
  });

  test("returns 'fresh' well within the TTL", () => {
    const now = new Date("2026-06-01T10:05:00Z"); // +5min
    expect(heartbeatFreshness(null, "2026-06-01T10:00:00Z", now)).toBe("fresh");
  });

  test("returns 'aging' partway through the TTL", () => {
    const now = new Date("2026-06-01T10:35:00Z"); // +35min
    expect(heartbeatFreshness(null, "2026-06-01T10:00:00Z", now)).toBe("aging");
  });

  test("returns 'stale' once past the TTL", () => {
    const now = new Date("2026-06-01T11:10:00Z"); // +70min > 65min TTL
    expect(heartbeatFreshness(null, "2026-06-01T10:00:00Z", now)).toBe("stale");
  });

  test("does not crash on an unparseable timestamp, returns null", () => {
    expect(heartbeatFreshness(null, "not-a-real-date", new Date())).toBeNull();
  });
});

describe("renderPrsPage", () => {
  function render(
    prs: PrListItem[] = [],
    filters: Parameters<typeof renderPrsPage>[1] = {},
    degraded = false,
    now?: Date,
  ): string {
    return renderPrsPage(
      prs,
      filters,
      degraded,
      USER_NAME,
      { "agent-001": "Alpha Agent" },
      { total: prs.length, limit: 50, page: 1 },
      "America/Los_Angeles",
      undefined,
      {},
      now,
    );
  }

  test("returns a valid HTML document", () => {
    const html = render();
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("<html");
    expect(html).toContain("</html>");
  });

  test("empty state shows 'No PRs found'", () => {
    const html = render([]);
    expect(html).toContain("No PRs found");
  });

  test("renders table with required column headers", () => {
    const html = render([PR_LIST_ITEM_1]);
    expect(html).toContain("Review Cycles");
    expect(html).toContain("Repo");
    expect(html).toContain("PR#");
    expect(html).toContain("Task");
    expect(html).toContain("State");
    expect(html).toContain("Review State");
    expect(html).toContain("Patch Cycles");
    expect(html).toContain("Claimed By");
    expect(html).toContain("Created");
  });

  test("table markup is wrapped in .data-table-wrapper", () => {
    const html = render([PR_LIST_ITEM_1]);
    expect(html).toContain('<div class="data-table-wrapper">');
  });

  test("Created column renders pr.createdAt, not pr.updatedAt", () => {
    const html = render([PR_LIST_ITEM_1]);
    // PR_LIST_ITEM_1 has distinct createdAt (09:00) and updatedAt (10:00) values.
    const createdFormatted = new Date(
      PR_LIST_ITEM_1.createdAt as string,
    ).toLocaleString("en-US", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: "America/Los_Angeles",
    });
    const updatedFormatted = new Date(
      PR_LIST_ITEM_1.updatedAt as string,
    ).toLocaleString("en-US", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: "America/Los_Angeles",
    });
    expect(html).toContain(createdFormatted);
    expect(html).not.toContain(updatedFormatted);
  });

  test("Claimed By cell links to the claiming agent's detail page", () => {
    const html = render([PR_LIST_ITEM_1]);
    expect(html).toContain('<a href="/admin/agents/agent-001"');
    expect(html).toContain("Alpha Agent");
  });

  test("renders 2+ PRs as table rows", () => {
    const html = render([PR_LIST_ITEM_1, PR_LIST_ITEM_2]);
    expect(html).toContain("org/repo-a");
    expect(html).toContain("org/repo-b");
    expect(html).toContain("10");
    expect(html).toContain("20");
  });

  test("renders repo field for each PR", () => {
    const html = render([PR_LIST_ITEM_1, PR_LIST_ITEM_2]);
    expect(html).toContain("org/repo-a");
    expect(html).toContain("org/repo-b");
  });

  test("renders state and reviewState fields", () => {
    const html = render([PR_LIST_ITEM_1]);
    expect(html).toContain("open");
    expect(html).toContain("pending");
  });

  test("renders patchCycles field", () => {
    const html = render([PR_LIST_ITEM_2]);
    expect(html).toContain("3");
  });

  test("renders linked task ids when present in linkedTasksByPr", () => {
    const html = renderPrsPage(
      [PR_LIST_ITEM_1],
      {},
      false,
      USER_NAME,
      { "agent-001": "Alpha Agent" },
      { total: 1, limit: 50, page: 1 },
      "America/Los_Angeles",
      undefined,
      {
        [PR_LIST_ITEM_1.id]: [{ id: "TASK-1", title: "T", status: "done" }],
      },
    );
    expect(html).toContain("TASK-1");
    expect(html).toContain("/admin/tasks/TASK-1");
  });

  test("renders all linked task ids when a PR has 2 linked tasks", () => {
    const html = renderPrsPage(
      [PR_LIST_ITEM_1],
      {},
      false,
      USER_NAME,
      { "agent-001": "Alpha Agent" },
      { total: 1, limit: 50, page: 1 },
      "America/Los_Angeles",
      undefined,
      {
        [PR_LIST_ITEM_1.id]: [
          { id: "TASK-A", title: "A", status: "done" },
          { id: "TASK-B", title: "B", status: "done" },
        ],
      },
    );
    expect(html).toContain("/admin/tasks/TASK-A");
    expect(html).toContain("/admin/tasks/TASK-B");
  });

  test("renders empty-state dash when a PR has no linked tasks", () => {
    const html = render([PR_LIST_ITEM_1]);
    expect(html).toContain('<span style="color:#9ca3af">—</span>');
  });

  test("degraded warning shown when degraded=true", () => {
    const html = render([], {}, true);
    expect(html).toContain("unavailable");
  });

  test("no degraded warning when degraded=false", () => {
    const html = render([], {}, false);
    expect(html).not.toContain("unavailable");
  });

  test("state tabs render Open / Merged only", () => {
    const html = render();
    expect(html).toContain("Open");
    expect(html).toContain("Merged");
    expect(html).not.toContain(">All<");
    expect(html).not.toContain("In Review");
    expect(html).not.toContain(">Closed<");
  });

  test("Open tab links to ?state=open", () => {
    const html = render();
    expect(html).toContain("state=open");
  });

  test("Merged tab links to ?state=merged", () => {
    const html = render();
    expect(html).toContain("state=merged");
  });

  test("filter form includes repo multiselect", () => {
    const html = render();
    expect(html).toContain('<select name="repo" multiple');
  });

  test("filter form includes org multiselect", () => {
    const html = render();
    expect(html).toContain('<select name="org" multiple');
  });

  test("filter form includes state input", () => {
    const html = render();
    expect(html).toContain('name="state"');
  });

  test("filter form includes reviewState input", () => {
    const html = render();
    expect(html).toContain('name="reviewState"');
  });

  test("filter form includes taskId input", () => {
    const html = render();
    expect(html).toContain('name="taskId"');
  });

  test("filter values are pre-filled in form", () => {
    const html = render([], { repo: "org/my-repo", taskId: "TASK-42" });
    expect(html).toContain(
      '<option value="org/my-repo" selected>org/my-repo</option>',
    );
    expect(html).toContain("TASK-42");
  });

  test("XSS: repo name in list is escaped", () => {
    const xssPr: PrListItem = {
      ...PR_LIST_ITEM_1,
      repo: "<script>alert(1)</script>",
    };
    const html = render([xssPr]);
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  test("XSS: filter repo value is escaped in form", () => {
    const html = render([], { repo: "<script>xss()</script>" });
    expect(html).not.toContain("<script>xss");
    expect(html).toContain("&lt;script&gt;");
  });

  test("uses renderAdminToolbar with /admin/prs active path", () => {
    const html = render();
    expect(html).toContain('href="/admin/prs" class="vos-nav-link active"');
  });

  test("tab URLs preserve reviewState filter when reviewState is set", () => {
    const html = render([], { state: "open", reviewState: "posted" });
    expect(html).toContain("reviewState=posted");
    // Both tab hrefs should carry the reviewState param
    const openTabMatch = html.match(/href="[^"]*state=open[^"]*"/);
    expect(openTabMatch).toBeTruthy();
    expect(openTabMatch?.[0]).toContain("reviewState=posted");
  });

  test("reviewState dropdown pre-selects the active option", () => {
    const html = render([], { reviewState: "posted" });
    expect(html).toContain('value="posted" selected');
  });

  // ─── AXR-2.1: shared CSS reuse, heartbeat dot, header tooltips ────────────

  test("does not duplicate .badge-green / .alert-warning rule definitions already in the base stylesheet (AC1)", () => {
    const html = render([PR_LIST_ITEM_1, PR_LIST_ITEM_2]);
    const badgeGreenRuleCount = (html.match(/\.badge-green\s*\{/g) ?? [])
      .length;
    const alertWarningRuleCount = (html.match(/\.alert-warning\s*\{/g) ?? [])
      .length;
    expect(badgeGreenRuleCount).toBe(1);
    expect(alertWarningRuleCount).toBe(1);
  });

  test("Review Cycles and Patch Cycles headers carry the shared header-tooltip class with a data-tip", () => {
    const html = render([PR_LIST_ITEM_1]);
    expect(html).toMatch(
      /<th class="col-review-cycles"[^>]*><span class="header-tooltip" data-tip="[^"]+">Review Cycles<\/span><\/th>/,
    );
    expect(html).toMatch(
      /<th class="col-patch-cycles"[^>]*><span class="header-tooltip" data-tip="[^"]+">Patch Cycles<\/span><\/th>/,
    );
  });

  test("heartbeat-dot renders class 'fresh' when the claim is recent (AC4)", () => {
    // PR_LIST_ITEM_1.claimedAt = 2026-06-01T10:00:00Z, heartbeatAt = null.
    const now = new Date("2026-06-01T10:05:00Z"); // +5min
    const html = render([PR_LIST_ITEM_1], {}, false, now);
    expect(html).toContain('class="heartbeat-dot fresh"');
  });

  test("heartbeat-dot renders class 'aging' partway through the claim TTL (AC4)", () => {
    const now = new Date("2026-06-01T10:35:00Z"); // +35min
    const html = render([PR_LIST_ITEM_1], {}, false, now);
    expect(html).toContain('class="heartbeat-dot aging"');
  });

  test("heartbeat-dot renders class 'stale' once past the claim TTL (AC4)", () => {
    const now = new Date("2026-06-01T11:10:00Z"); // +70min, past DEFAULT_CLAIM_TTL_MS (65min)
    const html = render([PR_LIST_ITEM_1], {}, false, now);
    expect(html).toContain('class="heartbeat-dot stale"');
  });

  test("heartbeat-dot uses heartbeatAt over claimedAt when both are present (AC4)", () => {
    const prWithHeartbeat: PrListItem = {
      ...PR_LIST_ITEM_1,
      claimedAt: "2026-06-01T00:00:00Z", // would be "stale" on its own
      heartbeatAt: "2026-06-01T10:00:00Z", // fresh relative to `now`
    };
    const now = new Date("2026-06-01T10:05:00Z");
    const html = render([prWithHeartbeat], {}, false, now);
    expect(html).toContain('class="heartbeat-dot fresh"');
  });

  test("no heartbeat-dot renders when claimedBy/claimedAt/heartbeatAt are all null (AC4)", () => {
    const html = render([PR_LIST_ITEM_2], {}, false, new Date());
    // The base stylesheet always defines the .heartbeat-dot CSS rule; only
    // check that no <span> element using it is rendered in the row markup.
    expect(html).not.toContain('<span class="heartbeat-dot');
  });
});

// ─── renderPrsPage — Blocked tab & HITL badge (HBV-2.2) ──────────────────────

describe("renderPrsPage — Blocked tab & HITL badge", () => {
  function render(
    prs: PrListItem[] = [],
    filters: Parameters<typeof renderPrsPage>[1] = {},
    degraded = false,
  ): string {
    return renderPrsPage(
      prs,
      filters,
      degraded,
      USER_NAME,
      { "agent-001": "Alpha Agent" },
      { total: prs.length, limit: 50, page: 1 },
    );
  }

  test("Blocked tab renders with the label 'Blocked'", () => {
    const html = render();
    expect(html).toContain(">Blocked<");
  });

  test("Blocked tab href composes state=open with blocked=true", () => {
    const html = render();
    const blockedTabMatch = html.match(/href="[^"]*blocked=true[^"]*"/);
    expect(blockedTabMatch).toBeTruthy();
    expect(blockedTabMatch?.[0]).toContain("state=open");
  });

  test("Blocked tab is active when filters.blocked is 'true', regardless of state", () => {
    const html = render([], { state: "open", blocked: "true" });
    const blockedTabMatch = html.match(
      /<a href="[^"]*blocked=true[^"]*"[^>]*>Blocked<\/a>/,
    );
    expect(blockedTabMatch).toBeTruthy();
    expect(blockedTabMatch?.[0]).toContain("background:#6366f1");
  });

  test("Open tab is not shown as active when blocked=true", () => {
    const html = render([], { state: "open", blocked: "true" });
    const openTabMatch = html.match(/<a href="[^"]*state=open"[^>]*>Open<\/a>/);
    expect(openTabMatch).toBeTruthy();
    expect(openTabMatch?.[0]).not.toContain("background:#6366f1");
  });

  test("PR with blocked:true renders the 'Waiting: Blocked' badge in the list", () => {
    const html = render([{ ...PR_LIST_ITEM_1, blocked: true }]);
    expect(html).toContain("Waiting: Blocked");
    // AXR-2.1: reuses AXR-1.1's shared .badge-warning class instead of a
    // page-local .badge-blocked rule.
    expect(html).toContain("badge-warning");
  });

  test("PR with blocked:false does not render the badge", () => {
    const html = render([{ ...PR_LIST_ITEM_1, blocked: false }]);
    expect(html).not.toContain("Waiting: Blocked");
  });

  test("PR with blocked absent does not render the badge", () => {
    const html = render([PR_LIST_ITEM_1]);
    expect(html).not.toContain("Waiting: Blocked");
  });

  test("badge title attribute reflects blockedReason when present", () => {
    const html = render([
      {
        ...PR_LIST_ITEM_1,
        blocked: true,
        blockedReason: "Needs human sign-off",
      },
    ]);
    expect(html).toContain('title="Needs human sign-off"');
  });

  test("makePageUrl carries blocked=true through pagination links", () => {
    const html = renderPrsPage(
      [PR_LIST_ITEM_1, PR_LIST_ITEM_2],
      { state: "open", blocked: "true" },
      false,
      USER_NAME,
      {},
      { total: 200, limit: 50, page: 1 },
    );
    expect(html).toContain("blocked=true");
    const nextMatch = html.match(/href="([^"]*)"[^>]*>Next/);
    expect(nextMatch).toBeTruthy();
    expect(nextMatch?.[1]).toContain("blocked=true");
  });
});

// ─── renderPrsPage — org/repo multiselect filters (ORF-2.2) ──────────────────

describe("renderPrsPage — org/repo multiselect filters", () => {
  const pagination = { total: 0, limit: 50, page: 1 };

  test("renders both an Org and a Repo select-multiple element", () => {
    const html = renderPrsPage(
      [],
      {},
      false,
      USER_NAME,
      {},
      pagination,
      undefined,
      { orgs: ["app-vitals", "other-org"], repos: ["app-vitals/repo-a"] },
    );
    expect(html).toContain('<select name="org" multiple');
    expect(html).toContain('<select name="repo" multiple');
  });

  test("populates Org options from suggestions.orgs", () => {
    const html = renderPrsPage(
      [],
      {},
      false,
      USER_NAME,
      {},
      pagination,
      undefined,
      { orgs: ["app-vitals", "other-org"] },
    );
    expect(html).toContain('<option value="app-vitals">');
    expect(html).toContain('<option value="other-org">');
  });

  test("populates Repo options from suggestions.repos", () => {
    const html = renderPrsPage(
      [],
      {},
      false,
      USER_NAME,
      {},
      pagination,
      undefined,
      { repos: ["org/repo-a", "org/repo-b"] },
    );
    expect(html).toContain('<option value="org/repo-a">');
    expect(html).toContain('<option value="org/repo-b">');
  });

  test("Org and Repo multiselects carry the new scope-select pill/tag styling class (AXR-1.1)", () => {
    const html = renderPrsPage(
      [],
      {},
      false,
      USER_NAME,
      {},
      pagination,
      undefined,
      { orgs: ["app-vitals"], repos: ["app-vitals/repo-a"] },
    );
    expect(html).toContain(
      '<select name="org" multiple class="form-input scope-select"',
    );
    expect(html).toContain(
      '<select name="repo" multiple class="form-input scope-select"',
    );
  });

  test("Org and Repo stay independent multiselect fields, not merged into one combined scope pill", () => {
    const html = renderPrsPage(
      [],
      {},
      false,
      USER_NAME,
      {},
      pagination,
      undefined,
      { orgs: ["app-vitals"], repos: ["app-vitals/repo-a"] },
    );
    const selectCount = (html.match(/<select /g) ?? []).length;
    expect(selectCount).toBeGreaterThanOrEqual(2);
    expect(html).toContain('<select name="org" multiple');
    expect(html).toContain('<select name="repo" multiple');
  });

  test("marks currently-active repo filter values as selected (array)", () => {
    const html = renderPrsPage(
      [],
      { repo: ["org/repo-a", "org/repo-b"] },
      false,
      USER_NAME,
      {},
      pagination,
      undefined,
      { repos: ["org/repo-a", "org/repo-b", "org/repo-c"] },
    );
    expect(html).toContain(
      '<option value="org/repo-a" selected>org/repo-a</option>',
    );
    expect(html).toContain(
      '<option value="org/repo-b" selected>org/repo-b</option>',
    );
    expect(html).toContain('<option value="org/repo-c">org/repo-c</option>');
  });

  test("marks currently-active org filter values as selected (array)", () => {
    const html = renderPrsPage(
      [],
      { org: ["app-vitals"] },
      false,
      USER_NAME,
      {},
      pagination,
      undefined,
      { orgs: ["app-vitals", "other-org"] },
    );
    expect(html).toContain(
      '<option value="app-vitals" selected>app-vitals</option>',
    );
    expect(html).toContain('<option value="other-org">other-org</option>');
  });

  // AC2/AC6: org-only filtering — Org and Repo remain independently
  // selectable multiselects; selecting only an Org leaves every Repo option
  // unselected (matches every repo under that org, rather than the two
  // fields being merged into one combined scope-pill control).
  test("org-only filter selects only the Org multiselect, leaving Repo unselected", () => {
    const html = renderPrsPage(
      [],
      { org: ["app-vitals"] },
      false,
      USER_NAME,
      {},
      pagination,
      undefined,
      {
        orgs: ["app-vitals"],
        repos: ["app-vitals/repo-a", "app-vitals/repo-b"],
      },
    );
    // Org and Repo stay two independent <select multiple> controls.
    expect(html).toContain('<select name="org" multiple');
    expect(html).toContain('<select name="repo" multiple');
    // Org option is selected...
    expect(html).toContain(
      '<option value="app-vitals" selected>app-vitals</option>',
    );
    // ...but no Repo option is selected.
    expect(html).toContain(
      '<option value="app-vitals/repo-a">app-vitals/repo-a</option>',
    );
    expect(html).toContain(
      '<option value="app-vitals/repo-b">app-vitals/repo-b</option>',
    );
    expect(html).not.toContain('<option value="app-vitals/repo-a" selected>');
    expect(html).not.toContain('<option value="app-vitals/repo-b" selected>');
  });

  test("backward compat: a single-value repo filter (string, not array) is still marked selected", () => {
    const html = renderPrsPage(
      [],
      { repo: "org/repo-a" },
      false,
      USER_NAME,
      {},
      pagination,
      undefined,
      { repos: ["org/repo-a", "org/repo-b"] },
    );
    expect(html).toContain(
      '<option value="org/repo-a" selected>org/repo-a</option>',
    );
    expect(html).toContain('<option value="org/repo-b">org/repo-b</option>');
  });

  test("an active filter value not present in suggestions still renders as a selected option", () => {
    const html = renderPrsPage(
      [],
      { repo: ["org/stale-repo"] },
      false,
      USER_NAME,
      {},
      pagination,
      undefined,
      { repos: ["org/repo-a"] },
    );
    expect(html).toContain(
      '<option value="org/stale-repo" selected>org/stale-repo</option>',
    );
  });

  test("no repo/org filter active renders no selected options", () => {
    const html = renderPrsPage(
      [],
      {},
      false,
      USER_NAME,
      {},
      pagination,
      undefined,
      { orgs: ["app-vitals"], repos: ["org/repo-a"] },
    );
    expect(html).not.toContain("selected>");
  });

  test("removes the legacy single-value repo <input>+<datalist> markup", () => {
    const html = renderPrsPage(
      [],
      {},
      false,
      USER_NAME,
      {},
      pagination,
      undefined,
      { repos: ["org/repo-a"] },
    );
    expect(html).not.toContain('name="repo" type="text"');
    expect(html).not.toContain('<datalist id="prs-repos-list">');
    expect(html).not.toContain('list="prs-repos-list"');
  });

  test("escapes org/repo suggestion and filter values to prevent XSS", () => {
    const html = renderPrsPage(
      [],
      { org: ['<script>alert("xss")</script>'] },
      false,
      USER_NAME,
      {},
      pagination,
      undefined,
      { orgs: ['<script>alert("xss")</script>'] },
    );
    expect(html).not.toContain('<script>alert("xss")</script>');
    expect(html).toContain("&lt;script&gt;");
  });

  // AXR-2.1: secondary filters (State/Review State/Task ID) collapse behind
  // AXR-1.1's shared <details class="more-filters"> disclosure, while Org
  // and Repo stay always-visible primary filters (AC1/AC2).
  test("State/Review State/Task ID filters render inside a more-filters disclosure, Org/Repo stay outside it", () => {
    const html = renderPrsPage(
      [],
      {},
      false,
      USER_NAME,
      {},
      pagination,
      undefined,
      { orgs: ["app-vitals"], repos: ["app-vitals/repo-a"] },
    );
    expect(html).toContain('<details class="more-filters">');
    expect(html).toContain('<div class="more-filters-panel">');
    const orgSelectIndex = html.indexOf('<select name="org" multiple');
    const detailsIndex = html.indexOf('<details class="more-filters">');
    const stateFieldIndex = html.indexOf('name="state"');
    const taskIdFieldIndex = html.indexOf('name="taskId"');
    expect(orgSelectIndex).toBeGreaterThan(-1);
    expect(detailsIndex).toBeGreaterThan(-1);
    // Org/Repo render before (outside) the disclosure.
    expect(orgSelectIndex).toBeLessThan(detailsIndex);
    // State/Task ID render inside (after) the disclosure opens.
    expect(stateFieldIndex).toBeGreaterThan(detailsIndex);
    expect(taskIdFieldIndex).toBeGreaterThan(detailsIndex);
  });

  // AXR-2.1 review follow-up: reviewState/taskId live only inside the collapsed
  // disclosure, so a filtered URL must not render as an unfiltered-looking page.
  test("more-filters disclosure stays collapsed with no badge when no hidden filter is set", () => {
    const html = renderPrsPage(
      [],
      { state: "open" },
      false,
      USER_NAME,
      {},
      pagination,
    );
    expect(html).toContain('<details class="more-filters">');
    expect(html).toContain("<summary>More filters</summary>");
  });

  test("more-filters disclosure renders open with a count badge when reviewState is set", () => {
    const html = renderPrsPage(
      [],
      { reviewState: "pending" },
      false,
      USER_NAME,
      {},
      pagination,
    );
    expect(html).toContain('<details class="more-filters" open>');
    expect(html).toContain(
      '<summary>More filters<span class="badge badge-purple">1</span></summary>',
    );
  });

  test("more-filters disclosure renders open with a count badge when taskId is set", () => {
    const html = renderPrsPage(
      [],
      { taskId: "FOO-1" },
      false,
      USER_NAME,
      {},
      pagination,
    );
    expect(html).toContain('<details class="more-filters" open>');
    expect(html).toContain(
      '<summary>More filters<span class="badge badge-purple">1</span></summary>',
    );
  });

  test("more-filters badge counts both hidden filters when reviewState and taskId are set", () => {
    const html = renderPrsPage(
      [],
      { reviewState: "posted", taskId: "FOO-1" },
      false,
      USER_NAME,
      {},
      pagination,
    );
    expect(html).toContain('<details class="more-filters" open>');
    expect(html).toContain(
      '<summary>More filters<span class="badge badge-purple">2</span></summary>',
    );
  });
});

// ─── renderPrsPage — org/repo multiselect pagination/tab round-trip (ORF-2.2) ─

describe("renderPrsPage — org/repo multiselect pagination/tab round-trip", () => {
  test("makePageUrl carries multi-value filters.repo as repeated repo= params into pagination links, not comma-joined", () => {
    const html = renderPrsPage(
      [PR_LIST_ITEM_1, PR_LIST_ITEM_2],
      { repo: ["org/repo-a", "org/repo-b"] },
      false,
      USER_NAME,
      {},
      { total: 100, limit: 50, page: 1 },
    );
    expect(html).toContain(
      'href="/admin/prs?repo=org%2Frepo-a&repo=org%2Frepo-b&page=2"',
    );
    expect(html).not.toContain("org/repo-a,org/repo-b");
  });

  test("makePageUrl carries multi-value filters.org as repeated org= params into pagination links", () => {
    const html = renderPrsPage(
      [PR_LIST_ITEM_1, PR_LIST_ITEM_2],
      { org: ["app-vitals", "other-org"] },
      false,
      USER_NAME,
      {},
      { total: 100, limit: 50, page: 1 },
    );
    expect(html).toContain(
      'href="/admin/prs?org=app-vitals&org=other-org&page=2"',
    );
  });

  test("makePageUrl backward-compat: a single-value (string) filters.repo still round-trips as one repo= param", () => {
    const html = renderPrsPage(
      [PR_LIST_ITEM_1, PR_LIST_ITEM_2],
      { repo: "org/repo-a" },
      false,
      USER_NAME,
      {},
      { total: 100, limit: 50, page: 1 },
    );
    expect(html).toContain('href="/admin/prs?repo=org%2Frepo-a&page=2"');
  });

  test("state-tab links (Open/Merged) carry multi-value filters.repo as repeated repo= params", () => {
    const html = renderPrsPage(
      [],
      { state: "open", repo: ["org/repo-a", "org/repo-b"] },
      false,
      USER_NAME,
      {},
      EMPTY_PR_PAGINATION,
    );
    expect(html).toContain(
      'href="/admin/prs?state=merged&repo=org%2Frepo-a&repo=org%2Frepo-b"',
    );
  });

  test("state-tab links (Open/Merged) carry multi-value filters.org as repeated org= params", () => {
    const html = renderPrsPage(
      [],
      { state: "open", org: ["app-vitals", "other-org"] },
      false,
      USER_NAME,
      {},
      EMPTY_PR_PAGINATION,
    );
    expect(html).toContain(
      'href="/admin/prs?state=merged&org=app-vitals&org=other-org"',
    );
  });

  test("Blocked tab link carries multi-value filters.repo as repeated repo= params", () => {
    const html = renderPrsPage(
      [],
      { repo: ["org/repo-a", "org/repo-b"] },
      false,
      USER_NAME,
      {},
      EMPTY_PR_PAGINATION,
    );
    const blockedTabMatch = html.match(/href="[^"]*blocked=true[^"]*"/);
    expect(blockedTabMatch).toBeTruthy();
    expect(blockedTabMatch?.[0]).toContain("repo=org%2Frepo-a");
    expect(blockedTabMatch?.[0]).toContain("repo=org%2Frepo-b");
  });
});

// ─── renderPrDetailPage ──────────────────────────────────────────────────────

const PR_DETAIL: PrListItem = {
  id: "pr-detail-001",
  repo: "org/detail-repo",
  prNumber: 99,
  staged: false,
  state: "open",
  reviewState: "in_review",
  commitSha: "deadbeef",
  patchCycles: 2,
  reviewCycles: 3,
  agentId: "agent-x",
  claimedBy: "agent-x",
  reviewedAt: "2026-06-10T10:00:00Z",
  patchedAt: "2026-06-11T11:00:00Z",
  mergedAt: null,
  claimedAt: "2026-06-09T08:00:00Z",
  heartbeatAt: "2026-06-11T12:00:00Z",
  createdAt: "2026-06-09T07:00:00Z",
  updatedAt: "2026-06-11T12:00:00Z",
};

describe("renderPrDetailPage", () => {
  function render(
    pr: PrListItem = PR_DETAIL,
    linkedTasks: TaskItem[] = [],
  ): string {
    return renderPrDetailPage(
      pr,
      USER_NAME,
      { "agent-x": "Xray Agent" },
      "America/Los_Angeles",
      linkedTasks,
    );
  }

  test("returns a valid HTML document", () => {
    const html = render();
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("<html");
    expect(html).toContain("</html>");
  });

  test("renders repo field", () => {
    const html = render();
    expect(html).toContain("org/detail-repo");
  });

  test("renders prNumber field", () => {
    const html = render();
    expect(html).toContain("99");
  });

  test("renders state field", () => {
    const html = render();
    expect(html).toContain("open");
  });

  test("renders reviewState field", () => {
    const html = render();
    expect(html).toContain("in_review");
  });

  test("renders patchCycles field", () => {
    const html = render();
    expect(html).toContain("Patch Cycles");
    expect(html).toContain("2");
  });

  test("renders reviewCycles field", () => {
    const html = render();
    expect(html).toContain("Review Cycles");
    expect(html).toContain("3");
  });

  test("renders a linked task id when linkedTasks is non-empty", () => {
    const html = render(PR_DETAIL, [
      { id: "TASK-99", title: "T", status: "done" },
    ]);
    expect(html).toContain("TASK-99");
  });

  test("linked task links to the task's detail page", () => {
    const html = render(PR_DETAIL, [
      { id: "TASK-99", title: "T", status: "done" },
    ]);
    expect(html).toContain('<a href="/admin/tasks/TASK-99"');
  });

  test("no Task row when linkedTasks is empty", () => {
    const html = render(PR_DETAIL, []);
    expect(html).not.toContain("/admin/tasks/");
  });

  test("renders both links when a PR has 2 linked tasks", () => {
    const html = render(PR_DETAIL, [
      { id: "TASK-A", title: "A", status: "done" },
      { id: "TASK-B", title: "B", status: "done" },
    ]);
    expect(html).toContain('<a href="/admin/tasks/TASK-A"');
    expect(html).toContain('<a href="/admin/tasks/TASK-B"');
  });

  test("PR number links out to the GitHub PR", () => {
    const html = render();
    expect(html).toContain(
      '<a href="https://github.com/org/detail-repo/pull/99"',
    );
    expect(html).toContain(">#99</a>");
  });

  test("renders commitSha field when present", () => {
    const html = render();
    expect(html).toContain("deadbeef");
  });

  test("renders claimedBy field", () => {
    const html = render();
    // agent-x maps to "Xray Agent"
    expect(html).toContain("Xray Agent");
  });

  test("claimedBy links to the agent detail page", () => {
    const html = render();
    expect(html).toContain('<a href="/admin/agents/agent-x"');
  });

  test("agentId links to the agent detail page", () => {
    const html = render();
    const matches = html.match(/<a href="\/admin\/agents\/agent-x"/g);
    // both Claimed By and Agent ID resolve to agent-x here, so 2 links
    expect(matches?.length).toBe(2);
  });

  test("renders Timeline section with date fields", () => {
    const html = render();
    expect(html).toContain("Timeline");
  });

  test("Timeline section includes createdAt", () => {
    const html = render();
    expect(html).toContain("Created");
    expect(html).toContain("2026");
  });

  test("Timeline section includes claimedAt when present", () => {
    const html = render();
    expect(html).toContain("Claimed");
  });

  test("Timeline section includes reviewedAt when present", () => {
    const html = render();
    expect(html).toContain("Reviewed");
  });

  test("Timeline section includes patchedAt when present", () => {
    const html = render();
    expect(html).toContain("Patched");
  });

  test("Timeline section omits mergedAt when null", () => {
    // mergedAt is null in PR_DETAIL — no 'Merged' label should appear in the timeline
    const html = render({ ...PR_DETAIL, mergedAt: null, patchedAt: null });
    // Only check that 'Merged' as a timeline label is absent (it might appear in state fields)
    expect(html).not.toMatch(/>\s*Merged\s*<\/td>/);
  });

  test("Timeline section includes mergedAt when present", () => {
    const html = render({ ...PR_DETAIL, mergedAt: "2026-06-12T10:00:00Z" });
    expect(html).toContain("Merged");
  });

  test("renders id field", () => {
    const html = render();
    expect(html).toContain("pr-detail-001");
  });

  test("XSS: repo name in detail is escaped", () => {
    const xssPr: PrListItem = {
      ...PR_DETAIL,
      repo: "<script>alert(1)</script>",
    };
    const html = render(xssPr);
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  test("Timeline section includes heartbeatAt as Last Heartbeat", () => {
    const html = render();
    // PR_DETAIL has heartbeatAt: "2026-06-11T12:00:00Z"
    expect(html).toContain("Last Heartbeat");
  });

  test("Timeline section omits Last Heartbeat when heartbeatAt is null", () => {
    const html = render({ ...PR_DETAIL, heartbeatAt: null });
    expect(html).not.toContain("Last Heartbeat");
  });

  test("uses renderAdminToolbar with /admin/prs active path", () => {
    const html = render();
    expect(html).toContain('href="/admin/prs" class="vos-nav-link active"');
  });

  test("renders Blocked field as 'yes' when pr.blocked is true", () => {
    const html = render({ ...PR_DETAIL, blocked: true });
    expect(html).toContain("Blocked");
    expect(html).toMatch(/Blocked<\/td>\s*<td[^>]*>yes<\/td>/);
  });

  test("renders Blocked field as 'no' when pr.blocked is false", () => {
    const html = render({ ...PR_DETAIL, blocked: false });
    expect(html).toMatch(/Blocked<\/td>\s*<td[^>]*>no<\/td>/);
  });

  test("omits Blocked field when pr.blocked is null/undefined", () => {
    const html = render({ ...PR_DETAIL, blocked: null });
    expect(html).not.toMatch(/>\s*Blocked\s*<\/td>/);
  });

  test("renders Blocked Reason field when present", () => {
    const html = render({
      ...PR_DETAIL,
      blockedReason: "Awaiting human review",
    });
    expect(html).toContain("Blocked Reason");
    expect(html).toContain("Awaiting human review");
  });

  test("omits Blocked Reason field when null/undefined", () => {
    const html = render({ ...PR_DETAIL, blockedReason: null });
    expect(html).not.toContain("Blocked Reason");
  });

  test("renders Skip Count field when skipCount > 0", () => {
    const html = render({ ...PR_DETAIL, skipCount: 3 });
    expect(html).toContain("Skip Count");
    expect(html).toMatch(/Skip Count<\/td>\s*<td[^>]*>3<\/td>/);
  });

  test("omits Skip Count field when skipCount is 0", () => {
    const html = render({ ...PR_DETAIL, skipCount: 0 });
    expect(html).not.toContain("Skip Count");
  });

  test("omits Skip Count field when skipCount is null/undefined", () => {
    const html = render({ ...PR_DETAIL, skipCount: null });
    expect(html).not.toContain("Skip Count");
  });

  test("renders Last Skipped field when skipCount > 0 and lastSkippedAt is set", () => {
    const html = render({
      ...PR_DETAIL,
      skipCount: 2,
      lastSkippedAt: "2026-06-12T10:00:00Z",
    });
    expect(html).toContain("Last Skipped");
  });

  test("omits Last Skipped field when skipCount is 0 even if lastSkippedAt is set", () => {
    const html = render({
      ...PR_DETAIL,
      skipCount: 0,
      lastSkippedAt: "2026-06-12T10:00:00Z",
    });
    expect(html).not.toContain("Last Skipped");
  });

  test("omits Last Skipped field when lastSkippedAt is null/undefined", () => {
    const html = render({ ...PR_DETAIL, skipCount: 2, lastSkippedAt: null });
    expect(html).not.toContain("Last Skipped");
  });
});

describe("renderPrDetailPage — Verification Checks section", () => {
  function render(checks: VerificationCheckItem[] = []): string {
    return renderPrDetailPage(
      PR_DETAIL,
      USER_NAME,
      {},
      "America/Los_Angeles",
      [],
      checks,
    );
  }

  test("renders section heading when checks are present", () => {
    const html = render([
      mkVerificationCheck({ taskId: null, prRecordId: PR_DETAIL.id }),
    ]);
    expect(html).toContain("Verification Checks");
  });

  test("no section when checks array is empty", () => {
    const html = render([]);
    expect(html).not.toContain("Verification Checks");
  });

  test("no section when checks argument is omitted (defaults to empty)", () => {
    const html = renderPrDetailPage(PR_DETAIL, USER_NAME);
    expect(html).not.toContain("Verification Checks");
  });

  test("only the most recent run per checkName is shown, not older runs", () => {
    const html = render([
      mkVerificationCheck({
        checkName: "install",
        status: "timed_out",
        reasonCategory: "install_timeout",
        at: "2026-06-01T09:00:00.000Z",
      }),
      mkVerificationCheck({
        checkName: "install",
        status: "ran_passed",
        reasonCategory: null,
        at: "2026-06-01T11:00:00.000Z",
      }),
    ]);
    expect(html).toContain("passed");
    expect(html).not.toContain("timed out");
    expect(html).not.toContain("install_timeout");
  });

  test("a skipped check with a reasonCategory renders the reason", () => {
    const html = render([
      mkVerificationCheck({
        checkName: "e2e",
        status: "skipped",
        reasonCategory: "not_configured",
      }),
    ]);
    expect(html).toContain("skipped");
    expect(html).toContain("not_configured");
  });

  test("XSS: checkName is escaped", () => {
    const html = render([
      mkVerificationCheck({ checkName: "<script>xss()</script>" }),
    ]);
    expect(html).not.toContain("<script>xss");
    expect(html).toContain("&lt;script&gt;");
  });
});

// ─── renderTasksPage — mobile column hiding ───────────────────────────────────

describe("renderTasksPage — mobile column hiding", () => {
  function render(tasks: TaskItem[] = [TASK_ITEM], readOnly = false): string {
    return renderTasksPage(
      tasks,
      {},
      false,
      USER_NAME,
      {},
      { total: tasks.length, limit: 50, page: 1 },
      undefined,
      undefined,
      readOnly,
    );
  }

  // AC2: col-session class on the Session <th>
  test("Session <th> has class col-session", () => {
    const html = render();
    expect(html).toContain('<th class="col-session">Session</th>');
  });

  // AC2: col-repo class on the Repo <th>
  test("Repo <th> has class col-repo", () => {
    const html = render();
    expect(html).toContain('<th class="col-repo">Repo</th>');
  });

  // AC2: col-session class on every Session <td>
  test("Session <td> cells have class col-session", () => {
    const html = render([TASK_ITEM]);
    // TASK_ITEM has session: "session-abc"
    expect(html).toContain('class="col-session');
    // The session td must contain the class
    const sessionTdPattern = /<td[^>]*class="[^"]*col-session[^"]*"[^>]*>/;
    expect(html).toMatch(sessionTdPattern);
  });

  // AC2: col-repo class on every Repo <td>
  test("Repo <td> cells have class col-repo", () => {
    const html = render([TASK_ITEM]);
    // TASK_ITEM has repo: "org/repo"
    const repoTdPattern = /<td[^>]*class="[^"]*col-repo[^"]*"[^>]*>/;
    expect(html).toMatch(repoTdPattern);
  });

  // AC4: readOnly=true also has the correct classes
  test("col-session and col-repo classes appear in readOnly=true output", () => {
    const html = render([TASK_ITEM], true);
    expect(html).toContain('<th class="col-session">Session</th>');
    expect(html).toContain('<th class="col-repo">Repo</th>');
    const sessionTdPattern = /<td[^>]*class="[^"]*col-session[^"]*"[^>]*>/;
    const repoTdPattern = /<td[^>]*class="[^"]*col-repo[^"]*"[^>]*>/;
    expect(html).toMatch(sessionTdPattern);
    expect(html).toMatch(repoTdPattern);
  });

  // Multiple tasks → all rows get the correct classes
  test("all task rows have col-session and col-repo on their <td> cells", () => {
    const html = render([TASK_ITEM, TASK_ITEM_PENDING]);
    const sessionTdMatches = html.match(
      /<td[^>]*class="[^"]*col-session[^"]*"[^>]*>/g,
    );
    const repoTdMatches = html.match(
      /<td[^>]*class="[^"]*col-repo[^"]*"[^>]*>/g,
    );
    // One col-session td per row (2 rows)
    expect(sessionTdMatches).not.toBeNull();
    expect((sessionTdMatches ?? []).length).toBe(2);
    expect(repoTdMatches).not.toBeNull();
    expect((repoTdMatches ?? []).length).toBe(2);
  });
});

// ─── renderTasksPage — readOnly suppresses internal /admin/ links ────────────

describe("renderTasksPage — readOnly suppresses internal /admin/ links", () => {
  const CLAIMED_BLOCKED_TASK: TaskItem = {
    id: "TASK-3",
    title: "Claimed and blocked task",
    status: "blocked",
    session: "session-abc",
    repo: "org/repo",
    assignee: null,
    claimedBy: "agent-x",
    blockedBy: [{ type: "dependency", id: "TASK-dep", status: "pending" }],
  };

  function render(readOnly: boolean): string {
    return renderTasksPage(
      [CLAIMED_BLOCKED_TASK],
      {},
      false,
      USER_NAME,
      {},
      { total: 1, limit: 50, page: 1 },
      undefined,
      undefined,
      readOnly,
    );
  }

  test("readOnly=false links the agent cell and the blocker badge", () => {
    const html = render(false);
    expect(html).toContain('<a href="/admin/agents/agent-x"');
    expect(html).toContain('<a href="/admin/tasks/TASK-dep"');
  });

  test("readOnly=true renders the same ids as plain text, no /admin/ links", () => {
    const html = render(true);
    expect(html).toContain("agent-x");
    expect(html).toContain("Blocked:");
    expect(html).toContain("TASK-dep");
    expect(html).not.toContain("/admin/");
  });
});

// ─── Session value links to /admin/sessions/{session} (ASV-1.1) ─────────────

describe("renderTasksPage — session links to /admin/sessions/{session}", () => {
  test("session cell links to /admin/sessions/{session}", () => {
    const html = renderTasksPage(
      [TASK_ITEM],
      {},
      false,
      USER_NAME,
      {},
      { total: 1, limit: 50, page: 1 },
    );
    // TBF-1.1: carries ?from=/admin/tasks?view=table so the Session Detail
    // back link returns to the table view instead of the board.
    const from = encodeURIComponent("/admin/tasks?view=table");
    expect(html).toContain(
      `<a href="/admin/sessions/${encodeURIComponent(TASK_ITEM.session as string)}?from=${from}"`,
    );
  });

  test("session cell with no session value renders the placeholder, not a link", () => {
    const html = renderTasksPage(
      [TASK_ITEM_PENDING],
      {},
      false,
      USER_NAME,
      {},
      { total: 1, limit: 50, page: 1 },
    );
    expect(html).not.toContain("/admin/sessions/undefined");
    expect(html).not.toContain("/admin/sessions/null");
  });

  // AC4: session link carries the current list URL as `from` so the Session
  // Detail back link can return to this exact filtered/paginated view.
  test("session cell carries the current list URL as ?from= when filters are active", () => {
    const html = renderTasksPage(
      [TASK_ITEM],
      { status: "in_progress" },
      false,
      USER_NAME,
      {},
      { total: 1, limit: 50, page: 2 },
    );
    const from = "/admin/tasks?status=in_progress&page=2&view=table";
    expect(html).toContain(
      `<a href="/admin/sessions/${encodeURIComponent(TASK_ITEM.session as string)}?from=${encodeURIComponent(from)}"`,
    );
  });

  // TBF-1.1 (was AC4's "bare default omits ?from="): bare /admin/tasks now
  // defaults to the board (AXR-1.3), so even the default table-view case (no
  // filters, page 1) must still carry ?from=/admin/tasks?view=table — a bare
  // link would bounce the user off the table view.
  test("session cell still carries ?from= for the default table view (no filters, page 1)", () => {
    const html = renderTasksPage(
      [TASK_ITEM],
      {},
      false,
      USER_NAME,
      {},
      { total: 1, limit: 50, page: 1 },
    );
    const from = encodeURIComponent("/admin/tasks?view=table");
    expect(html).toContain(
      `<a href="/admin/sessions/${encodeURIComponent(TASK_ITEM.session as string)}?from=${from}" style="color:#6366f1;text-decoration:none">`,
    );
  });
});

describe("renderTaskDetailPage — session link to /admin/sessions/{session}", () => {
  test("Session field links to /admin/sessions/{session}", () => {
    const task: TaskItem = { ...TASK_ITEM, session: "session-xyz" };
    const html = renderTaskDetailPage(task, USER_NAME);
    expect(html).toContain(`<a href="/admin/sessions/session-xyz`);
  });

  test("session value with special characters is URL-encoded in the link", () => {
    const task: TaskItem = { ...TASK_ITEM, session: "session/with slash" };
    const html = renderTaskDetailPage(task, USER_NAME);
    expect(html).toContain(
      `<a href="/admin/sessions/${encodeURIComponent("session/with slash")}`,
    );
  });

  test("no Session row rendered when session is absent", () => {
    const task: TaskItem = { ...TASK_ITEM, session: null };
    const html = renderTaskDetailPage(task, USER_NAME);
    expect(html).not.toContain("/admin/sessions/");
  });

  // AC4: the Session link carries this task detail page's own URL as `from`
  // so the Session Detail back link can return to it.
  test("Session field link carries this task detail page's URL as ?from=", () => {
    const task: TaskItem = {
      ...TASK_ITEM,
      id: "TASK-9",
      session: "session-xyz",
    };
    const html = renderTaskDetailPage(task, USER_NAME);
    const from = `/admin/tasks/${encodeURIComponent("TASK-9")}`;
    expect(html).toContain(
      `<a href="/admin/sessions/session-xyz?from=${encodeURIComponent(from)}"`,
    );
  });
});

// ─── renderTaskDetailPage — kind field (TKD-1.4) ────────────────────────────────

describe("renderTaskDetailPage — kind field (TKD-1.4)", () => {
  function render(task: Partial<TaskItem> = {}): string {
    return renderTaskDetailPage(
      { ...TASK_DETAIL, ...task },
      USER_NAME,
      {},
      "UTC",
    );
  }

  // AC1: Task detail page shows a Kind row when kind is set
  test("shows Kind row when task.kind is 'prd'", () => {
    const html = render({ kind: "prd" });
    expect(html).toContain("Kind");
    expect(html).toContain("prd");
  });

  test("shows Kind row when task.kind is 'dev'", () => {
    const html = render({ kind: "dev" });
    expect(html).toContain("Kind");
    expect(html).toContain("dev");
  });

  // Backward compat: no Kind row when kind is absent
  test("no Kind row when kind is null", () => {
    const html = render({ kind: null });
    // The Kind label should not appear in the HTML
    expect(html).not.toContain(
      '<td style="width:170px;padding:8px 12px;color:#6b7280;font-size:12px;font-weight:500;vertical-align:top;white-space:nowrap">Kind</td>',
    );
  });

  test("no Kind row when kind is undefined", () => {
    const html = render({ kind: undefined });
    expect(html).not.toContain(
      '<td style="width:170px;padding:8px 12px;color:#6b7280;font-size:12px;font-weight:500;vertical-align:top;white-space:nowrap">Kind</td>',
    );
  });

  // XSS: kind value is escaped
  test("Kind value is HTML-escaped", () => {
    const html = render({ kind: "<script>alert(1)</script>" });
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });
});

// ─── renderPrsPage — mobile column hiding (AMB-1.4) ──────────────────────────

describe("renderPrsPage — mobile column hiding", () => {
  function render(
    prs: PrListItem[] = [PR_LIST_ITEM_1, PR_LIST_ITEM_2],
  ): string {
    return renderPrsPage(
      prs,
      {},
      false,
      USER_NAME,
      { "agent-001": "Alpha Agent" },
      { total: prs.length, limit: 50, page: 1 },
    );
  }

  // AC2: col-review-cycles class on the Review Cycles <th>. AXR-2.1 wraps
  // the header text in a shared .header-tooltip span (data-tip), so the
  // text is no longer the <th>'s immediate content.
  test("Review Cycles <th> has class col-review-cycles", () => {
    const html = render();
    expect(html).toContain('class="col-review-cycles"');
    expect(html).toMatch(
      /<th[^>]*class="[^"]*col-review-cycles[^"]*"[^>]*>[\s\S]*?Review Cycles[\s\S]*?<\/th>/,
    );
  });

  // AC2: col-patch-cycles class on the Patch Cycles <th>
  test("Patch Cycles <th> has class col-patch-cycles", () => {
    const html = render();
    expect(html).toContain('class="col-patch-cycles"');
    expect(html).toMatch(
      /<th[^>]*class="[^"]*col-patch-cycles[^"]*"[^>]*>[\s\S]*?Patch Cycles[\s\S]*?<\/th>/,
    );
  });

  // AC2: col-claimed-by class on the Claimed By <th>
  test("Claimed By <th> has class col-claimed-by", () => {
    const html = render();
    expect(html).toContain('class="col-claimed-by"');
    expect(html).toMatch(
      /<th[^>]*class="[^"]*col-claimed-by[^"]*"[^>]*>Claimed By<\/th>/,
    );
  });

  // AC2: col-review-cycles class on every Review Cycles <td>
  test("Review Cycles <td> cells have class col-review-cycles", () => {
    const html = render([PR_LIST_ITEM_1]);
    const pattern = /<td[^>]*class="[^"]*col-review-cycles[^"]*"[^>]*>/;
    expect(html).toMatch(pattern);
  });

  // AC2: col-patch-cycles class on every Patch Cycles <td>
  test("Patch Cycles <td> cells have class col-patch-cycles", () => {
    const html = render([PR_LIST_ITEM_1]);
    const pattern = /<td[^>]*class="[^"]*col-patch-cycles[^"]*"[^>]*>/;
    expect(html).toMatch(pattern);
  });

  // AC2: col-claimed-by class on every Claimed By <td>
  test("Claimed By <td> cells have class col-claimed-by", () => {
    const html = render([PR_LIST_ITEM_1]);
    const pattern = /<td[^>]*class="[^"]*col-claimed-by[^"]*"[^>]*>/;
    expect(html).toMatch(pattern);
  });

  // Multiple rows → all rows get the correct classes
  test("all PR rows have col-review-cycles, col-patch-cycles, and col-claimed-by on their <td> cells", () => {
    const html = render([PR_LIST_ITEM_1, PR_LIST_ITEM_2]);
    const reviewCyclesTdMatches = html.match(
      /<td[^>]*class="[^"]*col-review-cycles[^"]*"[^>]*>/g,
    );
    const patchCyclesTdMatches = html.match(
      /<td[^>]*class="[^"]*col-patch-cycles[^"]*"[^>]*>/g,
    );
    const claimedByTdMatches = html.match(
      /<td[^>]*class="[^"]*col-claimed-by[^"]*"[^>]*>/g,
    );
    // One of each per row (2 rows)
    expect(reviewCyclesTdMatches).not.toBeNull();
    expect((reviewCyclesTdMatches ?? []).length).toBe(2);
    expect(patchCyclesTdMatches).not.toBeNull();
    expect((patchCyclesTdMatches ?? []).length).toBe(2);
    expect(claimedByTdMatches).not.toBeNull();
    expect((claimedByTdMatches ?? []).length).toBe(2);
  });
});

// ─── classifyTaskState (HBV-1.2) ─────────────────────────────────────────────
// Mirrors task-store/src/task-service.ts's list()/listReady()/listBlocked()
// grouping: blockedBy is computed server-side for every status (not just
// pending), so classifyTaskState must check it before the in_progress/
// pr_open/approved branch — otherwise an in_progress task carrying an
// unresolved dependency or hitl block gets misbucketed as "in_progress".

describe("classifyTaskState", () => {
  const BASE: TaskItem = {
    id: "TASK-1",
    title: "Some task",
    status: "pending",
  };

  test.each(["in_progress", "pr_open", "approved"] as const)(
    "status %s with non-empty blockedBy classifies as blocked",
    (status) => {
      const task: TaskItem = {
        ...BASE,
        status,
        blockedBy: [{ type: "hitl" }],
      };
      expect(classifyTaskState(task)).toBe("blocked");
    },
  );

  test.each(["in_progress", "pr_open", "approved"] as const)(
    "status %s with empty blockedBy still classifies as in_progress",
    (status) => {
      const task: TaskItem = { ...BASE, status, blockedBy: [] };
      expect(classifyTaskState(task)).toBe("in_progress");
    },
  );

  test.each(["in_progress", "pr_open", "approved"] as const)(
    "status %s with no blockedBy field still classifies as in_progress",
    (status) => {
      const task: TaskItem = { ...BASE, status };
      expect(classifyTaskState(task)).toBe("in_progress");
    },
  );

  test.each(["merged", "done", "deploying", "deployed", "cancelled"] as const)(
    "closed status %s takes precedence over a stale non-empty blockedBy",
    (status) => {
      const task: TaskItem = {
        ...BASE,
        status,
        blockedBy: [{ type: "dependency", id: "TASK-0", status: "pending" }],
      };
      expect(classifyTaskState(task)).toBe("closed");
    },
  );

  test("explicit status blocked classifies as blocked", () => {
    const task: TaskItem = { ...BASE, status: "blocked" };
    expect(classifyTaskState(task)).toBe("blocked");
  });

  test("pending status with unresolved blockedBy classifies as blocked", () => {
    const task: TaskItem = {
      ...BASE,
      status: "pending",
      blockedBy: [{ type: "dependency", id: "TASK-0", status: "pending" }],
    };
    expect(classifyTaskState(task)).toBe("blocked");
  });

  test("pending status with no blockedBy classifies as ready", () => {
    const task: TaskItem = { ...BASE, status: "pending", blockedBy: [] };
    expect(classifyTaskState(task)).toBe("ready");
  });
});

// ─── bucketTaskColumn (AXR-1.2) ──────────────────────────────────────────────
// Single source of truth for the 5-column task board (Queued / Claimed /
// In Progress / Blocked-HITL / Done), consumed later by AXR-1.3's board UI.
// Every task must resolve to exactly one column — including the edge case
// where both the task itself (status/hitl/blockedBy) and its joined PR
// (pr.blocked) are separately blocked.

describe("bucketTaskColumn", () => {
  const BASE: TaskItem = {
    id: "TASK-1",
    title: "Some task",
    status: "pending",
  };

  test.each(["merged", "deployed", "done", "deploying", "cancelled"] as const)(
    "status %s buckets as done",
    (status) => {
      expect(bucketTaskColumn({ ...BASE, status })).toBe("done");
    },
  );

  test("status done wins over hitl:true (done takes precedence)", () => {
    const task: TaskItem = { ...BASE, status: "done", hitl: true };
    expect(bucketTaskColumn(task)).toBe("done");
  });

  test("status done wins over a blocked joined PR (done takes precedence)", () => {
    const task: TaskItem = { ...BASE, status: "done" };
    expect(bucketTaskColumn(task, true)).toBe("done");
  });

  test("explicit status blocked buckets as blocked_hitl", () => {
    const task: TaskItem = { ...BASE, status: "blocked" };
    expect(bucketTaskColumn(task)).toBe("blocked_hitl");
  });

  test("hitl:true and not yet done buckets as blocked_hitl", () => {
    const task: TaskItem = { ...BASE, status: "in_progress", hitl: true };
    expect(bucketTaskColumn(task)).toBe("blocked_hitl");
  });

  test("joined PR blocked:true buckets as blocked_hitl even when the task itself is not blocked", () => {
    const task: TaskItem = { ...BASE, status: "in_progress" };
    expect(bucketTaskColumn(task, true)).toBe("blocked_hitl");
  });

  test("non-empty blockedBy (unresolved dependency) buckets as blocked_hitl even with status pending", () => {
    const task: TaskItem = {
      ...BASE,
      status: "pending",
      blockedBy: [{ type: "dependency", id: "REL-2.2", status: "pending" }],
    };
    expect(bucketTaskColumn(task)).toBe("blocked_hitl");
  });

  test("non-empty blockedBy (hitl wait) buckets as blocked_hitl even with status in_progress", () => {
    const task: TaskItem = {
      ...BASE,
      status: "in_progress",
      blockedBy: [{ type: "hitl" }],
    };
    expect(bucketTaskColumn(task)).toBe("blocked_hitl");
  });

  test("empty blockedBy does not force blocked_hitl", () => {
    const task: TaskItem = { ...BASE, status: "pending", blockedBy: [] };
    expect(bucketTaskColumn(task)).toBe("queued");
  });

  test("both task-level blocked (status) AND PR-level blocked resolve to the single blocked_hitl bucket", () => {
    const task: TaskItem = { ...BASE, status: "blocked" };
    expect(bucketTaskColumn(task, true)).toBe("blocked_hitl");
  });

  test("both task-level blocked (hitl) AND PR-level blocked resolve to the single blocked_hitl bucket", () => {
    const task: TaskItem = { ...BASE, status: "in_progress", hitl: true };
    expect(bucketTaskColumn(task, true)).toBe("blocked_hitl");
  });

  test.each(["in_progress", "pr_open", "approved"] as const)(
    "status %s with no blockers buckets as in_progress",
    (status) => {
      const task: TaskItem = { ...BASE, status };
      expect(bucketTaskColumn(task)).toBe("in_progress");
    },
  );

  test("pending status with a claimedBy buckets as claimed", () => {
    const task: TaskItem = {
      ...BASE,
      status: "pending",
      claimedBy: "agent-1",
    };
    expect(bucketTaskColumn(task)).toBe("claimed");
  });

  test("pending status with no claimedBy buckets as queued", () => {
    const task: TaskItem = { ...BASE, status: "pending", claimedBy: null };
    expect(bucketTaskColumn(task)).toBe("queued");
  });

  test("pending status with claimedBy undefined buckets as queued", () => {
    const task: TaskItem = { ...BASE, status: "pending" };
    expect(bucketTaskColumn(task)).toBe("queued");
  });

  test("prBlocked false does not force blocked_hitl for an otherwise-in_progress task", () => {
    const task: TaskItem = { ...BASE, status: "in_progress" };
    expect(bucketTaskColumn(task, false)).toBe("in_progress");
  });
});

// ─── renderSessionDetailPage (ASV-1.1) ───────────────────────────────────────

describe("renderSessionDetailPage", () => {
  const SESSION_ID = "session-abc";

  const READY_TASK: TaskItem = {
    id: "TASK-1",
    title: "Build the thing",
    status: "pending",
    session: SESSION_ID,
    repo: "org/repo",
    layer: "Backend",
    hours: 2,
    dependencies: ["TASK-0"],
  };

  const IN_PROGRESS_TASK: TaskItem = {
    id: "TASK-2",
    title: "Wire up the UI",
    status: "in_progress",
    session: SESSION_ID,
    repo: "org/repo",
    layer: "Frontend",
    hours: 3.5,
  };

  const CLOSED_TASK_1: TaskItem = {
    id: "TASK-3",
    title: "Ship it",
    status: "done",
    session: SESSION_ID,
    repo: "org/repo",
    layer: "Backend",
    hours: 1,
  };

  const CLOSED_TASK_2: TaskItem = {
    id: "TASK-4",
    title: "Deploy it",
    status: "merged",
    session: SESSION_ID,
    repo: "org/repo",
    layer: "Ops",
    hours: 0.5,
  };

  const MIXED_TASKS = [
    READY_TASK,
    IN_PROGRESS_TASK,
    CLOSED_TASK_1,
    CLOSED_TASK_2,
  ];

  test("stat cards: total tasks, est. hours sum, distinct layers", () => {
    const html = renderSessionDetailPage(SESSION_ID, MIXED_TASKS, USER_NAME);
    // total tasks = 4
    expect(html).toContain(">4<");
    // est hours sum = 2 + 3.5 + 1 + 0.5 = 7
    expect(html).toContain(">7<");
    // distinct layers = Backend, Frontend, Ops = 3
    expect(html).toContain(">3<");
  });

  test("task table includes a Status column and renders every task", () => {
    const html = renderSessionDetailPage(SESSION_ID, MIXED_TASKS, USER_NAME);
    expect(html).toContain("<th>Status</th>");
    expect(html).toContain("Build the thing");
    expect(html).toContain("Wire up the UI");
    expect(html).toContain("Ship it");
    expect(html).toContain("Deploy it");
    expect(html).toContain("pending");
    expect(html).toContain("in_progress");
    expect(html).toContain("done");
    expect(html).toContain("merged");
  });

  test("task table includes a Source column header", () => {
    const html = renderSessionDetailPage(SESSION_ID, MIXED_TASKS, USER_NAME);
    expect(html).toContain('<th class="col-source">Source</th>');
  });

  test("row renders task.source value in the Source column", () => {
    const taskWithSource: TaskItem = {
      ...READY_TASK,
      source: "entropy-fix",
    };
    const html = renderSessionDetailPage(
      SESSION_ID,
      [taskWithSource],
      USER_NAME,
    );
    expect(html).toContain(
      '<td class="col-source mono" style="font-size:11px">entropy-fix</td>',
    );
  });

  test("row without source shows em-dash placeholder", () => {
    const taskWithoutSource: TaskItem = { ...READY_TASK, source: null };
    const html = renderSessionDetailPage(
      SESSION_ID,
      [taskWithoutSource],
      USER_NAME,
    );
    expect(html).toContain(
      '<td class="col-source mono" style="font-size:11px"><span style="color:#9ca3af">—</span></td>',
    );
  });

  test("row escapes HTML in task.source", () => {
    const xssTask: TaskItem = {
      ...READY_TASK,
      source: '"><script>xss()</script>',
    };
    const html = renderSessionDetailPage(SESSION_ID, [xssTask], USER_NAME);
    expect(html).not.toContain("<script>xss()</script>");
  });

  test("no filter form is added to the session detail view", () => {
    const html = renderSessionDetailPage(SESSION_ID, MIXED_TASKS, USER_NAME);
    expect(html).not.toContain('name="source"');
    expect(html).not.toContain('placeholder="source"');
  });

  test("summarizes and groups the task table by ready/in_progress/blocked/closed — matching the Tasks page taxonomy", () => {
    const html = renderSessionDetailPage(SESSION_ID, MIXED_TASKS, USER_NAME);
    // READY_TASK (pending, no blockedBy) -> ready; IN_PROGRESS_TASK (in_progress) -> in_progress;
    // CLOSED_TASK_1/2 (done, merged) -> closed; none blocked.
    expect(html).toMatch(/1[^0-9]*ready/i);
    expect(html).toMatch(/1[^0-9]*in progress/i);
    expect(html).toMatch(/0[^0-9]*blocked/i);
    expect(html).toMatch(/2[^0-9]*closed/i);
    expect(html).toContain("Ready (1)");
    expect(html).toContain("In Progress (1)");
    expect(html).toContain("Closed (2)");
    expect(html).not.toContain("Blocked (");
  });

  test("all-ready-or-in-progress session: no Closed group rendered", () => {
    const html = renderSessionDetailPage(
      SESSION_ID,
      [READY_TASK, IN_PROGRESS_TASK],
      USER_NAME,
    );
    expect(html).toContain("Ready (1)");
    expect(html).toContain("In Progress (1)");
    expect(html).not.toContain("Closed (");
  });

  test("all-closed session: single Closed group, no Ready/In Progress/Blocked", () => {
    const html = renderSessionDetailPage(
      SESSION_ID,
      [CLOSED_TASK_1, CLOSED_TASK_2],
      USER_NAME,
    );
    expect(html).toContain("Closed (2)");
    expect(html).not.toContain("Ready (");
    expect(html).not.toContain("In Progress (");
    expect(html).not.toContain("Blocked (");
  });

  test("a pending task with unresolved blockers groups under Blocked in the task table", () => {
    const blocked: TaskItem = {
      id: "TASK-5",
      title: "Blocked on something",
      status: "pending",
      session: SESSION_ID,
      blockedBy: [{ type: "dependency", id: "TASK-1", status: "pending" }],
    };
    const html = renderSessionDetailPage(SESSION_ID, [blocked], USER_NAME);
    expect(html).toContain("Blocked (1)");
  });

  test("an in_progress task with hitl-derived blockedBy groups under Blocked, not In Progress", () => {
    const blockedInProgress: TaskItem = {
      id: "TASK-6",
      title: "Waiting on a human",
      status: "in_progress",
      session: SESSION_ID,
      blockedBy: [{ type: "hitl" }],
    };
    const html = renderSessionDetailPage(
      SESSION_ID,
      [blockedInProgress],
      USER_NAME,
    );
    expect(html).toContain("Blocked (1)");
    expect(html).not.toContain("In Progress (1)");
  });

  test("dependency list rendering: distinct dependency ids collected across tasks", () => {
    const html = renderSessionDetailPage(SESSION_ID, MIXED_TASKS, USER_NAME);
    expect(html).toContain("TASK-0");
  });

  test("empty-session case: sensible empty state, zero stats", () => {
    const html = renderSessionDetailPage(SESSION_ID, [], USER_NAME);
    expect(html).toContain(">0<");
    expect(html.toLowerCase()).toContain("no tasks");
  });

  test("renders the session id in the page", () => {
    const html = renderSessionDetailPage(SESSION_ID, MIXED_TASKS, USER_NAME);
    expect(html).toContain(SESSION_ID);
  });

  test("escapes the session id to avoid XSS", () => {
    const xssSession = "<script>alert(1)</script>";
    const html = renderSessionDetailPage(xssSession, [], USER_NAME);
    expect(html).not.toContain("<script>alert(1)</script>");
  });

  test("tasks with missing hours/layer don't break stat computation", () => {
    const sparseTask: TaskItem = {
      id: "TASK-5",
      title: "Sparse task",
      status: "pending",
      session: SESSION_ID,
      repo: null,
    };
    const html = renderSessionDetailPage(SESSION_ID, [sparseTask], USER_NAME);
    expect(html).toContain("Sparse task");
    expect(html).toContain(">1<"); // 1 total task
  });

  // ─── Admin actions: archive/unarchive/rename (SESH-5.2) ─────────────────────

  test("isAdmin=false (default): no archive/unarchive/rename controls are present", () => {
    const html = renderSessionDetailPage(SESSION_ID, MIXED_TASKS, USER_NAME);
    expect(html).not.toContain(`/admin/sessions/${SESSION_ID}/archive`);
    expect(html).not.toContain(`/admin/sessions/${SESSION_ID}/unarchive`);
    expect(html).not.toContain(`/admin/sessions/${SESSION_ID}/rename`);
    expect(html).not.toContain("newTitle");
  });

  test("isAdmin=true: archive, unarchive, and rename forms are present", () => {
    const html = renderSessionDetailPage(
      SESSION_ID,
      MIXED_TASKS,
      USER_NAME,
      false,
      "/admin/tasks",
      {},
      true,
    );
    expect(html).toContain(`action="/admin/sessions/${SESSION_ID}/archive"`);
    expect(html).toContain(`action="/admin/sessions/${SESSION_ID}/unarchive"`);
    expect(html).toContain(`action="/admin/sessions/${SESSION_ID}/rename"`);
    expect(html).toContain('name="newTitle"');
  });

  test("a session id with characters needing escaping is URL-encoded in admin action form action attributes", () => {
    const xssSession = "session<script>";
    const html = renderSessionDetailPage(
      xssSession,
      [],
      USER_NAME,
      false,
      "/admin/tasks",
      {},
      true,
    );
    expect(html).not.toContain(
      `action="/admin/sessions/${xssSession}/archive"`,
    );
    expect(html).toContain(
      `action="/admin/sessions/${encodeURIComponent(xssSession)}/archive"`,
    );
  });

  test("notice: a success notice renders an alert-success banner with the message", () => {
    const html = renderSessionDetailPage(
      SESSION_ID,
      MIXED_TASKS,
      USER_NAME,
      false,
      "/admin/tasks",
      {},
      true,
      { kind: "success", message: "Session archived." },
    );
    expect(html).toContain('class="alert alert-success"');
    expect(html).toContain("Session archived.");
  });

  test("notice: an error notice renders an alert-error banner with the message", () => {
    const html = renderSessionDetailPage(
      SESSION_ID,
      MIXED_TASKS,
      USER_NAME,
      false,
      "/admin/tasks",
      {},
      true,
      { kind: "error", message: "Failed to archive the session." },
    );
    expect(html).toContain('class="alert alert-error"');
    expect(html).toContain("Failed to archive the session.");
  });

  test("no notice: no alert-success/alert-error banner is rendered", () => {
    const html = renderSessionDetailPage(SESSION_ID, MIXED_TASKS, USER_NAME);
    expect(html).not.toContain('class="alert alert-success"');
    expect(html).not.toContain('class="alert alert-error"');
  });
});

// ─── renderSessionDetailPage — Needs-you panel + header state badge (SESH-5.1)

describe("renderSessionDetailPage — Needs-you panel + header state badge", () => {
  const SESSION_ID = "session-needs-you";

  test("a blocked task renders a waiting header badge, the Needs-you panel, Blocked kind, reason, since, task link, and unblock hint", () => {
    const blocked: TaskItem = {
      id: "TASK-BLOCKED",
      title: "Stuck",
      status: "blocked",
      session: SESSION_ID,
      blockedReason: "Ambiguous requirement",
      updatedAt: "2026-05-01T00:00:00.000Z",
    };
    const html = renderSessionDetailPage(SESSION_ID, [blocked], USER_NAME);
    expect(html).toContain("Needs you");
    expect(html).toContain("Blocked");
    expect(html).toContain("Ambiguous requirement");
    expect(html).toContain("2026-05-01T00:00:00.000Z");
    expect(html).toContain('href="/admin/tasks/TASK-BLOCKED"');
    expect(html).toContain("/shipwright:unblock TASK-BLOCKED");
    expect(html).toContain("Waiting");
    expect(html).toContain("Waiting since 2026-05-01T00:00:00.000Z");
  });

  test("a hitl task with no unmet dependency renders the HITL kind + the fixed hint string", () => {
    const hitlTask: TaskItem = {
      id: "TASK-HITL",
      title: "Needs a human",
      status: "in_progress",
      session: SESSION_ID,
      hitl: true,
      updatedAt: "2026-05-02T00:00:00.000Z",
    };
    const html = renderSessionDetailPage(SESSION_ID, [hitlTask], USER_NAME);
    expect(html).toContain("Needs you");
    expect(html).toContain("HITL");
    expect(html).toContain("Needs human via /shipwright:hitl");
    expect(html).toContain("/shipwright:hitl TASK-HITL");
  });

  test("a hitl task with an unmet dependency does NOT classify as waiting (dependency-only waits excluded)", () => {
    const hitlWithDependency: TaskItem = {
      id: "TASK-HITL-DEP",
      title: "Needs a human, but blocked on a dependency first",
      status: "pending",
      session: SESSION_ID,
      hitl: true,
      blockedBy: [{ type: "dependency", id: "TASK-0", status: "pending" }],
      updatedAt: "2026-05-03T00:00:00.000Z",
    };
    const html = renderSessionDetailPage(
      SESSION_ID,
      [hitlWithDependency],
      USER_NAME,
    );
    expect(html).not.toContain("Needs you");
  });

  test("a task with pr set and a blocked joined PR renders the PR blocked kind, the PR's blockedReason, and a PR link", () => {
    const prBlockedTask: TaskItem = {
      id: "TASK-PR-BLOCKED",
      title: "Its PR is stuck",
      status: "pr_open",
      session: SESSION_ID,
      pr: 77,
      prUrl: "https://github.com/example-org/example-repo/pull/77",
      updatedAt: "2026-05-04T00:00:00.000Z",
    };
    const prsByTaskId: Record<string, PrListItem> = {
      "TASK-PR-BLOCKED": {
        id: "pr-77",
        repo: "example-org/example-repo",
        prNumber: 77,
        staged: false,
        state: "open",
        reviewState: "in_review",
        patchCycles: 0,
        reviewCycles: 0,
        blocked: true,
        blockedReason: "Waiting on CI",
      },
    };
    const html = renderSessionDetailPage(
      SESSION_ID,
      [prBlockedTask],
      USER_NAME,
      false,
      "/admin/tasks",
      prsByTaskId,
    );
    expect(html).toContain("Needs you");
    expect(html).toContain("PR blocked");
    expect(html).toContain("Waiting on CI");
    expect(html).toContain(
      'href="https://github.com/example-org/example-repo/pull/77"',
    );
    expect(html).toContain("/shipwright:unblock TASK-PR-BLOCKED");
  });

  test("a non-waiting session (active/closed only) renders no Needs-you panel and no Waiting header state", () => {
    const activeTask: TaskItem = {
      id: "TASK-ACTIVE",
      title: "In flight",
      status: "in_progress",
      session: SESSION_ID,
      updatedAt: "2026-05-05T00:00:00.000Z",
    };
    const html = renderSessionDetailPage(SESSION_ID, [activeTask], USER_NAME);
    expect(html).not.toContain("Needs you");
    expect(html).not.toContain("Waiting since");
  });

  test("an empty session renders the Empty header state and no Needs-you panel", () => {
    const html = renderSessionDetailPage(SESSION_ID, [], USER_NAME);
    expect(html).toContain(">Empty<");
    expect(html).not.toContain("Needs you");
  });

  test("a fully-closed session renders the Closed header state and no Needs-you panel", () => {
    const closedTask: TaskItem = {
      id: "TASK-DONE",
      title: "Shipped",
      status: "done",
      session: SESSION_ID,
      updatedAt: "2026-05-06T00:00:00.000Z",
    };
    const html = renderSessionDetailPage(SESSION_ID, [closedTask], USER_NAME);
    expect(html).toContain(">Closed<");
    expect(html).not.toContain("Needs you");
  });

  test("escapes HTML in a blocked task's blockedReason", () => {
    const xssBlocked: TaskItem = {
      id: "TASK-XSS-BLOCKED",
      title: "xss",
      status: "blocked",
      session: SESSION_ID,
      blockedReason: '"><script>xssBlocked()</script>',
      updatedAt: "2026-05-07T00:00:00.000Z",
    };
    const html = renderSessionDetailPage(SESSION_ID, [xssBlocked], USER_NAME);
    expect(html).not.toContain("<script>xssBlocked()</script>");
  });

  test("escapes HTML in a pr_blocked task's joined PR blockedReason", () => {
    const xssPrTask: TaskItem = {
      id: "TASK-XSS-PR",
      title: "xss",
      status: "pr_open",
      session: SESSION_ID,
      pr: 88,
      updatedAt: "2026-05-08T00:00:00.000Z",
    };
    const prsByTaskId: Record<string, PrListItem> = {
      "TASK-XSS-PR": {
        id: "pr-88",
        repo: "example-org/example-repo",
        prNumber: 88,
        staged: false,
        state: "open",
        reviewState: "in_review",
        patchCycles: 0,
        reviewCycles: 0,
        blocked: true,
        blockedReason: '"><script>xssPr()</script>',
      },
    };
    const html = renderSessionDetailPage(
      SESSION_ID,
      [xssPrTask],
      USER_NAME,
      false,
      "/admin/tasks",
      prsByTaskId,
    );
    expect(html).not.toContain("<script>xssPr()</script>");
  });

  test("escapes HTML in a task's prUrl", () => {
    const xssPrUrlTask: TaskItem = {
      id: "TASK-XSS-PRURL",
      title: "xss",
      status: "blocked",
      session: SESSION_ID,
      prUrl: '"><script>xssPrUrl()</script>',
      updatedAt: "2026-05-09T00:00:00.000Z",
    };
    const html = renderSessionDetailPage(SESSION_ID, [xssPrUrlTask], USER_NAME);
    expect(html).not.toContain("<script>xssPrUrl()</script>");
  });
});

// ─── renderSessionDetailPage — dependency graph ──────────────────────────────

describe("renderSessionDetailPage dependency graph", () => {
  const SESSION_ID = "session-graph";

  // Isolates the graph card from the task table above it — both can contain
  // the same task ids, so plain html.toContain() can't tell them apart.
  function graphSection(html: string): string {
    const idx = html.indexOf("Dependency graph");
    expect(idx).toBeGreaterThan(-1);
    return html.slice(idx);
  }

  test("no Ready/In Progress/Blocked/Closed grouping headers appear in the graph card", () => {
    const a: TaskItem = {
      id: "TASK-A",
      title: "Root",
      status: "pending",
      session: SESSION_ID,
      blockedBy: [],
    };
    const b: TaskItem = {
      id: "TASK-B",
      title: "Depends on A",
      status: "in_progress",
      session: SESSION_ID,
      dependencies: ["TASK-A"],
      blockedBy: [{ type: "dependency", id: "TASK-A", status: "pending" }],
    };
    const html = renderSessionDetailPage(SESSION_ID, [a, b], USER_NAME);
    const section = graphSection(html);
    expect(section).not.toContain("Ready (");
    expect(section).not.toContain("In Progress (");
    expect(section).not.toContain("Blocked (");
    expect(section).not.toContain("Closed (");
    expect(section).toContain('data-task-id="TASK-A"');
    expect(section).toContain('data-task-id="TASK-B"');
    expect(section).toContain("needs");
    expect(section).toContain('href="/admin/tasks/TASK-A"');
  });

  test("a dependency id outside the session renders as plain unlinked text in the needs line", () => {
    const c: TaskItem = {
      id: "TASK-C",
      title: "Needs an external dep",
      status: "pending",
      session: SESSION_ID,
      dependencies: ["EXTERNAL-1"],
      blockedBy: [{ type: "dependency", id: "EXTERNAL-1", status: "unknown" }],
    };
    const html = renderSessionDetailPage(SESSION_ID, [c], USER_NAME);
    const section = graphSection(html);
    expect(section).toContain("EXTERNAL-1");
    expect(section).not.toContain('href="/admin/tasks/EXTERNAL-1"');
    expect(section).not.toContain('data-to="EXTERNAL-1"');
    expect(section).not.toContain('data-from="EXTERNAL-1"');
  });

  test("a dependency id inside the session links to that task's detail page", () => {
    const root: TaskItem = {
      id: "TASK-ROOT",
      title: "Root",
      status: "pending",
      session: SESSION_ID,
      blockedBy: [],
    };
    const dependent: TaskItem = {
      id: "TASK-DEP",
      title: "Depends on root",
      status: "pending",
      session: SESSION_ID,
      dependencies: ["TASK-ROOT"],
      blockedBy: [{ type: "dependency", id: "TASK-ROOT", status: "pending" }],
    };
    const html = renderSessionDetailPage(
      SESSION_ID,
      [root, dependent],
      USER_NAME,
    );
    const section = graphSection(html);
    expect(section).toContain('href="/admin/tasks/TASK-ROOT"');
    expect(section).toContain('data-from="TASK-ROOT" data-to="TASK-DEP"');
  });

  test("tasks with no dependency relationship at all render as isolated nodes in the graph", () => {
    const unrelated: TaskItem = {
      id: "TASK-LONER",
      title: "No relationships",
      status: "pending",
      session: SESSION_ID,
      blockedBy: [],
    };
    const dependent: TaskItem = {
      id: "TASK-DEP",
      title: "Depends on root",
      status: "pending",
      session: SESSION_ID,
      dependencies: ["TASK-ROOT"],
      blockedBy: [{ type: "dependency", id: "TASK-ROOT", status: "pending" }],
    };
    const root: TaskItem = {
      id: "TASK-ROOT",
      title: "Root",
      status: "pending",
      session: SESSION_ID,
      blockedBy: [],
    };
    const html = renderSessionDetailPage(
      SESSION_ID,
      [unrelated, dependent, root],
      USER_NAME,
    );
    const section = graphSection(html);
    expect(section).toContain("TASK-DEP");
    expect(section).toContain("TASK-ROOT");
    expect(section).toContain('data-task-id="TASK-LONER"');
    expect(section.match(/data-task-id=/g)?.length).toBe(3);
  });

  test("same-branch tasks get a matching branch color", () => {
    const first: TaskItem = {
      id: "TASK-1",
      title: "models + migration",
      status: "pending",
      session: SESSION_ID,
      branch: "feat/bundle",
      blockedBy: [],
    };
    const second: TaskItem = {
      id: "TASK-2",
      title: "admin endpoint",
      status: "in_progress",
      session: SESSION_ID,
      branch: "feat/bundle",
      dependencies: ["TASK-1"],
    };
    const html = renderSessionDetailPage(
      SESSION_ID,
      [first, second],
      USER_NAME,
    );
    const section = graphSection(html);
    const colors = [
      ...section.matchAll(/border-left:3px solid (#[0-9a-f]{6})/g),
    ].map((m) => m[1]);
    expect(colors.length).toBe(2);
    expect(colors[0]).toBe(colors[1]);
  });

  test("single-task session renders the dependency graph card with that node", () => {
    const solo: TaskItem = {
      id: "TASK-SOLO",
      title: "Independent",
      status: "pending",
      session: SESSION_ID,
      blockedBy: [],
    };
    const html = renderSessionDetailPage(SESSION_ID, [solo], USER_NAME);
    expect(graphSection(html)).toContain('data-task-id="TASK-SOLO"');
  });

  test("zero-task session omits the dependency graph card", () => {
    const html = renderSessionDetailPage(SESSION_ID, [], USER_NAME);
    expect(html).not.toContain("Dependency graph");
  });

  test("a mutual dependency cycle doesn't hang rendering and still renders both nodes", () => {
    const x: TaskItem = {
      id: "TASK-X",
      title: "X",
      status: "pending",
      session: SESSION_ID,
      dependencies: ["TASK-Y"],
      blockedBy: [{ type: "dependency", id: "TASK-Y", status: "pending" }],
    };
    const y: TaskItem = {
      id: "TASK-Y",
      title: "Y",
      status: "pending",
      session: SESSION_ID,
      dependencies: ["TASK-X"],
      blockedBy: [{ type: "dependency", id: "TASK-X", status: "pending" }],
    };
    const html = renderSessionDetailPage(SESSION_ID, [x, y], USER_NAME);
    const section = graphSection(html);
    expect(section).toContain('data-task-id="TASK-X"');
    expect(section).toContain('data-task-id="TASK-Y"');
  });

  test("escapes task ids, titles, and branch names in the graph to avoid XSS", () => {
    const xss: TaskItem = {
      id: "TASK-XSS",
      title: "<img src=x onerror=alert(1)>",
      status: "pending",
      session: SESSION_ID,
      branch: "<script>evil()</script>",
      dependencies: ["<b>dep</b>"],
      blockedBy: [{ type: "dependency", id: "<b>dep</b>", status: "unknown" }],
    };
    const html = renderSessionDetailPage(SESSION_ID, [xss], USER_NAME);
    const section = graphSection(html);
    expect(section).not.toContain("<img src=x onerror=alert(1)>");
    expect(section).not.toContain("<script>evil()</script>");
    expect(section).not.toContain("<b>dep</b>");
  });

  test("fan-out+fan-in: node count and data-from/data-to pairs match every in-session edge", () => {
    // ROOT -> CHILD-1, ROOT -> CHILD-2, CHILD-1 -> SINK, CHILD-2 -> SINK
    const root: TaskItem = {
      id: "TASK-ROOT",
      title: "Root",
      status: "pending",
      session: SESSION_ID,
      blockedBy: [],
    };
    const child1: TaskItem = {
      id: "TASK-CHILD-1",
      title: "Child 1",
      status: "pending",
      session: SESSION_ID,
      dependencies: ["TASK-ROOT"],
      blockedBy: [{ type: "dependency", id: "TASK-ROOT", status: "pending" }],
    };
    const child2: TaskItem = {
      id: "TASK-CHILD-2",
      title: "Child 2",
      status: "pending",
      session: SESSION_ID,
      dependencies: ["TASK-ROOT"],
      blockedBy: [{ type: "dependency", id: "TASK-ROOT", status: "pending" }],
    };
    const sink: TaskItem = {
      id: "TASK-SINK",
      title: "Sink",
      status: "pending",
      session: SESSION_ID,
      dependencies: ["TASK-CHILD-1", "TASK-CHILD-2"],
      blockedBy: [
        { type: "dependency", id: "TASK-CHILD-1", status: "pending" },
        { type: "dependency", id: "TASK-CHILD-2", status: "pending" },
      ],
    };
    const html = renderSessionDetailPage(
      SESSION_ID,
      [root, child1, child2, sink],
      USER_NAME,
    );
    const section = graphSection(html);

    const nodeIds = [...section.matchAll(/data-task-id="([^"]+)"/g)].map(
      (m) => m[1],
    );
    expect(nodeIds.sort()).toEqual(
      ["TASK-CHILD-1", "TASK-CHILD-2", "TASK-ROOT", "TASK-SINK"].sort(),
    );

    const edges = [
      ...section.matchAll(/data-from="([^"]+)" data-to="([^"]+)"/g),
    ].map((m) => [m[1], m[2]]);
    expect(edges.length).toBe(4);
    expect(edges).toContainEqual(["TASK-ROOT", "TASK-CHILD-1"]);
    expect(edges).toContainEqual(["TASK-ROOT", "TASK-CHILD-2"]);
    expect(edges).toContainEqual(["TASK-CHILD-1", "TASK-SINK"]);
    expect(edges).toContainEqual(["TASK-CHILD-2", "TASK-SINK"]);
  });

  test("graph is wrapped in .data-table-wrapper for horizontal scroll on mobile", () => {
    const root: TaskItem = {
      id: "TASK-ROOT",
      title: "Root",
      status: "pending",
      session: SESSION_ID,
      blockedBy: [],
    };
    const dependent: TaskItem = {
      id: "TASK-DEP",
      title: "Depends on root",
      status: "pending",
      session: SESSION_ID,
      dependencies: ["TASK-ROOT"],
      blockedBy: [{ type: "dependency", id: "TASK-ROOT", status: "pending" }],
    };
    const html = renderSessionDetailPage(
      SESSION_ID,
      [root, dependent],
      USER_NAME,
    );
    const section = graphSection(html);
    expect(section).toMatch(
      /<div class="data-table-wrapper">\s*<div style="position:relative;/,
    );
  });

  test("2-depth-column graph: wrapper (not inner graph div) carries overflow-x:auto, and inner width exceeds a phone viewport", () => {
    const root: TaskItem = {
      id: "TASK-A",
      title: "Root",
      status: "pending",
      session: SESSION_ID,
      blockedBy: [],
    };
    const dependent: TaskItem = {
      id: "TASK-B",
      title: "Depends on A",
      status: "pending",
      session: SESSION_ID,
      dependencies: ["TASK-A"],
      blockedBy: [{ type: "dependency", id: "TASK-A", status: "pending" }],
    };
    const html = renderSessionDetailPage(
      SESSION_ID,
      [root, dependent],
      USER_NAME,
    );
    const section = graphSection(html);

    // Wrapper carries the (class-based) overflow-x:auto; the inner graph div
    // is exactly sized to its own content and must not duplicate it inline.
    expect(section).toContain('<div class="data-table-wrapper">');
    const innerDivMatch = section.match(/<div style="position:relative;[^"]*"/);
    expect(innerDivMatch).not.toBeNull();
    expect(innerDivMatch?.[0]).not.toContain("overflow-x:auto");

    // Confirm this is genuinely a 2-depth-column graph whose width exceeds a
    // 375px phone viewport, so the wrapper's scroll is actually needed.
    const layout = computeDependencyLayout(
      computeDependencyNodes([root, dependent]),
    );
    const depths = [...layout.positions.values()].map((p) => p.depth);
    const numColumns = new Set(depths).size;
    expect(numColumns).toBe(2);
    expect(layout.width).toBe(
      40 * 2 + numColumns * 220 + (numColumns - 1) * 100,
    );
    expect(layout.width).toBeGreaterThan(375);
  });
});

describe("computeDependencyNodes", () => {
  test("returns every task, including edge-less ones, sorted by id; out-of-session deps get no node", () => {
    const mk = (id: string, deps?: string[]): TaskItem => ({
      id,
      title: id,
      status: "pending",
      session: "s",
      dependencies: deps,
      blockedBy: [],
    });
    const nodes = computeDependencyNodes([
      mk("C-3"),
      mk("B-2", ["A-1", "OUTSIDE-9"]),
      mk("A-1"),
    ]);
    expect(nodes.map((n) => n.id)).toEqual(["A-1", "B-2", "C-3"]);
    expect(nodes[1].dependsOn).toEqual(["A-1", "OUTSIDE-9"]);
  });

  test("an isolated node lays out at depth 0 in column 0", () => {
    const mk = (id: string, deps?: string[]): TaskItem => ({
      id,
      title: id,
      status: "pending",
      session: "s",
      dependencies: deps,
      blockedBy: [],
    });
    const layout = computeDependencyLayout(
      computeDependencyNodes([mk("A-1"), mk("B-2", ["A-1"]), mk("Z-9")]),
    );
    expect(layout.positions.get("Z-9")?.depth).toBe(0);
    expect(layout.positions.get("Z-9")?.x).toBe(layout.positions.get("A-1")?.x);
  });
});

// ─── computeDependencyLayout ──────────────────────────────────────────────────

function depNode(
  overrides: Partial<DependencyNode> & { id: string },
): DependencyNode {
  return {
    id: overrides.id,
    title: overrides.title ?? overrides.id,
    status: overrides.status ?? "pending",
    branch: overrides.branch ?? null,
    dependsOn: overrides.dependsOn ?? [],
  };
}

describe("computeDependencyLayout", () => {
  test("simple linear chain: each node gets increasing depth and distinct x, same y", () => {
    const a = depNode({ id: "TASK-A" });
    const b = depNode({ id: "TASK-B", dependsOn: ["TASK-A"] });
    const c = depNode({ id: "TASK-C", dependsOn: ["TASK-B"] });
    const layout = computeDependencyLayout([a, b, c]);

    const posA = layout.positions.get("TASK-A");
    const posB = layout.positions.get("TASK-B");
    const posC = layout.positions.get("TASK-C");
    expect(posA).toBeDefined();
    expect(posB).toBeDefined();
    expect(posC).toBeDefined();

    // Exact numbers, locking in the mockup's measured spacing:
    // margin=40, card=220, columnGap=100 -> pitch=320
    expect(posA).toEqual({ x: 40, y: 40, depth: 0 });
    expect(posB).toEqual({ x: 360, y: 40, depth: 1 });
    expect(posC).toEqual({ x: 680, y: 40, depth: 2 });

    // Distinct x per depth, same y (single row per column).
    expect(posA?.x).not.toBe(posB?.x);
    expect(posB?.x).not.toBe(posC?.x);
    expect(posA?.y).toBe(posB?.y);
    expect(posB?.y).toBe(posC?.y);
  });

  test("fan-out: root at depth 0, children at depth 1 with distinct rows", () => {
    const root = depNode({ id: "TASK-ROOT" });
    const child1 = depNode({ id: "TASK-CHILD-1", dependsOn: ["TASK-ROOT"] });
    const child2 = depNode({ id: "TASK-CHILD-2", dependsOn: ["TASK-ROOT"] });
    const layout = computeDependencyLayout([root, child1, child2]);

    expect(layout.positions.get("TASK-ROOT")?.depth).toBe(0);
    expect(layout.positions.get("TASK-CHILD-1")?.depth).toBe(1);
    expect(layout.positions.get("TASK-CHILD-2")?.depth).toBe(1);

    // Children share a column (same x) but get distinct rows (different y).
    const child1Pos = layout.positions.get("TASK-CHILD-1");
    const child2Pos = layout.positions.get("TASK-CHILD-2");
    expect(child1Pos?.x).toBe(child2Pos?.x);
    expect(child1Pos?.y).not.toBe(child2Pos?.y);
  });

  test("fan-in: child depth is 1 + max(parents' depths) — longest path, not shortest", () => {
    // shallow -> mid -> deep, and a separate shallow-parent directly into child.
    const shallow = depNode({ id: "TASK-SHALLOW" });
    const mid = depNode({ id: "TASK-MID", dependsOn: ["TASK-SHALLOW"] });
    const deep = depNode({ id: "TASK-DEEP", dependsOn: ["TASK-MID"] });
    const child = depNode({
      id: "TASK-CHILD",
      dependsOn: ["TASK-SHALLOW", "TASK-DEEP"],
    });
    const layout = computeDependencyLayout([shallow, mid, deep, child]);

    expect(layout.positions.get("TASK-SHALLOW")?.depth).toBe(0);
    expect(layout.positions.get("TASK-MID")?.depth).toBe(1);
    expect(layout.positions.get("TASK-DEEP")?.depth).toBe(2);
    // child depends on shallow (depth 0) and deep (depth 2) -> longest path wins: 1+2=3
    expect(layout.positions.get("TASK-CHILD")?.depth).toBe(3);
  });

  test("cycle safety: mutual dependency doesn't hang and both nodes get positions", () => {
    const x = depNode({ id: "TASK-X", dependsOn: ["TASK-Y"] });
    const y = depNode({ id: "TASK-Y", dependsOn: ["TASK-X"] });
    const layout = computeDependencyLayout([x, y]);

    const posX = layout.positions.get("TASK-X");
    const posY = layout.positions.get("TASK-Y");
    expect(posX).toBeDefined();
    expect(posY).toBeDefined();
    expect(Number.isFinite(posX?.x)).toBe(true);
    expect(Number.isFinite(posX?.y)).toBe(true);
    expect(Number.isFinite(posX?.depth)).toBe(true);
    expect(Number.isFinite(posY?.x)).toBe(true);
    expect(Number.isFinite(posY?.y)).toBe(true);
    expect(Number.isFinite(posY?.depth)).toBe(true);
  });

  test("deterministic ordering: same input twice yields identical layout", () => {
    const a = depNode({ id: "TASK-A" });
    const b = depNode({ id: "TASK-B", dependsOn: ["TASK-A"] });
    const c = depNode({ id: "TASK-C", dependsOn: ["TASK-A"] });
    const nodes = [a, b, c];

    const layout1 = computeDependencyLayout(nodes);
    const layout2 = computeDependencyLayout(nodes);

    expect(layout1.width).toBe(layout2.width);
    expect(layout1.height).toBe(layout2.height);
    for (const id of ["TASK-A", "TASK-B", "TASK-C"]) {
      expect(layout1.positions.get(id)).toEqual(layout2.positions.get(id));
    }
  });

  test("deterministic row ordering for same-depth nodes with no dependency relationship follows input order", () => {
    // Two independent roots, no edges between them.
    const rootFirst = depNode({ id: "TASK-FIRST" });
    const rootSecond = depNode({ id: "TASK-SECOND" });
    const layout = computeDependencyLayout([rootFirst, rootSecond]);

    const firstPos = layout.positions.get("TASK-FIRST");
    const secondPos = layout.positions.get("TASK-SECOND");
    expect(firstPos?.depth).toBe(0);
    expect(secondPos?.depth).toBe(0);
    // Same column.
    expect(firstPos?.x).toBe(secondPos?.x);
    // Row order follows input array order: first node gets the earlier row.
    expect(firstPos?.y).toBeLessThan(secondPos?.y ?? Number.POSITIVE_INFINITY);
  });

  test("empty input returns empty positions and zeroed canvas size", () => {
    const layout = computeDependencyLayout([]);
    expect(layout.positions.size).toBe(0);
    expect(layout.width).toBe(0);
    expect(layout.height).toBe(0);
  });
});

// ─── resolveAgentNameFilterAndPaginate (SLF-1.1) ────────────────────────────
//
// Extracted from the Tasks page route's inline agentFilterIds block so the
// Sessions page route can share the exact same resolve → widen-fetch →
// filter → recompute-total → re-slice flow. These unit tests cover the
// helper directly (pure logic, injected fetchPage/searchByName/matches — no
// I/O), confirming behavior is unchanged after the extraction from
// admin-ui.ts's Tasks page agent filter (still covered end-to-end by
// admin-ui.smoke.test.ts's "GET /admin/tasks?agent= filters by agent name").

interface FakeItem {
  id: string;
  ownerAgentId: string | null;
}

describe("resolveAgentNameFilterAndPaginate", () => {
  test("passthrough: no agentName runs fetchPage once at the caller's own limit/offset, filterActive false", async () => {
    const fetchPageCalls: Array<{ limit: number; offset: number }> = [];
    const result = await resolveAgentNameFilterAndPaginate<FakeItem>({
      agentName: undefined,
      searchByName: async () => {
        throw new Error("searchByName must not be called with no agentName");
      },
      limit: 10,
      offset: 20,
      matches: () => true,
      fetchPage: async (limit, offset) => {
        fetchPageCalls.push({ limit, offset });
        return {
          items: [{ id: "t1", ownerAgentId: "agent-a" }],
          total: 42,
        };
      },
    });

    expect(fetchPageCalls).toEqual([{ limit: 10, offset: 20 }]);
    expect(result).toEqual({
      items: [{ id: "t1", ownerAgentId: "agent-a" }],
      total: 42,
      filterActive: false,
    });
  });

  test("resolves the name to matching ids (OR semantics across multiple matches), widens the fetch, and re-paginates the filtered set", async () => {
    const allItems: FakeItem[] = [
      { id: "t1", ownerAgentId: "agent-a" },
      { id: "t2", ownerAgentId: "agent-b" },
      { id: "t3", ownerAgentId: "agent-c" },
      { id: "t4", ownerAgentId: null },
    ];
    const fetchPageCalls: Array<{ limit: number; offset: number }> = [];

    const result = await resolveAgentNameFilterAndPaginate<FakeItem>({
      agentName: "ag",
      searchByName: async (name) => {
        expect(name).toBe("ag");
        // Fuzzy match hits two agents — OR semantics means items owned by
        // either should survive the filter.
        return [{ id: "agent-a" }, { id: "agent-b" }];
      },
      limit: 1,
      offset: 1,
      matches: (item, ids) =>
        item.ownerAgentId !== null && ids.has(item.ownerAgentId),
      fetchPage: async (limit, offset) => {
        fetchPageCalls.push({ limit, offset });
        return { items: allItems, total: allItems.length };
      },
    });

    // Widened to the shared 500/0 page instead of the caller's own limit/offset.
    expect(fetchPageCalls).toEqual([{ limit: 500, offset: 0 }]);
    // Two of the four items match (t1, t2); total is recomputed from the
    // filtered set, not the upstream total (4).
    expect(result.total).toBe(2);
    expect(result.filterActive).toBe(true);
    // offset 1, limit 1 over the filtered [t1, t2] set slices to just t2.
    expect(result.items).toEqual([{ id: "t2", ownerAgentId: "agent-b" }]);
  });

  test("a name with zero matches returns an empty, non-erroring result rather than an unfiltered list", async () => {
    const allItems: FakeItem[] = [
      { id: "t1", ownerAgentId: "agent-a" },
      { id: "t2", ownerAgentId: "agent-b" },
    ];

    const result = await resolveAgentNameFilterAndPaginate<FakeItem>({
      agentName: "no-such-agent",
      searchByName: async () => [],
      limit: 50,
      offset: 0,
      matches: (item, ids) =>
        item.ownerAgentId !== null && ids.has(item.ownerAgentId),
      fetchPage: async () => ({ items: allItems, total: allItems.length }),
    });

    expect(result).toEqual({ items: [], total: 0, filterActive: true });
  });
});
// ─── Drawer/scrim z-index vs sticky toolbar (DNZ-1.1) ─────────────────────────
//
// Drawers and their scrims must render above the sticky toolbar (z-index: 100)
// so they're never obscured by the sticky top nav. Each drawer's scrim should
// render below the drawer itself (z-index: scrim < drawer), but both must be
// above the toolbar (z-index > 100). Toolbar z-index is 100 per lib/web/toolbar.ts.

describe("drawer z-index above sticky toolbar (DNZ-1.1)", () => {
  const TOOLBAR_ZINDEX = 100;

  test("task drawer and scrim z-indexes are above toolbar (> 100) with scrim < drawer", () => {
    const html = renderTasksPage(
      [TASK_ITEM],
      {},
      false,
      USER_NAME,
      {},
      { total: 1, limit: 50, page: 1 },
    );

    const scrimMatch = html.match(/\.task-drawer-scrim\s*\{[^}]*z-index:(\d+)/);
    const drawerMatch = html.match(/\.task-drawer\s*\{[^}]*z-index:(\d+)/);

    expect(scrimMatch).not.toBeNull();
    expect(drawerMatch).not.toBeNull();

    const scrimZIndex = scrimMatch ? Number.parseInt(scrimMatch[1], 10) : 0;
    const drawerZIndex = drawerMatch ? Number.parseInt(drawerMatch[1], 10) : 0;

    expect(scrimZIndex).toBeGreaterThan(TOOLBAR_ZINDEX);
    expect(drawerZIndex).toBeGreaterThan(TOOLBAR_ZINDEX);
    expect(scrimZIndex).toBeLessThan(drawerZIndex);
  });
});

// ─── All page renderers — shared head via renderAdminPage (CFB-1.2) ─────────
//
// The coding pages' share of the CFB-1.2 loop (the platform pages' share lives
// in admin-ui-pages.unit.test.ts): each render site builds its head via
// renderAdminPage(), so each output has exactly one DOCTYPE and one viewport
// meta tag.

describe("all page renderers — single DOCTYPE and viewport meta (CFB-1.2)", () => {
  const MINIMAL_TASK: TaskItem = {
    id: "TASK-LOOP-1",
    title: "Loop test task",
    status: "pending",
    session: null,
    repo: null,
    assignee: null,
    claimedBy: null,
  };

  const MINIMAL_PR: PrListItem = {
    id: "pr-loop-1",
    repo: "org/repo",
    prNumber: 1,
    staged: false,
    state: "open",
    reviewState: "pending",
    commitSha: null,
    patchCycles: 0,
    reviewCycles: 0,
    agentId: null,
    claimedBy: null,
    reviewedAt: null,
    patchedAt: null,
    mergedAt: null,
    claimedAt: null,
    heartbeatAt: null,
    createdAt: "2026-06-01T09:00:00Z",
    updatedAt: "2026-06-01T09:00:00Z",
  };

  const renderers: Array<[string, () => string]> = [
    [
      "renderTasksPage",
      () =>
        renderTasksPage(
          [MINIMAL_TASK],
          {},
          false,
          USER_NAME,
          {},
          { total: 1, limit: 50, page: 1 },
        ),
    ],
    [
      "renderTaskDetailPage",
      () => renderTaskDetailPage(MINIMAL_TASK, USER_NAME),
    ],
    [
      "renderSessionDetailPage",
      () =>
        renderSessionDetailPage("session-loop-1", [MINIMAL_TASK], USER_NAME),
    ],
    [
      "renderPrsPage",
      () =>
        renderPrsPage(
          [MINIMAL_PR],
          {},
          false,
          USER_NAME,
          {},
          { total: 1, limit: 50, page: 1 },
        ),
    ],
    ["renderPrDetailPage", () => renderPrDetailPage(MINIMAL_PR, USER_NAME)],
    [
      "renderQueueActivityPage",
      () =>
        renderQueueActivityPage({
          agent: { id: "agent-123", name: "Test Agent" },
          snapshot: null,
          crons: [],
          runs: [],
          filters: {},
          pagination: { total: 0, limit: 50, page: 1 },
          userName: USER_NAME,
        }),
    ],
  ];

  test("all 6 render sites are covered by this loop", () => {
    expect(renderers.length).toBe(6);
  });

  for (const [name, render] of renderers) {
    test(`${name}: exactly one DOCTYPE and one viewport meta tag`, () => {
      const html = render();
      const doctypeMatches = html.match(/<!DOCTYPE html>/g) ?? [];
      const viewportMatches = html.match(/<meta name="viewport"/g) ?? [];
      expect(doctypeMatches.length).toBe(1);
      expect(viewportMatches.length).toBe(1);
      expect(html).toContain(
        'content="width=device-width, initial-scale=1, viewport-fit=cover"',
      );
    });
  }
});
