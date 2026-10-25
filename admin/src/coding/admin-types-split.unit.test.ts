/**
 * admin/src/coding/admin-types-split.unit.test.ts
 *
 * The generated admin types are split in two (AGR-1.4): the platform half
 * (`@app-vitals/agent-lib/admin-types`, consumed from the registry since
 * AGR-4.1 and generated in the platform repository) types the runtime's admin
 * client; the coding half (admin/src/coding/admin-types.ts, generated from
 * admin/src/coding/openapi.coding.json) is Shipwright's. The platform half
 * must import nothing at all (in particular nothing from the coding half) and
 * must cover every path of this repository's platform spec. It may be ahead
 * of that spec (the platform releases independently), and keeping coding
 * paths out of it is now the platform repository's check, not this one's.
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

  it("the registry platform types declare every path of the local platform spec", () => {
    const platformSpec = readJson(join(ADMIN_DIR, "openapi.platform.json"));
    const declared = new Set(pathKeys(platformSource));
    expect(
      Object.keys(platformSpec.paths).filter((p) => !declared.has(p)),
    ).toEqual([]);
  });

  it("the coding half holds exactly the coding paths", () => {
    const codingSpec = readJson(join(CODING_DIR, "openapi.coding.json"));
    const codingPaths = Object.keys(codingSpec.paths);
    expect(codingPaths.length).toBeGreaterThan(0);
    expect(pathKeys(codingSource)).toEqual(codingPaths);
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
