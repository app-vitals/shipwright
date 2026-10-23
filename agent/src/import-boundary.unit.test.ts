/**
 * agent/src/import-boundary.unit.test.ts
 *
 * Enforces the one-way dependency between the two agent layers: files under
 * agent/src/coding/ may import agent/src/runtime/, never the reverse.
 * agent/src/index.ts is the composition root and the single file exempt from
 * the check (it wires the coding extension into the runtime); it lives
 * outside both directories, so scanning only runtime/ already exempts it.
 *
 * The allowed direction goes through the package specifier only: runtime is
 * the `@app-vitals/agent-runtime` workspace package (AGR-1.3), so no file
 * outside agent/src/runtime/ — coding/, the composition root, agent/scripts,
 * root scripts, plugins — may reach it with a relative path.
 *
 * Runs under `bun test`, so CI (task ci -> test:coverage) enforces it.
 */

import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";

const SRC = resolve(import.meta.dir);
const RUNTIME_DIR = join(SRC, "runtime");
const CODING_DIR = join(SRC, "coding");
const REPO_ROOT = resolve(SRC, "..", "..");
const THIS_FILE = resolve(import.meta.path);

// Directory names never scanned by the repo-wide walk: dependencies, build
// output, the self-contained Astro site, and dot-dirs (.git, .claude, ...).
const REPO_SCAN_SKIP_DIRS = new Set(["node_modules", "dist", "site"]);

// `from "./x"`, `import("./x")`, `import "./x"`, `mock.module("./x", ...)`
const RELATIVE_SPECIFIER =
  /(?:from|import|mock\.module|require)\s*\(?\s*["'](\.{1,2}\/[^"']+)["']/g;

function listTsFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return listTsFiles(full);
    return entry.name.endsWith(".ts") ? [full] : [];
  });
}

/** Every .ts file in the repo outside `excludeDir` (and the skip dirs). */
function listRepoTsFiles(dir: string, excludeDir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name.startsWith(".") || REPO_SCAN_SKIP_DIRS.has(entry.name)) {
        return [];
      }
      return full === excludeDir ? [] : listRepoTsFiles(full, excludeDir);
    }
    return entry.name.endsWith(".ts") ? [full] : [];
  });
}

function isInside(dir: string, path: string): boolean {
  return path === dir || path.startsWith(dir + sep);
}

/** Relative imports in `source` (located at `file`) that resolve into `forbiddenDir`. */
export function findImportsInto(
  file: string,
  source: string,
  forbiddenDir: string,
): string[] {
  const hits: string[] = [];
  for (const match of source.matchAll(RELATIVE_SPECIFIER)) {
    const target = resolve(dirname(file), match[1]);
    if (isInside(forbiddenDir, target)) hits.push(match[1]);
  }
  return hits;
}

describe("agent import boundary (coding -> runtime only)", () => {
  it("no runtime file imports a coding file", () => {
    const violations = listTsFiles(RUNTIME_DIR).flatMap((file) =>
      findImportsInto(file, readFileSync(file, "utf8"), CODING_DIR).map(
        (spec) => `${file.slice(SRC.length + 1)} -> ${spec}`,
      ),
    );
    expect(violations).toEqual([]);
  });

  it("detects a runtime -> coding import (checker self-test)", () => {
    const file = join(RUNTIME_DIR, "example.ts");
    expect(
      findImportsInto(
        file,
        `import { x } from "../coding/check-helpers.ts";`,
        CODING_DIR,
      ),
    ).toEqual(["../coding/check-helpers.ts"]);
    expect(
      findImportsInto(
        file,
        `const m = await import("../coding/extension.ts");`,
        CODING_DIR,
      ),
    ).toEqual(["../coding/extension.ts"]);
    expect(
      findImportsInto(file, `import { x } from "./clock.ts";`, CODING_DIR),
    ).toEqual([]);
  });
});

describe("runtime package boundary (@app-vitals/agent-runtime only)", () => {
  it("no coding file (tests included) relatively imports a runtime file", () => {
    const violations = listTsFiles(CODING_DIR).flatMap((file) =>
      findImportsInto(file, readFileSync(file, "utf8"), RUNTIME_DIR).map(
        (spec) => `${file.slice(SRC.length + 1)} -> ${spec}`,
      ),
    );
    expect(violations).toEqual([]);
  });

  it("no file outside agent/src/runtime relatively imports a runtime file", () => {
    const violations = listRepoTsFiles(REPO_ROOT, RUNTIME_DIR)
      .filter((file) => file !== THIS_FILE)
      .flatMap((file) =>
        findImportsInto(file, readFileSync(file, "utf8"), RUNTIME_DIR).map(
          (spec) => `${file.slice(REPO_ROOT.length + 1)} -> ${spec}`,
        ),
      );
    expect(violations).toEqual([]);
  });

  it("detects a coding -> relative runtime import (checker self-test)", () => {
    const file = join(CODING_DIR, "example.ts");
    expect(
      findImportsInto(
        file,
        `import { FixedClock } from "../runtime/clock.ts";`,
        RUNTIME_DIR,
      ),
    ).toEqual(["../runtime/clock.ts"]);
    expect(
      findImportsInto(
        file,
        `mock.module("../runtime/gh-helpers.ts", () => ({}));`,
        RUNTIME_DIR,
      ),
    ).toEqual(["../runtime/gh-helpers.ts"]);
    expect(
      findImportsInto(
        join(REPO_ROOT, "scripts", "example.ts"),
        `import { setup } from "../agent/src/runtime/setup.ts";`,
        RUNTIME_DIR,
      ),
    ).toEqual(["../agent/src/runtime/setup.ts"]);
    expect(
      findImportsInto(
        file,
        `import { FixedClock } from "@app-vitals/agent-runtime/clock";`,
        RUNTIME_DIR,
      ),
    ).toEqual([]);
  });
});
