/**
 * sync-version.ts
 *
 * Writes a semver version string into the four package.json files in this
 * monorepo and into version.txt.
 *
 * Usage (CLI): bun run scripts/sync-version.ts <version>
 * Usage (API): import { syncVersion } from "./sync-version"
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

// Paths relative to the monorepo root (cwd)
const PACKAGE_JSON_PATHS = [
  "package.json",
  "plugins/shipwright/package.json",
  "plugins/shipwright/.claude-plugin/plugin.json",
  "metrics/package.json",
  "agent/package.json",
] as const;

const VERSION_TXT_PATH = "version.txt";
const MARKETPLACE_JSON_PATH = ".claude-plugin/marketplace.json";

/**
 * Semver regex: requires X.Y.Z at minimum, allows pre-release and build metadata.
 * Does NOT allow a leading "v" prefix.
 */
const SEMVER_RE =
  /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/**
 * Validates that `version` is a well-formed semver string.
 * Throws if it is not.
 */
function validateSemver(version: string): void {
  if (!SEMVER_RE.test(version)) {
    throw new Error(
      `Invalid semver: "${version}". Expected X.Y.Z (with optional pre-release/build metadata, no "v" prefix).`,
    );
  }
}

/**
 * Writes `version` into $.version in a package.json file, preserving
 * 2-space indent and a trailing newline.
 */
function writePackageJson(path: string, version: string): void {
  const raw = readFileSync(path, "utf8");
  const pkg = JSON.parse(raw) as Record<string, unknown>;
  pkg.version = version;
  writeFileSync(path, `${JSON.stringify(pkg, null, 2)}\n`, "utf8");
}

/**
 * Writes `version` into $.version in the marketplace manifest, preserving
 * 2-space indent and a trailing newline. All other fields are left unchanged.
 */
function writeMarketplaceJson(path: string, version: string): void {
  const raw = readFileSync(path, "utf8");
  const manifest = JSON.parse(raw) as Record<string, unknown>;
  manifest.version = version;
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

/**
 * Syncs `version` into all 5 package.json/plugin.json files, version.txt, and
 * .claude-plugin/marketplace.json.
 *
 * @param version - A valid semver string (e.g. "1.2.3" or "1.0.0-alpha.1")
 * @param cwd     - Monorepo root directory. Defaults to process.cwd().
 */
export function syncVersion(version: string, cwd?: string): void {
  validateSemver(version);

  const root = cwd ?? process.cwd();

  for (const rel of PACKAGE_JSON_PATHS) {
    writePackageJson(resolve(root, rel), version);
  }

  writeFileSync(resolve(root, VERSION_TXT_PATH), `${version}\n`, "utf8");

  writeMarketplaceJson(resolve(root, MARKETPLACE_JSON_PATH), version);
}

// CLI entry point
if (import.meta.main) {
  const version = process.argv[2];
  if (!version) {
    console.error("Usage: bun run scripts/sync-version.ts <version>");
    process.exit(1);
  }
  syncVersion(version);
  console.log(`Version synced to ${version}`);
}
