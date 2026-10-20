# Plan: agent runtime / coding decoupling

**Session**: `agent-types-decoupling` · **Prefix**: `ARD` · **Repo**: `app-vitals/shipwright`
**Spec**: [`PRODUCT-SPEC.md`](./PRODUCT-SPEC.md) · **Context**: [`CONTEXT.md`](./CONTEXT.md), [`AUDIT.md`](./AUDIT.md)

Approved interactively by Dan McAulay on 2026-10-19. Design was settled during the planning session, so there is no HITL checkpoint.

## Design summary

Behavior-preserving refactor of `agent/`: separate the generic runtime from coding behavior so more agent types can run on the same image.

- **Classification** (refines the audit): GitHub auth family, repo scope (`agent-repos-ref`), `sync-config-clone`, `worktree-reaper` and `cleanup-after-days-ref` are runtime, for every agent type. `check-*`, `loop-*`, `work-*`, `pr-*`, `patch-*`, `claim-invariant-reconciler` and the PR-policy refs are coding. The dependency arrow decides: anything both coding and a runtime capability need lives in runtime.
- **Extension seam**: an `AgentExtension` interface (`onConfigSync`, `periodicPasses`, `onCronJobs`, `classifyCronJobs`, `dispatchLoop`) implemented by a `coding` extension. `index.ts` stays at its path as the composition root and is the only file exempt from the import-boundary check.
- **Policy cleanup first**: the six agent-policy fields are DB settings; the `state/agent-policy.md` tier, backfill tooling and seeding are removed (all live agents confirmed by Dan).
- **Type-aware templates last**: the runtime does not know its agent type today; add `typeName` to the config response and resolve templates by type with a coding fallback.
- **Vocabulary**: the unified concept is a **specialty** (decided 2026-10-19). Code and schema keep `typeName` / `AgentType` until before the schema is published; renaming the unpublished schema is cheap now and expensive afterwards.
- **Layered workspace files** (ARD-6.2): `RUNTIME.md` is runtime-owned, identical for every agent and rewritten on every boot; `SPECIALTY.md` is specialty-owned and overwritten on every boot from the specialty's template directory; `SOUL.md` and `IDENTITY.md` keep their meaning as the agent's own files (seeded once, never overwritten); `CLAUDE.md` is a thin seeded-once file that includes them in a fixed order shared by every specialty. Existing agents are untouched until a deliberate migration (Phase 2).
- **Extraction direction** (ARD-3.2): the agent runtime will move to its own repo together with admin and provisioning, and Shipwright (coding) and the specialists repo will both depend on it. `startAgent(extensions)` is the seam: a runtime repo cannot import the coding extension, so each consumer has a thin entry that calls it.
- **Guardrails**: base-image contract unchanged (image name/tag scheme, `/opt/shipwright/marketplaces/`, `installPlugins()`, entrypoint path); boot order preserved; tests relocated, not edited; no new manifest fields.

## Tasks

| ID | Title | Layer | Hours | Cx / Model | Branch | Deps |
|---|---|---|---|---|---|---|
| ARD-1.1 | Drop the agent-policy.md file tier from policy reads | Background | 3 | 3 / sonnet | `refactor/ard-1-1-drop-policy-file-tier` | — |
| ARD-1.2 | Remove policy backfill, file seeding and file references | Shared | 2 | 2 / sonnet | `chore/ard-1-2-remove-policy-backfill-and-seeding` | 1.1 |
| ARD-1.3 | Update public site copy for DB-based policy | Frontend | 1 | 2 / haiku | `docs/ard-1-3-site-policy-copy` | 1.2 |
| ARD-2.1 | Base-image contract smoke test for derived images | Shared | 3 | 3 / sonnet | `test/ard-2-1-base-image-contract-smoke` | — |
| ARD-3.1 | Introduce AgentExtension seam and coding extension | Background | 5 | 4 / opus | `refactor/ard-3-1-agent-extension-seam` | — |
| ARD-4.1 | Split generic gh helpers out of check-helpers.ts | Shared | 3 | 3 / sonnet | `refactor/ard-4-1-split-check-helpers` | 1.1 |
| ARD-5.1 | Move agent/src into runtime/ and coding/ with a boundary check | Shared | 4 | 4 / sonnet | `refactor/ard-5-1-runtime-coding-directories` | 2.1, 3.1, 3.2, 4.1, 6.1, 6.2 |
| ARD-3.2 | Export startAgent(extensions); index.ts becomes a thin entry | Background | 4 | 4 / opus | `refactor/ard-3-2-start-agent-entry` | 3.1 |
| ARD-6.1 | Type-aware workspace templates with coding fallback | Background | 4 | 3 / sonnet | `feat/ard-6-1-type-aware-templates` | 3.1 |
| ARD-6.2 | Layered workspace files: RUNTIME.md (runtime-owned) and SPECIALTY.md (specialty-owned) | Shared | 5 | 4 / sonnet | `feat/ard-6-2-layered-workspace-files` | 6.1 |

## Dependency Map

```
ARD-1.1 (deployed) ── ARD-1.2 ── ARD-1.3
      └── ARD-4.1 ──────────────────────────────────┐
ARD-2.1 ────────────────────────────────────────────┤
ARD-3.1 ─┬─ ARD-3.2 ────────────────────────────────┤
         └─ ARD-6.1 ── ARD-6.2 ─────────────────────┴── ARD-5.1 ── (specialists SPL-0.7, prod re-pin)
```

Updated 2026-10-19 after the first tasks started. Ordering rationale: 1.1 precedes 4.1 (both edit `check-helpers.ts`); 6.1 waits for 3.1 (3.1 rewrites most of `index.ts`; 6.1 touches the `ensureAgentHome` call site); 6.2 follows 6.1 (needs the specialty's template directory resolved); 5.1 waits for everything touching `index.ts`, `check-helpers.ts` or `setup.ts` so the move creates no conflicts. The specialists repo's prod re-pin task (SPL-0.7) depends on ARD-5.1: the directory move lands before the re-pin, so the re-pin is the single deploy that picks up both and the two changes are never debugged together. Ordering across sessions is expressed as a task dependency, not as prose.

## Breaking Change Safety

Only ARD-1.1 changes behavior: when the admin config fetch fails (or never succeeds), policy reads fall to conservative hardcoded defaults instead of the legacy file. All other tasks are pure moves or additive. ARD-3.1 changes pass order in one way (worktree reaper runs before the coding passes); passes are independent with per-pass try/catch. ARD-6.1 adds an additive config-response field. Safe to deploy standalone: yes for all eight. The base-image contract guard (ARD-2.1) lands before the directory move.

HITL scan: no Type A tasks. ARD-1.3 edits public site copy and should get a human read at review.

## Decision Log

- Extension loads unconditionally: every agent today already runs these passes; gating by type is a deliberate later behavior change.
- `index.ts` is the composition root: avoids a shim and keeps the spawn path and entrypoint unchanged.
- Worktree reaper becomes a runtime pass: pure filesystem sweep over the generic `worktrees/` layout; order change accepted.
- Policy file tier removed rather than relocated: DB is the source of truth and all agents were confirmed.
- `typeName` delivery for ARD-6.1: config response (documented contract, simplest expected outcome) over entrypoint env.
- Site copy split into its own task so the public wording gets a human read.
- Specialty vocabulary adopted; schema and `typeName` rename deferred to before publication.
- Workspace files are layered rather than copied per kind, so runtime rules stay unified and can fill gaps in existing agents; the specialty extension point is `SPECIALTY.md`, not `SOUL.md`.
- ARD-3.2 added as a follow-up task instead of growing the open ARD-3.1 PR; the 3.1 boot-order test is the safety net.
- ARD-6.1 no longer waits on 5.1 (specialists get proper templates sooner); it waits on 3.1 to avoid an `index.ts` conflict.
- Cross-session ordering uses dependencies: the specialists repo's SPL-0.7 depends on ARD-5.1.

## Phase 2 (not queued)

Follow-up work after the specialists foundation completes. Text only: nothing here is a task.

1. **Platform extraction.** Move the agent runtime, admin and provisioning (plus the shared lib pieces they import) into their own repo that Shipwright and the specialists repo depend on. First step is an admin audit equivalent to `AUDIT.md` (admin has coding-shaped parts: work queue, phase methodology, review/patch allowlists, PR and task views). The runtime imports seven `@shipwright/lib` modules and `@shipwright/admin` types, which must be published or moved. The `shipwright-agent` image name needs a plan once the runtime has its own image.
2. **Coding as a specialty** on the same reconcile and verify path as the others.
3. **Migrate existing agents** to the layered workspace files.
4. **Specialty persona delivery** writes `SPECIALTY.md` instead of `SOUL.md`.
5. **Fold the specialty registry into the definition schema**, with external loading.
6. **Rename `typeName` and the schema to "specialty"** before publication.
7. **Single specialty per agent.**
8. **Memory as a platform capability** (parked; an experiment for now).
9. **Rename the `@vitals-os` marketplace and migrate the existing marketing agent.**

Open questions: what remains in the Shipwright repo after extraction (the task store is coding-shaped but holds every agent's work queue); whether "Shipwright" names the platform or the coding specialty; whether the platform repo is public.
