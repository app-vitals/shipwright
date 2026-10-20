# Plan: agent runtime extraction prep

**Session**: `agent-runtime-extraction-prep` · **Prefix**: `AEP` · **Repo**: `app-vitals/shipwright`
**Context**: [`ADMIN-AUDIT.md`](./ADMIN-AUDIT.md), [`TASK-STORE-AUDIT.md`](./TASK-STORE-AUDIT.md), [`../agent-types-decoupling/PLAN.md`](../agent-types-decoupling/PLAN.md) (all ARD tasks merged)

Approved interactively by Dan McAulay on 2026-10-20. Only merge status matters for this session's dependencies.

## Design summary

Goal: make the agent runtime, admin and provisioning (plus the `lib` modules they use) a closed set inside this repo, so that moving it to its own repo is a direct copy/paste with no refactoring. Shipwright (coding) and the specialists repo then depend on it. The repo move itself is out of scope.

- **Task-store stays whole in Shipwright** and is not part of the platform set (Dan, 2026-10-20: keep things separate; no work-item base yet). Its work-item core is not extracted; sessions stay coding.
- **Admin gets the same seam the agent got**: an `AdminExtension` + `startAdmin(extensions)`, with the coding-shaped admin code moved to `admin/src/coding/` and contributed through the extension. `main.ts` is Shipwright's composition root.
- **Provisioning becomes service-integration based**: chat is a built-in platform integration; task-store is registered by the coding extension, so the platform source names no `SHIPWRIGHT_TASK_STORE_*`.
- **Type system stops assuming the repo layout**: manifest directory and default type become configuration (defaults preserve today's behavior).
- **Proof**: a platform manifest plus a bun test that walks the import closure and fails on any edge leaving the set (AEP-4.1).
- **Guardrails**: behavior-preserving; base-image contract unchanged; tests relocate rather than change; generated admin OpenAPI document and rendered pages stay byte-identical.
- **Deferred (not queued)**: `platform/` directory consolidation and the specialty rename (add, migrate, remove on `Agent.typeName`); both are added after the gate is green. `lib` delivery (copy vs publish) stays a decision for the extraction itself; the gate records which modules are shared.

## Tasks

| ID | Title | Layer | Hours | Cx / Model | Branch | Deps |
|---|---|---|---|---|---|---|
| AEP-1.1 | refactor: remove hard cross-package imports from admin | Shared | 3 | 3 / sonnet | `refactor/aep-1-1-remove-admin-cross-package-imports` | — |
| AEP-1.2 | refactor: make agent-type manifest directory and default type configurable | Shared | 4 | 3 / sonnet | `refactor/aep-1-2-configurable-agent-types-dir` | — |
| AEP-1.3 | refactor: split the Claude timeout constant out of lib/claim-ttl | Shared | 2 | 2 / haiku | `refactor/aep-1-3-split-claim-ttl` | — |
| AEP-2.1 | refactor: introduce AdminExtension seam and startAdmin entry | Background | 6 | 5 / opus | `refactor/aep-2-1-admin-extension-seam` | 1.2 |
| AEP-2.2 | refactor: generalize provisioning to optional service integrations | Background | 5 | 4 / sonnet | `refactor/aep-2-2-service-integrations` | 2.1 |
| AEP-3.1 | refactor: move whole-file coding admin modules behind the extension | Background | 5 | 4 / sonnet | `refactor/aep-3-1-move-coding-admin-modules` | 2.1, 2.2 |
| AEP-3.2 | refactor: split coding blocks out of the mixed admin UI and API files | Frontend | 8 | 5 / opus | `refactor/aep-3-2-split-mixed-admin-files` | 3.1 |
| AEP-3.3 | test: add admin import-boundary test | Shared | 2 | 2 / haiku | `test/aep-3-3-admin-import-boundary` | 3.2 |
| AEP-3.4 | refactor: isolate coding Prisma models in their own schema file | Database | 3 | 3 / sonnet | `refactor/aep-3-4-isolate-coding-prisma-models` | 3.3 |
| AEP-4.1 | test: add the copy-paste-readiness gate for the platform set | Shared | 4 | 4 / sonnet | `test/aep-4-1-copy-paste-readiness-gate` | 3.3, 1.1, 1.3, 2.2 |

## Dependency Map

```
AEP-1.1 ─────────────────────────────────────────────┐
AEP-1.2 ── AEP-2.1 ─┬─ AEP-2.2 ──┬── AEP-3.1 ── AEP-3.2 ── AEP-3.3 ─┬─ AEP-3.4
                    └────────────┘                                 └─ AEP-4.1 (also needs 1.1, 1.3, 2.2)
AEP-1.3 ─────────────────────────────────────────────┘
```

Phase 1 tasks are independent and can run in parallel. 2.1 waits for 1.2 (the loader and self-serve options). 3.x run in order because they edit the same files (`admin-ui*.ts`, `agents-api.ts`, `main.ts`). 4.1 is last: it needs the boundary in place and the hard imports gone.

## Breaking Change Safety

All ten are behavior-preserving moves or additive options. Atomic updates, no shims: AEP-1.3 updates all importers of the moved constant in the same PR; AEP-2.2 changes provisioner and callers together; AEP-3.x move code and its registration together. No database migration (AEP-3.4 asserts `prisma migrate diff` is empty). Safe to deploy standalone: yes for all. Risk to watch: AEP-3.2 is the largest and touches 15k lines of UI/API files; its byte-identical HTML and OpenAPI checks are the safety net.

HITL scan: no Type A tasks (no `.claude/**`, secrets or console steps).

## Decision Log

- Task-store stays whole; platform keeps only optional service integrations: simplest for the integrator, avoids a live-DB schema split.
- Sessions, work-queue snapshot and phase methodology are coding: they exist for the coding loop and are task-store views.
- Prisma isolation (AEP-3.4) is a file split with no migration, and sits after the boundary test so it does not block the gate.
- `lib` delivery left open: the gate tags modules platform/shared and records them; copy is the likely answer for small leaf modules.
- AEP-4.2 (lib delivery) was folded into AEP-4.1 because the only in-repo work is recording and checking the module tags; the copy/publish choice is made at extraction time.
- `platform/` consolidation and the specialty rename are left out of this batch and added once the gate is green.
- AEP-1.3 uses a new lib module with an atomic importer update instead of a re-export shim.
