/**
 * scripts/agent-workspace-pull.ts
 * Operator CLI: mirrors a REAL, already-deployed Shipwright agent's
 * workspace onto the local machine, so an operator can drive `claude`
 * against it directly for one-off investigation/dev-loop work — no
 * dispatch loop, no local task-store/admin services.
 *
 * Usage:
 *   bun scripts/agent-workspace-pull.ts <id-or-name>
 *
 * Resolves the given id/name against GET /agents (admin-tier, via
 * SHIPWRIGHT_API_URL/SHIPWRIGHT_ADMIN_API_KEY), matching by id first then by
 * name. Fetches the resolved agent's config bundle via the existing
 * HttpShipwrightRuntimeClient.getAgentConfigBundle(), clones every repo in
 * the bundle's `repos` list via `gh repo clone` (skipping repos already
 * present — relies on the OPERATOR's own `gh auth login`, not the agent's
 * own GH_TOKEN), scaffolds the workspace via the existing ensureAgentHome(),
 * and installs the bundle's plugins via the existing installPlugins().
 *
 * Workspace root is always keyed by the resolved agent NAME, never the raw
 * CLI arg (which may have been an id):
 *
 *   ${SHIPWRIGHT_WORKSPACE_PULL_ROOT:-~/.shipwright-agents}/<name>
 *
 * — so the same root can hold multiple mirrored agents without collision,
 * and re-running with either the id or the name lands in the same place.
 *
 * On completion, prints the resolved workspace path plus the env vars still
 * needed for local `claude` invocations (SHIPWRIGHT_REPO_DIR,
 * SHIPWRIGHT_WORKTREE_DIR). SHIPWRIGHT_TASK_STORE_URL/
 * SHIPWRIGHT_TASK_STORE_TOKEN are left untouched — this script never manages
 * task-store auth.
 *
 * The config bundle's `env` field (which may contain secrets like GH_TOKEN)
 * is NEVER written to disk. If any of its keys match the well-known
 * secret-shaped env var list, this script warns with the key NAMES only,
 * never the values.
 *
 * Out of scope: no dispatch loop (the operator drives `claude` themselves),
 * no local task-store/admin service startup, no task-store token minting,
 * no changes to the real agent's own K8s deployment. The config bundle has
 * no `policy` field, so state/agent-policy.md is always seeded from the
 * static default template (via ensureAgentHome), not a copy of the real
 * agent's live autonomy settings.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentConfigResponse, AgentPlugin } from "@shipwright/admin";
import {
  ensureAgentHome,
  installPlugins as realInstallPlugins,
} from "../agent/src/setup.ts";
import { HttpShipwrightRuntimeClient } from "../agent/src/shipwright-runtime-client.ts";
import { SECRET_ENV_VARS } from "../lib/secret-env-vars.ts";
import { computeMissingClones } from "./lib/clone-plan.ts";

// ---------------------------------------------------------------------------
// Agent summary (GET /agents list-summary shape — no `repos` field, mirrors
// admin's AgentSummarySchema / scripts/hitl.ts's local AgentSummary type).
// ---------------------------------------------------------------------------

export interface AgentSummary {
  id: string;
  name: string;
  selfHosted: boolean;
}

// ---------------------------------------------------------------------------
// Agent resolution — pure planner: id first, then name; no-match/ambiguous
// are reported as typed failures rather than thrown, so callers can format
// the error message however fits their context (CLI stderr vs. a test
// assertion).
// ---------------------------------------------------------------------------

export type ResolveAgentResult =
  | { ok: true; agent: AgentSummary }
  | { ok: false; reason: "not-found" | "ambiguous"; message: string };

/**
 * Resolves `idOrName` against `agents`: matches by id first, then falls back
 * to matching by name. Pure — no I/O, so id/name resolution and its edge
 * cases (no match, multiple agents sharing a name) are unit-testable without
 * a real admin service.
 */
export function resolveAgent(
  idOrName: string,
  agents: AgentSummary[],
): ResolveAgentResult {
  const byId = agents.find((a) => a.id === idOrName);
  if (byId) return { ok: true, agent: byId };

  const byName = agents.filter((a) => a.name === idOrName);
  if (byName.length === 1)
    return { ok: true, agent: byName[0] as AgentSummary };
  if (byName.length > 1) {
    return {
      ok: false,
      reason: "ambiguous",
      message: `Multiple agents are named "${idOrName}": ${byName
        .map((a) => a.id)
        .join(", ")}. Pass the agent id instead.`,
    };
  }

  return {
    ok: false,
    reason: "not-found",
    message: `No agent found with id or name "${idOrName}".`,
  };
}

// ---------------------------------------------------------------------------
// Workspace root — <root>/<resolved-name>, never the raw CLI arg.
// ---------------------------------------------------------------------------

/**
 * Builds the workspace root path for a resolved agent: `<root>/<name>`.
 * Pure — always keyed by the resolved agent NAME (never the raw id/name the
 * operator typed on the CLI), so the same root can hold multiple mirrored
 * agents without collision, and re-running against either the id or the
 * name of the same agent lands in the same directory.
 */
export function buildWorkspaceRoot(root: string, resolvedName: string): string {
  return join(root, resolvedName);
}

/**
 * Resolves the workspace-pull root dir from env + home dir:
 * `${SHIPWRIGHT_WORKSPACE_PULL_ROOT:-~/.shipwright-agents}`. Pure — the
 * env→default mapping is unit-testable without touching process.env.
 */
export function resolvePullRoot(
  env: Record<string, string | undefined>,
  homeDir: string,
): string {
  return (
    env.SHIPWRIGHT_WORKSPACE_PULL_ROOT ?? join(homeDir, ".shipwright-agents")
  );
}

// ---------------------------------------------------------------------------
// Secret-flagged env detection — key NAMES only, never values.
// ---------------------------------------------------------------------------

/**
 * Given the config bundle's `env` map and the well-known secret-shaped env
 * var name list (SECRET_ENV_VARS), returns the key NAMES present in `env`
 * that are secret-flagged — in SECRET_ENV_VARS's declared order. Pure and
 * value-free by construction: it never touches or returns any value from
 * `env`, only key names, so a caller logging its result can never leak a
 * secret.
 */
export function detectSecretEnvKeys(
  env: Record<string, string>,
  secretVars: readonly string[] = SECRET_ENV_VARS,
): string[] {
  return secretVars.filter((key) => key in env);
}

// ---------------------------------------------------------------------------
// GET /agents — admin-tier agent list, for id/name resolution.
// ---------------------------------------------------------------------------

type FetchLike = typeof fetch;

/**
 * Fetches the agent summary list from GET /agents (admin-tier, bearer
 * SHIPWRIGHT_ADMIN_API_KEY auth). Defaults to the real global fetch — the
 * entrypoint calls this with no fetchImpl. Tests inject a fake so the
 * request shape (URL, auth header) and the non-ok-response failure path are
 * assertable without a real admin service.
 */
export async function fetchAgentList(
  apiUrl: string,
  apiKey: string,
  fetchImpl: FetchLike = fetch,
): Promise<AgentSummary[]> {
  const res = await fetchImpl(`${apiUrl}/agents`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) {
    throw new Error(`GET /agents failed: ${res.status}`);
  }
  return (await res.json()) as AgentSummary[];
}

// ---------------------------------------------------------------------------
// Orchestration — pullAgentWorkspace() composes resolution, config-bundle
// fetch, clone planning, workspace scaffolding, and plugin install through
// an injected-deps object, mirroring hitl.ts's injected-exec pattern. The
// real (I/O-performing) implementations of each dep are wired in the
// import.meta.main entrypoint below; tests inject doubles.
// ---------------------------------------------------------------------------

export interface PullAgentWorkspaceDeps {
  /** GET /agents — resolves the id/name against the live agent list. */
  fetchAgents: () => Promise<AgentSummary[]>;
  /** Fetches the resolved agent's config bundle (repos, plugins, env, ...). */
  fetchConfigBundle: (agentId: string) => Promise<AgentConfigResponse>;
  /** Existence check for the clone-skip plan — injectable for tests. */
  exists: (path: string) => boolean;
  /** Clones a single repo ("org/repo") to `dest` via `gh repo clone`. */
  cloneRepo: (repo: string, dest: string) => Promise<void>;
  /** Scaffolds the workspace dir structure + identity files. */
  ensureAgentHome: (home: string) => void;
  /** Installs the bundle's plugins (defaults + agent-specific). */
  installPlugins: (agentPlugins: AgentPlugin[]) => Promise<void>;
  log: (line: string) => void;
  warn: (line: string) => void;
}

export interface PullAgentWorkspaceResult {
  agent: AgentSummary;
  workspaceRoot: string;
  clonedRepos: string[];
  skippedRepos: string[];
  secretEnvKeys: string[];
}

/**
 * Drives the full workspace-pull sequence: resolve -> fetch config bundle ->
 * plan clones -> scaffold workspace -> install plugins. Pure orchestration
 * over injected deps — no direct I/O of its own, so the composition (and
 * every edge case: unresolved agent, already-cloned repos, secret-flagged
 * env keys) is testable without a real admin service, gh, or filesystem.
 */
export async function pullAgentWorkspace(
  idOrName: string,
  pullRoot: string,
  deps: PullAgentWorkspaceDeps,
): Promise<PullAgentWorkspaceResult> {
  const agents = await deps.fetchAgents();
  const resolved = resolveAgent(idOrName, agents);
  if (!resolved.ok) {
    throw new Error(resolved.message);
  }
  const { agent } = resolved;

  const workspaceRoot = buildWorkspaceRoot(pullRoot, agent.name);
  // Clone into <workspaceRoot>/workspace/repos to match ensureAgentHome()'s
  // scaffolding (agent/src/setup.ts) and the documented
  // <AGENT_HOME>/workspace/repos convention (docs/configuration.md) — so the
  // clones and the scaffolded state/identity files live in one coherent
  // mirrored tree, not disconnected siblings.
  const reposDir = join(workspaceRoot, "workspace", "repos");

  const bundle = await deps.fetchConfigBundle(agent.id);

  const secretEnvKeys = detectSecretEnvKeys(bundle.env);
  if (secretEnvKeys.length > 0) {
    deps.warn(
      `config bundle env includes secret-flagged keys (values NOT written to disk): ${secretEnvKeys.join(", ")}`,
    );
  }

  const plan = computeMissingClones(bundle.repos, reposDir, deps.exists);
  const missingSet = new Set(plan.map((p) => p.repo));
  const skippedRepos = bundle.repos.filter((r) => !missingSet.has(r));

  for (const { repo, dest } of plan) {
    deps.log(`cloning ${repo} into ${dest}...`);
    await deps.cloneRepo(repo, dest);
  }
  for (const repo of skippedRepos) {
    deps.log(`${repo} already present — skipping clone`);
  }

  deps.ensureAgentHome(workspaceRoot);

  deps.log("installing plugins...");
  await deps.installPlugins(bundle.plugins);

  return {
    agent,
    workspaceRoot,
    clonedRepos: plan.map((p) => p.repo),
    skippedRepos,
    secretEnvKeys,
  };
}

// ---------------------------------------------------------------------------
// Main entrypoint
// ---------------------------------------------------------------------------

async function realCloneRepo(repo: string, dest: string): Promise<void> {
  const result = Bun.spawnSync(["gh", "repo", "clone", repo, dest], {
    stdout: "inherit",
    stderr: "inherit",
  });
  if (result.exitCode !== 0) {
    throw new Error(`gh repo clone failed for ${repo}`);
  }
}

if (import.meta.main) {
  const idOrName = process.argv[2];
  if (!idOrName) {
    console.error("Usage: bun scripts/agent-workspace-pull.ts <id-or-name>");
    process.exit(1);
  }

  const apiUrl = process.env.SHIPWRIGHT_API_URL;
  const apiKey = process.env.SHIPWRIGHT_ADMIN_API_KEY;

  const missing: string[] = [];
  if (!apiUrl) missing.push("SHIPWRIGHT_API_URL");
  if (!apiKey) missing.push("SHIPWRIGHT_ADMIN_API_KEY");
  if (missing.length > 0) {
    for (const m of missing) {
      console.error(`Error: missing required env var: ${m}`);
    }
    process.exit(1);
  }

  const pullRoot = resolvePullRoot(process.env, homedir());
  const client = new HttpShipwrightRuntimeClient({
    apiUrl: apiUrl as string,
    apiKey: apiKey as string,
  });

  try {
    const result = await pullAgentWorkspace(idOrName, pullRoot, {
      fetchAgents: () => fetchAgentList(apiUrl as string, apiKey as string),
      fetchConfigBundle: (agentId) => client.getAgentConfigBundle(agentId),
      exists: existsSync,
      cloneRepo: realCloneRepo,
      ensureAgentHome: (home) => ensureAgentHome(home),
      installPlugins: (agentPlugins) =>
        realInstallPlugins(undefined, undefined, agentPlugins),
      log: (line) => console.log(`[agent-workspace-pull] ${line}`),
      warn: (line) => console.warn(`[agent-workspace-pull] warning: ${line}`),
    });

    const reposDir = join(result.workspaceRoot, "workspace", "repos");
    const worktreesDir = join(result.workspaceRoot, "workspace", "worktrees");

    console.log("");
    console.log(`workspace ready: ${result.workspaceRoot}`);
    console.log("");
    console.log(
      "Env vars for local `claude` invocations (task-store auth is unmanaged):",
    );
    console.log(`  export SHIPWRIGHT_REPO_DIR="${reposDir}"`);
    console.log(`  export SHIPWRIGHT_WORKTREE_DIR="${worktreesDir}"`);
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
