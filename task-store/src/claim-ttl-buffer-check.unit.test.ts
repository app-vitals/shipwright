/**
 * task-store/src/claim-ttl-buffer-check.unit.test.ts
 *
 * Unit tests for checkClaimTtlBuffer — a pure function that warns when the
 * task-store's resolved claim TTL doesn't leave enough headroom over the
 * agent's configured claude timeout + buffer. Opt-in: only fires when
 * claudeTimeoutMs is defined (i.e. SHIPWRIGHT_CLAUDE_TIMEOUT_MS is set in
 * task-store's own env).
 */

import { describe, expect, test } from "bun:test";
import { CLAIM_TTL_BUFFER_MS } from "@shipwright/lib/claim-ttl";
import { checkClaimTtlBuffer } from "./claim-ttl-buffer-check.ts";

describe("checkClaimTtlBuffer", () => {
  test("returns null when claudeTimeoutMs is undefined (opt-in, no new required config)", () => {
    const result = checkClaimTtlBuffer(2_100_000, undefined);
    expect(result).toBeNull();
  });

  test("returns null when ttlMs is sufficiently larger than claudeTimeoutMs + buffer", () => {
    const claudeTimeoutMs = 1_800_000;
    const ttlMs = claudeTimeoutMs + CLAIM_TTL_BUFFER_MS + 1; // just over the minimum
    const result = checkClaimTtlBuffer(ttlMs, claudeTimeoutMs);
    expect(result).toBeNull();
  });

  test("returns a non-null warning naming both values when ttlMs is insufficient", () => {
    const claudeTimeoutMs = 1_800_000;
    const ttlMs = 1_000_000; // far too small
    const result = checkClaimTtlBuffer(ttlMs, claudeTimeoutMs);

    expect(result).not.toBeNull();
    expect(result as string).toContain(String(ttlMs));
    expect(result as string).toContain(String(claudeTimeoutMs));
    expect(result as string).toContain("SHIPWRIGHT_TASK_STORE_CLAIM_TTL_MS");
    expect(result as string).toContain("SHIPWRIGHT_CLAUDE_TIMEOUT_MS");
  });

  test("boundary: ttlMs exactly equal to claudeTimeoutMs + buffer warns (per <= condition)", () => {
    const claudeTimeoutMs = 1_800_000;
    const ttlMs = claudeTimeoutMs + CLAIM_TTL_BUFFER_MS; // exactly equal
    const result = checkClaimTtlBuffer(ttlMs, claudeTimeoutMs);

    expect(result).not.toBeNull();
    expect(result as string).toContain(String(ttlMs));
    expect(result as string).toContain(String(claudeTimeoutMs));
  });

  test("boundary: ttlMs one ms over claudeTimeoutMs + buffer does not warn", () => {
    const claudeTimeoutMs = 1_800_000;
    const ttlMs = claudeTimeoutMs + CLAIM_TTL_BUFFER_MS + 1;
    const result = checkClaimTtlBuffer(ttlMs, claudeTimeoutMs);

    expect(result).toBeNull();
  });
});
