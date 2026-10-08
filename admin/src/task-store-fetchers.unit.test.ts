/**
 * admin/src/task-store-fetchers.unit.test.ts
 *
 * SSP-6.8 — the admin UI's task-store fetchers use the single admin token and
 * narrow to one account by forwarding `?accountId=` (admin tokens honor it;
 * agent tokens ignore it). Driven through an injected fetch double that
 * records each request, so no global is touched.
 */

import { describe, expect, it } from "bun:test";
import { createTaskStoreFetchers } from "./task-store-fetchers.ts";

interface Recorded {
  url: URL;
  method: string;
  auth: string | null;
  body?: string;
}

function recordingFetch(
  respond: (url: URL) => Response = () =>
    new Response(JSON.stringify({}), { status: 200 }),
) {
  const calls: Recorded[] = [];
  const fetchFn = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = new URL(String(input));
    calls.push({
      url,
      method: init?.method ?? "GET",
      auth: new Headers(init?.headers).get("Authorization"),
      ...(typeof init?.body === "string" ? { body: init.body } : {}),
    });
    return respond(url);
  };
  return { calls, fetchFn };
}

function make(respond?: (url: URL) => Response) {
  const rec = recordingFetch(respond);
  const fetchers = createTaskStoreFetchers({
    url: "http://task-store.test",
    adminToken: "admin-tok",
    fetch: rec.fetchFn,
  });
  return { ...rec, fetchers };
}

describe("createTaskStoreFetchers — accountId forwarding (SSP-6.8)", () => {
  it("omits accountId entirely when none is given (admin: every account)", async () => {
    const { calls, fetchers } = make();
    await fetchers.fetchTaskStoreTasks(new URLSearchParams({ limit: "5" }));
    expect(calls[0]?.url.pathname).toBe("/tasks");
    expect(calls[0]?.url.searchParams.get("limit")).toBe("5");
    expect(calls[0]?.url.searchParams.has("accountId")).toBe(false);
    expect(calls[0]?.auth).toBe("Bearer admin-tok");
  });

  it("forwards ?accountId= on every list fetcher without mutating the caller's params", async () => {
    const { calls, fetchers } = make();
    const params = new URLSearchParams({ repo: "org/r" });
    await fetchers.fetchTaskStoreTasks(params, "acct-a");
    await fetchers.fetchTaskStorePrs(params, "acct-a");
    await fetchers.fetchVerificationChecks(params, "acct-a");
    await fetchers.fetchTaskStoreSessions(params, "acct-a");
    await fetchers.fetchDistinctTaskValues("acct-a");
    expect(calls.map((c) => c.url.pathname)).toEqual([
      "/tasks",
      "/prs",
      "/verification-checks",
      "/sessions",
      "/tasks/distinct",
    ]);
    for (const call of calls) {
      expect(call.url.searchParams.get("accountId")).toBe("acct-a");
    }
    expect(calls[0]?.url.searchParams.get("repo")).toBe("org/r");
    expect(params.has("accountId")).toBe(false);
  });

  it("forwards ?accountId= on by-id fetchers, release and session patch", async () => {
    const { calls, fetchers } = make();
    await fetchers.fetchTaskStoreTask("T-1", "acct-a");
    await fetchers.releaseTask("T-1", "acct-a");
    await fetchers.fetchTaskStorePrById("pr-1", "acct-a");
    await fetchers.fetchTaskStoreSession("my slug", "acct-a");
    await fetchers.patchTaskStoreSession(
      "my slug",
      { archived: true },
      "acct-a",
    );
    expect(calls.map((c) => `${c.method} ${c.url.pathname}`)).toEqual([
      "GET /tasks/T-1",
      "POST /tasks/T-1/release",
      "GET /prs/pr-1",
      "GET /sessions/my%20slug",
      "PATCH /sessions/my%20slug",
    ]);
    for (const call of calls) {
      expect(call.url.searchParams.get("accountId")).toBe("acct-a");
    }
    expect(calls[4]?.body).toBe(JSON.stringify({ archived: true }));
  });

  it("maps a 404 on by-id reads and the session patch to null", async () => {
    const { fetchers } = make(() => new Response("{}", { status: 404 }));
    expect(await fetchers.fetchTaskStoreTask("T-x", "acct-a")).toBeNull();
    expect(await fetchers.fetchTaskStorePrById("pr-x", "acct-a")).toBeNull();
    expect(await fetchers.fetchTaskStoreSession("s", "acct-a")).toBeNull();
    expect(
      await fetchers.patchTaskStoreSession("s", { title: "t" }, "acct-a"),
    ).toBeNull();
  });

  it("throws on non-404 failures", async () => {
    const { fetchers } = make(() => new Response("{}", { status: 500 }));
    await expect(
      fetchers.fetchTaskStoreTasks(new URLSearchParams()),
    ).rejects.toThrow("500");
    await expect(fetchers.releaseTask("T-1")).rejects.toThrow("500");
  });
});
