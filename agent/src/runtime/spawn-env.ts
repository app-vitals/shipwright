/**
 * agent/src/runtime/spawn-env.ts
 *
 * Builds the extraEnv for a Claude spawn, adding the SHIPWRIGHT_GH_OWNER hint
 * the `gh` wrapper uses to pick the matching App installation token (GOR-1.3).
 * Additive: nothing enforces the hint yet.
 *
 *   - "loop": owner of the dispatched task or PR's repo
 *   - "cron": the default org (pinned installation, else lowest installation id)
 *   - "dm":   deliberately NO hint — a Slack DM is not tied to an org
 *
 * Observability: a loop or cron spawn that should carry the hint but has no
 * resolvable owner logs ONE warn line. Spawns with an owner, and DM spawns,
 * log nothing.
 */

import type { InstallationsSnapshot } from "./github-installations.ts";

export type SpawnKind = "loop" | "cron" | "dm";

interface BuildSpawnEnvOptions {
  kind: SpawnKind;
  /** Task id (loop) or cron job id (cron); named in the warn line. */
  id?: string;
  /** The resolved owner, if any. Ignored for "dm". */
  owner?: string | null;
  /** Existing env (e.g. SLACK_CHANNEL_ID) — preserved, never overwritten by an absent hint. */
  extraEnv?: Record<string, string>;
  warn?: (message: string) => void;
}

/**
 * Returns extraEnv merged with SHIPWRIGHT_GH_OWNER when an owner is known.
 * Returns the input extraEnv untouched (possibly undefined) otherwise.
 */
export function buildSpawnEnv(
  opts: BuildSpawnEnvOptions,
): Record<string, string> | undefined {
  const { kind, id, owner, extraEnv, warn = console.warn } = opts;
  if (kind === "dm") return extraEnv;
  if (!owner) {
    warn(
      `[spawn-env] ${kind} spawn${id ? ` ${id}` : ""} has no resolvable GitHub owner — running without SHIPWRIGHT_GH_OWNER`,
    );
    return extraEnv;
  }
  return { ...extraEnv, SHIPWRIGHT_GH_OWNER: owner };
}

/** The default installation's owner login, or null when none is known. */
export function defaultOwnerOf(
  snapshot: InstallationsSnapshot | null | undefined,
): string | null {
  if (!snapshot || snapshot.defaultId === null) return null;
  return (
    snapshot.installations.find((i) => i.id === snapshot.defaultId)?.owner ??
    null
  );
}
