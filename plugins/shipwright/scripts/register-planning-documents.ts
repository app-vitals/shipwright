/**
 * plugins/shipwright/scripts/register-planning-documents.ts
 *
 * Shared planning-document registration rules (PLU-3.1). Implemented once so the
 * commands' lazy registration and the operator script cannot drift.
 *
 * Self-contained (no @app-vitals/* imports): the plugin installs standalone.
 * The task-store client and content sources are injected; time comes from a Clock.
 * Registration is additive bookkeeping: `registerPlanningSessions` never throws —
 * failures come back in `result.errors`.
 *
 * Rules (convention `planning/{session}/` only):
 *  - PLAN.md            -> plan 1
 *  - PRODUCT-SPEC.md    -> spec 1 (marked planned when the session has a plan)
 *  - SPEC-{NNNN}.md     -> spec NNNN (NNNN >= 1)
 *  - anything else      -> reported, never registered
 *  - the session's home repo is set (by the register call); owner is left empty
 *  - tasks whose `source` is the plan path gain `planDocumentId` and nothing else
 *  - idempotent: an unchanged tree makes zero creates and zero updates
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Clock } from "./clock";

// ─── Types ────────────────────────────────────────────────────────────────────

export type DocKind = "spec" | "plan";

export interface PlanDocumentRow {
  id: string;
  session: string;
  kind: DocKind;
  number: number;
  repo: string;
  path: string;
  title: string | null;
  plannedAt: string | null;
}

export interface RegisterDocumentInput {
  session: string;
  kind: DocKind;
  number: number;
  repo: string;
  path: string;
  title: string | null;
}

export interface TaskRow {
  id: string;
  source: string | null;
  planDocumentId: string | null;
}

/** Injected task-store client — the only network seam. */
export interface PlanningStoreClient {
  listDocuments(filter: { session: string }): Promise<PlanDocumentRow[]>;
  registerDocument(input: RegisterDocumentInput): Promise<PlanDocumentRow>;
  patchDocument(id: string, patch: { plannedAt: string }): Promise<void>;
  listTasks(filter: { source: string }): Promise<TaskRow[]>;
  patchTask(id: string, patch: { planDocumentId: string }): Promise<void>;
}

/** A place planning files can be read from (git ref or local checkout). */
export interface ContentSource {
  listSessions(): Promise<string[]>;
  /** File names (not paths) directly inside planning/{session}/. */
  listFiles(session: string): Promise<string[]>;
  /** File content, or null when this source does not have it. */
  read(path: string): Promise<string | null>;
}

export interface ReportedFile {
  path: string;
  reason: string;
}

export interface RegistrationResult {
  dryRun: boolean;
  created: number;
  updated: number;
  linked: number;
  reported: ReportedFile[];
  errors: string[];
}

// ─── Filename rules (pure) ────────────────────────────────────────────────────

export interface ClassifiedFile {
  kind: DocKind;
  number: number;
}

export function classifyPlanningFile(name: string): ClassifiedFile | null {
  if (name === "PLAN.md") return { kind: "plan", number: 1 };
  if (name === "PRODUCT-SPEC.md") return { kind: "spec", number: 1 };
  const m = /^SPEC-(\d{4})\.md$/.exec(name);
  if (m) {
    const number = Number(m[1]);
    if (number >= 1) return { kind: "spec", number };
  }
  return null;
}

/** First markdown H1, trimmed; null when absent. */
export function extractTitle(content: string | null): string | null {
  if (!content) return null;
  const m = /^#\s+(.+?)\s*$/m.exec(content);
  return m?.[1] ?? null;
}

// ─── Content sources ──────────────────────────────────────────────────────────

/** Local checkout: `{root}/planning/{session}/{file}`. */
export function localContentSource(root: string): ContentSource {
  const planning = join(root, "planning");
  return {
    async listSessions() {
      if (!existsSync(planning)) return [];
      return readdirSync(planning)
        .filter((n) => statSync(join(planning, n)).isDirectory())
        .sort();
    },
    async listFiles(session) {
      const dir = join(planning, session);
      if (!existsSync(dir)) return [];
      return readdirSync(dir)
        .filter((n) => statSync(join(dir, n)).isFile())
        .sort();
    },
    async read(path) {
      const full = join(root, path);
      return existsSync(full) ? readFileSync(full, "utf8") : null;
    },
  };
}

/** Git ref source (docs branch, default branch). `git` runs an injected command. */
export function gitRefContentSource(
  ref: string,
  git: (args: string[]) => Promise<string | null>,
): ContentSource {
  const lines = async (args: string[]) =>
    ((await git(args)) ?? "").split("\n").filter(Boolean);
  return {
    async listSessions() {
      return (await lines(["ls-tree", "--name-only", ref, "planning/"]))
        .map((p) => p.replace(/^planning\//, ""))
        .sort();
    },
    async listFiles(session) {
      return (
        await lines(["ls-tree", "--name-only", ref, `planning/${session}/`])
      )
        .map((p) => p.slice(p.lastIndexOf("/") + 1))
        .sort();
    },
    async read(path) {
      return git(["show", `${ref}:${path}`]);
    },
  };
}

/**
 * Read order follows the design: the first source in the list that has the file
 * wins (callers pass: open docs branch, default branch, local). Listings are the
 * union across sources.
 */
export function chainContentSources(sources: ContentSource[]): ContentSource {
  const union = async (fn: (s: ContentSource) => Promise<string[]>) => {
    const all = new Set<string>();
    for (const s of sources) for (const n of await fn(s)) all.add(n);
    return [...all].sort();
  };
  return {
    listSessions: () => union((s) => s.listSessions()),
    listFiles: (session) => union((s) => s.listFiles(session)),
    async read(path) {
      for (const s of sources) {
        const c = await s.read(path);
        if (c !== null) return c;
      }
      return null;
    },
  };
}

// ─── Registration ─────────────────────────────────────────────────────────────

export interface RegisterOptions {
  client: PlanningStoreClient;
  source: ContentSource;
  /** Home repo (org/repo) the planning files live in. */
  repo: string;
  clock: Clock;
  dryRun?: boolean;
  /** Restrict to these sessions; default: every session the source lists. */
  sessions?: string[];
}

export async function registerPlanningSessions(
  opts: RegisterOptions,
): Promise<RegistrationResult> {
  const result: RegistrationResult = {
    dryRun: opts.dryRun === true,
    created: 0,
    updated: 0,
    linked: 0,
    reported: [],
    errors: [],
  };
  let sessions: string[];
  try {
    sessions = opts.sessions ?? (await opts.source.listSessions());
  } catch (e) {
    result.errors.push(`list sessions: ${errMsg(e)}`);
    return result;
  }
  for (const session of sessions) {
    try {
      await registerSession(opts, session, result);
    } catch (e) {
      result.errors.push(`${session}: ${errMsg(e)}`);
    }
  }
  return result;
}

async function registerSession(
  opts: RegisterOptions,
  session: string,
  result: RegistrationResult,
): Promise<void> {
  const { client, source, repo } = opts;
  const dryRun = result.dryRun;
  const files = await source.listFiles(session);
  const existing = await client.listDocuments({ session });
  const byKey = new Map(existing.map((d) => [`${d.kind}:${d.number}`, d]));

  // Classify; first file claiming a (kind, number) wins (PRODUCT-SPEC.md sorts
  // before SPEC-0001.md only by luck, so make the legacy name explicit).
  const ordered = [...files].sort(
    (a, b) =>
      Number(b === "PRODUCT-SPEC.md") - Number(a === "PRODUCT-SPEC.md") ||
      a.localeCompare(b),
  );
  const claimed = new Map<string, string>();
  const docs: Array<{ name: string; kind: DocKind; number: number }> = [];
  for (const name of ordered) {
    const path = `planning/${session}/${name}`;
    const cls = classifyPlanningFile(name);
    if (!cls) {
      result.reported.push({ path, reason: "non-standard file" });
      continue;
    }
    const key = `${cls.kind}:${cls.number}`;
    const holder = claimed.get(key);
    if (holder) {
      result.reported.push({
        path,
        reason: `duplicate ${cls.kind} ${cls.number} (already ${holder})`,
      });
      continue;
    }
    claimed.set(key, name);
    docs.push({ name, ...cls });
  }

  const hasPlan = docs.some((d) => d.kind === "plan");
  let planDocId: string | null = byKey.get("plan:1")?.id ?? null;

  for (const d of docs) {
    const path = `planning/${session}/${d.name}`;
    const title = extractTitle(await source.read(path));
    const row = byKey.get(`${d.kind}:${d.number}`);
    let current = row;
    if (!row || row.path !== path || row.title !== title) {
      if (!dryRun) {
        current = await client.registerDocument({
          session,
          kind: d.kind,
          number: d.number,
          repo: row?.repo ?? repo, // never move an existing document's home
          path,
          title,
        });
      }
      if (row) result.updated++;
      else result.created++;
    }
    if (d.kind === "plan") planDocId = current?.id ?? planDocId;
    // Legacy spec 1 is planned once a plan exists.
    if (
      d.kind === "spec" &&
      d.number === 1 &&
      d.name === "PRODUCT-SPEC.md" &&
      hasPlan &&
      !(current ?? row)?.plannedAt
    ) {
      if (!dryRun && current) {
        await client.patchDocument(current.id, {
          plannedAt: opts.clock.now().toISOString(),
        });
      }
      result.updated++;
    }
  }

  // Link tasks to the plan by `source`; only planDocumentId is ever written.
  const planFile = docs.find((d) => d.kind === "plan");
  if (planFile) {
    const tasks = await client.listTasks({
      source: `planning/${session}/${planFile.name}`,
    });
    for (const t of tasks) {
      if (t.planDocumentId) continue;
      if (!dryRun && planDocId) {
        await client.patchTask(t.id, { planDocumentId: planDocId });
      }
      result.linked++;
    }
  }
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
