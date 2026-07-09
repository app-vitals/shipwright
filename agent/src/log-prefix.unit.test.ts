/**
 * Unit tests for buildLogPrefix() in agent/src/log-prefix.ts
 *
 * Pure function — no side effects, no mocks needed.
 */

import { describe, expect, test } from "bun:test";
import { buildLogPrefix } from "./log-prefix.ts";

describe("buildLogPrefix", () => {
  test("returns timestamp only when agentId is undefined", () => {
    const timestamp = "2026-07-09T09:00:00.000Z";
    const prefix = buildLogPrefix(undefined, timestamp);
    expect(prefix).toBe(`[${timestamp}]`);
    expect(prefix).not.toContain("undefined");
  });

  test("returns timestamp only when agentId is empty string", () => {
    const timestamp = "2026-07-09T09:00:00.000Z";
    const prefix = buildLogPrefix("", timestamp);
    expect(prefix).toBe(`[${timestamp}]`);
    expect(prefix).not.toContain("undefined");
  });

  test("includes agent tag when agentId is set", () => {
    const timestamp = "2026-07-09T09:00:00.000Z";
    const agentId = "agent-abc123";
    const prefix = buildLogPrefix(agentId, timestamp);
    expect(prefix).toBe(
      `[${timestamp}] [agent:${agentId}]`,
    );
  });

  test("handles typical agent ID format", () => {
    const timestamp = "2026-07-09T09:00:00.000Z";
    const agentId = "shipwright-prod-us-east-1";
    const prefix = buildLogPrefix(agentId, timestamp);
    expect(prefix).toContain("[agent:shipwright-prod-us-east-1]");
    expect(prefix).toContain(`[${timestamp}]`);
  });

  test("does not include 'undefined' literal in output when agentId is undefined", () => {
    const timestamp = "2026-07-09T09:00:00.000Z";
    const prefix = buildLogPrefix(undefined, timestamp);
    expect(prefix.includes("undefined")).toBe(false);
  });

  test("preserves timestamp format exactly", () => {
    const timestamp = "2026-07-09T09:00:00.123Z";
    const agentId = "agent-xyz";
    const prefix = buildLogPrefix(agentId, timestamp);
    expect(prefix).toContain(timestamp);
  });
});
