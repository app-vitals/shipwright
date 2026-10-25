/**
 * agent/scripts/check-lib-resolution.unit.test.ts
 *
 * The image-level lib resolution guard (AGR-4.1): finds lib imports, resolves
 * them through an injected resolver, and refuses to pass vacuously. The last
 * case runs it against the real agent/src with Bun's resolver, the same check
 * the Dockerfile runs inside the image.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  checkLibResolution,
  findLibImports,
  listSourceFiles,
} from "./check-lib-resolution.ts";

const files = [
  {
    path: "/app/agent/src/a.ts",
    source: [
      'import { initSentry } from "@app-vitals/agent-lib/sentry";',
      'import type { paths } from "@app-vitals/agent-lib/admin-types";',
      'import { DEFAULT_CLAIM_TTL_MS } from "@app-vitals/agent-lib/claim-ttl";',
      'const p = await import("@app-vitals/agent-lib/pricing");',
      'import { x } from "hono";',
      "// see @app-vitals/agent-lib/sentry for details",
    ].join("\n"),
  },
  {
    path: "/app/agent/src/b.ts",
    source: 'import "@app-vitals/agent-lib/sentry";\n',
  },
];

describe("findLibImports", () => {
  test("finds static, type-only, side-effect and dynamic lib imports only", () => {
    expect(findLibImports(files)).toEqual([
      {
        specifier: "@app-vitals/agent-lib/sentry",
        from: "/app/agent/src/a.ts",
      },
      {
        specifier: "@app-vitals/agent-lib/admin-types",
        from: "/app/agent/src/a.ts",
      },
      {
        specifier: "@app-vitals/agent-lib/claim-ttl",
        from: "/app/agent/src/a.ts",
      },
      {
        specifier: "@app-vitals/agent-lib/pricing",
        from: "/app/agent/src/a.ts",
      },
      {
        specifier: "@app-vitals/agent-lib/sentry",
        from: "/app/agent/src/b.ts",
      },
    ]);
  });
});

describe("checkLibResolution", () => {
  test("passes when every import resolves, resolving from the importer's directory", () => {
    const dirs: string[] = [];
    const r = checkLibResolution(
      files,
      (_spec, dir) => {
        dirs.push(dir);
        return "/resolved.ts";
      },
      ["@app-vitals/agent-lib"],
    );
    expect(r.failures).toEqual([]);
    expect(r.missingRequired).toEqual([]);
    expect(new Set(dirs)).toEqual(new Set(["/app/agent/src"]));
  });

  test("reports each import that fails to resolve (package missing from the image)", () => {
    const r = checkLibResolution(files, (spec) => {
      if (spec === "@app-vitals/agent-lib/claim-ttl") {
        throw new Error("Cannot find package '@app-vitals/agent-lib'");
      }
      return "/ok.ts";
    });
    expect(r.failures).toEqual([
      {
        specifier: "@app-vitals/agent-lib/claim-ttl",
        from: "/app/agent/src/a.ts",
        error: "Cannot find package '@app-vitals/agent-lib'",
      },
    ]);
  });

  test("fails a required prefix that no file imports, so it cannot pass vacuously", () => {
    const r = checkLibResolution(
      [{ path: "/x.ts", source: 'import "@app-vitals/agent-lib/sentry";' }],
      () => "/ok.ts",
      ["@app-vitals/agent-lib", "@app-vitals/other"],
    );
    expect(r.missingRequired).toEqual(["@app-vitals/other"]);
    expect(
      checkLibResolution([], () => "/ok.ts", ["@app-vitals/agent-lib"])
        .missingRequired,
    ).toEqual(["@app-vitals/agent-lib"]);
  });
});

describe("real agent/src", () => {
  test("every registry lib import resolves from this checkout", () => {
    const src = resolve(import.meta.dir, "..", "src");
    const paths = listSourceFiles(src);
    expect(paths.some((p) => p.endsWith(".test.ts"))).toBe(false);
    const r = checkLibResolution(
      paths.map((path) => ({ path, source: readFileSync(path, "utf8") })),
      (spec, dir) => Bun.resolveSync(spec, dir),
      ["@app-vitals/agent-lib"],
    );
    expect(r.failures).toEqual([]);
    expect(r.missingRequired).toEqual([]);
    expect(r.checked.length).toBeGreaterThan(0);
  });
});
