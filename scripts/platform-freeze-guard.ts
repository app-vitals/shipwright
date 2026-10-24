/**
 * scripts/platform-freeze-guard.ts
 *
 * Drift guard (AGR-2.4). Between the extraction push (AGR-2.3) and the cutover
 * (AGR-4.x) the platform code exists in both this repo and app-vitals/agent.
 * This fails any PR that touches a frozen path so the two copies cannot drift.
 * Removed again by AGR-4.4.
 *
 * Frozen = platform-manifest.json `include` minus `exclude` minus
 * `compositionRoots` (which stay per consumer). The `platform-cutover` label
 * bypasses the guard for the AGR-4.x cutover PRs.
 *
 * Usage (CI): bun scripts/platform-freeze-guard.ts <changed-files.txt> "<labels, comma-separated>"
 */

import { readFileSync } from "node:fs";
import { loadManifest, type PlatformManifest } from "./platform-gate.ts";

export const BYPASS_LABEL = "platform-cutover";
export const PLATFORM_REPO = "app-vitals/agent";

export interface FreezeResult {
  ok: boolean;
  bypassed: boolean;
  frozen: string[];
}

function matchesAny(globs: string[], file: string): boolean {
  return globs.some((g) => new Bun.Glob(g).match(file));
}

/** Changed files that fall inside the frozen platform paths. */
export function findFrozenPaths(
  changed: string[],
  m: PlatformManifest,
): string[] {
  const roots = m.compositionRoots.map((r) => r.path);
  return changed.filter(
    (f) =>
      matchesAny(m.include, f) &&
      !matchesAny(m.exclude, f) &&
      !roots.includes(f),
  );
}

export function evaluate(
  changed: string[],
  labels: string[],
  m: PlatformManifest,
): FreezeResult {
  const frozen = findFrozenPaths(changed, m);
  const bypassed = frozen.length > 0 && labels.includes(BYPASS_LABEL);
  return { ok: frozen.length === 0 || bypassed, bypassed, frozen };
}

export function formatFailure(frozen: string[]): string {
  return [
    `This PR touches ${frozen.length} path(s) that are frozen while the platform code is extracted to ${PLATFORM_REPO}:`,
    ...frozen.map((f) => `  - ${f}`),
    "",
    `Make the change in https://github.com/${PLATFORM_REPO} instead. Cutover PRs (AGR-4.x) may add the "${BYPASS_LABEL}" label to bypass this check.`,
  ].join("\n");
}

if (import.meta.main) {
  const [changedFile, labelArg = ""] = process.argv.slice(2);
  if (!changedFile) {
    console.error(
      "usage: platform-freeze-guard.ts <changed-files.txt> [labels]",
    );
    process.exit(2);
  }
  const changed = readFileSync(changedFile, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const labels = labelArg
    .split(",")
    .map((l) => l.trim())
    .filter(Boolean);
  const result = evaluate(changed, labels, loadManifest("platform-manifest.json"));
  if (result.bypassed) {
    console.log(
      `Bypassed via "${BYPASS_LABEL}" label (${result.frozen.length} frozen path(s) touched).`,
    );
  } else if (!result.ok) {
    console.error(formatFailure(result.frozen));
    process.exit(1);
  } else {
    console.log("No frozen platform paths touched.");
  }
}
