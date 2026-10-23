#!/usr/bin/env bun
/**
 * scripts/extract-platform.ts
 *
 * Re-runnable platform extraction (AGR-1.5). Reads platform-manifest.json and
 * produces the app-vitals/agent tree in an output directory:
 *
 *   agent/src/runtime/**, agent/src/fixtures/**, agent/Dockerfile, ... -> runtime/
 *   admin/**                                                          -> admin/
 *   lib/<listed modules>                                              -> lib/
 *   specialties/specialist/**, docs/schemas/specialty.schema.json     -> agent-types/
 *
 * History mode (default) runs `git filter-repo` over the manifest paths with
 * `--paths-from-file` renames, so history is preserved, then commits the
 * specifier/config rewrite as one commit with a fixed author and date. It is
 * deterministic: the same source commit yields the same tree and the same
 * commit hashes. `--no-history` copies the files only (fast rehearsal).
 *
 * The script never pushes and never touches the source repository.
 *
 * Usage:
 *   bun scripts/extract-platform.ts --out <dir> [--no-history] [--ref <rev>]
 *                                   [--source <repo>] [--clean]
 *
 * Requires git-filter-repo (history mode only): `pip install git-filter-repo`.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix, resolve } from "node:path";
import {
  collectSetFiles,
  extractSpecifiers,
  loadManifest,
} from "./platform-gate";

/** Source prefix -> extracted prefix. A prefix ending in "/" is a directory; anything else is one exact file. First match wins. */
export const PATH_RENAMES: ReadonlyArray<readonly [string, string]> = [
  ["agent/src/runtime/", "runtime/"],
  ["agent/src/fixtures/", "runtime/fixtures/"],
  ["agent/src/entrypoint-main.ts", "runtime/entrypoint-main.ts"],
  ["agent/Dockerfile", "runtime/Dockerfile"],
  ["agent/workspace/", "runtime/workspace/"],
  ["specialties/specialist/", "agent-types/specialist/"],
  ["docs/schemas/specialty.schema.json", "agent-types/specialty.schema.json"],
];

/** Files the extracted tree needs that the manifest globs do not name. */
export const EXTRA_FILES: readonly string[] = ["lib/package.json"];

/** Top-level source paths exported from the commit; everything the manifest can match lives under one of them. */
const SOURCE_ROOTS = [
  "agent",
  "admin",
  "lib",
  "specialties",
  "docs/schemas",
  "platform-manifest.json",
];

/** Workspace scope rewritten on extraction. */
const OLD_SCOPE = "@shipwright/";
const NEW_SCOPE = "@app-vitals/";

/** Maps a repo-relative source path (file or directory, with or without extension) to its path in the extracted tree. */
export function mapPath(path: string): string {
  for (const [from, to] of PATH_RENAMES) {
    if (from.endsWith("/")) {
      if (path.startsWith(from)) return to + path.slice(from.length);
      if (path === from.slice(0, -1)) return to.slice(0, -1);
    } else if (path === from) {
      return to;
    }
  }
  return path;
}

function relativeSpec(fromFile: string, target: string): string {
  const rel = posix.relative(posix.dirname(fromFile), target);
  return rel.startsWith(".") ? rel : `./${rel}`;
}

function rewriteSpecifier(spec: string, fromFile: string): string {
  if (spec.startsWith(OLD_SCOPE))
    return NEW_SCOPE + spec.slice(OLD_SCOPE.length);
  if (!spec.startsWith("./") && !spec.startsWith("../")) return spec;
  const target = posix.join(posix.dirname(fromFile), spec);
  const next = relativeSpec(mapPath(fromFile), mapPath(target));
  // Keep a trailing "/" and the original "./" style stable when nothing moved.
  return next === spec || posix.normalize(next) === posix.normalize(spec)
    ? spec
    : next;
}

/** Rewrites relative and workspace module specifiers in a TS/JS source file. `fromFile` is the repo-relative source path. */
export function rewriteSource(source: string, fromFile: string): string {
  let out = source;
  for (const spec of new Set(extractSpecifiers(source))) {
    const next = rewriteSpecifier(spec, fromFile);
    if (next === spec) continue;
    for (const q of ['"', "'"]) {
      out = out.split(`${q}${spec}${q}`).join(`${q}${next}${q}`);
    }
  }
  return out;
}

function renameScopedKeys(
  obj: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!obj) return obj;
  return Object.fromEntries(
    Object.entries(obj).map(([k, v]) => [
      k.startsWith(OLD_SCOPE) ? NEW_SCOPE + k.slice(OLD_SCOPE.length) : k,
      v,
    ]),
  );
}

function rewritePathValue(value: string, fromFile: string): string {
  if (!value.startsWith("./") && !value.startsWith("../")) return value;
  const target = posix.join(posix.dirname(fromFile), value);
  return relativeSpec(mapPath(fromFile), mapPath(target));
}

/**
 * Rewrites a package.json or tsconfig*.json: the `@shipwright/` scope in the
 * name and dependency keys, and relative `extends`, `paths` and `references`
 * values. Returns the input unchanged (formatting preserved) when nothing moves.
 */
export function rewriteJson(source: string, fromFile: string): string {
  const base = posix.basename(fromFile);
  const isPackage = base === "package.json";
  const isTsconfig = /^tsconfig.*\.json$/.test(base);
  if (!isPackage && !isTsconfig) return source;
  const json = JSON.parse(source) as {
    name?: unknown;
    extends?: unknown;
    references?: Array<{ path?: unknown }>;
    compilerOptions?: { paths?: Record<string, string[]> };
    [key: string]: unknown;
  };
  if (isPackage) {
    if (typeof json.name === "string" && json.name.startsWith(OLD_SCOPE)) {
      json.name = NEW_SCOPE + json.name.slice(OLD_SCOPE.length);
    }
    for (const key of [
      "dependencies",
      "devDependencies",
      "peerDependencies",
      "optionalDependencies",
    ]) {
      json[key] = renameScopedKeys(json[key] as Record<string, unknown>);
    }
  } else {
    if (typeof json.extends === "string") {
      json.extends = rewritePathValue(json.extends, fromFile);
    }
    const paths = json.compilerOptions?.paths;
    if (json.compilerOptions && paths) {
      json.compilerOptions.paths = Object.fromEntries(
        Object.entries(paths).map(([k, vs]) => [
          k.startsWith(OLD_SCOPE) ? NEW_SCOPE + k.slice(OLD_SCOPE.length) : k,
          vs.map((v) => rewritePathValue(v, fromFile)),
        ]),
      );
    }
    if (Array.isArray(json.references)) {
      for (const ref of json.references) {
        if (typeof ref.path === "string") {
          ref.path = rewritePathValue(ref.path, fromFile);
        }
      }
    }
  }
  const next = `${JSON.stringify(json, null, 2)}\n`;
  return JSON.stringify(JSON.parse(source)) === JSON.stringify(json)
    ? source
    : next;
}

const TS_SOURCE = /\.(?:ts|tsx|js|mjs|cjs)$/;

/** Applies the content rewrite appropriate for `fromFile`. */
export function rewriteFile(content: string, fromFile: string): string {
  if (TS_SOURCE.test(fromFile)) return rewriteSource(content, fromFile);
  if (fromFile.endsWith(".json")) return rewriteJson(content, fromFile);
  return content;
}

/** Source paths to extract, sorted, with the generated paths removed. Operates on a directory containing the exported commit. */
export function planFiles(root: string): string[] {
  const manifest = loadManifest(join(root, "platform-manifest.json"));
  const generated = manifest.generated.map((g) => new Bun.Glob(g));
  const files = new Set(collectSetFiles(root, manifest));
  for (const extra of EXTRA_FILES) {
    if (existsSync(join(root, extra))) files.add(extra);
  }
  return [...files]
    .filter(
      (f) =>
        !generated.some((g) => g.match(f)) &&
        !f.startsWith("worktrees/") &&
        !f.split("/").includes("node_modules"),
    )
    .sort();
}

// ---------------------------------------------------------------------------
// Git plumbing
// ---------------------------------------------------------------------------

function run(
  cmd: string[],
  opts: { cwd?: string; env?: Record<string, string> } = {},
): string {
  const proc = Bun.spawnSync(cmd, {
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (proc.exitCode !== 0) {
    throw new Error(
      `${cmd.join(" ")} failed (${proc.exitCode}): ${proc.stderr.toString().trim()}`,
    );
  }
  return proc.stdout.toString().trim();
}

function hasFilterRepo(): boolean {
  return Bun.spawnSync(["git", "filter-repo", "--version"], {
    stdout: "ignore",
    stderr: "ignore",
  }).success;
}

function exportCommit(source: string, sha: string, dest: string): void {
  const roots = SOURCE_ROOTS.filter(
    (r) =>
      run(["git", "ls-tree", "--name-only", sha, r], { cwd: source }) !== "",
  );
  const tarball = join(dest, "..", "export.tar");
  run(["git", "archive", "-o", tarball, sha, "--", ...roots], { cwd: source });
  mkdirSync(dest, { recursive: true });
  run(["tar", "-xf", tarball, "-C", dest]);
}

function writeRewritten(
  exported: string,
  files: string[],
  out: string,
): number {
  let changed = 0;
  for (const file of files) {
    const raw = readFileSync(join(exported, file));
    const dest = join(out, mapPath(file));
    mkdirSync(dirname(dest), { recursive: true });
    if (TS_SOURCE.test(file) || file.endsWith(".json")) {
      const text = raw.toString("utf8");
      const next = rewriteFile(text, file);
      if (next !== text) changed++;
      writeFileSync(dest, next);
    } else {
      writeFileSync(dest, raw);
    }
  }
  return changed;
}

export interface ExtractOptions {
  /** Repository to extract from. */
  source: string;
  /** Commit-ish in `source`; resolved once so reruns on the same commit are identical. */
  ref: string;
  out: string;
  history: boolean;
  clean: boolean;
}

export interface ExtractResult {
  sha: string;
  files: number;
  /** HEAD of the output repository; null in --no-history mode. */
  head: string | null;
}

export function extractPlatform(opts: ExtractOptions): ExtractResult {
  const source = resolve(opts.source);
  const out = resolve(opts.out);
  const sha = run(["git", "rev-parse", "--verify", `${opts.ref}^{commit}`], {
    cwd: source,
  });

  if (existsSync(out) && readdirSync(out).length > 0) {
    if (!opts.clean) {
      throw new Error(`${out} is not empty (pass --clean to replace it)`);
    }
    rmSync(out, { recursive: true, force: true });
  }
  if (opts.history && !hasFilterRepo()) {
    throw new Error(
      "git-filter-repo not found (pip install git-filter-repo), or use --no-history",
    );
  }

  const scratch = mkdtempSync(join(tmpdir(), "extract-platform-"));
  try {
    const exported = join(scratch, "tree");
    exportCommit(source, sha, exported);
    const files = planFiles(exported);
    mkdirSync(out, { recursive: true });

    if (!opts.history) {
      writeRewritten(exported, files, out);
      return { sha, files: files.length, head: null };
    }

    run(["git", "init", "-q", "-b", "main", out]);
    run(["git", "fetch", "-q", "--no-tags", source, sha], { cwd: out });
    run(["git", "reset", "-q", "--hard", "FETCH_HEAD"], { cwd: out });
    const pathsFile = join(scratch, "paths.txt");
    // --paths-from-file selects (literal paths); renames are separate args,
    // since a rename line in the file would not select anything.
    writeFileSync(pathsFile, `${files.join("\n")}\n`);
    const renames = PATH_RENAMES.flatMap(([from, to]) => [
      "--path-rename",
      `${from}:${to}`,
    ]);
    run(
      [
        "git",
        "filter-repo",
        "--force",
        "--paths-from-file",
        pathsFile,
        ...renames,
      ],
      { cwd: out },
    );
    rmSync(join(out, ".git", "filter-repo"), { recursive: true, force: true });

    // filter-repo preserves file content as of each commit; rewrite the tip
    // in one fixed-identity commit so the result is reproducible.
    const changed = writeRewritten(exported, files, out);
    run(["git", "add", "-A"], { cwd: out });
    const dirty = Bun.spawnSync(["git", "diff", "--cached", "--quiet"], {
      cwd: out,
    }).exitCode;
    if (changed > 0 || dirty !== 0) {
      const date = run(["git", "show", "-s", "--format=%cI", sha], {
        cwd: source,
      });
      const ident = {
        GIT_AUTHOR_NAME: "extract-platform",
        GIT_AUTHOR_EMAIL: "extract-platform@app-vitals.invalid",
        GIT_AUTHOR_DATE: date,
        GIT_COMMITTER_NAME: "extract-platform",
        GIT_COMMITTER_EMAIL: "extract-platform@app-vitals.invalid",
        GIT_COMMITTER_DATE: date,
      };
      run(
        [
          "git",
          "commit",
          "-q",
          "--no-gpg-sign",
          "-m",
          `chore: rewrite specifiers for the extracted layout\n\nSource commit: ${sha}`,
        ],
        { cwd: out, env: ident },
      );
    }
    return {
      sha,
      files: files.length,
      head: run(["git", "rev-parse", "HEAD"], { cwd: out }),
    };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export function parseArgs(argv: string[]): ExtractOptions {
  const opts: ExtractOptions = {
    source: resolve(import.meta.dir, ".."),
    ref: "HEAD",
    out: "",
    history: true,
    clean: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${arg} needs a value`);
      return v;
    };
    if (arg === "--out") opts.out = value();
    else if (arg === "--ref") opts.ref = value();
    else if (arg === "--source") opts.source = value();
    else if (arg === "--no-history") opts.history = false;
    else if (arg === "--clean") opts.clean = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!opts.out) throw new Error("--out <dir> is required");
  return opts;
}

if (import.meta.main) {
  try {
    const result = extractPlatform(parseArgs(process.argv.slice(2)));
    console.log(
      `extracted ${result.files} files from ${result.sha}${result.head ? ` (head ${result.head})` : " (no history)"}`,
    );
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
}
