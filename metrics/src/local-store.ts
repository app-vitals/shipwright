/**
 * metrics/src/local-store.ts
 * Local SQLite event store (write side of local metrics collection).
 * Wraps bun:sqlite with an idempotent `events` table; dedups on insert_id.
 */

import { Database } from "bun:sqlite";
import { type Clock, SystemClock } from "./lib/clock.ts";

/** A row as returned from the store, with `properties` parsed from JSON. */
export interface StoredEvent {
  insertId: string | null;
  event: string;
  distinctId: string | null;
  timestamp: string;
  properties: Record<string, unknown>;
}

/** Input to insertEvent — a single normalized event. */
export interface InsertableEvent {
  insertId?: string | null;
  event: string;
  distinctId?: string | null;
  timestamp: string;
  properties: Record<string, unknown>;
}

export interface LocalEventStore {
  /** Insert a single event; duplicate (non-null) insert_id is silently ignored. */
  insertEvent(e: InsertableEvent): void;
  /**
   * Query stored events by name, optionally bounded by an inclusive timestamp
   * range. Rows are returned in timestamp ascending order.
   */
  queryByEvent(
    event: string,
    range?: { from?: string; to?: string },
  ): StoredEvent[];
  /** Close the underlying database handle (for test cleanup). */
  close(): void;
}

interface RawRow {
  insert_id: string | null;
  event: string;
  distinct_id: string | null;
  timestamp: string;
  properties: string;
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    insert_id   TEXT UNIQUE,
    event       TEXT NOT NULL,
    distinct_id TEXT,
    timestamp   TEXT NOT NULL,
    properties  TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_events_event ON events(event);
  CREATE INDEX IF NOT EXISTS idx_events_ts ON events(timestamp);
`;

function rowToStored(row: RawRow): StoredEvent {
  let properties: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(row.properties);
    if (parsed && typeof parsed === "object") {
      properties = parsed as Record<string, unknown>;
    }
  } catch {
    // Malformed stored JSON — fall back to empty object rather than throwing.
  }
  return {
    insertId: row.insert_id,
    event: row.event,
    distinctId: row.distinct_id,
    timestamp: row.timestamp,
    properties,
  };
}

/**
 * Create a local SQLite event store. The `events` table and its indexes are
 * created idempotently. Pass `path: ":memory:"` for an ephemeral test DB.
 */
export function createLocalEventStore(opts?: {
  path?: string;
  clock?: Clock;
}): LocalEventStore {
  const path = opts?.path ?? process.env.METRICS_DB_PATH ?? "state/metrics.db";
  const clock = opts?.clock ?? SystemClock();

  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(SCHEMA);

  const insertStmt = db.query(
    `INSERT OR IGNORE INTO events (insert_id, event, distinct_id, timestamp, properties)
     VALUES ($insertId, $event, $distinctId, $timestamp, $properties)`,
  );

  return {
    insertEvent(e: InsertableEvent): void {
      insertStmt.run({
        $insertId: e.insertId ?? null,
        $event: e.event,
        $distinctId: e.distinctId ?? null,
        $timestamp: e.timestamp || clock.now().toISOString(),
        $properties: JSON.stringify(e.properties ?? {}),
      });
    },

    queryByEvent(
      event: string,
      range?: { from?: string; to?: string },
    ): StoredEvent[] {
      const clauses = ["event = $event"];
      const params: Record<string, string> = { $event: event };
      if (range?.from) {
        clauses.push("timestamp >= $from");
        params.$from = range.from;
      }
      if (range?.to) {
        clauses.push("timestamp <= $to");
        params.$to = range.to;
      }
      const sql = `SELECT insert_id, event, distinct_id, timestamp, properties
                   FROM events
                   WHERE ${clauses.join(" AND ")}
                   ORDER BY timestamp ASC`;
      const rows = db.query(sql).all(params) as RawRow[];
      return rows.map(rowToStored);
    },

    close(): void {
      db.close();
    },
  };
}
