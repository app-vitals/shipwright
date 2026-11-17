/**
 * scripts/register-planning-sessions.ts
 *
 * Operator script (PLU-6.1): walk `planning/*\/` in a checkout and register
 * every standard planning file with the task store. All rules live in the
 * shared module `plugins/shipwright/scripts/register-planning-documents.ts`
 * (PLU-3.1) — this file only supplies an HTTP `PlanningStoreClient`, prints a
 * report and wires the CLI. Re-runnable: an unchanged tree makes zero creates
 * and zero updates. Owner is never set. Non-standard files are reported only.
 *
 * Usage: bun scripts/register-planning-sessions.ts [--dry-run] [--root <dir>] [--repo <org/repo>]
 * Env:   SHIPWRIGHT_TASK_STORE_URL, SHIPWRIGHT_TASK_STORE_TOKEN
 */

import { resolve } from "node:path";
import type { Clock } from "../plugins/shipwright/scripts/clock.ts";
import {
  localContentSource,
  type PlanDocumentRow,
  type PlanningStoreClient,
  type RegisterDocumentInput,
  type RegistrationResult,
  registerPlanningSessions,
  type TaskRow,
} from "../plugins/shipwright/scripts/register-planning-documents.ts";

const TASK_PAGE_SIZE = 50;

export interface HttpPlanningStoreClientOptions {
  baseUrl: string;
  token: string;
  fetch?: typeof fetch;
}

/** `PlanningStoreClient` over the task store HTTP API. */
export class HttpPlanningStoreClient implements PlanningStoreClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchFn: typeof fetch;

  constructor(opts: HttpPlanningStoreClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.token = opts.token;
    this.fetchFn = opts.fetch ?? fetch;
  }

  private async call<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const res = await this.fetchFn(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        "content-type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`${method} ${path} -> ${res.status} ${text}`.trim());
    }
    return (await res.json()) as T;
  }

  async listDocuments(filter: { session: string }): Promise<PlanDocumentRow[]> {
    const r = await this.call<{ documents: PlanDocumentRow[] }>(
      "GET",
      `/documents?session=${encodeURIComponent(filter.session)}`,
    );
    return r.documents;
  }

  registerDocument(input: RegisterDocumentInput): Promise<PlanDocumentRow> {
    return this.call("POST", "/documents", input);
  }

  async patchDocument(id: string, patch: { plannedAt: string }): Promise<void> {
    await this.call("PATCH", `/documents/${encodeURIComponent(id)}`, patch);
  }

  async listTasks(filter: { source: string }): Promise<TaskRow[]> {
    const out: TaskRow[] = [];
    for (let offset = 0; ; offset += TASK_PAGE_SIZE) {
      const r = await this.call<{ tasks: TaskRow[]; total: number }>(
        "GET",
        `/tasks?source=${encodeURIComponent(filter.source)}&limit=${TASK_PAGE_SIZE}&offset=${offset}`,
      );
      out.push(...r.tasks);
      if (r.tasks.length === 0 || out.length >= r.total) return out;
    }
  }

  async patchTask(
    id: string,
    patch: { planDocumentId: string },
  ): Promise<void> {
    await this.call("PATCH", `/tasks/${encodeURIComponent(id)}`, patch);
  }
}

export interface RunRegistrationOptions {
  client: PlanningStoreClient;
  /** Checkout root containing `planning/`. */
  root: string;
  /** Home repo (org/repo). */
  repo: string;
  clock: Clock;
  dryRun?: boolean;
}

/** Walk the checkout's planning/ tree through the shared PLU-3.1 rules. */
export function runRegistration(
  opts: RunRegistrationOptions,
): Promise<RegistrationResult> {
  return registerPlanningSessions({
    client: opts.client,
    source: localContentSource(opts.root),
    repo: opts.repo,
    clock: opts.clock,
    dryRun: opts.dryRun,
  });
}

export function formatReport(r: RegistrationResult): string {
  const verb = r.dryRun ? "would be" : "were";
  const lines = [
    r.dryRun ? "Dry run: nothing was written." : "Registration complete.",
    `  documents created: ${r.created}`,
    `  documents updated: ${r.updated}`,
    `  tasks linked to a plan: ${r.linked}`,
    `  non-standard files reported (${r.reported.length}, never registered):`,
    ...r.reported.map((f) => `    ${f.path} — ${f.reason}`),
  ];
  if (r.errors.length > 0) {
    lines.push(`  errors (${r.errors.length}):`);
    for (const e of r.errors) lines.push(`    ${e}`);
  }
  lines.push(`  (changes above ${verb} applied)`);
  return lines.join("\n");
}

export interface CliArgs {
  dryRun: boolean;
  root: string;
  repo: string | null;
}

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { dryRun: false, root: process.cwd(), repo: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") args.dryRun = true;
    else if (a === "--root") args.root = resolve(argv[++i] ?? "");
    else if (a === "--repo") args.repo = argv[++i] ?? null;
    else throw new Error(`unknown argument: ${a}`);
  }
  return args;
}

/** `org/repo` from a git remote URL (https or ssh), or null. */
export function repoFromRemote(url: string): string | null {
  const m = /[:/]([^/:]+\/[^/]+?)(?:\.git)?\/?$/.exec(url.trim());
  return m?.[1] ?? null;
}

if (import.meta.main) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const url = process.env.SHIPWRIGHT_TASK_STORE_URL;
    const token = process.env.SHIPWRIGHT_TASK_STORE_TOKEN;
    if (!url || !token) {
      throw new Error(
        "SHIPWRIGHT_TASK_STORE_URL and SHIPWRIGHT_TASK_STORE_TOKEN must be set",
      );
    }
    let repo = args.repo;
    if (!repo) {
      const git = Bun.spawnSync(
        ["git", "-C", args.root, "remote", "get-url", "origin"],
        { stderr: "ignore" },
      );
      repo = git.exitCode === 0 ? repoFromRemote(git.stdout.toString()) : null;
    }
    if (!repo)
      throw new Error("cannot determine home repo; pass --repo org/repo");

    const result = await runRegistration({
      client: new HttpPlanningStoreClient({ baseUrl: url, token }),
      root: args.root,
      repo,
      clock: { now: () => new Date() },
      dryRun: args.dryRun,
    });
    console.log(formatReport(result));
    process.exit(result.errors.length > 0 ? 1 : 0);
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
