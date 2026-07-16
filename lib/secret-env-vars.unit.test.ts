import { describe, expect, test } from "bun:test";
import { SECRET_ENV_VARS } from "./secret-env-vars.ts";

describe("SECRET_ENV_VARS", () => {
  test("is a non-empty array", () => {
    expect(Array.isArray(SECRET_ENV_VARS)).toBe(true);
    expect(SECRET_ENV_VARS.length).toBeGreaterThan(0);
  });

  test("contains expected well-known secret env var names", () => {
    const expectedEntries = [
      "ANTHROPIC_API_KEY",
      "CLAUDE_CODE_OAUTH_TOKEN",
      "GH_APP_PRIVATE_KEY",
      "GH_TOKEN",
      "SLACK_BOT_TOKEN",
      "SLACK_APP_TOKEN",
      "SLACK_SIGNING_SECRET",
      "SLACK_CLIENT_SECRET",
      "SLACK_ADMIN_TOKEN",
      "SHIPWRIGHT_AGENT_API_KEY",
      "SHIPWRIGHT_TASK_STORE_TOKEN",
      "SHIPWRIGHT_TASK_STORE_ADMIN_TOKEN",
      "SHIPWRIGHT_CHAT_SERVICE_TOKEN",
      "SHIPWRIGHT_CHAT_SERVICE_ADMIN_TOKEN",
      "SHIPWRIGHT_ADMIN_API_KEYS",
      "SHIPWRIGHT_SESSION_SECRET",
      "SHIPWRIGHT_ENCRYPTION_KEY",
      "GOOGLE_CLIENT_SECRET",
    ];

    for (const entry of expectedEntries) {
      expect(SECRET_ENV_VARS).toContain(entry);
    }
  });

  test("has exactly the expected number of entries (catches accidental additions/removals)", () => {
    expect(SECRET_ENV_VARS.length).toBe(18);
  });

  test("every entry is a non-empty string", () => {
    for (const entry of SECRET_ENV_VARS) {
      expect(typeof entry).toBe("string");
      expect(entry.length).toBeGreaterThan(0);
    }
  });

  test("every entry looks like an env var name (uppercase snake case)", () => {
    for (const entry of SECRET_ENV_VARS) {
      expect(entry).toMatch(/^[A-Z][A-Z0-9_]*$/);
    }
  });

  test("has no duplicate entries", () => {
    const uniqueEntries = new Set(SECRET_ENV_VARS);
    expect(uniqueEntries.size).toBe(SECRET_ENV_VARS.length);
  });
});
