/**
 * scripts/platform-gate.unit.test.ts
 *
 * Unit layer for the copy-paste-readiness closure walker (AEP-4.1). Builds a
 * throwaway fixture tree on disk and proves the walker fails on every kind of
 * edge that leaves the platform set. The repo-level run against the real
 * manifest lives in platform-manifest.unit.test.ts.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  analyzeClosure,
  checkLibTags,
  extractSpecifiers,
  type PlatformManifest,
  validateManifest,
} from "./platform-gate.ts";

let root: string;

function write(rel: string, content = "export const x = 1;\n"): void {
  const full = join(root, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

function manifest(over: Partial<PlatformManifest> = {}): PlatformManifest {
  return {
    version: 1,
    include: ["runtime/**", "admin/src/**"],
    exclude: ["admin/src/coding/**"],
    lib: [{ module: "leaf", tag: "platform-only", sharedWith: [] }],
    generated: [],
    compositionRoots: [],
    exemptions: [],
    ...over,
  };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "platform-gate-"));
  write("lib/leaf.ts");
  write("lib/other.ts");
  write(
    "runtime/a.ts",
    `import { b } from "./b.ts";\nimport { l } from "@app-vitals/agent-lib/leaf";\n`,
  );
  write("runtime/b.ts");
  write("admin/src/x.ts", `import type { T } from "../../runtime/a.ts";\n`);
  write("admin/src/coding/c.ts");
  write("task-store/src/t.ts");
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("extractSpecifiers", () => {
  it("finds static, type-only, re-export, side-effect, dynamic and mock specifiers", () => {
    const src = [
      `import a from "./a.ts";`,
      `import type { B } from "../b";`,
      `export * from "./c.ts";`,
      `export { d } from "@app-vitals/agent-lib/d";`,
      `import "./side-effect.ts";`,
      `const e = await import("./e.ts");`,
      `mock.module("../f.ts", () => ({}));`,
      `const g = require("node:fs");`,
      `import {\n  h,\n} from "pkg";`,
    ].join("\n");
    expect(extractSpecifiers(src).sort()).toEqual(
      [
        "./a.ts",
        "../b",
        "./c.ts",
        "@app-vitals/agent-lib/d",
        "./side-effect.ts",
        "./e.ts",
        "../f.ts",
        "node:fs",
        "pkg",
      ].sort(),
    );
  });

  it("ignores specifiers inside comments and string literals", () => {
    const src = [
      `// import x from "./commented.ts";`,
      `/* import y from "./block.ts"; */`,
      `const s = 'expect(src).toContain("from \\"./quoted.ts\\"")';`,
    ].join("\n");
    expect(extractSpecifiers(src)).toEqual([]);
  });
});

describe("validateManifest", () => {
  it("accepts a well-formed manifest", () => {
    expect(validateManifest(manifest())).toEqual([]);
  });

  it("rejects a platform-only module with sharedWith entries and a shared module without", () => {
    const errors = validateManifest(
      manifest({
        lib: [
          { module: "a", tag: "platform-only", sharedWith: ["chat"] },
          { module: "b", tag: "shared", sharedWith: [] },
          { module: "c", tag: "shared", sharedWith: ["nope" as never] },
        ],
      }),
    );
    expect(errors.length).toBe(3);
  });

  it("rejects duplicate lib modules", () => {
    const errors = validateManifest(
      manifest({
        lib: [
          { module: "a", tag: "platform-only", sharedWith: [] },
          { module: "a", tag: "platform-only", sharedWith: [] },
        ],
      }),
    );
    expect(errors.some((e) => e.includes("duplicate"))).toBe(true);
  });
});

describe("analyzeClosure", () => {
  it("passes when every edge stays inside the set (relative, type-only, listed lib)", () => {
    const result = analyzeClosure(root, manifest());
    expect(result.violations).toEqual([]);
    expect(result.files).toContain("runtime/a.ts");
    expect(result.files).toContain("lib/leaf.ts");
    expect(result.files).not.toContain("admin/src/coding/c.ts");
  });

  it("fails on a relative import into an excluded coding directory", () => {
    write("runtime/b.ts", `import { c } from "../admin/src/coding/c.ts";\n`);
    const { violations } = analyzeClosure(root, manifest());
    expect(violations).toEqual([
      {
        from: "runtime/b.ts",
        specifier: "../admin/src/coding/c.ts",
        target: "admin/src/coding/c.ts",
        reason: "outside-set",
      },
    ]);
  });

  it("fails on an `import type` that leaves the set", () => {
    write("runtime/b.ts", `import type { T } from "../task-store/src/t.ts";\n`);
    const { violations } = analyzeClosure(root, manifest());
    expect(violations.map((v) => v.target)).toEqual(["task-store/src/t.ts"]);
  });

  it("fails on a dynamic import and a re-export that leave the set", () => {
    write(
      "runtime/b.ts",
      `export * from "../task-store/src/t.ts";\nconst m = await import("../task-store/src/t.ts");\n`,
    );
    const { violations } = analyzeClosure(root, manifest());
    expect(violations.length).toBe(2);
  });

  it("fails on a workspace specifier that points at another package", () => {
    write("runtime/b.ts", `import { t } from "@shipwright/task-store";\n`);
    const { violations } = analyzeClosure(root, manifest());
    expect(violations).toEqual([
      expect.objectContaining({
        from: "runtime/b.ts",
        specifier: "@shipwright/task-store",
        reason: "outside-set",
      }),
    ]);
  });

  it("fails on a lib module the set imports but the manifest does not list", () => {
    write("runtime/b.ts", `import { o } from "@app-vitals/agent-lib/other";\n`);
    const { violations } = analyzeClosure(root, manifest());
    expect(violations).toEqual([
      expect.objectContaining({
        from: "runtime/b.ts",
        target: "lib/other.ts",
        reason: "unlisted-lib-module",
      }),
    ]);
  });

  it("fails on a relative path into an unlisted lib module", () => {
    write("runtime/b.ts", `import { o } from "../lib/other.ts";\n`);
    const { violations } = analyzeClosure(root, manifest());
    expect(violations.map((v) => v.reason)).toEqual(["unlisted-lib-module"]);
  });

  it("fails when a listed lib module itself imports outside the set", () => {
    write("lib/leaf.ts", `import { o } from "./other.ts";\n`);
    const { violations } = analyzeClosure(root, manifest());
    expect(violations.map((v) => `${v.from} -> ${v.reason}`)).toEqual([
      "lib/leaf.ts -> unlisted-lib-module",
    ]);
  });

  it("fails on an import that does not resolve to a file", () => {
    write("runtime/b.ts", `import { z } from "./missing.ts";\n`);
    const { violations } = analyzeClosure(root, manifest());
    expect(violations.map((v) => v.reason)).toEqual(["unresolved"]);
  });

  it("fails when a manifest-listed lib module does not exist", () => {
    const { violations } = analyzeClosure(
      root,
      manifest({
        lib: [{ module: "ghost", tag: "platform-only", sharedWith: [] }],
      }),
    );
    expect(violations.some((v) => v.reason === "missing-lib-module")).toBe(
      true,
    );
  });

  it("allows npm and node: specifiers", () => {
    write(
      "runtime/b.ts",
      `import { Hono } from "hono";\nimport fs from "node:fs";\n`,
    );
    expect(analyzeClosure(root, manifest()).violations).toEqual([]);
  });

  it("resolves directory index and extensionless specifiers inside the set", () => {
    write("runtime/dir/index.ts");
    write("runtime/b.ts", `import "./dir";\nimport "./dir/index";\n`);
    expect(analyzeClosure(root, manifest()).violations).toEqual([]);
  });

  it("treats imports of a generated (git-ignored) path as inside the set even when absent", () => {
    write("runtime/b.ts", `import { P } from "../admin/gen/client.ts";\n`);
    expect(analyzeClosure(root, manifest()).violations.length).toBe(1);
    const ok = analyzeClosure(root, manifest({ generated: ["admin/gen/**"] }));
    expect(ok.violations).toEqual([]);
  });

  it("keeps composition roots out of the set and flags imports of them", () => {
    write("admin/src/main.ts", `import { c } from "./coding/c.ts";\n`);
    const withRoot = manifest({
      compositionRoots: [{ path: "admin/src/main.ts", reason: "wires coding" }],
    });
    const result = analyzeClosure(root, withRoot);
    expect(result.files).not.toContain("admin/src/main.ts");
    expect(result.violations).toEqual([]);
    write("admin/src/x.ts", `import "./main.ts";\n`);
    expect(
      analyzeClosure(root, withRoot).violations.map((v) => v.target),
    ).toEqual(["admin/src/main.ts"]);
  });

  it("an exemption suppresses its edge but is surfaced in the result", () => {
    write("runtime/b.ts", `import { t } from "../task-store/src/t.ts";\n`);
    const result = analyzeClosure(
      root,
      manifest({
        exemptions: [
          { from: "runtime/b.ts", to: "task-store/src/t.ts", reason: "x" },
        ],
      }),
    );
    expect(result.violations).toEqual([]);
    expect(result.exempted.length).toBe(1);
  });
});

describe("checkLibTags", () => {
  it("passes when tags match who imports each lib module outside the set", () => {
    write(
      "task-store/src/t.ts",
      `import { l } from "@app-vitals/agent-lib/leaf";\n`,
    );
    const m = manifest({
      lib: [{ module: "leaf", tag: "shared", sharedWith: ["task-store"] }],
    });
    expect(checkLibTags(root, m)).toEqual([]);
  });

  it("fails when a platform-only module is imported outside the set", () => {
    write(
      "task-store/src/t.ts",
      `import { l } from "@app-vitals/agent-lib/leaf";\n`,
    );
    const errors = checkLibTags(root, manifest());
    expect(errors).toEqual([
      "lib/leaf is tagged platform-only but is imported by: task-store",
    ]);
  });

  it("classifies unknown top-level dirs as coding and skips docs, site and planning", () => {
    write("plugins/p/x.ts", `import { l } from "../../lib/leaf.ts";\n`);
    write("docs/x.test.ts", `import { l } from "../lib/leaf.ts";\n`);
    write("site/x.ts", `import { l } from "../lib/leaf.ts";\n`);
    const m = manifest({
      lib: [{ module: "leaf", tag: "shared", sharedWith: ["coding"] }],
    });
    expect(checkLibTags(root, m)).toEqual([]);
  });

  it("fails on a stale sharedWith entry and on a missing one", () => {
    write("chat/src/c.ts", `import { l } from "@app-vitals/agent-lib/leaf";\n`);
    const m = manifest({
      lib: [{ module: "leaf", tag: "shared", sharedWith: ["metrics"] }],
    });
    const errors = checkLibTags(root, m);
    expect(errors.length).toBe(2);
  });

  it("reports a lib module outside the set that imports a listed module as 'lib'", () => {
    write("lib/other.ts", `import { l } from "./leaf.ts";\n`);
    const m = manifest({
      lib: [{ module: "leaf", tag: "shared", sharedWith: ["lib"] }],
    });
    expect(checkLibTags(root, m)).toEqual([]);
  });
});
