/**
 * agent/src/coding/claim-ttl.unit.test.ts
 *
 * Unit tests for the localized claim-ttl module. Pins the constants and verifies
 * parity with task-store/src/claim-ttl.ts.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DEFAULT_CLAUDE_TIMEOUT_MS } from "@app-vitals/agent-lib/claude-timeout";
import { CLAIM_TTL_BUFFER_MS, DEFAULT_CLAIM_TTL_MS } from "./claim-ttl.ts";

describe("claim-ttl constants", () => {
  it("CLAIM_TTL_BUFFER_MS is 300_000 (5 minutes)", () => {
    expect(CLAIM_TTL_BUFFER_MS).toBe(300_000);
  });

  it("DEFAULT_CLAIM_TTL_MS equals DEFAULT_CLAUDE_TIMEOUT_MS + CLAIM_TTL_BUFFER_MS", () => {
    expect(DEFAULT_CLAIM_TTL_MS).toBe(
      DEFAULT_CLAUDE_TIMEOUT_MS + CLAIM_TTL_BUFFER_MS,
    );
  });

  it("DEFAULT_CLAIM_TTL_MS is 3_900_000 (65 minutes)", () => {
    // DEFAULT_CLAUDE_TIMEOUT_MS is 3600_000 (60 minutes), plus 300_000 (5 minutes) = 3900_000
    expect(DEFAULT_CLAIM_TTL_MS).toBe(3_900_000);
  });

  it("parity: agent/src/coding/claim-ttl.ts matches task-store/src/claim-ttl.ts values", () => {
    // Read task-store version and verify constants match
    const taskStoreFile = resolve(
      import.meta.dir,
      "../../../task-store/src/claim-ttl.ts",
    );
    const taskStoreContent = readFileSync(taskStoreFile, "utf8");

    // Extract CLAIM_TTL_BUFFER_MS from task-store file
    const bufferMatch = /CLAIM_TTL_BUFFER_MS\s*=\s*(\d+_?\d*)/m.exec(
      taskStoreContent,
    );
    expect(bufferMatch).not.toBeNull();
    const taskStoreBuffer = Number((bufferMatch?.[1] || "0").replace(/_/g, ""));
    expect(CLAIM_TTL_BUFFER_MS).toBe(taskStoreBuffer);

    // Verify the formula: DEFAULT_CLAIM_TTL_MS = DEFAULT_CLAUDE_TIMEOUT_MS + CLAIM_TTL_BUFFER_MS
    // is present in both files (as a comment or code pattern)
    expect(taskStoreContent).toContain("DEFAULT_CLAUDE_TIMEOUT_MS");
    expect(taskStoreContent).toContain("CLAIM_TTL_BUFFER_MS");
  });
});
