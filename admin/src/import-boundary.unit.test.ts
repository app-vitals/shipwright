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
