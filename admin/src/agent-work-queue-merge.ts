/**
 * admin/src/agent-work-queue-merge.ts
 *
 * Pure, no-I/O helpers supporting the merged all-agent work-queue view:
 *
 *   1. mergeWorkQueueSnapshots() — takes each agent's latest
 *      AgentWorkQueueSnapshot-shaped `{ agentId, items }` pair and dedupes
 *      items across agents by `(type, id)`, annotating each surviving row
 *      with `queuedByAgentIds` — every agent whose snapshot currently
 *      contains that item.
 *
 *   2. buildEligibilityIndex() / lookupEligibleAgents() / annotateEligibility()
 *      — build a `repo -> agentId[]` index once from the fleet's Agent list
 *      (O(agents)), then apply it per merged item (O(items)) to produce
 *      `eligibleAgentIds`. This two-step index-then-lookup shape is
 *      deliberate: a nested loop over merged items (each snapshot capped at
 *      50 items) times agent count is cheap today (<10 agents) but stops
 *      being cheap as the fleet grows toward ~250 agents.
 *
 * Deliberately generic over the caller's item shape rather than importing
 * RankedWorkItem (agent/src/work-selector.ts) or AgentWorkQueueSnapshot
 * (admin/src/agent-work-queue.ts) directly — those types are owned
 * elsewhere and are not modified by this module (see AAV-1.3's AC3).
 * RankedWorkItem in particular has no `repo` field today, so the
 * eligibility step is expressed as its own generic constrained to
 * `{ repo: string }` rather than baked into the merge step's generic.
 */

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * One agent's work-queue snapshot, as seen by the merge step. Mirrors the
 * shape of AgentWorkQueueSnapshot (admin/src/agent-work-queue.ts) closely
 * enough to build from it, but is declared independently here so this
 * module never needs to import the Prisma-generated type (whose `items`
 * field is untyped JSON at the DB layer).
 */
export interface AgentSnapshotForMerge<T extends { type: string; id: string }> {
  agentId: string;
  items: T[];
}

/**
 * A merged, deduped work item — the original item fields plus the list of
 * every agent whose snapshot currently contains it. Order of
 * queuedByAgentIds follows the order snapshots were passed in (and, within
 * one agent's snapshot, the order items appeared) — no re-sorting.
 */
export type MergedWorkItem<T extends { type: string; id: string }> = T & {
  queuedByAgentIds: string[];
};

/**
 * Minimal fleet-agent shape the eligibility index needs — a subset of the
 * full Agent type in admin/src/agents-api.ts.
 */
export interface AgentForEligibility {
  id: string;
  repos: string[];
}

/** repo -> agentId[], built once from the fleet's agent list. */
export type EligibilityIndex = Map<string, string[]>;

// ─── Merge / dedupe ─────────────────────────────────────────────────────────

/**
 * Merge N agents' work-queue snapshots into one deduped list, keyed by
 * `(type, id)`. An item present in multiple agents' snapshots collapses to
 * a single row carrying every agent's id in `queuedByAgentIds`, in the
 * order those snapshots were encountered.
 *
 * If the same agent's own snapshot somehow lists the same (type, id) item
 * twice, that agent's id is appended to queuedByAgentIds once per
 * occurrence — this reflects what was actually queued rather than silently
 * de-duplicating within a single agent's list, and is intentionally
 * lenient about upstream data quality (this function does no I/O and
 * trusts its input).
 *
 * Non-key fields (title, phase, age, repo, ...) are taken from the first
 * occurrence of a given (type, id) encountered across all snapshots; later
 * occurrences only contribute their agentId to queuedByAgentIds.
 */
export function mergeWorkQueueSnapshots<T extends { type: string; id: string }>(
  snapshots: AgentSnapshotForMerge<T>[],
): MergedWorkItem<T>[] {
  const merged = new Map<string, MergedWorkItem<T>>();

  for (const snapshot of snapshots) {
    for (const item of snapshot.items) {
      const key = `${item.type}:${item.id}`;
      const existing = merged.get(key);
      if (existing) {
        existing.queuedByAgentIds.push(snapshot.agentId);
      } else {
        merged.set(key, { ...item, queuedByAgentIds: [snapshot.agentId] });
      }
    }
  }

  return [...merged.values()];
}

// ─── Eligibility index + lookup ─────────────────────────────────────────────

/**
 * Build a `repo -> agentId[]` index from the fleet's agent list — O(agents).
 * An agent with an empty `repos[]` contributes no entries. Call this once
 * per merged-view render, then reuse the returned index for every item via
 * lookupEligibleAgents()/annotateEligibility() (O(items)) — never rebuild it
 * per item, which would degrade this to an O(items x agents) nested loop.
 */
export function buildEligibilityIndex(
  agents: AgentForEligibility[],
): EligibilityIndex {
  const index: EligibilityIndex = new Map();

  for (const agent of agents) {
    for (const repo of agent.repos) {
      const agentIds = index.get(repo);
      if (agentIds) {
        agentIds.push(agent.id);
      } else {
        index.set(repo, [agent.id]);
      }
    }
  }

  return index;
}

/**
 * Look up the agentIds eligible for a given repo via a prebuilt
 * EligibilityIndex — O(1). Returns [] (never throws) when no agent lists
 * that repo.
 */
export function lookupEligibleAgents(
  index: EligibilityIndex,
  repo: string,
): string[] {
  return index.get(repo) ?? [];
}

/**
 * Annotate a list of items (each carrying a `repo` field) with
 * `eligibleAgentIds`, via a prebuilt EligibilityIndex — O(items) given an
 * already-built index. Intended to run on mergeWorkQueueSnapshots()'s
 * output, but independently pure/testable on any `{ repo: string }`-shaped
 * item list.
 */
export function annotateEligibility<T extends { repo: string }>(
  items: T[],
  index: EligibilityIndex,
): (T & { eligibleAgentIds: string[] })[] {
  return items.map((item) => ({
    ...item,
    eligibleAgentIds: lookupEligibleAgents(index, item.repo),
  }));
}
