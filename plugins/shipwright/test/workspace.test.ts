/**
 * Workspace resolution smoke test.
 *
 * Verifies that the bun workspaces monorepo is correctly structured:
 * all three workspace packages exist with valid package.json files,
 * and the root package.json declares all workspaces.
 *
 * There is no business logic yet — this test exists to assert that
 * `task setup`, `task test`, etc. succeed on a clean checkout.
 */
import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

// The monorepo root is three levels up from this test file:
// plugins/shipwright/test/workspace.test.ts → root
const root = resolve(import.meta.dir, "../../..");

interface PackageJson {
  name?: string;
  version?: string;
  workspaces?: string[];
  [key: string]: unknown;
}

interface TsConfig {
  compilerOptions?: {
    strict?: boolean;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

interface BiomeConfig {
  linter?: {
    enabled?: boolean;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

function readJson<T = Record<string, unknown>>(rel: string): T {
  const abs = resolve(root, rel);
  if (!existsSync(abs)) {
    throw new Error(`Missing file: ${rel}`);
  }
  return JSON.parse(readFileSync(abs, "utf8")) as T;
}

describe("bun workspaces scaffold", () => {
  it("root package.json declares all three workspace packages", () => {
    const pkg = readJson<PackageJson>("package.json");
    const workspaces = pkg.workspaces;
    expect(Array.isArray(workspaces)).toBe(true);
    expect(workspaces).toContain("plugins/shipwright");
    expect(workspaces).toContain("metrics");
    expect(workspaces).toContain("agent");
  });

  it("plugins/shipwright has a valid package.json with a name", () => {
    const pkg = readJson<PackageJson>("plugins/shipwright/package.json");
    expect(typeof pkg.name).toBe("string");
    expect((pkg.name as string).length).toBeGreaterThan(0);
  });

  it("metrics has a valid package.json with a name", () => {
    const pkg = readJson<PackageJson>("metrics/package.json");
    expect(typeof pkg.name).toBe("string");
    expect((pkg.name as string).length).toBeGreaterThan(0);
  });

  it("agent has a valid package.json with a name", () => {
    const pkg = readJson<PackageJson>("agent/package.json");
    expect(typeof pkg.name).toBe("string");
    expect((pkg.name as string).length).toBeGreaterThan(0);
  });

  it("each workspace package has a version field", () => {
    for (const ws of ["plugins/shipwright", "metrics", "agent"]) {
      const pkg = readJson<PackageJson>(`${ws}/package.json`);
      expect(typeof pkg.version).toBe("string");
    }
  });

  it("MIT LICENSE exists at repo root", () => {
    const licensePath = resolve(root, "LICENSE");
    expect(existsSync(licensePath)).toBe(true);
    const content = readFileSync(licensePath, "utf8");
    expect(content).toContain("MIT License");
  });

  it("root tsconfig.json exists and enables strict mode", () => {
    const cfg = readJson<TsConfig>("tsconfig.json");
    const opts = cfg.compilerOptions;
    expect(opts).toBeDefined();
    expect(opts?.strict).toBe(true);
  });

  it("root biome.json exists and has linter enabled", () => {
    const cfg = readJson<BiomeConfig>("biome.json");
    const linter = cfg.linter;
    expect(linter).toBeDefined();
    expect(linter?.enabled).toBe(true);
  });
});
