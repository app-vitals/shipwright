import { describe, expect, test } from "bun:test";
import {
  mapPath,
  parseArgs,
  rewriteFile,
  rewriteJson,
  rewriteSource,
} from "./extract-platform";

describe("mapPath", () => {
  test("renames directory prefixes", () => {
    expect(mapPath("agent/src/runtime/boot.ts")).toBe("runtime/boot.ts");
    expect(mapPath("agent/src/fixtures/a/b.json")).toBe(
      "runtime/fixtures/a/b.json",
    );
    expect(mapPath("agent/workspace/CLAUDE.md")).toBe(
      "runtime/workspace/CLAUDE.md",
    );
    expect(mapPath("specialties/specialist/manifest.yaml")).toBe(
      "agent-types/specialist/manifest.yaml",
    );
  });

  test("renames exact files and bare directories", () => {
    expect(mapPath("agent/Dockerfile")).toBe("runtime/Dockerfile");
    expect(mapPath("agent/src/entrypoint-main.ts")).toBe(
      "runtime/entrypoint-main.ts",
    );
    expect(mapPath("docs/schemas/specialty.schema.json")).toBe(
      "agent-types/specialty.schema.json",
    );
    expect(mapPath("agent/src/runtime")).toBe("runtime");
  });

  test("leaves admin and lib paths alone and does not match look-alikes", () => {
    expect(mapPath("admin/src/server.ts")).toBe("admin/src/server.ts");
    expect(mapPath("lib/sentry.ts")).toBe("lib/sentry.ts");
    expect(mapPath("agent/src/runtime-extra/x.ts")).toBe(
      "agent/src/runtime-extra/x.ts",
    );
    expect(mapPath("agent/Dockerfile.dev")).toBe("agent/Dockerfile.dev");
  });
});

describe("rewriteSource", () => {
  test("re-relativizes specifiers that cross a renamed root", () => {
    const src = `import { x } from "../fixtures/a";\nimport { y } from "./y";\n`;
    const out = rewriteSource(src, "agent/src/runtime/boot.ts");
    expect(out).toBe(
      `import { x } from "./fixtures/a";\nimport { y } from "./y";\n`,
    );
  });

  test("handles entrypoint-main moving next to runtime", () => {
    const out = rewriteSource(
      `import { r } from "./runtime/boot";`,
      "agent/src/entrypoint-main.ts",
    );
    expect(out).toBe(`import { r } from "./boot";`);
  });

  test("rewrites the @shipwright scope, keeps packages and builtins", () => {
    const src = `import a from "@shipwright/x/y";\nimport b from "hono";\nimport c from "node:fs";\nimport d from "@app-vitals/agent-lib/sentry";\n`;
    expect(rewriteSource(src, "admin/src/a.ts")).toBe(
      `import a from "@app-vitals/x/y";\nimport b from "hono";\nimport c from "node:fs";\nimport d from "@app-vitals/agent-lib/sentry";\n`,
    );
  });

  test("covers dynamic imports and single quotes", () => {
    const out = rewriteSource(
      `const m = await import('../fixtures/z');`,
      "agent/src/runtime/a.ts",
    );
    expect(out).toBe(`const m = await import('./fixtures/z');`);
  });

  test("is idempotent for unmoved files", () => {
    const src = `import { x } from "../lib/x";`;
    expect(rewriteSource(src, "admin/src/a.ts")).toBe(src);
  });
});

describe("rewriteJson", () => {
  test("renames the scope in name and dependencies", () => {
    const out = JSON.parse(
      rewriteJson(
        JSON.stringify({
          name: "@shipwright/agent",
          dependencies: { "@shipwright/chat": "workspace:*", hono: "^4" },
        }),
        "agent/package.json",
      ),
    );
    expect(out.name).toBe("@app-vitals/agent");
    expect(out.dependencies).toEqual({
      "@app-vitals/chat": "workspace:*",
      hono: "^4",
    });
  });

  test("rewrites tsconfig extends and paths", () => {
    const out = JSON.parse(
      rewriteJson(
        JSON.stringify({
          extends: "../../../tsconfig.json",
          compilerOptions: { paths: { "@x/*": ["../fixtures/*"] } },
        }),
        "agent/src/runtime/tsconfig.json",
      ),
    );
    expect(out.extends).toBe("../tsconfig.json");
    expect(out.compilerOptions.paths["@x/*"]).toEqual(["./fixtures/*"]);
  });

  test("returns the input untouched when nothing changes", () => {
    const src = `{"name":"@app-vitals/agent-lib"}`;
    expect(rewriteJson(src, "lib/package.json")).toBe(src);
    expect(rewriteJson(`{"a":1}`, "admin/openapi.json")).toBe(`{"a":1}`);
  });
});

describe("rewriteFile", () => {
  test("passes non-code files through", () => {
    expect(rewriteFile("# hi", "agent/workspace/README.md")).toBe("# hi");
  });
});

describe("parseArgs", () => {
  test("parses flags", () => {
    const o = parseArgs(["--out", "/tmp/o", "--no-history", "--ref", "abc"]);
    expect(o).toMatchObject({
      out: "/tmp/o",
      history: false,
      ref: "abc",
      clean: false,
    });
  });

  test("requires --out and rejects unknown flags", () => {
    expect(() => parseArgs([])).toThrow("--out");
    expect(() => parseArgs(["--out", "x", "--bogus"])).toThrow("unknown");
  });
});
