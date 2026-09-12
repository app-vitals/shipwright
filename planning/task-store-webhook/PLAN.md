# Plan Session: task-store-webhook

**Repo:** app-vitals/shipwright
**Input:** verbal description (no PRODUCT-SPEC.md)

## What we're building

A generic outbound webhook mechanism on the task-store service. One configured URL receives
a `{ type, data }` envelope on every meaningful task mutation. The first (and, for this
session, only) event type is `task.write`, whose `data` is an array of the affected `Task`
row(s) — the same shape as `POST /tasks/bulk`'s request body, so a consumer's parser for one
doubles as the parser for the other.

No queue, no retry, no background delivery. The webhook call happens synchronously inside the
same Prisma `$transaction` that performs the write, before commit. A delivery failure (network
error, timeout, non-2xx) throws, which rolls back the transaction — the task write and the
webhook delivery succeed or fail together. This is a deliberate trade: no durability net (a
failed request must be retried by the caller), in exchange for a hard consistency guarantee
without any additional infrastructure (no Kafka, no outbox table, no background worker).

**Explicitly out of scope:** Jira/Linear/any other external-tool integration. Those live in
separate downstream services that subscribe to this webhook — task-store only ever emits the
generic envelope and knows nothing about what consumes it.

## Design

### Config (env vars, all optional — unset `SHIPWRIGHT_TASK_STORE_WEBHOOK_URL` disables the
feature entirely, zero behavior change)

- `SHIPWRIGHT_TASK_STORE_WEBHOOK_URL` — the single endpoint every event type is POSTed to.
- `SHIPWRIGHT_TASK_STORE_WEBHOOK_TOKEN` — optional; sent as `Authorization: Bearer` and used
  as the HMAC-SHA256 signing key for `X-Shipwright-Signature`.
- `SHIPWRIGHT_TASK_STORE_WEBHOOK_TIMEOUT_MS` — optional, default `5000`. Hard timeout on the
  outbound call — load-bearing here (unlike the fire-and-forget `chat/src/reply-notifier.ts`
  precedent), since the call now holds a live Postgres transaction/connection open for its
  duration.

### Envelope

`POST {url}` with body `{ "type": "task.write", "data": [Task, ...] }`, headers
`Authorization: Bearer {token}` (if configured) and `X-Shipwright-Signature: sha256={hmac}`
(HMAC-SHA256 over the raw JSON body, keyed by the token) — mirrors the bar this codebase
already holds *inbound* webhook handlers to (`webhook_signature_verification` in
`plugins/shipwright/references/principles.md`), applied to the outbound side so anything
built on top of this can authenticate what it receives.

The envelope shape (`{ type, data }`) is generic and reusable — a future second event type
(e.g. a PR state change) reuses the identical transport with a different `type` string and
`data` shape. Only today's call sites are task-specific.

### Trigger scope

Fires on: `create`, `update`, `bulk`, `claim`, `complete`, `fail`, `release`, `recordSkip`,
`resetSkip`. Each of these already runs its mutation inside a `$transaction`; the dispatcher
call is added right before the callback returns, using the just-written row(s) as `data`.

Does **not** fire on:
- `heartbeat()` — deliberately runs outside `$transaction` today (hottest-volume path, no
  audit-worthy change; mirrors the existing rationale for excluding it from the TaskEvent
  audit trail).
- `remove()` (`DELETE /tasks/:id`) — no `Task` row survives to put in `data`.

### Bulk semantics (changed from today)

`bulk()` currently runs one `$transaction` per task in a loop specifically so that one
colliding id (P2002) doesn't roll back tasks already inserted earlier in the same call. This
plan replaces that with **one `$transaction` for the entire array**: a P2002 anywhere in the
batch now aborts the whole transaction (translated to `ConflictError`/409) instead of being
individually skipped, and one `task.write` event fires with every created row only after the
whole batch succeeds.

This is a real behavior change to an existing endpoint with external callers
(`entropy-fix`/`error-fix`/`security-fix`/`consolidation-fix`, all of which POST to
`/tasks/bulk`). Verified before accepting this: all four already treat "`/tasks/bulk`
responds non-2xx → log the response, stop, do not retry blindly — rerunning the skill is
idempotent because its own dedup check filters already-queued ids" as their standard failure
path (see e.g. `entropy-fix/SKILL.md`'s Error Handling section). No code changes are required
in those skills; the new atomic-failure mode surfaces through a path they already handle.
Known concrete scenario this affects: two repos scanned in the same ISO week producing a
colliding `entropy-fix` task id — today a silent per-item skip, after this change a whole-batch
failure for that run (one-cycle delay via the next scheduled scan, not data loss).

### Error surface

New `WebhookDeliveryError` → HTTP 502 (distinguishes "downstream webhook target failed" from
400/409 client-input/conflict errors). Logged loudly (`console.error`) on every failure — there
is no retry queue, so this is the only record of a dropped write.

## Decision Log

- **Network call inside the write transaction, not before/after it:** the only way to get a
  hard "webhook fails ⇒ task write fails" guarantee without a queue/outbox is to gate the
  commit on the call succeeding. Before-transaction loses access to DB-generated fields
  (id/createdAt when not caller-supplied); after-transaction-plus-compensating-rollback opens
  a visibility window where another agent could read/claim the row before the compensation
  runs, and is more code. Accepted trade: the call now holds a DB connection/row lock for its
  duration, bounded by a hard timeout.
- **heartbeat excluded:** hottest-volume write path, no audit-worthy change — mirrors its
  existing exclusion from the TaskEvent trail.
- **delete excluded:** no `Task` row left to send; revisit later if a consumer needs
  deletion-awareness.
- **bulk() made atomic (one transaction, one event, no per-item skip):** a true single
  Postgres transaction can't both be one transaction and let a mid-batch unique-constraint
  violation be individually caught-and-skipped — Postgres aborts the whole transaction on
  that error regardless of whether the JS exception is caught. Per-item SAVEPOINTs would
  preserve today's skip behavior but require raw SQL not exposed by Prisma's client — rejected
  as unnecessary complexity given existing callers already degrade cleanly into the atomic
  failure mode.
- **HMAC signature added beyond the original ask:** justified by `webhook_signature_verification`
  in the default principles file — this codebase already requires inbound webhook handlers to
  verify signatures; holding the outbound side to the same bar directly serves the stated goal
  of external services building on top of this.
- **Envelope is generic (`{ type, data }`) rather than task-specific:** explicit ask — the
  first event type is `task.write`, but the transport must not need to change shape for a
  second event type later.

## Tasks

| Task | Depends on | Blocks | HITL |
|------|------------|--------|------|
| TSW-1.1 | — | TSW-1.2 | |
| TSW-1.2 | TSW-1.1 | TSW-1.3 | |
| TSW-1.3 | TSW-1.1, TSW-1.2 | TSW-1.4 | |
| TSW-1.4 | TSW-1.1, TSW-1.2, TSW-1.3 | — | |

```
[START]
  └─ TSW-1.1: Add outbound webhook config + generic event dispatcher (no deps)
        └─ TSW-1.2: Fire task.write from single-task mutation paths (needs 1.1)
              └─ TSW-1.3: Make bulk() atomic + batched task.write + document behavior change (needs 1.1, 1.2)
                    └─ TSW-1.4: Document the webhook feature (needs 1.1, 1.2, 1.3)
```

### TSW-1.1 — Add outbound webhook config + generic event dispatcher

New `task-store/src/webhook-dispatcher.ts`: `createWebhookDispatcher(url, token, timeoutMs,
fetchImpl)` returns `(type: string, data: unknown) => Promise<void>`. POSTs
`{ type, data }` with `Authorization: Bearer {token}` (if set) and `X-Shipwright-Signature:
sha256={hmac}` (HMAC-SHA256 over the raw body, keyed by `token`), a hard `AbortSignal.timeout`,
and throws `WebhookDeliveryError` on non-2xx, network error, or timeout. Returns a no-op
dispatcher when `url` is unset, so call sites never branch on config presence. New
`WebhookDeliveryError` in `errors.ts`, mapped to HTTP 502 in the app's error handler. Wire
`SHIPWRIGHT_TASK_STORE_WEBHOOK_URL` / `_TOKEN` / `_TIMEOUT_MS` (default `5000`) in `main.ts`
and inject the dispatcher into `TaskService`'s constructor (optional param, defaults to the
no-op dispatcher so existing callers/tests are unaffected).

- Acceptance criteria:
  - `createWebhookDispatcher` sends the documented envelope, headers, and signature; throws
    `WebhookDeliveryError` on non-2xx/timeout/network error; no-ops when `url` is unset.
  - `WebhookDeliveryError` maps to HTTP 502 in the app's error handler.
  - `SHIPWRIGHT_TASK_STORE_WEBHOOK_URL`/`_TOKEN`/`_TIMEOUT_MS` wired in `main.ts`; `TaskService`
    accepts an injected dispatcher (defaults to a no-op).
  - Test decision: unit tests only (`webhook-dispatcher.unit.test.ts`), injected `FetchLike`
    per this repo's no-`mock.module`/no-`global.fetch` rule — covers success, non-2xx, network
    error, timeout, signature computation, and the disabled/no-op path. No existing tests
    retired (net-new module).
- Layer: API
- Branch: `feat/tsw-1-1-webhook-dispatcher`
- Dependencies: none
- Hours: 3 | Complexity: 3 | Model: sonnet
- HITL: false
- Safe to deploy standalone: yes (pure addition, no call sites wired yet)

### TSW-1.2 — Fire task.write from single-task mutation paths

Call the injected dispatcher from inside `create`, `update`, `claim`, `complete`, `fail`,
`release`, `recordSkip`, `resetSkip`'s existing `$transaction` callbacks, right before they
return, with `type: "task.write"`, `data: [task]`. A thrown `WebhookDeliveryError` propagates
out of the callback, so Prisma rolls back the transaction and the original call rejects with
502. `heartbeat()` and `remove()` are explicitly untouched — add a code comment on each noting
why (mirrors the existing heartbeat-skips-audit-trail rationale; delete has no row to send).

- Acceptance criteria:
  - All eight listed methods call the dispatcher with the correct `type`/`data` right before
    returning, inside their existing transaction.
  - A dispatcher failure rolls back the underlying DB write (verified against a real DB, not
    just asserted in a mock) and the API call surfaces 502.
  - `heartbeat()` and `remove()` are unmodified, each with a one-line comment explaining the
    exclusion.
  - Test decision: integration tests (`task-service.integration.test.ts`, real Postgres) proving
    rollback-on-webhook-failure for at least create/update/claim — this guarantee is Postgres's
    transaction behavior, not something a fake DB can verify. Smoke test
    (`tasks.smoke.test.ts`) confirming the 502 surfaces correctly through the route layer for
    at least one call site. No existing tests retired.
- Layer: API
- Branch: `feat/tsw-1-2-task-write-events`
- Dependencies: TSW-1.1
- Hours: 4 | Complexity: 4 | Model: sonnet
- HITL: false
- Safe to deploy standalone: yes (opt-in via unset env var = zero behavior change)

### TSW-1.3 — Make bulk() atomic + batched task.write + document behavior change

Replace `bulk()`'s per-item try/catch-skip loop with one `$transaction` wrapping every task's
`tx.task.create()` + `SessionService.upsert()` call. Translate a P2002 collision to
`ConflictError` (409) instead of adding to a `skipped` array — the whole batch aborts. After
every insert in the transaction succeeds, call the dispatcher once with `type: "task.write"`,
`data: <all created rows>`. Update `docs/task-store.md`'s `POST /tasks/bulk` description in
this same PR to state the new atomic-all-or-nothing behavior explicitly (breaking-change
disclosure ships with the change, not deferred to TSW-1.4).

- Acceptance criteria:
  - `bulk()` runs as one transaction; a mid-batch P2002 rolls back every insert in that call
    and returns 409, not a partial `{inserted, skipped}` result.
  - Exactly one `task.write` event fires per successful bulk call, containing every created
    row.
  - `docs/task-store.md`'s bulk endpoint section documents the new atomic behavior.
  - `BulkInsertResponseSchema`'s `skipped` field is kept in the response shape (empty array on
    success) for response-shape backward compatibility, with its doc comment updated to
    reflect that collisions now hard-fail instead of populating it.
  - Test decision: integration tests (real Postgres) for (a) full-batch success + single
    N-item event, (b) mid-batch collision → whole batch rolled back, 409, (c) webhook failure
    mid-batch → whole batch rolled back, 502. No existing tests retired; the existing
    partial-success unit/integration tests for `bulk()`'s skip behavior are rewritten in place
    to assert the new atomic behavior instead (same file, updated assertions).
- Layer: API
- Branch: `feat/tsw-1-3-bulk-atomic-webhook`
- Dependencies: TSW-1.1, TSW-1.2
- Hours: 4 | Complexity: 4 | Model: sonnet
- HITL: false
- Safe to deploy standalone: yes, with the caveat above stated explicitly in the PR description
  (no code changes required in `entropy-fix`/`error-fix`/`security-fix`/`consolidation-fix` —
  verified they already treat a bulk failure as log-and-stop-idempotent-rerun)

### TSW-1.4 — Document the webhook feature

Add `SHIPWRIGHT_TASK_STORE_WEBHOOK_URL`/`_TOKEN`/`_TIMEOUT_MS` to `docs/configuration-agent.md`'s
task-store services section. Add a new "Outbound webhook" section to `docs/task-store.md`
covering: the `{ type, data }` envelope, `task.write` as the sole event type today and its
trigger scope (which methods fire it, which don't and why), the fail-closed/no-retry
guarantee, the signature header, and an explicit note that integration-specific logic
(Jira/Linear/etc.) lives in separate downstream services that subscribe to this webhook, not
in task-store itself.

- Acceptance criteria:
  - Both env-var docs and the `docs/task-store.md` section exist and match the shipped
    behavior from TSW-1.1–1.3.
  - `task check-config-docs` passes with the new env vars documented.
  - Test decision: none — content-only change; the `check-config-docs` CI gate is the existing
    enforcement mechanism for env-var documentation, no new test needed.
- Layer: API
- Branch: `feat/tsw-1-4-webhook-docs`
- Dependencies: TSW-1.1, TSW-1.2, TSW-1.3
- Hours: 1 | Complexity: 1 | Model: haiku
- HITL: false
- Safe to deploy standalone: yes
