/**
 * metrics/src/providers/postgres-provider.ts
 *
 * Postgres-backed MetricsProvider. Uses the shared SqlEventStoreProvider
 * (from sql-provider.ts) for all aggregation logic; only the storage layer
 * (pg.Pool) differs from the SQLite implementation.
 *
 * DDL (auto-applied on connect):
 *   CREATE TABLE IF NOT EXISTS events (
 *     id          BIGSERIAL PRIMARY KEY,
 *     insert_id   TEXT UNIQUE,
 *     event       TEXT NOT NULL,
 *     distinct_id TEXT,
 *     timestamp   TEXT NOT NULL,
 *     properties  JSONB NOT NULL
 *   )
 *
 * Dedup: INSERT ... ON CONFLICT (insert_id) DO NOTHING
 */

import pg from "pg";
import type { Clock } from "../lib/clock.ts";
import type { InsertableEvent } from "../local-store.ts";
import type { MetricsProvider } from "../metrics-provider.ts";
import { type SqlEventStore, type SqlStoredEvent, SqlEventStoreProvider } from "./sql-provider.ts";

const { Pool } = pg;

// ─── DDL ──────────────────────────────────────────────────────────────────────

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS events (
    id          BIGSERIAL PRIMARY KEY,
    insert_id   TEXT UNIQUE,
    event       TEXT NOT NULL,
    distinct_id TEXT,
    timestamp   TEXT NOT NULL,
    properties  JSONB NOT NULL DEFAULT '{}'
  );
  CREATE INDEX IF NOT EXISTS idx_pg_events_event ON events(event);
  CREATE INDEX IF NOT EXISTS idx_pg_events_ts ON events(timestamp);
`;

// ─── PostgresEventStore — implements SqlEventStore over pg.Pool ───────────────

class PostgresEventStoreImpl implements SqlEventStore {
  constructor(private readonly pool: pg.Pool) {}

  async queryByEvent(
    event: string,
    range?: { from?: string; to?: string },
  ): Promise<SqlStoredEvent[]> {
    const clauses = ["event = $1"];
    const params: unknown[] = [event];

    if (range?.from) {
      params.push(range.from);
      clauses.push(`timestamp >= $${params.length}`);
    }
    if (range?.to) {
      params.push(range.to);
      clauses.push(`timestamp <= $${params.length}`);
    }

    const sql = `
      SELECT insert_id, event, distinct_id, timestamp, properties
      FROM events
      WHERE ${clauses.join(" AND ")}
      ORDER BY timestamp ASC
    `;

    const result = await this.pool.query(sql, params);
    return result.rows.map((row) => ({
      insertId: row.insert_id ?? null,
      event: row.event as string,
      distinctId: row.distinct_id ?? null,
      timestamp: row.timestamp as string,
      properties:
        row.properties &&
        typeof row.properties === "object" &&
        !Array.isArray(row.properties)
          ? (row.properties as Record<string, unknown>)
          : {},
    }));
  }
}

// ─── Public interface ─────────────────────────────────────────────────────────

/**
 * The object returned by createPostgresEventStore.
 * provider — MetricsProvider for read queries
 * insertEvent — write a single event (with insert_id dedup)
 * truncateForTest — truncate the events table (test helper only)
 * close — close the underlying pg.Pool
 */
export interface PostgresEventStore {
  provider: MetricsProvider;
  insertEvent(e: InsertableEvent): Promise<void>;
  /** For test isolation only — truncates the events table. */
  truncateForTest(): Promise<void>;
  close(): Promise<void>;
}

/**
 * Create a Postgres-backed event store + metrics provider.
 *
 * @param url  Postgres connection URL (postgres://user:pass@host:5432/db)
 * @param clock  Optional injectable clock (defaults to wall clock)
 */
export async function createPostgresEventStore(
  url: string,
  clock?: Clock,
): Promise<PostgresEventStore> {
  const pool = new Pool({ connectionString: url });

  // Provision schema idempotently
  await pool.query(SCHEMA);

  const pgStore = new PostgresEventStoreImpl(pool);
  const provider = new SqlEventStoreProvider(pgStore, clock);

  return {
    provider,

    async insertEvent(e: InsertableEvent): Promise<void> {
      await pool.query(
        `INSERT INTO events (insert_id, event, distinct_id, timestamp, properties)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (insert_id) DO NOTHING`,
        [
          e.insertId ?? null,
          e.event,
          e.distinctId ?? null,
          e.timestamp || new Date().toISOString(),
          JSON.stringify(e.properties ?? {}),
        ],
      );
    },

    async truncateForTest(): Promise<void> {
      await pool.query("TRUNCATE TABLE events RESTART IDENTITY");
    },

    async close(): Promise<void> {
      await pool.end();
    },
  };
}
