/**
 * plugins/shipwright/scripts/load-config.ts
 *
 * Full Shipwright plugin config type and pure resolver function.
 *
 * Precedence (highest → lowest) for each field:
 *   1. Environment variable
 *   2. .shipwright.json value
 *   3. Built-in default
 *
 * The resolver is a pure function that accepts injected env and file config
 * so it can be unit-tested without any I/O or global-state overrides.
 */

import type { TaskStoreConfig } from "./store";

// ─── ShiprightConfig ──────────────────────────────────────────────────────────

/**
 * Full Shipwright plugin config — covers all fields that can be set via
 * .shipwright.json or environment variables.
 */
export interface ShiprightConfig extends TaskStoreConfig {
  /**
   * Root directory where git repos are cloned.
   *
   * Env:     SHIPWRIGHT_REPOS_DIR
   * Default: $HOME/src
   */
  reposDir: string;

  /**
   * Root directory where worktrees are created.
   *
   * Env:     SHIPWRIGHT_WORKTREE_DIR
   * Default: $HOME/worktrees
   */
  worktreeDir: string;

  /**
   * When true, use the local marketplace instead of the remote one.
   *
   * Env:     SHIPWRIGHT_LOCAL_MARKETPLACE (truthy: "1", "true")
   * Default: false
   */
  localMarketplace: boolean;

  /**
   * When true, enable the dev chat endpoint.
   *
   * Env:     SHIPWRIGHT_DEV_CHAT (truthy: "1", "true")
   * Default: false
   */
  devChat: boolean;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Interpret an env var string as a boolean.
 * "1" and "true" (case-insensitive) are truthy; anything else (including
 * absent / empty) is falsy.
 */
function envBool(value: string | undefined): boolean {
  if (value === undefined || value === "") return false;
  const v = value.trim().toLowerCase();
  return v === "1" || v === "true";
}

// ─── Resolver ─────────────────────────────────────────────────────────────────

/**
 * Resolve the full ShiprightConfig by merging file config with env overrides
 * and built-in defaults.
 *
 * @param fileConfig  Parsed fields from .shipwright.json (may be partial)
 * @param env         Env var map — pass process.env in production, a plain
 *                    object in tests (no global state leakage)
 */
export function resolvePluginConfig(
  fileConfig: Partial<ShiprightConfig>,
  env: Record<string, string | undefined>,
): ShiprightConfig {
  const home = env.HOME ?? "";

  // ── reposDir ──────────────────────────────────────────────────────────────
  const reposDir =
    env.SHIPWRIGHT_REPOS_DIR?.trim() ||
    fileConfig.reposDir ||
    `${home}/src`;

  // ── worktreeDir ───────────────────────────────────────────────────────────
  const worktreeDir =
    env.SHIPWRIGHT_WORKTREE_DIR?.trim() ||
    fileConfig.worktreeDir ||
    `${home}/worktrees`;

  // ── localMarketplace ──────────────────────────────────────────────────────
  // Env var is present (even if empty string) → env wins
  const localMarketplace =
    env.SHIPWRIGHT_LOCAL_MARKETPLACE !== undefined
      ? envBool(env.SHIPWRIGHT_LOCAL_MARKETPLACE)
      : (fileConfig.localMarketplace ?? false);

  // ── devChat ───────────────────────────────────────────────────────────────
  const devChat =
    env.SHIPWRIGHT_DEV_CHAT !== undefined
      ? envBool(env.SHIPWRIGHT_DEV_CHAT)
      : (fileConfig.devChat ?? false);

  // ── taskStore + github (passthrough from file, default to json) ───────────
  const taskStore = fileConfig.taskStore ?? "json";
  const github = fileConfig.github;

  return {
    taskStore,
    ...(github !== undefined ? { github } : {}),
    reposDir,
    worktreeDir,
    localMarketplace,
    devChat,
  };
}
