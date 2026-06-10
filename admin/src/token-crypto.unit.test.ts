/**
 * agent/src/token-crypto.unit.test.ts
 * Unit tests for the crypto round-trip (AES-256-GCM).
 * Pure logic — no I/O, no DB, no network.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { decrypt, encrypt } from "./crypto.ts";
import { identityCrypto, makeTokenCrypto } from "./token-crypto.ts";

// ─── Test key ─────────────────────────────────────────────────────────────────
// A known 64-char hex key (32 bytes) for deterministic tests.
const TEST_KEY =
  "0000000000000000000000000000000000000000000000000000000000000001";

// ─── crypto.ts: encrypt / decrypt ─────────────────────────────────────────────

describe("encrypt / decrypt (AES-256-GCM)", () => {
  it("round-trips a plain ASCII string", () => {
    const plaintext = "hello world";
    const encrypted = encrypt(plaintext, TEST_KEY);
    expect(decrypt(encrypted, TEST_KEY)).toBe(plaintext);
  });

  it("round-trips an empty string", () => {
    const plaintext = "";
    const encrypted = encrypt(plaintext, TEST_KEY);
    expect(decrypt(encrypted, TEST_KEY)).toBe(plaintext);
  });

  it("round-trips a unicode string", () => {
    const plaintext = "こんにちは世界 🌍 — café résumé naïve";
    const encrypted = encrypt(plaintext, TEST_KEY);
    expect(decrypt(encrypted, TEST_KEY)).toBe(plaintext);
  });

  it("round-trips a 4096-byte value", () => {
    const plaintext = "x".repeat(4096);
    const encrypted = encrypt(plaintext, TEST_KEY);
    expect(decrypt(encrypted, TEST_KEY)).toBe(plaintext);
  });

  it("produces a different ciphertext on each call (random IV)", () => {
    const plaintext = "same input";
    const enc1 = encrypt(plaintext, TEST_KEY);
    const enc2 = encrypt(plaintext, TEST_KEY);
    expect(enc1).not.toBe(enc2);
  });

  it("encrypted format is iv:ciphertext:authTag (3 colon-separated parts)", () => {
    const encrypted = encrypt("test", TEST_KEY);
    const parts = encrypted.split(":");
    expect(parts.length).toBe(3);
    // IV is 12 bytes = 24 hex chars
    expect(parts[0]).toHaveLength(24);
    // Auth tag is 16 bytes = 32 hex chars
    expect(parts[2]).toHaveLength(32);
  });

  it("throws on invalid encrypted format (wrong part count)", () => {
    expect(() => decrypt("notvalid", TEST_KEY)).toThrow(
      "Invalid encrypted format",
    );
  });

  it("throws when auth tag is wrong (tampered ciphertext)", () => {
    const encrypted = encrypt("secret", TEST_KEY);
    const parts = encrypted.split(":");
    // Flip one char in the ciphertext
    parts[1] = parts[1]
      ? parts[1].slice(0, -2) + (parts[1].slice(-2) === "ff" ? "00" : "ff")
      : "00";
    const tampered = parts.join(":");
    expect(() => decrypt(tampered, TEST_KEY)).toThrow();
  });
});

// ─── makeTokenCrypto ───────────────────────────────────────────────────────────

describe("makeTokenCrypto", () => {
  const originalKey = process.env.SHIPWRIGHT_ENCRYPTION_KEY;

  afterEach(() => {
    if (originalKey === undefined) {
      process.env.SHIPWRIGHT_ENCRYPTION_KEY = undefined;
    } else {
      process.env.SHIPWRIGHT_ENCRYPTION_KEY = originalKey;
    }
  });

  it("returns identityCrypto when SHIPWRIGHT_ENCRYPTION_KEY is not set", () => {
    process.env.SHIPWRIGHT_ENCRYPTION_KEY = undefined;
    const crypto = makeTokenCrypto();
    const token = "my-secret-token";
    expect(crypto.encrypt(token)).toBe(token);
    expect(crypto.decrypt(token)).toBe(token);
  });

  it("encrypts and decrypts when key is set", () => {
    process.env.SHIPWRIGHT_ENCRYPTION_KEY = TEST_KEY;
    const crypto = makeTokenCrypto();
    const token = "my-secret-token";
    const encrypted = crypto.encrypt(token);
    expect(encrypted).not.toBe(token);
    expect(crypto.decrypt(encrypted)).toBe(token);
  });

  it("decrypt falls back to returning plain text for legacy unencrypted tokens", () => {
    process.env.SHIPWRIGHT_ENCRYPTION_KEY = TEST_KEY;
    const crypto = makeTokenCrypto();
    const legacyToken = "plain-text-stored-before-encryption";
    // decrypt should not throw — returns the value as-is
    expect(crypto.decrypt(legacyToken)).toBe(legacyToken);
  });
});

// ─── identityCrypto ────────────────────────────────────────────────────────────

describe("identityCrypto", () => {
  it("encrypt returns input unchanged", () => {
    expect(identityCrypto.encrypt("hello")).toBe("hello");
  });

  it("decrypt returns input unchanged", () => {
    expect(identityCrypto.decrypt("hello")).toBe("hello");
  });
});
