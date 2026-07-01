/**
 * Integration tests for HttpChatTokenReporter.
 *
 * Strategy: spin up a real Bun.serve stub admin API, inject its URL, and verify
 * the reporter POSTs the correct daily-usage payload — no global.fetch overrides,
 * no mock.module(). Time is injected via a FixedClock so the date is deterministic.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  HttpChatTokenReporter,
  NoopChatTokenReporter,
  formatDailyDate,
} from "./chat-token-reporter.ts";
import type { TokenUsage } from "./claude.ts";
import { FixedClock } from "./clock.ts";

// ─── Shared helpers ───────────────────────────────────────────────────────────

interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

interface StubState {
  captured: CapturedRequest[];
  statusToReturn: number;
}

function startStubServer(
  port: number,
  state: StubState,
  // biome-ignore lint/suspicious/noExplicitAny: Server type param varies by bun version
): ReturnType<typeof Bun.serve<any>> {
  return Bun.serve({
    port,
    fetch: async (req) => {
      const body = await req.json().catch(() => null);
      state.captured.push({
        url: req.url,
        method: req.method,
        headers: Object.fromEntries(req.headers.entries()),
        body,
      });

      if (state.statusToReturn >= 400) {
        return new Response(JSON.stringify({ error: "stub error" }), {
          status: state.statusToReturn,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(
        JSON.stringify({ row: { id: "chat-token-daily-stub-1" } }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    },
  });
}

const USAGE: TokenUsage = {
  input_tokens: 100,
  output_tokens: 50,
  cache_read_input_tokens: 20,
  cache_creation_input_tokens: 10,
};

// ─── formatDailyDate ──────────────────────────────────────────────────────────

describe("formatDailyDate", () => {
  test("formats a Date as YYYY-MM-DD in the given timezone", () => {
    const date = new Date("2026-01-15T12:00:00.000Z");
    expect(formatDailyDate(date, "UTC")).toBe("2026-01-15");
  });

  test("respects the timezone when crossing a day boundary", () => {
    // 00:30 UTC on the 15th is still the 14th in US Pacific.
    const date = new Date("2026-01-15T00:30:00.000Z");
    expect(formatDailyDate(date, "America/Los_Angeles")).toBe("2026-01-14");
  });
});

// ─── HttpChatTokenReporter ────────────────────────────────────────────────────

describe("HttpChatTokenReporter", () => {
  // biome-ignore lint/suspicious/noExplicitAny: Server type param varies by bun version
  let server: ReturnType<typeof Bun.serve<any>>;
  let state: StubState;
  const PORT = 19961;
  const BASE_URL = `http://localhost:${PORT}`;
  const AGENT_ID = "agent-abc";
  const API_KEY = "test-api-key";
  const CLOCK = FixedClock(new Date("2026-01-15T12:00:00.000Z"));

  beforeEach(() => {
    state = { captured: [], statusToReturn: 200 };
    server = startStubServer(PORT, state);
  });

  afterEach(() => {
    server.stop(true);
  });

  function makeReporter() {
    return new HttpChatTokenReporter({
      apiUrl: BASE_URL,
      agentId: AGENT_ID,
      apiKey: API_KEY,
      clock: CLOCK,
      timeZone: "UTC",
    });
  }

  test("recordSession POSTs to /agents/:agentId/chat-tokens/daily", async () => {
    const reporter = makeReporter();
    await reporter.recordSession(USAGE);

    expect(state.captured).toHaveLength(1);
    expect(state.captured[0].method).toBe("POST");
    expect(state.captured[0].url).toContain(
      `/agents/${AGENT_ID}/chat-tokens/daily`,
    );
  });

  test("recordSession sends the correct date and token fields", async () => {
    const reporter = makeReporter();
    await reporter.recordSession(USAGE);

    const body = state.captured[0].body as Record<string, unknown>;
    expect(body.date).toBe("2026-01-15");
    expect(body.inputTokens).toBe(100);
    expect(body.outputTokens).toBe(50);
    expect(body.cacheReadTokens).toBe(20);
    expect(body.cacheCreationTokens).toBe(10);
  });

  test("recordSession does NOT send a model field", async () => {
    const reporter = makeReporter();
    await reporter.recordSession(USAGE);

    const body = state.captured[0].body as Record<string, unknown>;
    expect(body.model).toBeUndefined();
  });

  test("recordSession sends costUsd from totalCostUsd when provided", async () => {
    const reporter = makeReporter();
    await reporter.recordSession(USAGE, 0.0099);

    const body = state.captured[0].body as Record<string, unknown>;
    expect(body.costUsd).toBe(0.0099);
  });

  test("recordSession falls back to calculateCost when totalCostUsd not provided", async () => {
    const reporter = makeReporter();
    await reporter.recordSession(USAGE);

    const body = state.captured[0].body as Record<string, unknown>;
    // Falls back to calculateCost(usage, liveClaudeConfig.model) — non-zero computed cost
    expect(typeof body.costUsd).toBe("number");
    expect(body.costUsd as number).toBeGreaterThan(0);
  });

  test("recordSession sends Authorization: Bearer header", async () => {
    const reporter = makeReporter();
    await reporter.recordSession(USAGE);

    expect(state.captured[0].headers.authorization).toBe(`Bearer ${API_KEY}`);
  });

  test("recordSession(undefined) makes NO request (no-op)", async () => {
    const reporter = makeReporter();
    await reporter.recordSession(undefined);

    expect(state.captured).toHaveLength(0);
  });

  test("recordSession swallows network errors (does not throw)", async () => {
    const reporter = new HttpChatTokenReporter({
      apiUrl: "http://localhost:19999", // nothing listening
      agentId: AGENT_ID,
      apiKey: API_KEY,
      clock: CLOCK,
      timeZone: "UTC",
    });

    await expect(reporter.recordSession(USAGE)).resolves.toBeUndefined();
  });

  test("recordSession swallows HTTP error responses (does not throw)", async () => {
    state.statusToReturn = 500;
    const reporter = makeReporter();

    await expect(reporter.recordSession(USAGE)).resolves.toBeUndefined();
  });

  test("recordSession swallows HTTP 4xx responses (does not throw)", async () => {
    state.statusToReturn = 400;
    const reporter = makeReporter();

    await expect(reporter.recordSession(USAGE)).resolves.toBeUndefined();
  });
});

// ─── NoopChatTokenReporter ────────────────────────────────────────────────────

describe("NoopChatTokenReporter", () => {
  test("recordSession resolves immediately and does not throw", async () => {
    const reporter = new NoopChatTokenReporter();
    await expect(reporter.recordSession(USAGE)).resolves.toBeUndefined();
  });

  test("recordSession(undefined) resolves and does not throw", async () => {
    const reporter = new NoopChatTokenReporter();
    await expect(reporter.recordSession(undefined)).resolves.toBeUndefined();
  });
});
