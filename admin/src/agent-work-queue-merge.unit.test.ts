/**
 * admin/src/agent-work-queue-merge.unit.test.ts
 *
 * Unit tests for the pure merge/dedupe and eligibility-index helpers in
 * agent-work-queue-merge.ts. No I/O — pure logic only.
 */

import { describe, expect, it } from "bun:test";
import {
  type AgentForEligibility,
  type AgentSnapshotForMerge,
  annotateEligibility,
  buildEligibilityIndex,
  lookupEligibleAgents,
  mergeWorkQueueSnapshots,
} from "./agent-work-queue-merge.ts";

// ─── Helpers ─────────────────────────────────────────────────────────────────

interface TestItem {
  type: "task" | "pr";
  id: string;
  repo?: string;
  title?: string;
}

function makeItem(overrides: Partial<TestItem> = {}): TestItem {
  return {
    type: "task",
    id: "item-1",
    ...overrides,
  };
}

function makeSnapshot(
  overrides: Partial<AgentSnapshotForMerge<TestItem>> = {},
): AgentSnapshotForMerge<TestItem> {
  return {
    agentId: "agent-1",
    items: [],
    ...overrides,
  };
}

function makeAgent(
  overrides: Partial<AgentForEligibility> = {},
): AgentForEligibility {
  return {
    id: "agent-1",
    repos: [],
    ...overrides,
  };
}

// ─── mergeWorkQueueSnapshots ────────────────────────────────────────────────

describe("mergeWorkQueueSnapshots", () => {
  it("returns [] for an empty snapshot list", () => {
    expect(mergeWorkQueueSnapshots([])).toEqual([]);
  });

  it("dedupes identical (type,id) items across N agents' snapshots into one row with a correct queuedByAgentIds list", () => {
    const shared = makeItem({ type: "task", id: "t1", title: "Shared task" });
    const snapshots = [
      makeSnapshot({ agentId: "agent-a", items: [shared] }),
      makeSnapshot({ agentId: "agent-b", items: [shared] }),
      makeSnapshot({ agentId: "agent-c", items: [shared] }),
    ];

    const merged = mergeWorkQueueSnapshots(snapshots);

    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({
      type: "task",
      id: "t1",
      title: "Shared task",
    });
    expect(merged[0]?.queuedByAgentIds).toEqual([
      "agent-a",
      "agent-b",
      "agent-c",
    ]);
  });

  it("keeps an item that appears in only one agent's snapshot with a single-element queuedByAgentIds", () => {
    const solo = makeItem({ type: "pr", id: "pr1" });
    const snapshots = [
      makeSnapshot({ agentId: "agent-a", items: [solo] }),
      makeSnapshot({ agentId: "agent-b", items: [] }),
    ];

    const merged = mergeWorkQueueSnapshots(snapshots);

    expect(merged).toHaveLength(1);
    expect(merged[0]?.queuedByAgentIds).toEqual(["agent-a"]);
  });

  it("keeps distinct (type,id) items as separate rows, and disambiguates by type even when id collides", () => {
    const taskItem = makeItem({ type: "task", id: "shared-id" });
    const prItem = makeItem({ type: "pr", id: "shared-id" });
    const snapshots = [
      makeSnapshot({ agentId: "agent-a", items: [taskItem, prItem] }),
    ];

    const merged = mergeWorkQueueSnapshots(snapshots);

    expect(merged).toHaveLength(2);
    expect(merged.find((m) => m.type === "task")?.queuedByAgentIds).toEqual([
      "agent-a",
    ]);
    expect(merged.find((m) => m.type === "pr")?.queuedByAgentIds).toEqual([
      "agent-a",
    ]);
  });

  it("appends an agent to queuedByAgentIds even if the same agent's snapshot lists the same item twice (reflects reality of what was queued)", () => {
    const dup = makeItem({ type: "task", id: "t1" });
    const snapshots = [makeSnapshot({ agentId: "agent-a", items: [dup, dup] })];

    const merged = mergeWorkQueueSnapshots(snapshots);

    expect(merged).toHaveLength(1);
    expect(merged[0]?.queuedByAgentIds).toEqual(["agent-a", "agent-a"]);
  });

  it("handles an agent snapshot with an empty items array without error", () => {
    const merged = mergeWorkQueueSnapshots([
      makeSnapshot({ agentId: "agent-a", items: [] }),
    ]);
    expect(merged).toEqual([]);
  });
});

// ─── buildEligibilityIndex ──────────────────────────────────────────────────

describe("buildEligibilityIndex", () => {
  it("builds a repo -> agentId[] map directly from the agent list, independent of any items/lookup call", () => {
    const agents = [
      makeAgent({ id: "agent-a", repos: ["org/repo-1", "org/repo-2"] }),
      makeAgent({ id: "agent-b", repos: ["org/repo-1"] }),
    ];

    const index = buildEligibilityIndex(agents);

    // Assert the index's shape directly — this is what verifies the
    // index-building step runs independent of item count (AC2).
    expect(index).toBeInstanceOf(Map);
    expect(index.get("org/repo-1")).toEqual(["agent-a", "agent-b"]);
    expect(index.get("org/repo-2")).toEqual(["agent-a"]);
    expect(index.size).toBe(2);
  });

  it("returns an empty index for an empty agent list", () => {
    const index = buildEligibilityIndex([]);
    expect(index.size).toBe(0);
  });

  it("an agent with an empty repos[] contributes no eligibility matches for any repo", () => {
    const agents = [
      makeAgent({ id: "agent-a", repos: [] }),
      makeAgent({ id: "agent-b", repos: ["org/repo-1"] }),
    ];

    const index = buildEligibilityIndex(agents);

    expect(index.size).toBe(1);
    expect(index.get("org/repo-1")).toEqual(["agent-b"]);
    // agent-a appears nowhere in the index at all.
    for (const agentIds of index.values()) {
      expect(agentIds).not.toContain("agent-a");
    }
  });
});

// ─── lookupEligibleAgents ───────────────────────────────────────────────────

describe("lookupEligibleAgents", () => {
  it("returns the agentIds registered for a repo present in the index", () => {
    const index = buildEligibilityIndex([
      makeAgent({ id: "agent-a", repos: ["org/repo-1"] }),
    ]);
    expect(lookupEligibleAgents(index, "org/repo-1")).toEqual(["agent-a"]);
  });

  it("returns an empty array (not an error) for a repo matching zero agents", () => {
    const index = buildEligibilityIndex([
      makeAgent({ id: "agent-a", repos: ["org/repo-1"] }),
    ]);
    expect(lookupEligibleAgents(index, "org/unknown-repo")).toEqual([]);
  });

  it("returns an empty array for an empty index", () => {
    const index = buildEligibilityIndex([]);
    expect(lookupEligibleAgents(index, "org/repo-1")).toEqual([]);
  });
});

// ─── annotateEligibility ────────────────────────────────────────────────────

describe("annotateEligibility", () => {
  it("adds eligibleAgentIds to each item based on its repo field, via the prebuilt index", () => {
    const index = buildEligibilityIndex([
      makeAgent({ id: "agent-a", repos: ["org/repo-1"] }),
      makeAgent({ id: "agent-b", repos: ["org/repo-1", "org/repo-2"] }),
    ]);
    const items = [
      { type: "task" as const, id: "t1", repo: "org/repo-1" },
      { type: "task" as const, id: "t2", repo: "org/repo-2" },
    ];

    const annotated = annotateEligibility(items, index);

    expect(annotated).toEqual([
      {
        type: "task",
        id: "t1",
        repo: "org/repo-1",
        eligibleAgentIds: ["agent-a", "agent-b"],
      },
      {
        type: "task",
        id: "t2",
        repo: "org/repo-2",
        eligibleAgentIds: ["agent-b"],
      },
    ]);
  });

  it("gives an item whose repo matches zero agents an empty eligibleAgentIds array, not an error", () => {
    const index = buildEligibilityIndex([
      makeAgent({ id: "agent-a", repos: ["org/repo-1"] }),
    ]);
    const items = [{ type: "task" as const, id: "t1", repo: "org/no-match" }];

    const annotated = annotateEligibility(items, index);

    expect(annotated).toEqual([
      { type: "task", id: "t1", repo: "org/no-match", eligibleAgentIds: [] },
    ]);
  });

  it("returns [] for an empty items list", () => {
    const index = buildEligibilityIndex([
      makeAgent({ id: "agent-a", repos: ["org/repo-1"] }),
    ]);
    expect(annotateEligibility([], index)).toEqual([]);
  });
});

// ─── End-to-end composition ─────────────────────────────────────────────────

interface TestItemWithRepo {
  type: "task" | "pr";
  id: string;
  repo: string;
}

describe("mergeWorkQueueSnapshots + buildEligibilityIndex + annotateEligibility composed", () => {
  it("produces merged rows carrying both queuedByAgentIds and eligibleAgentIds", () => {
    const item: TestItemWithRepo = {
      type: "task",
      id: "t1",
      repo: "org/repo-1",
    };
    const snapshots: AgentSnapshotForMerge<TestItemWithRepo>[] = [
      { agentId: "agent-a", items: [item] },
      { agentId: "agent-b", items: [item] },
    ];
    const agents = [
      makeAgent({ id: "agent-a", repos: ["org/repo-1"] }),
      makeAgent({ id: "agent-c", repos: ["org/repo-1"] }),
    ];

    const merged = mergeWorkQueueSnapshots(snapshots);
    const index = buildEligibilityIndex(agents);
    const annotated = annotateEligibility(merged, index);

    expect(annotated).toEqual([
      {
        type: "task",
        id: "t1",
        repo: "org/repo-1",
        queuedByAgentIds: ["agent-a", "agent-b"],
        eligibleAgentIds: ["agent-a", "agent-c"],
      },
    ]);
  });
});
