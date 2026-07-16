import { readFile, writeFile } from "node:fs/promises";
import { type Clock, SystemClock } from "./clock.ts";

interface SessionEntry {
  sessionId: string;
  updatedAt: number; // epoch ms
}

/** On-disk format: values can be a plain string (legacy) or a SessionEntry object. */
type SessionMap = Record<string, string | SessionEntry>;

/** Default TTL: 7 days in milliseconds. Sessions older than this are pruned on load. */
const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Key is channel:thread_ts (or channel:ts for the root of a new thread). */
export function threadKey(channel: string, threadTs: string): string {
  return `${channel}:${threadTs}`;
}

/**
 * Per-file write queue: serializes async operations against the same file
 * path so overlapping load-modify-save sequences (get/set/clear/prune) apply
 * in enqueued order instead of racing. Without this, two concurrent set()
 * calls can each load() the same pre-write map, then save() over one
 * another — the second save() to land wins and the first write is silently
 * lost even though both callers believe their write succeeded.
 *
 * Keyed by file path (module-level) so every createFileSessionStore() call
 * targeting the same path shares one queue, matching the file-level
 * contention this is meant to serialize.
 */
const writeQueues = new Map<string, Promise<unknown>>();

function enqueue<T>(file: string, fn: () => Promise<T>): Promise<T> {
  const prev = writeQueues.get(file) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  // Swallow so a failed op doesn't poison the chain for subsequent callers —
  // the caller of enqueue() still observes the original rejection via `next`.
  writeQueues.set(
    file,
    next.catch(() => {}),
  );
  return next;
}

/**
 * Create a file-backed session store at a specific path.
 *
 * Module-level default store removed — callers must wire their own store
 * via createFileSessionStore(config.paths.sessions).
 *
 * @param clock - Injectable clock for deterministic testing. Defaults to SystemClock.
 */
export function createFileSessionStore(
  file: string,
  ttlMs: number = DEFAULT_TTL_MS,
  clock: Clock = SystemClock(),
): {
  get: (key: string) => Promise<string | undefined>;
  set: (key: string, id: string) => Promise<void>;
  clear: (key: string) => Promise<void>;
  prune: () => Promise<number>;
  size: () => Promise<number>;
} {
  async function load(): Promise<SessionMap> {
    try {
      return JSON.parse(await readFile(file, "utf8")) as SessionMap;
    } catch {
      return {};
    }
  }
  async function save(map: SessionMap): Promise<void> {
    await writeFile(file, JSON.stringify(map, null, 2));
  }

  /** Extract sessionId from either legacy string or SessionEntry format. */
  function resolveId(value: string | SessionEntry): string {
    return typeof value === "string" ? value : value.sessionId;
  }

  /** Check if entry is expired. Legacy string entries are always considered valid (no timestamp). */
  function isExpired(value: string | SessionEntry, now: number): boolean {
    if (typeof value === "string") return false; // legacy format, no TTL
    return now - value.updatedAt > ttlMs;
  }

  return {
    get: (key) =>
      enqueue(file, async () => {
        const map = await load();
        const entry = map[key];
        if (!entry) return undefined;
        if (isExpired(entry, clock.now().getTime())) {
          // Lazy prune: remove expired entry on access
          delete map[key];
          await save(map);
          return undefined;
        }
        return resolveId(entry);
      }),
    set: (key, id) =>
      enqueue(file, async () => {
        const map = await load();
        map[key] = { sessionId: id, updatedAt: clock.now().getTime() };
        await save(map);
      }),
    clear: (key) =>
      enqueue(file, async () => {
        const map = await load();
        delete map[key];
        await save(map);
      }),
    /** Remove all expired sessions. Returns count of pruned entries. */
    prune: () =>
      enqueue(file, async () => {
        const map = await load();
        const now = clock.now().getTime();
        let pruned = 0;
        for (const key of Object.keys(map)) {
          if (isExpired(map[key], now)) {
            delete map[key];
            pruned++;
          }
        }
        if (pruned > 0) await save(map);
        return pruned;
      }),
    size: () =>
      enqueue(file, async () => Object.keys(await load()).length),
  };
}
