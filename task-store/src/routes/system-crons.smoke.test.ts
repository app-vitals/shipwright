/**
 * task-store/src/routes/system-crons.smoke.test.ts
 *
 * Smoke tests for the /system-crons routes (SCR-1.1) via in-process
 * app.request(), against a hand-faked SystemCronServiceLike that records its
 * calls. Covers the HTTP contract only — auth (401 / admin-only 403), status
 * codes (201 claimed vs 200 not-claimed), account-scope plumbing, and error
 * propagation. Fire's exactly-once semantics are covered against a real DB in
 * system-cron-service.integration.test.ts.
 */

import { describe, expect, it } from "bun:test";
import { createTaskStoreApp } from "../app.ts";
import { ConflictError, NotFoundError } from "../errors.ts";
import type { SystemCronDefinition } from "../index.ts";
import type { SessionServiceLike } from "../session-service.ts";
import type {
  FireSystemCronResult,
  SystemCronServiceLike,
} from "../system-cron-service.ts";
import type { TaskServiceLike } from "../task-service.ts";
import type { TokenServiceLike } from "../token-service.ts";

const ADMIN_TOKEN = "admin-token";
const AGENT_TOKEN = "agent-token";

const DEF: SystemCronDefinition = {
  id: "dep-audit",
  accountId: "default",
  name: "Dependency audit",
  schedule: "0 9 * * 1",
  timezone: "UTC",
  enabled: true,
  titleTemplate: "Audit {repo}",
  descriptionTemplate: "Audit {repo}",
  createdAt: new Date("2026-11-14T00:00:00.000Z"),
  updatedAt: new Date("2026-11-14T00:00:00.000Z"),
};

function tokenService(): TokenServiceLike {
  return {
    async create() {
      return { token: {} as never, rawToken: "" };
    },
    async validate(raw: string) {
      if (raw === ADMIN_TOKEN) return { id: "tok-admin", agentId: null };
      if (raw === AGENT_TOKEN) return { id: "tok-agent", agentId: "agent-1" };
      return null;
    },
    async revoke() {
      return null;
    },
    async list() {
      return [];
    },
    async update() {
      return null;
    },
  };
}

type Call = { method: string; args: unknown[] };

function fakeService(
  opts: { fireResult?: FireSystemCronResult; fireError?: Error } = {},
): SystemCronServiceLike & { calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    async list(filters) {
      calls.push({ method: "list", args: [filters] });
      return [DEF];
    },
    async create(data, accountId) {
      calls.push({ method: "create", args: [data, accountId] });
      return { ...DEF, ...data, accountId } as SystemCronDefinition;
    },
    async update(id, patch, accountId) {
      calls.push({ method: "update", args: [id, patch, accountId] });
      if (id !== DEF.id) throw new NotFoundError("system cron not found");
      return { ...DEF, ...patch } as SystemCronDefinition;
    },
    async setEnabled(id, enabled, accountId) {
      calls.push({ method: "setEnabled", args: [id, enabled, accountId] });
      return { ...DEF, enabled };
    },
    async fire(id, input, accountId) {
      calls.push({ method: "fire", args: [id, input, accountId] });
      if (opts.fireError) throw opts.fireError;
      return (
        opts.fireResult ?? {
          claimed: true,
          cronId: id,
          scheduledFor: "2026-11-14T09:00:00.000Z",
          slot: "20261114T090000Z",
          taskIds: ["SC-dep-audit-20261114T090000Z-org-repo"],
        }
      );
    },
    async lastTrigger(id, accountId) {
      calls.push({ method: "lastTrigger", args: [id, accountId] });
      if (id !== DEF.id) throw new NotFoundError("system cron not found");
      return { scheduledFor: "2026-11-14T09:00:00.000Z" };
    },
    async recentTriggers(id, limit, accountId) {
      calls.push({ method: "recentTriggers", args: [id, limit, accountId] });
      if (id !== DEF.id) throw new NotFoundError("system cron not found");
      return {
        triggers: [
          {
            scheduledFor: "2026-11-14T09:00:00.000Z",
            claimedAt: "2026-11-14T09:00:01.000Z",
            taskCount: 2,
          },
        ],
      };
    },
  };
}

function makeApp(service: SystemCronServiceLike) {
  return createTaskStoreApp({
    taskService: {} as TaskServiceLike,
    tokenService: tokenService(),
    sessionService: {} as SessionServiceLike,
    systemCronService: service,
  });
}

function req(
  path: string,
  init: { method?: string; body?: unknown; token?: string | null } = {},
): Request {
  const headers: Record<string, string> = {};
  const token = init.token === undefined ? ADMIN_TOKEN : init.token;
  if (token !== null) headers.Authorization = `Bearer ${token}`;
  if (init.body !== undefined) headers["Content-Type"] = "application/json";
  return new Request(`http://localhost${path}`, {
    method: init.method ?? "GET",
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

const FIRE_BODY = {
  scheduledFor: "2026-11-14T09:00:00Z",
  repos: ["org/repo"],
};

describe("/system-crons auth", () => {
  it("401s without a bearer token", async () => {
    const res = await makeApp(fakeService()).request(
      req("/system-crons", { token: null }),
    );
    expect(res.status).toBe(401);
  });

  it("403s agent tokens on every route", async () => {
    const service = fakeService();
    const app = makeApp(service);
    const cases: Array<[string, string, unknown]> = [
      ["GET", "/system-crons", undefined],
      ["POST", "/system-crons", { ...DEF }],
      ["PATCH", "/system-crons/dep-audit", { name: "x" }],
      ["POST", "/system-crons/dep-audit/enable", undefined],
      ["POST", "/system-crons/dep-audit/disable", undefined],
      ["POST", "/system-crons/dep-audit/fire", FIRE_BODY],
      ["GET", "/system-crons/dep-audit/last-trigger", undefined],
    ];
    for (const [method, path, body] of cases) {
      const res = await app.request(
        req(path, { method, body, token: AGENT_TOKEN }),
      );
      expect(res.status).toBe(403);
    }
    expect(service.calls).toHaveLength(0);
  });
});

describe("GET /system-crons", () => {
  it("lists definitions, passing enabled + accountId filters", async () => {
    const service = fakeService();
    const res = await makeApp(service).request(
      req("/system-crons?enabled=true&accountId=acct-1"),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { systemCrons: { id: string }[] };
    expect(body.systemCrons.map((d) => d.id)).toEqual(["dep-audit"]);
    expect(service.calls[0]).toEqual({
      method: "list",
      args: [{ accountId: "acct-1", enabled: true }],
    });
  });

  it("is unrestricted for admin without ?accountId=", async () => {
    const service = fakeService();
    await makeApp(service).request(req("/system-crons"));
    expect(service.calls[0].args[0]).toEqual({
      accountId: null,
      enabled: undefined,
    });
  });
});

describe("POST /system-crons", () => {
  it("201s and stamps the write account (default when omitted)", async () => {
    const service = fakeService();
    const res = await makeApp(service).request(
      req("/system-crons", {
        method: "POST",
        body: {
          id: "dep-audit",
          name: "Dependency audit",
          schedule: "0 9 * * 1",
          titleTemplate: "Audit {repo}",
          descriptionTemplate: "Audit {repo}",
        },
      }),
    );
    expect(res.status).toBe(201);
    expect(service.calls[0].args[1]).toBe("default");
  });
});

describe("PATCH /system-crons/:id", () => {
  it("200s with the updated definition", async () => {
    const service = fakeService();
    const res = await makeApp(service).request(
      req("/system-crons/dep-audit", {
        method: "PATCH",
        body: { schedule: "0 10 * * *" },
      }),
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { schedule: string }).schedule).toBe(
      "0 10 * * *",
    );
    expect(service.calls[0].args).toEqual([
      "dep-audit",
      { schedule: "0 10 * * *" },
      null,
    ]);
  });

  it("404s an unknown id", async () => {
    const res = await makeApp(fakeService()).request(
      req("/system-crons/nope", { method: "PATCH", body: { name: "x" } }),
    );
    expect(res.status).toBe(404);
  });
});

describe("POST /system-crons/:id/enable|disable", () => {
  it("enable sets enabled:true, disable sets enabled:false", async () => {
    const service = fakeService();
    const app = makeApp(service);
    const on = await app.request(
      req("/system-crons/dep-audit/enable", { method: "POST" }),
    );
    const off = await app.request(
      req("/system-crons/dep-audit/disable", { method: "POST" }),
    );
    expect(on.status).toBe(200);
    expect(off.status).toBe(200);
    expect(((await on.json()) as { enabled: boolean }).enabled).toBe(true);
    expect(((await off.json()) as { enabled: boolean }).enabled).toBe(false);
  });
});

describe("GET /system-crons/:id/last-trigger", () => {
  it("200s with the service's scheduledFor, passing the account scope", async () => {
    const service = fakeService();
    const res = await makeApp(service).request(
      req("/system-crons/dep-audit/last-trigger"),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      scheduledFor: "2026-11-14T09:00:00.000Z",
    });
    expect(service.calls).toEqual([
      { method: "lastTrigger", args: ["dep-audit", null] },
    ]);
  });

  it("404s an unknown id", async () => {
    const res = await makeApp(fakeService()).request(
      req("/system-crons/nope/last-trigger"),
    );
    expect(res.status).toBe(404);
  });
});

describe("GET /system-crons/:id/triggers", () => {
  it("200s with the service's triggers, defaulting limit to 5", async () => {
    const service = fakeService();
    const res = await makeApp(service).request(
      req("/system-crons/dep-audit/triggers"),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      triggers: [
        {
          scheduledFor: "2026-11-14T09:00:00.000Z",
          claimedAt: "2026-11-14T09:00:01.000Z",
          taskCount: 2,
        },
      ],
    });
    expect(service.calls).toEqual([
      { method: "recentTriggers", args: ["dep-audit", 5, null] },
    ]);
  });

  it("passes ?limit and ?accountId through", async () => {
    const service = fakeService();
    const res = await makeApp(service).request(
      req("/system-crons/dep-audit/triggers?limit=50&accountId=acct-1"),
    );
    expect(res.status).toBe(200);
    expect(service.calls).toEqual([
      { method: "recentTriggers", args: ["dep-audit", 50, "acct-1"] },
    ]);
  });

  it.each(["0", "51", "abc", "1.5"])("400s invalid limit %s", async (limit) => {
    const service = fakeService();
    const res = await makeApp(service).request(
      req(`/system-crons/dep-audit/triggers?limit=${limit}`),
    );
    expect(res.status).toBe(400);
    expect(service.calls).toEqual([]);
  });

  it("404s an unknown id", async () => {
    const res = await makeApp(fakeService()).request(
      req("/system-crons/nope/triggers"),
    );
    expect(res.status).toBe(404);
  });
});

describe("POST /system-crons/:id/fire", () => {
  it("201s when this call claimed the slot", async () => {
    const service = fakeService();
    const res = await makeApp(service).request(
      req("/system-crons/dep-audit/fire?accountId=acct-1", {
        method: "POST",
        body: FIRE_BODY,
      }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as FireSystemCronResult;
    expect(body.claimed).toBe(true);
    expect(body.taskIds).toEqual(["SC-dep-audit-20261114T090000Z-org-repo"]);
    expect(service.calls[0].args).toEqual(["dep-audit", FIRE_BODY, "acct-1"]);
  });

  it("200s with claimed:false when the slot was already claimed", async () => {
    const res = await makeApp(
      fakeService({
        fireResult: {
          claimed: false,
          cronId: "dep-audit",
          scheduledFor: "2026-11-14T09:00:00.000Z",
          slot: "20261114T090000Z",
          taskIds: [],
        },
      }),
    ).request(
      req("/system-crons/dep-audit/fire", { method: "POST", body: FIRE_BODY }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as FireSystemCronResult;
    expect(body.claimed).toBe(false);
    expect(body.taskIds).toEqual([]);
  });

  it("propagates a disabled-definition conflict as 409", async () => {
    const res = await makeApp(
      fakeService({ fireError: new ConflictError("disabled") }),
    ).request(
      req("/system-crons/dep-audit/fire", { method: "POST", body: FIRE_BODY }),
    );
    expect(res.status).toBe(409);
  });

  it("400s a body missing repos", async () => {
    const res = await makeApp(fakeService()).request(
      req("/system-crons/dep-audit/fire", {
        method: "POST",
        body: { scheduledFor: "2026-11-14T09:00:00Z" },
      }),
    );
    expect(res.status).toBe(400);
  });
});
