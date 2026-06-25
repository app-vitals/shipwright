/**
 * Integration tests for startHealthServer() in agent/src/health.ts
 *
 * These tests spin up real Bun.serve() instances on localhost ports and make
 * live fetch() calls — they require a real network stack and belong in
 * *.integration.test.ts per docs/test-readiness/test-system.md.
 */

import { afterEach, describe, expect, it } from "bun:test";
import type { Server } from "bun";
import type { AnalyticsSummary } from "./analytics.ts";
import { FixedClock } from "./clock.ts";
import {
  SLACK_DOWN_GRACE_MS,
  markSlackConnected,
  markSlackDisconnected,
  slackState,
  startHealthServer,
} from "./health.ts";

describe("startHealthServer", () => {
  const servers: Server<undefined>[] = [];

  afterEach(() => {
    for (const s of servers) s.stop(true);
    servers.length = 0;
    slackState.connected = false;
    slackState.downSince = null;
  });

  function serve(
    port: number,
    summarize?: (date?: string) => AnalyticsSummary,
  ): Server<undefined> {
    const s = startHealthServer(port, summarize);
    servers.push(s);
    return s;
  }

  it("GET /health returns 200 with slack disconnected when not connected", async () => {
    slackState.connected = false;
    slackState.downSince = null;
    serve(19901);
    const res = await fetch("http://localhost:19901/health");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true, slack: "disconnected" });
  });

  it("GET /health returns slack connected when slackState.connected is true", async () => {
    slackState.connected = true;
    serve(19902);
    const res = await fetch("http://localhost:19902/health");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true, slack: "connected" });
  });

  it("reflects state changes at runtime without restart", async () => {
    slackState.connected = false;
    slackState.downSince = null;
    serve(19903);

    const res1 = await fetch("http://localhost:19903/health");
    expect((await res1.json()).slack).toBe("disconnected");

    slackState.connected = true;
    const res2 = await fetch("http://localhost:19903/health");
    expect((await res2.json()).slack).toBe("connected");

    slackState.connected = false;
    const res3 = await fetch("http://localhost:19903/health");
    expect((await res3.json()).slack).toBe("disconnected");
  });

  it("returns 404 for unknown paths", async () => {
    serve(19904);
    const res = await fetch("http://localhost:19904/not-a-thing");
    expect(res.status).toBe(404);
  });

  it("returns 404 for POST /health", async () => {
    serve(19905);
    const res = await fetch("http://localhost:19905/health", {
      method: "POST",
    });
    expect(res.status).toBe(404);
  });

  it("GET /stats returns analytics summary when summarize is provided", async () => {
    const mockSummary = {
      date: "2026-04-02",
      totalEvents: 5,
      messages: 3,
      mentions: 1,
      cronJobs: 1,
      errors: 0,
      sessionStarts: 0,
      sessionFallbacks: 0,
      avgResponseMs: 250,
      p95ResponseMs: 400,
      uniqueSessions: 2,
    };
    serve(19906, () => mockSummary);
    const res = await fetch("http://localhost:19906/stats");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual(mockSummary);
  });

  it("GET /stats passes date query param to summarize", async () => {
    let receivedDate: string | undefined;
    serve(19907, (date) => {
      receivedDate = date;
      return { date: date ?? "today", totalEvents: 0 } as AnalyticsSummary;
    });
    await fetch("http://localhost:19907/stats?date=2026-03-30");
    expect(receivedDate).toBe("2026-03-30");
  });

  it("GET /stats returns 404 when no summarize function provided", async () => {
    serve(19908);
    const res = await fetch("http://localhost:19908/stats");
    expect(res.status).toBe(404);
  });

  // ─── Self-heal grace-window behavior ──────────────────────────────────────

  // A1: Healthy → 200 connected
  it("GET /health returns 200 connected when socket is up", async () => {
    const clock = FixedClock(new Date("2026-06-06T00:00:00.000Z"));
    slackState.connected = true;
    slackState.downSince = null;
    const s = startHealthServer(19910, undefined, undefined, clock);
    servers.push(s);
    const res = await fetch("http://localhost:19910/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, slack: "connected" });
  });

  // A2: Disconnected but within grace window → 200 disconnected
  it("GET /health returns 200 when disconnected within grace window", async () => {
    const downAt = new Date("2026-06-06T00:00:00.000Z").getTime();
    // Server clock 30s later — well under the 90s grace window.
    const clock = FixedClock(new Date("2026-06-06T00:00:30.000Z"));
    slackState.connected = false;
    slackState.downSince = downAt;
    const s = startHealthServer(19911, undefined, undefined, clock);
    servers.push(s);
    const res = await fetch("http://localhost:19911/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, slack: "disconnected" });
  });

  // A3: Disconnected beyond grace window → 500 disconnected
  it("GET /health returns 500 when disconnected beyond grace window", async () => {
    const downAt = new Date("2026-06-06T00:00:00.000Z").getTime();
    // Server clock past the grace window.
    const clock = FixedClock(new Date(downAt + SLACK_DOWN_GRACE_MS + 1_000));
    slackState.connected = false;
    slackState.downSince = downAt;
    const s = startHealthServer(19912, undefined, undefined, clock);
    servers.push(s);
    const res = await fetch("http://localhost:19912/health");
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ ok: false, slack: "disconnected" });
  });

  // A4: Recovery — markSlackConnected clears downSince → 200 again
  it("GET /health returns 200 again after recovery from a wedge", async () => {
    const downAt = new Date("2026-06-06T00:00:00.000Z").getTime();
    const clock = FixedClock(new Date(downAt + SLACK_DOWN_GRACE_MS + 1_000));
    slackState.connected = false;
    slackState.downSince = downAt;
    const s = startHealthServer(19913, undefined, undefined, clock);
    servers.push(s);

    const wedged = await fetch("http://localhost:19913/health");
    expect(wedged.status).toBe(500);

    markSlackConnected();
    expect(slackState.connected).toBe(true);
    expect(slackState.downSince).toBeNull();

    const recovered = await fetch("http://localhost:19913/health");
    expect(recovered.status).toBe(200);
    expect(await recovered.json()).toEqual({ ok: true, slack: "connected" });
  });

  // A5: Cold start / never connected → 200 (not killed during initial connect)
  it("GET /health returns 200 at cold start before first connect", async () => {
    const clock = FixedClock(new Date("2026-06-06T05:00:00.000Z"));
    slackState.connected = false;
    slackState.downSince = null;
    const s = startHealthServer(19914, undefined, undefined, clock);
    servers.push(s);
    const res = await fetch("http://localhost:19914/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, slack: "disconnected" });
  });

  // A6: Repeated markSlackDisconnected does not push downSince forward
  it("markSlackDisconnected anchors downSince to the first drop", () => {
    slackState.connected = true;
    slackState.downSince = null;

    const first = FixedClock(new Date("2026-06-06T00:00:00.000Z"));
    markSlackDisconnected(first);
    const firstDown = slackState.downSince as unknown as number;
    expect(firstDown).toBe(new Date("2026-06-06T00:00:00.000Z").getTime());

    // A later error event must NOT reset/extend the timer.
    const later = FixedClock(new Date("2026-06-06T00:01:00.000Z"));
    markSlackDisconnected(later);
    expect(slackState.downSince as number | null).toBe(firstDown);
  });

  it("markSlackConnected then markSlackDisconnected re-anchors after reconnect", () => {
    slackState.connected = false;
    slackState.downSince = null;

    const first = FixedClock(new Date("2026-06-06T00:00:00.000Z"));
    markSlackDisconnected(first);
    expect(slackState.downSince as number | null).toBe(first.now().getTime());

    markSlackConnected();
    expect(slackState.downSince).toBeNull();

    const second = FixedClock(new Date("2026-06-06T01:00:00.000Z"));
    markSlackDisconnected(second);
    expect(slackState.downSince as number | null).toBe(second.now().getTime());
  });
});
