/**
 * task-store/src/doc-store.ts
 * Ephemeral in-memory HTML document store with TTL expiry.
 *
 * Ports the Map-based TTL cache pattern from metrics/src/cache.ts, but takes an
 * injected {@link Clock} instead of calling `Date.now()` directly so TTL expiry
 * is deterministic and testable (per the repo's test-isolation rule — no real
 * wall-clock in tests).
 *
 * ⚠️ SINGLE-REPLICA CAVEAT — storage is process-local (a plain Map). A document
 * POSTed to one replica is NOT visible from another replica, and all documents
 * are lost on restart. This is acceptable for the ephemeral MVP (short-lived,
 * regenerable HTML such as one-pagers / reports shared via capability URL) but
 * requires a single replica or sticky routing. A future durable backend (e.g.
 * object storage or a DB-backed blob) would lift this constraint.
 */

import { type Clock, SystemClock } from "./clock.ts";
import { PayloadTooLargeError } from "./errors.ts";

/** Seconds a stored document lives before it expires. */
export const DEFAULT_DOC_TTL_SECONDS = 3600;

/** Max document size in bytes (UTF-8 encoded). Guards against memory abuse. */
export const DEFAULT_MAX_DOC_BYTES = 5 * 1024 * 1024; // 5 MiB

/** Result of storing a document. */
export interface StoredDoc {
  id: string;
  /** Absolute expiry as epoch milliseconds. */
  expiresAt: number;
}

/** Minimal store surface the routes depend on (injectable for tests). */
export interface DocStoreLike {
  put(html: string): StoredDoc;
  get(id: string): string | undefined;
  /** Configured time-to-live in seconds — returned to clients as `expiresIn`. */
  readonly ttlSeconds: number;
}

interface DocEntry {
  html: string;
  expiresAt: number;
}

export interface EphemeralDocStoreOptions {
  clock: Clock;
  /** Time-to-live in seconds. Non-positive / non-finite values fall back to the default. */
  ttlSeconds?: number;
  /** Max UTF-8 byte size of a stored document. */
  maxBytes?: number;
}

export class EphemeralDocStore implements DocStoreLike {
  private readonly store = new Map<string, DocEntry>();
  private readonly clock: Clock;
  private readonly maxBytes: number;
  readonly ttlSeconds: number;

  constructor(opts: EphemeralDocStoreOptions) {
    this.clock = opts.clock;
    this.ttlSeconds =
      opts.ttlSeconds !== undefined &&
      Number.isFinite(opts.ttlSeconds) &&
      opts.ttlSeconds > 0
        ? opts.ttlSeconds
        : DEFAULT_DOC_TTL_SECONDS;
    this.maxBytes = opts.maxBytes ?? DEFAULT_MAX_DOC_BYTES;
  }

  /**
   * Store an HTML document and return its id + absolute expiry.
   * Throws {@link PayloadTooLargeError} when the body exceeds `maxBytes`.
   */
  put(html: string): StoredDoc {
    const byteLength = new TextEncoder().encode(html).length;
    if (byteLength > this.maxBytes) {
      throw new PayloadTooLargeError(
        `document exceeds max size of ${this.maxBytes} bytes`,
      );
    }

    const id = crypto.randomUUID();
    const expiresAt = this.clock.now().getTime() + this.ttlSeconds * 1000;
    this.store.set(id, { html, expiresAt });
    return { id, expiresAt };
  }

  /** Return the stored HTML, or undefined on miss or expiry (lazy eviction). */
  get(id: string): string | undefined {
    const entry = this.store.get(id);
    if (!entry) return undefined;

    if (this.clock.now().getTime() > entry.expiresAt) {
      this.store.delete(id);
      return undefined;
    }

    return entry.html;
  }
}

/**
 * Resolve the document TTL from a raw env-var value, falling back to the default
 * for unset / empty / invalid (non-positive, non-numeric) input. Pure helper so
 * the env-parsing rule is unit-testable without spinning up the store.
 */
export function resolveDocTtlSeconds(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_DOC_TTL_SECONDS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_DOC_TTL_SECONDS;
}

/** Convenience production constructor — system clock + default config. */
export function createDocStore(
  opts: Partial<EphemeralDocStoreOptions> = {},
): EphemeralDocStore {
  return new EphemeralDocStore({ clock: opts.clock ?? SystemClock(), ...opts });
}
