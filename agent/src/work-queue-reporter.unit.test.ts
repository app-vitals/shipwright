/**
 * Unit tests for HttpWorkQueueReporter / NoopWorkQueueReporter.
 *
 * Strategy: inject a stub `fetchFn` (matching the global `fetch` signature) —
 * no real Bun.serve, no global.fetch override — per the repo's test-isolation
 * contract. Mirrors cron-run-reporter's swallow-and-warn behaviors, but at the
 * unit level since fetch is injectable here.
 */

import { describe, expect, test } from "bun:test";
import type { RankedWorkItem } from "./work-selector.ts";
import {
  HttpWorkQueueReporter,
  MAX_WORK_QUEUE_ITEMS,
  NoopWorkQueueReporter,
} from "./work-queue-reporter.ts";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function rankedItem(id: string, age: string): RankedWorkItem {
  return { type: "task", id, phase: "dev-task", age };
}

interface CapturedCall {
  url: string;
  init: RequestInit | undefined;
}

/** Records each call and returns a scripted Response (or throws). */
function makeFetchStub(responses: (Response | Error)[] = []): {
  fetchFn: typeof fetch;
  calls: CapturedCall[];
} {
  const calls: CapturedCall[] = [];
  let idx = 0;
  const fetchFn = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    calls.push({ url: String(input), init });
    const scripted = responses[idx];
    idx += 1;
    if (scripted instanceof Error) throw scripted;
    if (scripted) return scripted;
    return new Response(null, { status: 200 });
  }) as typeof fetch;
  return { fetchFn, calls };
}

const AGENT_ID = "agent-abc";
const API_KEY = "test-api-key";
const API_URL = "http://localhost:19960";

// ─── HttpWorkQueueReporter ────────────────────────────────────────────────────

describe("HttpWorkQueueReporter", () => {
  test("POSTs to /agents/:agentId/work-queue with computedAt + items, and Authorization header", async () => {
    const { fetchFn, calls } = makeFetchStub([
      new Response(null, { status: 200 }),
    ]);
    const reporter = new HttpWorkQueueReporter({
      apiUrl: API_URL,
      agentId: AGENT_ID,
      apiKey: API_KEY,
      fetchFn,
    });

    const computedAt = "2026-07-17T00:00:00.000Z";
    const items = [rankedItem("T-1", "2026-01-01T00:00:00Z")];

    await reporter.reportSnapshot({ computedAt, items });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${API_URL}/agents/${AGENT_ID}/work-queue`);
    expect(calls[0].init?.method).toBe("POST");

    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${API_KEY}`);
    expect(headers["Content-Type"]).toBe("application/json");

    const body = JSON.parse(calls[0].init?.body as string);
    expect(body.computedAt).toBe(computedAt);
    expect(body.items).toEqual(items);
  });

  test("swallows a non-2xx response (does not throw) and logs a console.warn", async () => {
    const { fetchFn } = makeFetchStub([new Response(null, { status: 500 })]);
    const reporter = new HttpWorkQueueReporter({
      apiUrl: API_URL,
      agentId: AGENT_ID,
      apiKey: API_KEY,
      fetchFn,
    });

    const originalWarn = console.warn.bind(console);
    const warnMessages: string[] = [];
    console.warn = (...args: unknown[]) => {
      warnMessages.push(args.map(String).join(" "));
    };
    try {
      await expect(
        reporter.reportSnapshot({
          computedAt: "2026-07-17T00:00:00.000Z",
          items: [],
        }),
      ).resolves.toBeUndefined();
    } finally {
      console.warn = originalWarn;
    }

    expect(warnMessages.some((m) => m.includes("500"))).toBe(true);
  });

  test("swallows a thrown fetch error (does not throw) and logs a console.warn", async () => {
    const { fetchFn } = makeFetchStub([new Error("network unreachable")]);
    const reporter = new HttpWorkQueueReporter({
      apiUrl: API_URL,
      agentId: AGENT_ID,
      apiKey: API_KEY,
      fetchFn,
    });

    const originalWarn = console.warn.bind(console);
    const warnMessages: string[] = [];
    console.warn = (...args: unknown[]) => {
      warnMessages.push(args.map(String).join(" "));
    };
    try {
      await expect(
        reporter.reportSnapshot({
          computedAt: "2026-07-17T00:00:00.000Z",
          items: [],
        }),
      ).resolves.toBeUndefined();
    } finally {
      console.warn = originalWarn;
    }

    expect(warnMessages.some((m) => m.includes("network unreachable"))).toBe(
      true,
    );
  });

  test("caps items at MAX_WORK_QUEUE_ITEMS (50), retaining the oldest 50 (drops the tail)", async () => {
    const { fetchFn, calls } = makeFetchStub([
      new Response(null, { status: 200 }),
    ]);
    const reporter = new HttpWorkQueueReporter({
      apiUrl: API_URL,
      agentId: AGENT_ID,
      apiKey: API_KEY,
      fetchFn,
    });

    // 60 items, already oldest-first ascending (as rankWorkItems guarantees).
    const items: RankedWorkItem[] = Array.from({ length: 60 }, (_, i) =>
      rankedItem(`T-${i}`, new Date(2026, 0, 1 + i).toISOString()),
    );

    await reporter.reportSnapshot({
      computedAt: "2026-07-17T00:00:00.000Z",
      items,
    });

    const body = JSON.parse(calls[0].init?.body as string);
    expect(MAX_WORK_QUEUE_ITEMS).toBe(50);
    expect(body.items).toHaveLength(50);
    expect(body.items).toEqual(items.slice(0, 50));
    // The retained items are exactly the oldest 50 (first 50 of the ascending list).
    expect(body.items[0].id).toBe("T-0");
    expect(body.items[49].id).toBe("T-49");
    expect(body.items.some((it: RankedWorkItem) => it.id === "T-50")).toBe(
      false,
    );
  });

  test("does not truncate when items.length <= 50", async () => {
    const { fetchFn, calls } = makeFetchStub([
      new Response(null, { status: 200 }),
    ]);
    const reporter = new HttpWorkQueueReporter({
      apiUrl: API_URL,
      agentId: AGENT_ID,
      apiKey: API_KEY,
      fetchFn,
    });

    const items = [rankedItem("T-1", "2026-01-01T00:00:00Z")];
    await reporter.reportSnapshot({
      computedAt: "2026-07-17T00:00:00.000Z",
      items,
    });

    const body = JSON.parse(calls[0].init?.body as string);
    expect(body.items).toEqual(items);
  });
});

// ─── NoopWorkQueueReporter ────────────────────────────────────────────────────

describe("NoopWorkQueueReporter", () => {
  test("reportSnapshot resolves immediately and does not throw", async () => {
    const reporter = new NoopWorkQueueReporter();
    await expect(
      reporter.reportSnapshot({
        computedAt: "2026-07-17T00:00:00.000Z",
        items: [],
      }),
    ).resolves.toBeUndefined();
  });
});
