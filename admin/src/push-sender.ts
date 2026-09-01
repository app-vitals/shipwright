/**
 * admin/src/push-sender.ts
 * PushSender — sends an encrypted Web Push message to one or many
 * subscriptions. Constructed with an injected `fetchImpl` (acceptance
 * criterion 3): NO global.fetch override, so sibling test suites in Bun's
 * shared process stay clean.
 *
 * Depends on the hand-rolled RFC 8291 encryption (push-crypto.ts) and signs the
 * VAPID JWT (RFC 8292) here with ES256 via node:crypto. See push-crypto.ts's
 * header for why we hand-roll rather than depend on the `web-push` npm package.
 *
 * Delivery contract:
 *   - 201/2xx  → delivered (ok=true).
 *   - 404/410  → the subscription is gone; prune it IMMEDIATELY (AC 4).
 *   - anything else / network throw → failure, but NOT pruned (transient).
 * A failure for one subscription never blocks delivery to the others.
 */

import { createPrivateKey, createSign } from "node:crypto";
import {
  base64UrlDecode,
  base64UrlEncode,
  encryptPushPayload,
} from "./push-crypto.ts";

export interface VapidConfig {
  publicKey: string;
  privateKey: string;
  subject: string; // "mailto:..." or an https URL
}

export interface PushSubscriptionLike {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export interface SendResult {
  ok: boolean;
  /** True when the subscription should be pruned (404/410). */
  pruned: boolean;
  status?: number;
}

/**
 * Push is enabled only when public + private + subject are ALL set. A partial
 * config must NOT half-enable the feature — routes 503 and the UI renders no
 * toggle so local-first still holds.
 */
export function isPushEnabled(v: VapidConfig | undefined): v is VapidConfig {
  return Boolean(v?.publicKey && v.privateKey && v.subject);
}

const ONE_HOUR = 60 * 60;
const TTL_SECONDS = 4 * ONE_HOUR;

export class PushSender {
  constructor(
    private readonly vapid: VapidConfig,
    private readonly fetchImpl: typeof fetch,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Builds the `Authorization: vapid ...` header value for an endpoint origin. */
  private buildVapidAuthHeader(endpoint: string): string {
    const audience = new URL(endpoint).origin;
    const header = { typ: "JWT", alg: "ES256" };
    const nowSec = Math.floor(this.now() / 1000);
    const claims = {
      aud: audience,
      exp: nowSec + TTL_SECONDS,
      sub: this.vapid.subject,
    };
    const signingInput = `${base64UrlEncode(
      Buffer.from(JSON.stringify(header)),
    )}.${base64UrlEncode(Buffer.from(JSON.stringify(claims)))}`;

    // ES256: ECDSA over P-256 with SHA-256, raw (ieee-p1363) 64-byte signature.
    const key = privateKeyFromVapid(
      this.vapid.privateKey,
      this.vapid.publicKey,
    );
    const signature = createSign("SHA256")
      .update(signingInput)
      .sign({ key, dsaEncoding: "ieee-p1363" });
    const jwt = `${signingInput}.${base64UrlEncode(new Uint8Array(signature))}`;
    return `vapid t=${jwt}, k=${this.vapid.publicKey}`;
  }

  /** Sends one payload to one subscription. Never throws — returns a SendResult. */
  async send(sub: PushSubscriptionLike, payload: string): Promise<SendResult> {
    let body: Uint8Array;
    try {
      body = encryptPushPayload({
        plaintext: payload,
        uaPublicKey: sub.p256dh,
        uaAuthSecret: sub.auth,
      });
    } catch {
      // A malformed subscription key can't be encrypted for — treat as prune.
      return { ok: false, pruned: true };
    }

    try {
      const res = await this.fetchImpl(sub.endpoint, {
        method: "POST",
        headers: {
          authorization: this.buildVapidAuthHeader(sub.endpoint),
          "content-encoding": "aes128gcm",
          "content-type": "application/octet-stream",
          ttl: String(TTL_SECONDS),
        },
        // A Uint8Array is a valid fetch body at runtime; the DOM lib's
        // BodyInit type omits it, so assert through the shared BufferSource.
        body: body as unknown as BodyInit,
      });
      const pruned = res.status === 404 || res.status === 410;
      return { ok: res.ok, pruned, status: res.status };
    } catch {
      // Network error — transient, don't prune.
      return { ok: false, pruned: false };
    }
  }

  /**
   * Fans a payload out to many subscriptions. One failure never blocks the
   * rest (Promise.allSettled). Returns the endpoints that must be pruned.
   */
  async sendToMany(
    subs: PushSubscriptionLike[],
    payload: string,
  ): Promise<{ prunedEndpoints: string[]; delivered: number }> {
    const results = await Promise.allSettled(
      subs.map((s) => this.send(s, payload)),
    );
    const prunedEndpoints: string[] = [];
    let delivered = 0;
    results.forEach((r, i) => {
      if (r.status === "fulfilled") {
        if (r.value.ok) delivered += 1;
        if (r.value.pruned) prunedEndpoints.push(subs[i].endpoint);
      }
    });
    return { prunedEndpoints, delivered };
  }
}

// ─── VAPID key import ────────────────────────────────────────────────────────

// Import the VAPID keypair from its base64url raw forms via a JWK — the most
// portable path across node:crypto implementations (avoids hand-rolling SEC1/
// PKCS#8 DER, which Bun's OpenSSL rejects). The public key is the uncompressed
// P-256 point (0x04 || x(32) || y(32)); the private key is the raw scalar `d`.
function privateKeyFromVapid(
  base64urlPrivate: string,
  base64urlPublic: string,
) {
  const pub = base64UrlDecode(base64urlPublic);
  if (pub.length !== 65 || pub[0] !== 0x04) {
    throw new Error("VAPID public key must be an uncompressed P-256 point");
  }
  const x = base64UrlEncode(pub.slice(1, 33));
  const y = base64UrlEncode(pub.slice(33, 65));
  const d = base64UrlEncode(base64UrlDecode(base64urlPrivate));
  return createPrivateKey({
    key: { kty: "EC", crv: "P-256", x, y, d },
    format: "jwk",
  });
}
