/**
 * admin/src/trial-expiry-sweeper.unit.test.ts
 * Unit tests for TrialExpirySweeper orchestration and its interval resolver
 * (ATE-3.1).
 *
 * Sibling of session-alert-sweeper.unit.test.ts: everything the sweeper
 * touches is injected — an in-memory AgentCronJobService double, a recording
 * line logger, and a FixedClock. No mock.module(), no global overrides, no
 * real Prisma, no Postgres — per the repo's hard test-isolation rule
 * (CLAUDE.md). The real join query and write path are covered separately in
 * trial-expiry-sweeper.integration.test.ts, which skips entirely unless
 * DATABASE_URL_ADMIN_TEST is set; this file is what runs on every `task test`.
 */

import { describe, expect, it } from "bun:test";
import { FixedClock } from "./clock.ts";
import {
  DEFAULT_TRIAL_EXPIRY_SWEEP_INTERVAL_MS,
  type TrialExpiryCronJobServiceLike,
  TrialExpirySweeper,
  resolveTrialExpirySweepIntervalMs,
} from "./trial-expiry-sweeper.ts";

const NOW = new Date("2026-06-15T00:00:00.000Z");

interface FakeRow {
  id: string;
  agentId: string;
  enabled: boolean;
}

interface SetEnabledCall {
  agentId: string;
  cronId: string;
  enabled: boolean;
}

/**
 * In-memory stand-in for AgentCronJobService. `listEnabledWithExpiredTrial`
 * returns only rows still flagged enabled, so a second tick naturally sees
 * less work — the same shape the real join query has, which is what makes the
 * sweeper idempotent without any dedup state.
 */
function fakeCronJobService(
  seed: FakeRow[] = [],
  opts: {
    failListing?: boolean;
    failSetEnabledFor?: (cronId: string) => boolean;
  } = {},
): {
  service: TrialExpiryCronJobServiceLike;
  rows: FakeRow[];
  listedNow: Date[];
  calls: SetEnabledCall[];
} {
  const rows = seed.map((r) => ({ ...r }));
  const listedNow: Date[] = [];
  const calls: SetEnabledCall[] = [];

  const service: TrialExpiryCronJobServiceLike = {
    listEnabledWithExpiredTrial: async (now: Date) => {
      listedNow.push(now);
      if (opts.failListing) throw new Error("db down");
      return rows
        .filter((r) => r.enabled)
        .map((r) => ({ id: r.id, agentId: r.agentId }));
    },
    setEnabled: async (agentId: string, cronId: string, enabled: boolean) => {
      calls.push({ agentId, cronId, enabled });
      if (opts.failSetEnabledFor?.(cronId)) throw new Error("boom");
      const row = rows.find((r) => r.id === cronId);
      if (!row) throw new Error(`no such cron ${cronId}`);
      row.enabled = enabled;
      return row;
    },
  };

  return { service, rows, listedNow, calls };
}

function sweeperFor(
  service: TrialExpiryCronJobServiceLike,
  lines: string[] = [],
): TrialExpirySweeper {
  return new TrialExpirySweeper({
    agentCronJobService: service,
    clock: FixedClock(NOW),
    log: (line) => lines.push(line),
  });
}

// ─── resolveTrialExpirySweepIntervalMs ──────────────────────────────────────

// The pure env rule behind the trial-expiry sweeper's setInterval cadence in
// startServer(). Tested without touching process.env.
describe("resolveTrialExpirySweepIntervalMs", () => {
  it("defaults to 60s when unset", () => {
    expect(resolveTrialExpirySweepIntervalMs({})).toBe(
      DEFAULT_TRIAL_EXPIRY_SWEEP_INTERVAL_MS,
    );
    expect(DEFAULT_TRIAL_EXPIRY_SWEEP_INTERVAL_MS).toBe(60_000);
  });

  it("uses an explicit positive override", () => {
    expect(
      resolveTrialExpirySweepIntervalMs({
        SHIPWRIGHT_ADMIN_TRIAL_EXPIRY_SWEEP_INTERVAL_MS: "5000",
      }),
    ).toBe(5000);
  });

  it("trims surrounding whitespace around a valid value", () => {
    expect(
      resolveTrialExpirySweepIntervalMs({
        SHIPWRIGHT_ADMIN_TRIAL_EXPIRY_SWEEP_INTERVAL_MS: " 1500 ",
      }),
    ).toBe(1500);
  });

  it("falls back to the default for blank, non-numeric, zero, or negative values", () => {
    // A 0/NaN interval would make setInterval spin; a negative one is
    // nonsense. Both must resolve to the default rather than reach setInterval.
    for (const raw of ["", "   ", "soon", "NaN", "0", "-1", "-5000"]) {
      expect(
        resolveTrialExpirySweepIntervalMs({
          SHIPWRIGHT_ADMIN_TRIAL_EXPIRY_SWEEP_INTERVAL_MS: raw,
        }),
      ).toBe(DEFAULT_TRIAL_EXPIRY_SWEEP_INTERVAL_MS);
    }
  });

  it("falls back to the default for Infinity", () => {
    expect(
      resolveTrialExpirySweepIntervalMs({
        SHIPWRIGHT_ADMIN_TRIAL_EXPIRY_SWEEP_INTERVAL_MS: "Infinity",
      }),
    ).toBe(DEFAULT_TRIAL_EXPIRY_SWEEP_INTERVAL_MS);
  });

  it("ignores unrelated env vars", () => {
    expect(
      resolveTrialExpirySweepIntervalMs({
        SHIPWRIGHT_ADMIN_SESSION_ALERT_INTERVAL_MS: "1234",
      }),
    ).toBe(DEFAULT_TRIAL_EXPIRY_SWEEP_INTERVAL_MS);
  });
});

// ─── tick(): the happy path ─────────────────────────────────────────────────

describe("TrialExpirySweeper.tick — disabling expired-trial crons", () => {
  it("disables every listed row and counts them", async () => {
    const { service, rows, calls } = fakeCronJobService([
      { id: "cron_a", agentId: "agt_1", enabled: true },
      { id: "cron_b", agentId: "agt_1", enabled: true },
      { id: "cron_c", agentId: "agt_2", enabled: true },
    ]);

    const result = await sweeperFor(service).tick();

    expect(result).toEqual({ disabled: 3 });
    expect(rows.every((r) => r.enabled === false)).toBe(true);
    expect(calls).toEqual([
      { agentId: "agt_1", cronId: "cron_a", enabled: false },
      { agentId: "agt_1", cronId: "cron_b", enabled: false },
      { agentId: "agt_2", cronId: "cron_c", enabled: false },
    ]);
  });

  it("passes the injected clock's time through to the listing query", async () => {
    const { service, listedNow } = fakeCronJobService([]);

    await sweeperFor(service).tick();

    expect(listedNow).toHaveLength(1);
    expect(listedNow[0]?.toISOString()).toBe(NOW.toISOString());
  });

  it("no-ops cleanly when nothing is listed", async () => {
    const lines: string[] = [];
    const { service, calls } = fakeCronJobService([]);

    const result = await sweeperFor(service, lines).tick();

    expect(result).toEqual({ disabled: 0 });
    expect(calls).toHaveLength(0);
    // Nothing disabled → no log line (an idle sweeper must stay quiet; it
    // ticks once a minute forever).
    expect(lines).toHaveLength(0);
  });

  it("logs a single count line only when it disabled something", async () => {
    const lines: string[] = [];
    const { service } = fakeCronJobService([
      { id: "cron_a", agentId: "agt_1", enabled: true },
      { id: "cron_b", agentId: "agt_1", enabled: true },
    ]);

    const sweeper = sweeperFor(service, lines);
    await sweeper.tick();
    expect(lines).toEqual(["[trial-expiry-sweeper] disabled=2"]);

    // Second tick has nothing left → no further lines.
    await sweeper.tick();
    expect(lines).toHaveLength(1);
  });
});

// ─── Idempotency ────────────────────────────────────────────────────────────

// The sweeper carries no "have I already swept this agent" state (unlike
// session-alert-sweeper's SessionAlertState dedup): once its crons are
// disabled the listing simply stops returning them.
describe("TrialExpirySweeper.tick — idempotency", () => {
  it("finds nothing left to do on a second tick", async () => {
    const { service, calls } = fakeCronJobService([
      { id: "cron_a", agentId: "agt_1", enabled: true },
    ]);
    const sweeper = sweeperFor(service);

    expect(await sweeper.tick()).toEqual({ disabled: 1 });
    expect(await sweeper.tick()).toEqual({ disabled: 0 });
    expect(await sweeper.tick()).toEqual({ disabled: 0 });
    expect(calls).toHaveLength(1);
  });

  it("never re-counts an already-disabled row the listing excludes", async () => {
    const { service, calls } = fakeCronJobService([
      { id: "cron_on", agentId: "agt_1", enabled: true },
      { id: "cron_off", agentId: "agt_1", enabled: false },
    ]);

    const result = await sweeperFor(service).tick();

    expect(result).toEqual({ disabled: 1 });
    expect(calls.map((c) => c.cronId)).toEqual(["cron_on"]);
  });

  it("is safe under overlapping ticks — no re-entrancy guard needed", async () => {
    // Two concurrent sweeps both disabling the same row is harmless because
    // setEnabled is idempotent; the sweeper deliberately has no in-flight
    // guard (unlike the session sweeper, whose pushes have side effects).
    const { service, rows } = fakeCronJobService([
      { id: "cron_a", agentId: "agt_1", enabled: true },
    ]);
    const sweeper = sweeperFor(service);

    const [first, second] = await Promise.all([sweeper.tick(), sweeper.tick()]);

    expect(first.disabled + second.disabled).toBeGreaterThanOrEqual(1);
    expect(rows[0]?.enabled).toBe(false);
  });
});

// ─── Resilience: one bad row never aborts the sweep ─────────────────────────

describe("TrialExpirySweeper.tick — per-row resilience", () => {
  it("keeps sweeping after one row's setEnabled throws", async () => {
    const { service, rows, calls } = fakeCronJobService(
      [
        { id: "cron_bad", agentId: "agt_1", enabled: true },
        { id: "cron_good", agentId: "agt_1", enabled: true },
        { id: "cron_also_good", agentId: "agt_2", enabled: true },
      ],
      { failSetEnabledFor: (cronId) => cronId === "cron_bad" },
    );

    const result = await sweeperFor(service).tick();

    // The failure is counted out, not thrown out: the two healthy rows are
    // still disabled and every row was attempted.
    expect(result).toEqual({ disabled: 2 });
    expect(calls).toHaveLength(3);
    expect(rows.find((r) => r.id === "cron_bad")?.enabled).toBe(true);
    expect(rows.find((r) => r.id === "cron_good")?.enabled).toBe(false);
    expect(rows.find((r) => r.id === "cron_also_good")?.enabled).toBe(false);
  });

  it("retries the failed row on the next tick", async () => {
    // Because the failed row stays enabled, the next listing returns it again
    // — a transient write failure self-heals rather than leaking a cron that
    // outlives the trial.
    let fail = true;
    const { service, rows } = fakeCronJobService(
      [
        { id: "cron_flaky", agentId: "agt_1", enabled: true },
        { id: "cron_good", agentId: "agt_1", enabled: true },
      ],
      { failSetEnabledFor: (cronId) => fail && cronId === "cron_flaky" },
    );
    const sweeper = sweeperFor(service);

    expect(await sweeper.tick()).toEqual({ disabled: 1 });

    fail = false;
    expect(await sweeper.tick()).toEqual({ disabled: 1 });
    expect(rows.every((r) => r.enabled === false)).toBe(true);
  });

  it("returns disabled=0 (and never throws) when the listing fails", async () => {
    const lines: string[] = [];
    const { service, calls } = fakeCronJobService(
      [{ id: "cron_a", agentId: "agt_1", enabled: true }],
      { failListing: true },
    );

    // Fail-open: a DB blip must not crash the setInterval callback in main.ts.
    const result = await sweeperFor(service, lines).tick();

    expect(result).toEqual({ disabled: 0 });
    expect(calls).toHaveLength(0);
    expect(lines).toHaveLength(0);
  });

  it("recovers on the next tick after a listing failure", async () => {
    const rows: FakeRow[] = [{ id: "cron_a", agentId: "agt_1", enabled: true }];
    let broken = true;
    const service: TrialExpiryCronJobServiceLike = {
      listEnabledWithExpiredTrial: async () => {
        if (broken) throw new Error("db down");
        return rows
          .filter((r) => r.enabled)
          .map((r) => ({ id: r.id, agentId: r.agentId }));
      },
      setEnabled: async (_agentId, cronId, enabled) => {
        const row = rows.find((r) => r.id === cronId);
        if (row) row.enabled = enabled;
        return row;
      },
    };
    const sweeper = sweeperFor(service);

    expect(await sweeper.tick()).toEqual({ disabled: 0 });

    broken = false;
    expect(await sweeper.tick()).toEqual({ disabled: 1 });
    expect(rows[0]?.enabled).toBe(false);
  });
});

// ─── Deliberate non-behavior ────────────────────────────────────────────────

// A trial ending must never destroy the workspace — the sweeper only flips
// AgentCronJob.enabled. The narrow injected interface is the guard rail: if
// deprovisioning were ever added, this test's double would have to grow a
// method to satisfy it.
describe("TrialExpirySweeper.tick — scope", () => {
  it("only ever calls setEnabled(..., false) — no other service method", async () => {
    const seen: string[] = [];
    const base = fakeCronJobService([
      { id: "cron_a", agentId: "agt_1", enabled: true },
      { id: "cron_b", agentId: "agt_2", enabled: true },
    ]);
    // A double that also fails loudly on anything deprovision-shaped: if the
    // sweeper ever grew a deleteAgentFully()-style call, it would land here.
    const recording: TrialExpiryCronJobServiceLike &
      Record<string, unknown> = {
      listEnabledWithExpiredTrial: (now: Date) => {
        seen.push("listEnabledWithExpiredTrial");
        return base.service.listEnabledWithExpiredTrial(now);
      },
      setEnabled: (agentId: string, cronId: string, enabled: boolean) => {
        seen.push("setEnabled");
        return base.service.setEnabled(agentId, cronId, enabled);
      },
      deleteAgentFully: () => {
        throw new Error("sweeper must never deprovision an agent");
      },
    };

    await sweeperFor(recording).tick();

    expect([...new Set(seen)].sort()).toEqual([
      "listEnabledWithExpiredTrial",
      "setEnabled",
    ]);
    expect(base.calls.every((c) => c.enabled === false)).toBe(true);
    expect(base.rows.every((r) => r.enabled === false)).toBe(true);
  });
});
