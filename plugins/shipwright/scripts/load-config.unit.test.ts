/**
 * plugins/shipwright/scripts/load-config.unit.test.ts
 *
 * Unit tests for the pure resolvePluginConfig() function.
 *
 * Tests cover the three-tier precedence for all four new plugin-level fields:
 *   reposDir, worktreeDir, localMarketplace, devChat
 *
 * Precedence order: env var > .shipwright.json > built-in default
 *
 * All tests are pure logic — no I/O, no mock.module(), no global overrides.
 * resolvePluginConfig() accepts injected env and file config arguments.
 */

import { describe, expect, test } from "bun:test";
import { resolvePluginConfig } from "./load-config";

const HOME = "/test-home";

// ─── reposDir ─────────────────────────────────────────────────────────────────

describe("resolvePluginConfig — reposDir", () => {
  test("env var wins when both env and file are set", () => {
    const result = resolvePluginConfig(
      { reposDir: "/from-file/repos" },
      { SHIPWRIGHT_REPOS_DIR: "/from-env/repos", HOME },
    );
    expect(result.reposDir).toBe("/from-env/repos");
  });

  test("file value wins over default when only file is set", () => {
    const result = resolvePluginConfig(
      { reposDir: "/from-file/repos" },
      { HOME },
    );
    expect(result.reposDir).toBe("/from-file/repos");
  });

  test("built-in default applies when neither env nor file is set", () => {
    const result = resolvePluginConfig({}, { HOME });
    expect(result.reposDir).toBe(`${HOME}/src`);
  });
});

// ─── worktreeDir ──────────────────────────────────────────────────────────────

describe("resolvePluginConfig — worktreeDir", () => {
  test("env var wins when both env and file are set", () => {
    const result = resolvePluginConfig(
      { worktreeDir: "/from-file/worktrees" },
      { SHIPWRIGHT_WORKTREE_DIR: "/from-env/worktrees", HOME },
    );
    expect(result.worktreeDir).toBe("/from-env/worktrees");
  });

  test("file value wins over default when only file is set", () => {
    const result = resolvePluginConfig(
      { worktreeDir: "/from-file/worktrees" },
      { HOME },
    );
    expect(result.worktreeDir).toBe("/from-file/worktrees");
  });

  test("built-in default applies when neither env nor file is set", () => {
    const result = resolvePluginConfig({}, { HOME });
    expect(result.worktreeDir).toBe(`${HOME}/worktrees`);
  });
});

// ─── localMarketplace ─────────────────────────────────────────────────────────

describe("resolvePluginConfig — localMarketplace", () => {
  test("env var wins when both env and file are set — env=1 overrides file=false", () => {
    const result = resolvePluginConfig(
      { localMarketplace: false },
      { SHIPWRIGHT_LOCAL_MARKETPLACE: "1", HOME },
    );
    expect(result.localMarketplace).toBe(true);
  });

  test("env var wins when both env and file are set — env='' overrides file=true", () => {
    const result = resolvePluginConfig(
      { localMarketplace: true },
      { SHIPWRIGHT_LOCAL_MARKETPLACE: "", HOME },
    );
    expect(result.localMarketplace).toBe(false);
  });

  test("file value wins over default when only file is set — file=true", () => {
    const result = resolvePluginConfig(
      { localMarketplace: true },
      { HOME },
    );
    expect(result.localMarketplace).toBe(true);
  });

  test("file value wins over default when only file is set — file=false", () => {
    const result = resolvePluginConfig(
      { localMarketplace: false },
      { HOME },
    );
    expect(result.localMarketplace).toBe(false);
  });

  test("built-in default (false) applies when neither env nor file is set", () => {
    const result = resolvePluginConfig({}, { HOME });
    expect(result.localMarketplace).toBe(false);
  });

  test("truthy env string 'true' resolves to true", () => {
    const result = resolvePluginConfig({}, { SHIPWRIGHT_LOCAL_MARKETPLACE: "true", HOME });
    expect(result.localMarketplace).toBe(true);
  });
});

// ─── devChat ──────────────────────────────────────────────────────────────────

describe("resolvePluginConfig — devChat", () => {
  test("env var wins when both env and file are set — env=1 overrides file=false", () => {
    const result = resolvePluginConfig(
      { devChat: false },
      { SHIPWRIGHT_DEV_CHAT: "1", HOME },
    );
    expect(result.devChat).toBe(true);
  });

  test("env var wins when both env and file are set — env='' overrides file=true", () => {
    const result = resolvePluginConfig(
      { devChat: true },
      { SHIPWRIGHT_DEV_CHAT: "", HOME },
    );
    expect(result.devChat).toBe(false);
  });

  test("file value wins over default when only file is set — file=true", () => {
    const result = resolvePluginConfig(
      { devChat: true },
      { HOME },
    );
    expect(result.devChat).toBe(true);
  });

  test("built-in default (false) applies when neither env nor file is set", () => {
    const result = resolvePluginConfig({}, { HOME });
    expect(result.devChat).toBe(false);
  });

  test("truthy env string 'true' resolves to true", () => {
    const result = resolvePluginConfig({}, { SHIPWRIGHT_DEV_CHAT: "true", HOME });
    expect(result.devChat).toBe(true);
  });
});

// ─── taskStore passthrough ────────────────────────────────────────────────────

describe("resolvePluginConfig — taskStore fields passthrough", () => {
  test("taskStore field from file config is preserved", () => {
    const result = resolvePluginConfig(
      { taskStore: "github", github: { owner: "my-org", repo: "my-repo" } },
      { HOME },
    );
    expect(result.taskStore).toBe("github");
    expect(result.github).toEqual({ owner: "my-org", repo: "my-repo" });
  });

  test("taskStore defaults to json when not provided", () => {
    const result = resolvePluginConfig({}, { HOME });
    expect(result.taskStore).toBe("json");
  });
});
