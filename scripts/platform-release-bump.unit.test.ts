/**
 * scripts/platform-release-bump.unit.test.ts
 *
 * The receiver's version bump (AGR-4.1): strict X.Y.Z validation, exact
 * re-pinning of registry @app-vitals/agent-* entries, workspace entries left
 * alone, formatting preserved. The repo-level cases run against a scratch
 * tree, and the CLI is exercised end to end for its exit codes.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  bumpDockerfile,
  bumpManifest,
  bumpRepo,
  findManifests,
  isStrictSemver,
} from "./platform-release-bump.ts";

const SCRIPT = join(import.meta.dir, "platform-release-bump.ts");

const MANIFEST = `{
  "name": "x",
  "workspaces": ["lib", "admin"],
  "dependencies": {
    "@shipwright/admin": "workspace:*",
    "@app-vitals/agent-lib": "0.1.0",
    "@app-vitals/agentic": "1.0.0",
    "hono": "^4.13.1"
  },
  "devDependencies": {
    "@app-vitals/agent-runtime": "0.1.0"
  }
}
`;

describe("isStrictSemver", () => {
  test.each(["0.1.0", "1.2.3", "10.20.30"])("accepts %s", (v) => {
    expect(isStrictSemver(v)).toBe(true);
  });

  test.each([
    "",
    "v1.2.3",
    "1.2",
    "1.2.3-rc.1",
    "1.2.3+build",
    "01.2.3",
    "^1.2.3",
    "1.2.3\n",
    "1.2.3; rm -rf /",
    "$(id)",
    "1.2.3 1.2.4",
  ])("rejects %j", (v) => {
    expect(isStrictSemver(v)).toBe(false);
  });
});

describe("bumpManifest", () => {
  test("re-pins registry @app-vitals/agent-* entries exactly and keeps formatting", () => {
    const r = bumpManifest(MANIFEST, "0.2.0");
    expect(r.declared).toEqual([
      "@app-vitals/agent-lib",
      "@app-vitals/agent-runtime",
    ]);
    expect(r.changed).toEqual([
      "@app-vitals/agent-lib",
      "@app-vitals/agent-runtime",
    ]);
    expect(r.text).toBe(
      MANIFEST.replace(
        '"@app-vitals/agent-lib": "0.1.0"',
        '"@app-vitals/agent-lib": "0.2.0"',
      ).replace(
        '"@app-vitals/agent-runtime": "0.1.0"',
        '"@app-vitals/agent-runtime": "0.2.0"',
      ),
    );
  });

  test("leaves workspace entries and look-alike names untouched", () => {
    const pkg = JSON.parse(bumpManifest(MANIFEST, "0.2.0").text);
    expect(pkg.dependencies["@shipwright/admin"]).toBe("workspace:*");
    expect(pkg.dependencies["@app-vitals/agentic"]).toBe("1.0.0");
    expect(pkg.dependencies.hono).toBe("^4.13.1");
  });

  test("reports no change when already on the version", () => {
    const once = bumpManifest(MANIFEST, "0.2.0").text;
    const twice = bumpManifest(once, "0.2.0");
    expect(twice.changed).toEqual([]);
    expect(twice.text).toBe(once);
  });

  test("pins a range back to an exact version", () => {
    const r = bumpManifest(
      `{"dependencies":{"@app-vitals/agent-lib":"^0.1.0"}}`,
      "0.1.1",
    );
    expect(JSON.parse(r.text).dependencies["@app-vitals/agent-lib"]).toBe(
      "0.1.1",
    );
  });

  test("throws on a non-strict version instead of writing it", () => {
    expect(() => bumpManifest(MANIFEST, '0.2.0"; "x')).toThrow(
      "not a strict X.Y.Z version",
    );
  });
});

describe("bumpDockerfile", () => {
  test("rewrites only the PLATFORM_VERSION arg", () => {
    const r = bumpDockerfile(
      "ARG PLATFORM_VERSION=0.1.0\nARG OTHER=0.1.0\n",
      "0.2.0",
    );
    expect(r).toEqual({
      text: "ARG PLATFORM_VERSION=0.2.0\nARG OTHER=0.1.0\n",
      changed: true,
    });
  });

  test("is a no-op when current or absent, and rejects a non-strict version", () => {
    expect(
      bumpDockerfile("ARG PLATFORM_VERSION=0.2.0\n", "0.2.0").changed,
    ).toBe(false);
    expect(bumpDockerfile("FROM x\n", "0.2.0").changed).toBe(false);
    expect(() =>
      bumpDockerfile("ARG PLATFORM_VERSION=0.1.0\n", "0.2.0\nRUN x"),
    ).toThrow();
  });
});

describe("bumpRepo / CLI", () => {
  let root: string;
  const put = (path: string, text: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  const read = (path: string) => readFileSync(join(root, path), "utf8");

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "platform-bump-"));
    put("package.json", MANIFEST);
    put(
      "admin/package.json",
      `{"dependencies":{"@app-vitals/agent-lib":"0.1.0"}}\n`,
    );
    put("site/package.json", `{"dependencies":{"astro":"^5"}}\n`);
    put(
      "node_modules/@app-vitals/agent-lib/package.json",
      `{"dependencies":{"@app-vitals/agent-lib":"0.0.1"}}\n`,
    );
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  test("findManifests skips node_modules", () => {
    expect(findManifests(root)).toEqual([
      "admin/package.json",
      "package.json",
      "site/package.json",
    ]);
  });

  test("bumps every declaring manifest and nothing else", () => {
    const r = bumpRepo(root, "0.3.0");
    expect(r.declaring).toEqual(["admin/package.json", "package.json"]);
    expect(r.updated).toEqual(["admin/package.json", "package.json"]);
    expect(JSON.parse(read("admin/package.json")).dependencies).toEqual({
      "@app-vitals/agent-lib": "0.3.0",
    });
    expect(read("site/package.json")).toBe(`{"dependencies":{"astro":"^5"}}\n`);
    expect(read("node_modules/@app-vitals/agent-lib/package.json")).toContain(
      "0.0.1",
    );
    expect(bumpRepo(root, "0.3.0").updated).toEqual([]);
  });

  test("re-pins ARG PLATFORM_VERSION in agent/Dockerfile and reports it as updated", () => {
    put(
      "agent/Dockerfile",
      "# c\nARG PLATFORM_VERSION=0.1.0\nFROM ghcr.io/app-vitals/agent:${PLATFORM_VERSION}\n",
    );
    const r = bumpRepo(root, "0.3.0");
    expect(r.updated).toContain("agent/Dockerfile");
    expect(read("agent/Dockerfile")).toBe(
      "# c\nARG PLATFORM_VERSION=0.3.0\nFROM ghcr.io/app-vitals/agent:${PLATFORM_VERSION}\n",
    );
    expect(bumpRepo(root, "0.3.0").updated).toEqual([]);
  });

  function cli(...args: string[]) {
    const p = Bun.spawnSync(["bun", SCRIPT, ...args, "--root", root]);
    return {
      code: p.exitCode,
      out: p.stdout.toString(),
      err: p.stderr.toString(),
    };
  }

  test("CLI bumps and exits 0", () => {
    const r = cli("0.4.0");
    expect(r.code).toBe(0);
    expect(r.out).toContain("Pinned @app-vitals/agent-* to 0.4.0");
    expect(
      JSON.parse(read("package.json")).dependencies["@app-vitals/agent-lib"],
    ).toBe("0.4.0");
  });

  test("CLI rejects an injected version loudly and writes nothing", () => {
    const before = read("package.json");
    const r = cli("0.4.0$(touch pwned)");
    expect(r.code).toBe(1);
    expect(r.err).toContain("expected strict X.Y.Z");
    expect(read("package.json")).toBe(before);
  });

  test("CLI fails when nothing declares a registry platform dependency", () => {
    rmSync(join(root, "package.json"));
    rmSync(join(root, "admin/package.json"));
    const r = cli("0.4.0");
    expect(r.code).toBe(1);
    expect(r.err).toContain("nothing to bump");
  });

  test("CLI usage error without a version", () => {
    expect(cli().code).toBe(2);
  });
});
