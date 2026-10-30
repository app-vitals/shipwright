# Platform / coding decoupling follow-up: Plan

**Sessions**: `platform-coding-decoupling` (PCD-*, app-vitals/agent), `coding-extension-takeover` (CET-*, app-vitals/shipwright)
**Spec**: [PRODUCT-SPEC.md](./PRODUCT-SPEC.md)

## Design

Audit findings (verified against the code on 2026-10-29/30):

- Coding-only files in the platform: `admin/src/coding-task-store-provisioning-client.ts`, `lib/task-store-types.ts`, `lib/claim-ttl.ts`, `lib/default-account.ts`, the platform SPECIALTY.md template (full Shipwright pipeline text).
- 'coding' is hardcoded as the default type in the loader, `runtime/setup.ts`, the Prisma `specialty` column default and the self-serve form; the platform's default specialties dir (`<repo>/specialties`) does not exist in the platform image, which ships `agent-types/`.
- `DEFAULT_PLUGINS = ['shipwright']` installs a plugin the platform image does not ship; failures only warn.
- The specialty manifest system (strict v1alpha1 schema, loader, JSON Schema, docs) is read by the cron reconcile, create-time seeding, the type picker, missing-env reporting and workspace template lookup. Its only non-trivial content is the coding manifest (14 crons, 11 tools, 1 plugin); the neutral `specialist` type is nearly empty.
- The specialists repo does not use the manifest schema and now builds on the platform image (SIL-4.1/4.2 merged).

Approach, by layer:

- **Business logic / platform**: add a specialty-defaults extension hook (PCD-4.1); switch defaults to `specialist` over the shipped `agent-types/` dir (PCD-3.1); install plugins from rows (PCD-3.3); shrink the loader (PCD-5.1).
- **Shipwright**: take ownership of the moved modules and templates (CET-1.x), set explicit coding defaults, supply coding defaults as code (CET-4.1), delete manifests (CET-4.2).
- **DB**: only `ALTER COLUMN SET DEFAULT` for `Agent.specialty` (PCD-3.4); no row changes, no constraints, no backfill. coding.prisma stays (PCD-6.1).
- **CI**: coding-vs-platform boundary gate with a shrinking allowlist (PCD-1.2).

## Breaking Change Safety

| Change | Consumers | Safe path |
|---|---|---|
| Remove client/types/claim-ttl/default-account from platform | Shipwright coding extension, metrics, task-store, admin-ui | CET-1.1/1.2 first, PCD-2.1 after |
| Stop special-casing coding templates | Coding agents' workspace seeding | CET-1.3 first (inert), then PCD-2.2 |
| Default type 'coding' -> 'specialist' | Shipwright-created agents, pods | CET-1.4 first, PCD-3.2 verification, then PCD-3.1 |
| Prisma default -> 'specialist' | Any create without specialty | After PCD-3.1 + PCD-3.2; SET DEFAULT only |
| Plugins from rows | Coding agents' shipwright plugin | PCD-3.2 confirms rows, then PCD-3.3 |
| Remove manifests / shrink loader | Shipwright seed/fixtures, cron reconcile, specialist agents | PCD-4.1 -> CET-4.1 -> CET-4.2 -> PCD-5.1 |

All tasks are safe to deploy standalone when run in dependency order.

## Tasks

| Task | Repo | Title | Depends on | Cx | Model | HITL |
|---|---|---|---|---|---|---|
| PCD-1.1 | agent | fix: self-serve create form posts the resolved agent type | — | 1 | haiku |  |
| PCD-1.2 | agent | ci: add a coding-vs-platform boundary gate with a shrinking allowlist | — | 3 | sonnet |  |
| PCD-2.1 | agent | refactor: remove the task-store client, task-store types, claim-ttl and default-account from the platform | PCD-1.2, CET-1.1, CET-1.2 | 2 | haiku |  |
| PCD-2.2 | agent | refactor: make the platform workspace fallback generic and stop special-casing coding | PCD-1.2, CET-1.3 | 3 | sonnet |  |
| PCD-3.1 | agent | refactor: default the agent type to specialist and the specialties dir to the shipped agent-types | PCD-2.2, CET-1.4 | 4 | sonnet |  |
| PCD-3.2 | agent | chore: verify live specialty values, pod specialties env and coding agents' plugin rows | — | 1 | haiku | ⚠ HITL |
| PCD-3.3 | agent | refactor: install plugins from the agent's own rows instead of a hardcoded shipwright default | PCD-3.2 | 3 | sonnet |  |
| PCD-3.4 | agent | chore: change the Agent.specialty column default to specialist | PCD-3.1, PCD-3.2 | 3 | sonnet |  |
| PCD-4.1 | agent | feat: add an extension hook for specialty defaults (crons, tools, plugins) | — | 5 | opus |  |
| PCD-5.1 | agent | refactor: shrink the specialty loader to a minimal specialist type record | PCD-3.1, PCD-4.1, CET-4.2 | 4 | sonnet |  |
| PCD-6.1 | agent | docs: record and guard the decision to keep coding.prisma and the coding Agent columns in the platform schema | PCD-1.2 | 2 | haiku |  |
| CET-1.1 | shipwright | refactor: own the task-store provisioning client, types and cassette in the coding extension | — | 3 | sonnet |  |
| CET-1.2 | shipwright | refactor: own claim-ttl and default-account in Shipwright | — | 2 | haiku |  |
| CET-1.3 | shipwright | feat: Shipwright owns the coding workspace templates, including the full SPECIALTY.md | — | 3 | sonnet |  |
| CET-1.4 | shipwright | feat: set the default and self-serve agent type to coding explicitly in the admin composition root | — | 2 | haiku |  |
| CET-4.1 | shipwright | feat: supply the coding agent's default crons, tools and plugin as code from the coding extension | PCD-4.1 | 4 | sonnet |  |
| CET-4.2 | shipwright | refactor: remove the coding and specialist manifests and the schema generator | CET-4.1 | 3 | sonnet |  |

## Dependency Map

```
[START]
  |- PCD-1.1 form fix
  |- PCD-1.2 boundary gate --------------------------+-> PCD-6.1 keep-schema guard
  |- PCD-3.2 (HITL) verify live state ---+-> PCD-3.3 plugins from rows
  |- PCD-4.1 defaults hook                |
  |- CET-1.1 own client ---+              |
  |- CET-1.2 own claim-ttl +-> PCD-2.1 delete moved files (needs PCD-1.2)
  |- CET-1.3 coding templates -> PCD-2.2 generic fallback (needs PCD-1.2)
  |- CET-1.4 explicit defaults                \
  |                                            +-> PCD-3.1 specialist default (needs PCD-2.2, CET-1.4)
  |                                                   +-> PCD-3.4 Prisma default (also needs PCD-3.2)
  |- PCD-4.1 -> CET-4.1 coding defaults as code -> CET-4.2 delete manifests
  \- PCD-5.1 shrink loader (needs PCD-3.1, PCD-4.1, CET-4.2)
```

Cross-session: SIL-4.1/4.2 (specialty-image-lane) are merged, which clears the gate on shrinking the loader.

## Test strategy

Unit tests for the helpers and the gate; integration tests where real files or the DB are involved (loader against the shipped `agent-types/`, migration test for the column default, cassette-driven client test); contract tests for the specialist type before and after the loader shrink. No e2e changes. Each task states which existing tests it retires and why.

## HITL

PCD-3.2 is Type A HITL: it reads production data (live specialty distribution, pod env, plugin rows) that the dev-task environment cannot reach.

## Decision Log

- Default agent type: specialist (Dan, 2026-10-30).
- coding.prisma and coding Agent columns: keep in the platform schema (Dan confirmed, 2026-10-30).
- Plan PRs open as usual (Dan, 2026-10-30).
- PCD-4.1 scored complexity 5 / opus: new abstraction (extension hook) crossing cron reconcile and create-time seeding.
