#!/usr/bin/env bun
/**
 * plugins/shipwright/scripts/cron-run-recorder.ts
 *
 * Records one RepoCronRun per invocation in the task store (PCR-2.1) and
 * serves the prior state a per-repo system cron needs, so cron state lives in
 * the task store instead of agent-local `state/*.json` files.
 *
 * - Auth via SHIPWRIGHT_TASK_STORE_URL / SHIPWRIGHT_TASK_STORE_TOKEN.
 * - fetch and clock are injected (clock.ts), like the check-*.ts scripts.
 * - Prior state = GET /cron-runs/latest (+ /patrol-findings).
 * - One-time legacy import: when /cron-runs/latest is 404 and the agent-local
 *   legacy ledger holds entries for this repo, those entries (filtered to the
 *   named repo; other repos' entries are ignored) become the first run's prior
 *   state: findings go to POST /patrol-findings/batch, small non-finding state
 *   goes into the run's machineState. The legacy file is deleted only after
 *   both posts succeed, so a failed post leaves it in place for a retry.
 * - Never writes machine state to any local path; the only filesystem
 *   mutation is deleting the legacy file after a successful import.
 *
 * Skills call it via ${CLAUDE_PLUGIN_ROOT}/scripts/cron-run-recorder.ts:
 *   prior  --cron ID --repo org/repo [--legacy-shape S [--legacy-path P]]
 *          prints {latest, findings, imported} JSON (read-only)
 *   record --cron ID --repo org/repo --commit SHA --result FILE
 *          [--task ID] [--scheduled-for ISO] [--started-at ISO]
 *          [--legacy-shape S [--legacy-path P]]
 *          FILE = {outcome, metrics, machineState?, findings?}; posts one run
 */

import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { resolveWorkspacePath } from "./check-helpers.ts";
import { type Clock, SystemClock } from "./clock.ts";

// ─── Types ────────────────────────────────────────────────────────────────────

export const LEGACY_SHAPES = [
  "consolidation-ledger",
  "security-patrol-ledger",
  "error-patrol-ledger",
  "entropy-patrol-last-run",
  "docs-last-synced",
] as const;
export type LegacyShape = (typeof LEGACY_SHAPES)[number];

export type Outcome = "ok" | "no_op" | "failed";

export interface FindingInput {
  fingerprint: string;
  status: string;
  detail?: unknown;
  taskId?: string | null;
}

export interface RecorderDeps {
  fetchFn: typeof fetch;
  clock: Clock;
  baseUrl: string;
  token: string;
  /** Returns file contents, or null when the file does not exist. */
  readFile: (path: string) => string | null;
  deleteFile: (path: string) => void;
  log: (msg: string) => void;
}

export interface RunContext {
  cronId: string;
  /** owner/repo */
  repo: string;
  commitSha: string;
  taskId?: string;
  scheduledFor?: string;
  /** Overrides the clock-derived start (CLI `record` after the work ran). */
  startedAt?: string;
  legacyShape?: LegacyShape;
  /** Legacy ledger path; default `<workspace>/state/<shape>.json`. */
  legacyPath?: string;
}

export interface LegacyImport {
  shape: LegacyShape;
  path: string;
  findings: FindingInput[];
  machineState: Record<string, unknown>;
  /** ISO observedAt for the findings batch (legacy lastRun, if any). */
  observedAt?: string;
}

export interface PriorState {
  latest: Record<string, unknown> | null;
  findings: unknown[];
  imported: LegacyImport | null;
}

export interface WorkResult {
  outcome: "ok" | "no_op";
  metrics: Record<string, number>;
  machineState?: Record<string, unknown>;
  findings?: FindingInput[];
}

// ─── Legacy filtering ─────────────────────────────────────────────────────────

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export function parseLegacyShape(s: string): LegacyShape | null {
  return (LEGACY_SHAPES as readonly string[]).includes(s)
    ? (s as LegacyShape)
    : null;
}

/** Last path segment, lowercased — the ledgers' `repo-slug`. */
function repoSlug(repo: string): string {
  return (repo.split("/").pop() ?? repo).toLowerCase();
}

function isRepoRef(value: unknown, repo: string): boolean {
  if (typeof value !== "string") return false;
  const v = value.toLowerCase();
  return v === repo.toLowerCase() || v === repoSlug(repo);
}

const STATUS_MAP: Record<string, string> = {
  unresolved: "open",
  ignored: "suppressed",
};

function mapStatus(s: unknown): string {
  const str = typeof s === "string" ? s : "tracking";
  return STATUS_MAP[str] ?? str;
}

function toFinding(fingerprint: string, entry: Obj): FindingInput {
  const { status, repo: _repo, ...detail } = entry;
  return { fingerprint, status: mapStatus(status), detail };
}

function strField(o: Obj, k: string): string | undefined {
  return typeof o[k] === "string" ? (o[k] as string) : undefined;
}

/**
 * Turn a parsed legacy ledger into the single-repo prior state for `repo`.
 * Returns null when the content is not a recognizable ledger or holds nothing
 * for this repo. Other repos' entries are ignored.
 */
export function filterLegacy(
  shape: LegacyShape,
  raw: unknown,
  repo: string,
): Pick<LegacyImport, "findings" | "machineState" | "observedAt"> | null {
  if (!isObj(raw)) return null;
  const lastRun = strField(raw, "lastRun");
  const withRun = (ms: Obj): Obj => (lastRun ? { lastRun, ...ms } : ms);
  const slug = repoSlug(repo);

  switch (shape) {
    case "consolidation-ledger": {
      const cands = isObj(raw.candidates) ? raw.candidates : {};
      const findings = Object.entries(cands)
        .filter(
          ([k, v]) =>
            isObj(v) &&
            (isRepoRef(v.repo, repo) ||
              k.startsWith(`${repo}:`) ||
              k.startsWith(`${slug}:`)),
        )
        .map(([k, v]) => toFinding(k, v as Obj));
      if (findings.length === 0) return null;
      return { findings, machineState: withRun({}), observedAt: lastRun };
    }
    case "security-patrol-ledger": {
      const all = isObj(raw.findings) ? raw.findings : {};
      const re = new RegExp(`^security-.+-${escapeRe(slug)}-\\d{4}-W\\d{2}$`);
      const findings = Object.entries(all)
        .filter(([k, v]) => isObj(v) && (re.test(k) || isRepoRef(v.repo, repo)))
        .map(([k, v]) => toFinding(k, v as Obj));
      if (findings.length === 0) return null;
      return { findings, machineState: withRun({}), observedAt: lastRun };
    }
    case "error-patrol-ledger": {
      const issues = isObj(raw.issues) ? raw.issues : {};
      const findings = Object.entries(issues)
        .filter(([, v]) => isObj(v) && isRepoRef(v.repo, repo))
        .map(([k, v]) => toFinding(k, v as Obj));
      const map = isObj(raw.serviceRepoMap) ? raw.serviceRepoMap : {};
      const serviceRepoMap = Object.fromEntries(
        Object.entries(map).filter(
          ([, v]) => isObj(v) && isRepoRef(v.repo, repo),
        ),
      );
      if (findings.length === 0 && Object.keys(serviceRepoMap).length === 0) {
        return null;
      }
      return {
        findings,
        machineState: withRun({ serviceRepoMap }),
        observedAt: lastRun,
      };
    }
    case "entropy-patrol-last-run": {
      if (isObj(raw.repos)) {
        const mine = raw.repos[repo];
        if (!isObj(mine)) return null;
        return { findings: [], machineState: { ...mine } };
      }
      return lastRun ? { findings: [], machineState: { lastRun } } : null;
    }
    case "docs-last-synced": {
      const mine = isObj(raw[repo]) ? (raw[repo] as Obj) : raw;
      const sha = strField(mine, "sha");
      if (!sha) return null;
      const timestamp = strField(mine, "timestamp");
      return {
        findings: [],
        machineState: timestamp ? { sha, timestamp } : { sha },
      };
    }
  }
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ─── Store client ─────────────────────────────────────────────────────────────

async function call(
  deps: RecorderDeps,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<Response> {
  return deps.fetchFn(`${deps.baseUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${deps.token}`,
      "Content-Type": "application/json",
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

async function mustOk(res: Response, what: string): Promise<Response> {
  if (!res.ok) throw new Error(`${what} failed: HTTP ${res.status}`);
  return res;
}

function legacyPathFor(ctx: RunContext): string | null {
  if (!ctx.legacyShape) return null;
  return (
    ctx.legacyPath ??
    join(resolveWorkspacePath(), "state", `${ctx.legacyShape}.json`)
  );
}

// ─── Core ─────────────────────────────────────────────────────────────────────

/** Read-only: latest run, tracked findings, and (on 404) the legacy import. */
export async function loadPriorState(
  ctx: RunContext,
  deps: RecorderDeps,
): Promise<PriorState> {
  const q = `cronId=${encodeURIComponent(ctx.cronId)}&repo=${encodeURIComponent(ctx.repo)}`;
  const res = await call(deps, "GET", `/cron-runs/latest?${q}`);
  let latest: Record<string, unknown> | null = null;
  if (res.status === 200) {
    latest = (await res.json()) as Record<string, unknown>;
  } else if (res.status !== 404) {
    throw new Error(`GET /cron-runs/latest failed: HTTP ${res.status}`);
  }

  const findings: unknown[] = [];
  let cursor: string | null = null;
  do {
    const page: Response = await mustOk(
      await call(
        deps,
        "GET",
        `/patrol-findings?${q}&limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
      ),
      "GET /patrol-findings",
    );
    const data = (await page.json()) as {
      findings?: unknown[];
      nextCursor?: string | null;
    };
    findings.push(...(data.findings ?? []));
    cursor = data.nextCursor ?? null;
  } while (cursor);

  // Only a 404 ever consults the local file.
  let imported: LegacyImport | null = null;
  const path = latest === null ? legacyPathFor(ctx) : null;
  if (path && ctx.legacyShape) {
    const text = deps.readFile(path);
    if (text !== null) {
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }
      const filtered = filterLegacy(ctx.legacyShape, parsed, ctx.repo);
      if (filtered) imported = { shape: ctx.legacyShape, path, ...filtered };
    }
  }
  return { latest, findings, imported };
}

async function postFindings(
  ctx: RunContext,
  findings: FindingInput[],
  observedAt: string,
  deps: RecorderDeps,
): Promise<void> {
  if (findings.length === 0) return;
  await mustOk(
    await call(deps, "POST", "/patrol-findings/batch", {
      cronId: ctx.cronId,
      repo: ctx.repo,
      observedAt,
      findings,
    }),
    "POST /patrol-findings/batch",
  );
}

/** POST exactly one run. */
export async function postRun(
  ctx: RunContext,
  run: {
    outcome: Outcome;
    metrics: Record<string, number>;
    machineState?: Record<string, unknown>;
    startedAt: string;
    finishedAt: string;
  },
  deps: RecorderDeps,
): Promise<void> {
  await mustOk(
    await call(deps, "POST", "/cron-runs", {
      cronId: ctx.cronId,
      repo: ctx.repo,
      ...(ctx.taskId ? { taskId: ctx.taskId } : {}),
      ...(ctx.scheduledFor ? { scheduledFor: ctx.scheduledFor } : {}),
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      commitSha: ctx.commitSha,
      outcome: run.outcome,
      metrics: run.metrics,
      ...(run.machineState ? { machineState: run.machineState } : {}),
    }),
    "POST /cron-runs",
  );
}

/**
 * Load prior state, run `work`, record exactly one run (outcome `failed` and
 * rethrow if `work` or the legacy import throws), and finish the legacy
 * import only after the run was posted successfully.
 */
export async function runWithRecorder(
  ctx: RunContext,
  work: (prior: PriorState) => Promise<WorkResult>,
  deps: RecorderDeps,
): Promise<void> {
  const startedAt = ctx.startedAt ?? deps.clock.now().toISOString();
  const prior = await loadPriorState(ctx, deps);
  const failed = async (err: unknown): Promise<never> => {
    try {
      await postRun(
        ctx,
        {
          outcome: "failed",
          metrics: {},
          startedAt,
          finishedAt: deps.clock.now().toISOString(),
        },
        deps,
      );
    } catch (postErr) {
      deps.log(`failed-run post also failed: ${String(postErr)}`);
    }
    throw err;
  };

  let result: WorkResult;
  try {
    if (prior.imported) {
      await postFindings(
        ctx,
        prior.imported.findings,
        prior.imported.observedAt ?? startedAt,
        deps,
      );
    }
    result = await work(prior);
    await postFindings(
      ctx,
      result.findings ?? [],
      deps.clock.now().toISOString(),
      deps,
    );
  } catch (err) {
    return failed(err);
  }

  await postRun(
    ctx,
    {
      outcome: result.outcome,
      metrics: result.metrics,
      machineState: {
        ...(prior.imported?.machineState ?? {}),
        ...(result.machineState ?? {}),
      },
      startedAt,
      finishedAt: deps.clock.now().toISOString(),
    },
    deps,
  );

  if (prior.imported) {
    deps.deleteFile(prior.imported.path);
    deps.log(
      `legacy import: ${prior.imported.shape} -> ${ctx.repo} (${prior.imported.findings.length} findings), removed ${prior.imported.path}`,
    );
  }
}

// ─── Production wiring + CLI ──────────────────────────────────────────────────

export function buildProductionDeps(
  clock: Clock = SystemClock(),
): RecorderDeps {
  const baseUrl = (process.env.SHIPWRIGHT_TASK_STORE_URL ?? "")
    .trim()
    .replace(/\/$/, "");
  const token = (process.env.SHIPWRIGHT_TASK_STORE_TOKEN ?? "").trim();
  if (!baseUrl || !token) {
    throw new Error(
      "SHIPWRIGHT_TASK_STORE_URL and SHIPWRIGHT_TASK_STORE_TOKEN must be set",
    );
  }
  return {
    fetchFn: fetch,
    clock,
    baseUrl,
    token,
    readFile: (p) => (existsSync(p) ? readFileSync(p, "utf-8") : null),
    deleteFile: (p) => unlinkSync(p),
    log: (m) => process.stderr.write(`${m}\n`),
  };
}

function parseArgs(argv: string[]): {
  cmd: string;
  flags: Record<string, string>;
} {
  const [cmd = "", ...rest] = argv;
  const flags: Record<string, string> = {};
  for (let i = 0; i < rest.length; i += 2) {
    const k = rest[i];
    if (!k?.startsWith("--") || rest[i + 1] === undefined) {
      throw new Error(`bad argument: ${k}`);
    }
    flags[k.slice(2)] = rest[i + 1];
  }
  return { cmd, flags };
}

function ctxFromFlags(f: Record<string, string>): RunContext {
  if (!f.cron || !f.repo) throw new Error("--cron and --repo are required");
  let legacyShape: LegacyShape | undefined;
  if (f["legacy-shape"]) {
    legacyShape = parseLegacyShape(f["legacy-shape"]) ?? undefined;
    if (!legacyShape)
      throw new Error(`unknown --legacy-shape ${f["legacy-shape"]}`);
  }
  return {
    cronId: f.cron,
    repo: f.repo,
    commitSha: f.commit ?? "",
    taskId: f.task,
    scheduledFor: f["scheduled-for"],
    startedAt: f["started-at"],
    legacyShape,
    legacyPath: f["legacy-path"],
  };
}

export async function main(
  argv: string[],
  deps: RecorderDeps,
): Promise<number> {
  const { cmd, flags } = parseArgs(argv);
  const ctx = ctxFromFlags(flags);
  if (cmd === "prior") {
    process.stdout.write(
      `${JSON.stringify(await loadPriorState(ctx, deps))}\n`,
    );
    return 0;
  }
  if (cmd === "record") {
    if (!ctx.commitSha || !flags.result) {
      throw new Error("--commit and --result are required");
    }
    const parsed = JSON.parse(readFileSync(flags.result, "utf-8")) as Partial<
      Omit<WorkResult, "outcome">
    > & {
      outcome?: Outcome;
    };
    const outcome = parsed.outcome;
    if (outcome !== "ok" && outcome !== "no_op" && outcome !== "failed") {
      throw new Error("result.outcome must be ok | no_op | failed");
    }
    if (outcome === "failed") {
      await postRun(
        ctx,
        {
          outcome,
          metrics: parsed.metrics ?? {},
          startedAt: ctx.startedAt ?? deps.clock.now().toISOString(),
          finishedAt: deps.clock.now().toISOString(),
        },
        deps,
      );
      return 0;
    }
    await runWithRecorder(
      ctx,
      async () => ({
        outcome,
        metrics: parsed.metrics ?? {},
        machineState: parsed.machineState,
        findings: parsed.findings,
      }),
      deps,
    );
    return 0;
  }
  throw new Error(
    "usage: cron-run-recorder.ts prior|record --cron ID --repo org/repo ...",
  );
}

if (import.meta.main) {
  (async () => {
    process.exit(await main(process.argv.slice(2), buildProductionDeps()));
  })().catch((e: unknown) => {
    process.stderr.write(`error: ${String(e)}\n`);
    process.exit(2);
  });
}
