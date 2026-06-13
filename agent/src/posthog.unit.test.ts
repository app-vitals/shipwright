/**
 * Tests for agent/src/posthog.ts — snapshotMetrics and forwardNewMetrics.
 *
 * Both forwardNewMetrics and forwardTokenUsage accept an optional fetchFn
 * parameter for DI — tests pass a mock directly, following the same pattern
 * as makeWhisperSvcClient in voice.ts.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TokenUsage } from "./claude.ts";
import {
  forwardNewMetrics,
  forwardTokenUsage,
  snapshotMetrics,
} from "./posthog.ts";

const SAMPLE_ENTRY = JSON.stringify({
  task: "T-009",
  title: "Update test.yml",
  session: "test-readiness",
  repo: "example-org/my-project",
  estimated_h: null,
  pr: 1031,
  files_changed: 1,
  started_at: "2026-05-13T05:45:00.000Z",
  ts: "2026-05-13T05:46:00.000Z",
  simplify: {
    total: 0,
    dry: 0,
    dead_code: 0,
    naming: 0,
    complexity: 0,
    consistency: 0,
  },
  requirements: { met: 3, partial: 0, not_met: 0, total: 4 },
  ci: { fix_attempts: 0, failures: [] },
});

const SAMPLE_ENTRY_2 = JSON.stringify({
  task: "T-010",
  title: "Add canary stub",
  session: "test-readiness",
  repo: "example-org/my-project",
  pr: 1032,
  ts: "2026-05-13T06:00:00.000Z",
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeTmpWorkspace(): string {
  const ws = mkdtempSync(join(tmpdir(), "posthog-test-ws-"));
  mkdirSync(join(ws, "state"), { recursive: true });
  mkdirSync(join(ws, "planning"), { recursive: true });
  return ws;
}

// ─── snapshotMetrics ──────────────────────────────────────────────────────────

describe("snapshotMetrics", () => {
  test("returns empty Map when no metrics files exist", () => {
    const ws = makeTmpWorkspace();
    const snap = snapshotMetrics(ws);
    expect(snap.size).toBe(0);
    rmSync(ws, { recursive: true });
  });

  test("records line count for state/metrics.jsonl", () => {
    const ws = makeTmpWorkspace();
    writeFileSync(
      join(ws, "state", "metrics.jsonl"),
      `${SAMPLE_ENTRY}\n${SAMPLE_ENTRY_2}\n`,
    );

    const snap = snapshotMetrics(ws);
    expect(snap.get(join(ws, "state", "metrics.jsonl"))).toBe(2);
    rmSync(ws, { recursive: true });
  });

  test("records line count for planning/metrics.jsonl", () => {
    const ws = makeTmpWorkspace();
    writeFileSync(join(ws, "planning", "metrics.jsonl"), `${SAMPLE_ENTRY}\n`);

    const snap = snapshotMetrics(ws);
    expect(snap.get(join(ws, "planning", "metrics.jsonl"))).toBe(1);
    rmSync(ws, { recursive: true });
  });

  test("picks up planning/{session}/metrics.jsonl", () => {
    const ws = makeTmpWorkspace();
    mkdirSync(join(ws, "planning", "test-readiness"), { recursive: true });
    writeFileSync(
      join(ws, "planning", "test-readiness", "metrics.jsonl"),
      `${SAMPLE_ENTRY}\n`,
    );

    const snap = snapshotMetrics(ws);
    expect(
      snap.get(join(ws, "planning", "test-readiness", "metrics.jsonl")),
    ).toBe(1);
    rmSync(ws, { recursive: true });
  });

  test("snapshots multiple files simultaneously", () => {
    const ws = makeTmpWorkspace();
    writeFileSync(join(ws, "state", "metrics.jsonl"), `${SAMPLE_ENTRY}\n`);
    writeFileSync(
      join(ws, "planning", "metrics.jsonl"),
      `${SAMPLE_ENTRY}\n${SAMPLE_ENTRY_2}\n`,
    );

    const snap = snapshotMetrics(ws);
    expect(snap.get(join(ws, "state", "metrics.jsonl"))).toBe(1);
    expect(snap.get(join(ws, "planning", "metrics.jsonl"))).toBe(2);
    rmSync(ws, { recursive: true });
  });
});

// ─── forwardNewMetrics ────────────────────────────────────────────────────────

describe("forwardNewMetrics", () => {
  let mockFetch: ReturnType<typeof mock>;
  const originalApiKey = process.env.POSTHOG_PROJECT_API_KEY;

  beforeEach(() => {
    mockFetch = mock(() =>
      Promise.resolve(new Response(null, { status: 200 })),
    );
    process.env.POSTHOG_PROJECT_API_KEY = "phc_test-key";
  });

  afterEach(() => {
    if (originalApiKey === undefined) {
      process.env.POSTHOG_PROJECT_API_KEY = undefined;
    } else {
      process.env.POSTHOG_PROJECT_API_KEY = originalApiKey;
    }
  });

  test("no-op when POSTHOG_PROJECT_API_KEY is absent", async () => {
    process.env.POSTHOG_PROJECT_API_KEY = undefined;
    const ws = makeTmpWorkspace();
    writeFileSync(join(ws, "state", "metrics.jsonl"), `${SAMPLE_ENTRY}\n`);

    const snap = new Map<string, number>();
    await forwardNewMetrics(ws, snap, mockFetch as unknown as typeof fetch);

    expect(mockFetch).not.toHaveBeenCalled();
    rmSync(ws, { recursive: true });
  });

  test("no-op when no new lines since snapshot", async () => {
    const ws = makeTmpWorkspace();
    const path = join(ws, "state", "metrics.jsonl");
    writeFileSync(path, `${SAMPLE_ENTRY}\n`);

    const snap = new Map([[path, 1]]);
    await forwardNewMetrics(ws, snap, mockFetch as unknown as typeof fetch);

    expect(mockFetch).not.toHaveBeenCalled();
    rmSync(ws, { recursive: true });
  });

  test("no-op when workspace has no metrics files at all", async () => {
    const ws = makeTmpWorkspace();
    const snap = new Map<string, number>();
    await forwardNewMetrics(ws, snap, mockFetch as unknown as typeof fetch);

    expect(mockFetch).not.toHaveBeenCalled();
    rmSync(ws, { recursive: true });
  });

  test("POSTs new entry as shipwright_task_complete event", async () => {
    const ws = makeTmpWorkspace();
    const path = join(ws, "state", "metrics.jsonl");
    writeFileSync(path, `${SAMPLE_ENTRY}\n`);

    const snap = new Map([[path, 0]]);
    await forwardNewMetrics(ws, snap, mockFetch as unknown as typeof fetch);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/batch/");
    const body = JSON.parse(init.body as string) as {
      api_key: string;
      batch: {
        event: string;
        distinct_id: string;
        properties: { task: string };
      }[];
    };
    expect(body.api_key).toBe("phc_test-key");
    expect(body.batch).toHaveLength(1);
    expect(body.batch[0].event).toBe("shipwright_task_complete");
    expect(body.batch[0].distinct_id).toBe(
      "shipwright/example-org/my-project/T-009",
    );
    expect(body.batch[0].properties.task).toBe("T-009");
    rmSync(ws, { recursive: true });
  });

  test("sets $insert_id for PostHog deduplication", async () => {
    const ws = makeTmpWorkspace();
    const path = join(ws, "state", "metrics.jsonl");
    writeFileSync(path, `${SAMPLE_ENTRY}\n`);

    const snap = new Map([[path, 0]]);
    await forwardNewMetrics(ws, snap, mockFetch as unknown as typeof fetch);

    const body = JSON.parse(
      (mockFetch.mock.calls[0] as [string, RequestInit])[1].body as string,
    ) as { batch: { properties: { $insert_id: string } }[] };
    expect(body.batch[0].properties.$insert_id).toBe(
      "shipwright_task_complete/example-org/my-project/T-009",
    );
    rmSync(ws, { recursive: true });
  });

  test("batches multiple new entries in a single POST", async () => {
    const ws = makeTmpWorkspace();
    const path = join(ws, "state", "metrics.jsonl");
    writeFileSync(path, `${SAMPLE_ENTRY}\n${SAMPLE_ENTRY_2}\n`);

    const snap = new Map([[path, 0]]);
    await forwardNewMetrics(ws, snap, mockFetch as unknown as typeof fetch);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse(
      (mockFetch.mock.calls[0] as [string, RequestInit])[1].body as string,
    ) as { batch: { properties: { task: string } }[] };
    expect(body.batch).toHaveLength(2);
    expect(body.batch.map((e) => e.properties.task)).toEqual([
      "T-009",
      "T-010",
    ]);
    rmSync(ws, { recursive: true });
  });

  test("only forwards lines added since snapshot", async () => {
    const ws = makeTmpWorkspace();
    const path = join(ws, "state", "metrics.jsonl");
    writeFileSync(path, `${SAMPLE_ENTRY}\n`);

    // snapshot sees 1 line; then a second line is added
    const snap = new Map([[path, 1]]);
    writeFileSync(path, `${SAMPLE_ENTRY}\n${SAMPLE_ENTRY_2}\n`);
    await forwardNewMetrics(ws, snap, mockFetch as unknown as typeof fetch);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse(
      (mockFetch.mock.calls[0] as [string, RequestInit])[1].body as string,
    ) as { batch: { properties: { task: string } }[] };
    expect(body.batch).toHaveLength(1);
    expect(body.batch[0].properties.task).toBe("T-010");
    rmSync(ws, { recursive: true });
  });

  test("collects new entries from multiple files in one batch", async () => {
    const ws = makeTmpWorkspace();
    const statePath = join(ws, "state", "metrics.jsonl");
    const planningPath = join(ws, "planning", "metrics.jsonl");
    writeFileSync(statePath, `${SAMPLE_ENTRY}\n`);
    writeFileSync(planningPath, `${SAMPLE_ENTRY_2}\n`);

    const snap = new Map<string, number>(); // both files unseen
    await forwardNewMetrics(ws, snap, mockFetch as unknown as typeof fetch);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse(
      (mockFetch.mock.calls[0] as [string, RequestInit])[1].body as string,
    ) as { batch: unknown[] };
    expect(body.batch).toHaveLength(2);
    rmSync(ws, { recursive: true });
  });

  test("skips malformed JSON lines without throwing", async () => {
    const ws = makeTmpWorkspace();
    const path = join(ws, "state", "metrics.jsonl");
    writeFileSync(path, `not-json\n${SAMPLE_ENTRY}\n{broken\n`);

    const snap = new Map([[path, 0]]);
    await forwardNewMetrics(ws, snap, mockFetch as unknown as typeof fetch);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse(
      (mockFetch.mock.calls[0] as [string, RequestInit])[1].body as string,
    ) as { batch: unknown[] };
    expect(body.batch).toHaveLength(1); // only the valid entry
    rmSync(ws, { recursive: true });
  });

  test("does not throw when fetch fails — silent no-op", async () => {
    const failFetch = mock(() => Promise.reject(new Error("network error")));
    const ws = makeTmpWorkspace();
    const path = join(ws, "state", "metrics.jsonl");
    writeFileSync(path, `${SAMPLE_ENTRY}\n`);

    const snap = new Map([[path, 0]]);
    await expect(
      forwardNewMetrics(ws, snap, failFetch as unknown as typeof fetch),
    ).resolves.toBeUndefined();
    rmSync(ws, { recursive: true });
  });

  test("does not throw when fetch returns non-200 — silent no-op", async () => {
    const errorFetch = mock(() =>
      Promise.resolve(new Response(null, { status: 500 })),
    );
    const ws = makeTmpWorkspace();
    const path = join(ws, "state", "metrics.jsonl");
    writeFileSync(path, `${SAMPLE_ENTRY}\n`);

    const snap = new Map([[path, 0]]);
    await expect(
      forwardNewMetrics(ws, snap, errorFetch as unknown as typeof fetch),
    ).resolves.toBeUndefined();
    rmSync(ws, { recursive: true });
  });
});

// ─── forwardTokenUsage ────────────────────────────────────────────────────────

describe("forwardTokenUsage", () => {
  let mockFetch: ReturnType<typeof mock>;
  const originalApiKey = process.env.POSTHOG_PROJECT_API_KEY;
  const originalAgentId = process.env.SHIPWRIGHT_AGENT_ID;

  const SAMPLE_USAGE: TokenUsage = {
    input_tokens: 100,
    output_tokens: 200,
    cache_read_input_tokens: 50,
    cache_creation_input_tokens: 10,
  };

  beforeEach(() => {
    mockFetch = mock(() =>
      Promise.resolve(new Response(null, { status: 200 })),
    );
    process.env.POSTHOG_PROJECT_API_KEY = "phc_test-key";
    process.env.SHIPWRIGHT_AGENT_ID = "agent-abc-123";
  });

  afterEach(() => {
    if (originalApiKey === undefined) {
      process.env.POSTHOG_PROJECT_API_KEY = undefined;
    } else {
      process.env.POSTHOG_PROJECT_API_KEY = originalApiKey;
    }
    if (originalAgentId === undefined) {
      process.env.SHIPWRIGHT_AGENT_ID = undefined;
    } else {
      process.env.SHIPWRIGHT_AGENT_ID = originalAgentId;
    }
  });

  test("sends agent_token_usage event with all fields", async () => {
    await forwardTokenUsage(
      SAMPLE_USAGE,
      "slack_dm",
      "claude-sonnet-4-6",
      mockFetch as unknown as typeof fetch,
    );

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/batch/");
    const body = JSON.parse(init.body as string) as {
      api_key: string;
      batch: {
        event: string;
        distinct_id: string;
        properties: Record<string, unknown>;
      }[];
    };
    expect(body.api_key).toBe("phc_test-key");
    expect(body.batch).toHaveLength(1);
    const evt = body.batch[0];
    expect(evt.event).toBe("agent_token_usage");
    expect(evt.properties.agent_id).toBe("agent-abc-123");
    expect(evt.properties.session_type).toBe("slack_dm");
    expect(evt.properties.input_tokens).toBe(100);
    expect(evt.properties.output_tokens).toBe(200);
    expect(evt.properties.cache_read_input_tokens).toBe(50);
    expect(evt.properties.cache_creation_input_tokens).toBe(10);
    expect(evt.properties.model).toBe("claude-sonnet-4-6");
    // (100 * 3.00 + 200 * 15.00 + 10 * 3.00 * 1.25 + 50 * 3.00 * 0.1) / 1_000_000 = 0.0033525
    expect(evt.properties.cost_usd).toBe(0.0033525);
  });

  test("no-op when POSTHOG_PROJECT_API_KEY is absent", async () => {
    process.env.POSTHOG_PROJECT_API_KEY = undefined;
    await forwardTokenUsage(
      SAMPLE_USAGE,
      "cron",
      undefined,
      mockFetch as unknown as typeof fetch,
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test("no-op when usage is undefined", async () => {
    await forwardTokenUsage(
      undefined,
      "slack_mention",
      undefined,
      mockFetch as unknown as typeof fetch,
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test("does not throw when fetch fails", async () => {
    const failFetch = mock(() => Promise.reject(new Error("network error")));
    await expect(
      forwardTokenUsage(
        SAMPLE_USAGE,
        "slack_dm",
        undefined,
        failFetch as unknown as typeof fetch,
      ),
    ).resolves.toBeUndefined();
  });
});
