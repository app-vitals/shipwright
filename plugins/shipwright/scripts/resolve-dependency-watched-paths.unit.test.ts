// Unit tests for resolve-dependency-watched-paths.ts — pure logic, no I/O.
//
// Covers DBR-3.2's watched-path resolution: given the raw text contents of a
// target repo's renovate.json and/or .github/dependabot.yml (or their
// absence), resolve which dependency-manifest file paths that repo's PR
// review should treat as "dependency-manifest changes" — falling back to
// the universal manifest-file list when neither config is present, and
// narrowing to a repo-specific set when renovate.json's `managers` array
// explicitly restricts scope.

import { describe, expect, it } from "bun:test";
import {
  resolveDependencyWatchedPaths,
  UNIVERSAL_FALLBACK_PATHS,
} from "./resolve-dependency-watched-paths";

describe("resolveDependencyWatchedPaths — neither config present (fallback)", () => {
  it("returns the universal fallback list when both renovateJson and dependabotYml are undefined", () => {
    const result = resolveDependencyWatchedPaths({
      renovateJson: undefined,
      dependabotYml: undefined,
    });
    expect(result.source).toBe("fallback");
    expect(result.paths.sort()).toEqual([...UNIVERSAL_FALLBACK_PATHS].sort());
  });

  it("the universal fallback list includes the task-mandated manifest files", () => {
    expect(UNIVERSAL_FALLBACK_PATHS).toContain("package.json");
    expect(UNIVERSAL_FALLBACK_PATHS).toContain("go.mod");
    expect(UNIVERSAL_FALLBACK_PATHS).toContain("Gemfile");
    expect(UNIVERSAL_FALLBACK_PATHS).toContain("requirements.txt");
    expect(UNIVERSAL_FALLBACK_PATHS).toContain("Cargo.toml");
    // at least one common lockfile
    expect(
      UNIVERSAL_FALLBACK_PATHS.some((p) =>
        ["package-lock.json", "yarn.lock", "pnpm-lock.yaml", "bun.lock", "bun.lockb"].includes(p),
      ),
    ).toBe(true);
  });
});

describe("resolveDependencyWatchedPaths — renovate.json only", () => {
  it("with no `managers` field, treats Renovate as watching the full universal fallback list", () => {
    const renovateJson = JSON.stringify({
      extends: ["config:base"],
    });
    const result = resolveDependencyWatchedPaths({
      renovateJson,
      dependabotYml: undefined,
    });
    expect(result.source).toBe("renovate");
    expect(result.paths.sort()).toEqual([...UNIVERSAL_FALLBACK_PATHS].sort());
  });

  it("with `managers: [\"npm\"]`, narrows the watched-path set to npm manifests only", () => {
    const renovateJson = JSON.stringify({
      managers: ["npm"],
    });
    const result = resolveDependencyWatchedPaths({
      renovateJson,
      dependabotYml: undefined,
    });
    expect(result.source).toBe("renovate");
    expect(result.paths).toContain("package.json");
    expect(result.paths).not.toContain("go.mod");
    expect(result.paths).not.toContain("Gemfile");
    expect(result.paths).not.toContain("Cargo.toml");
    expect(result.paths).not.toContain("requirements.txt");
  });

  it("with `managers: [\"gomod\", \"cargo\"]`, narrows to go + cargo manifests only", () => {
    const renovateJson = JSON.stringify({
      managers: ["gomod", "cargo"],
    });
    const result = resolveDependencyWatchedPaths({
      renovateJson,
      dependabotYml: undefined,
    });
    expect(result.paths).toContain("go.mod");
    expect(result.paths).toContain("Cargo.toml");
    expect(result.paths).not.toContain("package.json");
    expect(result.paths).not.toContain("Gemfile");
  });

  it("malformed renovate.json (invalid JSON) falls back to the full universal list rather than throwing", () => {
    const result = resolveDependencyWatchedPaths({
      renovateJson: "{ this is not valid json",
      dependabotYml: undefined,
    });
    expect(result.source).toBe("renovate");
    expect(result.paths.sort()).toEqual([...UNIVERSAL_FALLBACK_PATHS].sort());
  });
});

describe("resolveDependencyWatchedPaths — dependabot.yml only", () => {
  it("parses a single npm update entry at the repo root", () => {
    const dependabotYml = `
version: 2
updates:
  - package-ecosystem: "npm"
    directory: "/"
    schedule:
      interval: "weekly"
`;
    const result = resolveDependencyWatchedPaths({
      renovateJson: undefined,
      dependabotYml,
    });
    expect(result.source).toBe("dependabot");
    expect(result.paths).toContain("package.json");
  });

  it("parses a bundler update entry and maps it to Gemfile paths", () => {
    const dependabotYml = `
version: 2
updates:
  - package-ecosystem: "bundler"
    directory: "/"
`;
    const result = resolveDependencyWatchedPaths({
      renovateJson: undefined,
      dependabotYml,
    });
    expect(result.paths).toContain("Gemfile");
  });

  it("joins a non-root directory prefix onto the mapped manifest filenames", () => {
    const dependabotYml = `
version: 2
updates:
  - package-ecosystem: "npm"
    directory: "/backend"
`;
    const result = resolveDependencyWatchedPaths({
      renovateJson: undefined,
      dependabotYml,
    });
    expect(result.paths).toContain("backend/package.json");
  });

  it("handles multiple updates entries across different ecosystems", () => {
    const dependabotYml = `
version: 2
updates:
  - package-ecosystem: "npm"
    directory: "/"
  - package-ecosystem: "pip"
    directory: "/scripts"
  - package-ecosystem: "gomod"
    directory: "/"
`;
    const result = resolveDependencyWatchedPaths({
      renovateJson: undefined,
      dependabotYml,
    });
    expect(result.paths).toContain("package.json");
    expect(result.paths).toContain("scripts/requirements.txt");
    expect(result.paths).toContain("go.mod");
  });

  it("malformed dependabot.yml (invalid YAML) falls back to the full universal list rather than throwing", () => {
    const result = resolveDependencyWatchedPaths({
      renovateJson: undefined,
      dependabotYml: "updates: [this is not: valid: yaml: at: all",
    });
    expect(result.source).toBe("dependabot");
    expect(result.paths.sort()).toEqual([...UNIVERSAL_FALLBACK_PATHS].sort());
  });

  it("an empty `updates: []` array watches nothing — no universal-fallback widening", () => {
    const result = resolveDependencyWatchedPaths({
      renovateJson: undefined,
      dependabotYml: `
version: 2
updates: []
`,
    });
    expect(result.source).toBe("dependabot");
    expect(result.paths).toEqual([]);
  });

  it("updates entries naming only unrecognized ecosystems watch nothing rather than the universal list", () => {
    const result = resolveDependencyWatchedPaths({
      renovateJson: undefined,
      dependabotYml: `
version: 2
updates:
  - package-ecosystem: "docker"
    directory: "/"
  - package-ecosystem: "terraform"
    directory: "/infra"
`,
    });
    expect(result.source).toBe("dependabot");
    expect(result.paths).toEqual([]);
    // Specifically must NOT spuriously watch manifests for ecosystems this
    // repo's dependabot.yml never names.
    expect(result.paths).not.toContain("go.mod");
    expect(result.paths).not.toContain("package.json");
  });

  it("keeps only the recognized ecosystems when entries are a mix of recognized and unrecognized", () => {
    const result = resolveDependencyWatchedPaths({
      renovateJson: undefined,
      dependabotYml: `
version: 2
updates:
  - package-ecosystem: "npm"
    directory: "/"
  - package-ecosystem: "docker"
    directory: "/"
`,
    });
    expect(result.paths).toContain("package.json");
    expect(result.paths).not.toContain("go.mod");
    expect(result.paths).not.toContain("Cargo.toml");
  });

  it("a dependabot.yml with no `updates` key at all is unparseable-intent and still falls back to the universal list", () => {
    const result = resolveDependencyWatchedPaths({
      renovateJson: undefined,
      dependabotYml: "version: 2\n",
    });
    expect(result.source).toBe("dependabot");
    expect(result.paths.sort()).toEqual([...UNIVERSAL_FALLBACK_PATHS].sort());
  });
});

describe("resolveDependencyWatchedPaths — both present (union)", () => {
  it("unions the renovate-narrowed set with the dependabot-derived set", () => {
    const renovateJson = JSON.stringify({ managers: ["npm"] });
    const dependabotYml = `
version: 2
updates:
  - package-ecosystem: "gomod"
    directory: "/"
`;
    const result = resolveDependencyWatchedPaths({
      renovateJson,
      dependabotYml,
    });
    expect(result.source).toBe("both");
    expect(result.paths).toContain("package.json");
    expect(result.paths).toContain("go.mod");
  });

  it("does not duplicate paths present in both sources", () => {
    const renovateJson = JSON.stringify({ managers: ["npm"] });
    const dependabotYml = `
version: 2
updates:
  - package-ecosystem: "npm"
    directory: "/"
`;
    const result = resolveDependencyWatchedPaths({
      renovateJson,
      dependabotYml,
    });
    const packageJsonCount = result.paths.filter((p) => p === "package.json").length;
    expect(packageJsonCount).toBe(1);
  });

  it("a watches-nothing dependabot.yml does not widen a narrowed renovate.json back to the universal list", () => {
    const renovateJson = JSON.stringify({ managers: ["npm"] });
    const dependabotYml = `
version: 2
updates: []
`;
    const result = resolveDependencyWatchedPaths({
      renovateJson,
      dependabotYml,
    });
    expect(result.source).toBe("both");
    expect(result.paths).toContain("package.json");
    expect(result.paths).not.toContain("go.mod");
    expect(result.paths).not.toContain("Cargo.toml");
  });
});
