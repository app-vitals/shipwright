/**
 * scripts/agent-workspace-pull.unit.test.ts
 * Unit tests for the pure planners in scripts/agent-workspace-pull.ts:
 * agent resolution by id vs. name (including no-match/ambiguous cases) and
 * the <root>/<name> workspace path builder. Everything with a real I/O
 * boundary (fetch, fs, gh, ensureAgentHome, installPlugins) is exercised
 * through injected doubles in agent-workspace-pull.integration.test.ts, not
 * here.
 */

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  buildWorkspaceRoot,
  detectSecretEnvKeys,
  resolveAgent,
  resolvePullRoot,
} from "./agent-workspace-pull.ts";

const AGENTS = [
  { id: "agent-1", name: "hitl", selfHosted: true },
  { id: "agent-2", name: "reviewer", selfHosted: false },
  { id: "agent-3", name: "reviewer-2", selfHosted: false },
];

describe("resolveAgent", () => {
  test("resolves by exact id match", () => {
    const result = resolveAgent("agent-2", AGENTS);
    expect(result).toEqual({
      ok: true,
      agent: { id: "agent-2", name: "reviewer", selfHosted: false },
    });
  });

  test("resolves by exact name match when no id matches", () => {
    const result = resolveAgent("hitl", AGENTS);
    expect(result).toEqual({
      ok: true,
      agent: { id: "agent-1", name: "hitl", selfHosted: true },
    });
  });

  test("id match takes precedence over a name match", () => {
    const agents = [
      { id: "reviewer", name: "some-other-agent", selfHosted: true },
      { id: "agent-2", name: "reviewer", selfHosted: false },
    ];
    const result = resolveAgent("reviewer", agents);
    expect(result).toEqual({
      ok: true,
      agent: { id: "reviewer", name: "some-other-agent", selfHosted: true },
    });
  });

  test("returns a not-found error when neither id nor name matches", () => {
    const result = resolveAgent("nonexistent", AGENTS);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("not-found");
      expect(result.message).toContain("nonexistent");
    }
  });

  test("returns an ambiguous error when multiple agents share the same name", () => {
    const agents = [
      { id: "agent-1", name: "dup", selfHosted: true },
      { id: "agent-2", name: "dup", selfHosted: false },
    ];
    const result = resolveAgent("dup", agents);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("ambiguous");
      expect(result.message).toContain("dup");
      expect(result.message).toContain("agent-1");
      expect(result.message).toContain("agent-2");
    }
  });

  test("returns [] not-found for an empty agent list", () => {
    const result = resolveAgent("anything", []);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("not-found");
    }
  });
});

describe("buildWorkspaceRoot", () => {
  test("joins the root and the resolved agent NAME, not the raw id/arg", () => {
    expect(buildWorkspaceRoot("/home/dev/.shipwright-agents", "hitl")).toBe(
      join("/home/dev/.shipwright-agents", "hitl"),
    );
  });

  test("uses the resolved name even when the CLI arg passed in was an id", () => {
    // Simulates: `bun scripts/agent-workspace-pull.ts agent-1` resolving to
    // an agent named "hitl" — the workspace root must be keyed by "hitl",
    // never "agent-1", so re-running with either the id or the name lands
    // in the same place.
    const root = "/home/dev/.shipwright-agents";
    const resolvedName = "hitl";
    expect(buildWorkspaceRoot(root, resolvedName)).toBe(join(root, "hitl"));
  });

  test("different agent names produce different, non-colliding roots under the same base", () => {
    const root = "/home/dev/.shipwright-agents";
    expect(buildWorkspaceRoot(root, "agent-a")).not.toBe(
      buildWorkspaceRoot(root, "agent-b"),
    );
  });
});

describe("resolvePullRoot", () => {
  test("defaults to ~/.shipwright-agents when SHIPWRIGHT_WORKSPACE_PULL_ROOT is unset", () => {
    expect(resolvePullRoot({}, "/home/dev")).toBe(
      join("/home/dev", ".shipwright-agents"),
    );
  });

  test("SHIPWRIGHT_WORKSPACE_PULL_ROOT overrides the default", () => {
    expect(
      resolvePullRoot(
        { SHIPWRIGHT_WORKSPACE_PULL_ROOT: "/custom/root" },
        "/home/dev",
      ),
    ).toBe("/custom/root");
  });
});

describe("detectSecretEnvKeys", () => {
  test("returns [] when the bundle env has no secret-flagged keys", () => {
    const keys = detectSecretEnvKeys({ FOO: "bar", NODE_ENV: "production" }, [
      "GH_TOKEN",
      "ANTHROPIC_API_KEY",
    ]);
    expect(keys).toEqual([]);
  });

  test("returns only the key names of secret-flagged entries present in env", () => {
    const keys = detectSecretEnvKeys(
      {
        FOO: "bar",
        GH_TOKEN: "ghp_super_secret_value",
        NODE_ENV: "production",
      },
      ["GH_TOKEN", "ANTHROPIC_API_KEY"],
    );
    expect(keys).toEqual(["GH_TOKEN"]);
  });

  test("never includes secret values anywhere in the returned data", () => {
    const keys = detectSecretEnvKeys({ GH_TOKEN: "ghp_super_secret_value" }, [
      "GH_TOKEN",
    ]);
    expect(JSON.stringify(keys)).not.toContain("ghp_super_secret_value");
  });

  test("returns [] for an empty env bundle", () => {
    expect(detectSecretEnvKeys({}, ["GH_TOKEN"])).toEqual([]);
  });

  test("preserves the order secret vars are declared in, not env insertion order", () => {
    const keys = detectSecretEnvKeys(
      { ANTHROPIC_API_KEY: "x", GH_TOKEN: "y" },
      ["GH_TOKEN", "ANTHROPIC_API_KEY"],
    );
    expect(keys).toEqual(["GH_TOKEN", "ANTHROPIC_API_KEY"]);
  });
});
