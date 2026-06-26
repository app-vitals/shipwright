/**
 * Integration tests for HttpCronRunReporter (new two-step interface).
 *
 * Strategy: spin up a real Bun.serve stub admin API, inject its URL, and verify
 * the reporter POSTs / PATCHes the correct payloads — no global.fetch overrides,
 * no mock.module().
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
  postStatusToReturn: number;
  patchStatusToReturn: number;
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

      if (req.method === "POST") {
        if (state.postStatusToReturn >= 400) {
          return new Response(JSON.stringify({ error: "stub error" }), {
            status: state.postStatusToReturn,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response(JSON.stringify({ run: { id: "run-stub-1" } }), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        });
      }

      // PATCH
      if (state.patchStatusToReturn >= 400) {
        return new Response(JSON.stringify({ error: "stub error" }), {
          status: state.patchStatusToReturn,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ run: { id: "run-stub-1" } }), {
        status: 200,
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
  const PORT = 19960;
  const BASE_URL = `http://localhost:${PORT}`;
  const AGENT_ID = "agent-abc";
  const API_KEY = "test-api-key";

  beforeEach(() => {
    state = {
      captured: [],
      postStatusToReturn: 201,
      patchStatusToReturn: 200,
    };
    server = startStubServer(PORT, state);
  });

  afterEach(() => {
    server.stop(true);
  });

  function makeReporter() {
    return new HttpCronRunReporter({
      apiUrl: BASE_URL,
      agentId: AGENT_ID,
      apiKey: API_KEY,
    });
  }

  // ─── createRun ─────────────────────────────────────────────────────────────

  test("createRun POSTs to correct URL: /agents/:agentId/crons/:cronId/runs", async () => {
    const reporter = makeReporter();
    const startedAt = new Date("2026-01-01T08:00:00.000Z");

    await reporter.createRun("cron-123", startedAt);

    expect(state.captured).toHaveLength(1);
    expect(state.captured[0].method).toBe("POST");
    expect(state.captured[0].url).toContain(
      `/agents/${AGENT_ID}/crons/cron-123/runs`,
    );
  });

  test("createRun sends only startedAt in body", async () => {
    const reporter = makeReporter();
    const startedAt = new Date("2026-01-01T08:00:00.000Z");

    await reporter.createRun("cron-123", startedAt);

    const body = state.captured[0].body as Record<string, unknown>;
    expect(body.startedAt).toBe(startedAt.toISOString());
    expect(Object.keys(body)).toEqual(["startedAt"]);
  });

  test("createRun returns run.id from response", async () => {
    const reporter = makeReporter();
    const runId = await reporter.createRun(
      "cron-123",
      new Date("2026-01-01T08:00:00.000Z"),
    );

    expect(runId).toBe("run-stub-1");
  });

  test("createRun sends Authorization header with api key", async () => {
    const reporter = makeReporter();
    await reporter.createRun("cron-auth", new Date());

    expect(state.captured[0].headers.authorization).toBe(`Bearer ${API_KEY}`);
  });

  test("createRun returns null on network error (does not throw)", async () => {
    const reporter = new HttpCronRunReporter({
      apiUrl: "http://localhost:19999", // nothing listening
      agentId: AGENT_ID,
      apiKey: API_KEY,
    });

    const result = await reporter.createRun("cron-net-err", new Date());
    expect(result).toBeNull();
  });

  test("createRun returns null on HTTP error (does not throw)", async () => {
    state.postStatusToReturn = 500;
    const reporter = makeReporter();

    const result = await reporter.createRun("cron-http-err", new Date());
    expect(result).toBeNull();
  });

  // ─── completeRun ───────────────────────────────────────────────────────────

  test("completeRun PATCHes to correct URL: /agents/:agentId/crons/:cronId/runs/:runId", async () => {
    const reporter = makeReporter();
    const completedAt = new Date("2026-01-01T08:00:05.000Z");

    await reporter.completeRun("cron-123", "run-abc", completedAt, "completed");

    expect(state.captured).toHaveLength(1);
    expect(state.captured[0].method).toBe("PATCH");
    expect(state.captured[0].url).toContain(
      `/agents/${AGENT_ID}/crons/cron-123/runs/run-abc`,
    );
  });

  test("completeRun sends completedAt + outcome in body", async () => {
    const reporter = makeReporter();
    const completedAt = new Date("2026-01-01T08:00:05.000Z");

    await reporter.completeRun("cron-123", "run-abc", completedAt, "completed");

    const body = state.captured[0].body as Record<string, unknown>;
    expect(body.completedAt).toBe(completedAt.toISOString());
    expect(body.outcome).toBe("completed");
  });

  test("completeRun sends token data when provided", async () => {
    const reporter = makeReporter();
    const completedAt = new Date("2026-01-01T08:00:05.000Z");

    await reporter.completeRun("cron-123", "run-abc", completedAt, "completed", {
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 20,
      cacheCreationTokens: 10,
      costUsd: 0.00123,
      model: "claude-sonnet-4-6",
    });

    const body = state.captured[0].body as Record<string, unknown>;
    expect(body.inputTokens).toBe(100);
    expect(body.outputTokens).toBe(50);
    expect(body.cacheReadTokens).toBe(20);
    expect(body.cacheCreationTokens).toBe(10);
    expect(body.costUsd).toBe(0.00123);
    expect(body.model).toBe("claude-sonnet-4-6");
  });

  test("completeRun sends error when provided (failed outcome)", async () => {
    const reporter = makeReporter();
    const completedAt = new Date("2026-01-01T08:00:05.000Z");

    await reporter.completeRun("cron-123", "run-abc", completedAt, "failed", {
      error: "something went wrong",
    });

    const body = state.captured[0].body as Record<string, unknown>;
    expect(body.outcome).toBe("failed");
    expect(body.error).toBe("something went wrong");
  });

  test("completeRun does nothing when runId is null", async () => {
    const reporter = makeReporter();
    await reporter.completeRun(
      "cron-123",
      null,
      new Date(),
      "completed",
    );

    expect(state.captured).toHaveLength(0);
  });

  test("completeRun swallows network errors (does not throw)", async () => {
    const reporter = new HttpCronRunReporter({
      apiUrl: "http://localhost:19999", // nothing listening
      agentId: AGENT_ID,
      apiKey: API_KEY,
    });

    await expect(
      reporter.completeRun("cron-net-err", "run-1", new Date(), "completed"),
    ).resolves.toBeUndefined();
  });

  test("completeRun swallows HTTP error responses (does not throw)", async () => {
    state.patchStatusToReturn = 500;
    const reporter = makeReporter();

    await expect(
      reporter.completeRun("cron-http-err", "run-1", new Date(), "completed"),
    ).resolves.toBeUndefined();
  });

  // ─── skipRun ───────────────────────────────────────────────────────────────

  test("skipRun PATCHes to correct URL with skipped:true and skipReason", async () => {
    const reporter = makeReporter();
    const completedAt = new Date("2026-01-01T08:00:05.000Z");

    await reporter.skipRun(
      "cron-123",
      "run-abc",
      completedAt,
      "preCheck:not-found",
    );

    expect(state.captured).toHaveLength(1);
    expect(state.captured[0].method).toBe("PATCH");
    expect(state.captured[0].url).toContain(
      `/agents/${AGENT_ID}/crons/cron-123/runs/run-abc`,
    );

    const body = state.captured[0].body as Record<string, unknown>;
    expect(body.skipped).toBe(true);
    expect(body.skipReason).toBe("preCheck:not-found");
    expect(body.completedAt).toBe(completedAt.toISOString());
  });

  test("skipRun sends error when provided", async () => {
    const reporter = makeReporter();

    await reporter.skipRun(
      "cron-123",
      "run-abc",
      new Date(),
      "preCheck:crash",
      { error: "stderr output" },
    );

    const body = state.captured[0].body as Record<string, unknown>;
    expect(body.error).toBe("stderr output");
  });

  test("skipRun does nothing when runId is null", async () => {
    const reporter = makeReporter();
    await reporter.skipRun("cron-123", null, new Date(), "preCheck:not-found");

    expect(state.captured).toHaveLength(0);
  });

  test("skipRun swallows network errors (does not throw)", async () => {
    const reporter = new HttpCronRunReporter({
      apiUrl: "http://localhost:19999",
      agentId: AGENT_ID,
      apiKey: API_KEY,
    });

    await expect(
      reporter.skipRun("cron-net-err", "run-1", new Date(), "preCheck:crash"),
    ).resolves.toBeUndefined();
  });

  test("skipRun swallows HTTP error responses (does not throw)", async () => {
    state.patchStatusToReturn = 500;
    const reporter = makeReporter();

    await expect(
      reporter.skipRun("cron-http-err", "run-1", new Date(), "preCheck:crash"),
    ).resolves.toBeUndefined();
  });
});

// ─── NoopCronRunReporter ──────────────────────────────────────────────────────

describe("NoopCronRunReporter", () => {
  test("createRun returns null and does not throw", async () => {
    const reporter = new NoopCronRunReporter();
    const result = await reporter.createRun("any", new Date());
    expect(result).toBeNull();
  });

  test("completeRun resolves immediately and does not throw", async () => {
    const reporter = new NoopCronRunReporter();
    await expect(
      reporter.completeRun("any", null, new Date(), "completed"),
    ).resolves.toBeUndefined();
  });

  test("skipRun resolves immediately and does not throw", async () => {
    const reporter = new NoopCronRunReporter();
    await expect(
      reporter.skipRun("any", null, new Date(), "preCheck:not-found"),
    ).resolves.toBeUndefined();
  });
});
