/**
 * admin/src/coding/task-store-fetchers.system-crons.unit.test.ts
 *
 * SCR-1.1 / SCR-1.9 — system-cron fetchers (list, triggers, patch, enable /
 * disable) via an injected fetch double.
 */

import { describe, expect, it } from "bun:test";
import { createTaskStoreFetchers } from "./task-store-fetchers.ts";

function make(status = 200, body: unknown = { ok: true }) {
  const calls: {
    url: URL;
    method: string;
    auth: string | null;
    body?: string;
  }[] = [];
  const fetchers = createTaskStoreFetchers({
    url: "http://ts.test",
    adminToken: "tok",
    fetch: async (input, init) => {
      calls.push({
        url: new URL(input),
        method: init?.method ?? "GET",
        auth: new Headers(init?.headers).get("Authorization"),
        ...(typeof init?.body === "string" ? { body: init.body } : {}),
      });
      return new Response(JSON.stringify(body), { status });
    },
  });
  return { fetchers, calls };
}

describe("system-cron fetchers", () => {
  it("fetchSystemCrons GETs /system-crons with the admin token", async () => {
    const { fetchers, calls } = make(200, { systemCrons: [] });
    expect(
      await fetchers.fetchSystemCrons<{ systemCrons: unknown[] }>(),
    ).toEqual({ systemCrons: [] });
    expect(calls[0]?.url.pathname).toBe("/system-crons");
    expect(calls[0]?.auth).toBe("Bearer tok");
  });

  it("fetchSystemCronTriggers encodes the id and sends limit", async () => {
    const { fetchers, calls } = make(200, { triggers: [] });
    await fetchers.fetchSystemCronTriggers<unknown>("a/b", 5);
    expect(calls[0]?.url.pathname).toBe("/system-crons/a%2Fb/triggers");
    expect(calls[0]?.url.searchParams.get("limit")).toBe("5");
  });

  it("fetchCronRuns GETs /cron-runs with cronId, repo and limit, no includeDetail", async () => {
    const { fetchers, calls } = make(200, { runs: [] });
    await fetchers.fetchCronRuns<unknown>("dep-audit", "acme/api", 1);
    expect(calls[0]?.url.pathname).toBe("/cron-runs");
    expect(calls[0]?.url.searchParams.get("cronId")).toBe("dep-audit");
    expect(calls[0]?.url.searchParams.get("repo")).toBe("acme/api");
    expect(calls[0]?.url.searchParams.get("limit")).toBe("1");
    expect(calls[0]?.url.searchParams.has("includeDetail")).toBe(false);
  });

  it("patchSystemCron PATCHes JSON and returns the body", async () => {
    const { fetchers, calls } = make();
    expect(await fetchers.patchSystemCron("c1", { enabled: false })).toEqual({
      ok: true,
    });
    expect(calls[0]?.method).toBe("PATCH");
    expect(calls[0]?.body).toBe(JSON.stringify({ enabled: false }));
  });

  it("patchSystemCron resolves null on 404 and throws on other errors", async () => {
    expect(await make(404).fetchers.patchSystemCron("c1", {})).toBeNull();
    await expect(make(500).fetchers.patchSystemCron("c1", {})).rejects.toThrow(
      /PATCH \/system-crons\/c1 → 500/,
    );
  });

  it("setSystemCronEnabled POSTs enable/disable", async () => {
    const on = make();
    await on.fetchers.setSystemCronEnabled("c1", true);
    expect(on.calls[0]?.method).toBe("POST");
    expect(on.calls[0]?.url.pathname).toBe("/system-crons/c1/enable");
    const off = make();
    await off.fetchers.setSystemCronEnabled("c1", false);
    expect(off.calls[0]?.url.pathname).toBe("/system-crons/c1/disable");
  });

  it("setSystemCronEnabled resolves null on 404 and throws on other errors", async () => {
    expect(
      await make(404).fetchers.setSystemCronEnabled("c1", true),
    ).toBeNull();
    await expect(
      make(500).fetchers.setSystemCronEnabled("c1", false),
    ).rejects.toThrow(/POST \/system-crons\/c1\/disable → 500/);
  });
});
