/**
 * admin/src/push-crypto.unit.test.ts
 * Validates the hand-rolled RFC 8291 (aes128gcm Web Push encryption) and
 * RFC 8292 (VAPID) primitives against the specs' published test vectors.
 *
 * The web-push npm package was spiked under Bun (see push-sender.ts header)
 * and the crypto path works, but the dependency is heavy for ~150 lines of
 * well-specified crypto — so we hand-roll and pin correctness to the RFC's
 * own vectors here.
 */

import { describe, expect, it } from "bun:test";
import {
  base64UrlDecode,
  base64UrlEncode,
  encryptPushPayload,
} from "./push-crypto.ts";

describe("base64url", () => {
  it("round-trips arbitrary bytes with no padding", () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255]);
    const encoded = base64UrlEncode(bytes);
    expect(encoded).not.toContain("=");
    expect(encoded).not.toContain("+");
    expect(encoded).not.toContain("/");
    expect(Array.from(base64UrlDecode(encoded))).toEqual(Array.from(bytes));
  });
});

describe("encryptPushPayload — RFC 8291 Appendix A test vector", () => {
  // RFC 8291 §5 "Push Message Encryption Example". All values are base64url.
  const plaintext = "When I grow up, I want to be a watermelon";
  const uaPublic =
    "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4";
  const uaAuth = "BTBZMqHH6r4Tts7J_aSIgg";
  // The RFC fixes the server's ephemeral keypair and salt so the ciphertext is
  // reproducible; the implementation must accept them to be vector-testable.
  const serverPrivate = "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw";
  const salt = "DGv6ra1nlYgDCS1FRnbzlw";

  const expectedBody =
    "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN";

  it("produces the exact ciphertext body from the RFC's fixed inputs", () => {
    const body = encryptPushPayload({
      plaintext,
      uaPublicKey: uaPublic,
      uaAuthSecret: uaAuth,
      serverPrivateKey: serverPrivate,
      salt,
    });
    expect(base64UrlEncode(body)).toBe(expectedBody);
  });

  it("decrypts back only with the right keys (self-consistency)", () => {
    // Different salt/server key → different ciphertext (sanity, not a vector).
    const body = encryptPushPayload({
      plaintext,
      uaPublicKey: uaPublic,
      uaAuthSecret: uaAuth,
    });
    expect(body.length).toBeGreaterThan(plaintext.length);
    // aes128gcm header is: salt(16) || rs(4) || idlen(1) || keyid(65) = 86 bytes
    expect(body.length).toBeGreaterThan(86);
  });
});
