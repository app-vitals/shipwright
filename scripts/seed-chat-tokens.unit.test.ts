/**
 * scripts/seed-chat-tokens.unit.test.ts
 * Unit tests for the local-dev chat-service token seeder.
 *
 * Pure helpers (hashRawToken) and the insert shape are tested via an injected
 * store double — no real DB, no network. The seeder is only ever run by
 * `task stack` against the local chat DB; it is never part of a deployed
 * stack.
 *
 * Flag parsing itself is covered by the @app-vitals/agent-lib cli-flags tests; this file
 * only asserts that the flag-name mapping this script relies on
 * (--db-url/--admin-token/--agent-token/--agent-id, both `--flag value` and
 * `--flag=value` forms) resolves the way the CLI entrypoint expects.
 */

import { describe, expect, test } from "bun:test";
import { parseFlags } from "@app-vitals/agent-lib/cli-flags";
import {
  type ChatTokenRow,
  hashRawToken,
  isMissingTableError,
  retryUntilMigrated,
  seedChatTokens,
} from "./seed-chat-tokens.ts";

const SEED_CHAT_FLAGS = [
  "--db-url",
  "--admin-token",
  "--agent-token",
  "--agent-id",
] as const;

describe("hashRawToken", () => {
  test("is a stable SHA-256 hex digest (known vector)", () => {
    // sha256("abc") — locks the algorithm against drift from the platform repo's chat/src/token-service.ts (app-vitals/agent).
    expect(hashRawToken("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  test("is deterministic for the dev tokens", () => {
    expect(hashRawToken("dev-chat-admin-token")).toBe(
      hashRawToken("dev-chat-admin-token"),
    );
  });
});

describe("parseFlags — seed-chat-tokens's flag mapping", () => {
  test("parses all flags in space form", () => {
    const result = parseFlags(
      [
        "--db-url",
        "postgresql://x/y",
        "--admin-token",
        "a",
        "--agent-token",
        "b",
        "--agent-id",
        "dev-agent",
      ],
      SEED_CHAT_FLAGS,
    );
    expect(result["--db-url"]).toBe("postgresql://x/y");
    expect(result["--admin-token"]).toBe("a");
    expect(result["--agent-token"]).toBe("b");
    expect(result["--agent-id"]).toBe("dev-agent");
  });

  test("parses all flags in equals form", () => {
    const result = parseFlags(
      [
        "--db-url=postgresql://x/y",
        "--admin-token=a",
        "--agent-token=b",
        "--agent-id=dev-agent",
      ],
      SEED_CHAT_FLAGS,
    );
    expect(result["--db-url"]).toBe("postgresql://x/y");
    expect(result["--admin-token"]).toBe("a");
    expect(result["--agent-token"]).toBe("b");
    expect(result["--agent-id"]).toBe("dev-agent");
  });

  test("returns undefined fields when flags are absent", () => {
    const result = parseFlags([], SEED_CHAT_FLAGS);
    expect(result["--db-url"]).toBeUndefined();
    expect(result["--admin-token"]).toBeUndefined();
    expect(result["--agent-token"]).toBeUndefined();
    expect(result["--agent-id"]).toBeUndefined();
  });
});

describe("seedChatTokens", () => {
  function makeStoreDouble() {
    const rows: ChatTokenRow[] = [];
    return {
      rows,
      store: {
        insertIfAbsent: async (row: ChatTokenRow) => {
          rows.push(row);
        },
      },
    };
  }

  test("inserts an admin token (agentId null) and an agent-scoped token, hashed", async () => {
    const { store, rows } = makeStoreDouble();
    await seedChatTokens({
      store,
      adminRawToken: "dev-chat-admin-token",
      agentRawToken: "dev-chat-agent-token",
      agentId: "dev-agent",
    });

    expect(rows).toEqual([
      {
        token: hashRawToken("dev-chat-admin-token"),
        label: "dev-admin",
        agentId: null,
      },
      {
        token: hashRawToken("dev-chat-agent-token"),
        label: "dev-agent (dev-agent)",
        agentId: "dev-agent",
      },
    ]);
  });
});

describe("isMissingTableError", () => {
  test("recognises Postgres undefined_table by code or message", () => {
    expect(isMissingTableError({ code: "42P01" })).toBe(true);
    expect(isMissingTableError({ errno: "42P01" })).toBe(true);
    expect(
      isMissingTableError(new Error('relation "ChatToken" does not exist')),
    ).toBe(true);
    expect(isMissingTableError(new Error("connection refused"))).toBe(false);
    expect(isMissingTableError(undefined)).toBe(false);
  });
});

describe("retryUntilMigrated", () => {
  const noSleep = async () => {};

  test("retries while the table is missing, then succeeds", async () => {
    let calls = 0;
    const result = await retryUntilMigrated(
      async () => {
        calls++;
        if (calls < 3) throw { code: "42P01" };
        return "ok";
      },
      { sleep: noSleep },
    );
    expect(result).toBe("ok");
    expect(calls).toBe(3);
  });

  test("gives up after the attempt budget and rethrows", async () => {
    let calls = 0;
    await expect(
      retryUntilMigrated(
        async () => {
          calls++;
          throw { code: "42P01" };
        },
        { attempts: 4, sleep: noSleep },
      ),
    ).rejects.toEqual({ code: "42P01" });
    expect(calls).toBe(4);
  });

  test("does not retry unrelated errors", async () => {
    let calls = 0;
    await expect(
      retryUntilMigrated(
        async () => {
          calls++;
          throw new Error("boom");
        },
        { sleep: noSleep },
      ),
    ).rejects.toThrow("boom");
    expect(calls).toBe(1);
  });
});
