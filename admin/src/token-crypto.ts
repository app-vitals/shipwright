/**
 * agent/src/token-crypto.ts
 * Token encryption/decryption interface and factory for agent credential storage.
 *
 * Centralises all token crypto so every storage path encrypts and decrypts
 * automatically — callers work with plain text.
 *
 * Key: SHIPWRIGHT_ENCRYPTION_KEY — 64-char hex string (32 bytes for AES-256-GCM).
 * If unset: identity functions (plain text stored, no encryption).
 * If wrong format: encrypt() throws loudly at write time (better than silent failure).
 *
 * Legacy plain-text values: decrypt() catches parse errors and returns the stored
 * value as-is, so existing rows continue to work after the key is added.
 */

import { decrypt, encrypt } from "./crypto.ts";

export interface TokenCrypto {
  encrypt(token: string): string;
  decrypt(token: string): string;
}

/** Identity implementation — no encryption. Used as default in tests and when key is unset. */
export const identityCrypto: TokenCrypto = {
  encrypt: (s) => s,
  decrypt: (s) => s,
};

/**
 * Creates a TokenCrypto backed by AES-256-GCM using SHIPWRIGHT_ENCRYPTION_KEY.
 * Falls back to identity (plain text) if the env var is not set.
 */
export function makeTokenCrypto(): TokenCrypto {
  const key = process.env.SHIPWRIGHT_ENCRYPTION_KEY;
  if (!key) {
    console.warn(
      "[shipwright agent] SHIPWRIGHT_ENCRYPTION_KEY not set — tokens stored in plain text",
    );
    return identityCrypto;
  }
  return {
    encrypt: (token) => encrypt(token, key),
    decrypt: (encrypted) => {
      try {
        return decrypt(encrypted, key);
      } catch {
        // Legacy plain-text value — return as-is so existing rows keep working.
        return encrypted;
      }
    },
  };
}
