#!/usr/bin/env bun
/**
 * scripts/audit-extraction.ts
 *
 * Pre-publication audit of an extracted tree (AGR-2.1). Run it against the
 * output of scripts/extract-platform.ts - and, in history mode, its FULL git
 * history - before the repository is made public. Public repositories keep
 * every ref forever, so the audit exits non-zero on ANY finding.
 *
 * Checks:
 *   1. secrets          gitleaks (when on PATH) plus a built-in scanner over the
 *                       working tree and `git log --all -p` (added lines only)
 *   2. banned-strings   internal hostnames, cloud project/cluster identifiers,
 *                       private-repo references, internal product names; the
 *                       working tree always, history with --history-banned
 *   3. license          LICENSE (MIT) at the tree root, consistent package.json
 *                       `license` fields
 *   4. artifacts        node_modules, dist/build output, *.tsbuildinfo, coverage,
 *                       .env files, worktrees/, nested .git - in the tree AND in
 *                       any commit reachable from any ref
 *
 * Every finding is { rule, file, commit ("working-tree" or a sha), line?,
 * excerpt }. Secret values are never printed in full: excerpts are redacted.
 *
 * Usage:
 *   bun scripts/audit-extraction.ts <tree> [--json] [--report <path>]
 *     [--history-banned] [--no-gitleaks]
 *
 * Exit codes: 0 clean, 1 findings, 2 usage error.
 */

import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export const WORKING_TREE = "working-tree";

export interface Finding {
  rule: string;
  file: string;
  /** A commit sha, or "working-tree". */
  commit: string;
  line?: number;
  /** Redacted for secrets. */
  excerpt: string;
}

export interface BannedRule {
  id: string;
  description: string;
  pattern: RegExp;
}

export interface AllowRule {
  id: string;
  description: string;
  pattern: RegExp;
}

export interface BannedMatch {
  rule: string;
  line: number;
  match: string;
  excerpt: string;
}

// ---------------------------------------------------------------------------
// Secret shapes (redaction + detection)
// ---------------------------------------------------------------------------

export interface SecretRule {
  id: string;
  pattern: RegExp;
}

const PLACEHOLDER = /example|placeholder|changeme|dummy|your[_-]|xxxx|\*{4}/i;

/** Shannon entropy in bits per character. */
export function entropy(s: string): number {
  const counts = new Map<string, number>();
  for (const c of s) counts.set(c, (counts.get(c) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

export const SECRET_RULES: readonly SecretRule[] = [
  { id: "secret/aws-access-key", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { id: "secret/github-token", pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g },
  {
    id: "secret/github-fine-grained-pat",
    pattern: /\bgithub_pat_[A-Za-z0-9_]{22,}\b/g,
  },
  {
    // Real shapes only: xoxb-<digits>-<digits>-<alnum>, rotating xoxe.xoxp-1-<b64>, xapp-1-...
    id: "secret/slack-token",
    pattern:
      /\bxox[abeprs]-\d{8,}-\d{8,}(?:-\d{8,})?-[A-Za-z0-9]{16,}|\bxoxe\.xox[bp]-\d-[A-Za-z0-9]{40,}|\bxapp-\d-[A-Z0-9]{8,}-\d{8,}-[a-z0-9]{40,}/g,
  },
  {
    // Flagged only when real key material follows (or the header ends its
    // line, i.e. a multi-line PEM); short fixture bodies ("\\nmock\\n") pass.
    id: "secret/private-key",
    pattern:
      /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY(?: BLOCK)?-----(?=\s*$|(?:\\n|\s)*[A-Za-z0-9+/=]{40})/g,
  },
  { id: "secret/anthropic-key", pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  {
    // key/secret/token/password assigned a long quoted, high-entropy literal
    id: "secret/generic-api-key",
    pattern:
      /\b(?:api[_-]?key|secret(?:[_-]?key)?|access[_-]?token|auth[_-]?token|password)["']?\s*[:=]\s*["']([A-Za-z0-9/+_=-]{24,})["']/gi,
  },
];

/** Redacts one secret: keeps a short prefix so a human can recognise the shape. */
export function redactValue(value: string): string {
  return `${value.slice(0, 4)}[REDACTED:${value.length}]`;
}

interface SecretHit {
  rule: string;
  value: string;
}

/** Secret-shaped substrings of `text` (full values; callers must redact before printing). */
export function findSecrets(text: string): SecretHit[] {
  const hits: SecretHit[] = [];
  for (const rule of SECRET_RULES) {
    for (const m of text.matchAll(new RegExp(rule.pattern))) {
      const value = m[1] ?? m[0];
      if (rule.id === "secret/generic-api-key") {
        if (PLACEHOLDER.test(value) || entropy(value) < 3.5) continue;
      }
      hits.push({ rule: rule.id, value: m[0] });
    }
  }
  return hits;
}

/** Replaces every secret-shaped substring so the line is safe to print. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const hit of findSecrets(text)) {
    out = out.split(hit.value).join(redactValue(hit.value));
  }
  return out;
}

const EXCERPT_MAX = 160;

export function makeExcerpt(line: string): string {
  const safe = redactSecrets(line).trim();
  return safe.length > EXCERPT_MAX ? `${safe.slice(0, EXCERPT_MAX)}...` : safe;
}

// ---------------------------------------------------------------------------
// Check 2: banned strings
// ---------------------------------------------------------------------------

// Rule patterns are regexes (never the literal identifiers), so this file does
// not trip `task check-strings` itself.
export const BANNED_RULES: readonly BannedRule[] = [
  {
    id: "banned/internal-product",
    description: "internal product name (any casing or separator)",
    pattern: /\bvitals[-_ ]?os\b/gi,
  },
  {
    id: "banned/private-repo",
    description: "reference to a private app-vitals repository",
    pattern:
      /\bapp-vitals\/(?:marketplace|vitals[-]os|squadron|factorymode|marketing-site|supplement-cert-platform|infra|terraform)\b/gi,
  },
  {
    id: "banned/internal-hostname",
    description: "internal DNS name (.internal, .corp, cluster-local FQDN)",
    pattern:
      /\b[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)*\.(?:internal|corp|intranet|svc\.cluster\.local)\b/gi,
  },
  {
    id: "banned/gcp-identifier",
    description: "GCP project, GKE cluster or service-account identifier",
    pattern:
      /\bgke_[a-z0-9-]+_[a-z0-9-]+_[a-z0-9-]+|\b[a-z0-9-]+@[a-z][a-z0-9-]{4,28}\.iam\.gserviceaccount\.com\b|\b(?:gcr\.io|[a-z]+-docker\.pkg\.dev)\/[a-z][a-z0-9-]{4,28}\//gi,
  },
  {
    id: "banned/internal-env",
    description: "internal environment/product env-var prefix",
    pattern: /\bVITALS[_]OS_[A-Z_]+/g,
  },
];

export const BANNED_ALLOWLIST: readonly AllowRule[] = [
  {
    id: "allow/public-repo",
    description: "public app-vitals repositories",
    pattern: /\bapp-vitals\/(?:shipwright|agent(?:-[a-z]+)?)\b/gi,
  },
  {
    id: "allow/placeholder-hosts",
    description: "RFC 2606 placeholder hosts (example.com/.test/.invalid)",
    pattern:
      /\b[a-z0-9.-]*(?:example\.(?:com|org|net|test)|\.test|\.invalid|\.localhost)\b/gi,
  },
];

/**
 * Finds banned strings in `text`. A match is dropped when it lies entirely
 * inside a span matched by an allow rule on the same line, so a line carrying
 * both an allowed token and a banned one still reports the banned one.
 */
export function matchBannedStrings(
  text: string,
  rules: readonly BannedRule[] = BANNED_RULES,
  allowlist: readonly AllowRule[] = BANNED_ALLOWLIST,
): BannedMatch[] {
  const out: BannedMatch[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const allowed: Array<[number, number]> = [];
    for (const allow of allowlist) {
      for (const m of line.matchAll(new RegExp(allow.pattern))) {
        const start = m.index ?? 0;
        allowed.push([start, start + m[0].length]);
      }
    }
    for (const rule of rules) {
      for (const m of line.matchAll(new RegExp(rule.pattern))) {
        const start = m.index ?? 0;
        const end = start + m[0].length;
        if (allowed.some(([a, b]) => start >= a && end <= b)) continue;
        out.push({
          rule: rule.id,
          line: i + 1,
          match: m[0],
          excerpt: makeExcerpt(line),
        });
      }
    }
  }
  return out;
}

/**
 * Working-tree paths whose content intentionally holds banned strings:
 * a committed migration is immutable (editing it changes its checksum), so its
 * historical Sentry-issue comment stays as-is.
 */
export const BANNED_PATH_ALLOWLIST: readonly RegExp[] = [
  /^admin\/prisma\/migrations\/20261009000000_chat_token_usage_bigint\//,
];

// ---------------------------------------------------------------------------
// Check 4: generated artifacts
// ---------------------------------------------------------------------------

const ARTIFACT_DIRS = new Map<string, string>([
  ["node_modules", "artifact/node_modules"],
  ["dist", "artifact/build-output"],
  ["build", "artifact/build-output"],
  [".next", "artifact/build-output"],
  [".turbo", "artifact/build-output"],
  ["coverage", "artifact/coverage"],
  ["worktrees", "artifact/worktrees"],
]);

const ENV_TEMPLATE = /^\.env\.(?:example|sample|template|dist)$/;

/** Rule id when a repo-relative path is (or sits inside) a generated artifact, else null. */
export function matchArtifactPath(path: string): string | null {
  const segs = path.split("/").filter(Boolean);
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i] ?? "";
    const dirRule = ARTIFACT_DIRS.get(seg);
    if (dirRule) return dirRule;
    if (seg === ".git" && i > 0) return "artifact/nested-git";
  }
  const base = segs[segs.length - 1] ?? "";
  if (base.endsWith(".tsbuildinfo")) return "artifact/tsbuildinfo";
  if ((base === ".env" || base.startsWith(".env.")) && !ENV_TEMPLATE.test(base))
    return "artifact/env-file";
  return null;
}

// ---------------------------------------------------------------------------
// Check 3: license
// ---------------------------------------------------------------------------

export interface LicenseInputs {
  /** LICENSE file text, or null when absent. */
  license: string | null;
  /** package.json contents keyed by repo-relative path. */
  packages: Record<string, string>;
}

export function checkLicense(input: LicenseInputs): Finding[] {
  const out: Finding[] = [];
  const add = (rule: string, file: string, excerpt: string) =>
    out.push({ rule, file, commit: WORKING_TREE, excerpt });

  if (input.license === null) {
    add("license/missing", "LICENSE", "LICENSE file not found at tree root");
  } else if (
    !/^\s*MIT License\b/.test(input.license) ||
    !/Permission is hereby granted, free of charge/.test(input.license)
  ) {
    add("license/not-mit", "LICENSE", "LICENSE is not the MIT license text");
  }

  const rootRaw = input.packages["package.json"];
  let rootLicense: unknown;
  if (rootRaw === undefined) {
    add("license/package-json", "package.json", "root package.json missing");
  } else {
    try {
      rootLicense = (JSON.parse(rootRaw) as { license?: unknown }).license;
    } catch {
      add("license/package-json", "package.json", "unparseable package.json");
    }
    if (rootLicense !== "MIT" && rootRaw !== undefined) {
      add(
        "license/package-json",
        "package.json",
        `root "license" is ${JSON.stringify(rootLicense)}, expected "MIT"`,
      );
    }
  }
  for (const [file, raw] of Object.entries(input.packages)) {
    if (file === "package.json") continue;
    let lic: unknown;
    try {
      lic = (JSON.parse(raw) as { license?: unknown }).license;
    } catch {
      add("license/package-json", file, "unparseable package.json");
      continue;
    }
    if (lic !== undefined && lic !== "MIT") {
      add(
        "license/package-json",
        file,
        `"license" is ${JSON.stringify(lic)}, inconsistent with LICENSE (MIT)`,
      );
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// History scanning
// ---------------------------------------------------------------------------

const MAX_LINE = 4000;
const COMMIT_MARK = "\u0001COMMIT ";

export type LineChecker = (
  line: string,
) => Array<{ rule: string; excerpt: string }>;

/**
 * Stateful parser for `git log -p --format=\x01COMMIT %H` output. Feed it one
 * line at a time; it calls `check` on every ADDED line and reports findings
 * with the commit, file and new-file line number.
 */
export function createPatchScanner(check: LineChecker, sink: Finding[]) {
  let commit = "";
  let file = "";
  let lineNo = 0;
  let inHunk = false;
  return (raw: string) => {
    if (raw.startsWith(COMMIT_MARK)) {
      commit = raw.slice(COMMIT_MARK.length).trim();
      file = "";
      inHunk = false;
      return;
    }
    if (raw.startsWith("diff --git ")) {
      inHunk = false;
      return;
    }
    if (!inHunk) {
      if (raw.startsWith("+++ ")) {
        const p = raw.slice(4);
        file = p === "/dev/null" ? "" : p.replace(/^b\//, "");
      } else if (raw.startsWith("@@")) {
        const m = /\+(\d+)/.exec(raw);
        lineNo = m ? Number(m[1]) - 1 : 0;
        inHunk = true;
      }
      return;
    }
    if (raw.startsWith("@@")) {
      const m = /\+(\d+)/.exec(raw);
      lineNo = m ? Number(m[1]) - 1 : lineNo;
      return;
    }
    if (raw.startsWith("+")) {
      lineNo++;
      const text = raw.slice(1, 1 + MAX_LINE);
      for (const hit of check(text)) {
        sink.push({
          rule: hit.rule,
          file,
          commit,
          line: lineNo,
          excerpt: hit.excerpt,
        });
      }
    } else if (raw.startsWith(" ")) {
      lineNo++;
    }
  };
}

/** Line checker for secrets: one result per secret-shaped substring. */
export const secretLineChecker: LineChecker = (line) =>
  findSecrets(line).map((h) => ({
    rule: h.rule,
    excerpt: makeExcerpt(line),
  }));

/** Line checker for banned strings. */
export const bannedLineChecker: LineChecker = (line) =>
  matchBannedStrings(line).map((m) => ({
    rule: m.rule,
    excerpt: m.excerpt,
  }));

async function streamLines(
  cmd: string[],
  cwd: string,
  onLine: (line: string) => void,
): Promise<number> {
  const proc = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of proc.stdout) {
    buf += decoder.decode(chunk, { stream: true });
    let nl = buf.indexOf("\n");
    while (nl !== -1) {
      onLine(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
      nl = buf.indexOf("\n");
    }
  }
  if (buf) onLine(buf);
  return await proc.exited;
}

export function isGitRepo(tree: string): boolean {
  return existsSync(join(tree, ".git"));
}

/** Scans added lines in every commit reachable from any ref. */
export async function scanHistoryPatches(
  tree: string,
  checks: LineChecker[],
): Promise<Finding[]> {
  const findings: Finding[] = [];
  const scan = createPatchScanner(
    (line) => checks.flatMap((c) => c(line)),
    findings,
  );
  const code = await streamLines(
    [
      "git",
      "log",
      "--all",
      "-p",
      "--no-color",
      "--no-ext-diff",
      "--no-renames",
      `--format=${COMMIT_MARK}%H`,
    ],
    tree,
    scan,
  );
  if (code !== 0) throw new Error(`git log -p failed (exit ${code})`);
  return findings;
}

/** Every path ever committed on any ref that is a generated artifact. Reports the oldest commit per path. */
export async function scanHistoryArtifacts(tree: string): Promise<Finding[]> {
  const oldest = new Map<string, Finding>();
  let commit = "";
  const code = await streamLines(
    [
      "git",
      "-c",
      "core.quotepath=off",
      "log",
      "--all",
      "--name-only",
      "--no-renames",
      `--format=${COMMIT_MARK}%H`,
    ],
    tree,
    (line) => {
      if (line.startsWith(COMMIT_MARK)) {
        commit = line.slice(COMMIT_MARK.length).trim();
        return;
      }
      if (!line) return;
      const rule = matchArtifactPath(line);
      if (!rule) return;
      // log is newest-first, so later sightings are older: overwrite.
      oldest.set(`${rule}\0${line}`, {
        rule,
        file: line,
        commit,
        excerpt: `${line} (committed in history)`,
      });
    },
  );
  if (code !== 0) throw new Error(`git log --name-only failed (exit ${code})`);
  return [...oldest.values()];
}

// ---------------------------------------------------------------------------
// gitleaks
// ---------------------------------------------------------------------------

interface GitleaksLeak {
  RuleID?: string;
  File?: string;
  Commit?: string;
  StartLine?: number;
  Match?: string;
  Secret?: string;
}

/** Converts a gitleaks JSON report into findings. The secret value is never copied; only a redacted match. */
export function parseGitleaksReport(json: string): Finding[] {
  const raw = json.trim() ? (JSON.parse(json) as GitleaksLeak[] | null) : [];
  return (raw ?? []).map((l) => {
    let excerpt = l.Match ?? "";
    if (l.Secret) excerpt = excerpt.split(l.Secret).join("REDACTED");
    return {
      rule: `gitleaks/${l.RuleID ?? "unknown"}`,
      file: l.File ?? "",
      commit: l.Commit ?? WORKING_TREE,
      line: l.StartLine,
      excerpt: makeExcerpt(excerpt),
    };
  });
}

export function gitleaksAvailable(): boolean {
  return Bun.which("gitleaks") !== null;
}

export function runGitleaks(tree: string): Finding[] {
  const dir = mkdtempSync(join(tmpdir(), "audit-gitleaks-"));
  const report = join(dir, "report.json");
  try {
    const p = Bun.spawnSync(
      [
        "gitleaks",
        "detect",
        "--source",
        tree,
        "--log-opts=--all",
        "--redact",
        "--no-banner",
        "--report-format",
        "json",
        "--report-path",
        report,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    if (p.exitCode !== 0 && p.exitCode !== 1) {
      return [
        {
          rule: "gitleaks/error",
          file: "",
          commit: WORKING_TREE,
          excerpt: `gitleaks exited ${p.exitCode}: ${p.stderr.toString().trim().slice(0, 200)}`,
        },
      ];
    }
    return existsSync(report)
      ? parseGitleaksReport(readFileSync(report, "utf8"))
      : [];
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Working-tree walk
// ---------------------------------------------------------------------------

export interface WalkResult {
  /** Artifact findings (directories are reported, not descended into). */
  artifacts: Finding[];
  /** Regular files to content-scan, repo-relative. */
  files: string[];
}

export function walkTree(tree: string): WalkResult {
  const artifacts: Finding[] = [];
  const files: string[] = [];
  const visit = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const abs = join(dir, name);
      const rel = relative(tree, abs).split("\\").join("/");
      if (rel === ".git") continue;
      const st = lstatSync(abs);
      const rule = matchArtifactPath(rel);
      if (rule) {
        artifacts.push({
          rule,
          file: rel,
          commit: WORKING_TREE,
          excerpt: st.isDirectory() ? `${rel}/ (directory)` : rel,
        });
        if (st.isDirectory()) continue;
      }
      if (st.isDirectory()) visit(abs);
      else if (st.isFile()) files.push(rel);
    }
  };
  visit(tree);
  return { artifacts, files };
}

function readText(abs: string): string | null {
  const raw = readFileSync(abs);
  if (raw.includes(0)) return null;
  return raw.toString("utf8");
}

function scanContent(
  tree: string,
  files: string[],
  opts: { banned: boolean; secrets: boolean },
): Finding[] {
  const out: Finding[] = [];
  for (const file of files) {
    const text = readText(join(tree, file));
    if (text === null) continue;
    const lines = text.split("\n");
    const pathAllowed = BANNED_PATH_ALLOWLIST.some((re) => re.test(file));
    for (let i = 0; i < lines.length; i++) {
      const line = (lines[i] ?? "").slice(0, MAX_LINE);
      if (opts.secrets) {
        for (const hit of findSecrets(line)) {
          out.push({
            rule: hit.rule,
            file,
            commit: WORKING_TREE,
            line: i + 1,
            excerpt: makeExcerpt(line),
          });
        }
      }
      if (opts.banned && !pathAllowed) {
        for (const m of matchBannedStrings(line)) {
          out.push({
            rule: m.rule,
            file,
            commit: WORKING_TREE,
            line: i + 1,
            excerpt: m.excerpt,
          });
        }
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export interface AuditOptions {
  tree: string;
  historyBanned: boolean;
  useGitleaks: boolean;
}

export interface AuditResult {
  findings: Finding[];
  notices: string[];
}

function collectPackages(
  tree: string,
  files: string[],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of files) {
    if (f === "package.json" || f.endsWith("/package.json"))
      out[f] = readFileSync(join(tree, f), "utf8");
  }
  return out;
}

export async function auditTree(opts: AuditOptions): Promise<AuditResult> {
  const tree = resolve(opts.tree);
  if (!existsSync(tree)) throw new Error(`tree not found: ${tree}`);
  const notices: string[] = [];
  const findings: Finding[] = [];

  const { artifacts, files } = walkTree(tree);
  findings.push(...artifacts);
  findings.push(...scanContent(tree, files, { banned: true, secrets: true }));

  const licensePath = join(tree, "LICENSE");
  findings.push(
    ...checkLicense({
      license: existsSync(licensePath)
        ? readFileSync(licensePath, "utf8")
        : null,
      packages: collectPackages(tree, files),
    }),
  );

  if (isGitRepo(tree)) {
    if (opts.useGitleaks) {
      if (gitleaksAvailable()) findings.push(...runGitleaks(tree));
      else
        notices.push(
          "gitleaks not found on PATH - skipped (built-in history scanner still ran; install gitleaks for full coverage)",
        );
    }
    const checks = [secretLineChecker];
    if (opts.historyBanned) checks.push(bannedLineChecker);
    findings.push(...(await scanHistoryPatches(tree, checks)));
    findings.push(...(await scanHistoryArtifacts(tree)));
  } else {
    notices.push(
      "no .git directory - git history was NOT audited (working tree only)",
    );
  }
  return { findings: dedupe(findings), notices };
}

export function dedupe(findings: Finding[]): Finding[] {
  const seen = new Set<string>();
  const out: Finding[] = [];
  for (const f of findings) {
    const key = [f.rule, f.file, f.commit, f.line ?? ""].join("\0");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(f);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

export function formatReport(result: AuditResult): string {
  const lines: string[] = [];
  for (const n of result.notices) lines.push(`NOTICE: ${n}`);
  if (result.findings.length === 0) {
    lines.push("AUDIT PASSED: no findings");
    return lines.join("\n");
  }
  const byRule = new Map<string, number>();
  for (const f of result.findings)
    byRule.set(f.rule, (byRule.get(f.rule) ?? 0) + 1);
  lines.push(`AUDIT FAILED: ${result.findings.length} finding(s)`);
  for (const [rule, n] of [...byRule].sort())
    lines.push(`  ${n.toString().padStart(4)}  ${rule}`);
  lines.push("");
  for (const f of result.findings) {
    const commit = f.commit === WORKING_TREE ? f.commit : f.commit.slice(0, 12);
    const where = f.line ? `${f.file}:${f.line}` : f.file;
    lines.push(`[${f.rule}] ${where} @ ${commit}`);
    lines.push(`    ${f.excerpt}`);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export interface CliOptions extends AuditOptions {
  json: boolean;
  report: string | null;
}

export function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    tree: "",
    historyBanned: false,
    useGitleaks: true,
    json: false,
    report: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    if (arg === "--json") opts.json = true;
    else if (arg === "--history-banned") opts.historyBanned = true;
    else if (arg === "--no-gitleaks") opts.useGitleaks = false;
    else if (arg === "--report") {
      const v = argv[++i];
      if (v === undefined) throw new Error("--report needs a value");
      opts.report = v;
    } else if (arg.startsWith("--"))
      throw new Error(`unknown argument: ${arg}`);
    else if (!opts.tree) opts.tree = arg;
    else throw new Error(`unexpected argument: ${arg}`);
  }
  if (!opts.tree) throw new Error("<tree> is required");
  return opts;
}

if (import.meta.main) {
  let opts: CliOptions;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error((err as Error).message);
    console.error(
      "usage: bun scripts/audit-extraction.ts <tree> [--json] [--report <path>] [--history-banned] [--no-gitleaks]",
    );
    process.exit(2);
  }
  let result: AuditResult;
  try {
    result = await auditTree(opts);
  } catch (err) {
    console.error(`audit could not run: ${(err as Error).message}`);
    process.exit(2);
  }
  const json = JSON.stringify(result, null, 2);
  if (opts.report) writeFileSync(opts.report, `${json}\n`);
  console.log(opts.json ? json : formatReport(result));
  process.exit(result.findings.length > 0 ? 1 : 0);
}
