/**
 * metrics/src/providers/sqlite-provider.ts
 * MetricsProvider backed by the local SQLite event store (LDS-1.1).
 *
 * This is now a thin wrapper: it adapts LocalEventStore (synchronous) to the
 * async SqlEventStore interface consumed by SqlEventStoreProvider, which holds
 * all aggregation logic. Both SqliteProvider and PostgresProvider therefore
 * share identical business logic — only the storage backend differs.
 */

import { type Clock, SystemClock } from "../lib/clock.ts";
import type { LocalEventStore, StoredEvent } from "../local-store.ts";
import type {
  MetricQuery,
  MetricTable,
  MetricsProvider,
} from "../metrics-provider.ts";
import {
  type SqlEventStore,
  SqlEventStoreProvider,
  type SqlStoredEvent,
} from "./sql-provider.ts";

// ─── Adapter: LocalEventStore → SqlEventStore ─────────────────────────────────

/**
 * Wraps the synchronous LocalEventStore so it satisfies the async SqlEventStore
 * interface expected by SqlEventStoreProvider.
 */
class LocalStoreAdapter implements SqlEventStore {
  constructor(private readonly store: LocalEventStore) {}

  queryByEvent(
    event: string,
    range?: { from?: string; to?: string },
  ): SqlStoredEvent[] {
    const rows: StoredEvent[] = this.store.queryByEvent(event, range);
    return rows.map((r) => ({
      insertId: r.insertId,
      event: r.event,
      distinctId: r.distinctId,
      timestamp: r.timestamp,
      properties: r.properties,
    }));
  }
}

// ─── SqliteProvider ───────────────────────────────────────────────────────────

/**
 * MetricsProvider that delegates aggregation to SqlEventStoreProvider while
 * reading events from the local SQLite store.  The public API is identical to
 * the pre-refactor implementation — existing code that constructs
 * `new SqliteProvider(store)` continues to work unchanged.
 */
export class SqliteProvider implements MetricsProvider {
  private readonly inner: SqlEventStoreProvider;

  constructor(store: LocalEventStore, clock: Clock = SystemClock()) {
    this.inner = new SqlEventStoreProvider(new LocalStoreAdapter(store), clock);
  }

  query(q: MetricQuery): Promise<MetricTable> {
    return this.inner.query(q);
  }
}
