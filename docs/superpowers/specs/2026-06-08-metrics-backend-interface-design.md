# Metrics Backend Interface — Pluggable Event-Store Providers

**Date:** 2026-06-08
**Status:** Superseded — the multi-provider interface was implemented but later simplified (June 2026, feat/mme-5-3). The metrics service now supports only two modes: fixtures (offline) and taskstore (live), eliminating PostHog, Postgres, and SQLite event-store backends. This spec is retained as design history.
**Prior:** the interface + PostHog & SQLite providers landed in LDS-1.3 (PR #148); Postgres provider in LDS-1.4.
**Supersedes:** the read-side approach of LDS-1.2 (`LocalSqlitePostHogClient` implementing the HogQL-string seam) — now cancelled.

---

## 1. Summary

The metrics service can already read from PostHog (live) and offline fixtures, and after LDS-1.1 it can *ingest* events into a local SQLite store via `POST /batch/`. That left us with two parallel "metric systems" (PostHog and SQLite) and no single contract uniting them. This design introduces **one backend-agnostic interface** — `MetricsProvider` — so the dashboard and API are identical regardless of which event store backs them.

**Backend matrix (committed):**

| Backend | Model | Query language | Role |
|---|---|---|---|
| **PostHog** | event store (ClickHouse) | HogQL | Hosted default; what we run today. |
| **Postgres** | event store (relational) | SQL | Self-hosted "real deployment" tier. |
| **SQLite** | event store (relational) | SQL | Local/dev default; zero-dependency (LDS-1.1). |

All three are **event stores** — they persist events-with-properties and support arbitrary aggregation — so every metric we compute (counts, averages, group-bys, cycle-time joins) is expressible in all three with identical results.

**Prometheus is explicitly out of scope.** It is a numeric time-series database: it cannot store event properties, and the bulk of these dashboards (estimation accuracy, complexity distribution, per-feature breakdowns, per-task cycle-time joins) require event-level granularity it does not retain. Prometheus is the right tool for *operational/runtime* metrics, not *event-level delivery analytics*. Forcing it behind this interface would produce misleading empty charts. If runtime metrics are ever wanted, that is a separate, additive surface — not a provider here.

---

## 2. The coupling we are removing

The current read seam is `PostHogClientLike.query(hogql: string) → HogQLResult`. The contract is a **HogQL string** plus a tabular result. PostHog executes HogQL natively; a SQL backend cannot. The cancelled LDS-1.2 worked around this by *parsing* HogQL (`detectQueryType`) to recover intent and translate to SQL — brittle, and it keeps HogQL as the lingua franca (i.e. still PostHog-shaped).

The fix is to move the seam **above** any query language: the API expresses *what metric it wants* as typed data, and each provider renders that to its own native query.

---

## 3. The interface

```ts
// metrics/src/metrics-provider.ts

// What the dashboard/API asks for — query INTENT as data, not a query string.
export type MetricQuery =
  | { kind: "summary";                    range: DateRange }
  | { kind: "summaryCycleTime";           range: DateRange }
  | { kind: "trends";                     range: DateRange; groupBy: "hour" | "day" | "week" }
  | { kind: "featuresTasks";              range: DateRange }
  | { kind: "featuresCi";                 range: DateRange }
  | { kind: "featuresReviews";            range: DateRange }
  | { kind: "queueFunnel";                range: DateRange }
  | { kind: "queueCycleStarted";          range: DateRange }
  | { kind: "queueCycleMerged";           range: DateRange }
  | { kind: "tokensTotals";               range: DateRange }
  | { kind: "tokensBySessionType";        range: DateRange }
  | { kind: "tokensByAgent";              range: DateRange }
  | { kind: "tokensByAgentBySessionType"; range: DateRange }
  | { kind: "tokensByAgentByCron";        range: DateRange }
  | { kind: "tokensByAgentByModel";       range: DateRange }
  | { kind: "tokensTrends";               range: DateRange };

// The normalized result — today's HogQLResult shape, renamed to drop the vendor name.
export type MetricTable = { columns: string[]; results: unknown[][]; types: string[] };

export interface MetricsProvider {
  query(q: MetricQuery): Promise<MetricTable>;
}
```

**No capability/degrade layer.** Every committed backend is an event store that serves every metric, so a `supports()`/capability mechanism would be dead weight (YAGNI). It is only needed if a capability-asymmetric backend (e.g. Prometheus) is ever admitted — and that decision has been made the other way. If that ever changes, the capability layer is added then, not now.

---

## 4. Components

| Unit | File | Responsibility |
|---|---|---|
| Interface + types | `metrics/src/metrics-provider.ts` | `MetricQuery`, `MetricTable`, `MetricsProvider`. |
| PostHog provider | `metrics/src/providers/posthog-provider.ts` | Maps `MetricQuery` → existing HogQL builders (`queries.ts`) → existing PostHog client. Behavior-preserving wrapper. |
| Fixture provider | `metrics/src/providers/fixture-provider.ts` | Wraps the existing offline fixtures behind the interface. |
| SQLite provider | `metrics/src/providers/sqlite-provider.ts` | Maps each `MetricQuery` → SQL aggregation over the LDS-1.1 `events` table. |
| Postgres provider | `metrics/src/providers/postgres-provider.ts` | Same SQL builders as SQLite via `SqlEventStoreProvider`; `pg.Pool` execution seam; provisions DDL idempotently. |

The SQL providers share one set of `MetricQuery → SQL` builders parameterized by dialect, with a thin executor seam (`bun:sqlite` vs a pg driver) so SQLite and Postgres cannot drift.

---

## 5. Data flow

```
api.ts handler
  → builds a typed MetricQuery  (was: a HogQL string)
  → provider.query(q) → MetricTable
  → existing row→domain transform + rate calcs (UNCHANGED)
  → JSON response
```

`createMetricsApp` takes `provider: MetricsProvider` in place of `postHogClient`. The substantial transform/rate-calc logic in `api.ts` is untouched — it already consumes the tabular shape, now called `MetricTable`.

---

## 6. Mode selection (`server.ts`)

A pure, unit-tested selector chooses the provider from env:

```
METRICS_OFFLINE === "true"                                 → FixtureProvider
else POSTHOG_PERSONAL_API_KEY && POSTHOG_PROJECT_ID set    → PostHogProvider (live)
else METRICS_DATABASE_URL is a postgres URL                → PostgresProvider   (LDS-1.4)
else                                                        → SqliteProvider     (local default)
```

This keeps every existing test that relies on `METRICS_OFFLINE=true` working, makes local SQLite the zero-config default, and leaves live PostHog exactly as today when its read-keys are present.

---

## 7. Write path

Ingest stays the PostHog-shaped `POST /batch/` from LDS-1.1. SQLite and Postgres both insert into the same `events` table (dedup on `insert_id`); the active backend owns the write. PostHog's own ingest is unchanged (the agent forwarder already POSTs to `{POSTHOG_HOST}/batch/`). Prometheus's push/scrape model is not relevant here — another reason it is not a provider.

---

## 8. Testing (lands with the code, at the correct layer)

Honors the repo isolation contract: inject doubles, **no `mock.module()`, no global overrides**.

| Area | Layer | Coverage |
|---|---|---|
| `MetricQuery → SQL` builders | `*.unit.test.ts` | per-kind column/row/type assertions over seeded events |
| Mode selector | `*.unit.test.ts` | env → provider choice, all branches |
| PostHog provider | reuse existing | existing fixtures/integration tests pass through the wrapper unchanged |
| SQLite/Postgres provider end-to-end | `*.integration.test.ts` | seed via store or `/batch/`, query each kind, assert dashboard-shaped parity |

---

## 9. Build phases

1. **LDS-1.3** ✓ — interface + types; PostHog & fixture providers (behavior-preserving); SQLite provider (13 kinds); `createMetricsApp`/`api.ts` switched to the provider seam; mode selection with SQLite default.
2. **LDS-1.4** ✓ — Postgres provider (`SqlEventStoreProvider` shared with SQLite via `sql-provider.ts`); Postgres `events` DDL provisioned idempotently; `METRICS_DATABASE_URL`/`DATABASE_URL_METRICS` mode selection; result parity with SQLite verified in integration tests.

---

## 10. Out of scope

- Prometheus / any numeric time-series backend (wrong data model for event-level analytics — see §1).
- Runtime/operational metrics (a separate concern, not this interface).
- Changing what metrics exist or how they are computed — this is a backend-portability change only.
