import { describe, expect, test } from "bun:test";
import { DEFAULT_ADMIN_AGENT_TOOLS, DEFAULT_AGENT_TOOLS } from "./agent-default-tools.ts";

describe("DEFAULT_ADMIN_AGENT_TOOLS", () => {
  test("is a non-empty array", () => {
    expect(Array.isArray(DEFAULT_ADMIN_AGENT_TOOLS)).toBe(true);
    expect(DEFAULT_ADMIN_AGENT_TOOLS.length).toBeGreaterThan(0);
  });

  test("contains expected tool patterns", () => {
    const expectedEntries = ["Bash", "WebSearch", "WebFetch", "Agent"];

    for (const entry of expectedEntries) {
      expect(DEFAULT_ADMIN_AGENT_TOOLS).toContain(entry);
    }
  });

  test("has exactly the expected number of entries (catches accidental additions/removals)", () => {
    expect(DEFAULT_ADMIN_AGENT_TOOLS.length).toBe(4);
  });

  test("every entry is a non-empty string", () => {
    for (const entry of DEFAULT_ADMIN_AGENT_TOOLS) {
      expect(typeof entry).toBe("string");
      expect(entry.length).toBeGreaterThan(0);
    }
  });

  test("has no duplicate entries", () => {
    const uniqueEntries = new Set(DEFAULT_ADMIN_AGENT_TOOLS);
    expect(uniqueEntries.size).toBe(DEFAULT_ADMIN_AGENT_TOOLS.length);
  });
});

describe("DEFAULT_AGENT_TOOLS", () => {
  test("is a non-empty array", () => {
    expect(Array.isArray(DEFAULT_AGENT_TOOLS)).toBe(true);
    expect(DEFAULT_AGENT_TOOLS.length).toBeGreaterThan(0);
  });

  test("contains expected tool patterns", () => {
    const expectedEntries = [
      "Read",
      "Write",
      "Edit",
      "Glob",
      "Grep",
      "Bash",
      "WebSearch",
      "WebFetch",
      "Skill",
      "Agent",
    ];

    for (const entry of expectedEntries) {
      expect(DEFAULT_AGENT_TOOLS).toContain(entry);
    }
  });

  test("has exactly the expected number of entries (catches accidental additions/removals)", () => {
    expect(DEFAULT_AGENT_TOOLS.length).toBe(10);
  });

  test("every entry is a non-empty string", () => {
    for (const entry of DEFAULT_AGENT_TOOLS) {
      expect(typeof entry).toBe("string");
      expect(entry.length).toBeGreaterThan(0);
    }
  });

  test("has no duplicate entries", () => {
    const uniqueEntries = new Set(DEFAULT_AGENT_TOOLS);
    expect(uniqueEntries.size).toBe(DEFAULT_AGENT_TOOLS.length);
  });

  test("is a superset of DEFAULT_ADMIN_AGENT_TOOLS", () => {
    for (const entry of DEFAULT_ADMIN_AGENT_TOOLS) {
      expect(DEFAULT_AGENT_TOOLS).toContain(entry);
    }
  });
});
