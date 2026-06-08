import { readFileSync, writeFileSync } from "node:fs";

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
 * Create a file-backed session store at a specific path.
 *
 * Module-level default store removed — callers must wire their own store
 * via createFileSessionStore(config.paths.sessions).
 */
export function createFileSessionStore(
  file: string,
  ttlMs: number = DEFAULT_TTL_MS,
): {
  get: (key: string) => string | undefined;
  set: (key: string, id: string) => void;
  clear: (key: string) => void;
  prune: () => number;
  size: () => number;
} {
  function load(): SessionMap {
    try {
      return JSON.parse(readFileSync(file, "utf8")) as SessionMap;
    } catch {
      return {};
    }
  }
  function save(map: SessionMap): void {
    writeFileSync(file, JSON.stringify(map, null, 2));
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
    get: (key) => {
      const map = load();
      const entry = map[key];
      if (!entry) return undefined;
      if (isExpired(entry, Date.now())) {
        // Lazy prune: remove expired entry on access
        delete map[key];
        save(map);
        return undefined;
      }
      return resolveId(entry);
    },
    set: (key, id) => {
      const map = load();
      map[key] = { sessionId: id, updatedAt: Date.now() };
      save(map);
    },
    clear: (key) => {
      const map = load();
      delete map[key];
      save(map);
    },
    /** Remove all expired sessions. Returns count of pruned entries. */
    prune: () => {
      const map = load();
      const now = Date.now();
      let pruned = 0;
      for (const key of Object.keys(map)) {
        if (isExpired(map[key], now)) {
          delete map[key];
          pruned++;
        }
      }
      if (pruned > 0) save(map);
      return pruned;
    },
    size: () => Object.keys(load()).length,
  };
}
