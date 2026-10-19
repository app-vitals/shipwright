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
| ARD-5.1 | Move agent/src into runtime/ and coding/ with a boundary check | Shared | 4 | 4 / sonnet | `refactor/ard-5-1-runtime-coding-directories` | 2.1, 3.1, 4.1 |
| ARD-6.1 | Type-aware workspace templates with coding fallback | Background | 4 | 3 / sonnet | `feat/ard-6-1-type-aware-templates` | 5.1 |

## Dependency Map

```
[START]
  ├─ ARD-1.1 ── ARD-1.2 ── ARD-1.3
  │      └──── ARD-4.1 ─┐
  ├─ ARD-2.1 ───────────┼── ARD-5.1 ── ARD-6.1
  └─ ARD-3.1 ───────────┘
```

Ready to start: ARD-1.1, ARD-2.1, ARD-3.1.

Ordering rationale: 1.1 precedes 4.1 (both edit `check-helpers.ts`); 5.1 waits for everything touching `index.ts`/`check-helpers.ts` so the move creates no conflicts; 6.1 follows 5.1 (both change `setup.ts` paths). 3.1 and 4.1 both touch `index.ts` imports; accepted as a small possible conflict rather than serializing.

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
