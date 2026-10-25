#!/usr/bin/env bun
/**
 * agent/scripts/check-lib-resolution.ts
 *
 * Image-level lib resolution guard (AGR-4.1). Finds every
 * `@app-vitals/agent-lib/*` (registry package) and `@shipwright/lib/*` (the
 * slim local workspace) import in the given source directories and resolves
 * each one from the importing file, so an image that ships without the lib
 * sources or the node_modules they resolve through fails its build instead of
 * crash-looping at boot (the 0.100.0 class: lib/ missing from the image).
 *
 * The Dockerfiles run it in the final stage, after every COPY, so it checks
 * the filesystem that actually ships, not the build stage's.
 *
 * Usage:
 *   bun agent/scripts/check-lib-resolution.ts [--require <prefix>]... <dir>...
 *
 * `--require` fails the check when no import with that prefix is found, so
 * the guard cannot pass vacuously (e.g. after a bad grep or an empty COPY).
 * Test files are skipped: they do not run in the image.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const LIB_PREFIXES = ["@app-vitals/agent-lib", "@shipwright/lib"];

// `from "x"`, `import "x"`, `import("x")` where x is a lib specifier.
const LIB_IMPORT =
  /\b(?:from|import)\s*\(?\s*["']((?:@app-vitals\/agent-lib|@shipwright\/lib)\/[^"']+)["']/g;

export interface SourceFile {
  path: string;
  source: string;
}

export interface LibImport {
  specifier: string;
  from: string;
}

export interface ResolutionResult {
  checked: LibImport[];
  failures: { specifier: string; from: string; error: string }[];
  /** Required prefixes with no import at all. */
  missingRequired: string[];
}

/** Every lib import in `files`, one entry per (file, specifier). */
export function findLibImports(files: SourceFile[]): LibImport[] {
  const out: LibImport[] = [];
  for (const file of files) {
    const seen = new Set<string>();
    for (const m of file.source.matchAll(LIB_IMPORT)) {
      if (seen.has(m[1])) continue;
      seen.add(m[1]);
      out.push({ specifier: m[1], from: file.path });
    }
  }
  return out;
}

/** Resolves each lib import from its importing file's directory. */
export function checkLibResolution(
  files: SourceFile[],
  resolve: (specifier: string, fromDir: string) => string,
  required: string[] = [],
): ResolutionResult {
  const checked = findLibImports(files);
  const failures: ResolutionResult["failures"] = [];
  for (const { specifier, from } of checked) {
    try {
      resolve(specifier, dirname(from));
    } catch (err) {
      failures.push({ specifier, from, error: (err as Error).message });
    }
  }
  const missingRequired = required.filter(
    (prefix) => !checked.some((i) => i.specifier.startsWith(`${prefix}/`)),
  );
  return { checked, failures, missingRequired };
}

/** Non-test .ts files under `dir` (skipping node_modules). */
export function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules") out.push(...listSourceFiles(full));
    } else if (
      /\.tsx?$/.test(entry.name) &&
      !/\.test\.tsx?$/.test(entry.name)
    ) {
      out.push(full);
    }
  }
  return out;
}

function main(argv: string[]): number {
  const required: string[] = [];
  const dirs: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--require") {
      const prefix = argv[++i];
      if (!prefix) {
        console.error("--require needs a prefix");
        return 2;
      }
      required.push(prefix);
    } else {
      dirs.push(argv[i]);
    }
  }
  if (dirs.length === 0) {
    console.error(
      "usage: check-lib-resolution.ts [--require <prefix>]... <dir>...",
    );
    return 2;
  }
  const files = dirs.flatMap(listSourceFiles).map((path) => ({
    path,
    source: readFileSync(path, "utf8"),
  }));
  const result = checkLibResolution(
    files,
    (spec, fromDir) => Bun.resolveSync(spec, fromDir),
    required,
  );
  for (const f of result.failures) {
    console.error(`unresolved: ${f.specifier} (from ${f.from}): ${f.error}`);
  }
  for (const prefix of result.missingRequired) {
    console.error(`no ${prefix}/* import found under ${dirs.join(", ")}`);
  }
  if (result.failures.length > 0 || result.missingRequired.length > 0) {
    return 1;
  }
  const unique = new Set(result.checked.map((i) => i.specifier));
  console.log(
    `lib resolution OK: ${unique.size} specifiers across ${result.checked.length} imports`,
  );
  return 0;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
