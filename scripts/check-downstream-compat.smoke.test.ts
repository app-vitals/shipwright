/**
 * scripts/check-downstream-compat.smoke.test.ts
 * Smoke test for scripts/check-downstream-compat.sh — the downstream-
 * compatibility render-diff script.
 *
 * Two kinds of assertions:
 *   1. Structural (text-based parsing): the script exists, is executable,
 *      and contains the Render A restore-guard that reads back the
 *      wrapper's own Chart.lock / vendored charts/ dir after copy_wrapper()
 *      has deleted them from the destination.
 *   2. Behavioral (actual execution): the exact `copy_wrapper()` function
 *      and Render-A-restore-guard block are extracted live from the script
 *      file's text (not re-typed) and run, via bash, against a synthetic
 *      wrapper fixture that has a Chart.lock but NO vendored charts/ dir —
 *      the layout that regresses if the guard checks the wrong (already
 *      copy_wrapper()-deleted) destination path instead of the source
 *      wrapper path. Extracting straight from the file means this test
 *      exercises the real code, not a hand-copied stand-in that could
 *      silently drift from it.
 *      A full end-to-end `helm template` run isn't used here because it
 *      requires a wrapper chart with a real `shipwright` dependency (or,
 *      in self-referential mode, a full diff against charts/shipwright)
 *      to reach a meaningful pass/fail — orthogonal to what this guard
 *      does, which is purely a restore-into-a-scratch-dir filesystem step.
 */

import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Resolve relative to the repo root (cwd when tests run)
const SCRIPT_PATH = resolve(process.cwd(), "scripts/check-downstream-compat.sh");

function readScript(): string {
  return readFileSync(SCRIPT_PATH, "utf8");
}

describe("scripts/check-downstream-compat.sh — structure", () => {
  test("the script file exists", () => {
    expect(() => statSync(SCRIPT_PATH)).not.toThrow();
  });

  test("the script is executable (has the executable bit)", () => {
    const mode = statSync(SCRIPT_PATH).mode;
    expect(mode & 0o111).toBeGreaterThan(0);
  });

  test("uses strict bash mode (set -euo pipefail)", () => {
    expect(readScript()).toMatch(/set -euo pipefail/);
  });

  test("copy_wrapper drops charts/ and Chart.lock from its destination", () => {
    expect(readScript()).toMatch(/rm -rf "\$\{dest\}\/charts" "\$\{dest\}\/Chart\.lock"/);
  });

  test("the Render A restore guard reads back the WRAPPER_DIR source, not the already-emptied RENDER_A_DIR destination", () => {
    // Regression test for the bug fixed on this line: the guard used to
    // check `-f "${RENDER_A_DIR}/Chart.lock"` — the destination
    // copy_wrapper() had just deleted, so it was always false — instead of
    // `-f "${WRAPPER_DIR}/Chart.lock"` (the source, matching the inner
    // check a few lines below).
    expect(readScript()).toMatch(
      /if \[\[ -f "\$\{WRAPPER_DIR\}\/Chart\.lock" \|\| -d "\$\{WRAPPER_DIR\}\/charts" \]\]; then/,
    );
  });
});

describe("scripts/check-downstream-compat.sh — Render A restore guard (extracted, executed)", () => {
  test("restores Chart.lock into the Render A scratch dir for a wrapper with a lock file but no charts/ dir", () => {
    // This is the exact layout the bug silently broke: a lock file
    // committed, but vendored .tgz dependency archives gitignored (no
    // charts/ dir on disk) — common downstream.
    const script = readScript();
    const copyWrapperStart = script.indexOf("copy_wrapper() {");
    const copyWrapperEnd = script.indexOf("\n}", copyWrapperStart) + 2;
    const copyWrapperFn = script.slice(copyWrapperStart, copyWrapperEnd);
    expect(copyWrapperFn).toContain("rm -rf");

    const guardStart = script.indexOf('if [[ -f "${WRAPPER_DIR}/Chart.lock"');
    const guardEnd = script.indexOf("\nfi", guardStart) + 3;
    const guardBlock = script.slice(guardStart, guardEnd);
    expect(guardBlock).toContain("cp ");

    const wrapperDir = mkdtempSync(join(tmpdir(), "check-downstream-compat-wrapper-"));
    const renderADir = mkdtempSync(join(tmpdir(), "check-downstream-compat-render-a-"));
    try {
      // Minimal wrapper: a lock file, no charts/ dir.
      writeFileSync(join(wrapperDir, "Chart.lock"), "dependencies: []\n");
      writeFileSync(join(wrapperDir, "Chart.yaml"), "apiVersion: v2\nname: fixture\nversion: 0.1.0\n");

      const harness = [
        "set -euo pipefail",
        `WRAPPER_DIR=${JSON.stringify(wrapperDir)}`,
        `RENDER_A_DIR=${JSON.stringify(renderADir)}`,
        copyWrapperFn,
        'copy_wrapper "${RENDER_A_DIR}"',
        guardBlock,
      ].join("\n");

      execFileSync("bash", ["-c", harness], { encoding: "utf8" });

      // The bug: the guard checked -f "${RENDER_A_DIR}/Chart.lock" — the
      // destination copy_wrapper() had just deleted — so it was always
      // false and this restore never happened.
      expect(() => statSync(join(renderADir, "Chart.lock"))).not.toThrow();
    } finally {
      rmSync(wrapperDir, { recursive: true, force: true });
      rmSync(renderADir, { recursive: true, force: true });
    }
  });
});

describe("scripts/check-downstream-compat.sh — image-tag allowlist (extracted, executed)", () => {
  // The A-vs-B allowlist logic lives in a Python heredoc embedded in the
  // bash script (between `python3 - "${AB_DIFF}" "${OFFENDING}" <<'PYEOF'`
  // and the closing `PYEOF`). Extract it verbatim and run it as a real
  // Python script against synthetic diff fixtures, so this test exercises
  // the actual allowlist code rather than a hand-copied stand-in.
  function extractAllowlistScript(): string {
    const script = readScript();
    const heredocStart = script.indexOf("<<'PYEOF'\n", script.indexOf("python3 - \"${AB_DIFF}\""));
    expect(heredocStart).toBeGreaterThan(-1);
    const bodyStart = heredocStart + "<<'PYEOF'\n".length;
    const bodyEnd = script.indexOf("\nPYEOF", bodyStart);
    expect(bodyEnd).toBeGreaterThan(bodyStart);
    return script.slice(bodyStart, bodyEnd);
  }

  function runAllowlist(diffText: string): string {
    const pyScript = extractAllowlistScript();
    const scratchDir = mkdtempSync(join(tmpdir(), "check-downstream-compat-allowlist-"));
    try {
      const diffPath = join(scratchDir, "ab.diff");
      const outPath = join(scratchDir, "ab.offending");
      writeFileSync(diffPath, diffText);
      execFileSync("python3", ["-c", pyScript, diffPath, outPath], { encoding: "utf8" });
      return readFileSync(outPath, "utf8");
    } finally {
      rmSync(scratchDir, { recursive: true, force: true });
    }
  }

  test("regression: a digest-pinned image with a different digest is NOT allowlisted (surfaces as a real diff)", () => {
    // Two genuinely different sha256 digests on an otherwise-identical
    // "image:" line. Before the fix, IMAGE_TAG_RE's greedy `[^:\s]+` swallowed
    // the whole `@sha256:<hex>` segment as if it were a tag, normalizing both
    // lines to the same placeholder and silently allowlisting the diff.
    const diff = [
      "--- a/render-a.norm.yaml\n",
      "+++ b/render-b.norm.yaml\n",
      "@@ -1,1 +1,1 @@\n",
      "-  image: ghcr.io/app-vitals/shipwright@sha256:aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111\n",
      "+  image: ghcr.io/app-vitals/shipwright@sha256:bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222\n",
    ].join("");

    const offending = runAllowlist(diff);
    expect(offending).toContain("@sha256:aaaa1111");
    expect(offending).toContain("@sha256:bbbb2222");
  });

  test("no regression: a plain tag-only image change is still allowlisted", () => {
    const diff = [
      "--- a/render-a.norm.yaml\n",
      "+++ b/render-b.norm.yaml\n",
      "@@ -1,1 +1,1 @@\n",
      "-  image: ghcr.io/app-vitals/shipwright:1.2.3\n",
      "+  image: ghcr.io/app-vitals/shipwright:1.2.4\n",
    ].join("");

    const offending = runAllowlist(diff);
    expect(offending).toBe("");
  });
});
