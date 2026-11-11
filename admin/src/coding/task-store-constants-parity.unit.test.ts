import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_CLAIM_TTL_MS } from "./claim-ttl.ts";
import { DEFAULT_ACCOUNT_ID } from "./default-account.ts";

// admin cannot import task-store, so read its authoritative source as text.
const tsSrc = (file: string) =>
  readFileSync(join(import.meta.dir, "../../../task-store/src", file), "utf8");

describe("admin copies of task-store constants", () => {
  it("DEFAULT_ACCOUNT_ID matches task-store", () => {
    const m = /DEFAULT_ACCOUNT_ID = "([^"]+)"/.exec(
      tsSrc("default-account.ts"),
    );
    expect(DEFAULT_ACCOUNT_ID).toBe(m?.[1] ?? "");
  });

  it("DEFAULT_CLAIM_TTL_MS equals task-store's timeout + buffer", () => {
    const src = tsSrc("claim-ttl.ts");
    const buffer = Number(
      /CLAIM_TTL_BUFFER_MS = ([\d_]+)/.exec(src)?.[1]?.replaceAll("_", "") ??
        "",
    );
    // DEFAULT_CLAUDE_TIMEOUT_MS is the platform's 1h `claude -p` hard timeout.
    expect(DEFAULT_CLAIM_TTL_MS).toBe(3_600_000 + buffer);
  });
});
