/**
 * admin/src/push-sender.unit.test.ts
 * Unit tests for PushSender — VAPID gating, injected fetchImpl (no global
 * override, AC 3), and immediate pruning on 404/410 (AC 4).
 */

import { describe, expect, it } from "bun:test";
import { PushSender, isPushEnabled } from "./push-sender.ts";

// A minimal valid-shaped subscription. Keys are the RFC 8291 vector's UA keys
// so the encryption path exercises real values.
const sub = {
  endpoint: "https://push.example.com/sub/abc",
  p256dh:
    "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  auth: "BTBZMqHH6r4Tts7J_aSIgg",
};

// A real, matched VAPID keypair (P-256). The public key is the uncompressed
// point (0x04 || x || y); the private key is the raw scalar `d`.
const vapid = {
  publicKey:
    "BAl-hYOXgpZwx-qqRoAapu5iSeHrlcJdy89wjv1NyctfsYSyGKCVO97vvlOVR4h61MROU8CZLAxzQEj8vIFsTaI",
  privateKey: "Sl9AT1gAl_yFgHlTToZkarQRWNYHVTAviDf5osjxXN0",
  subject: "mailto:ops@example.com",
};

describe("isPushEnabled", () => {
  it("is true only when public + private + subject are all set", () => {
    expect(isPushEnabled(vapid)).toBe(true);
  });

  it("is false when any of the three is missing", () => {
    expect(isPushEnabled({ ...vapid, publicKey: "" })).toBe(false);
    expect(isPushEnabled({ ...vapid, privateKey: "" })).toBe(false);
    expect(isPushEnabled({ ...vapid, subject: "" })).toBe(false);
    expect(isPushEnabled(undefined)).toBe(false);
  });
});

describe("PushSender.send — injected fetchImpl (AC 3)", () => {
  it("POSTs to the subscription endpoint using the injected fetch, never a global", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fakeFetch = async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(null, { status: 201 });
    };
    const sender = new PushSender(vapid, fakeFetch as unknown as typeof fetch);
    const result = await sender.send(sub, "hello world");
    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe(sub.endpoint);
    expect(calls[0].init.method).toBe("POST");
    // VAPID auth header + aes128gcm content encoding are mandatory.
    const headers = new Headers(calls[0].init.headers);
    expect(headers.get("authorization") ?? "").toContain("vapid");
    expect(headers.get("content-encoding")).toBe("aes128gcm");
    expect(result.pruned).toBe(false);
    expect(result.ok).toBe(true);
  });
});

describe("PushSender.send — pruning on 404/410 (AC 4)", () => {
  it("flags the subscription for pruning on 410 Gone", async () => {
    const fakeFetch = async () => new Response(null, { status: 410 });
    const sender = new PushSender(vapid, fakeFetch as unknown as typeof fetch);
    const result = await sender.send(sub, "x");
    expect(result.pruned).toBe(true);
    expect(result.ok).toBe(false);
  });

  it("flags the subscription for pruning on 404 Not Found", async () => {
    const fakeFetch = async () => new Response(null, { status: 404 });
    const sender = new PushSender(vapid, fakeFetch as unknown as typeof fetch);
    const result = await sender.send(sub, "x");
    expect(result.pruned).toBe(true);
  });

  it("does NOT prune on a transient 500 — just reports failure", async () => {
    const fakeFetch = async () => new Response(null, { status: 500 });
    const sender = new PushSender(vapid, fakeFetch as unknown as typeof fetch);
    const result = await sender.send(sub, "x");
    expect(result.pruned).toBe(false);
    expect(result.ok).toBe(false);
  });
});

describe("PushSender.sendToMany — one failure never blocks the others", () => {
  it("delivers to every subscription and collects prune targets", async () => {
    const seen: string[] = [];
    const fakeFetch = async (url: string) => {
      seen.push(url);
      // The middle one is gone; the others succeed.
      if (url.endsWith("/gone")) return new Response(null, { status: 410 });
      if (url.endsWith("/boom")) throw new Error("network down");
      return new Response(null, { status: 201 });
    };
    const sender = new PushSender(vapid, fakeFetch as unknown as typeof fetch);
    const subs = [
      { ...sub, endpoint: "https://push.example.com/ok" },
      { ...sub, endpoint: "https://push.example.com/gone" },
      { ...sub, endpoint: "https://push.example.com/boom" },
    ];
    const { prunedEndpoints } = await sender.sendToMany(subs, "payload");
    expect(seen.length).toBe(3); // all attempted despite the failures
    expect(prunedEndpoints).toEqual(["https://push.example.com/gone"]);
  });
});
