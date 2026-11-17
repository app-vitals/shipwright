#!/usr/bin/env bun
// Coverage-summary reader (CVT-1.2).
//
// Finds coverage artifacts published by CI on a repo's default branch, parses
// them with the standalone coverage/ modules, prints one result per commit and
// optionally records each result in the task store.
//
// CLI:
//   bun run coverage-summary.ts --repo owner/repo [--record] [--max-backfill 50]
//
// measuredAt is the artifact's `created_at` (when the coverage was uploaded).
//
// Pure logic with an injected command runner and HTTP client; the CLI lives
// under `import.meta.main`. No dependency on any workspace package.

import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeReports, type ReportFile } from "./coverage/normalize.ts";
import type { NormalizedCoverage } from "./coverage/types.ts";

export const ARTIFACT_NAME = "shipwright-coverage";
export const DEFAULT_MAX_BACKFILL = 50;

// ─── Types ────────────────────────────────────────────────────────────────────

export interface CommandResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}
export type CommandRunner = (cmd: string[]) => CommandResult;

export interface HttpRequest {
  method: "GET" | "POST";
  url: string;
  headers: Record<string, string>;
  body?: string;
}
export interface HttpResponse {
  status: number;
  body: unknown;
}
export type HttpClient = (req: HttpRequest) => Promise<HttpResponse>;

export interface ReaderDeps {
  run: CommandRunner;
  http: HttpClient;
  env: Record<string, string | undefined>;
  /** Creates an empty temp directory for a download. */
  makeTempDir: () => string;
  removeDir: (dir: string) => void;
  readReports: (dir: string) => ReportFile[];
}

export interface Artifact {
  id: number;
  name: string;
  expired: boolean;
  created_at: string;
  workflow_run?: { id: number; head_branch: string; head_sha: string };
}

export type RecordOutcome =
  | { status: "recorded" }
  | { status: "record_skipped" }
  | { status: "record_failed"; error: string };

export type CommitResult = NormalizedCoverage & {
  commitSha: string;
  branch: string;
  runUrl: string;
  measuredAt: string;
  record?: RecordOutcome;
};

export type NotReportingReason =
  | "no_artifact"
  | "all_expired"
  | "no_default_branch_artifact"
  | "no_new_artifact"
  | "download_failed"
  | "unparseable";

export interface NotReporting {
  status: "not_reporting";
  reason: NotReportingReason;
}

// ─── Pure selection ───────────────────────────────────────────────────────────

/** Keeps unexpired artifacts from the default branch; or explains why none. */
export function filterArtifacts(
  artifacts: Artifact[],
  defaultBranch: string,
): { artifacts: Artifact[] } | NotReporting {
  const named = artifacts.filter((a) => a.name === ARTIFACT_NAME);
  if (named.length === 0)
    return { status: "not_reporting", reason: "no_artifact" };
  const live = named.filter((a) => !a.expired);
  if (live.length === 0)
    return { status: "not_reporting", reason: "all_expired" };
  const onDefault = live.filter(
    (a) =>
      a.workflow_run?.head_branch === defaultBranch && a.workflow_run.head_sha,
  );
  if (onDefault.length === 0) {
    return { status: "not_reporting", reason: "no_default_branch_artifact" };
  }
  return { artifacts: onDefault };
}

/** One artifact per commit SHA; the newest wins. */
export function dedupeByCommit(artifacts: Artifact[]): Artifact[] {
  const byCommit = new Map<string, Artifact>();
  for (const a of artifacts) {
    const sha = a.workflow_run?.head_sha ?? "";
    const cur = byCommit.get(sha);
    if (!cur || Date.parse(a.created_at) > Date.parse(cur.created_at)) {
      byCommit.set(sha, a);
    }
  }
  return [...byCommit.values()];
}

/**
 * Artifacts newer than the latest stored snapshot, oldest first. With no
 * snapshot, or more than maxBackfill candidates, only the newest maxBackfill
 * (still oldest first) are kept.
 */
export function selectArtifacts(
  artifacts: Artifact[],
  latestMeasuredAt: string | null,
  maxBackfill: number,
): Artifact[] {
  const cutoff = latestMeasuredAt ? Date.parse(latestMeasuredAt) : null;
  const newer = dedupeByCommit(artifacts)
    .filter((a) => cutoff === null || Date.parse(a.created_at) > cutoff)
    .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
  return maxBackfill > 0 && newer.length > maxBackfill
    ? newer.slice(newer.length - maxBackfill)
    : newer;
}

/** Tolerates `{snapshots:[...]}` or a bare array; null on anything else. */
export function extractLatestMeasuredAt(body: unknown): string | null {
  const list = Array.isArray(body)
    ? body
    : (body as { snapshots?: unknown } | null)?.snapshots;
  if (!Array.isArray(list) || list.length === 0) return null;
  const at = (list[0] as { measuredAt?: unknown } | null)?.measuredAt;
  return typeof at === "string" && !Number.isNaN(Date.parse(at)) ? at : null;
}

// ─── I/O helpers ──────────────────────────────────────────────────────────────

function ghJson(run: CommandRunner, args: string[]): unknown {
  const res = run(["gh", ...args]);
  if (!res.ok)
    throw new Error(`gh ${args.join(" ")} failed: ${res.stderr.trim()}`);
  return JSON.parse(res.stdout);
}

function storeConfig(env: ReaderDeps["env"]) {
  const url = env.SHIPWRIGHT_TASK_STORE_URL;
  const token = env.SHIPWRIGHT_TASK_STORE_TOKEN;
  return url && token ? { url: url.replace(/\/+$/, ""), token } : null;
}

async function fetchLatestMeasuredAt(
  deps: ReaderDeps,
  repo: string,
): Promise<string | null> {
  const cfg = storeConfig(deps.env);
  if (!cfg) return null;
  try {
    const res = await deps.http({
      method: "GET",
      url: `${cfg.url}/coverage-snapshots?repo=${encodeURIComponent(repo)}&limit=1`,
      headers: { Authorization: `Bearer ${cfg.token}` },
    });
    return res.status >= 200 && res.status < 300
      ? extractLatestMeasuredAt(res.body)
      : null;
  } catch {
    return null;
  }
}

async function recordResult(
  deps: ReaderDeps,
  repo: string,
  r: CommitResult,
): Promise<RecordOutcome> {
  const cfg = storeConfig(deps.env);
  if (!cfg) return { status: "record_skipped" };
  const body: Record<string, unknown> = {
    repo,
    branch: r.branch,
    commitSha: r.commitSha,
    linesCovered: r.lines.covered,
    linesTotal: r.lines.total,
    tool: r.tool,
    runUrl: r.runUrl,
    measuredAt: r.measuredAt,
  };
  if (r.branches) {
    body.branchesCovered = r.branches.covered;
    body.branchesTotal = r.branches.total;
  }
  if (r.functions) {
    body.functionsCovered = r.functions.covered;
    body.functionsTotal = r.functions.total;
  }
  try {
    const res = await deps.http({
      method: "POST",
      url: `${cfg.url}/coverage-snapshots`,
      headers: {
        Authorization: `Bearer ${cfg.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    return res.status >= 200 && res.status < 300
      ? { status: "recorded" }
      : { status: "record_failed", error: `HTTP ${res.status}` };
  } catch (e) {
    return {
      status: "record_failed",
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

// ─── Orchestration ────────────────────────────────────────────────────────────

export interface Options {
  repo: string;
  record: boolean;
  maxBackfill: number;
}

export async function readCoverageSummary(
  opts: Options,
  deps: ReaderDeps,
): Promise<CommitResult[] | NotReporting> {
  const { repo } = opts;
  const repoInfo = ghJson(deps.run, ["api", `repos/${repo}`]) as {
    default_branch?: string;
  };
  if (!repoInfo.default_branch)
    throw new Error("could not resolve default branch");
  const defaultBranch = repoInfo.default_branch;

  const listing = ghJson(deps.run, [
    "api",
    `repos/${repo}/actions/artifacts?name=${ARTIFACT_NAME}&per_page=100`,
  ]) as { artifacts?: Artifact[] };
  const filtered = filterArtifacts(listing.artifacts ?? [], defaultBranch);
  if ("status" in filtered) return filtered;

  const latest = await fetchLatestMeasuredAt(deps, repo);
  const selected = selectArtifacts(
    filtered.artifacts,
    latest,
    opts.maxBackfill,
  );
  if (selected.length === 0) {
    return { status: "not_reporting", reason: "no_new_artifact" };
  }

  const results: CommitResult[] = [];
  let downloadFailures = 0;
  for (const artifact of selected) {
    const runId = artifact.workflow_run?.id;
    const dir = deps.makeTempDir();
    try {
      const runInfo = ghJson(deps.run, [
        "api",
        `repos/${repo}/actions/runs/${runId}`,
      ]) as { html_url?: string };
      const dl = deps.run([
        "gh",
        "run",
        "download",
        String(runId),
        "--repo",
        repo,
        "--name",
        ARTIFACT_NAME,
        "--dir",
        dir,
      ]);
      if (!dl.ok || !runInfo.html_url) {
        downloadFailures++;
        continue;
      }
      const normalized = normalizeReports(deps.readReports(dir));
      if (!normalized) continue;
      results.push({
        ...normalized,
        commitSha: artifact.workflow_run?.head_sha ?? "",
        branch: defaultBranch,
        runUrl: runInfo.html_url,
        measuredAt: artifact.created_at,
      });
    } catch {
      downloadFailures++;
    } finally {
      deps.removeDir(dir);
    }
  }

  if (results.length === 0) {
    return {
      status: "not_reporting",
      reason:
        downloadFailures === selected.length
          ? "download_failed"
          : "unparseable",
    };
  }

  if (opts.record) {
    for (const r of results) r.record = await recordResult(deps, repo, r);
  }
  return results;
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

export function parseArgs(argv: string[]): Options {
  let repo = "";
  let record = false;
  let maxBackfill = DEFAULT_MAX_BACKFILL;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--repo") repo = argv[++i] ?? "";
    else if (arg === "--record") record = true;
    else if (arg === "--max-backfill") {
      const n = Number(argv[++i]);
      if (!Number.isInteger(n) || n < 1) {
        throw new Error("--max-backfill must be a positive integer");
      }
      maxBackfill = n;
    } else throw new Error(`unknown argument: ${arg}`);
  }
  if (!/^[^/\s]+\/[^/\s]+$/.test(repo)) {
    throw new Error("--repo {owner}/{repo} is required");
  }
  return { repo, record, maxBackfill };
}

function listFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? listFiles(p) : [p];
  });
}

export const realDeps = (): ReaderDeps => ({
  run: (cmd) => {
    const r = spawnSync(cmd[0] as string, cmd.slice(1), { encoding: "utf8" });
    return {
      ok: r.status === 0,
      stdout: r.stdout ?? "",
      stderr: r.stderr ?? "",
    };
  },
  http: async (req) => {
    const res = await fetch(req.url, {
      method: req.method,
      headers: req.headers,
      body: req.body,
    });
    const text = await res.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {}
    return { status: res.status, body };
  },
  env: process.env,
  makeTempDir: () => mkdtempSync(join(tmpdir(), "cov-")),
  removeDir: (dir) => rmSync(dir, { recursive: true, force: true }),
  readReports: (dir) =>
    listFiles(dir).map((p) => ({
      name: p.slice(dir.length + 1),
      content: readFileSync(p, "utf8"),
    })),
});

if (import.meta.main) {
  try {
    const opts = parseArgs(process.argv.slice(2));
    const out = await readCoverageSummary(opts, realDeps());
    console.log(JSON.stringify(out, null, 2));
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
}
