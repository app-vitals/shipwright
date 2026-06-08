/**
 * scripts/quickstart.smoke.test.ts
 * Smoke test for scripts/quickstart.sh — the one-prompt local onboarding script.
 *
 * Two kinds of assertions:
 *   1. Structural (text-based parsing): the script exists, is executable, and
 *      contains the required steps (prereq checks, `task setup`, the
 *      QUICKSTART_SKIP_SERVE guard, `task dev`, the dashboard URL).
 *   2. Behavioral (actual execution): the script is run with
 *      QUICKSTART_SKIP_SERVE=1, which exercises every deterministic step
 *      (prereq checks + `task setup`) WITHOUT blocking on the long-running
 *      `task dev` server. We assert it exits 0 and does not start a server.
 *
 * NOT COVERED in CI (see the skipped test below): the real `git clone` and the
 * live `/plugin install shipwright@app-vitals/shipwright` step — neither can run
 * deterministically in CI (network + an interactive Claude Code session).
 */

import { describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

// Resolve relative to the repo root (cwd when tests run)
const SCRIPT_PATH = resolve(process.cwd(), "scripts/quickstart.sh");
const DASHBOARD_URL = "http://localhost:3460/dashboard";

// The behavioral test requires go-task to be installed. In CI it is (arduino/setup-task@v2).
// Locally it may not be — skip rather than fail so the structural tests still run.
const taskAvailable = spawnSync("which", ["task"]).status === 0;

function readScript(): string {
  return readFileSync(SCRIPT_PATH, "utf8");
}

describe("scripts/quickstart.sh — structure", () => {
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

  test("checks for the git prerequisite", () => {
    expect(readScript()).toMatch(/\bgit\b/);
  });

  test("checks for the bun prerequisite", () => {
    expect(readScript()).toMatch(/\bbun\b/);
  });

  test("checks for the task (go-task) prerequisite", () => {
    expect(readScript()).toMatch(/\btask\b/);
  });

  test("invokes `task setup`", () => {
    expect(readScript()).toMatch(/task setup/);
  });

  test("references the QUICKSTART_SKIP_SERVE guard", () => {
    expect(readScript()).toMatch(/QUICKSTART_SKIP_SERVE/);
  });

  test("references the long-running `task dev` serve step", () => {
    expect(readScript()).toMatch(/task dev/);
  });

  test("references the dashboard URL", () => {
    expect(readScript()).toContain(DASHBOARD_URL);
  });
});

describe("scripts/quickstart.sh — execution (QUICKSTART_SKIP_SERVE=1)", () => {
  (taskAvailable ? test : test.skip)(
    "runs the deterministic steps and exits 0 without starting a server",
    () => {
      // Spawn the script with the serve-skip guard set. This runs prereq
      // checks + `task setup` (bun install is idempotent) + prints next steps,
      // then exits 0 WITHOUT exec'ing `task dev`. If it exits non-zero,
      // execFileSync throws and the test fails.
      const output = execFileSync("bash", [SCRIPT_PATH], {
        cwd: process.cwd(),
        env: { ...process.env, QUICKSTART_SKIP_SERVE: "1" },
        encoding: "utf8",
        // bun install on a cold cache can take a while — keep generous.
        timeout: 240_000,
      });

      // The script reached its "next steps" message (the post-setup epilogue),
      // which only prints after prereq checks + setup succeed.
      expect(output).toContain(DASHBOARD_URL);
      // And it pointed the user at `task dev` rather than having started it.
      expect(output).toMatch(/task dev/);
    },
    240_000,
  );
});

/**
 * NOT COVERED IN CI — documented explicitly per the acceptance criteria.
 *
 * The full copy-paste onboarding prompt has two steps this smoke test cannot
 * exercise deterministically:
 *
 *   1. `git clone https://github.com/app-vitals/shipwright.git` — requires
 *      network access and produces a fresh checkout; CI already runs *inside*
 *      a checkout, so re-cloning is both impossible-in-sandbox and redundant.
 *   2. `/plugin install shipwright@app-vitals/shipwright` — runs inside an
 *      interactive Claude Code session, not a shell; there is no headless,
 *      deterministic way to invoke it from `bun test`.
 *
 * The deterministic shell portion (prereq checks + `task setup`) IS covered by
 * the execution test above via QUICKSTART_SKIP_SERVE=1.
 */
describe("scripts/quickstart.sh — explicitly out of CI scope", () => {
  test.skip("NOT COVERED: real git clone + live /plugin install cannot run in CI", () => {
    // Intentionally skipped — see the block comment above for why.
  });
});
