#!/usr/bin/env bun
/**
 * scripts/platform-release-bump.ts
 *
 * Receiver side of the platform release chain (AGR-4.1). When the platform
 * repository releases, it dispatches `platform-release` with the version
 * (AGR-3.3), and .github/workflows/platform-release.yml runs this script to
 * re-pin every registry `@app-vitals/agent-*` dependency to that exact
 * version in every package.json that declares one. `workspace:` entries
 * (packages still built here) are left alone. The workflow then refreshes
 * bun.lock and opens or updates the bump PR.
 *
 * It also re-pins `ARG PLATFORM_VERSION=` in agent/Dockerfile (AGR-4.4): the
 * shipwright-agent image is built FROM the platform image at that version, so
 * merging the bump PR is what makes build-agent.yml cut a new agent-vX image,
 * and agent-platform-image.content.test.ts requires it to equal the
 * @app-vitals/agent-lib pin.
 *
 * The version arrives from an external event, so it is validated as strict
 * `X.Y.Z` before it touches any file; anything else exits non-zero.
 *
 * Usage:
 *   bun scripts/platform-release-bump.ts <version> [--root <dir>]
 *
 * Exit codes: 0 bumped or already current, 1 invalid version or no
 * manifest declares a registry @app-vitals/agent-* dependency, 2 usage.
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

/** Strict semver core: X.Y.Z, no leading zeros, no pre-release/build suffix. */
const STRICT_SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function isStrictSemver(version: string): boolean {
  return STRICT_SEMVER.test(version);
}

const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
] as const;

/** `"@app-vitals/agent-x": "<value>"`, matched textually so formatting survives. */
const PLATFORM_ENTRY = /("(@app-vitals\/agent-[a-z0-9-]+)"\s*:\s*")([^"]*)(")/g;

export interface BumpResult {
  text: string;
  /** Registry packages declared in the manifest (bumped or already current). */
  declared: string[];
  /** Packages whose pin actually changed. */
  changed: string[];
}

/**
 * Re-pins every registry `@app-vitals/agent-*` entry of a package.json's
 * dependency fields to `version`. Workspace entries are skipped.
 */
export function bumpManifest(text: string, version: string): BumpResult {
  if (!isStrictSemver(version)) {
    throw new Error(`not a strict X.Y.Z version: ${JSON.stringify(version)}`);
  }
  const pkg = JSON.parse(text) as Record<
    string,
    Record<string, string> | undefined
  >;
  const registry = new Set<string>();
  for (const field of DEPENDENCY_FIELDS) {
    for (const [name, value] of Object.entries(pkg[field] ?? {})) {
      if (
        /^@app-vitals\/agent-/.test(name) &&
        !value.startsWith("workspace:")
      ) {
        registry.add(name);
      }
    }
  }
  const changed = new Set<string>();
  const next = text.replace(
    PLATFORM_ENTRY,
    (whole, open: string, name: string, value: string, close: string) => {
      if (!registry.has(name)) return whole;
      if (value !== version) changed.add(name);
      return `${open}${version}${close}`;
    },
  );
  return {
    text: next,
    declared: [...registry].sort(),
    changed: [...changed].sort(),
  };
}

/** The shipwright-agent Dockerfile and the build arg that selects the platform image. */
export const AGENT_DOCKERFILE = "agent/Dockerfile";
const PLATFORM_VERSION_ARG = /^(ARG PLATFORM_VERSION=)(\S*)$/m;

/** Re-pins `ARG PLATFORM_VERSION=` in a Dockerfile; `changed` is false when absent or current. */
export function bumpDockerfile(
  text: string,
  version: string,
): { text: string; changed: boolean } {
  if (!isStrictSemver(version)) {
    throw new Error(`not a strict X.Y.Z version: ${JSON.stringify(version)}`);
  }
  const match = PLATFORM_VERSION_ARG.exec(text);
  if (!match || match[2] === version) return { text, changed: false };
  return {
    text: text.replace(PLATFORM_VERSION_ARG, `$1${version}`),
    changed: true,
  };
}

const SKIP_DIRS = new Set(["node_modules", ".git", "worktrees", "dist"]);

/** Every package.json under `root`, repo-relative and sorted. */
export function findManifests(root: string, dir = root): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) {
        out.push(...findManifests(root, join(dir, entry.name)));
      }
    } else if (entry.name === "package.json") {
      out.push(relative(root, join(dir, entry.name)));
    }
  }
  return out.sort();
}

export interface RepoBump {
  /** Manifests that declare a registry @app-vitals/agent-* dependency. */
  declaring: string[];
  /** Files (manifests and the agent Dockerfile) rewritten by this run. */
  updated: string[];
}

/** Applies bumpManifest to every package.json under `root`. */
export function bumpRepo(root: string, version: string): RepoBump {
  const declaring: string[] = [];
  const updated: string[] = [];
  for (const file of findManifests(root)) {
    const path = join(root, file);
    const result = bumpManifest(readFileSync(path, "utf8"), version);
    if (result.declared.length === 0) continue;
    declaring.push(file);
    if (result.changed.length > 0) {
      writeFileSync(path, result.text);
      updated.push(file);
    }
  }
  const dockerfile = join(root, AGENT_DOCKERFILE);
  if (existsSync(dockerfile)) {
    const result = bumpDockerfile(readFileSync(dockerfile, "utf8"), version);
    if (result.changed) {
      writeFileSync(dockerfile, result.text);
      updated.push(AGENT_DOCKERFILE);
    }
  }
  return { declaring, updated };
}

function main(argv: string[]): number {
  let root = process.cwd();
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--root") {
      const dir = argv[++i];
      if (!dir) {
        console.error("--root needs a directory");
        return 2;
      }
      root = resolve(dir);
    } else {
      positional.push(argv[i]);
    }
  }
  if (positional.length !== 1) {
    console.error("usage: platform-release-bump.ts <version> [--root <dir>]");
    return 2;
  }
  const [version] = positional;
  if (!isStrictSemver(version)) {
    console.error(
      `ERROR: refusing platform release version ${JSON.stringify(version)}: expected strict X.Y.Z`,
    );
    return 1;
  }
  const { declaring, updated } = bumpRepo(root, version);
  if (declaring.length === 0) {
    console.error(
      "ERROR: no package.json declares a registry @app-vitals/agent-* dependency; nothing to bump",
    );
    return 1;
  }
  if (updated.length === 0) {
    console.log(
      `Already on @app-vitals/agent-* ${version}: ${declaring.join(", ")}`,
    );
  } else {
    console.log(
      `Pinned @app-vitals/agent-* to ${version} in: ${updated.join(", ")}`,
    );
  }
  return 0;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
