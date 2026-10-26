/**
 * Platform candidate real-boot guard (PCB-2.2).
 *
 * base-image-contract.smoke.test.ts proves the entrypoint runs and a baked
 * marketplace registers, but it passed on a platform candidate that could not
 * boot a coding agent (AGR-5.1 checkpoint). This test runs the runtime's real
 * setup code inside the image as the production user (uid 1000) with a scratch
 * HOME and the image's own environment, and asserts the two failure classes
 * that checkpoint found:
 *   - ensureAgentHome() with the default (coding) type completes and seeds
 *     CLAUDE.md, and every template the coding specialty ships resolves
 *     (including CLAUDE-HITL.md.template)
 *   - the built-in marketplace registers and `shipwright@shipwright` installs
 *
 * Needs a Docker daemon and an already-built image, so it is image-level smoke
 * and opt-in: set SHIPWRIGHT_CONTRACT_BASE_IMAGE (CI sets it to
 * shipwright-agent:ci). Skipped otherwise. Module paths are
 * overridable like base-image-contract.smoke.test.ts:
 * SHIPWRIGHT_CONTRACT_SETUP_MODULE and SHIPWRIGHT_CONTRACT_TEMPLATES_DIR.
 * No network or secrets are needed.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";

const BASE_IMAGE = process.env.SHIPWRIGHT_CONTRACT_BASE_IMAGE;
const SETUP_MODULE =
  process.env.SHIPWRIGHT_CONTRACT_SETUP_MODULE ??
  "/app/runtime/setup.ts";
const TEMPLATES_DIR =
  process.env.SHIPWRIGHT_CONTRACT_TEMPLATES_DIR ??
  join(dirname(SETUP_MODULE), "workspace");
const SCRATCH_HOME = "/tmp/real-boot-home";

// Every template the coding specialty ships (specialties/coding/manifest.yaml
// points identity.templatesDir at agent/workspace/).
const CODING_TEMPLATES = readdirSync(
  join(import.meta.dir, "..", "..", "workspace"),
).filter((name) => name.endsWith(".template"));

/** Runs a bun script in the image as uid 1000 with only HOME overridden. */
function runInImage(script: string) {
  const proc = Bun.spawnSync(
    [
      "docker",
      "run",
      "--rm",
      "--user",
      "1000",
      "--security-opt=no-new-privileges",
      "-e",
      `HOME=${SCRATCH_HOME}`,
      "--entrypoint",
      "bun",
      BASE_IMAGE as string,
      "-e",
      script,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const stdout = proc.stdout.toString();
  const stderr = proc.stderr.toString();
  const line = stdout.split("\n").find((l) => l.startsWith("RESULT:"));
  return {
    exitCode: proc.exitCode,
    stdout,
    stderr,
    result: line ? JSON.parse(line.slice("RESULT:".length)) : undefined,
  };
}

describe.skipIf(!BASE_IMAGE)("platform image real coding boot", () => {
  test("ensureAgentHome() with the default type seeds CLAUDE.md and every coding template resolves", () => {
    const script = `
      import { existsSync, mkdirSync } from "node:fs";
      import { join } from "node:path";
      import { ensureAgentHome } from "${SETUP_MODULE}";
      const home = "${SCRATCH_HOME}";
      mkdirSync(home, { recursive: true });
      const warnings = [];
      console.warn = (...a) => warnings.push(a.join(" "));
      let error = null;
      try { ensureAgentHome(home); } catch (e) { error = String(e); }
      const missing = ${JSON.stringify(CODING_TEMPLATES)}
        .filter((t) => !existsSync(join("${TEMPLATES_DIR}", t)));
      console.log("RESULT:" + JSON.stringify({
        error,
        warnings,
        missing,
        claudeMd: existsSync(join(home, "workspace", "CLAUDE.md")),
      }));
    `;
    const run = runInImage(script);
    expect(run.result, run.stdout + run.stderr).toBeDefined();
    expect(run.result.error).toBeNull();
    expect(run.result.missing).toEqual([]);
    expect(run.result.claudeMd).toBe(true);
    expect(run.result.warnings).toEqual([]);
  }, 120_000);

  test("the built-in marketplace registers and shipwright@shipwright installs with the image's own environment", () => {
    // Real `claude` through the runtime's own installPlugins(): its default
    // repo root is the image's own resolution, so a wrong root fails the add.
    const script = `
      import { mkdirSync } from "node:fs";
      import { installPlugins } from "${SETUP_MODULE}";
      mkdirSync("${SCRATCH_HOME}", { recursive: true });
      const calls = [];
      const exec = async (cmd, args, opts) => {
        const p = Bun.spawn([cmd, ...args], { cwd: opts?.cwd, stdout: "pipe", stderr: "pipe" });
        const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
        const exitCode = await p.exited;
        calls.push({ args: args.join(" "), exitCode, output: (out + err).slice(-500) });
        return { stdout: out + err, exitCode };
      };
      await installPlugins(exec, "${SCRATCH_HOME}");
      console.log("RESULT:" + JSON.stringify({ calls }));
    `;
    const run = runInImage(script);
    expect(run.result, run.stdout + run.stderr).toBeDefined();
    const calls: { args: string; exitCode: number; output: string }[] =
      run.result.calls;
    // `plugin update` may reach for the network; only add/install are the contract.
    const add = calls.find((c) => c.args.startsWith("plugin marketplace add"));
    const install = calls.find(
      (c) => c.args === "plugin install shipwright@shipwright",
    );
    expect(add, JSON.stringify(calls)).toBeDefined();
    expect(add?.exitCode, JSON.stringify(add)).toBe(0);
    expect(install, JSON.stringify(calls)).toBeDefined();
    expect(install?.exitCode, JSON.stringify(install)).toBe(0);
  }, 180_000);
});
