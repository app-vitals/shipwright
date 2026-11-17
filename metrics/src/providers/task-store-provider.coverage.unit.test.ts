/**
 * metrics/src/providers/task-store-provider.coverage.unit.test.ts
 * Unit (CVT-3.1): the `coverage` query kind — latest snapshot per repo,
 * deltaVsPrevious, the 14-day stale flag (injected Clock), and the trend.
 */

import { describe, expect, test } from "bun:test";
import type { CoverageSnapshotRecord } from "../lib/task-store-client.ts";
import { FixedClock } from "../lib/test-helpers.ts";
import { TaskStoreProvider } from "./task-store-provider.ts";
import {
  RecordedAdminMetricsClient,
  RecordedTaskStoreClient,
} from "./task-store-recorded.ts";

const ZERO_AGG = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheCreation: 0,
  total: 0,
};

function snap(
  repo: string,
  commitSha: string,
  linesPct: number,
  measuredAt: string,
  extra: Partial<CoverageSnapshotRecord> = {},
): CoverageSnapshotRecord {
  return {
    repo,
    commitSha,
    linesPct,
    branchesPct: null,
    functionsPct: null,
    measuredAt,
    ...extra,
  };
}

function buildProvider(
  snaps: CoverageSnapshotRecord[],
  now: string,
  repo?: string,
) {
  return new TaskStoreProvider(
    new RecordedTaskStoreClient([], [], snaps),
    new RecordedAdminMetricsClient(
      {
        totals: ZERO_AGG,
        byAgent: [],
        byCron: [],
        byModel: [],
        daily: [],
        byCronModel: [],
        byPhase: [],
      },
      { totals: ZERO_AGG, byAgent: [], byModel: [], daily: [] },
    ),
    FixedClock(now),
    repo,
  );
}

type Row = Record<string, unknown>;

async function run(provider: TaskStoreProvider, kind: "repo" | "trend") {
  const t = await provider.query({ kind: "coverage" });
  return t.results
    .map((r) => Object.fromEntries(t.columns.map((c, i) => [c, r[i]])) as Row)
    .filter((r) => r.kind === kind);
}

const NOW = "2026-06-20T12:00:00.000Z";

describe("TaskStoreProvider coverage query", () => {
  test("two repos: latest linesPct and deltaVsPrevious; single snapshot has null delta", async () => {
    const provider = buildProvider(
      [
        snap("org/alpha", "a1", 80, "2026-06-10T00:00:00.000Z"),
        snap("org/alpha", "a2", 82.5, "2026-06-18T00:00:00.000Z", {
          branchesPct: 70,
          functionsPct: 91,
        }),
        snap("org/beta", "b1", 64, "2026-06-19T00:00:00.000Z"),
      ],
      NOW,
    );
    const repos = await run(provider, "repo");
    expect(repos).toHaveLength(2);
    const alpha = repos.find((r) => r.repo === "org/alpha");
    const beta = repos.find((r) => r.repo === "org/beta");
    expect(alpha).toMatchObject({
      commitSha: "a2",
      linesPct: 82.5,
      branchesPct: 70,
      functionsPct: 91,
      deltaVsPrevious: 2.5,
      stale: false,
    });
    expect(beta).toMatchObject({
      linesPct: 64,
      branchesPct: null,
      functionsPct: null,
      deltaVsPrevious: null,
      stale: false,
    });
  });

  test("negative delta is reported and rounded to 2dp", async () => {
    const provider = buildProvider(
      [
        snap("org/alpha", "a1", 80.1, "2026-06-10T00:00:00.000Z"),
        snap("org/alpha", "a2", 79.7, "2026-06-18T00:00:00.000Z"),
      ],
      NOW,
    );
    const [alpha] = await run(provider, "repo");
    expect(alpha?.deltaVsPrevious).toBe(-0.4);
  });

  test("stale is true only when the latest snapshot is more than 14 days old", async () => {
    const provider = buildProvider(
      [
        snap("org/old", "o1", 50, "2026-06-05T11:59:00.000Z"), // 15d+ old
        snap("org/edge", "e1", 60, "2026-06-06T12:00:00.000Z"), // exactly 14d
      ],
      NOW,
    );
    const repos = await run(provider, "repo");
    expect(repos.find((r) => r.repo === "org/old")?.stale).toBe(true);
    expect(repos.find((r) => r.repo === "org/edge")?.stale).toBe(false);
  });

  test("trend covers the trailing 30 days oldest first", async () => {
    const provider = buildProvider(
      [
        snap("org/alpha", "ancient", 10, "2026-04-01T00:00:00.000Z"),
        snap("org/alpha", "a1", 80, "2026-06-10T00:00:00.000Z"),
        snap("org/alpha", "a2", 82, "2026-06-18T00:00:00.000Z"),
      ],
      NOW,
    );
    const trend = await run(provider, "trend");
    expect(trend.map((r) => r.commitSha)).toEqual(["a1", "a2"]);
  });

  test("repo scope narrows repos and trend", async () => {
    const provider = buildProvider(
      [
        snap("org/alpha", "a1", 80, "2026-06-18T00:00:00.000Z"),
        snap("org/beta", "b1", 64, "2026-06-19T00:00:00.000Z"),
      ],
      NOW,
      "org/beta",
    );
    expect((await run(provider, "repo")).map((r) => r.repo)).toEqual([
      "org/beta",
    ]);
    expect((await run(provider, "trend")).map((r) => r.repo)).toEqual([
      "org/beta",
    ]);
  });

  test("no snapshots → empty table", async () => {
    const t = await buildProvider([], NOW).query({ kind: "coverage" });
    expect(t.results).toEqual([]);
  });
});
