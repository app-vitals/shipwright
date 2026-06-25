/**
 * Integration tests for HttpCronRunReporter.
 *
 * Strategy: spin up a real Bun.serve stub admin API, inject its URL, and verify
 * the reporter POSTs the correct payload — no global.fetch overrides, no mock.module().
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  HttpCronRunReporter,
  NoopCronRunReporter,
} from "./cron-run-reporter.ts";

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
      return new Response(JSON.stringify({ run: { id: "run-1" } }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      });
    },
  });
}

// ─── HttpCronRunReporter ──────────────────────────────────────────────────────

describe("HttpCronRunReporter", () => {
  // biome-ignore lint/suspicious/noExplicitAny: Server type param varies by bun version
  let server: ReturnType<typeof Bun.serve<any>>;
  let state: StubState;
  const PORT = 19950;
  const BASE_URL = `http://localhost:${PORT}`;
  const AGENT_ID = "agent-abc";
  const API_KEY = "test-api-key";

  beforeEach(() => {
    state = { captured: [], statusToReturn: 201 };
    server = startStubServer(PORT, state);
  });

  afterEach(() => {
    server.stop(true);
  });

  test("POSTs to correct URL: /agents/:agentId/crons/:cronId/runs", async () => {
    const reporter = new HttpCronRunReporter({
      apiUrl: BASE_URL,
      agentId: AGENT_ID,
      apiKey: API_KEY,
    });

    const startedAt = new Date("2026-01-01T08:00:00.000Z");
    const completedAt = new Date("2026-01-01T08:00:05.000Z");

    await reporter.report({
      cronId: "cron-123",
      startedAt,
      completedAt,
      skipped: false,
      outcome: "posted",
    });

    expect(state.captured).toHaveLength(1);
    expect(state.captured[0].method).toBe("POST");
    expect(state.captured[0].url).toContain(
      `/agents/${AGENT_ID}/crons/cron-123/runs`,
    );
  });

  test("sends correct payload with all fields", async () => {
    const reporter = new HttpCronRunReporter({
      apiUrl: BASE_URL,
      agentId: AGENT_ID,
      apiKey: API_KEY,
    });

    const startedAt = new Date("2026-01-01T08:00:00.000Z");
    const completedAt = new Date("2026-01-01T08:00:05.000Z");

    await reporter.report({
      cronId: "cron-456",
      startedAt,
      completedAt,
      skipped: true,
      skipReason: "preCheck:not-found",
      error: "script not found",
    });

    const body = state.captured[0].body as Record<string, unknown>;
    expect(body.startedAt).toBe(startedAt.toISOString());
    expect(body.completedAt).toBe(completedAt.toISOString());
    expect(body.skipped).toBe(true);
    expect(body.skipReason).toBe("preCheck:not-found");
    expect(body.error).toBe("script not found");
  });

  test("sends Authorization header with api key", async () => {
    const reporter = new HttpCronRunReporter({
      apiUrl: BASE_URL,
      agentId: AGENT_ID,
      apiKey: API_KEY,
    });

    await reporter.report({
      cronId: "cron-789",
      startedAt: new Date(),
      completedAt: new Date(),
      skipped: false,
      outcome: "posted",
    });

    expect(state.captured[0].headers.authorization).toBe(`Bearer ${API_KEY}`);
  });

  test("swallows network errors (does not throw)", async () => {
    const reporter = new HttpCronRunReporter({
      apiUrl: "http://localhost:19999", // nothing listening
      agentId: AGENT_ID,
      apiKey: API_KEY,
    });

    await expect(
      reporter.report({
        cronId: "cron-net-err",
        startedAt: new Date(),
        completedAt: new Date(),
        skipped: false,
        outcome: "posted",
      }),
    ).resolves.toBeUndefined();
  });

  test("swallows HTTP error responses (does not throw)", async () => {
    state.statusToReturn = 500;

    const reporter = new HttpCronRunReporter({
      apiUrl: BASE_URL,
      agentId: AGENT_ID,
      apiKey: API_KEY,
    });

    await expect(
      reporter.report({
        cronId: "cron-http-err",
        startedAt: new Date(),
        completedAt: new Date(),
        skipped: false,
        outcome: "posted",
      }),
    ).resolves.toBeUndefined();
  });

  test("swallows 404 HTTP error (does not throw)", async () => {
    state.statusToReturn = 404;

    const reporter = new HttpCronRunReporter({
      apiUrl: BASE_URL,
      agentId: AGENT_ID,
      apiKey: API_KEY,
    });

    await expect(
      reporter.report({
        cronId: "cron-404",
        startedAt: new Date(),
        completedAt: new Date(),
        skipped: false,
        outcome: "posted",
      }),
    ).resolves.toBeUndefined();
  });

  test("sends outcome field when provided", async () => {
    const reporter = new HttpCronRunReporter({
      apiUrl: BASE_URL,
      agentId: AGENT_ID,
      apiKey: API_KEY,
    });

    await reporter.report({
      cronId: "cron-dm",
      startedAt: new Date(),
      completedAt: new Date(),
      skipped: false,
      outcome: "dm",
    });

    const body = state.captured[0].body as Record<string, unknown>;
    expect(body.outcome).toBe("dm");
    expect(body.skipped).toBe(false);
  });
});

// ─── NoopCronRunReporter ──────────────────────────────────────────────────────

describe("NoopCronRunReporter", () => {
  test("does not throw and resolves immediately", async () => {
    const reporter = new NoopCronRunReporter();

    await expect(
      reporter.report({
        cronId: "any",
        startedAt: new Date(),
        completedAt: new Date(),
        skipped: false,
        outcome: "posted",
      }),
    ).resolves.toBeUndefined();
  });
});
