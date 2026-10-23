/**
 * admin/src/import-boundary.unit.test.ts
 *
 * Enforces the one-way dependency inside admin/src: platform files may not
 * import admin/src/coding/; coding/ may import platform code, never the
 * reverse. admin/src/main.ts is the composition root and the single file
 * exempt from the check (it wires the coding extension into the platform).
 *
 * Also asserts nothing under admin/src (outside coding/) imports from outside
 * admin/ other than @app-vitals/agent-lib/* and npm packages, so the platform set
 * can be copied into its own repo. coding/ is exempt (plugins/task-store/brand).
 *
 * Consumers reach admin through the package specifier only: admin is the
 * `@app-vitals/agent-admin` workspace package (AGR-1.4), so no file outside
 * admin/ — the agent runtime, root scripts, task-store, plugins, brand,
 * specialties — may import it with a relative path or the retired
 * `@shipwright/admin` name.
 *
 * Runs under `bun test`, so CI (task ci -> test:coverage) enforces it.
 */

import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";

const SRC = resolve(import.meta.dir);
const ADMIN_DIR = resolve(SRC, "..");
const CODING_DIR = join(SRC, "coding");
const COMPOSITION_ROOT = join(SRC, "main.ts");
// This file's self-test fixtures contain violating import strings.
const SELF = join(SRC, "import-boundary.unit.test.ts");
const REPO_ROOT = resolve(ADMIN_DIR, "..");

// Directory names never scanned by the repo-wide walk: dependencies, build
// output, the self-contained Astro site, and dot-dirs (.git, .claude, ...).
const REPO_SCAN_SKIP_DIRS = new Set(["node_modules", "dist", "site"]);

// Files whose admin-looking specifiers are fixture strings written into a
// temp tree, not imports: the platform gate's own unit test.
const REPO_SCAN_FIXTURE_FILES = new Set([
  join(REPO_ROOT, "scripts", "platform-gate.unit.test.ts"),
]);

// The retired workspace name, in any module specifier.
const RETIRED_SPECIFIER = /["'](@shipwright\/admin(?:\/[^"']*)?)["']/g;

// Keywords inside a quoted string (e.g. an assertion on source text) are not
// imports, so the keyword must not directly follow a quote or backtick.
// `from "./x"`, `import("./x")`, `import "./x"`, `mock.module("./x", ...)`
const RELATIVE_SPECIFIER =
  /(?<!["'`])\b(?:from|import|mock\.module|require)\s*\(?\s*["'](\.{1,2}\/[^"']+)["']/g;

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

/** `@shipwright/admin[/...]` specifiers in `source`. */
export function findRetiredSpecifiers(source: string): string[] {
  return [...source.matchAll(RETIRED_SPECIFIER)].map((m) => m[1]);
}

function isInside(dir: string, path: string): boolean {
  return path === dir || path.startsWith(dir + sep);
}

function relativeTargets(file: string, source: string): string[] {
  return [...source.matchAll(RELATIVE_SPECIFIER)].map((m) => m[1]);
}

/** Relative imports in `source` (located at `file`) that resolve into `forbiddenDir`. */
export function findImportsInto(
  file: string,
  source: string,
  forbiddenDir: string,
): string[] {
  return relativeTargets(file, source).filter((spec) =>
    isInside(forbiddenDir, resolve(dirname(file), spec)),
  );
}

/** Relative imports in `source` that resolve outside `allowedDir`. */
export function findImportsOutside(
  file: string,
  source: string,
  allowedDir: string,
): string[] {
  return relativeTargets(file, source).filter(
    (spec) => !isInside(allowedDir, resolve(dirname(file), spec)),
  );
}

const platformFiles = listTsFiles(SRC).filter(
  (file) =>
    !isInside(CODING_DIR, file) && file !== COMPOSITION_ROOT && file !== SELF,
);

function rel(file: string): string {
  return file.slice(SRC.length + 1);
}

describe("admin import boundary (coding -> platform only)", () => {
  it("no platform file imports a coding file", () => {
    const violations = platformFiles.flatMap((file) =>
      findImportsInto(file, readFileSync(file, "utf8"), CODING_DIR).map(
        (spec) => `${rel(file)} -> ${spec}`,
      ),
    );
    expect(violations).toEqual([]);
  });

  it("no platform file imports outside admin/ (only @app-vitals/agent-lib/* and npm)", () => {
    const violations = platformFiles.flatMap((file) =>
      findImportsOutside(file, readFileSync(file, "utf8"), ADMIN_DIR).map(
        (spec) => `${rel(file)} -> ${spec}`,
      ),
    );
    expect(violations).toEqual([]);
  });

  it("detects a platform -> coding import (checker self-test)", () => {
    const file = join(SRC, "example.ts");
    expect(
      findImportsInto(
        file,
        `import { x } from "./coding/agent-work-queue.ts";`,
        CODING_DIR,
      ),
    ).toEqual(["./coding/agent-work-queue.ts"]);
    expect(
      findImportsInto(
        file,
        `const m = await import("./coding/coding-admin-extension.ts");`,
        CODING_DIR,
      ),
    ).toEqual(["./coding/coding-admin-extension.ts"]);
    expect(
      findImportsInto(file, `import { x } from "./accounts.ts";`, CODING_DIR),
    ).toEqual([]);
  });

  it("allows coding -> platform imports", () => {
    const file = join(CODING_DIR, "example.ts");
    expect(
      findImportsInto(file, `import { x } from "../accounts.ts";`, CODING_DIR),
    ).toEqual([]);
  });

  it("detects an import escaping admin/ (checker self-test)", () => {
    const file = join(SRC, "example.ts");
    expect(
      findImportsOutside(
        file,
        `import { x } from "../../plugins/task-store/foo.ts";`,
        ADMIN_DIR,
      ),
    ).toEqual(["../../plugins/task-store/foo.ts"]);
    expect(
      findImportsOutside(
        file,
        `import type { P } from "../prisma/client/client.ts";`,
        ADMIN_DIR,
      ),
    ).toEqual([]);
  });
});

describe("admin package boundary (@app-vitals/agent-admin only)", () => {
  const outsideFiles = listRepoTsFiles(REPO_ROOT, ADMIN_DIR).filter(
    (file) => !REPO_SCAN_FIXTURE_FILES.has(file),
  );
  const repoRel = (file: string) => file.slice(REPO_ROOT.length + 1);

  it("no file outside admin/ relatively imports an admin file", () => {
    const violations = outsideFiles.flatMap((file) =>
      findImportsInto(file, readFileSync(file, "utf8"), ADMIN_DIR).map(
        (spec) => `${repoRel(file)} -> ${spec}`,
      ),
    );
    expect(violations).toEqual([]);
  });

  it("no file outside admin/ imports the retired @shipwright/admin name", () => {
    const violations = outsideFiles.flatMap((file) =>
      findRetiredSpecifiers(readFileSync(file, "utf8")).map(
        (spec) => `${repoRel(file)} -> ${spec}`,
      ),
    );
    expect(violations).toEqual([]);
  });

  it("detects relative and retired admin imports (checker self-test)", () => {
    const script = join(REPO_ROOT, "scripts", "example.ts");
    expect(
      findImportsInto(
        script,
        `import { adminExtensions } from "../admin/src/main.ts";`,
        ADMIN_DIR,
      ),
    ).toEqual(["../admin/src/main.ts"]);
    expect(
      findImportsInto(
        join(REPO_ROOT, "task-store", "src", "example.ts"),
        `const m = await import("../../admin/src/coding/x.ts");`,
        ADMIN_DIR,
      ),
    ).toEqual(["../../admin/src/coding/x.ts"]);
    expect(
      findImportsInto(
        script,
        `import { x } from "@app-vitals/agent-admin/admin-boot";`,
        ADMIN_DIR,
      ),
    ).toEqual([]);
    expect(
      findRetiredSpecifiers(
        `import type { AgentPlugin } from "@shipwright/admin";\n` +
          `import { y } from "@shipwright/admin/api.ts";\n` +
          `import { z } from "@app-vitals/agent-admin";`,
      ),
    ).toEqual(["@shipwright/admin", "@shipwright/admin/api.ts"]);
  });
});
