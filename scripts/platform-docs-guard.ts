/**
 * scripts/platform-docs-guard.ts
 *
 * Snapshot guard (PLD-2.1, same shape as the AGR-2.4 freeze guard).
 * docs/platform/ is a generated, read-only snapshot of the platform docs. This
 * fails any PR that touches it unless the PR comes from the platform release
 * bump branch, the only writer.
 *
 * Usage (CI): bun scripts/platform-docs-guard.ts <changed-files.txt> <head-branch>
 */

import { readFileSync } from "node:fs";
import { PLATFORM_REPO, SNAPSHOT_DIR } from "./platform-docs-snapshot.ts";

/** Branch the platform-release workflow pushes the bump to. */
export const BUMP_BRANCH = "chore/platform-release";

export interface DocsGuardResult {
  ok: boolean;
  bypassed: boolean;
  touched: string[];
}

/** Changed files inside the snapshot directory. */
export function findSnapshotPaths(changed: string[]): string[] {
  return changed.filter((f) => f.startsWith(`${SNAPSHOT_DIR}/`));
}

export function evaluate(changed: string[], headBranch: string): DocsGuardResult {
  const touched = findSnapshotPaths(changed);
  const bypassed = touched.length > 0 && headBranch === BUMP_BRANCH;
  return { ok: touched.length === 0 || bypassed, bypassed, touched };
}

export function formatFailure(touched: string[]): string {
  return [
    `This PR hand-edits ${touched.length} file(s) in ${SNAPSHOT_DIR}/, a read-only snapshot of the platform docs:`,
    ...touched.map((f) => `  - ${f}`),
    "",
    `Edit the doc in https://github.com/${PLATFORM_REPO} instead; the next platform release refreshes the snapshot via the ${BUMP_BRANCH} PR.`,
  ].join("\n");
}

if (import.meta.main) {
  const [changedFile, headBranch = ""] = process.argv.slice(2);
  if (!changedFile) {
    console.error("usage: platform-docs-guard.ts <changed-files.txt> [head-branch]");
    process.exit(2);
  }
  const changed = readFileSync(changedFile, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const result = evaluate(changed, headBranch);
  if (result.bypassed) {
    console.log(
      `Snapshot refresh from ${BUMP_BRANCH} (${result.touched.length} file(s)).`,
    );
  } else if (!result.ok) {
    console.error(formatFailure(result.touched));
    process.exit(1);
  } else {
    console.log(`No ${SNAPSHOT_DIR}/ paths touched.`);
  }
}
