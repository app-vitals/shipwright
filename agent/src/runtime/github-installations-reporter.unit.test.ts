/**
 * Unit tests for HttpGitHubInstallationsReporter: change detection, heartbeat
 * (injected Clock), payload hygiene, and never-throws behavior.
 */

import { describe, expect, test } from "bun:test";
import type { InstallationsSnapshot } from "./github-installations.ts";
import {
  HttpGitHubInstallationsReporter,
  INSTALLATIONS_HEARTBEAT_MS,
  NoopGitHubInstallationsReporter,
  startInstallationsHeartbeat,
} from "./github-installations-reporter.ts";

function snap(
  health: "ok" | "broken" | "unknown" = "ok",
  extra: InstallationsSnapshot["installations"] = [],
): InstallationsSnapshot {
  return {
    defaultId: 1,
    installations: [
      {
        id: 1,
        owner: "acme",
        pinned: false,
        health,
        reason: health === "broken" ? "mint_rejected" : null,
      },
      ...extra,
    ],
  };
}

function harness(responses: (Response | Error)[] = []) {
  let nowMs = Date.UTC(2026, 0, 1);
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  let i = 0;
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    const r = responses[i++] ?? new Response("{}", { status: 200 });
    if (r instanceof Error) throw r;
    return r;
  }) as unknown as typeof fetch;
  const reporter = new HttpGitHubInstallationsReporter({
    apiUrl: "http://api",
    agentId: "a1",
    apiKey: "KEY",
    fetchFn,
    clock: { now: () => new Date(nowMs) },
  });
  return {
    reporter,
    calls,
    advance: (ms: number) => {
      nowMs += ms;
    },
  };
}

describe("HttpGitHubInstallationsReporter", () => {
  test("first report PUTs a full snapshot", async () => {
    const h = harness();
    await h.reporter.report(snap());
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0].url).toBe("http://api/agents/a1/github-installations");
    expect(h.calls[0].init?.method).toBe("PUT");
    const body = JSON.parse(String(h.calls[0].init?.body));
    expect(body.installations).toEqual([
      { owner: "acme", installationId: 1, state: "ok", lastError: null },
    ]);
  });

  test("unchanged state inside heartbeat window posts nothing", async () => {
    const h = harness();
    await h.reporter.report(snap());
    h.advance(60_000);
    await h.reporter.report(snap());
    expect(h.calls).toHaveLength(1);
  });

  test("ok -> broken -> ok each post", async () => {
    const h = harness();
    await h.reporter.report(snap("ok"));
    await h.reporter.report(snap("broken"));
    await h.reporter.report(snap("ok"));
    expect(h.calls).toHaveLength(3);
    const broken = JSON.parse(String(h.calls[1].init?.body));
    expect(broken.installations[0].state).toBe("broken");
    expect(broken.installations[0].lastError).toBe(
      "installation token mint rejected",
    );
  });

  test("discovered and removed installations post", async () => {
    const h = harness();
    await h.reporter.report(snap());
    const added = snap("ok", [
      { id: 2, owner: null, pinned: true, health: "unknown", reason: null },
    ]);
    await h.reporter.report(added);
    await h.reporter.report(snap());
    expect(h.calls).toHaveLength(3);
    expect(
      JSON.parse(String(h.calls[1].init?.body)).installations[1].owner,
    ).toBe("unknown");
  });

  test("heartbeat re-posts unchanged state after 30 minutes", async () => {
    const h = harness();
    await h.reporter.report(snap());
    h.advance(INSTALLATIONS_HEARTBEAT_MS - 1);
    await h.reporter.report(snap());
    expect(h.calls).toHaveLength(1);
    h.advance(1);
    await h.reporter.report(snap());
    expect(h.calls).toHaveLength(2);
  });

  test("non-2xx and thrown fetch never throw, and retry next report", async () => {
    const h = harness([
      new Response("secret body", { status: 500 }),
      new Error("boom"),
    ]);
    await h.reporter.report(snap());
    await h.reporter.report(snap());
    await h.reporter.report(snap());
    expect(h.calls).toHaveLength(3);
  });

  test("payload carries no token, key, or response material", async () => {
    const h = harness();
    await h.reporter.report(snap("broken"));
    const raw = String(h.calls[0].init?.body);
    expect(Object.keys(JSON.parse(raw)).sort()).toEqual([
      "installations",
      "reportedAt",
    ]);
    expect(raw).not.toMatch(/ghs_|BEGIN|"token"|"key"/);
  });
});

describe("startInstallationsHeartbeat", () => {
  test("ticks report the current state; stop clears the timer", async () => {
    const reports: InstallationsSnapshot[] = [];
    let tick: () => void = () => {};
    const stop = startInstallationsHeartbeat(
      { report: async (s) => void reports.push(s) },
      () => snap(),
      {
        setIntervalFn: ((fn: () => void) => {
          tick = fn;
          return 0;
        }) as unknown as typeof setInterval,
      },
    );
    tick();
    expect(reports).toHaveLength(1);
    stop();
  });
});

describe("NoopGitHubInstallationsReporter", () => {
  test("resolves without effect", async () => {
    await new NoopGitHubInstallationsReporter().report(snap());
  });
});
