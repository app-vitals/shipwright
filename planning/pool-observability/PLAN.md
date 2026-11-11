# Plan: pool-observability

Source: Sentry VITALS-OS-5T ("Unable to start a transaction in the given time"), task `error-7730771100-prisma-tx-timeout-prs`.
Scope: **observability only** — no pool-size change, no `GET /prs` rewrite (both deliberately deferred until data exists).

## Evidence
Events are spread across routes in both services (separate pools): `GET /prs` (60), `POST /agents/:id/chat-tokens/daily` (35, admin), `GET /tasks` (16), `PATCH .../crons/:cronId/runs/:runId` (14, admin), `PATCH /tasks/:id` (11). Bursty: task-store 2026-09-28 17:00; admin 2026-10-08/09. Events carry no pool stats, no holder identity, no durations — so who held the connections is unknowable today.

## Design
Both services build a `pg.Pool` under the Prisma 7 adapter (`task-store/src/prisma-client.ts`, `admin/src/prisma-client.ts`). Starvation is visible on that pool, so instrument it there.

New shared module `lib/pool-observability.ts` (pure, clock/logger injected):
1. `snapshotPool(pool)` → `{total, idle, waiting, max}`; `isPoolTimeoutError(err)` (Prisma P2028 / "Unable to start a transaction" / pg connect timeout).
2. `startPoolMonitor(pool, {intervalMs=30s, log})` → logs a line when `waiting > 0`; returns stop fn.
3. Request context via `AsyncLocalStorage` (`runWithRouteContext`, Hono middleware factory recording method + matched route pattern).
4. `trackConnectionHold(pool, {thresholdMs=2000, log, clock})` → on checkout wraps `client.release` to measure hold time; if over threshold logs `{route, heldMs, pool snapshot}`. Measures every holder (transactions, webhook-dispatching writes, `bulk()`), not just `$transaction`.
5. `poolErrorContext(pool)` → object attached to Sentry via `captureException` scope (`pool` context + `route`/`server_name` tags) when `isPoolTimeoutError`.

Wired per service in its own PR (task-store: `app.ts` onError + `main.ts`; admin: `admin-boot.ts` / `agents-api.ts` onError). Purely additive; no behavior change beyond log lines and Sentry metadata. Log volume bounded: monitor logs only when waiting>0; hold log only over threshold.

Risk: wrapping `client.release` touches every checkout — keep it allocation-light, restore semantics exactly (idempotent release), and cover with tests. Safe to deploy standalone: yes for all tasks.

## Tasks
| Task | Depends on | Layer | Model |
|---|---|---|---|
| PLO-1.1 shared pool-observability lib | — | Shared | sonnet |
| PLO-1.2 wire into task-store | 1.1 | Background | sonnet |
| PLO-1.3 wire into admin | 1.1 | Background | sonnet |

Out of scope / follow-ups: Cloud SQL `max_connections` and connection/CPU graphs for 09-28 17:00 and 10-08/09 (human, infra); `GET /prs` batch-transaction removal; pool size change; moving webhook calls out of transactions — revisit once this data exists.

## Decision Log
- Hold-time tracking at pool checkout, not per `$transaction`: defaulted to pool-level — it catches non-transaction holders and needs no per-call-site edits.
- Threshold 2s / monitor interval 30s: defaulted to the values in the request; env-overridable is a task detail.
