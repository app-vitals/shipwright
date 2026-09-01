/**
 * admin/src/push-crypto.ts
 * Hand-rolled RFC 8291 (Message Encryption for Web Push, "aes128gcm") and the
 * primitives RFC 8292 (VAPID) needs, implemented on Bun's node:crypto.
 *
 * WHY HAND-ROLLED (not the `web-push` npm package): a ~20-line spike confirmed
 * Bun's node:crypto supports the entire path — ECDH P-256, HKDF-SHA256,
 * AES-128-GCM, and ES256 (ECDSA P-256, `dsaEncoding: "ieee-p1363"` → the raw
 * 64-byte JWT signature). The web-push dependency drags in a large tree and has
 * historically been finicky under non-Node runtimes for ~150 lines of
 * well-specified crypto. Correctness here is pinned to the RFC 8291 Appendix A
 * test vector in push-crypto.unit.test.ts, so drift fails CI.
 *
 * Pure module: no Hono, no Prisma, no network. The actual HTTP send lives in
 * push-sender.ts.
 */

import { createCipheriv, createECDH, hkdfSync, randomBytes } from "node:crypto";

// ─── base64url ────────────────────────────────────────────────────────────────

export function base64UrlEncode(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

export function base64UrlDecode(str: string): Uint8Array {
  return new Uint8Array(Buffer.from(str, "base64url"));
}

// ─── RFC 8291 aes128gcm encryption ───────────────────────────────────────────

export interface EncryptPushPayloadArgs {
  /** UTF-8 plaintext to encrypt. */
  plaintext: string;
  /** UA public key (base64url, uncompressed P-256 point) — the `p256dh` value. */
  uaPublicKey: string;
  /** UA auth secret (base64url, 16 bytes) — the `auth` value. */
  uaAuthSecret: string;
  /**
   * Optional fixed server ephemeral private key (base64url raw scalar) — used
   * ONLY to reproduce the RFC's test vector. Omitted in production, where a
   * fresh ephemeral keypair is generated per message.
   */
  serverPrivateKey?: string;
  /** Optional fixed 16-byte salt (base64url) — used ONLY for the test vector. */
  salt?: string;
}

const HKDF_HASH = "sha256";

function hkdf(
  salt: Uint8Array,
  ikm: Uint8Array,
  info: Uint8Array,
  length: number,
): Uint8Array {
  return new Uint8Array(hkdfSync(HKDF_HASH, ikm, salt, info, length));
}

function infoLabel(label: string, ...parts: Uint8Array[]): Uint8Array {
  const chunks = [Buffer.from(`Content-Encoding: ${label}\0`, "ascii")];
  for (const p of parts) chunks.push(Buffer.from(p));
  return new Uint8Array(Buffer.concat(chunks));
}

/**
 * Encrypts `plaintext` per RFC 8291 §3-4 producing the full aes128gcm body:
 *   header = salt(16) || rs(4, big-endian) || idlen(1) || serverPublicKey(65)
 *   body   = header || AES-128-GCM(cek, nonce, plaintext || 0x02)
 *
 * The 0x02 delimiter marks the last (and here only) record.
 */
export function encryptPushPayload(args: EncryptPushPayloadArgs): Uint8Array {
  const uaPublic = base64UrlDecode(args.uaPublicKey);
  const authSecret = base64UrlDecode(args.uaAuthSecret);

  const ecdh = createECDH("prime256v1");
  if (args.serverPrivateKey) {
    ecdh.setPrivateKey(Buffer.from(base64UrlDecode(args.serverPrivateKey)));
  } else {
    ecdh.generateKeys();
  }
  const serverPublic = new Uint8Array(ecdh.getPublicKey()); // 65 bytes, uncompressed
  const sharedSecret = new Uint8Array(
    ecdh.computeSecret(Buffer.from(uaPublic)),
  );

  const salt = args.salt
    ? base64UrlDecode(args.salt)
    : new Uint8Array(randomBytes(16));

  // Step 1: derive the pseudo-random key (PRK) from the ECDH secret, keyed by
  // the auth secret. info = "WebPush: info\0" || ua_public || server_public.
  const prkInfo = new Uint8Array(
    Buffer.concat([
      Buffer.from("WebPush: info\0", "ascii"),
      Buffer.from(uaPublic),
      Buffer.from(serverPublic),
    ]),
  );
  const prk = hkdf(authSecret, sharedSecret, prkInfo, 32);

  // Step 2: derive the content encryption key and nonce from the PRK, salted.
  const cek = hkdf(salt, prk, infoLabel("aes128gcm"), 16);
  const nonce = hkdf(salt, prk, infoLabel("nonce"), 12);

  // Step 3: AES-128-GCM over (plaintext || 0x02 delimiter).
  const cipher = createCipheriv(
    "aes-128-gcm",
    Buffer.from(cek),
    Buffer.from(nonce),
  );
  const padded = Buffer.concat([
    Buffer.from(args.plaintext, "utf-8"),
    Buffer.from([0x02]),
  ]);
  const encrypted = Buffer.concat([
    cipher.update(padded),
    cipher.final(),
    cipher.getAuthTag(),
  ]);

  // Step 4: assemble the aes128gcm content-coding header + ciphertext.
  const rs = Buffer.alloc(4);
  rs.writeUInt32BE(4096, 0); // record size
  const idlen = Buffer.from([serverPublic.length]); // 65
  const body = Buffer.concat([
    Buffer.from(salt),
    rs,
    idlen,
    Buffer.from(serverPublic),
    encrypted,
  ]);
  return new Uint8Array(body);
}
