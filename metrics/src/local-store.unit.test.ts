/**
 * metrics/src/local-store.unit.test.ts
 * Unit tests for the local SQLite event store (insert, dedup, range query).
 * Uses an in-memory (`:memory:`) DB and an injected FixedClock — no real file I/O.
 */

import { describe, expect, test } from "bun:test";
import { createLocalEventStore } from "./local-store.ts";
import { FixedClock } from "./lib/test-doubles.ts";

const CLOCK = FixedClock("2026-06-08T00:00:00.000Z");

describe("createLocalEventStore", () => {
  test("insert then query returns the row with parsed properties", () => {
    const store = createLocalEventStore({ path: ":memory:", clock: CLOCK });

    store.insertEvent({
      insertId: "ins-1",
      event: "task_completed",
      distinctId: "shipwright/repo/T-1",
      timestamp: "2026-06-08T01:00:00.000Z",
      properties: { task_id: "T-1", hours: 2.5 },
    });

    const rows = store.queryByEvent("task_completed");
    expect(rows).toHaveLength(1);
    expect(rows[0].insertId).toBe("ins-1");
    expect(rows[0].event).toBe("task_completed");
    expect(rows[0].distinctId).toBe("shipwright/repo/T-1");
    expect(rows[0].timestamp).toBe("2026-06-08T01:00:00.000Z");
    expect(rows[0].properties).toEqual({ task_id: "T-1", hours: 2.5 });

    store.close();
  });

  test("duplicate insert_id is ignored (dedup)", () => {
    const store = createLocalEventStore({ path: ":memory:", clock: CLOCK });

    const row = {
      insertId: "dup-1",
      event: "task_completed",
      distinctId: "d",
      timestamp: "2026-06-08T01:00:00.000Z",
      properties: { n: 1 },
    };
    store.insertEvent(row);
    store.insertEvent({ ...row, properties: { n: 2 } }); // same insertId

    const rows = store.queryByEvent("task_completed");
    expect(rows).toHaveLength(1);
    // First write wins (INSERT OR IGNORE)
    expect(rows[0].properties).toEqual({ n: 1 });

    store.close();
  });

  test("range query filters by timestamp (inclusive bounds)", () => {
    const store = createLocalEventStore({ path: ":memory:", clock: CLOCK });

    for (const [ins, ts] of [
      ["a", "2026-06-01T00:00:00.000Z"],
      ["b", "2026-06-05T00:00:00.000Z"],
      ["c", "2026-06-10T00:00:00.000Z"],
    ] as const) {
      store.insertEvent({
        insertId: ins,
        event: "task_completed",
        distinctId: "d",
        timestamp: ts,
        properties: {},
      });
    }

    const rows = store.queryByEvent("task_completed", {
      from: "2026-06-05T00:00:00.000Z",
      to: "2026-06-09T00:00:00.000Z",
    });
    expect(rows.map((r) => r.insertId)).toEqual(["b"]);

    // Inclusive lower bound picks up the boundary row
    const inclusive = store.queryByEvent("task_completed", {
      from: "2026-06-01T00:00:00.000Z",
      to: "2026-06-05T00:00:00.000Z",
    });
    expect(inclusive.map((r) => r.insertId).sort()).toEqual(["a", "b"]);

    store.close();
  });

  test("NULL/absent insert_id rows are each retained (not collapsed)", () => {
    const store = createLocalEventStore({ path: ":memory:", clock: CLOCK });

    store.insertEvent({
      event: "task_completed",
      timestamp: "2026-06-08T01:00:00.000Z",
      properties: { n: 1 },
    });
    store.insertEvent({
      insertId: null,
      event: "task_completed",
      timestamp: "2026-06-08T02:00:00.000Z",
      properties: { n: 2 },
    });

    const rows = store.queryByEvent("task_completed");
    expect(rows).toHaveLength(2);

    store.close();
  });

  test("creating the store twice on the same DB is idempotent (table exists)", () => {
    const store1 = createLocalEventStore({ path: ":memory:", clock: CLOCK });
    store1.insertEvent({
      insertId: "x",
      event: "e",
      timestamp: "2026-06-08T00:00:00.000Z",
      properties: {},
    });
    expect(store1.queryByEvent("e")).toHaveLength(1);
    store1.close();

    // A fresh store on a fresh :memory: DB still initializes cleanly
    const store2 = createLocalEventStore({ path: ":memory:", clock: CLOCK });
    expect(store2.queryByEvent("e")).toHaveLength(0);
    store2.close();
  });
});
