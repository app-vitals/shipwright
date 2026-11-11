/**
 * Base-image contract guard (ARD-2.1).
 *
 * Downstream images build FROM the shipwright-agent image and
 * COPY a marketplace to the /opt/shipwright/marketplaces/ convention root. This
 * test builds such a derived image the same way and asserts the contract:
 *   - a marketplace at the convention root registers at boot via installPlugins()
 *   - /app/runtime/entrypoint-main.ts exists and runs under `bun run`
 *
 * Needs a Docker daemon and an already-built base image, so it is image-level
 * smoke and opt-in: set SHIPWRIGHT_CONTRACT_BASE_IMAGE (CI sets it to the image
 * built by the `agent docker build` job). Skipped otherwise.
 *
 * The platform-based image (agent/Dockerfile, AGR-4.3a/4.3b) keeps
 * the runtime at /app/runtime, so the two module paths are overridable:
 * SHIPWRIGHT_CONTRACT_SETUP_MODULE and SHIPWRIGHT_CONTRACT_ENTRYPOINT.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BASE_IMAGE = process.env.SHIPWRIGHT_CONTRACT_BASE_IMAGE;
const SETUP_MODULE =
  process.env.SHIPWRIGHT_CONTRACT_SETUP_MODULE ??
  "/app/runtime/setup.ts";
const ENTRYPOINT =
  process.env.SHIPWRIGHT_CONTRACT_ENTRYPOINT ??
  "/app/runtime/entrypoint-main.ts";
const CONVENTION_ROOT = "/opt/shipwright/marketplaces";
const MARKETPLACE_NAME = "contract-test";
const DERIVED_TAG = `shipwright-agent-contract:${process.pid}`;

function docker(args: string[]) {
  const proc = Bun.spawnSync(["docker", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: proc.exitCode,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  };
}

describe.skipIf(!BASE_IMAGE)("agent base-image contract", () => {
  let contextDir: string;

  beforeAll(() => {
    contextDir = mkdtempSync(join(tmpdir(), "base-image-contract-"));
    const marketplaceDir = join(contextDir, "marketplace", ".claude-plugin");
    mkdirSync(marketplaceDir, { recursive: true });
    writeFileSync(
      join(marketplaceDir, "marketplace.json"),
      JSON.stringify({
        name: MARKETPLACE_NAME,
        owner: { name: "contract-test" },
        plugins: [],
      }),
    );
    writeFileSync(
      join(contextDir, "Dockerfile"),
      [
        `FROM ${BASE_IMAGE}`,
        "USER root",
        `COPY marketplace ${CONVENTION_ROOT}/${MARKETPLACE_NAME}/`,
        "USER 1000",
        "",
      ].join("\n"),
    );
    const build = docker(["build", "-t", DERIVED_TAG, contextDir]);
    expect(build.exitCode, build.stderr).toBe(0);
  }, 300_000);

  afterAll(() => {
    docker(["rmi", "-f", DERIVED_TAG]);
    if (contextDir) rmSync(contextDir, { recursive: true, force: true });
  });

  test("installPlugins() registers a marketplace baked at the convention root", () => {
    // Recording exec: asserts what installPlugins() asks `claude` to do without
    // needing network access or a logged-in CLI inside the container.
    const script = `
      import { installPlugins } from "${SETUP_MODULE}";
      const calls = [];
      const exec = async (cmd, args) => {
        calls.push([cmd, ...args]);
        return { stdout: "", exitCode: 0 };
      };
      await installPlugins(exec, "/tmp", [], undefined, "/nonexistent/installed_plugins.json");
      console.log("CALLS:" + JSON.stringify(calls));
    `;
    const run = docker([
      "run",
      "--rm",
      "--entrypoint",
      "bun",
      DERIVED_TAG,
      "-e",
      script,
    ]);
    expect(run.exitCode, run.stderr).toBe(0);

    const line = run.stdout.split("\n").find((l) => l.startsWith("CALLS:"));
    expect(line, run.stdout).toBeDefined();
    const calls: string[][] = JSON.parse(
      (line as string).slice("CALLS:".length),
    );
    const adds = calls
      .filter(
        (c) => c.slice(0, 4).join(" ") === "claude plugin marketplace add",
      )
      .map((c) => c[4]);

    expect(adds).toContain(`${CONVENTION_ROOT}/${MARKETPLACE_NAME}`);
  }, 60_000);

  test("entrypoint-main.ts exists and runs under `bun run`", () => {
    // No agent id/url/key: runEntrypoint() reports the missing vars and exits 1.
    // A missing file or broken import graph fails differently ("Module not
    // found"), so the message proves the entrypoint actually executed.
    const run = docker([
      "run",
      "--rm",
      "--entrypoint",
      "bun",
      "-e",
      "SHIPWRIGHT_AGENT_ID=",
      "-e",
      "SHIPWRIGHT_API_URL=",
      "-e",
      "SHIPWRIGHT_AGENT_API_KEY=",
      DERIVED_TAG,
      "run",
      ENTRYPOINT,
    ]);
    expect(run.exitCode).toBe(1);
    expect(run.stdout + run.stderr).toContain("SHIPWRIGHT_AGENT_ID");
  }, 60_000);
});
