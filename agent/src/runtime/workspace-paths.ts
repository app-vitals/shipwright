/**
 * agent/src/runtime/workspace-paths.ts
 *
 * Workspace-root and `org/repo` helpers shared by runtime passes (the
 * worktree reaper) and the coding check scripts. Lives in runtime so the
 * reaper does not import across the runtime -> coding boundary;
 * check-helpers.ts re-exports both for its existing importers.
 */

import { join } from "node:path";

/**
 * Resolve the agent workspace root.
 *
 * Priority:
 * 1. WORKSPACE_PATH env var (explicit override)
 * 2. AGENT_HOME/workspace (standard harness layout)
 *
 * Throws rather than falling back to a default path — a misconfigured agent
 * (missing AGENT_HOME) should fail loudly rather than silently read from the
 * wrong workspace and produce confusing results.
 */
export function resolveWorkspacePath(): string {
  const envPath = (process.env.WORKSPACE_PATH ?? "").trim();
  if (envPath) return envPath;
  const agentHome = (process.env.AGENT_HOME ?? "").trim();
  if (!agentHome)
    throw new Error("AGENT_HOME is not set — cannot resolve workspace path");
  return join(agentHome, "workspace");
}

/** Split "org/repo" into [org, repo], defaulting org to "app-vitals" for a bare repo name. */
export function splitOrgRepo(repo: string): [string, string] {
  return repo.includes("/")
    ? (repo.split("/", 2) as [string, string])
    : ["app-vitals", repo];
}
