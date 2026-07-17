/**
 * metrics/src/lib/accounts-client.integration.test.ts
 * Integration: HttpAccountsClient builds correct URLs/headers for the real
 * accounts endpoints it implements (getUser, listUsers, listAgents,
 * listAgentCronJobs), and throws a typed error on non-2xx. Exercises the
 * real external-HTTP-client boundary via an injected `FetchLike` double
 * that replays recorded cassette fixtures — no global override (Bun shares
 * the test process), no mock.module(). Mirrors
 * admin-metrics-client.integration.test.ts and
 * slack-provisioning-client.integration.test.ts's cassette pattern.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  AccountsClientError,
  type AgentRecord,
  type CronJobRecord,
  type FetchLike,
  HttpAccountsClient,
  type UserRecord,
} from "./accounts-client.ts";

// ─── Cassettes ────────────────────────────────────────────────────────────────

interface CassetteEntry {
  status: number;
  body: unknown;
}

function loadCassette(fileName: string): Record<string, CassetteEntry> {
  const path = new URL(`../fixtures/accounts/${fileName}`, import.meta.url)
    .pathname;
  return JSON.parse(readFileSync(path, "utf-8"));
}

const getUserCassette = loadCassette("get-user.json");
const listUsersCassette = loadCassette("list-users.json");
const listAgentsCassette = loadCassette("list-agents.json");
const listAgentCronJobsCassette = loadCassette("list-agent-cron-jobs.json");

/** Build an injected FetchLike that replays the cassette entry for `key` and
 * records every call so tests can assert URL/headers. */
function cassetteFetch(
  cassette: Record<string, CassetteEntry>,
  key: string,
): {
  fetch: FetchLike;
  calls: { url: string; headers?: Record<string, string> }[];
} {
  const entry = cassette[key];
  if (!entry) throw new Error(`cassette key not found: ${key}`);
  const calls: { url: string; headers?: Record<string, string> }[] = [];

  const fetch: FetchLike = async (input, init) => {
    calls.push({ url: input, headers: init?.headers });
    const bodyText =
      typeof entry.body === "string" ? entry.body : JSON.stringify(entry.body);
    return {
      ok: entry.status >= 200 && entry.status < 300,
      status: entry.status,
      text: async () => bodyText,
      json: async () => entry.body,
    };
  };

  return { fetch, calls };
}

// ─── construction ───────────────────────────────────────────────────────────

describe("HttpAccountsClient construction", () => {
  test("strips a trailing slash from baseUrl", async () => {
    const { fetch, calls } = cassetteFetch(
      listUsersCassette,
      "listUsers_success",
    );
    const client = new HttpAccountsClient("http://accounts/", "tok", fetch);

    await client.listUsers();
    expect(calls[0]?.url).toBe("http://accounts/accounts/users");
  });

  test("uses globalThis.fetch when no fetch override is injected", () => {
    // No third constructor arg — must not throw, and must fall back to the
    // platform fetch (verified indirectly: construction succeeds).
    const client = new HttpAccountsClient("http://accounts", "tok");
    expect(client).toBeInstanceOf(HttpAccountsClient);
  });

  test("sends a Bearer auth header and JSON content-type", async () => {
    const { fetch, calls } = cassetteFetch(getUserCassette, "getUser_success");
    const client = new HttpAccountsClient(
      "http://accounts",
      "secret-tok",
      fetch,
    );

    await client.getUser("user-1");

    expect(calls[0]?.headers?.Authorization).toBe("Bearer secret-tok");
    expect(calls[0]?.headers?.["Content-Type"]).toBe("application/json");
  });
});

// ─── getUser ─────────────────────────────────────────────────────────────────

describe("HttpAccountsClient getUser", () => {
  test("returns the mapped UserRecord on a 200 response", async () => {
    const { fetch, calls } = cassetteFetch(getUserCassette, "getUser_success");
    const client = new HttpAccountsClient("http://accounts", "tok", fetch);

    const got = await client.getUser("user-1");

    expect(calls[0]?.url).toBe("http://accounts/accounts/users/user-1");
    const expected: UserRecord = {
      id: "user-1",
      name: "Ada Lovelace",
      email: "ada@example.com",
      slackId: "U0123456",
      role: "OWNER",
      workingHoursStart: "09:00",
      workingHoursEnd: "17:00",
      timezone: "UTC",
      mercuryCounterparty: null,
      ownerUserId: null,
      clientId: "client-1",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
    };
    expect(got).toEqual(expected);
  });

  test("throws AccountsClientError with statusCode and body text on a 404", async () => {
    const { fetch } = cassetteFetch(getUserCassette, "getUser_not_found");
    const client = new HttpAccountsClient("http://accounts", "tok", fetch);

    try {
      await client.getUser("missing-user");
      throw new Error("expected getUser to reject");
    } catch (err) {
      expect(err).toBeInstanceOf(AccountsClientError);
      expect((err as AccountsClientError).statusCode).toBe(404);
      expect((err as Error).message).toContain("user not found");
    }
  });
});

// ─── listUsers ───────────────────────────────────────────────────────────────

describe("HttpAccountsClient listUsers", () => {
  test("returns the mapped UserRecord[] on a 200 response", async () => {
    const { fetch, calls } = cassetteFetch(
      listUsersCassette,
      "listUsers_success",
    );
    const client = new HttpAccountsClient("http://accounts", "tok", fetch);

    const got = await client.listUsers();

    expect(calls[0]?.url).toBe("http://accounts/accounts/users");
    expect(got).toHaveLength(2);
    expect(got[0]?.id).toBe("user-1");
    expect(got[1]?.role).toBe("MEMBER");
  });

  test("throws AccountsClientError with statusCode and body text on a 503", async () => {
    const { fetch } = cassetteFetch(
      listUsersCassette,
      "listUsers_server_error",
    );
    const client = new HttpAccountsClient("http://accounts", "tok", fetch);

    try {
      await client.listUsers();
      throw new Error("expected listUsers to reject");
    } catch (err) {
      expect(err).toBeInstanceOf(AccountsClientError);
      expect((err as AccountsClientError).statusCode).toBe(503);
      expect((err as Error).message).toContain("accounts service unavailable");
    }
  });
});

// ─── listAgents ──────────────────────────────────────────────────────────────

describe("HttpAccountsClient listAgents", () => {
  test("returns the mapped AgentRecord[] on a 200 response", async () => {
    const { fetch, calls } = cassetteFetch(
      listAgentsCassette,
      "listAgents_success",
    );
    const client = new HttpAccountsClient("http://accounts", "tok", fetch);

    const got = await client.listAgents();

    expect(calls[0]?.url).toBe("http://accounts/agents");
    const expected: AgentRecord[] = [
      { id: "agent-1", name: "Warchild" },
      { id: "agent-2", name: "Scribe" },
    ];
    expect(got).toEqual(expected);
  });

  test("throws AccountsClientError with statusCode and body text on a 401", async () => {
    const { fetch } = cassetteFetch(
      listAgentsCassette,
      "listAgents_unauthorized",
    );
    const client = new HttpAccountsClient("http://accounts", "tok", fetch);

    try {
      await client.listAgents();
      throw new Error("expected listAgents to reject");
    } catch (err) {
      expect(err).toBeInstanceOf(AccountsClientError);
      expect((err as AccountsClientError).statusCode).toBe(401);
      expect((err as Error).message).toContain("invalid or expired token");
    }
  });
});

// ─── listAgentCronJobs ───────────────────────────────────────────────────────

describe("HttpAccountsClient listAgentCronJobs", () => {
  test("returns the mapped CronJobRecord[] on a 200 response", async () => {
    const { fetch, calls } = cassetteFetch(
      listAgentCronJobsCassette,
      "listAgentCronJobs_success",
    );
    const client = new HttpAccountsClient("http://accounts", "tok", fetch);

    const got = await client.listAgentCronJobs("agent-1");

    expect(calls[0]?.url).toBe("http://accounts/agents/agent-1/crons");
    const expected: CronJobRecord[] = [
      {
        id: "cron-1",
        name: "daily-standup",
        prompt: "Post the daily standup summary.",
      },
      { id: "cron-2", name: null, prompt: "Sweep stale branches." },
    ];
    expect(got).toEqual(expected);
  });

  test("throws AccountsClientError with statusCode and body text on a 404", async () => {
    const { fetch } = cassetteFetch(
      listAgentCronJobsCassette,
      "listAgentCronJobs_not_found",
    );
    const client = new HttpAccountsClient("http://accounts", "tok", fetch);

    try {
      await client.listAgentCronJobs("missing-agent");
      throw new Error("expected listAgentCronJobs to reject");
    } catch (err) {
      expect(err).toBeInstanceOf(AccountsClientError);
      expect((err as AccountsClientError).statusCode).toBe(404);
      expect((err as Error).message).toContain("agent not found");
    }
  });
});

// ─── stub methods (501 not implemented) ──────────────────────────────────────

describe("HttpAccountsClient stub methods", () => {
  test("createUser rejects with AccountsClientError statusCode 501", async () => {
    const client = new HttpAccountsClient("http://accounts", "tok");
    await expect(client.createUser({})).rejects.toMatchObject({
      statusCode: 501,
    });
  });

  test("listClients rejects with AccountsClientError statusCode 501", async () => {
    const client = new HttpAccountsClient("http://accounts", "tok");
    await expect(client.listClients()).rejects.toMatchObject({
      statusCode: 501,
    });
  });
});
