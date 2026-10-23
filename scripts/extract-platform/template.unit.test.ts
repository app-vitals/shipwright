/**
 * Content tests for the standalone-repo template (AGR-1.6).
 *
 * scripts/extract-platform/template/ is copied over the extracted app-vitals/agent
 * tree by scripts/extract-platform.ts. These tests pin the file set, keep
 * Shipwright-internal references out of it, check the Dockerfiles against the
 * extracted layout and run the ported import-boundary gate on a real extraction.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
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
import { dirname, join, relative, resolve, sep } from "node:path";
import { extractPlatform, TEMPLATE_DIR } from "../extract-platform";
import { checkBoundary } from "./template/scripts/check-import-boundary";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");

function listTemplate(dir = TEMPLATE_DIR): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .flatMap((e) =>
      e.isDirectory()
        ? listTemplate(join(dir, e.name))
        : [relative(TEMPLATE_DIR, join(dir, e.name)).split(sep).join("/")],
    )
    .sort();
}

const read = (path: string) => readFileSync(join(TEMPLATE_DIR, path), "utf8");

const EXPECTED_FILES = [
  ".dockerignore",
  ".github/workflows/ci.yml",
  ".github/workflows/pr-title-lint.yml",
  ".github/workflows/release.yml",
  ".gitignore",
  ".releaserc.json",
  "CLAUDE.md",
  "CONTRIBUTING.md",
  "LICENSE",
  "README.md",
  "SECURITY.md",
  "admin/Dockerfile",
  "admin/src/main.ts",
  "biome.json.tmpl",
  "bunfig.toml",
  "index.ts",
  "package.json",
  "patches/@slack%2Fsocket-mode@3.0.1.patch",
  "renovate.json",
  "runtime/Dockerfile",
  "scripts/bin/git-credential-shipwright.sh",
  "scripts/check-import-boundary.ts",
  "scripts/verify-browser-launch.ts",
  "tsconfig.json",
];

// Assembled so this file does not itself contain the host-repo hostname.
const BANNED = [
  "task-store",
  "task store",
  "taskstore",
  "chat service",
  "chat-service",
  "mcp-server",
  "plugins/shipwright",
  "app-vitals/shipwright",
  "@shipwright/",
  `shipwright.${"vitals-os"}.com`,
  "vitals-os",
  "vitals_os",
  ".svc.cluster.local",
  "app-vitals/marketplace",
];

describe("template file set", () => {
  test("contains exactly the expected files", () => {
    expect(listTemplate()).toEqual([...EXPECTED_FILES].sort());
  });

  test("no template file mentions a Shipwright-internal string", () => {
    const hits: string[] = [];
    for (const file of listTemplate()) {
      const text = read(file).toLowerCase();
      for (const banned of BANNED) {
        if (text.includes(banned)) hits.push(`${file}: ${banned}`);
      }
    }
    expect(hits).toEqual([]);
  });

  test("no template file would be discovered as a test", () => {
    expect(
      listTemplate().filter((f) => /\.(test|spec)\.[tj]s$/.test(f)),
    ).toEqual([]);
  });

  test("LICENSE is MIT and matches the source repository's", () => {
    expect(read("LICENSE")).toStartWith("MIT License");
    expect(read("LICENSE")).toBe(
      readFileSync(join(REPO_ROOT, "LICENSE"), "utf8"),
    );
  });
});

describe("package.json", () => {
  const pkg = JSON.parse(read("package.json"));

  test("workspaces are runtime, admin and lib", () => {
    expect([...pkg.workspaces].sort()).toEqual(["admin", "lib", "runtime"]);
  });

  test("depends on the three extracted packages", () => {
    for (const name of ["agent-runtime", "agent-admin", "agent-lib"]) {
      expect(pkg.dependencies[`@app-vitals/${name}`]).toBe("workspace:*");
    }
  });
});

describe("workflows", () => {
  test("ci.yml runs typecheck, lint, tests, the boundary gate, docker builds and the contract smoke", () => {
    const ci = read(".github/workflows/ci.yml");
    for (const needle of [
      "bun run lint",
      "bun run typecheck",
      "bun run check:boundary",
      "bun test",
      "docker build -f admin/Dockerfile",
      "docker build -f runtime/Dockerfile",
      "SHIPWRIGHT_CONTRACT_BASE_IMAGE=",
      "runtime/base-image-contract.smoke.test.ts",
    ]) {
      expect(ci).toContain(needle);
    }
  });

  test("release.yml runs semantic-release and pr-title-lint enforces conventional titles", () => {
    expect(read(".github/workflows/release.yml")).toContain("semantic-release");
    expect(read(".github/workflows/pr-title-lint.yml")).toContain(
      "action-semantic-pull-request",
    );
  });
});

/** COPY sources of stages that copy from the build context (not --from). */
function contextCopySources(dockerfile: string): string[] {
  const joined = dockerfile.replace(/\\\n/g, " ");
  return joined
    .split("\n")
    .filter((l) => /^COPY\s/.test(l) && !/--from=/.test(l))
    .flatMap((l) => {
      const args = l
        .replace(/^COPY\s+/, "")
        .split(/\s+/)
        .filter((a) => !a.startsWith("--"));
      return args.slice(0, -1);
    });
}

describe("Dockerfiles", () => {
  const FOREIGN = /(^|\/)(task-store|chat|plugins|metrics|mcp-server)(\/|$)/;

  test.each(["runtime/Dockerfile", "admin/Dockerfile"])(
    "%s copies nothing from the Shipwright-only services",
    (file) => {
      const text = read(file);
      for (const src of contextCopySources(text))
        expect(src).not.toMatch(FOREIGN);
      for (const line of text.split("\n")) {
        if (/^\s*(COPY|ADD)\s/.test(line)) expect(line).not.toMatch(FOREIGN);
      }
    },
  );

  test("runtime/Dockerfile keeps the module-resolution guard", () => {
    const text = read("runtime/Dockerfile");
    expect(text).toMatch(
      /find runtime -name "\*\.ts" \| xargs bun build --target=bun --external playwright --external playwright-core --outdir=\/tmp\/module-check/,
    );
  });

  test("runtime/Dockerfile keeps the base-image contract", () => {
    const text = read("runtime/Dockerfile");
    expect(text).toContain("/opt/shipwright/marketplaces/");
    expect(text).toContain("installPlugins()");
    expect(text).toContain(
      'ENTRYPOINT ["bun", "run", "/app/runtime/entrypoint-main.ts"]',
    );
    expect(text).toContain("USER 1000");
    expect(text).toContain("EXPOSE 3459");
  });

  test("admin/Dockerfile starts the admin composition root", () => {
    expect(read("admin/Dockerfile")).toContain(
      'ENTRYPOINT ["bun", "run", "admin/src/main.ts"]',
    );
  });
});

describe("import-boundary gate", () => {
  let scratch: string;
  beforeAll(() => {
    scratch = mkdtempSync(join(tmpdir(), "boundary-"));
  });
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));

  function put(path: string, content: string) {
    mkdirSync(dirname(join(scratch, path)), { recursive: true });
    writeFileSync(join(scratch, path), content);
  }

  test("flags specifiers that leave the tree and accepts those that do not", () => {
    put("lib/ok.ts", "export const ok = 1;\n");
    put(
      "runtime/a.ts",
      'import { ok } from "@app-vitals/agent-lib/ok";\nimport "./b.ts";\n',
    );
    put("runtime/b.ts", 'import pg from "pg";\nexport const b = pg;\n');
    put(
      "runtime/bad.ts",
      [
        'import "../../outside";',
        'import "../task-store/src/index.ts";',
        'import "@other-scope/unknown";',
        'import "@app-vitals/agent-lib/missing";',
        'const x = await import("./nope.ts");',
      ].join("\n"),
    );
    const bad = checkBoundary(scratch)
      .filter((v) => v.file.endsWith("bad.ts"))
      .map((v) => v.specifier)
      .sort();
    expect(bad).toEqual(
      [
        "../../outside",
        "../task-store/src/index.ts",
        "@other-scope/unknown",
        "@app-vitals/agent-lib/missing",
        "./nope.ts",
      ].sort(),
    );
    expect(
      checkBoundary(scratch).filter((v) => !v.file.endsWith("bad.ts")),
    ).toEqual([]);
  });
});

describe("extraction output", () => {
  let out: string;
  beforeAll(() => {
    out = mkdtempSync(join(tmpdir(), "template-extract-"));
    extractPlatform({
      source: REPO_ROOT,
      ref: "HEAD",
      out,
      history: false,
      clean: true,
    });
  }, 120_000);
  afterAll(() => rmSync(out, { recursive: true, force: true }));

  test("includes every template file", () => {
    for (const file of EXPECTED_FILES) {
      expect(existsSync(join(out, file.replace(/\.tmpl$/, "")))).toBe(true);
    }
  });

  test("the standalone Dockerfiles replace the renamed monorepo ones", () => {
    expect(readFileSync(join(out, "runtime/Dockerfile"), "utf8")).toBe(
      read("runtime/Dockerfile"),
    );
    expect(readFileSync(join(out, "admin/Dockerfile"), "utf8")).toBe(
      read("admin/Dockerfile"),
    );
  });

  test.each(["runtime/Dockerfile", "admin/Dockerfile"])(
    "every COPY source in %s exists in the extracted tree",
    (file) => {
      const missing = contextCopySources(read(file)).filter((src) => {
        const path = src.replace(/\/$/, "");
        if (path.includes("*")) return false; // optional globs (bun.lock*)
        return !existsSync(join(out, path));
      });
      expect(missing).toEqual([]);
    },
  );

  test("the ported import-boundary gate is clean on the extracted tree", () => {
    expect(checkBoundary(out)).toEqual([]);
  });

  test("the base-image contract smoke test addresses the extracted paths", () => {
    const smoke = readFileSync(
      join(out, "runtime/base-image-contract.smoke.test.ts"),
      "utf8",
    );
    expect(smoke).toContain('"/app/runtime/entrypoint-main.ts"');
    expect(smoke).toContain("/app/runtime/setup.ts");
    expect(smoke).not.toContain('"/app/agent/src');
  });
});
