/**
 * Unit tests for readiness-detectors.ts — pure logic over fixture file trees, no real I/O.
 */
import { describe, expect, test } from "bun:test";
import { READINESS_CATALOGUE } from "./readiness-catalogue.ts";
import {
  DETECTORS,
  detectToolchains,
  type ReadinessReader,
  runDetectors,
} from "./readiness-detectors.ts";

type Tree = Record<string, string>;

const reader = (tree: Tree): ReadinessReader => ({
  listFiles: () => Object.keys(tree),
  read: (p) => tree[p],
});

const run = (id: string, tree: Tree) => {
  const d = DETECTORS[id];
  if (!d) throw new Error(`no detector ${id}`);
  return d(reader(tree));
};

const lines = (n: number) => `${"x\n".repeat(n)}`;

const CI_TS = `
jobs:
  ci:
    steps:
      - run: bunx biome lint .
      - run: bun run typecheck
      - run: bun test
      - run: gitleaks detect
`;

const tsRepo: Tree = {
  "README.md": "# app\n\n```\nbun run build\nbun test\n```\n",
  "CLAUDE.md": "# hi",
  "package.json": JSON.stringify({ dependencies: { pino: "1", "@sentry/node": "1", "@opentelemetry/api": "1" } }),
  "bun.lock": "",
  "tsconfig.json": "{}",
  "biome.json": "{}",
  ".husky/pre-commit": "",
  ".nvmrc": "20",
  ".github/CODEOWNERS": "* @a",
  ".github/dependabot.yml": "",
  ".github/workflows/ci.yml": CI_TS,
  "src/a.ts": lines(10),
  "src/a.unit.test.ts": "",
  "e2e/login.spec.ts": "",
};

const goRepo: Tree = {
  "README.md": "# svc\nRun `go build ./...` then `go test ./...`.",
  "AGENTS.md": "",
  "go.mod": "module x\n\ngo 1.22",
  "go.sum": "",
  ".golangci.yml": "",
  ".github/workflows/ci.yml": "steps:\n  - run: golangci-lint run\n  - run: go test ./...\n",
  "main.go": 'package main\nimport "log/slog"\n',
  "main_test.go": "",
  "test/smoke/smoke_test.go": "",
};

describe("toolchain detection", () => {
  test("detects ts and go, and nothing for empty", () => {
    expect(detectToolchains(reader(tsRepo))).toEqual(["node"]);
    expect(detectToolchains(reader(goRepo))).toEqual(["go"]);
    expect(detectToolchains(reader({}))).toEqual([]);
    expect(
      detectToolchains(reader({ "Cargo.toml": "", Makefile: "", Gemfile: "", "pom.xml": "", "pyproject.toml": "" })),
    ).toEqual(["rust", "java", "python", "ruby", "make"]);
  });
});

describe("TypeScript fixture", () => {
  const res = runDetectors(reader(tsRepo));
  test("passes everything it satisfies", () => {
    for (const id of [
      "readme-present",
      "linter-configured",
      "type-checker-configured",
      "unit-tests-exist",
      "agent-instructions-present",
      "build-test-documented",
      "dependencies-pinned",
      "formatter-configured",
      "pre-commit-configured",
      "tool-versions-pinned",
      "codeowners-present",
      "ci-runs-lint-typecheck",
      "ci-runs-tests",
      "smoke-e2e-layer-exists",
      "secret-scanning-ci",
      "dependency-automation",
      "structured-logging",
      "error-tracking-configured",
      "tracing-metrics-instrumented",
      "large-files-within-limit",
    ]) {
      expect([id, res[id]]).toEqual([id, "pass"]);
    }
  });
  test("fails what is missing", () => {
    expect(res["staged-canary-deploy"]).toBe("fail");
    expect(res["preview-environment"]).toBe("fail");
  });
});

describe("Go fixture", () => {
  const res = runDetectors(reader(goRepo));
  test("type checker is n/a for Go", () => {
    expect(res["type-checker-configured"]).toBe("n/a");
  });
  test("ci lint+typecheck needs only lint when no type checker applies", () => {
    expect(res["ci-runs-lint-typecheck"]).toBe("pass");
  });
  test("passes and fails per Go conventions", () => {
    expect(res["linter-configured"]).toBe("pass");
    expect(res["formatter-configured"]).toBe("pass");
    expect(res["dependencies-pinned"]).toBe("pass");
    expect(res["structured-logging"]).toBe("pass");
    expect(res["smoke-e2e-layer-exists"]).toBe("pass");
    expect(res["unit-tests-exist"]).toBe("pass");
    expect(res["build-test-documented"]).toBe("pass");
    expect(res["error-tracking-configured"]).toBe("fail");
    expect(res["pre-commit-configured"]).toBe("fail");
    expect(res["codeowners-present"]).toBe("fail");
  });
});

describe("n/a, not TypeScript assumptions", () => {
  test("plain JavaScript has no type checker -> n/a", () => {
    expect(run("type-checker-configured", { "package.json": "{}", "index.js": "" })).toBe("n/a");
  });
  test("TypeScript sources without tsconfig -> fail", () => {
    expect(run("type-checker-configured", { "package.json": "{}", "index.ts": "" })).toBe("fail");
  });
  test("python without mypy fails, with mypy passes", () => {
    expect(run("type-checker-configured", { "pyproject.toml": "" })).toBe("fail");
    expect(run("type-checker-configured", { "pyproject.toml": "[tool.mypy]\n" })).toBe("pass");
  });
  test("no toolchain -> language-specific checks are n/a", () => {
    const empty: Tree = { "README.md": "x" };
    for (const id of [
      "linter-configured",
      "type-checker-configured",
      "dependencies-pinned",
      "formatter-configured",
      "structured-logging",
      "error-tracking-configured",
      "tracing-metrics-instrumented",
      "ci-runs-lint-typecheck",
      "large-files-within-limit",
    ]) {
      expect([id, run(id, empty)]).toEqual([id, "n/a"]);
    }
  });
  test("ci with lint but no typecheck fails for a typed-checkable repo", () => {
    expect(
      run("ci-runs-lint-typecheck", {
        "package.json": "{}",
        "tsconfig.json": "{}",
        ".github/workflows/ci.yml": "run: eslint .",
      }),
    ).toBe("fail");
  });
});

describe("individual detectors", () => {
  test("readme / instructions / codeowners variants", () => {
    expect(run("readme-present", { "readme.rst": "" })).toBe("pass");
    expect(run("readme-present", { "docs/README.md": "" })).toBe("fail");
    expect(run("agent-instructions-present", { "AGENTS.md": "" })).toBe("pass");
    expect(run("codeowners-present", { CODEOWNERS: "" })).toBe("pass");
  });
  test("build-test-documented requires both commands", () => {
    expect(run("build-test-documented", { "README.md": "run `make build`" })).toBe("fail");
    expect(run("build-test-documented", { "CLAUDE.md": "`cargo build` and `cargo test`" })).toBe("pass");
  });
  test("dependencies-pinned: missing lockfile fails, requirements with == passes", () => {
    expect(run("dependencies-pinned", { "package.json": "{}" })).toBe("fail");
    expect(run("dependencies-pinned", { "requirements.txt": "flask==2.0\n" })).toBe("pass");
    expect(run("dependencies-pinned", { "requirements.txt": "flask\n" })).toBe("fail");
    expect(run("dependencies-pinned", { "Cargo.toml": "", "Cargo.lock": "" })).toBe("pass");
  });
  test("tool versions: devcontainer and Dockerfile count", () => {
    expect(run("tool-versions-pinned", { ".devcontainer/devcontainer.json": "{}" })).toBe("pass");
    expect(run("tool-versions-pinned", { Dockerfile: "" })).toBe("pass");
    expect(run("tool-versions-pinned", { "a.txt": "" })).toBe("fail");
  });
  test("dependency automation via renovate or audit in CI", () => {
    expect(run("dependency-automation", { "renovate.json": "{}" })).toBe("pass");
    expect(run("dependency-automation", { ".github/workflows/a.yml": "run: cargo audit" })).toBe("pass");
    expect(run("dependency-automation", {})).toBe("fail");
  });
  test("preview-environment needs entry point and a CI job using it", () => {
    const entry = { "docker-compose.yml": "" };
    expect(run("preview-environment", entry)).toBe("fail");
    expect(
      run("preview-environment", {
        ...entry,
        ".github/workflows/p.yml": "run: docker compose up -d\nrun: bun run e2e",
      }),
    ).toBe("pass");
    expect(run("preview-environment", { ".github/workflows/p.yml": "run: docker compose up\nrun: test" })).toBe(
      "fail",
    );
  });
  test("staged-canary-deploy", () => {
    expect(run("staged-canary-deploy", { ".github/workflows/d.yml": "deploy canary" })).toBe("pass");
    expect(
      run("staged-canary-deploy", { ".github/workflows/d.yml": "environment: staging\nenvironment: production" }),
    ).toBe("pass");
  });
  test("staged-canary-deploy: staging+production in lockfile/OpenAPI/compose does not pass", () => {
    const both = "servers:\n  - url: https://staging.example.com\n  - url: https://production.example.com\n";
    expect(
      run("staged-canary-deploy", {
        "package.json": '{"name":"app"}',
        "pnpm-lock.yaml": "staging-utils@1.0.0:\n  production-deps@2.0.0:\n",
        "openapi.yaml": both,
        "docker-compose.yml": both,
      }),
    ).toBe("fail");
  });
  test("staged-canary-deploy: staging+production in deploy-ish paths passes", () => {
    const both = "env: staging\n---\nenv: production\n";
    expect(run("staged-canary-deploy", { "deploy/values.yaml": both })).toBe("pass");
    expect(run("staged-canary-deploy", { "helm/app/values-envs.yaml": both })).toBe("pass");
    expect(run("staged-canary-deploy", { "k8s/overlays.yml": both })).toBe("pass");
    expect(run("staged-canary-deploy", { "main.tf": 'workspace = "staging"\n# production\n' })).toBe("pass");
    // CANARY keywords still count in any yaml.
    expect(run("staged-canary-deploy", { "rollout.yaml": "kind: Rollout\n" })).toBe("pass");
  });
  test("large files: ratio threshold", () => {
    const small = Object.fromEntries(Array.from({ length: 19 }, (_, i) => [`s${i}.ts`, lines(10)]));
    expect(run("large-files-within-limit", { ...small, "big.ts": lines(501) })).toBe("pass"); // 1/20 = 5%
    expect(run("large-files-within-limit", { ...small, "big.ts": lines(501), "big2.ts": lines(600) })).toBe("fail");
    expect(run("large-files-within-limit", { "ok.ts": lines(500) })).toBe("pass");
  });
  test("vendored dirs are ignored", () => {
    expect(run("unit-tests-exist", { "node_modules/x/a.test.ts": "" })).toBe("fail");
  });
  test("rust inline tests count as unit tests", () => {
    expect(run("unit-tests-exist", { "src/lib.rs": "#[cfg(test)]\nmod t {}" })).toBe("pass");
  });
});

describe("determinism and reader isolation", () => {
  test("same fixture gives same result, regardless of listing order", () => {
    const a = runDetectors(reader(tsRepo));
    const b = runDetectors(reader(tsRepo));
    const reversed: ReadinessReader = {
      listFiles: () => Object.keys(tsRepo).reverse(),
      read: (p) => tsRepo[p],
    };
    expect(b).toEqual(a);
    expect(runDetectors(reversed)).toEqual(a);
  });
  test("detectors only observe the repo through the reader", () => {
    const seen: string[] = [];
    const spy: ReadinessReader = {
      listFiles: () => Object.keys(goRepo),
      read: (p) => {
        seen.push(p);
        return goRepo[p];
      },
    };
    runDetectors(spy);
    expect(seen.length).toBeGreaterThan(0);
    for (const p of seen) expect(Object.keys(goRepo)).toContain(p);
    // An empty reader yields only fail/n-a, never pass.
    const empty = runDetectors(reader({}));
    expect(Object.values(empty)).not.toContain("pass");
  });
  test("runDetectors returns a result for every detector", () => {
    expect(Object.keys(runDetectors(reader({}))).sort()).toEqual(Object.keys(DETECTORS).sort());
  });
});

describe("catalogue linkage", () => {
  test("every detector id exists in READINESS_CATALOGUE", () => {
    const ids = new Set(READINESS_CATALOGUE.map((c) => c.id));
    for (const id of Object.keys(DETECTORS)) expect(ids.has(id)).toBe(true);
  });
  test("covers the 22 file-answerable checks", () => {
    expect(Object.keys(DETECTORS)).toHaveLength(22);
  });
});
