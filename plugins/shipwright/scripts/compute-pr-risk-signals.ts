#!/usr/bin/env bun
// Deterministic PR risk signals (RSK-1.2).
//
// Computes a list of risk factors, each {factor, level, points, evidence}, from
// the shape of a PR: size, diffusion, sensitive paths, file history (git log)
// and verification evidence (tests, CI, CODEOWNERS). Levels use the same
// vocabulary as the review contract's `riskAssessment` (low | medium | high)
// so the output can feed it directly.
//
// Deliberately NO person-based signals: nothing here reads author identity,
// experience, reviewer load or incident rate. (The distinct-contributor count
// of a file's history is allowed; it is a property of the file, not the PR
// author.) Unknown input keys are ignored.
//
// The scoring (computeRiskSignals) is pure. All git/filesystem IO lives in
// collectFileHistory (injected runner) and the CLI at the bottom; history
// signals degrade to "unknown" (0 points) on any failure instead of throwing.
//
// CLI:
//   bun run plugins/shipwright/scripts/compute-pr-risk-signals.ts '{"files":[{"path":"src/a.ts","additions":10,"deletions":2}],"ci":{"status":"passing"},"repoDir":"."}'
// or pipe the same JSON blob via stdin. With "repoDir" set, file history and
// CODEOWNERS are collected from that checkout unless supplied inline.

// ─── Types ────────────────────────────────────────────────────────────────────

export type RiskLevel = "low" | "medium" | "high";

export type FileChange = {
  path: string;
  additions: number;
  deletions: number;
};

export type FileHistory = {
  commits90d: number;
  bugfixCommits: number;
  revertCommits: number;
  contributors: number;
  ageDays: number;
};

export type CiStatus = "passing" | "failing" | "pending" | "unknown";

export type RiskInput = {
  files: FileChange[];
  ci?: { status: CiStatus };
  /** Raw CODEOWNERS file content; omitted when unavailable. */
  codeowners?: string;
  /** Per-path history; null (or missing) means unknown. */
  history?: Record<string, FileHistory | null>;
};

export type RiskFactor = {
  factor: string;
  level: RiskLevel;
  points: number;
  evidence: string;
};

export type RiskSignals = {
  factors: RiskFactor[];
  totalPoints: number;
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

const levelFor = (points: number): RiskLevel =>
  points >= 4 ? "high" : points >= 2 ? "medium" : "low";

const factor = (
  name: string,
  points: number,
  evidence: string,
): RiskFactor => ({
  factor: name,
  level: levelFor(points),
  points,
  evidence,
});

const topLevel = (p: string): string =>
  p.includes("/") ? p.split("/")[0] : ".";
const dirOf = (p: string): string =>
  p.slice(0, Math.max(0, p.lastIndexOf("/"))) || ".";

// ─── size ─────────────────────────────────────────────────────────────────────

function sizeFactor(files: FileChange[]): RiskFactor {
  const added = files.reduce((s, x) => s + x.additions, 0);
  const deleted = files.reduce((s, x) => s + x.deletions, 0);
  const lines = added + deleted;
  const linePts = lines < 100 ? 0 : lines < 500 ? 2 : lines < 1000 ? 3 : 4;
  const n = files.length;
  const filePts = n < 15 ? 0 : n < 30 ? 1 : n < 60 ? 2 : 4;
  return factor(
    "size",
    linePts + filePts,
    `${lines} lines changed (+${added}/-${deleted}) across ${n} file${n === 1 ? "" : "s"}`,
  );
}

// ─── diffusion ────────────────────────────────────────────────────────────────

const SHARED_PATH = /(^|\/)(shared|common|libs?|core|utils?)\//i;

function normalizedEntropy(files: FileChange[]): number {
  const weights = files
    .map((x) => x.additions + x.deletions)
    .filter((w) => w > 0);
  if (weights.length < 2) return 0;
  const total = weights.reduce((s, w) => s + w, 0);
  const h = -weights.reduce(
    (s, w) => s + (w / total) * Math.log2(w / total),
    0,
  );
  return h / Math.log2(weights.length);
}

function diffusionFactor(files: FileChange[]): RiskFactor {
  const subsystems = new Set(files.map((x) => topLevel(x.path)));
  const dirs = new Set(files.map((x) => dirOf(x.path)));
  const shared = files.filter((x) => SHARED_PATH.test(x.path));
  const entropy = normalizedEntropy(files);
  const s = subsystems.size;
  let pts = s <= 1 ? 0 : s <= 3 ? 1 : s <= 5 ? 2 : 4;
  if (dirs.size >= 10) pts += 1;
  if (files.length >= 4 && entropy > 0.9) pts += 1;
  if (shared.length > 0) pts += 2;
  const parts = [
    `${s} top-level subsystem${s === 1 ? "" : "s"}`,
    `${dirs.size} director${dirs.size === 1 ? "y" : "ies"}`,
    `change entropy ${entropy.toFixed(2)}`,
  ];
  if (shared.length > 0) {
    parts.push(`shared-library paths: ${shared.map((x) => x.path).join(", ")}`);
  }
  return factor("diffusion", pts, parts.join("; "));
}

// ─── sensitive-paths ──────────────────────────────────────────────────────────

const SENSITIVE: { label: string; patterns: RegExp[] }[] = [
  {
    label: "auth/security",
    patterns: [
      /(^|\/)(auth|authn|authz|authentication|authorization|security|oauth|sso|crypto|secrets?|permissions?|rbac)([/._-]|$)/i,
    ],
  },
  {
    label: "migrations/schema",
    patterns: [/(^|\/)migrations?\//i, /schema\.(prisma|sql|rb)$/i, /\.sql$/i],
  },
  {
    label: "infra/CI/deploy",
    patterns: [
      /^\.github\/(workflows|actions)\//,
      /(^|\/)Dockerfile[^/]*$/,
      /(^|\/)docker-compose[^/]*\.ya?ml$/,
      /\.tf$/,
      /(^|\/)(terraform|helm|charts|k8s|kubernetes|deploy|infra)\//i,
      /\.gitlab-ci\.yml$/,
    ],
  },
  {
    label: "dependency manifests",
    patterns: [
      /(^|\/)(package\.json|bun\.lockb?|package-lock\.json|yarn\.lock|pnpm-lock\.yaml|go\.(mod|sum)|Cargo\.(toml|lock)|requirements[^/]*\.txt|Gemfile(\.lock)?|pyproject\.toml|poetry\.lock)$/,
    ],
  },
];

function sensitiveFactor(files: FileChange[]): RiskFactor {
  const hits: string[] = [];
  for (const cat of SENSITIVE) {
    const matched = files.filter((x) =>
      cat.patterns.some((re) => re.test(x.path)),
    );
    if (matched.length > 0) {
      hits.push(`${cat.label}: ${matched.map((x) => x.path).join(", ")}`);
    }
  }
  if (hits.length === 0) {
    return factor("sensitive-paths", 0, "no sensitive paths touched");
  }
  return factor("sensitive-paths", hits.length * 2, hits.join("; "));
}

// ─── file-history ─────────────────────────────────────────────────────────────

function historyFactor(
  files: FileChange[],
  history: RiskInput["history"],
): RiskFactor {
  const known = files
    .map((x) => history?.[x.path])
    .filter((h): h is FileHistory => !!h);
  if (known.length === 0) {
    return factor(
      "file-history",
      0,
      "file history unknown (not collected or git unavailable)",
    );
  }
  const sum = (k: "commits90d" | "bugfixCommits" | "revertCommits") =>
    known.reduce((s, h) => s + h[k], 0);
  const churn = sum("commits90d");
  const bugfix = sum("bugfixCommits");
  const reverts = sum("revertCommits");
  const contributors = Math.max(...known.map((h) => h.contributors));
  const youngest = Math.min(...known.map((h) => h.ageDays));
  let pts = 0;
  const ev: string[] = [];
  if (churn >= 20) {
    pts += 2;
    ev.push(`high recent churn (${churn} commits in 90d)`);
  } else if (churn >= 8) {
    pts += 1;
    ev.push(`moderate recent churn (${churn} commits in 90d)`);
  }
  if (bugfix >= 3) {
    pts += 2;
    ev.push(`${bugfix} bug-fix commits`);
  } else if (bugfix >= 1) {
    pts += 1;
    ev.push(`${bugfix} bug-fix commit${bugfix === 1 ? "" : "s"}`);
  }
  if (reverts >= 1) {
    pts += 1;
    ev.push(`${reverts} revert commit${reverts === 1 ? "" : "s"}`);
  }
  if (contributors >= 6) {
    pts += 2;
    ev.push(`${contributors} distinct contributors`);
  } else if (contributors >= 4) {
    pts += 1;
    ev.push(`${contributors} distinct contributors`);
  }
  if (youngest < 30) {
    pts += 1;
    ev.push(`young file (age ${youngest}d)`);
  }
  const note =
    known.length < files.length
      ? ` (history known for ${known.length}/${files.length} files)`
      : "";
  return factor(
    "file-history",
    pts,
    (ev.length > 0 ? ev.join("; ") : "no notable history signals") + note,
  );
}

// ─── evidence ─────────────────────────────────────────────────────────────────

const TEST_FILE = /(\.|_)(test|spec)\.[a-z]+$|(^|\/)(tests?|__tests__)\//i;
const CODE_FILE =
  /\.(ts|tsx|js|jsx|mjs|cjs|py|rb|go|rs|java|kt|swift|c|cc|cpp|h|cs|php|sh)$/i;

function testsFactor(files: FileChange[]): RiskFactor {
  const code = files.filter(
    (x) => CODE_FILE.test(x.path) && !TEST_FILE.test(x.path),
  );
  const tests = files.filter((x) => TEST_FILE.test(x.path));
  if (code.length === 0) {
    return factor(
      "evidence-tests",
      0,
      "no production code changed; tests not required",
    );
  }
  if (tests.length > 0) {
    return factor(
      "evidence-tests",
      0,
      `${code.length} code file(s) changed with ${tests.length} test file(s)`,
    );
  }
  const lines = code.reduce((s, x) => s + x.additions + x.deletions, 0);
  return factor(
    "evidence-tests",
    lines > 200 ? 3 : 2,
    `${code.length} code file(s) (${lines} lines) changed without any test changes`,
  );
}

function ciFactor(ci: RiskInput["ci"]): RiskFactor {
  switch (ci?.status) {
    case "passing":
      return factor("evidence-ci", 0, "CI passing");
    case "failing":
      return factor("evidence-ci", 4, "CI failing");
    case "pending":
      return factor("evidence-ci", 1, "CI still pending");
    default:
      return factor("evidence-ci", 0, "CI status unknown");
  }
}

type OwnerRule = { re: RegExp; owned: boolean };

function globToRegex(pattern: string): RegExp {
  const anchored =
    pattern.startsWith("/") || pattern.replace(/\/$/, "").includes("/");
  const body = pattern.replace(/^\//, "").replace(/\/$/, "");
  const src = body
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "@@GLOBSTAR@@")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    // `**/` matches zero or more directories (leading or between segments).
    .replace(/^@@GLOBSTAR@@\//, "(?:.*/)?")
    .replace(/\/@@GLOBSTAR@@\//g, "/(?:.*/)?")
    .replace(/@@GLOBSTAR@@/g, ".*");
  return new RegExp(`${anchored ? "^" : "(^|/)"}${src}(/|$)`);
}

function parseCodeowners(content: string): OwnerRule[] {
  const rules: OwnerRule[] = [];
  for (const raw of content.split("\n")) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const [pattern, ...owners] = line.split(/\s+/);
    rules.push({ re: globToRegex(pattern), owned: owners.length > 0 });
  }
  return rules;
}

function codeownersFactor(
  files: FileChange[],
  codeowners?: string,
): RiskFactor {
  if (codeowners === undefined) {
    return factor(
      "evidence-codeowners",
      0,
      "CODEOWNERS coverage unknown (no CODEOWNERS provided)",
    );
  }
  const rules = parseCodeowners(codeowners);
  const uncovered = files.filter((x) => {
    let owned = false; // last matching rule wins
    for (const r of rules) if (r.re.test(x.path)) owned = r.owned;
    return !owned;
  });
  if (uncovered.length === 0) {
    return factor(
      "evidence-codeowners",
      0,
      "all changed files covered by CODEOWNERS",
    );
  }
  const pts = uncovered.length / files.length >= 0.5 ? 2 : 1;
  return factor(
    "evidence-codeowners",
    pts,
    `${uncovered.length}/${files.length} changed files lack a CODEOWNERS owner: ${uncovered.map((x) => x.path).join(", ")}`,
  );
}

// ─── computeRiskSignals (pure) ────────────────────────────────────────────────

export function computeRiskSignals(input: RiskInput): RiskSignals {
  const { files } = input;
  const factors = [
    sizeFactor(files),
    diffusionFactor(files),
    sensitiveFactor(files),
    historyFactor(files, input.history),
    testsFactor(files),
    ciFactor(input.ci),
    codeownersFactor(files, input.codeowners),
  ];
  return { factors, totalPoints: factors.reduce((s, x) => s + x.points, 0) };
}

// ─── git history collection (IO injected) ─────────────────────────────────────

export type GitRunner = (args: string[]) => Promise<string>;

const FIELD = "\x1f";
const DAY = 86400;

/**
 * `seen` is shared across all paths of one PR: commit-count fields
 * (commits90d / bugfixCommits / revertCommits) only count a commit hash the
 * first time it is seen, so summing them across files counts each commit once.
 * contributors and ageDays are per-file and use every row.
 */
function parseHistory(
  out: string,
  nowSec: number,
  seen: Set<string>,
): FileHistory | null {
  const rows = out.split("\n").filter((l) => l.trim().length > 0);
  if (rows.length === 0) return null;
  const emails = new Set<string>();
  let commits90d = 0;
  let bugfix = 0;
  let reverts = 0;
  let oldest = nowSec;
  for (const row of rows) {
    const [hash, email, ts, ...subj] = row.split(FIELD);
    const subject = subj.join(FIELD);
    const t = Number(ts);
    if (!Number.isFinite(t)) continue;
    emails.add(email ?? "");
    oldest = Math.min(oldest, t);
    if (seen.has(hash)) continue;
    seen.add(hash);
    if (nowSec - t <= 90 * DAY) commits90d++;
    if (/^revert\b/i.test(subject)) reverts++;
    else if (/\b(fix(es|ed)?|bug|hotfix|regression)\b/i.test(subject)) bugfix++;
  }
  return {
    commits90d,
    bugfixCommits: bugfix,
    revertCommits: reverts,
    contributors: emails.size,
    ageDays: Math.floor((nowSec - oldest) / DAY),
  };
}

/** Never throws: any failure for a path yields null (unknown, 0 points). */
export async function collectFileHistory(
  paths: string[],
  run: GitRunner,
  nowSec: number = Math.floor(Date.now() / 1000),
): Promise<Record<string, FileHistory | null>> {
  const outputs = await Promise.all(
    paths.map(async (p): Promise<string | null> => {
      try {
        return await run([
          "log",
          "-n",
          "200",
          `--format=%H${FIELD}%ae${FIELD}%at${FIELD}%s`,
          "--",
          p,
        ]);
      } catch {
        return null;
      }
    }),
  );
  // Parse sequentially in path order so commit de-duplication is deterministic.
  const seen = new Set<string>();
  return Object.fromEntries(
    paths.map((p, i) => {
      const out = outputs[i];
      return [p, out === null ? null : parseHistory(out, nowSec, seen)];
    }),
  );
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

type CliInput = RiskInput & { repoDir?: string };

function parseCliInput(raw: string): CliInput {
  const parsed = JSON.parse(raw) as Partial<CliInput>;
  if (!Array.isArray(parsed.files)) {
    throw new Error('Input JSON must have a "files" array');
  }
  for (const x of parsed.files) {
    if (
      typeof x?.path !== "string" ||
      typeof x.additions !== "number" ||
      typeof x.deletions !== "number"
    ) {
      throw new Error(
        'Each "files" entry needs string "path" and numeric "additions"/"deletions"',
      );
    }
  }
  return {
    files: parsed.files,
    ci: parsed.ci,
    codeowners: parsed.codeowners,
    history: parsed.history,
    repoDir: parsed.repoDir,
  };
}

async function gitRunner(repoDir: string): Promise<GitRunner> {
  return async (args) => {
    const proc = Bun.spawn(["git", "-C", repoDir, ...args], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const out = await new Response(proc.stdout).text();
    if ((await proc.exited) !== 0) throw new Error("git failed");
    return out;
  };
}

async function readCodeowners(repoDir: string): Promise<string | undefined> {
  for (const rel of ["CODEOWNERS", ".github/CODEOWNERS", "docs/CODEOWNERS"]) {
    try {
      return await Bun.file(`${repoDir}/${rel}`).text();
    } catch {
      // try next location
    }
  }
  return undefined;
}

if (import.meta.main) {
  const arg = process.argv[2];
  const raw = arg && arg.length > 0 ? arg : await Bun.stdin.text();
  const input = parseCliInput(raw);
  if (input.repoDir) {
    if (!input.history) {
      input.history = await collectFileHistory(
        input.files.map((x) => x.path),
        await gitRunner(input.repoDir),
      );
    }
    if (input.codeowners === undefined) {
      input.codeowners = await readCodeowners(input.repoDir);
    }
  }
  console.log(JSON.stringify(computeRiskSignals(input)));
}
