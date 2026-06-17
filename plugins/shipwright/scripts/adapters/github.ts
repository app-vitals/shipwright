/**
 * plugins/shipwright/scripts/adapters/github.ts
 *
 * TaskStore implementation backed by GitHub Issues via the gh CLI.
 *
 * Status lifecycle: a fixed set of "status:*" labels — only one is present
 * on an issue at a time. Setup creates the labels; update swaps them atomically.
 *
 * Task metadata is stored in a ```shipwright JSON fenced block in the issue body.
 * Status is authoritative from the label (not the body block).
 *
 * GH_CMD env var is used for the gh executable — inject a fake command for tests.
 */

import { resolveReadyTasks } from "../store.ts";
import type {
  QueryFilters,
  Task,
  TaskStatus,
  TaskStore,
  TaskStoreConfig,
} from "../store.ts";
import { resolveRepos } from "../check-helpers.ts";
import { warnMissingFields } from "./validation.ts";

// ─── Constants ────────────────────────────────────────────────────────────────

const STATUS_LABEL_PREFIX = "status:";

const ALL_STATUS_VALUES: TaskStatus[] = [
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
];

const TERMINAL_STATUSES = new Set<string>([
  "merged",
  "done",
  "deployed",
  "cancelled",
]);

// ─── Types ────────────────────────────────────────────────────────────────────

interface GhLabel {
  name: string;
}

interface GhMilestone {
  title: string;
  number: number;
}

interface GhAssignee {
  login: string;
}

interface GhIssue {
  number: number;
  title: string;
  state: string;
  body: string;
  labels: GhLabel[];
  url: string;
  milestone: GhMilestone | null;
  assignees: GhAssignee[];
}

// Internal task with issue number attached for writes
interface TaskWithMeta extends Task {
  _issueNumber?: number;
  _labelStatus?: TaskStatus; // status label actually present on the issue, if any
}

// ─── Body parsing / building ──────────────────────────────────────────────────

function buildIssueBody(task: Task): string {
  const description = task.description ?? "";
  const criteria = task.acceptanceCriteria ?? [];

  // All fields go in the block — including description and acceptanceCriteria
  // so they survive the read-back round-trip via parseIssueBody.
  const meta: Record<string, unknown> = { ...task };

  const lines: string[] = [description, ""];
  if (criteria.length > 0) {
    lines.push("## Acceptance Criteria");
    for (const criterion of criteria) {
      lines.push(`- [ ] ${criterion}`);
    }
    lines.push("");
  }
  lines.push("```shipwright");
  lines.push(JSON.stringify(meta, null, 2));
  lines.push("```");
  return lines.join("\n");
}

function parseIssueBody(body: string): Record<string, unknown> | null {
  const match = /```shipwright\n([\s\S]*?)```/.exec(body);
  if (!match) return null;
  try {
    return JSON.parse(match[1]) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function getIssueStatus(labels: GhLabel[]): TaskStatus | undefined {
  for (const label of labels) {
    if (label.name.startsWith(STATUS_LABEL_PREFIX)) {
      return label.name.slice(STATUS_LABEL_PREFIX.length) as TaskStatus;
    }
  }
  return undefined;
}

function issueToTask(issue: GhIssue): TaskWithMeta {
  const bodyMeta = parseIssueBody(issue.body) ?? {};

  // Start with defaults, then overlay body metadata (body metadata wins over defaults)
  const task: TaskWithMeta = {
    id: "",
    title: issue.title,
    status: "pending",
    ...(bodyMeta as Partial<Task>),
  };

  // Status is authoritative from the label — override whatever the block says
  const labelStatus = getIssueStatus(issue.labels);
  if (labelStatus !== undefined) {
    task.status = labelStatus;
    task._labelStatus = labelStatus;
  }

  // Fall back to GitHub issue assignee when not set in the YAML block
  if (task.assignee === undefined && issue.assignees?.[0]) {
    task.assignee = issue.assignees[0].login;
  }

  // Attach issue number for internal use
  task._issueNumber = issue.number;

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

// ─── GitHubTaskStore ──────────────────────────────────────────────────────────

export class GitHubTaskStore implements TaskStore {
  private readonly config: TaskStoreConfig;
  private readonly warn: (msg: string) => void;

  constructor(config: TaskStoreConfig, warn?: (msg: string) => void) {
    this.config = config;
    this.warn = warn ?? console.warn;
  }

  // ── Internal helpers ──────────────────────────────────────────────────────

  private get ghCmd(): string {
    return process.env.GH_CMD ?? "gh";
  }

  private get repoFlag(): string {
    const g = this.config.github;
    if (!g) throw new Error("github config is required for GitHubTaskStore");
    return `${g.owner}/${g.repo}`;
  }

  private async runGh(args: string[]): Promise<string> {
    const proc = Bun.spawn([this.ghCmd, ...args], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      throw new Error(
        `gh command failed (exit ${exitCode}): ${[this.ghCmd, ...args].join(" ")}\n${stderr}`,
      );
    }
    return stdout.trim();
  }

  private async resolveCurrentGhUser(): Promise<string | undefined> {
    try {
      const login = await this.runGh(["api", "user", "--jq", ".login"]);
      return login || undefined;
    } catch {
      return undefined;
    }
  }

  private async ensureMilestone(session: string): Promise<void> {
    const g = this.config.github;
    if (!g) return;
    const raw = await this.runGh([
      "api",
      `repos/${g.owner}/${g.repo}/milestones?per_page=100`,
    ]);
    const existing = JSON.parse(raw) as Array<{ title: string }>;
    if (!existing.some((m) => m.title === session)) {
      await this.runGh([
        "api",
        "--method",
        "POST",
        `repos/${g.owner}/${g.repo}/milestones`,
        "-f",
        `title=${session}`,
      ]);
    }
  }

  private async fetchAllIssues(): Promise<GhIssue[]> {
    const raw = await this.runGh([
      "issue",
      "list",
      "--repo",
      this.repoFlag,
      "--state",
      "all",
      "--json",
      "number,title,body,labels,state,url,milestone,assignees",
      "--limit",
      "500",
    ]);
    const all = JSON.parse(raw) as GhIssue[];
    // Filter to only shipwright-managed issues (have a status:* label)
    return all.filter((issue) =>
      issue.labels.some((lbl) => lbl.name.startsWith(STATUS_LABEL_PREFIX)),
    );
  }

  // ── TaskStore interface ───────────────────────────────────────────────────

  private async isPrMerged(prNumber: number): Promise<boolean> {
    try {
      const output = await this.runGh([
        "pr",
        "view",
        String(prNumber),
        "--repo",
        this.repoFlag,
        "--json",
        "mergedAt",
        "--jq",
        ".mergedAt",
      ]);
      return output.trim() !== "" && output.trim() !== "null";
    } catch (e) {
      process.stderr.write(
        `warn: isPrMerged(${prNumber}) failed: ${String(e)}\n`,
      );
      return false;
    }
  }

  async query(filters: QueryFilters): Promise<Task[]> {
    const issues = await this.fetchAllIssues();
    const tasksWithMeta = issues.map((issue) => issueToTask(issue));

    if (filters.ready) {
      const plainTasks = tasksWithMeta.map((t) => t as Task);
      // Resolve readiness against the full task list so cross-session dependencies satisfy
      // correctly, then filter the output by session when --session is also provided.
      const ready = await resolveReadyTasks(plainTasks, (prNumber) =>
        this.isPrMerged(prNumber),
      );
      const readyIds = new Set(ready.map((t) => t.id));
      let result = tasksWithMeta.filter((t) => readyIds.has(t.id));
      if (filters.session !== undefined) {
        result = result.filter((t) => t.session === filters.session);
      }
      if (filters.assignee !== undefined) {
        // Unassigned tasks (no assignee field) are available to any agent.
        // Only exclude tasks explicitly assigned to a different agent.
        result = result.filter(
          (t) => t.assignee === undefined || t.assignee === filters.assignee,
        );
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
      // Strict equality here is intentional: the non-ready path is a general
      // query (list/filter), not a "claim next task" lookup, so unassigned tasks
      // are NOT implicitly available to every agent the way they are in the
      // ready path above.
      tasks = tasks.filter((t) => t.assignee === filters.assignee);
    }

    return tasks.map(stripInternal);
  }

  async append(tasks: Task[]): Promise<{ inserted: number; updated: number }> {
    const issues = await this.fetchAllIssues();
    const existingIds = new Set<string>();
    for (const issue of issues) {
      const task = issueToTask(issue);
      if (task.id) existingIds.add(task.id);
    }

    let inserted = 0;
    const updated = 0;
    const currentUser = await this.resolveCurrentGhUser();
    const ensuredMilestones = new Set<string>();

    for (const task of tasks) {
      if (!task.id) {
        continue;
      }
      if (existingIds.has(task.id)) {
        // Insert-only: existing issues are never updated. This intentionally diverges
        // from the TaskStore upsert contract — GitHub issues are the source of truth
        // once created. Use update() for targeted field changes on existing tasks.
        continue;
      }

      const assignee = task.assignee ?? currentUser;
      const body = buildIssueBody(task);
      const title = `${task.id}: ${task.title}`;
      const statusLabel = `${STATUS_LABEL_PREFIX}${task.status ?? "pending"}`;

      if (task.session) {
        await this.runGh([
          "label",
          "create",
          `session:${task.session}`,
          "--repo",
          this.repoFlag,
          "--force",
        ]);
        if (!ensuredMilestones.has(task.session)) {
          await this.ensureMilestone(task.session);
          ensuredMilestones.add(task.session);
        }
      }

      const createArgs = [
        "issue",
        "create",
        "--repo",
        this.repoFlag,
        "--title",
        title,
        "--body",
        body,
        "--label",
        statusLabel,
      ];

      if (task.session) {
        createArgs.push("--label", `session:${task.session}`);
        createArgs.push("--milestone", task.session);
      }

      if (assignee) {
        createArgs.push("--assignee", assignee);
      }

      await this.runGh(createArgs);
      inserted++;
    }

    return { inserted, updated };
  }

  async update(id: string, fields: Partial<Task>): Promise<Task> {
    const issues = await this.fetchAllIssues();

    let targetTask: TaskWithMeta | undefined;
    for (const issue of issues) {
      const task = issueToTask(issue);
      if (task.id === id) {
        targetTask = task;
        break;
      }
    }

    if (!targetTask) {
      throw new Error(`task not found: ${id}`);
    }

    const issueNumber = targetTask._issueNumber;
    const oldStatus = targetTask.status;

    // Separate status from non-status fields
    const { status: newStatus, ...nonStatusFields } = fields;

    // Apply non-status fields to the task
    Object.assign(targetTask, nonStatusFields);

    warnMissingFields(
      oldStatus,
      newStatus,
      newStatus !== undefined
        ? { ...targetTask, status: newStatus }
        : targetTask,
      this.warn,
    );

    // Update body if there are non-status fields to write
    if (Object.keys(nonStatusFields).length > 0 && issueNumber !== undefined) {
      const newBody = buildIssueBody(stripInternal(targetTask));
      await this.runGh([
        "issue",
        "edit",
        String(issueNumber),
        "--repo",
        this.repoFlag,
        "--body",
        newBody,
      ]);
    }

    // Write status LAST — swap labels
    if (newStatus !== undefined && issueNumber !== undefined) {
      targetTask.status = newStatus;
      const newLabel = `${STATUS_LABEL_PREFIX}${newStatus}`;
      const editArgs = [
        "issue",
        "edit",
        String(issueNumber),
        "--repo",
        this.repoFlag,
        "--add-label",
        newLabel,
      ];
      // Only remove the old label if it was actually present on the issue AND
      // differs from the one we're adding. Two failure modes otherwise:
      //   1. _labelStatus === undefined: removing a label that isn't there makes
      //      gh error, leaving the issue with no status label.
      //   2. _labelStatus === newStatus (re-applying the current status): a single
      //      `gh issue edit --add-label X --remove-label X` nets to a REMOVAL, so
      //      the issue ends up with no status label.
      // Either way the issue becomes invisible to fetchAllIssues (orphaned) and can
      // only be recovered by manually re-adding the label.
      if (
        targetTask._labelStatus !== undefined &&
        targetTask._labelStatus !== newStatus
      ) {
        editArgs.push(
          "--remove-label",
          `${STATUS_LABEL_PREFIX}${targetTask._labelStatus}`,
        );
      }
      await this.runGh(editArgs);

      if (TERMINAL_STATUSES.has(newStatus)) {
        await this.runGh([
          "issue",
          "close",
          String(issueNumber),
          "--repo",
          this.repoFlag,
        ]);
      }
    }

    return stripInternal(targetTask);
  }

  private async fetchOpenPlanIssues(): Promise<
    Array<{ number: number; title: string }>
  > {
    const raw = await this.runGh([
      "issue",
      "list",
      "--repo",
      this.repoFlag,
      "--state",
      "open",
      "--search",
      "[plan] in:title",
      "--json",
      "number,title",
      "--limit",
      "100",
    ]);
    return JSON.parse(raw) as Array<{ number: number; title: string }>;
  }

  private async fetchEmptyOpenMilestones(): Promise<
    Array<{ number: number; title: string }>
  > {
    const g = this.config.github;
    if (!g) return [];

    const raw = await this.runGh([
      "api",
      `repos/${g.owner}/${g.repo}/milestones?per_page=100`,
    ]);

    const milestones = JSON.parse(raw) as Array<{
      number: number;
      title: string;
      state: string;
      open_issues: number;
    }>;

    return milestones.filter((m) => m.state === "open" && m.open_issues === 0);
  }

  async cleanup(): Promise<{
    closed: number;
    milestonesClosed: number;
    plansClosed: number;
  }> {
    const issues = await this.fetchAllIssues();
    const tasks = issues.map(issueToTask);
    let closed = 0;

    for (const issue of issues) {
      if (issue.state !== "OPEN") continue;
      const status = getIssueStatus(issue.labels);
      if (status === undefined || !TERMINAL_STATUSES.has(status)) continue;

      await this.runGh([
        "issue",
        "close",
        String(issue.number),
        "--repo",
        this.repoFlag,
      ]);
      closed++;
    }

    // Close plan issues whose sessions are fully terminal.
    let plansClosed = 0;
    try {
      const planIssues = await this.fetchOpenPlanIssues();
      for (const planIssue of planIssues) {
        const session = planIssue.title.replace(/^\[plan\]\s*/i, "").trim();
        if (!session) continue;

        const sessionTasks = tasks.filter((t) => t.session === session);
        if (sessionTasks.length === 0) continue;

        const allTerminal = sessionTasks.every((t) =>
          TERMINAL_STATUSES.has(t.status),
        );
        if (!allTerminal) continue;

        await this.runGh([
          "issue",
          "close",
          String(planIssue.number),
          "--repo",
          this.repoFlag,
        ]);
        plansClosed++;
      }
    } catch (e) {
      this.warn(`[shipwright] cleanup: plan issue sweep failed: ${String(e)}`);
    }

    const emptyMilestones = await this.fetchEmptyOpenMilestones();
    const g = this.config.github;
    if (g) {
      for (const milestone of emptyMilestones) {
        await this.runGh([
          "api",
          "--method",
          "PATCH",
          `repos/${g.owner}/${g.repo}/milestones/${milestone.number}`,
          "-f",
          "state=closed",
        ]);
      }
    }

    return { closed, milestonesClosed: emptyMilestones.length, plansClosed };
  }

  async setup(): Promise<void> {
    if (!this.config.github) {
      throw new Error("github config (owner, repo) is required for setup");
    }
    for (const status of ALL_STATUS_VALUES) {
      const label = `${STATUS_LABEL_PREFIX}${status}`;
      await this.runGh([
        "label",
        "create",
        label,
        "--repo",
        this.repoFlag,
        "--force",
      ]);
    }
  }

  async resolveRepo(): Promise<string> {
    const g = this.config.github;
    if (!g?.owner || !g?.repo) {
      throw new Error(
        "github.owner and github.repo must be set in TaskStoreConfig to resolve repo",
      );
    }
    return `${g.owner}/${g.repo}`;
  }

  async resolveRepos(): Promise<string[]> {
    const g = this.config.github;
    if (!g?.owner || !g?.repo) return [];
    const primary = `${g.owner}/${g.repo}`;
    const scanned = resolveRepos(process.cwd());
    return [primary, ...scanned.filter((r) => r !== primary)];
  }
}
