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
 * NOT COVERED by this file (see the skipped test below): the real `git clone`
 * and the plugin install. The install path is covered by the clean-box job,
 * .github/workflows/quickstart-clean-box.yml, which runs the working form
 * `claude plugin marketplace add` + `claude plugin install shipwright@shipwright`.
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
 * NOT COVERED HERE — documented explicitly per the acceptance criteria.
 *
 *   1. `git clone https://github.com/app-vitals/shipwright.git` — requires
 *      network access; CI already runs *inside* a checkout, so re-cloning is
 *      redundant.
 *   2. The plugin install. The working form is
 *        claude plugin marketplace add app-vitals/shipwright
 *        claude plugin install shipwright@shipwright
 *      (the `/plugin ...` slash forms only work inside an interactive session).
 *      It is exercised by the clean-box job, .github/workflows/quickstart-clean-box.yml,
 *      which also boots scripts/local-store.sh and round-trips a task over HTTP.
 *      That job cannot run `/shipwright:plan-session` or `dev-task`: they need
 *      an authenticated model session and a GitHub target.
 *
 * The deterministic shell portion (prereq checks + `task setup`) IS covered by
 * the execution test above via QUICKSTART_SKIP_SERVE=1.
 */
describe("scripts/quickstart.sh — explicitly out of CI scope", () => {
  test.skip("NOT COVERED HERE: git clone + plugin install (see quickstart-clean-box.yml)", () => {
    // Intentionally skipped — see the block comment above for why.
  });
});
