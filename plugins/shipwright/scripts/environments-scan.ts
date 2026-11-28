#!/usr/bin/env bun
/**
 * plugins/shipwright/scripts/environments-scan.ts
 *
 * Detection, doc rendering and task planning for the environments patrol
 * (RDY-3.2). Covers the readiness `environments` owner checks: lockfile,
 * pinned tool versions, preview environment, structured logging, error
 * tracking, tracing/metrics and staged/canary deploy.
 *
 * Pure over an injected RepoIO (a file listing + reader) and Clock, so
 * integration tests run against fixture repos in temp dirs. The skills do the
 * git, PR, task-store and run-recording work; this script decides.
 *
 * CLI:
 *   scan  --repo org/repo --root DIR [--doc docs/patrols/environments.md]
 *         [--active-tasks FILE] [--out FILE]
 *         prints {findings, doc, materiallyChanged, violations, tasks, metrics}
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  isMaterialChange,
  renderPatrolDoc,
  validatePatrolDoc,
  type Violation,
} from "./check-patrol-docs.ts";
import { type Clock, SystemClock } from "./clock.ts";

export type Route = "auto" | "review" | "plan";
export type EnvCheckId =
  | "lockfile"
  | "tool-versions"
  | "preview-environment"
  | "structured-logging"
  | "error-tracking"
  | "tracing-metrics"
  | "staged-canary";

export interface EnvFinding {
  id: EnvCheckId;
  title: string;
  why: string;
  route: Route;
  /** Lower = higher priority. */
  priority: number;
  paths: string[];
  /** Options a human picks from (review route). */
  choices?: string[];
}

export interface RepoIO {
  /** Repo-relative file paths (no node_modules / .git). */
  listFiles(): string[];
  readFile(path: string): string | null;
}

const SKIP_DIRS = new Set(["node_modules", ".git", "vendor", "dist", "build"]);

export function dirIO(root: string): RepoIO {
  const files: string[] = [];
  const walk = (rel: string) => {
    for (const e of readdirSync(join(root, rel), { withFileTypes: true })) {
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(rel ? `${rel}/${e.name}` : e.name);
      } else files.push(rel ? `${rel}/${e.name}` : e.name);
    }
  };
  walk("");
  return {
    listFiles: () => files,
    readFile: (p) => {
      const abs = join(root, p);
      return existsSync(abs) ? readFileSync(abs, "utf8") : null;
    },
  };
}

// ─── Detection ────────────────────────────────────────────────────────────────

// Manifest -> accepted lockfiles; mirrors references/toolchain-patterns.md.
const LOCKS: { manifest: string; locks: string[] }[] = [
  {
    manifest: "package.json",
    locks: [
      "package-lock.json",
      "yarn.lock",
      "pnpm-lock.yaml",
      "bun.lock",
      "bun.lockb",
    ],
  },
  { manifest: "Cargo.toml", locks: ["Cargo.lock"] },
  { manifest: "go.mod", locks: ["go.sum"] },
  { manifest: "Gemfile", locks: ["Gemfile.lock"] },
  {
    manifest: "pyproject.toml",
    locks: ["poetry.lock", "uv.lock", "pdm.lock", "Pipfile.lock"],
  },
];

const TOOL_VERSION_FILES = [
  ".tool-versions",
  "mise.toml",
  ".mise.toml",
  ".nvmrc",
  ".node-version",
  ".python-version",
  ".ruby-version",
  "rust-toolchain",
  "rust-toolchain.toml",
  ".devcontainer.json",
  ".devcontainer/devcontainer.json",
];

const MANIFEST_RE =
  /(^|\/)(package\.json|go\.mod|Cargo\.toml|Gemfile|pyproject\.toml|requirements[^/]*\.txt|pom\.xml|build\.gradle(\.kts)?)$/;
const LOGGING_RE =
  /\b(pino|winston|bunyan|structlog|loguru|zerolog|zap|logrus|log\/slog|serilog|logback|tracing-subscriber|python-json-logger)\b/;
const ERROR_RE =
  /(@sentry\/|sentry-sdk|sentry-go|sentry-ruby|sentry-rails|sentry_sdk|bugsnag|rollbar|honeybadger|airbrake|raygun)/i;
const TRACE_RE =
  /(opentelemetry|prom-client|prometheus|statsd|dd-trace|micrometer|otel)/i;
const CANARY_RE =
  /(canary|kind:\s*Rollout|flagger|blue[-_ ]green|progressive delivery|staged rollout|promote-to-prod)/i;
const BRINGUP_FILE_RE =
  /(^|\/)(docker-compose[^/]*\.ya?ml|compose\.ya?ml|Tiltfile|skaffold\.ya?ml)$/;
const RUNNER_FILE_RE =
  /(^|\/)(Taskfile\.ya?ml|Makefile|justfile|Justfile|package\.json)$/;
const BRINGUP_TARGET_RE =
  /["']?(preview|stack|up|dev:up|dev-up|start:all|bootstrap)[\w:-]*["']?\s*:/i;
const BRINGUP_CMD_RE =
  /(docker[- ]compose\s+(-f\s+\S+\s+)?up|\btask\s+\S*(preview|up|stack)|\bmake\s+\S*(preview|up|stack)|\bskaffold\b|\btilt\s+ci|run\s+\S*(preview|stack|up)\b)/i;
const TEST_CMD_RE = /(test|e2e|smoke|canary|playwright|cypress)/i;

function dependencyHit(io: RepoIO, re: RegExp, files: string[]): boolean {
  return files.some((f) => {
    const c = io.readFile(f);
    return c !== null && re.test(c);
  });
}

export function scanRepo(io: RepoIO): EnvFinding[] {
  const files = io.listFiles();
  const has = (name: string) => files.includes(name);
  const manifests = files.filter((f) => MANIFEST_RE.test(f));
  const out: EnvFinding[] = [];

  const missingLocks = LOCKS.filter(
    (l) => has(l.manifest) && !l.locks.some(has),
  );
  if (missingLocks.length > 0) {
    out.push({
      id: "lockfile",
      title: "Dependencies not pinned",
      why: "no lockfile committed, so installs are not reproducible",
      route: "auto",
      priority: 2,
      paths: missingLocks.map((l) => l.manifest),
    });
  }

  const pinned =
    TOOL_VERSION_FILES.some(has) ||
    files.some((f) => /(^|\/)Dockerfile[^/]*$/.test(f));
  if (!pinned && manifests.length > 0) {
    out.push({
      id: "tool-versions",
      title: "Tool versions not pinned",
      why: "no tool-version file, container or devcontainer fixes the runtime",
      route: "auto",
      priority: 2,
      paths: manifests.slice(0, 5),
    });
  }

  const workflows = files.filter((f) =>
    /^\.github\/workflows\/[^/]+\.ya?ml$/.test(f),
  );
  const entryPoints = files.filter(
    (f) =>
      BRINGUP_FILE_RE.test(f) ||
      (RUNNER_FILE_RE.test(f) && BRINGUP_TARGET_RE.test(io.readFile(f) ?? "")),
  );
  const ciRunsAgainstIt = workflows.some((w) => {
    const c = io.readFile(w) ?? "";
    return BRINGUP_CMD_RE.test(c) && TEST_CMD_RE.test(c);
  });
  if (entryPoints.length === 0 || !ciRunsAgainstIt) {
    out.push({
      id: "preview-environment",
      title: "No preview environment",
      why:
        entryPoints.length === 0
          ? "no bring-up entry point (compose file, task or make target) starts the stack from a PR's source"
          : "a bring-up entry point exists but no CI job runs tests against it",
      route: "plan",
      priority: 3,
      paths: entryPoints.length > 0 ? entryPoints : workflows.slice(0, 3),
    });
  }

  const sources = [
    ...manifests,
    ...files.filter((f) => /\.(go|rs|py|ts|js)$/.test(f)),
  ];
  if (!dependencyHit(io, LOGGING_RE, sources)) {
    out.push({
      id: "structured-logging",
      title: "No structured logging",
      why: "no structured logging library found in the dependencies or source",
      route: "review",
      priority: 4,
      paths: manifests.slice(0, 3),
      choices: ["pino / structlog / slog for the repo's language"],
    });
  }

  if (!dependencyHit(io, ERROR_RE, manifests)) {
    out.push({
      id: "error-tracking",
      title: "No error tracking",
      why: "no error-tracking SDK is a dependency; pick a provider before wiring it",
      route: "review",
      priority: 3,
      paths: manifests.slice(0, 3),
      choices: ["Sentry", "Rollbar", "Bugsnag"],
    });
  }

  if (!dependencyHit(io, TRACE_RE, manifests)) {
    out.push({
      id: "tracing-metrics",
      title: "No tracing or metrics",
      why: "no OpenTelemetry, Prometheus or StatsD client is a dependency",
      route: "plan",
      priority: 5,
      paths: manifests.slice(0, 3),
    });
  }

  const deployFiles = files.filter((f) => /\.(ya?ml|tf)$/.test(f));
  if (!dependencyHit(io, CANARY_RE, deployFiles)) {
    out.push({
      id: "staged-canary",
      title: "No staged or canary deploy",
      why: "no workflow or manifest stages a rollout or runs a canary",
      route: "plan",
      priority: 6,
      paths: workflows.slice(0, 3),
    });
  }
  return out;
}

// ─── Doc ──────────────────────────────────────────────────────────────────────

export function renderEnvironmentsDoc(findings: EnvFinding[]): string {
  const doc = renderPatrolDoc({
    title: "Environments patrol",
    items: findings.map((f) => ({
      priority: f.priority,
      title: f.title,
      why: f.choices ? `${f.why} (options: ${f.choices.join(", ")})` : f.why,
      paths: f.paths.length > 0 ? f.paths : ["."],
    })),
  });
  return findings.length === 0 ? `${doc}\nNo open items.\n` : doc;
}

// ─── Tasks ────────────────────────────────────────────────────────────────────

export interface ActiveTask {
  id: string;
  status: string;
}

export interface PlannedTask {
  id: string;
  title: string;
  source: "environments-fix";
  originKind: "cron";
  originRef: "environments";
  repo: string;
  kind: "dev" | "prd";
  status: "pending" | "blocked";
  hitl: boolean;
  layer: "Shared";
  branch?: string;
  blockedReason?: string;
  description: string;
}

export function isoWeekSuffix(d: Date): string {
  const t = new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()),
  );
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const yearStart = Date.UTC(t.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((t.getTime() - yearStart) / 86400000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

const ACTIVE = new Set(["pending", "in_progress", "blocked", "pr_open"]);

/** Shipwright's own preview-environment pattern, cited by the preview plan task. */
export const PREVIEW_PATTERN = `Reference pattern (Shipwright's own preview environment): one bring-up script used both locally and by a CI composite action, which brings the whole stack up from the PR's source in a throwaway cluster with no real credentials, then runs the smoke/canary and e2e suites against it. See docs/preview-environment.md, scripts/preview-env.ts, .github/actions/preview-env and preview/canary/ in app-vitals/shipwright.`;

/** One task per finding; skips findings that already have an active task. */
export function planTasks(
  findings: EnvFinding[],
  repo: string,
  active: ActiveTask[],
  clock: Clock,
): PlannedTask[] {
  const slug = (repo.split("/").pop() ?? repo).toLowerCase();
  const week = isoWeekSuffix(clock.now());
  const tasks: PlannedTask[] = [];
  for (const f of findings) {
    const prefix = `environments-${f.id}-${slug}-`;
    if (active.some((a) => a.id.startsWith(prefix) && ACTIVE.has(a.status)))
      continue;
    const base = {
      id: `${prefix}${week}`,
      source: "environments-fix" as const,
      originKind: "cron" as const,
      originRef: "environments" as const,
      repo,
      layer: "Shared" as const,
      description: `Environments patrol finding: ${f.title}\n\n${f.why}\n\nPaths: ${f.paths.join(", ")}${f.choices ? `\nOptions: ${f.choices.join(", ")}` : ""}\n\nCheck: ${f.id} | Route: ${f.route}`,
    };
    if (f.route === "plan") {
      tasks.push({
        ...base,
        title: `Environments plan: ${f.title}`,
        kind: "prd",
        status: "pending",
        hitl: true,
        description:
          f.id === "preview-environment"
            ? `${base.description}\n\n${PREVIEW_PATTERN}`
            : base.description,
      });
    } else {
      const branch = `fix/environments-${f.id}`;
      tasks.push(
        f.route === "review"
          ? {
              ...base,
              title: `Environments fix: ${f.title}`,
              kind: "dev",
              branch,
              status: "blocked",
              hitl: false,
              blockedReason: `needs-review: ${f.choices ? `choose one of ${f.choices.join(", ")}` : f.why}`,
            }
          : {
              ...base,
              title: `Environments fix: ${f.title}`,
              kind: "dev",
              branch,
              status: "pending",
              hitl: false,
            },
      );
    }
  }
  return tasks;
}

// ─── Run ──────────────────────────────────────────────────────────────────────

export interface RunResult {
  findings: EnvFinding[];
  doc: string;
  violations: Violation[];
  materiallyChanged: boolean;
  tasks: PlannedTask[];
  metrics: {
    outcome: "ok" | "no_op";
    findings: number;
    auto: number;
    review: number;
    plan: number;
  };
}

export function runEnvironmentsScan(opts: {
  repo: string;
  io: RepoIO;
  clock: Clock;
  currentDoc: string | null;
  activeTasks: ActiveTask[];
}): RunResult {
  const findings = scanRepo(opts.io);
  const doc = renderEnvironmentsDoc(findings);
  const materiallyChanged = isMaterialChange(opts.currentDoc, doc);
  const tasks = planTasks(findings, opts.repo, opts.activeTasks, opts.clock);
  const count = (r: Route) =>
    tasks.filter((t) =>
      r === "plan"
        ? t.kind === "prd"
        : r === "review"
          ? t.status === "blocked"
          : t.kind === "dev" && t.status === "pending",
    ).length;
  return {
    findings,
    doc,
    violations: validatePatrolDoc(doc),
    materiallyChanged,
    tasks,
    metrics: {
      outcome: tasks.length > 0 || materiallyChanged ? "ok" : "no_op",
      findings: findings.length,
      auto: count("auto"),
      review: count("review"),
      plan: count("plan"),
    },
  };
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

if (import.meta.main) {
  const args = process.argv.slice(2);
  const flag = (n: string) => {
    const i = args.indexOf(`--${n}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const repo = flag("repo");
  const root = flag("root");
  if (args[0] !== "scan" || !repo || !root) {
    console.error(
      "usage: environments-scan.ts scan --repo org/repo --root DIR [--doc PATH] [--active-tasks FILE] [--out FILE]",
    );
    process.exit(2);
  }
  const docPath = join(root, flag("doc") ?? "docs/patrols/environments.md");
  const activePath = flag("active-tasks");
  const result = runEnvironmentsScan({
    repo,
    io: dirIO(root),
    clock: SystemClock(),
    currentDoc: existsSync(docPath) ? readFileSync(docPath, "utf8") : null,
    activeTasks: activePath ? JSON.parse(readFileSync(activePath, "utf8")) : [],
  });
  const json = JSON.stringify(result, null, 2);
  const out = flag("out");
  if (out) writeFileSync(out, json);
  else console.log(json);
  process.exit(result.violations.length > 0 ? 1 : 0);
}
