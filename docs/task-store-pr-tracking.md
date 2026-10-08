# Task Store — PR Tracking & Dispatch Guards

Companion to [`task-store.md`](./task-store.md). That page covers the HTTP service, task lifecycle, and dependency rules; this one covers PR origin metrics, verification checks, and the dispatch guards that keep the queue honest (skip tracking, the same-branch exclusivity guard, and the session archive sweep). Endpoint shapes live in [`task-store/openapi.json`](../task-store/openapi.json).

---

## PR origin metrics

`PullRequest` carries four nullable, purely additive origin-tracking columns: `origin` (a
`PrOrigin` enum — `shipwright` | `ci` | `dependency_bot` | `human` | `unknown`), `authorLogin`,
`headRef`, and `title`. `origin` is **first-write-wins**: once set, no later write ever overwrites
it — see `PullRequestService.stampOrigin()`. `authorLogin`/`headRef`/`title` are written
unconditionally by whichever call site supplies them — the latest known value always wins for
those three. Three call sites write these fields:

1. `TaskService.update()` — when a PATCH sends `status: "pr_open"` and the resulting `pr` is
   non-null (either supplied in the same PATCH or already on the row), the task-store stamps
   `origin: "shipwright"` on the linked `(repo, pr)` PullRequest row **in the same transaction** as
   the task write — no extra API call from `dev-task.md`/`unblock.md`. A PATCH that would leave
   `status: "pr_open"` with `pr` null (neither supplied nor already on the row) is rejected with
   `400` — this invariant is enforced server-side, not just by convention.
2. `PullRequestService.claim()` (`POST /prs/claim`) — accepts optional `authorLogin`, `headRef`,
   and `title` fields, which are stored unconditionally (latest value always wins), plus the
   origin-only signals `authorIsBot`, `hasAutomatedLabel`, and `hasShipwrightLabel` (consumed by
   `deriveOrigin()` and not persisted). After every
   successful claim (update or create branch), looks up whether a Task row links `(repo, prNumber)`
   and derives a `PrOrigin` via the pure `deriveOrigin()` helper (`task-store/src/pr-origin-derivation.ts`),
   then calls `stampOrigin()` atomically with the claim write. A task-row match or `hasShipwrightLabel` wins over any
   author/branch-based signal — see [metrics.md](./metrics.md#origin-classification-rules) for
   the exact precedence table `deriveOrigin()` implements.
3. `POST /prs/census` — a batch upsert (`{repo, prNumber, origin?, authorLogin?, headRef?, title?,
   state?, mergedAt?, prCreatedAt?, commitCount?, commitsDocsRefresh?, commitsReviewPatch?,
   commitsCiFix?, commitsImplementation?}[]`, capped at 200 entries per call) used by POM-4.1's
   repo-wide census sweep (see [agent-ops.md](./agent-ops.md#pr-origin-census-sweep)) to backfill
   origin/author/branch/title/commit-count metrics for PRs the pipeline never claimed directly. It
   never touches claim/phase/review/patch/blocked fields, so it's safe to run alongside
   review/patch/deploy's separate `POST /prs/claim` lock. New rows get `phase=null`,
   `reviewState="pending"`, `staged=false`. The five commit-count fields (CPP-1.1: `commitCount`,
   `commitsDocsRefresh`, `commitsReviewPatch`, `commitsCiFix`, `commitsImplementation`) are written
   unconditionally when supplied.

`GET /prs/census/cursor?repo=org/name` returns `{ cursor }` — the max `mergedAt` among rows scoped
to `repo` with a non-null `origin`, or `null` when none exist — the incremental search window the
census sweep uses to avoid re-scanning the same PRs every run.

**PR repo scoping.** Agent-token access to `/prs` is limited to the token's `repos`; admin tokens are unrestricted. An empty array (`repos: []`, including the resolver-outage fail-safe in the PR origin metrics section) means *zero access*, never "all repos". Out-of-scope behavior by route:

| Route | Out-of-scope / `repos: []` result |
|-------|------------------------------------|
| `GET /prs` | Filtered to scoped repos (ANDed with `?repo`/`?org`); `[]` returns an empty list |
| `POST /prs/claim` | `400` |
| `POST /prs/claim-next` | Only in-scope PRs are eligible (`204` when none) |
| `POST /prs/census`, `GET /prs/census/cursor` | `403` |
| `/prs/:id` and `/prs/:id/*` | `404` — identical to a missing PR, so out-of-scope ids can't be probed |

`GET /prs` accepts `?origin=shipwright,ci` (comma-separated) to filter by any of the given values.

**Known gap:** a PR that never goes through the `pr_open` transition, `POST /prs/claim`, or the
census sweep has no PullRequest row at all, and therefore no `origin`. As of POF-3.1, this gap
has been closed for `deploy.md`'s canary-revert PR: immediately after `gh pr create` succeeds,
Step 6 calls `POST /prs/census` directly with `origin: "shipwright"` and `state: "open"` to
stamp the revert PR at creation time, avoiding any reliance on the census sweep to classify it.
Older canary-revert PRs that merged before POF-3.1 shipped may have `origin=null` (`unknown`),
though the census sweep will eventually backfill them as `human` (via author login) once it runs.
Historical backfill via a one-time script remains out of scope.

## Verification checks

`VerificationCheck` is an append-only per-check outcome record (mirrors `PrFinding`/`TaskEvent` — a race-safe `INSERT`, not a JSON blob) belonging to exactly one parent: a `Task` (recorded while still in progress, before a PR exists) or a `PullRequest` (recorded once a PR is open). Prisma has no schema-level XOR constraint across the two nullable FK columns, so "exactly one of `taskId`/`prId`" is enforced by `VerificationCheckService.record()` — supplying neither or both is `400`.

`status` is `ran_passed | ran_failed | skipped | timed_out`. `reasonCategory` is a closed set of ENVIRONMENTAL causes (`check_timeout | install_timeout | resource_limit | missing_tool | missing_secret | missing_dependency | not_configured | learned_skip`) and is only valid alongside `status: skipped | timed_out` — a `ran_failed` row (the check ran and produced a genuine failure) must never carry one; that combination is rejected server-side, not just by convention. `learnedFromCategory` is only valid alongside `reasonCategory: learned_skip`, and must not itself be `learned_skip` — both rules are enforced in the same `record()` call.

`POST /verification-checks` records one outcome. `GET /verification-checks` supports three mutually-exclusive query modes: `?taskId=` and `?prId=` (ordered by `at` ascending, default `limit=50`/`offset=0`, `404` if the referenced task/PR doesn't exist), and `?repo=`+`?checkName=` together (LVB-4.4's skip-locally learning trigger — spans every task/PR that ever recorded that repo+check pair, so an unmatched pair returns `200` with an empty list rather than `404`, and is ordered by `at` **descending** so a caller can walk backward from the most recent outcome to detect a consecutive skipped/timed_out streak).

**Scoping (SSP-6.10).** Agent tokens are restricted to their repos and account. `POST` requires `repo` in the token's repos (`403` otherwise) and a parent task/PR inside the token's repos and account (`404`, indistinguishable from missing); the row is stamped with the parent's `accountId`. `?taskId=`/`?prId=` reads `404` for out-of-scope parents; `?repo=`+`?checkName=` returns only the caller's account rows, and an out-of-scope `repo` returns an empty list. Admin tokens are unrestricted and may narrow the repo+check history with `?accountId=`.

Full request/response shapes live in the OpenAPI spec, per this doc's existing pointer convention.

## Skip tracking (reason-aware auto-block)

`Task` records track repeated no-op dispatches via three fields: `skipCount` (number of consecutive skips with the same reason), `lastSkippedAt` (ISO timestamp of the most recent skip), and `lastSkipReason` (the text reason of the current skip streak). `PullRequest` records track only `skipCount` and `lastSkippedAt` — there is no `lastSkipReason` column, and `POST /prs/:id/skip` takes no body and increments `skipCount` on every call, so the reason-aware logic below applies to the task path only. When the loop orchestrator dispatches a task/PR and receives a `[silent]` marker (found nothing to do), it records a skip via `POST /tasks/:id/skip` (task, with a reason) or `POST /prs/:id/skip` (PullRequest). For tasks, `TaskService.recordSkip()` computes the next streak state using reason-aware logic (SRB-1.1):

- **Same reason:** if the incoming reason matches `lastSkipReason`, increment `skipCount` by 1.
- **Different reason or first skip:** if the reason differs (or `lastSkipReason` is null), reset `skipCount` to 1 and update `lastSkipReason`.
- **Auto-block threshold:** when `skipCount` reaches 3 (`SKIP_BLOCK_THRESHOLD` in `task-store/src/task-service.ts`), the record is auto-blocked to prevent infinite re-dispatch loops. A task gets `status:"blocked"`, `hitl: true`, and a `blockedReason` naming the count and reason, e.g. "Auto-blocked after 3 consecutive skips for reason: reason-a". A PullRequest gets `blocked: true` and `blockedReason` "Auto-blocked after 3 consecutive skips (dispatched but found nothing to do)" (no reason in the streak). It also records block-time state (PSL-3.1, all nullable): `blockedHeadSha` (the PR's `commitSha`, falling back to `reviewedCommitSha`), `blockedReviewId` (id of the latest review-source `PrFinding`, or null), `blockedAt`, and the preserved auto-block history `lastAutoBlockReason` / `lastAutoBlockedAt`. `resetSkip()` leaves all five untouched (the next block overwrites them; the `lastAutoBlock*` pair is never cleared).
- **Reap-triggered streak:** `StaleClaimReaper.reap()` feeds the same streak counter with the fixed reason `stale_claim_timeout` (`STALE_CLAIM_REAP_REASON`, `task-store/src/stale-claim-reaper.ts`), so a task whose claim is reaped three times in a row (no intervening progress or differently-reasoned skip) auto-blocks with `hitl: true` instead of cycling back to pending forever.

This reason-aware deduplication prevents legitimate but repeated deferrals (e.g., "waiting for dependency") from triggering auto-block, while catching genuine stuck loops where the same reason hits threshold 3 times in a row. No skip-reason category is exempt from counting: every `[skip-reason:...]` marker — including `deferred`-category markers like `dev-task:deferred:same-branch-sibling-busy:*` and `review:deferred:unresolved-human-feedback:*` — is forwarded to `recordSkip()` as-is; the loop orchestrator's prior category-based exemption was removed (SRB-1.1) in favor of this reason-aware streak logic alone.

The `POST /tasks/:id/skip` endpoint accepts an optional `reason` field (string); if omitted, the reason defaults to `"unspecified"`. The `lastSkipReason` value is sent by the loop orchestrator from the dispatched command's own `[skip-reason:text]` marker (see `agent/src/markers.ts` and `docs/agent-ops.md`). Callers can find auto-blocked tasks with `GET /tasks?status=blocked` or inspect `skipCount`/`lastSkipReason` directly via `GET /tasks/:id`.

## Same-branch exclusivity guard

A pending task is excluded from the ready set if another task shares its non-null/non-empty `branch` field and is `in_progress` with a fresh claim. This "same-branch exclusivity guard" prevents multiple agents from simultaneously executing tasks bound to the same feature branch — a real dev-task session is likely mid-flight on that shared git branch.

**Freshness definition:** A claim is considered fresh if its `heartbeatAt` (or `claimedAt` if heartbeat is absent) is within `DEFAULT_CLAIM_TTL_MS` (default: 65 minutes — `DEFAULT_CLAUDE_TIMEOUT_MS` + `CLAIM_TTL_BUFFER_MS`, overridable via `SHIPWRIGHT_TASK_STORE_CLAIM_TTL_MS`) of now. This mirrors the stale-claim-reaper's exact freshness formula, ensuring a genuinely crashed or abandoned sibling task (one whose agent failed to heartbeat) does not permanently starve pending bundled tasks on the same branch.

**Example:** If two tasks share `branch=feat/foo` and the first is `in_progress` with a fresh claim, the second remains excluded from `?ready=true` until either:
- The first task completes, fails, or is released (no longer `in_progress`)
- The first task's claim becomes stale (more than 65 minutes without heartbeat) and is reaped

This rule only applies when `branch` is set. Tasks with `branch=null` or `branch=""` are not subject to the exclusivity check.

## Session archive sweep

A background job, `SessionRetentionReaper` (`task-store/src/session-retention-reaper.ts`), archives sessions that have gone inactive. It runs on a 1-hour interval registered in `task-store/src/main.ts` (`SESH-8.1`) — a housekeeping pass, not a liveness check like the stale-claim reaper in the same-branch guard section.

A session is archived (`archivedAt` set, `archivedBy = "system"`) when **all** of these hold:

1. it is not already archived,
2. every task in the session is terminal (no open/non-terminal tasks remain),
3. the session has at least one task ever (an empty session is never archived), and
4. its last task activity is older than `SHIPWRIGHT_TASK_STORE_SESSION_ARCHIVE_AFTER_DAYS` days (default `30`; see [`docs/configuration-agent.md`](./configuration-agent.md#metrics--admin--chat--task-store-services) — set to `0` to disable the sweep).

Archiving is **non-destructive and reversible**: it only removes the session from the default list view. Nothing is deleted, and writing any new task into an archived session automatically un-archives it (`SessionService.upsert()`, SES-1.2) — the next sweep will not re-archive it while that task remains open.

**Retention is archive-only.** There is no purge/delete endpoint for sessions (or for the tasks
within them) — `SessionRetentionReaper` only ever sets `archivedAt`/`archivedBy`, and no route under
`/sessions` accepts a `DELETE`. A session's rows, and every task that ever belonged to it, persist
