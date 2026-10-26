/**
 * agent-platform-image.content.test.ts
 *
 * AGR-4.3b: agent/Dockerfile builds the Shipwright coding agent FROM the
 * published platform image and is the only shipwright-agent build. build-agent.yml
 * (the path that tags agent-v* and triggers the poller rollout) builds it, and
 * the old standalone build and the candidate publish workflow are gone.
 */
import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = import.meta.dir;
const read = (file: string) => readFileSync(join(ROOT, file), "utf8");

describe("platform-based shipwright-agent image (AGR-4.3b)", () => {
  it("build-agent.yml builds agent/Dockerfile and the candidate machinery is gone", () => {
    const wf = read(".github/workflows/build-agent.yml");
    expect(wf).toContain("-f agent/Dockerfile \\");
    expect(wf).toContain("ghcr.io/app-vitals/shipwright-agent:");
    expect(existsSync(join(ROOT, "agent/Dockerfile.platform"))).toBe(false);
    expect(
      existsSync(
        join(ROOT, ".github/workflows/publish-agent-platform-candidate.yml"),
      ),
    ).toBe(false);
  });

  it("builds FROM the platform image at the pinned agent-lib version", () => {
    const df = read("agent/Dockerfile");
    const pin = JSON.parse(read("agent/package.json")).dependencies[
      "@app-vitals/agent-lib"
    ];
    expect(df).toContain(`ARG PLATFORM_VERSION=${pin}\n`);
    expect(df).toContain("FROM ghcr.io/app-vitals/agent:${PLATFORM_VERSION}");
  });

  it("installs js-yaml itself, since the platform image only overrides it", () => {
    const df = read("agent/Dockerfile");
    expect(df).toContain("bun add js-yaml@");
  });

  it("layers the coding extension, plugins, marketplace and specialties", () => {
    const df = read("agent/Dockerfile");
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

  it("copies only the coding-owned templates into the platform workspace and sets the repo root", () => {
    const df = read("agent/Dockerfile");
    const copies = df
      .split("\n")
      .filter((l) => l.startsWith("COPY") && l.includes("runtime/workspace"));
    expect(copies).toHaveLength(2);
    for (const name of ["CLAUDE.md.template", "CLAUDE-HITL.md.template"]) {
      expect(copies).toContain(
        `COPY --chown=1000:1000 agent/workspace/${name} ./runtime/workspace/${name}`,
      );
    }
    expect(df).toContain("ENV SHIPWRIGHT_REPO_ROOT=/app\n");
  });

  it("puts the gh wrapper ahead of the real gh on PATH (PLD-1.1)", () => {
    const df = read("agent/Dockerfile");
    expect(df).toContain('ENV PATH="/app/agent/scripts/bin:${PATH}"');
    expect(df).toContain("chmod +x /app/agent/scripts/bin/gh");
  });

  it("CI builds one agent image and runs every contract check on it", () => {
    const ci = read(".github/workflows/ci.yml");
    expect(ci).toContain(
      "docker build -f agent/Dockerfile -t shipwright-agent:ci .",
    );
    expect(ci).not.toContain("Dockerfile.platform");
    expect(ci).not.toContain("ci-platform");
    expect(ci).not.toContain("agent-platform-docker-build");
    const job = ci.slice(
      ci.indexOf("  agent-docker-build:"),
      ci.indexOf("  metrics-docker-build:"),
    );
    for (const needle of [
      "verify-browser-launch.ts",
      "verify-cgroup-delegation.ts",
      "SHIPWRIGHT_CONTRACT_BASE_IMAGE=shipwright-agent:ci",
      "base-image-contract.smoke.test.ts",
      "platform-real-boot.smoke.test.ts",
      "SHIPWRIGHT_GH_OWNER",
    ]) {
      expect(job).toContain(needle);
    }
  });
});
