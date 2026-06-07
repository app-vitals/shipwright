# Todos Schema — Shipwright Tasks

This schema is the canonical task representation shared across all task store
backends (JSON, GitHub Projects v2, and any custom backend). The `source:
"shipwright"` field distinguishes shipwright tasks from `eng-execute` tasks
regardless of where they are persisted. For backend configuration, supported
operations, and GitHub field mapping see [task-store.md](task-store.md).

## Schema

```json
{
  "id": "TS-1.1",
  "source": "shipwright",
  "session": "may-billing-refactor",
  "repo": "vitals-os",
  "title": "Add billing schema migration",
  "description": "Add the new invoices table and billing period columns to the Prisma schema.",
  "acceptanceCriteria": [
    "Prisma schema includes invoices table with required fields",
    "Migration file generated and applies cleanly",
    "Existing tests pass after migration"
  ],
  "layer": "Database",
  "branch": "feat/ts-1-1-billing-schema-migration",
  "dependencies": [],
  "hours": 2,
  "status": "pending",
  "pr": null,
  "addedAt": "2026-04-12T10:00:00Z",
  "startedAt": null,
  "prCreatedAt": null,
  "mergedAt": null
}
```

## Status Flow

```
pending → in_progress → pr_open → merged → deployed
                      ↘ blocked   ↗
```

(deploy reads the GitHub API to check approved + CI green, so `approved` does not need to be a local status)

| Status | Set by | Meaning |
|---|---|---|
| `pending` | `plan-session` | Queued, waiting for dependencies |
| `in_progress` | `dev-task` Step 2 | Execution has started |
| `pr_open` | `dev-task` Step 9 | PR created, waiting for review |
| `merged` | `review` Step 13 | Merged, done |
| `deployed` | `deploy` command | PR promoted through canary to production |
| `blocked` | `dev-task` or `review` | Failed — needs human intervention |

> **Canary failure:** When the deploy command detects a canary failure, it sets `status: "blocked"` with a descriptive `note`. No separate `canary_failed` status — blocked captures the state and surfaces it in the morning brief.

## Field Reference

| Field | Type | Description |
|---|---|---|
| `id` | string | Task ID — `{PREFIX}-{N}.{M}` format |
| `source` | `"shipwright"` | Distinguishes from `eng-execute` tasks |
| `session` | string | Planning session slug — groups tasks and PRs |
| `repo` | string | Repo name (e.g., `vitals-os`) |
| `title` | string | Short, verb-first task title |
| `description` | string | What to build |
| `acceptanceCriteria` | string[] | 2-5 specific, testable criteria |
| `layer` | string | API, Frontend, Database, Shared, Background, CLI |
| `branch` | string | Git branch name for this task. Tasks sharing a branch are co-located in one PR (a "bundle") — see Bundled Tasks below. |
| `dependencies` | string[] | Task IDs that must be satisfied before this task is ready. For tasks on the same branch, `pr_open` satisfies the dependency (code is on the branch). For tasks on different branches, `merged` is required. |
| `hours` | number | Rough estimate (1-8h) |
| `status` | string | See Status Flow above |
| `pr` | number \| null | PR number once created |
| `addedAt` | ISO string | When queued by `/plan` |
| `startedAt` | ISO string \| null | When execution began |
| `prCreatedAt` | ISO string \| null | When PR was opened |
| `mergedAt` | ISO string \| null | When PR was merged |
| `deployedAt` | ISO string \| null | When PR was promoted to production via deploy command |

## Bundled Tasks

Tasks that share the same `branch` value are bundled into a single PR. This is useful when changes are tightly coupled and make more sense to review together than as separate PRs.

**Dependency resolution for bundles:** A dependency is satisfied when:
1. The dependency's `status` is `merged` (standard case), OR
2. The dependency shares the same `branch` as the current task AND its `status` is `pr_open` or `merged` (code is on the branch — merge gate is not required)

**Example:** Tasks IQ-1.3, IQ-1.4, IQ-2.1, and IQ-2.2 all share `"branch": "feat/iq-db-api-frontend"`. Once IQ-1.3 reaches `pr_open`, IQ-1.4 and IQ-2.1 are both unblocked, even though the PR hasn't merged yet.

## Blocked Tasks

When a task is blocked, set:

```json
{
  "status": "blocked",
  "blockedAt": "2026-04-12T14:00:00Z",
  "note": "CI failing after 3 attempts: TypeScript error in billing/src/invoice.ts line 42 — 'amount' is not assignable to type 'Decimal'"
}
```

Blocked tasks surface in the morning brief and require human intervention before the execution cron picks them up again.

## Coexistence with eng-execute

Eng-execute tasks use `source: "eng-execute"` (or have no `source` field for legacy entries). The execution cron filters by `source: "shipwright"` so there is no conflict.

Status values `pr_open`, `merged`, and `deployed` are new — eng-execute only uses `pending`, `done`, and `blocked`. These new values are ignored by the eng-execute cron.
