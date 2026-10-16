# Agent types decoupling — discussion context

**Date**: 2026-10-16 · **Participants**: Dan McAulay, Doc (agent) · **Status**: Input to a planning session (Dan + Dave). Nothing here is decided beyond what is marked **Decided**.

This records the design discussion that preceded planning, so the planning session starts with the same context. The dependency audit it refers to is in [`AUDIT.md`](./AUDIT.md).

## Goal

Make it possible to run **more than one agent type** on Shipwright. The coding agent exists; the vision is also a marketing agent, sales agent, PM, business development, executive assistant, and eventually third-party agent types. Each looks like the coding agent: a Slack-connected agent with system crons, optionally a loop, provisioning, and optionally GitHub.

## Direction (Decided)

1. **Stay in the Shipwright monorepo for the extraction.** Fix code boundaries first; a repo split adds versioning and CI coordination before interfaces are stable. A clean package is cheap to move later.
2. **One agent = one type.** No multi-specialty composition. The coding agent is already a full agent's worth of scope; a real marketing agent will be too. (An earlier proposal to add multi-type composition to the manifest was dropped.)
3. **Eventually one repo per agent type**, deployed like Shipwright agents. The growth DB / marketing OS is the model for how a type evolves. `coding` stays in this repo as the reference implementation.
4. **Do not publish the manifest schema yet.** We are committing to the direction (hence moving the marketing agent out of vitals-os) but not to any interface, and no third party is ready to build a type. Keep `shipwright.dev/v1alpha1` internal and free to change. OSS plus managed hosting, with users defining their own types, is the vision, not something to force yet.
5. **No work queue split yet.** The first non-coding agents are cron + Slack. A generic work-item base will be needed eventually (see below), but is deferred until an agent needs claiming.
6. **Marketing is the first non-coding type**, but is **out of scope for the first planning pass** (see Scope).

## Scope for the first planning pass

Dan: only steps 1 and 2 below, and "it should really just be moving things around, a decoupling, so we're not likely to break things."

1. Audit the boundary and split `agent/` into runtime and coding.
2. Make an agent type self-contained (templates, plugin refs under `agent-types/<name>/`).

**Explicitly out for now:** marketing repo move, Saul cutover, external-manifest loading, loop schema, work-item base, publishing the schema.

**Planning guidance from Dan:** put the dependency audit inside the plan session, or follow it with a HITL task, because it may change the plan. (The audit was then run ahead of planning — results in `AUDIT.md`.)

**Guardrails agreed**
- Pure refactor: no behavior change, no new manifest fields.
- Tests should be moved or relocated, not edited; a green suite is the proof nothing broke.
- The base-image contract is a de facto interface (see below) and must not change.
- Queueing tasks starts execution immediately. Don't queue until the plan is reviewed (see Process).

## Findings that shaped the plan

### Multi-type support already half exists
- `agent-types/coding/manifest.yaml` is a declarative `AgentType` manifest (crons incl. `parentCron`, plugins, tools, env contract, members, repos, chat/voice, resources). `docs/agent-types.md` describes "one shared image, config-only specialization".
- `admin/src/agent-type-manifest-loader.ts` (`AgentTypeRegistry`) resolves a type by loading `agent-types/{typeName}/manifest.yaml` from disk relative to the repo root; unknown types fall back to `coding`. `AgentCronJobService.reconcileSystemCrons()` seeds each agent's system crons from it on boot.
- `templatesDir` is in the schema but **nothing reads it at runtime**. `agent/src/setup.ts` loads templates relative to its own source file (`agent/workspace/`). Making templates type-driven may require the runtime to know its own type at boot — **unverified**.

### Runtime vs coding is cleanly separable
Detail in `AUDIT.md`. Headline: runtime→coding coupling is almost entirely `agent/src/index.ts` acting as a hardcoded composition root. `check-helpers.ts` is the one mixed file. Tests are cleanly owned.

### Base-image contract is a de facto public interface
vitals-os builds `infra/vitals-agent/Dockerfile` `FROM ghcr.io/app-vitals/shipwright-agent:${BASE_TAG}` (pinned, bumped by `update-agent-base-tag.yml` / `bump-vitals-agent.yml`), copies a marketplace to `/opt/shipwright/marketplaces/vitals-os/` (plugins: `vitals-os`, `marketing`, `podcast-publisher`) and relies on `installPlugins()` in `agent/src/setup.ts` registering it at boot. The `AgentPlugin` table picks which plugins each agent gets (most agents get `vitals-os`; Saul gets `marketing`). Therefore the following must not change in this refactor: the image name/tag scheme, `/opt/shipwright/marketplaces/` convention root, `installPlugins()` boot behavior, and the entrypoint (`/app/agent/src/entrypoint-main.ts`). A derived-image smoke test (model: `vitals-os/infra/vitals-agent/baked-marketplace.smoke.test.ts`) is a good guard.

### Task store is coding-shaped
`Task` has ~70 columns, mostly coding-specific (repo/branch/pr/mergeCommit/ciFixAttempts, simplify metrics, skipCount, the `pr_open → merged → deploying → deployed` lifecycle), plus separate `PullRequest`, `PrFinding`, `VerificationCheck` models. The generic core is small: identity/account scope, claim + heartbeat + TTL/reaper, dependencies/blockedBy, hitl/blockedReason, spin protection (skip counting), `TaskEvent` audit, cost fields, and a `metadata` JSON escape hatch.

Direction when needed: a **work-item base** (claim/heartbeat/release/block/ready, type-defined state machine, validated per-type `metadata`) with the coding `Task`/`PullRequest` as an extension. The riskiest part is that claim/liveness logic is entangled with coding status transitions. Defer until a type needs claiming, so the abstraction comes from a real use case.

### The marketing agent already exists in vitals-os (Saul)
- Saul (production, operating now) runs marketing crons; the plugin is `plugins/marketing` in the vitals-os marketplace, baked into the shared vitals-os agent image and installed on startup. The growth DB/service is vitals-os domain.
- vitals-os `planning/marketing-os/` has a hard constraint "zero changes to the Shipwright repository", plus **WS-H "Durable Agent Platform / Specialty Registry"** (Draft, not planned): a specialty = `{plugin + persona fragment + cron set + config profile + capabilities + product-binding}` with a `provision <specialty> onto <agent>` CLI and multi-specialty composition. This **overlaps the Shipwright `AgentType` manifest**. With composition dropped, WS-H reduces to an agent type plus an idempotent provisioning recipe and persona templates with a shared SOUL spine — platform concerns.
- **Action for Dan/Dave**: before WS-H is planned, add a note to vitals-os `planning/marketing-os/00-ORDER.md` that provisioning / specialty-registry work is superseded by the platform's agent types, so a parallel provisioning CLI isn't built. The "zero changes to Shipwright" rule should be lifted deliberately for the loader work. (Not done in this PR; it is a vitals-os change.)

## Later phases (not in the first pass)

3. **External type loading.** Registry loads manifest + templates from outside this repo (pinned git ref or mounted dir). Plugin delivery does not need the registry: type repos would build a thin derived image (as vitals-os does) with their own marketplace. This is the one new interface the repo-per-type model needs.
4. **Marketing as `agent-types/marketing` in its own repo; cut Saul over.** Additive migration: manifest mirroring Saul's live crons/env, a **zero-diff reconcile dry run** before cutover (config drift on a live agent is the main risk). Leave the growth DB and services where they are until much later.
5. **Deferred, each with a trigger:** declarative loop/candidate-provider schema (for third parties — arbitrary code in managed hosting is a security issue; start declarative, code plugins only for self-host); work-item base (first type that needs claiming); publishing the runtime + manifest schema + authoring guide (first external author). For managed hosting, the manifest is a trust boundary — egress limits, per-type tool allowlists, review/signing of published types (ties to the egress-allowlist gap in the security review doc).

## Process notes for planning

- `/shipwright:plan-session` interactive mode does not write or POST anything until the breakdown is approved. Step 6 bulk-POSTs tasks as `pending`; anything with no unmet dependencies is immediately ready for the pipeline. Do not approve until you want execution to start.
- There is no "draft" task state. A HITL task blocks dependents only until it is marked done; after that provisional dependents run as written. If the plan may change after the audit/HITL review, plan in two passes rather than queueing provisional tasks. (The audit has now been run, which removes most of the need for this.)
- `--autonomous` accepts the first pass with no human gate; not appropriate here.

## Suggested task shape (from the audit; not binding)

1. Extension seam in `index.ts`: coding periodic work and GitHub auth behind a registration interface, no file moves. Highest value, and the main behavior-preservation risk (boot order).
2. Split `check-helpers.ts` into generic `gh` helpers/policy parsers and coding queries.
3. Move files into `agent/src/runtime/` and `agent/src/coding/` (directories within one package first; separate packages only if needed) with an import-boundary check keeping coding→runtime one-way. Keep the Dockerfile entrypoint path.
4. Derived-image smoke test for the base-image contract.
5. Type-aware template resolution — after confirming whether the runtime knows its type at boot.

## Open questions

- Does the runtime process know its agent type at boot? Decides whether step 2 (templates) is a path move or a small behavior change.
- Is the GitHub auth stack best treated as an opt-in extension of the coding type, or a separate optional integration usable by any type? (Dan: GitHub should be an option for agents generally.)
- How should `coding` reach the extension seam given `index.ts` boot ordering (see `AUDIT.md`)?
- Admin was not audited. It has coding-shaped parts (`agent-work-queue`, `agent-phase-methodology`, patch-author allowlist) that matter for later phases.
