/**
 * agent/src/crypto.ts
 * AES-256-GCM encryption for at-rest value storage.
 *
 * Encrypted format: `iv:ciphertext:authTag` — all hex-encoded, colon-separated.
 *
 * Key must be a 32-byte value expressed as a 64-character hex string
 * (e.g. SHIPWRIGHT_ENCRYPTION_KEY env var).
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12; // 96-bit IV — recommended for GCM

/**
 * Encrypts a plaintext string with AES-256-GCM.
 *
 * @param plaintext - The string to encrypt.
 * @param keyHex   - 64-char hex string representing a 32-byte key.
 * @returns Hex-encoded `iv:ciphertext:authTag`.
 */
export function encrypt(plaintext: string, keyHex: string): string {
  const key = Buffer.from(keyHex, "hex");
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);

  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);

  const authTag = cipher.getAuthTag();

  return [
    iv.toString("hex"),
    ciphertext.toString("hex"),
    authTag.toString("hex"),
  ].join(":");
}

/**
 * Decrypts a value produced by `encrypt()`.
 *
 * @param encrypted - Hex-encoded `iv:ciphertext:authTag` string.
 * @param keyHex    - 64-char hex string representing a 32-byte key.
 * @returns The original plaintext string.
 * @throws If the format is invalid, the key is wrong, or the auth tag fails.
 */
export function decrypt(encrypted: string, keyHex: string): string {
  const parts = encrypted.split(":");
  if (parts.length !== 3) {
    throw new Error(
      `Invalid encrypted format: expected "iv:ciphertext:authTag", got ${parts.length} part(s)`,
    );
  }

  const [ivHex, ciphertextHex, authTagHex] = parts as [string, string, string];
  const key = Buffer.from(keyHex, "hex");
  const iv = Buffer.from(ivHex, "hex");
  const ciphertext = Buffer.from(ciphertextHex, "hex");
  const authTag = Buffer.from(authTagHex, "hex");

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);

  return decrypted.toString("utf8");
}
