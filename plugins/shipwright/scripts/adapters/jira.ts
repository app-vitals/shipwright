/**
 * plugins/shipwright/scripts/adapters/jira.ts
 *
 * TaskStore implementation backed by the Jira REST API v3.
 *
 * Auth: HTTP Basic via JIRA_EMAIL + JIRA_API_TOKEN env vars.
 * fetchFn is injected via the constructor — no global.fetch usage.
 *
 * Task metadata is stored in a ```shipwright JSON fenced block inside
 * the Jira issue description (ADF codeBlock with language "shipwright"),
 * mirroring the pattern used by github.ts.
 *
 * Status mapping: Jira status names → Shipwright TaskStatus values.
 * Default map can be extended/overridden via config.jira.statusMap.
 */

import { resolveReadyTasks } from "../store.ts";
import type {
  QueryFilters,
  Task,
  TaskStatus,
  TaskStore,
  TaskStoreConfig,
} from "../store.ts";
import { warnMissingFields } from "./validation.ts";

// ─── Types ────────────────────────────────────────────────────────────────────

/** Minimal fetch signature used for dependency injection. */
type FetchFn = (url: string | URL | Request, init?: RequestInit) => Promise<Response>;

// ─── Constants ────────────────────────────────────────────────────────────────

const TERMINAL_STATUSES = new Set<string>([
  "merged",
  "done",
  "deployed",
  "cancelled",
]);

/**
 * Default mapping from Jira status names to Shipwright TaskStatus values.
 * Can be extended/overridden via config.jira.statusMap.
 */
const JIRA_STATUS_MAP: Record<string, TaskStatus> = {
  "To Do": "pending",
  Backlog: "pending",
  Open: "pending",
  "In Progress": "in_progress",
  "In Review": "pr_open",
  "PR Open": "pr_open",
  Done: "done",
  Closed: "done",
  Resolved: "done",
  Blocked: "blocked",
  "On Hold": "blocked",
  "Won't Do": "cancelled",
  Cancelled: "cancelled",
};

// ─── Jira API types ───────────────────────────────────────────────────────────

interface JiraIssue {
  id: string;
  key: string;
  fields: {
    summary: string;
    status: { name: string };
    description: JiraAdf | null;
  };
}

interface JiraAdf {
  type: string;
  version?: number;
  content?: JiraAdfNode[];
}

interface JiraAdfNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: JiraAdfNode[];
  text?: string;
}

interface JiraTransition {
  id: string;
  name: string;
}

// Internal task with issue key attached for writes
interface TaskWithMeta extends Task {
  _issueKey?: string;
}

// ─── ADF description helpers ──────────────────────────────────────────────────

/**
 * Build an ADF document with:
 *   - A paragraph with the description text (if any)
 *   - A codeBlock with language "shipwright" containing the task JSON
 */
function buildIssueDescription(task: Task): JiraAdf {
  const description = task.description ?? "";
  const meta: Record<string, unknown> = { ...task };
  const metaJson = JSON.stringify(meta, null, 2);

  const content: JiraAdfNode[] = [];

  if (description) {
    content.push({
      type: "paragraph",
      content: [{ type: "text", text: description }],
    });
  }

  content.push({
    type: "codeBlock",
    attrs: { language: "shipwright" },
    content: [{ type: "text", text: metaJson }],
  });

  return { type: "doc", version: 1, content };
}

/**
 * Extract the text inside the first "shipwright" codeBlock from an ADF node.
 * Returns null if not found.
 */
function extractShipwrightBlock(node: JiraAdfNode | null | undefined): string | null {
  if (!node) return null;

  if (
    node.type === "codeBlock" &&
    node.attrs?.language === "shipwright" &&
    node.content?.[0]?.text
  ) {
    return node.content[0].text;
  }

  for (const child of node.content ?? []) {
    const found = extractShipwrightBlock(child);
    if (found !== null) return found;
  }

  return null;
}

function parseIssueDescription(desc: JiraAdf | null): Record<string, unknown> | null {
  if (!desc) return null;
  const raw = extractShipwrightBlock(desc);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function issueToTask(issue: JiraIssue, statusMap: Record<string, TaskStatus>): TaskWithMeta {
  const bodyMeta = parseIssueDescription(issue.fields.description) ?? {};

  const jiraStatusName = issue.fields.status.name;
  const mappedStatus: TaskStatus = statusMap[jiraStatusName] ?? "pending";

  const task: TaskWithMeta = {
    id: "",
    title: issue.fields.summary,
    ...(bodyMeta as Partial<Task>),
    // Status from Jira is authoritative — override whatever the body says
    status: mappedStatus,
    _issueKey: issue.key,
  };

  return task;
}

function stripInternal(task: TaskWithMeta): Task {
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(task)) {
    if (!k.startsWith("_")) {
      result[k] = v;
    }
  }
  return result as unknown as Task;
}

// ─── JiraTaskStore ────────────────────────────────────────────────────────────

export class JiraTaskStore implements TaskStore {
  private readonly authHeader: string;
  private readonly effectiveStatusMap: Record<string, TaskStatus>;
  private readonly warn: (msg: string) => void;

  constructor(
    private readonly config: TaskStoreConfig,
    private readonly fetchFn: FetchFn,
    email?: string,
    apiToken?: string,
    warn?: (msg: string) => void,
  ) {
    const resolvedEmail = email ?? process.env.JIRA_EMAIL;
    const resolvedToken = apiToken ?? process.env.JIRA_API_TOKEN;

    if (!resolvedEmail || !resolvedToken) {
      throw new Error(
        "JIRA_EMAIL and JIRA_API_TOKEN environment variables are required",
      );
    }

    this.authHeader = `Basic ${Buffer.from(`${resolvedEmail}:${resolvedToken}`).toString("base64")}`;

    // Merge config statusMap over defaults
    const customMap = config.jira?.statusMap ?? {};
    this.effectiveStatusMap = {
      ...JIRA_STATUS_MAP,
      ...(customMap as Record<string, TaskStatus>),
    };

    this.warn = warn ?? console.warn;
  }

  // ── Internal helpers ──────────────────────────────────────────────────────

  private get baseUrl(): string {
    const url = this.config.jira?.baseUrl;
    if (!url) throw new Error("jira.baseUrl is required in TaskStoreConfig");
    return url.replace(/\/$/, "");
  }

  private get projectKey(): string {
    const key = this.config.jira?.projectKey;
    if (!key) throw new Error("jira.projectKey is required in TaskStoreConfig");
    return key;
  }

  private async jiraFetch(
    path: string,
    options: RequestInit = {},
  ): Promise<Response> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      Authorization: this.authHeader,
      "Content-Type": "application/json",
      Accept: "application/json",
      ...(options.headers as Record<string, string> | undefined),
    };
    return this.fetchFn(url, { ...options, headers });
  }

  private async fetchAllIssues(): Promise<JiraIssue[]> {
    const jql =
      this.config.jira?.readyJql ??
      `project = "${this.projectKey}" AND labels = "shipwright-session" ORDER BY created ASC`;

    const allIssues: JiraIssue[] = [];
    let startAt = 0;
    const maxResults = 100;

    for (;;) {
      const body = JSON.stringify({
        jql,
        startAt,
        maxResults,
        fields: ["summary", "status", "description"],
      });

      const res = await this.jiraFetch("/rest/api/3/issue/search", {
        method: "POST",
        body,
      });

      if (!res.ok) {
        const text = await res.text();
        throw new Error(
          `Jira issue search failed (${res.status}): ${text}`,
        );
      }

      const data = (await res.json()) as { issues: JiraIssue[]; total: number };
      allIssues.push(...data.issues);

      if (data.issues.length === 0) {
        break;
      }

      if (startAt + data.issues.length >= data.total) {
        break;
      }
      startAt += data.issues.length;
    }

    return allIssues;
  }

  private async getTransitions(issueKey: string): Promise<JiraTransition[]> {
    const res = await this.jiraFetch(
      `/rest/api/3/issue/${issueKey}/transitions`,
    );
    if (!res.ok) {
      throw new Error(
        `Failed to get transitions for ${issueKey} (${res.status})`,
      );
    }
    const data = (await res.json()) as { transitions: JiraTransition[] };
    return data.transitions;
  }

  private async performTransition(
    issueKey: string,
    targetJiraStatusName: string,
  ): Promise<void> {
    const transitions = await this.getTransitions(issueKey);
    const match = transitions.find(
      (t) => t.name.toLowerCase() === targetJiraStatusName.toLowerCase(),
    );

    if (!match) {
      this.warn(
        `[shipwright] no transition found for "${targetJiraStatusName}" on ${issueKey}`,
      );
      return;
    }

    const res = await this.jiraFetch(
      `/rest/api/3/issue/${issueKey}/transitions`,
      {
        method: "POST",
        body: JSON.stringify({ transition: { id: match.id } }),
      },
    );

    if (!res.ok && res.status !== 204) {
      const text = await res.text();
      throw new Error(
        `Failed to transition ${issueKey} to "${targetJiraStatusName}" (${res.status}): ${text}`,
      );
    }
  }

  /**
   * Map a Shipwright TaskStatus back to the most appropriate Jira status name.
   * Uses the reverse of the effectiveStatusMap (first match wins).
   */
  private shipwrightStatusToJira(status: TaskStatus): string {
    // Prefer exact reverse lookups in a defined priority order
    const preferredJiraNames: Partial<Record<TaskStatus, string>> = {
      pending: "To Do",
      in_progress: "In Progress",
      pr_open: "In Review",
      done: "Done",
      blocked: "Blocked",
      cancelled: "Cancelled",
      merged: "Done",
      deployed: "Done",
      deploying: "In Progress",
      approved: "In Review",
    };
    return preferredJiraNames[status] ?? "To Do";
  }

  private async addPrComment(
    issueKey: string,
    prUrl: string,
    prNumber?: number,
  ): Promise<void> {
    const prRef = prNumber ? `PR #${prNumber}` : "PR";
    const text = `${prRef}: ${prUrl}`;

    const body: JiraAdf = {
      type: "doc",
      version: 1,
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text }],
        },
      ],
    };

    const res = await this.jiraFetch(`/rest/api/3/issue/${issueKey}/comment`, {
      method: "POST",
      body: JSON.stringify({ body }),
    });

    if (!res.ok) {
      const responseText = await res.text();
      this.warn(
        `[shipwright] failed to add PR comment to ${issueKey} (${res.status}): ${responseText}`,
      );
    }
  }

  // ── TaskStore interface ───────────────────────────────────────────────────

  async query(filters: QueryFilters): Promise<Task[]> {
    const issues = await this.fetchAllIssues();
    const tasksWithMeta = issues.map((issue) =>
      issueToTask(issue, this.effectiveStatusMap),
    );

    if (filters.ready) {
      const plainTasks = tasksWithMeta.map((t) => t as Task);
      // Jira tasks don't use GitHub PR bundle semantics → isPrMerged always false
      const ready = await resolveReadyTasks(plainTasks, async () => false);
      const readyIds = new Set(ready.map((t) => t.id));
      let result = tasksWithMeta.filter((t) => readyIds.has(t.id));
      if (filters.session !== undefined) {
        result = result.filter((t) => t.session === filters.session);
      }
      if (filters.assignee !== undefined) {
        result = result.filter(
          (t) => t.assignee === undefined || t.assignee === filters.assignee,
        );
      }
      if (filters.branch !== undefined) {
        result = result.filter((t) => t.branch === filters.branch);
      }
      return result.map(stripInternal);
    }

    let tasks: TaskWithMeta[] = tasksWithMeta;

    if (filters.status !== undefined) {
      tasks = tasks.filter((t) => t.status === filters.status);
    }
    if (filters.session !== undefined) {
      tasks = tasks.filter((t) => t.session === filters.session);
    }
    if (filters.id !== undefined) {
      tasks = tasks.filter((t) => t.id === filters.id);
    }
    if (filters.pr !== undefined) {
      tasks = tasks.filter((t) => t.pr === filters.pr);
    }
    if (filters.assignee !== undefined) {
      tasks = tasks.filter((t) => t.assignee === filters.assignee);
    }
    if (filters.branch !== undefined) {
      tasks = tasks.filter((t) => t.branch === filters.branch);
    }

    return tasks.map(stripInternal);
  }

  async append(tasks: Task[]): Promise<{ inserted: number; updated: number }> {
    const issues = await this.fetchAllIssues();

    // Build a map from task id → existing TaskWithMeta for upsert lookups
    const existingByTaskId = new Map<string, TaskWithMeta>();
    for (const issue of issues) {
      const task = issueToTask(issue, this.effectiveStatusMap);
      if (task.id) existingByTaskId.set(task.id, task);
    }

    let inserted = 0;
    let updated = 0;

    for (const task of tasks) {
      if (!task.id) continue;

      const existing = existingByTaskId.get(task.id);

      if (existing) {
        // Upsert: merge incoming fields over existing task and rewrite the body.
        // Status transitions are intentionally skipped during append — append is
        // a metadata sync operation, not a status change. Use update() to drive
        // status transitions.
        const issueKey = existing._issueKey;
        if (!issueKey) {
          this.warn(
            `[shipwright] append: task ${task.id} exists but has no issue key — skipping update`,
          );
          continue;
        }

        const merged: TaskWithMeta = { ...existing, ...task, _issueKey: issueKey };
        const newDescription = buildIssueDescription(stripInternal(merged));
        const putRes = await this.jiraFetch(`/rest/api/3/issue/${issueKey}`, {
          method: "PUT",
          body: JSON.stringify({ fields: { description: newDescription } }),
        });
        if (!putRes.ok && putRes.status !== 204) {
          const text = await putRes.text();
          throw new Error(
            `Failed to update Jira issue ${issueKey} for task ${task.id} (${putRes.status}): ${text}`,
          );
        }
        updated++;
        continue;
      }

      const description = buildIssueDescription(task);
      const summary = `${task.id}: ${task.title}`;

      const issueBody = {
        fields: {
          project: { key: this.projectKey },
          summary,
          description,
          labels: ["shipwright-session"],
          issuetype: { name: "Task" },
        },
      };

      const res = await this.jiraFetch("/rest/api/3/issue", {
        method: "POST",
        body: JSON.stringify(issueBody),
      });

      if (!res.ok) {
        const text = await res.text();
        throw new Error(
          `Failed to create Jira issue for task ${task.id} (${res.status}): ${text}`,
        );
      }

      inserted++;
    }

    return { inserted, updated };
  }

  async update(id: string, fields: Partial<Task>): Promise<Task> {
    const issues = await this.fetchAllIssues();

    let targetTask: TaskWithMeta | undefined;
    for (const issue of issues) {
      const task = issueToTask(issue, this.effectiveStatusMap);
      if (task.id === id) {
        targetTask = task;
        break;
      }
    }

    if (!targetTask) {
      throw new Error(`task not found: ${id}`);
    }

    const issueKey = targetTask._issueKey;
    if (!issueKey) {
      throw new Error(`task ${id} has no associated Jira issue key`);
    }

    const oldStatus = targetTask.status;
    const { status: newStatus, ...nonStatusFields } = fields;

    // Apply non-status fields
    Object.assign(targetTask, nonStatusFields);

    warnMissingFields(
      oldStatus,
      newStatus,
      newStatus !== undefined ? { ...targetTask, status: newStatus } : targetTask,
      this.warn,
    );

    // Update issue body whenever any fields are changing (including status-only changes).
    // cleanup() treats the body block as the authoritative status record, so the body
    // must always reflect the latest status even when no other fields are being written.
    if (Object.keys(nonStatusFields).length > 0 || newStatus !== undefined) {
      if (newStatus !== undefined) {
        targetTask.status = newStatus;
      }
      const newDescription = buildIssueDescription(stripInternal(targetTask));
      const putRes = await this.jiraFetch(`/rest/api/3/issue/${issueKey}`, {
        method: "PUT",
        body: JSON.stringify({ fields: { description: newDescription } }),
      });
      if (!putRes.ok && putRes.status !== 204) {
        const text = await putRes.text();
        throw new Error(
          `Failed to update issue ${issueKey} (${putRes.status}): ${text}`,
        );
      }
    }

    // Perform status transition if status is changing
    if (newStatus !== undefined) {
      targetTask.status = newStatus;
      const jiraStatusName = this.shipwrightStatusToJira(newStatus);
      await this.performTransition(issueKey, jiraStatusName);
    }

    // Add PR comment if pr field is being set
    const prUrl = fields.prUrl ?? (targetTask.prUrl as string | undefined);
    const prNumber = fields.pr ?? targetTask.pr;
    if (fields.pr !== undefined || fields.prUrl !== undefined) {
      const commentUrl = prUrl ?? (prNumber ? String(prNumber) : undefined);
      if (commentUrl) {
        await this.addPrComment(issueKey, commentUrl, prNumber);
      }
    }

    return stripInternal(targetTask);
  }

  async setup(): Promise<void> {
    const key = this.projectKey;
    const res = await this.jiraFetch(`/rest/api/3/project/${key}`);

    if (res.status === 401 || res.status === 403) {
      throw new Error(
        `Jira auth failure (${res.status}): check JIRA_EMAIL and JIRA_API_TOKEN`,
      );
    }

    if (res.status === 404) {
      throw new Error(
        `Jira project not found: "${key}" — verify jira.projectKey in your config`,
      );
    }

    if (!res.ok) {
      const text = await res.text();
      throw new Error(
        `Jira setup failed (${res.status}): ${text}`,
      );
    }

    // Project exists — nothing else to provision for Jira
  }

  async resolveRepo(): Promise<string> {
    const key = this.config.jira?.projectKey;
    if (!key) {
      throw new Error(
        "jira.projectKey must be set in TaskStoreConfig to resolve repo",
      );
    }
    return key;
  }

  async resolveRepos(): Promise<string[]> {
    const key = this.config.jira?.projectKey;
    if (!key) return [];
    return [key];
  }

  async cleanup(): Promise<{
    closed: number;
    milestonesClosed: number;
    plansClosed: number;
  }> {
    const issues = await this.fetchAllIssues();
    let closed = 0;

    for (const issue of issues) {
      // Read the Shipwright status from the body metadata (not Jira status).
      // The body metadata is the authoritative record of where Shipwright left
      // this task — Jira's own status may be stale if a previous update failed.
      const bodyMeta = parseIssueDescription(issue.fields.description) ?? {};
      const shipwrightStatus = (bodyMeta.status as string | undefined) ?? "";

      if (!TERMINAL_STATUSES.has(shipwrightStatus)) continue;

      // If Jira already shows "Done" (or a mapped-done equivalent), skip.
      const currentJiraStatus = issue.fields.status.name;
      if (currentJiraStatus === "Done") continue;
      const currentMappedStatus = this.effectiveStatusMap[currentJiraStatus];
      if (currentMappedStatus === "done") continue;

      try {
        await this.performTransition(issue.key, "Done");
        closed++;
      } catch (e) {
        this.warn(
          `[shipwright] cleanup: failed to transition ${issue.key} to Done: ${String(e)}`,
        );
      }
    }

    return { closed, milestonesClosed: 0, plansClosed: 0 };
  }
}
