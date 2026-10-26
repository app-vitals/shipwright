/**
 * agent-platform-image.content.test.ts
 *
 * AGR-4.3a: agent/Dockerfile.platform builds the Shipwright coding agent FROM the
 * published platform image as a candidate alongside agent/Dockerfile. Nothing
 * ships from it until AGR-4.3b, so build-agent.yml (the only path that tags
 * agent-v* and triggers the poller rollout) must not reference it.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = import.meta.dir;
const read = (file: string) => readFileSync(join(ROOT, file), "utf8");

describe("platform-based agent candidate image (AGR-4.3a)", () => {
  it("build-agent.yml does not reference Dockerfile.platform", () => {
    const wf = read(".github/workflows/build-agent.yml");
    expect(wf).not.toContain("Dockerfile.platform");
    expect(wf).toContain("-f agent/Dockerfile");
  });

  it("the candidate publish workflow never creates a release tag", () => {
    const wf = read(".github/workflows/publish-agent-platform-candidate.yml")
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("#"))
      .join("\n");
    expect(wf).not.toContain("agent-v");
    expect(wf).not.toContain("git/refs");
    expect(wf).not.toContain("workflow_run");
    expect(wf).toContain("platform-candidate-");
  });

  it("builds FROM the platform image at the pinned agent-lib version", () => {
    const df = read("agent/Dockerfile.platform");
    const pin = JSON.parse(read("agent/package.json")).dependencies[
      "@app-vitals/agent-lib"
    ];
    expect(df).toContain(`ARG PLATFORM_VERSION=${pin}\n`);
    expect(df).toContain("FROM ghcr.io/app-vitals/agent:${PLATFORM_VERSION}");
  });

  it("layers the coding extension, plugins, marketplace and specialties", () => {
    const df = read("agent/Dockerfile.platform");
    for (const needle of [
      "agent/src/coding ./agent/src/coding",
      "/app/plugins ./plugins",
      "/app/.claude-plugin ./.claude-plugin",
      "specialties ./specialties",
      'import "./agent/src/index.ts";',
    ]) {
      expect(df).toContain(needle);
    }
  });

  it("keeps the existing image build and runs all contract checks on the candidate in CI", () => {
    const ci = read(".github/workflows/ci.yml");
    expect(ci).toContain(
      "docker build -f agent/Dockerfile -t shipwright-agent:ci .",
    );
    expect(ci).toContain(
      "docker build -f agent/Dockerfile.platform -t shipwright-agent:ci-platform .",
    );
    const job = ci.slice(ci.indexOf("  agent-platform-docker-build:"));
    for (const needle of [
      "verify-browser-launch.ts",
      "verify-cgroup-delegation.ts",
      "SHIPWRIGHT_CONTRACT_BASE_IMAGE=shipwright-agent:ci-platform",
      "base-image-contract.smoke.test.ts",
    ]) {
      expect(job).toContain(needle);
    }
  });
});
