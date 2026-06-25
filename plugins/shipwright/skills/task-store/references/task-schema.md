# Task schema

The task store exposes one object type — the **Task**. This is the **backend-agnostic**
contract: the same shape whether the backend is GitHub Issues, Jira, or the local JSON file.

> **Operate the store only through the HTTP API** (`GET/POST/PATCH /tasks`).
> The `Task` below is the contract you read and write; *how* it is persisted is the
> backend's business. Never edit the underlying storage directly.

## Fields

### Identity & content
| field | type | notes |
|---|---|---|
| `id` | string **(required)** | Stable task id, e.g. `SWD-2.2`. `append` matches on this; never reuse. |
| `title` | string **(required)** | One-line summary. |
| `status` | enum **(required)** | See lifecycle below. |
| `description` | string | Full task description. |
| `acceptanceCriteria` | string[] | Checklist of done conditions. |
| `note` | string | Freeform note. |

### Planning & routing
| field | type | notes |
|---|---|---|
| `session` | string | Planning-session slug; groups tasks (a milestone / `session:` label on GitHub). |
| `repo` | string | Source repo the task targets; routes `/dev-task` to the right tree. |
| `layer` | string | `Shared`, `API`, `Database`, `Agent`, `CLI`, `Web`. |
| `dependencies` | string[] | Task ids that must be satisfied before this is `--ready`. |
| `branch` | string | Feature branch; used for same-branch dependency satisfaction. |
| `assignee` | string | GitHub login of the owner. |
| `hours` | number | Estimate. |
| `complexity` | number (1–5) | Planning / model-selection hint; out-of-range warns. |
| `model` | `haiku` \| `sonnet` \| `opus` | Tier hint for model selection (no auto-mapping to a full model id). |
| `priority` / `size` / `type` | string | Optional planning metadata. |

### Lifecycle timestamps & PR linkage
| field | type | set when |
|---|---|---|
| `addedAt` | ISO string | task created |
| `startedAt` | ISO string | → `in_progress` |
| `pr` | number | → `pr_open` (PR number) |
| `prUrl` | string | → `pr_open` (alternative to `pr`) |
| `prCreatedAt` | ISO string | → `pr_open` |
| `ciFixAttempts` | number | before `pr_open` → `approved` / `merged` |
| `mergedAt` | ISO string | → `merged` |
| `blockedAt` / `blockedReason` | ISO string / string | → `blocked` |
| `cancelledAt` / `deployingAt` / `deployedAt` / `completedAt` | ISO string | corresponding status |
| `mergeCommit` | string | merge commit SHA |
| `source` / `issue` | string | backend tracking ref (e.g. `gh:owner/repo#123`) |

> **Legacy duplicates** appear in older records: `prNumber` (≈ `pr`), `prOpenedAt`
> (≈ `prCreatedAt`). Prefer `pr` / `prCreatedAt`; readers should tolerate both.

## Status lifecycle

`pending → in_progress → pr_open → approved → merged → deploying → deployed`

Terminal: `merged`, `done`, `deployed`, `cancelled`. Paused: `blocked`.

A task is **`--ready`** when `status === "pending"` AND every id in `dependencies` is satisfied
(the dependency is `merged`, or on the same `branch` with `pr_open` / `approved`).

## Required fields per transition

`warnMissingFields` (in `scripts/adapters/validation.ts`) *warns* (never blocks) when these are
absent — set them in the **same `update`** that changes status:

| transition | must set |
|---|---|
| → `in_progress` | `model` (soft — recommended) |
| → `pr_open` | `pr` (or `prUrl`) **and** `prCreatedAt` |
| `pr_open` → `approved` / `merged` | `ciFixAttempts` |

The exact `PATCH` invocations for each transition are in `SKILL.md` (Standard lifecycle).
