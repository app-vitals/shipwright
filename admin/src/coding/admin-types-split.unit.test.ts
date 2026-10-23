/**
 * admin/src/coding/admin-types-split.unit.test.ts
 *
 * The generated admin types are split in two (AGR-1.4): the platform half
 * (lib/admin-types.ts, generated from admin/openapi.platform.json) ships with
 * the platform and types the runtime's admin client; the coding half
 * (admin/src/coding/admin-types.ts, generated from
 * admin/src/coding/openapi.coding.json) is Shipwright's. The runtime's typed
 * client must never depend on Shipwright coding endpoints, so the platform
 * half imports nothing at all (in particular nothing from the coding half)
 * and declares none of the coding extension's paths.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const CODING_DIR = resolve(import.meta.dir);
const ADMIN_DIR = resolve(CODING_DIR, "..", "..");
const PLATFORM_TYPES = Bun.resolveSync(
  "@app-vitals/agent-lib/admin-types",
  ADMIN_DIR,
);
const CODING_TYPES = join(CODING_DIR, "admin-types.ts");

// Any module specifier: `from "x"`, `import "x"`, `import("x")`, `require("x")`.
const SPECIFIER = /\b(?:from|import|require)\s*\(?\s*["']([^"']+)["']/g;

/** Every module specifier in `source`. */
export function moduleSpecifiers(source: string): string[] {
  return [...source.matchAll(SPECIFIER)].map((m) => m[1]);
}

/** Top-level keys of the generated `export interface paths { ... }` block. */
export function pathKeys(source: string): string[] {
  const start = source.indexOf("export interface paths {");
  if (start === -1) return [];
  const end = source.indexOf("\n}\n", start);
  return [...source.slice(start, end).matchAll(/^ {4}"([^"]+)": \{$/gm)].map(
    (m) => m[1],
  );
}

function readJson(path: string): { paths: Record<string, unknown> } {
  return JSON.parse(readFileSync(path, "utf8"));
}

describe("generated admin types split (platform | coding)", () => {
  const platformSource = readFileSync(PLATFORM_TYPES, "utf8");
  const codingSource = readFileSync(CODING_TYPES, "utf8");

  it("the platform types file imports nothing (so nothing from the coding half)", () => {
    expect(moduleSpecifiers(platformSource)).toEqual([]);
  });

  it("the platform types declare exactly the platform spec's paths", () => {
    const platformSpec = readJson(join(ADMIN_DIR, "openapi.platform.json"));
    expect(pathKeys(platformSource)).toEqual(Object.keys(platformSpec.paths));
  });

  it("the coding half holds the coding paths, none of which are in the platform half", () => {
    const codingSpec = readJson(join(CODING_DIR, "openapi.coding.json"));
    const codingPaths = Object.keys(codingSpec.paths);
    expect(codingPaths.length).toBeGreaterThan(0);
    expect(pathKeys(codingSource)).toEqual(codingPaths);
    const platformPaths = new Set(pathKeys(platformSource));
    expect(codingPaths.filter((p) => platformPaths.has(p))).toEqual([]);
  });

  it("platform + coding paths cover the composed admin/openapi.json", () => {
    const composed = readJson(join(ADMIN_DIR, "openapi.json"));
    const split = new Set([
      ...pathKeys(platformSource),
      ...pathKeys(codingSource),
    ]);
    expect(Object.keys(composed.paths).filter((p) => !split.has(p))).toEqual(
      [],
    );
  });

  it("detects imports and path keys (checker self-test)", () => {
    expect(
      moduleSpecifiers(
        `import type { paths } from "../admin/src/coding/admin-types.ts";\n` +
          `export * from "./x";\nconst m = await import("y");`,
      ),
    ).toEqual(["../admin/src/coding/admin-types.ts", "./x", "y"]);
    expect(
      pathKeys(
        `export interface paths {\n    "/a": {\n        get: {};\n    };\n    "/b/{id}": {\n    };\n}\n`,
      ),
    ).toEqual(["/a", "/b/{id}"]);
  });
});
