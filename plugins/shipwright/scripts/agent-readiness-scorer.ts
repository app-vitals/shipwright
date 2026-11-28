#!/usr/bin/env bun
/**
 * plugins/shipwright/scripts/agent-readiness-scorer.ts
 *
 * Deterministic agent-readiness scorer (RDY-2.3). Runs every file-based
 * detector (readiness-detectors.ts) and every GitHub / task-store detector
 * (readiness-api-detectors.ts) for one repo, computes the level with
 * computeLevel (readiness-catalogue.ts), posts one ReadinessSnapshot and
 * records one RepoCronRun (cron-run-recorder.ts; outcome ok, metrics {}).
 *
 * No model judgment, no clock reads (injected), no repo writes, no tasks: the
 * only side effects are the two task-store POSTs. Detection failures never
 * throw; a source that cannot be reached fails its checks (see the detectors).
 *
 * CLI:
 *   agent-readiness-scorer.ts --repo org/repo --root DIR [--commit SHA]
 *     --root is a checkout of the repo; --commit defaults to `git rev-parse HEAD`
 *     in it. Needs SHIPWRIGHT_TASK_STORE_URL / SHIPWRIGHT_TASK_STORE_TOKEN and an
 *     authenticated `gh` CLI. Prints {level, passing, failing} JSON.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type Clock, SystemClock } from "./clock.ts";
import {
  buildProductionDeps as buildRecorderDeps,
  type RecorderDeps,
  runWithRecorder,
} from "./cron-run-recorder.ts";
import {
  type BranchProtection,
  type BranchRule,
  type CronRun,
  type DetectorDeps,
  type GitHubSettingsClient,
  type PatrolFinding,
  type PatrolFindingStatus,
  runApiDetectors,
  type SystemCron,
  type SystemCronsClient,
  type TaskStoreClient,
} from "./readiness-api-detectors.ts";
import {
  type CheckResult,
  computeLevel,
  READINESS_CATALOGUE,
  READINESS_CATALOGUE_VERSION,
  type ReadinessLevel,
} from "./readiness-catalogue.ts";
import { type ReadinessReader, runDetectors } from "./readiness-detectors.ts";

export const CRON_ID = "agent-readiness";

export interface ScoredCheck {
  id: string;
  level: ReadinessLevel;
  result: CheckResult;
  owner: string;
}

export interface Score {
  level: 0 | ReadinessLevel;
  passing: number;
  failing: number;
  checks: ScoredCheck[];
}

// ─── Reader ───────────────────────────────────────────────────────────────────

const SKIP_DIRS = new Set([".git", "node_modules", "vendor", "dist", "build"]);

/** Read-only view of a checkout. Never writes. */
export function dirReader(root: string): ReadinessReader {
  const files: string[] = [];
  const walk = (rel: string) => {
    for (const e of readdirSync(join(root, rel), { withFileTypes: true })) {
      const p = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(p);
      } else if (e.isFile()) files.push(p);
    }
  };
  walk("");
  return {
    listFiles: () => files,
    read: (p) => {
      const abs = join(root, p);
      try {
        return existsSync(abs) ? readFileSync(abs, "utf8") : undefined;
      } catch {
        return undefined;
      }
    },
  };
}

// ─── Scoring ──────────────────────────────────────────────────────────────────

/** Run every detector and assemble one result per catalogue check. */
export async function scoreRepo(
  repo: string,
  reader: ReadinessReader,
  deps: DetectorDeps,
): Promise<Score> {
  const results: Record<string, CheckResult> = { ...runDetectors(reader) };
  for (const r of await runApiDetectors(repo, deps)) results[r.id] = r.result;

  const checks: ScoredCheck[] = READINESS_CATALOGUE.map((c) => ({
    id: c.id,
    level: c.level,
    // A check with no detector is not evidence of a pass.
    result: results[c.id] ?? "fail",
    owner: c.owner,
  }));
  return {
    level: computeLevel(
      Object.fromEntries(checks.map((c) => [c.id, c.result])),
    ),
    passing: checks.filter((c) => c.result === "pass").length,
    failing: checks.filter((c) => c.result === "fail").length,
    checks,
  };
}

// ─── Run + record ─────────────────────────────────────────────────────────────

export interface RunScorerOptions {
  repo: string;
  commitSha: string;
  reader: ReadinessReader;
  detectorDeps: DetectorDeps;
  recorderDeps: RecorderDeps;
  /** Cron task id / slot, passed through to the run record. */
  taskId?: string;
  scheduledFor?: string;
}

/** Score, POST one snapshot, record one run (`failed` + rethrow on error). */
export async function runScorer(opts: RunScorerOptions): Promise<Score> {
  const { recorderDeps: deps } = opts;
  let score: Score | undefined;
  await runWithRecorder(
    {
      cronId: CRON_ID,
      repo: opts.repo,
      commitSha: opts.commitSha,
      taskId: opts.taskId,
      scheduledFor: opts.scheduledFor,
    },
    async () => {
      score = await scoreRepo(opts.repo, opts.reader, opts.detectorDeps);
      const res = await deps.fetchFn(`${deps.baseUrl}/readiness-snapshots`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${deps.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          repo: opts.repo,
          commitSha: opts.commitSha,
          level: score.level,
          passing: score.passing,
          failing: score.failing,
          checks: score.checks,
          catalogueVersion: String(READINESS_CATALOGUE_VERSION),
          measuredAt: deps.clock.now().toISOString(),
        }),
      });
      if (!res.ok) {
        throw new Error(`POST /readiness-snapshots failed: HTTP ${res.status}`);
      }
      return { outcome: "ok", metrics: {} };
    },
    deps,
  );
  if (!score) throw new Error("scorer produced no score");
  return score;
}

// ─── Production clients ───────────────────────────────────────────────────────

export interface StoreConn {
  fetchFn: typeof fetch;
  baseUrl: string;
  token: string;
}

/** Task-store reads the API detectors need (cron runs, findings, system crons). */
export function taskStoreClients(conn: StoreConn): {
  taskStore: TaskStoreClient;
  systemCrons: SystemCronsClient;
} {
  const get = (path: string) =>
    conn.fetchFn(`${conn.baseUrl}${path}`, {
      headers: { Authorization: `Bearer ${conn.token}` },
    });
  const q = (cronId: string, repo: string) =>
    `cronId=${encodeURIComponent(cronId)}&repo=${encodeURIComponent(repo)}`;
  const ok = async <T>(res: Response, what: string): Promise<T> => {
    if (!res.ok) throw new Error(`${what} failed: HTTP ${res.status}`);
    return (await res.json()) as T;
  };
  return {
    taskStore: {
      async latestRun(cronId, repo) {
        const res = await get(`/cron-runs/latest?${q(cronId, repo)}`);
        if (res.status === 404) return null;
        return ok<CronRun>(res, "GET /cron-runs/latest");
      },
      async newestRun(cronId, repo) {
        const body = await ok<{ runs: CronRun[] }>(
          await get(`/cron-runs?${q(cronId, repo)}&limit=1`),
          "GET /cron-runs",
        );
        return body.runs[0] ?? null;
      },
      async listFindings(query: {
        cronId: string;
        repo: string;
        status?: PatrolFindingStatus;
      }) {
        const out: PatrolFinding[] = [];
        let cursor: string | null = null;
        do {
          const page: {
            findings?: PatrolFinding[];
            nextCursor?: string | null;
          } = await ok(
            await get(
              `/patrol-findings?${q(query.cronId, query.repo)}&limit=200${
                query.status ? `&status=${query.status}` : ""
              }${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
            ),
            "GET /patrol-findings",
          );
          out.push(...(page.findings ?? []));
          cursor = page.nextCursor ?? null;
        } while (cursor);
        return out;
      },
    },
    systemCrons: {
      async list() {
        const body = await ok<{ systemCrons: SystemCron[] }>(
          await get("/system-crons"),
          "GET /system-crons",
        );
        return body.systemCrons;
      },
    },
  };
}

/** GitHub settings via the `gh` CLI (read-only `gh api` GETs). */
export function ghSettingsClient(): GitHubSettingsClient {
  const api = (path: string): { status: number; body: unknown } => {
    const r = spawnSync("gh", ["api", "-i", path], {
      encoding: "utf-8",
      env: process.env,
    });
    const out = r.stdout ?? "";
    const m = /^HTTP\/[\d.]+ (\d+)/.exec(out);
    const status = m ? Number(m[1]) : r.status === 0 ? 200 : 0;
    if (status === 0) throw new Error(`gh api ${path} failed: ${r.stderr}`);
    const raw = out.slice(out.search(/\r?\n\r?\n/)).trim();
    let body: unknown = null;
    try {
      body = raw ? JSON.parse(raw) : null;
    } catch {
      body = null;
    }
    return { status, body };
  };
  return {
    async getDefaultBranch(repo) {
      const { status, body } = api(`repos/${repo}`);
      const b = (body as { default_branch?: string } | null)?.default_branch;
      if (status !== 200 || !b)
        throw new Error(`GET repos/${repo}: HTTP ${status}`);
      return b;
    },
    async getBranchProtection(repo, branch) {
      const { status, body } = api(
        `repos/${repo}/branches/${branch}/protection`,
      );
      if (status === 404) return null;
      if (status !== 200)
        throw new Error(`GET branch protection: HTTP ${status}`);
      return body as BranchProtection;
    },
    async getBranchRules(repo, branch) {
      const { status, body } = api(`repos/${repo}/rules/branches/${branch}`);
      if (status === 404) return [];
      if (status !== 200) throw new Error(`GET branch rules: HTTP ${status}`);
      return (body ?? []) as BranchRule[];
    },
  };
}

export function buildDetectorDeps(
  recorder: RecorderDeps,
  clock: Clock,
): DetectorDeps {
  return {
    clock,
    github: ghSettingsClient(),
    ...taskStoreClients({
      fetchFn: recorder.fetchFn,
      baseUrl: recorder.baseUrl,
      token: recorder.token,
    }),
  };
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

if (import.meta.main) {
  (async () => {
    const args = process.argv.slice(2);
    const flag = (n: string) => {
      const i = args.indexOf(`--${n}`);
      return i >= 0 ? args[i + 1] : undefined;
    };
    const repo = flag("repo");
    const root = flag("root");
    if (!repo || !root) {
      process.stderr.write(
        "usage: agent-readiness-scorer.ts --repo org/repo --root DIR [--commit SHA] [--task ID] [--scheduled-for ISO]\n",
      );
      process.exit(2);
    }
    const commitSha =
      flag("commit") ??
      spawnSync("git", ["-C", root, "rev-parse", "HEAD"], {
        encoding: "utf-8",
      }).stdout.trim();
    if (!commitSha)
      throw new Error("could not resolve commit SHA; pass --commit");
    const clock = SystemClock();
    const recorderDeps = buildRecorderDeps(clock);
    const score = await runScorer({
      repo,
      commitSha,
      reader: dirReader(root),
      detectorDeps: buildDetectorDeps(recorderDeps, clock),
      recorderDeps,
      taskId: flag("task"),
      scheduledFor: flag("scheduled-for"),
    });
    console.log(
      JSON.stringify({
        level: score.level,
        passing: score.passing,
        failing: score.failing,
      }),
    );
  })().catch((e: unknown) => {
    process.stderr.write(`error: ${String(e)}\n`);
    process.exit(2);
  });
}
