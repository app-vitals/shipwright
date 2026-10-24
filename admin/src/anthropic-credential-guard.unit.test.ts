/**
 * admin/src/anthropic-credential-guard.unit.test.ts
 * Unit tests for the Anthropic credential guard (WIF-2.1).
 */

import { describe, expect, it } from "bun:test";
import {
  ANTHROPIC_CREDENTIAL_KEYS,
  ANTHROPIC_CREDENTIALS_BLOCKED_CODE,
  AnthropicCredentialsBlockedError,
  anthropicCredentialKeysIn,
  isAnthropicCredentialKey,
} from "./anthropic-credential-guard.ts";
import { BadRequestError } from "./errors.ts";

describe("isAnthropicCredentialKey", () => {
  it.each([
    "CLAUDE_CODE_OAUTH_TOKEN",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
  ])("returns true for %s", (key) => {
    expect(isAnthropicCredentialKey(key)).toBe(true);
  });

  it.each(["OPENAI_API_KEY", "ANTHROPIC_BASE_URL", "anthropic_api_key", ""])(
    "returns false for %p",
    (key) => {
      expect(isAnthropicCredentialKey(key)).toBe(false);
    },
  );

  it("covers every exported credential key", () => {
    for (const key of ANTHROPIC_CREDENTIAL_KEYS) {
      expect(isAnthropicCredentialKey(key)).toBe(true);
    }
  });
});

describe("anthropicCredentialKeysIn", () => {
  it("filters to blocked keys, preserving input order", () => {
    expect(
      anthropicCredentialKeysIn([
        "ANTHROPIC_AUTH_TOKEN",
        "FOO",
        "CLAUDE_CODE_OAUTH_TOKEN",
        "BAR",
        "ANTHROPIC_API_KEY",
      ]),
    ).toEqual([
      "ANTHROPIC_AUTH_TOKEN",
      "CLAUDE_CODE_OAUTH_TOKEN",
      "ANTHROPIC_API_KEY",
    ]);
  });

  it("returns an empty array for empty input", () => {
    expect(anthropicCredentialKeysIn([])).toEqual([]);
  });

  it("returns an empty array when no keys are blocked", () => {
    expect(anthropicCredentialKeysIn(["FOO", "BAR"])).toEqual([]);
  });

  it("accepts any iterable (e.g. a Set)", () => {
    expect(
      anthropicCredentialKeysIn(new Set(["ANTHROPIC_API_KEY", "FOO"])),
    ).toEqual(["ANTHROPIC_API_KEY"]);
  });
});

describe("AnthropicCredentialsBlockedError", () => {
  it("extends BadRequestError and carries the stable code", () => {
    const err = new AnthropicCredentialsBlockedError(["ANTHROPIC_API_KEY"]);
    expect(err).toBeInstanceOf(BadRequestError);
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe("anthropic_credentials_blocked_federation");
    expect(err.code).toBe(ANTHROPIC_CREDENTIALS_BLOCKED_CODE);
    expect(err.name).toBe("AnthropicCredentialsBlockedError");
  });

  it("lists the keys in the message and exposes them", () => {
    const keys = ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"];
    const err = new AnthropicCredentialsBlockedError(keys);
    expect(err.keys).toEqual(keys);
    expect(err.message).toContain("ANTHROPIC_API_KEY, CLAUDE_CODE_OAUTH_TOKEN");
    expect(err.message).toContain(ANTHROPIC_CREDENTIALS_BLOCKED_CODE);
  });
});
