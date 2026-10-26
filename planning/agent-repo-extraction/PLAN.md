# Plan: extract the agent platform into app-vitals/agent

**Session**: `agent-repo-extraction` · **Prefix**: `AGR` · **Repos**: `app-vitals/shipwright` (most tasks), `app-vitals/agent` (AGR-3.x, 6.x)
**Context**: [`../agent-runtime-extraction-prep/PLAN.md`](../agent-runtime-extraction-prep/PLAN.md), [`../agent-types-decoupling/PLAN.md`](../agent-types-decoupling/PLAN.md), `docs/platform-manifest.md`

Approved interactively by Dan McAulay on 2026-10-23.

## Start state

One monorepo holds the agent runtime (`agent/src/runtime`), the admin (`admin/`), 17 `lib` modules and `agent-types/`, next to Shipwright's coding layer, task-store, chat, metrics, mcp-server and plugins. The `AgentExtension`/`AdminExtension` seams, import-boundary tests and the platform manifest gate (AEP-4.1) exist and pass. Consumption is by relative path: coding code has about 40 `../runtime/*` imports; root scripts, `plugins/shipwright`, `task-store` and tsconfig aliases import admin/agent code. `lib/admin-types.ts` is generated from the composed (platform plus coding) admin spec. Specialists derives from `shipwright-agent`, and vitals-os also hosts Shipwright coding agents on that derived image. `app-vitals/agent` is empty.

## End state

- `app-vitals/agent` is public, MIT, with `runtime/`, `admin/`, `lib/`, `agent-types/`, history preserved, its own CI, release workflow and import-boundary gate. It publishes `@app-vitals/agent-runtime`, `@app-vitals/agent-admin`, `@app-vitals/agent-lib` (TypeScript source) and `ghcr.io/app-vitals/agent`, `ghcr.io/app-vitals/agent-admin`.
- Shipwright contains only Shipwright: coding extension, composition roots, task-store, chat, metrics, mcp-server, plugins, site. It consumes the platform via pinned registry versions bumped by Renovate and a release dispatch. `shipwright-agent` is built `FROM` the platform image; its name, tag scheme and contract are unchanged.
- No duplication: extracted directories, the old gate and the freeze guard are gone from Shipwright; each lib module has one home.
- Specialists stays `FROM shipwright-agent` (it carries the coding layer on purpose; vitals-os hosts coding agents on it). The poller keeps following `agent-v*` tags.
- Naming is consistent: manifest schema renamed to specialty before publication; `Agent.typeName` replaced by `specialty` via add, backfill, remove.

## Design

- **Strangler first.** Phase 1 gives `lib`, `runtime` and `admin` real package names and exports maps inside this repo and codemods every consumer to package specifiers. Afterwards extraction is a workspace-link to registry swap, and the risky consumer rewiring has already shipped in small steps.
- **Extraction is a script, not a one-off.** `scripts/extract-platform.ts` (`git filter-repo` + `--path-rename` + specifier rewrite) is re-run in a rehearsal until the final cut, because the pipeline keeps merging. No in-repo `platform/` consolidation: path renames at extraction time do the job without a large PR touching CI, Dockerfiles and chart.
- **Distribution.** npm packages ship TypeScript source (Bun runs it) with exports maps covering the deep imports coding uses; images are built on release. `lib` is consumed from the registry by all of Shipwright (no copy stage).
- **Prisma.** The platform owns `admin/prisma` including the inert `coding.prisma` tables and the single 44-migration history. Splitting migration ownership is out of scope.
- **Generated types.** `lib/admin-types.ts` splits into a platform half (shipped) and a coding half (Shipwright), so the runtime client never depends on coding endpoints.
- **Image switch is add, verify, flip** because specialists derives from `shipwright-agent` and vitals-os hosts coding agents on it: changing the parent rolls both agent types at once with no canary. AGR-4.3a adds the platform-based build alongside (no tag, no rollout); AGR-5.1 (Dan) verifies a coding agent and a specialist agent on a specialists image built from the candidate; AGR-4.3b flips. Rollback: revert the flip PR or pin `BASE_TAG` back via the poller's `base_tag` override.
- **Release chain.** A platform release dispatches into Shipwright (AGR-3.3, received in AGR-4.1) with Renovate as fallback; failures must be loud, since the 2026-10-02..10-09 poller stall went unnoticed.
- **Public-repo hygiene.** Full-history gitleaks, banned-string and internal-identifier scan before the push (AGR-2.1); secrets and the npm scope provisioned by a human (AGR-2.2); nothing is pushed without Dan's go-ahead (AGR-2.3).
- **Drift guard.** Between the push and the cutover, a CI check blocks Shipwright PRs touching platform paths (AGR-2.4, removed in AGR-4.4).

## Decisions (Dan, 2026-10-23)

- MIT, public; layout `runtime/` + `admin/` (+ `lib/`, `agent-types/`); history preserved via filter-repo (nice to have, not required).
- `lib` delivery: whatever is easiest now; eventual model is the registry, which this plan adopts directly.
- Deferred items: drop `platform/` consolidation; rename split (schema before publication, DB column after cutover).
- AGR-4.3 gated on SPL-2.11 (via AGR-5.1); AGR-5.1 is Dan's HITL verification; specialists is not rebased onto the bare platform image.
- Names: `@app-vitals/agent-{runtime,admin,lib}`, `ghcr.io/app-vitals/agent`, `ghcr.io/app-vitals/agent-admin`.

## Out of scope / open

- **How vitals-os should manage all agent types** (one image with every extension vs per-type images). Parked by Dan; specialties may change. Would be its own session.
- Task-store extraction (stays whole in Shipwright per the AEP decision).
- The three tasks ARD-2.1, ARD-4.1 and AEP-2.1 are `deploying` with merged PRs (known quirk); only merge status matters for dependencies.

## Tasks

| ID | Title | Repo | Cx / Model | Deps |
|---|---|---|---|---|
| AGR-1.1 | refactor: rename the agent-type manifest schema and docs to specialty | shipwright | 3 / sonnet | — |
| AGR-1.2 | refactor: give lib a package identity and migrate consumers to it | shipwright | 4 / sonnet | — |
| AGR-1.3 | refactor: give the agent runtime a package identity and migrate consumers to it | shipwright | 5 / opus | AGR-1.2 |
| AGR-1.4 | refactor: give admin a package identity, migrate consumers and split the generated admin types | shipwright | 5 / opus | AGR-1.2, AGR-1.3 |
| AGR-1.5 | feat: add the re-runnable platform extraction script | shipwright | 5 / opus | AGR-1.1, AGR-1.4 |
| AGR-1.6 | feat: add the standalone-repo template for app-vitals/agent | shipwright | 4 / sonnet | AGR-1.5 |
| AGR-1.7 | test: add the extraction rehearsal | shipwright | 4 / sonnet | AGR-1.6, AGR-1.8, AGR-1.9 |
| AGR-1.8 | refactor: make platform tests and template lookups independent of the source layout | shipwright | 3 / sonnet | AGR-1.6 |
| AGR-1.9 | refactor: make the platform self-contained without the coding specialty | shipwright | 4 / sonnet | AGR-1.8 |
| AGR-2.1 | feat: add the pre-publication audit for the extracted repo | shipwright | 4 / sonnet | AGR-1.7 |
| AGR-2.2 | chore: provision the app-vitals/agent repo, npm org and secrets ⚠ HITL | shipwright | 2 / haiku | — |
| AGR-2.3 | chore: run the final extraction and push history to app-vitals/agent ⚠ HITL | shipwright | 3 / sonnet | AGR-2.1, AGR-2.2 |
| AGR-2.4 | ci: block shipwright PRs that touch the extracted platform paths | shipwright | 3 / sonnet | AGR-2.3 |
| AGR-3.1 | ci: publish the platform npm packages and images on release | agent | 4 / sonnet | AGR-2.3 |
| AGR-3.2 | test: add a consumer smoke test against the published artifacts | agent | 4 / sonnet | AGR-3.1 |
| AGR-3.3 | ci: notify shipwright when the platform releases | agent | 3 / sonnet | AGR-3.1 |
| AGR-4.1 | refactor: consume lib from the registry and receive platform releases | shipwright | 5 / opus | AGR-3.2, AGR-3.3 |
| AGR-4.2 | refactor: build the admin on the platform admin package and image | shipwright | 5 / opus | AGR-4.1 |
| AGR-4.3a | refactor: add a platform-based agent image build alongside the existing one | shipwright | 5 / opus | AGR-4.2 |
| AGR-4.3b | refactor: switch shipwright-agent to the platform image and remove the old build | shipwright | 4 / sonnet | AGR-5.1 |
| AGR-4.4 | chore: remove the extracted code, gate and guard, and update docs and dev flow | shipwright | 4 / sonnet | AGR-4.3b |
| AGR-5.1 | test: verify the specialists-derived image runs coding and specialist agents ⚠ HITL | shipwright | 3 / sonnet | AGR-4.3a, SPL-2.11 |
| AGR-6.1 | refactor: add Agent.specialty alongside typeName | agent | 4 / sonnet | AGR-4.4 |
| AGR-6.2 | chore: backfill Agent.specialty from typeName against live data ⚠ HITL | agent | 3 / sonnet | AGR-6.1 |
| AGR-6.3 | refactor: remove Agent.typeName | agent | 4 / sonnet | AGR-6.2 |
Task bodies, acceptance criteria and branches are in the task store (`?session=agent-repo-extraction`).

## Dependency map

```
1.1 ──────────────┐
1.2 ─ 1.3 ─ 1.4 ──┴─ 1.5 ─ 1.6 ─ 1.8 ─ 1.9 ─ 1.7 ─ 2.1 ──┐
2.2 (HITL) ──────────────────────────────────┴─ 2.3 (HITL) ─┬─ 2.4
                                                              └─ 3.1 ─┬─ 3.2 ─┐
                                                                       └─ 3.3 ─┴─ 4.1 ─ 4.2 ─ 4.3a ─┐
                                                                         SPL-2.11 ─────────────────┴─ 5.1 (HITL) ─ 4.3b ─ 4.4 ─ 6.1 ─ 6.2 (HITL) ─ 6.3
```

## Breaking-change safety

Add, migrate, remove throughout. Phase 1 is behavior-preserving and safe standalone. AGR-2.3 and 3.x only add. AGR-4.1/4.2 are atomic consumer swaps (all consumers updated in one PR). The image flip uses the 4.3a/5.1/4.3b sequence. The `typeName` rename is add (6.1), backfill with a live-data check (6.2), remove (6.3).

## Revision 2026-10-23: rehearsal findings

The AGR-1.7 rehearsal failed 121 tests in the extracted tree: ~45 from hardcoded `agent/workspace` paths, ~75 from the platform depending on coding-owned assets (`specialties/coding/`, `CLAUDE.md.template`) that the manifest excludes. Added AGR-1.8 (layout-independent paths) and AGR-1.9 (self-contained platform) ahead of AGR-1.7.

## Decision Log

- AGR-1.9 approach: fixture specialty + generic template under `runtime/fixtures/`, platform tests use `SHIPWRIGHT_SPECIALTIES_DIR`/`SHIPWRIGHT_DEFAULT_AGENT_TYPE`; coding-behavior tests stay in Shipwright and are excluded from extraction. Rejected: shipping a generic default specialty in the platform (expands public surface pre-publication). Approved by Dan.
- AGR-1.8 and AGR-1.9 are serialized (overlapping test files). Approved by Dan.

## Revision 2026-10-26: AGR-4.2 re-planned (platform adopted as-is)

AGR-4.2 was blocked (`platform_package_diverges_from_shipwright_admin`): `@app-vitals/agent-admin` is not byte-identical to `admin/`, which broke AC1/AC2. Option A was chosen (Dan): treat the platform as the source of truth.

Findings from diffing `admin/` against `app-vitals/agent` `admin/` at current `main`:

- **Nothing to port.** Every shipwright commit to platform paths after the cut (#4463, #4477, #4498) already exists in the platform. The shipwright-only lines are the composition root (`main.ts`), `admin-boot.ts`/`agents-api.ts` glue the platform refactored, and `specialty-manifest-loader` imports. `signedCommits` exists only in the platform (SGC-1.3); the earlier note had it backwards.
- **The platform is additively ahead:** agent-ask (off unless `SHIPWRIGHT_AGENT_ASK_ENABLED=enabled`), platform scopes in `api-auth`, chat-credential routes, `platform-doc-route`, the signed-commits toggle, and migration `20261025000000_add_agent_ask` (`CREATE TABLE AgentAsk` plus two indexes, no FK, no change to existing tables).
- **Release defect:** published `agent-admin@0.1.1` and `agent-runtime@0.1.1` pin `agent-lib` exactly `0.1.0` (the broken release) because `bun pm pack` ignores the stamped version when rewriting `workspace:*`. Installing them nests a second `agent-lib` copy.

Changes to the task list:

| ID | Change | Repo | Cx / Model | Deps |
|---|---|---|---|---|
| AGR-3.4 | **New.** `fix:` pack inter-package ranges at the release version, assert it in the release, and make the consumer smoke fail on duplicate or mismatched `agent-lib`. Its merge cuts 0.1.2 through the automatic path (also the ARL-3.8 verification). | app-vitals/agent | 3 / sonnet | AGR-3.3 |
| AGR-4.2 | **Rewritten.** Adopt the platform admin deliberately: AC1/AC2 replaced by an additive-only OpenAPI diff, an additive-only migration check (`prisma migrate diff` on a fresh DB), unchanged auth behavior for existing keys, and a single `agent-lib` copy. No longer HITL. | app-vitals/shipwright | 5 / opus | AGR-4.1, AGR-4.5, AGR-3.4 |

```
AGR-4.1 ✓ ─┐
AGR-4.5 ✓ ─┼─ AGR-4.2 ─ AGR-4.3a ─ AGR-5.1 (HITL) ─ AGR-4.3b ─ AGR-4.4 ─ AGR-6.1 ─ AGR-6.2 (HITL) ─ AGR-6.3
AGR-3.4 ───┘
```

Breaking-change safety: AGR-3.4 only adds assertions and changes packaging (safe standalone). AGR-4.2 is an atomic consumer swap with an additive migration.

### Decision Log (revision)

- Port step: dropped. The diff shows nothing shipwright-only to port.
- AGR-4.2 is no longer HITL. The decision is made and the migration is additive; rollback is a revert (the empty table is harmless).
- AGR-3.4 rides the first automatic release (0.1.2) so it doubles as the ARL-3.8 verification. Approved by Dan.
