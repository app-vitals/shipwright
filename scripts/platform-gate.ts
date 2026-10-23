/**
 * scripts/platform-gate.ts
 *
 * Copy-paste-readiness gate (AEP-4.1). Walks the import closure of the
 * platform set described by platform-manifest.json and reports every edge that
 * leaves it, so the set can be copied into its own repository unchanged.
 *
 * What counts as an edge: every module specifier in `import`, `import type`,
 * `export ... from`, side-effect `import "x"`, dynamic `import("x")`,
 * `require("x")` and `mock.module("x")`, in any file of the set (tests
 * included). Relative specifiers, `@shipwright/*` workspace specifiers,
 * `@app-vitals/agent-runtime/*` (agent/src/runtime) and
 * `@app-vitals/agent-admin[/*]` (admin, per its exports map) must resolve to a
 * file inside the set. npm packages and `node:`/`bun:` builtins
 * are not edges. `@app-vitals/agent-lib/*` modules are the one allowed way out of
 * admin/agent directories, and only if listed in the manifest's `lib` table.
 *
 * Exports are pure/fs-light so platform-gate.unit.test.ts can drive them with
 * a fixture tree; platform-manifest.unit.test.ts runs them on the real repo.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, posix } from "node:path";

/**
 * Non-platform consumers of a lib module. "coding" covers agent/src/coding,
 * admin/src/coding, plugins/, root scripts and anything else outside the other
 * values; "lib" is another lib module outside the set (itself shared).
 */
export type SharedWith =
  | "coding"
  | "task-store"
  | "chat"
  | "metrics"
  | "mcp-server"
  | "lib";
export const SHARED_WITH_VALUES: readonly SharedWith[] = [
  "coding",
  "task-store",
  "chat",
  "metrics",
  "mcp-server",
  "lib",
];

export interface LibModuleEntry {
  /** Module path under lib/ without extension, e.g. "sentry" or "web/toolbar". */
  module: string;
  tag: "platform-only" | "shared";
  /** Non-platform consumers; required for `shared`, empty for `platform-only`. */
  sharedWith: SharedWith[];
}

export interface Exemption {
  from: string;
  to: string;
  reason: string;
}

export interface PlatformManifest {
  version: 1;
  /** Repo-relative globs of files that move. */
  include: string[];
  /** Repo-relative globs carved out of `include`. */
  exclude: string[];
  lib: LibModuleEntry[];
  /** Git-ignored generated paths (e.g. the Prisma client) that exist only after codegen; imports of them stay in-set. */
  generated: string[];
  /** Entry files that wire the set to a consumer (e.g. coding) and stay per consumer; kept out of the set. */
  compositionRoots: { path: string; reason: string }[];
  /** Must stay empty; present so a new exemption is a visible diff. */
  exemptions: Exemption[];
}

export type ViolationReason =
  | "outside-set"
  | "unlisted-lib-module"
  | "missing-lib-module"
  | "unresolved";

export interface Violation {
  from: string;
  specifier: string;
  target: string;
  reason: ViolationReason;
}

export interface ClosureResult {
  /** Repo-relative paths of every file in the set. */
  files: string[];
  violations: Violation[];
  exempted: Violation[];
}

// ---------------------------------------------------------------------------
// Specifier extraction
// ---------------------------------------------------------------------------

type Token = { t: "id" | "str" | "p" | "tpl"; v: string };

const ID_START = /[A-Za-z_$]/;
const ID_PART = /[A-Za-z0-9_$]/;

/** Minimal JS/TS lexer: skips comments, keeps string contents, one token per template literal. */
function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === "/" && src[i + 1] === "/") {
      while (i < n && src[i] !== "\n") i++;
    } else if (c === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      i = end === -1 ? n : end + 2;
    } else if (c === '"' || c === "'") {
      let v = "";
      i++;
      while (i < n && src[i] !== c && src[i] !== "\n") {
        if (src[i] === "\\") {
          v += src[i + 1] ?? "";
          i += 2;
        } else v += src[i++];
      }
      i++;
      tokens.push({ t: "str", v });
    } else if (c === "`") {
      let depth = 0;
      i++;
      while (i < n && !(src[i] === "`" && depth === 0)) {
        if (src[i] === "\\") i += 2;
        else if (src[i] === "$" && src[i + 1] === "{") {
          depth++;
          i += 2;
        } else if (src[i] === "}" && depth > 0) {
          depth--;
          i++;
        } else i++;
      }
      i++;
      tokens.push({ t: "tpl", v: "" });
    } else if (ID_START.test(c)) {
      let j = i + 1;
      while (j < n && ID_PART.test(src[j])) j++;
      tokens.push({ t: "id", v: src.slice(i, j) });
      i = j;
    } else if (/\s/.test(c)) {
      i++;
    } else {
      tokens.push({ t: "p", v: c });
      i++;
    }
  }
  return tokens;
}

/** Every module specifier referenced by `source`. */
export function extractSpecifiers(source: string): string[] {
  const tokens = tokenize(source);
  const out: string[] = [];
  for (let k = 0; k < tokens.length; k++) {
    const tok = tokens[k];
    if (tok.t !== "str") continue;
    const prev = tokens[k - 1];
    if (!prev) continue;
    if (prev.t === "id" && (prev.v === "from" || prev.v === "import")) {
      out.push(tok.v);
    } else if (prev.t === "p" && prev.v === "(") {
      const callee = tokens[k - 2];
      if (callee?.t === "id" && ["import", "require"].includes(callee.v)) {
        out.push(tok.v);
      } else if (
        callee?.t === "id" &&
        callee.v === "module" &&
        tokens[k - 3]?.v === "." &&
        tokens[k - 4]?.v === "mock"
      ) {
        out.push(tok.v);
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

export function validateManifest(m: PlatformManifest): string[] {
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const entry of m.lib) {
    if (seen.has(entry.module))
      errors.push(`duplicate lib module: ${entry.module}`);
    seen.add(entry.module);
    if (entry.tag === "platform-only" && entry.sharedWith.length > 0) {
      errors.push(
        `lib/${entry.module}: platform-only must not list sharedWith`,
      );
    }
    if (entry.tag === "shared" && entry.sharedWith.length === 0) {
      errors.push(`lib/${entry.module}: shared must list sharedWith consumers`);
    }
    for (const who of entry.sharedWith) {
      if (!SHARED_WITH_VALUES.includes(who)) {
        errors.push(`lib/${entry.module}: unknown sharedWith "${who}"`);
      }
    }
  }
  return errors;
}

export function loadManifest(path: string): PlatformManifest {
  return JSON.parse(readFileSync(path, "utf8")) as PlatformManifest;
}

// ---------------------------------------------------------------------------
// Closure
// ---------------------------------------------------------------------------

const SOURCE_EXT = /\.(?:ts|tsx|js|mjs|cjs)$/;

function libFile(module: string): string {
  return `lib/${module}.ts`;
}

function listFiles(root: string, patterns: string[]): string[] {
  const found = new Set<string>();
  for (const pattern of patterns) {
    const glob = new Bun.Glob(pattern);
    for (const file of glob.scanSync({
      cwd: root,
      onlyFiles: true,
      dot: true,
    })) {
      if (file.split("/").includes("node_modules")) continue;
      found.add(file);
    }
  }
  return [...found].sort();
}

/** Files that make up the platform set (globs minus excludes, plus listed lib modules and their unit tests). */
export function collectSetFiles(root: string, m: PlatformManifest): string[] {
  const excluded = m.exclude.map((p) => new Bun.Glob(p));
  const roots = new Set(m.compositionRoots.map((r) => r.path));
  const files = new Set(
    listFiles(root, m.include).filter(
      (f) => !roots.has(f) && !excluded.some((g) => g.match(f)),
    ),
  );
  for (const entry of m.lib) {
    const main = libFile(entry.module);
    files.add(main);
    const unit = main.replace(/\.ts$/, ".unit.test.ts");
    if (existsSync(join(root, unit))) files.add(unit);
  }
  return [...files].sort();
}

/** Maps a workspace specifier to the repo-relative path it resolves to, or null if not a workspace specifier. */
function workspaceTarget(spec: string): string | null {
  const libMatch = /^@app-vitals\/agent-lib(?:\/(.*))?$/.exec(spec);
  if (libMatch) return libMatch[1] ? `lib/${libMatch[1]}` : "lib";
  const runtimeMatch = /^@app-vitals\/agent-runtime(?:\/(.*))?$/.exec(spec);
  if (runtimeMatch) {
    return runtimeMatch[1]
      ? `agent/src/runtime/${runtimeMatch[1]}`
      : "agent/src/runtime";
  }
  const adminMatch = /^@app-vitals\/agent-admin(?:\/(.*))?$/.exec(spec);
  if (adminMatch) return adminTarget(adminMatch[1]);
  const m = /^@shipwright\/([^/]+)(?:\/(.*))?$/.exec(spec);
  if (!m) return null;
  const [, pkg, rest] = m;
  const dir = pkg === "plugin" ? "plugins/shipwright" : pkg;
  const src = pkg === "task-store" || pkg === "chat" || pkg === "mcp-server";
  if (!rest) return src ? `${dir}/src/index.ts` : dir;
  return src ? `${dir}/src/${rest}` : `${dir}/${rest}`;
}

/**
 * Mirrors admin/package.json's exports map: the root is src/server.ts, the
 * package-root files (specs, prisma schema/migrations/config, package.json)
 * map to admin/, every other subpath (modules, coding/*) to admin/src/.
 */
function adminTarget(rest: string | undefined): string {
  if (!rest) return "admin/src/server.ts";
  if (
    /^(?:prisma\/|prisma\.config$|openapi[^/]*\.json$|package\.json$)/.test(
      rest,
    )
  ) {
    return `admin/${rest}`;
  }
  return `admin/src/${rest}`;
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** Resolves a repo-relative candidate (maybe extensionless / directory) to an existing repo-relative file. */
function resolveFile(root: string, candidate: string): string | null {
  const tries = [
    candidate,
    `${candidate}.ts`,
    `${candidate}.tsx`,
    `${candidate}.json`,
    candidate.replace(/\.js$/, ".ts"),
    posix.join(candidate, "index.ts"),
  ];
  return tries.find((t) => isFile(join(root, t))) ?? null;
}

export function analyzeClosure(
  root: string,
  m: PlatformManifest,
): ClosureResult {
  const files = collectSetFiles(root, m);
  const inSet = new Set(files);
  const listedLib = new Set(m.lib.map((e) => libFile(e.module)));
  const generated = m.generated.map((p) => new Bun.Glob(p));
  const violations: Violation[] = [];
  const exempted: Violation[] = [];

  const record = (v: Violation) => {
    const isExempt = m.exemptions.some(
      (e) => e.from === v.from && e.to === v.target,
    );
    (isExempt ? exempted : violations).push(v);
  };

  for (const entry of m.lib) {
    const file = libFile(entry.module);
    if (!existsSync(join(root, file))) {
      record({
        from: "platform-manifest.json",
        specifier: entry.module,
        target: file,
        reason: "missing-lib-module",
      });
    }
  }

  for (const from of files) {
    if (!SOURCE_EXT.test(from) || !isFile(join(root, from))) continue;
    const source = readFileSync(join(root, from), "utf8");
    for (const specifier of extractSpecifiers(source)) {
      let candidate: string;
      if (specifier.startsWith(".")) {
        candidate = posix.normalize(posix.join(dirname(from), specifier));
      } else {
        const ws = workspaceTarget(specifier);
        if (ws === null) continue; // npm package or node:/bun: builtin
        candidate = ws;
      }
      if (generated.some((g) => g.match(candidate))) continue;
      const target = resolveFile(root, candidate);
      if (target === null) {
        // A workspace package that is not part of the set is a leak even if
        // its entry file cannot be resolved from this checkout.
        const foreign =
          !specifier.startsWith(".") &&
          !/^(?:lib|admin|agent)(?:\/|$)/.test(candidate);
        record({
          from,
          specifier,
          target: candidate,
          reason: foreign ? "outside-set" : "unresolved",
        });
      } else if (!inSet.has(target)) {
        const isLib = target.startsWith("lib/") && !listedLib.has(target);
        record({
          from,
          specifier,
          target,
          reason: isLib ? "unlisted-lib-module" : "outside-set",
        });
      }
    }
  }
  return { files, violations, exempted };
}

/** Human-readable one-line form for assertion output. */
export function formatViolation(v: Violation): string {
  return `${v.from} -> ${v.specifier} (${v.target}) [${v.reason}]`;
}

// ---------------------------------------------------------------------------
// Lib tag verification
// ---------------------------------------------------------------------------

const TAG_SCAN_SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "site",
  "docs",
  "planning",
  "dist",
  "client", // generated Prisma clients
]);

function listSourceFiles(root: string, dir = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (TAG_SCAN_SKIP_DIRS.has(entry.name)) continue;
      out.push(...listSourceFiles(root, posix.join(dir, entry.name)));
    } else if (/\.tsx?$/.test(entry.name)) {
      out.push(posix.join(dir, entry.name));
    }
  }
  return out;
}

function consumerOf(file: string): SharedWith {
  const top = file.split("/")[0];
  if (top === "lib") return "lib";
  if (["task-store", "chat", "metrics", "mcp-server"].includes(top)) {
    return top as SharedWith;
  }
  return "coding";
}

/**
 * Verifies the manifest's lib tags against reality: for every listed module,
 * the set of non-platform consumers that import it must equal `sharedWith`
 * (empty for platform-only). Returns human-readable errors.
 */
export function checkLibTags(root: string, m: PlatformManifest): string[] {
  const inSet = new Set(collectSetFiles(root, m));
  const listed = new Map(m.lib.map((e) => [libFile(e.module), e]));
  const actual = new Map<string, Set<SharedWith>>();
  for (const e of m.lib) actual.set(e.module, new Set());

  for (const from of listSourceFiles(root)) {
    if (inSet.has(from)) continue;
    const source = readFileSync(join(root, from), "utf8");
    for (const specifier of extractSpecifiers(source)) {
      let candidate: string | null = null;
      if (specifier.startsWith(".")) {
        candidate = posix.normalize(posix.join(dirname(from), specifier));
      } else {
        candidate = workspaceTarget(specifier);
      }
      if (candidate === null || !candidate.startsWith("lib/")) continue;
      const target = resolveFile(root, candidate);
      const entry = target ? listed.get(target) : undefined;
      if (entry) actual.get(entry.module)?.add(consumerOf(from));
    }
  }

  const errors: string[] = [];
  for (const e of m.lib) {
    const got = [...(actual.get(e.module) ?? [])].sort();
    const want = [...e.sharedWith].sort();
    if (e.tag === "platform-only" && got.length > 0) {
      errors.push(
        `lib/${e.module} is tagged platform-only but is imported by: ${got.join(", ")}`,
      );
    } else if (e.tag === "shared") {
      const missing = got.filter((g) => !want.includes(g as SharedWith));
      const stale = want.filter((w) => !got.includes(w));
      if (missing.length > 0) {
        errors.push(
          `lib/${e.module} is also imported by ${missing.join(", ")}; add to sharedWith`,
        );
      }
      if (stale.length > 0) {
        errors.push(
          `lib/${e.module} lists sharedWith ${stale.join(", ")} but nothing there imports it`,
        );
      }
    }
  }
  return errors;
}
