# Specialists ↔ agent module: integration audit (step 3)

Status: draft for owner review. Read-only audit; no tasks queued. Step 3 of `workspace/agent-extraction-plan.md`.

## Audited commits

| Repo | SHA |
|---|---|
| `app-vitals/specialists` | `6ba55b945461d42c151bce80b54d0e58d8a78a0b` |
| `app-vitals/agent` | `ac199196f249fa5ba9b841fa4a8717e3fb7d6902` (re-checked against `6f63bfc`: only AGR-6.3 and docs changed) |
| `app-vitals/shipwright` | `3753b6bbd150558c123882fccec2defeb61948ef` |

Specialists is still moving; findings describe the SHA above.

## Frame

Specialists predates the agent module, so overlap is expected, not a fault. Goal: put specialists on the agent repo's integration points, retire obvious duplication, and note specialists features that would improve Shipwright. Specialists is an experiment; it is not asked to adopt a coding-specialty pattern. Out of scope: specialty content (domain plugins, persona text), deployment/services/chart, the image rebase (gated on vitals-os per-specialty images), key-minting standardization beyond a finding.

Tags: **duplicate** (retire by integrating), **nicety** (candidate to move into agent because Shipwright or other specialties would use it), **specific** (leave alone).

## What the agent module offers

- **Specialty manifest** (`agent-types/<name>/manifest.yaml`, `.strict()` Zod schema): `crons[]` (`name`, `schedule`, `prompt`, `preCheck`, `silent`, `enabled`, `parentCron`), `plugins[]`, `tools[]`, `env.required/optional` (keys only, `secret` flag), `identity.templatesDir`, `members`, `repos`, `chat`, `voice`, `resources`.
- **Resolution:** the agent row's `specialty` (AGR-6.3 removed the legacy `typeName`) selects one manifest from `SHIPWRIGHT_SPECIALTIES_DIR`. Manifest crons are system crons reconciled by `AgentCronJobService.reconcileSystemCrons()`.
- **Workspace layering** (`runtime/setup.ts`): `RUNTIME.md` (runtime-owned) and `SPECIALTY.md` (from the specialty's template dir) are rewritten on every boot; `SOUL.md`, `IDENTITY.md`, `CLAUDE.md` are seeded once and agent-owned.
- **Runtime code seam:** `AgentExtension` (`onConfigSync`, `periodicPasses`, `onCronJobs`, `classifyCronJobs`, `dispatchLoop`).

Key structural fact: **the agent module assumes one specialty per agent.** Specialists composes several specialties on one agent. Most findings below trace back to this.

## Findings

| # | Mechanism | Specialists | Agent module | Tag |
|---|---|---|---|---|
| F1 | Persona delivery | `specialist-base` SessionStart hook composes spine + fragments from `VITALS_PERSONA_*` env and **rewrites `SOUL.md` every session** (`plugins/specialist-base/hooks/persona-hook.ts`) | `SOUL.md` is agent-owned and seeded once; role content belongs in `SPECIALTY.md` (specialty-owned, boot-rewritten) | **duplicate** (mechanism); content is specific |
| F2 | Cron declaration | `SpecialtyCronSchema` in `specialties/schema.ts`: `name`, `schedule`, `prompt`, `silent`, `preCheck`, `channel` | Manifest cron entry has the same core fields plus `enabled`, `parentCron`; no `channel` | **duplicate** (schema); `channel` is a **nicety** |
| F3 | Cron registration | CLI creates ordinary crons named `{specialty}:{cron}` via the admin API and never touches `system: true` crons | Manifest crons are system crons reconciled by the admin service | **duplicate** (effect), blocked by F8 |
| F4 | Plugin install | CLI installs `specialist-base@vitals-os` then the specialty plugin via `POST /agents/{id}/plugins` | Manifest `plugins[]` | **duplicate** (concept); how manifest plugins are installed at creation not verified |
| F5 | Env contract | `envKeys` per specialty plus `specialties/env-profile-merge.ts` (merges across bound specialties) | `env.required/optional` with `description` and `secret` | **duplicate** (declaration); the cross-specialty merge is **specific** |
| F6 | Drift check (`--verify`, `provision-specialty-diff.ts`, `ReadOnlyAdminClient`) | Diffs live env keys, plugins, crons, tools against desired state; exit 1 on drift | No equivalent found in the files read | **nicety**: a live-agent-vs-manifest check would serve coding agents too |
| F7 | `--dry-run` / `--remove` | Prints planned writes; `--remove` lifts one specialty and revokes memory | Not found | `--dry-run`: **nicety** (pairs with F6). `--remove`: **specific** unless multi-specialty lands |
| F8 | Multi-specialty composition | Bound set derived by reverse-mapping installed plugin names to registry entries; persona fragments ordered | One `specialty` per agent | **specific** (experiment); main structural divergence |
| F9 | Memory service, key minting | CLI mints a per-agent key via the memory service admin API at provision time; `memory` plugin | Not in agent | **specific**; experiment to watch. Key minting is a finding only |
| F10 | Image and marketplace | `FROM shipwright-agent` (pinned `BASE_TAG`), plugins baked into marketplace `vitals-os` | Platform image `ghcr.io/app-vitals/agent` | Out of scope: gated on vitals-os per-specialty images |
| F11 | Repo rule | `CLAUDE.md`: "Zero Shipwright changes … consumes Shipwright's public admin API and plugin mechanism only" | Agent module now exists | Rule predates the agent module; integrating means this rule needs revisiting |

## Agent-side gaps found along the way

- `docs/agent-types.md` "Known drift": the `specialist` manifest's `templatesDir` is `specialties/specialist/templates/`, which does not resolve in the agent repo (files live under `agent-types/`), so the specialist type silently falls back to the built-in templates. A consumer using the manifest would hit this first.
- The default specialties directory is `<repo>/specialties`, so a consumer must set `SHIPWRIGHT_SPECIALTIES_DIR`.
- `runtime/setup.ts` notes `SPECIALTY.md` is "unused until a CLAUDE.md includes them"; whether the specialist `CLAUDE.md` template includes it was not checked.

## Decisions (owner review)

1. **Persona / bootstrap (F1): nothing moves into the agent repo, and specialists features do not break.** A specialty may override the agent bootstrap through the existing `identity.templatesDir` point. Per-agent token substitution is not added to the agent bootstrap. The `specialist-base` persona hook stays as is for now.
2. **Composition (F8): not in the agent repo. Likely removed from specialists.** The expected direction is that a specialist becomes something like Shipwright, one specialty per agent, with no layering. Not yet decided for specialists; revisit as it evolves. Open check: whether any live agent combines specialties today (the podcast persona test suggests one may).
3. **Crons (F3): system crons** declared in a manifest and reconciled by the admin service.
4. **Manifest (F2, F5): a specialists artifact consuming the agent repo's manifest format**, not something added to the agent repo. `channel` on manifest crons stays a specialists need to resolve (open); it is not proposed for the agent repo.
5. **Repo rule (F11): specialists no longer depends on Shipwright.** The "zero Shipwright changes" rule becomes "depend on the agent module only". Image rebase stays gated on per-specialty images.

## Proposed tasks (not queued)

Prefix is a placeholder (`SAI`); probe each id with `GET /tasks/{id}` before queueing. Nothing here touches the image or services. Decision 1 removes the persona and `SOUL.md` change from scope.

| # | Task | Repo | Depends on |
|---|---|---|---|
| 1 | docs: record decisions 1-5 | shipwright (planning) | none |
| 2 | fix: correct the `specialist` manifest `templatesDir` so the type's own templates load (agent-repo bug, no new feature) | agent | none |
| 3 | refactor: declare each specialty's plugins, env keys, tools and crons in an agent-format manifest; crons become system crons | specialists | decision 2 outcome (one specialty per agent), task 1 |
| 4 | refactor: retire the duplicated cron and env declarations once the manifest is the source | specialists | task 3 |
| 5 | docs: replace the "zero Shipwright changes" rule | specialists | task 1 |

Dropped from the earlier list: the persona/`SOUL.md` change (decision 1) and the drift-check addition to the agent repo (nothing new goes into the agent repo for now; `--verify` stays in specialists). Task 3 is blocked on whether composition is removed, because manifests resolve one specialty per agent. Only tasks 1 and 5 are independent of that, and task 2 is optional.
