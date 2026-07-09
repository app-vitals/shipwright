import { describe, expect, test } from "bun:test";
import { buildLogPrefix } from "./log-prefix.ts";

describe("buildLogPrefix", () => {
  test("returns timestamp only when agentId is undefined, with no 'undefined' literal", () => {
    const timestamp = "2026-07-09T09:00:00.000Z";
    const prefix = buildLogPrefix(undefined, timestamp);
    expect(prefix).toBe(`[${timestamp}]`);
    expect(prefix).not.toContain("undefined");
  });

  test("returns timestamp only when agentId is empty string", () => {
    const timestamp = "2026-07-09T09:00:00.000Z";
    const prefix = buildLogPrefix("", timestamp);
    expect(prefix).toBe(`[${timestamp}]`);
  });

  test("appends [agent:ID] after the timestamp when agentId is set", () => {
    const timestamp = "2026-07-09T09:00:00.123Z";
    const agentId = "shipwright-prod-us-east-1";
    const prefix = buildLogPrefix(agentId, timestamp);
    expect(prefix).toBe(`[${timestamp}] [agent:${agentId}]`);
  });
});
