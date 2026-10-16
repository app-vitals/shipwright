# Plan: generic `specialist` agent type

**Session**: `specialist-agent-type` · **Prefix**: `SAT` · **Repo**: `app-vitals/shipwright`
**Context**: [`planning/agent-types-decoupling/CONTEXT.md`](../agent-types-decoupling/CONTEXT.md), [`AUDIT.md`](../agent-types-decoupling/AUDIT.md)

## Problem

`coding` is the only directory under `agent-types/`, so the admin new-agent type picker offers nothing else and every agent is created as `coding` (all 11 live agents are, including Saul). `Agent.typeName` is set only at creation and is not updatable via the API. Creating an agent seeds its tools and plugins from the type manifest, and `reconcileSystemCrons` seeds system crons from it on every boot. A non-coding agent therefore carries coding's system crons and the `shipwright` plugin. The coding manifest also ships `shipwright-dev-task`, `-patch` and `-review` as `enabled: true`; Saul's are off only because they were disabled by hand.

Specialties (marketing, podcast, a future PM agent) are defined in vitals-os (`specialties/`, `scripts/provision-specialty.ts`) and layer plugin, crons and env on top of a base type through the admin API. They need a base type that is not `coding`.

## Design

Additive only. No loader code changes: `AgentTypeRegistry.listTypes()` discovers directories under `agent-types/`, `admin/Dockerfile` ships the whole repo (`COPY . .`), and the generated JSON Schema derives from the Zod schema, not from manifests, so it does not change.

### `agent-types/specialist/manifest.yaml`

| Field | Value |
|---|---|
| `metadata` | name `specialist`, displayName "Specialist Agent", `skills: []` |
| `identity.templatesDir` | `agent/workspace/` (required by schema; unread at runtime) |
| `crons` | `[]` (`learn-dream` excluded: it needs the `shipwright` plugin) |
| `plugins` | `[]` (specialties add theirs via provisioning) |
| `tools` | `Bash`, `WebSearch`, `WebFetch`, `Agent` (additive on the floor set; `Monitor` omitted) |
| `env.required` | `CLAUDE_CODE_OAUTH_TOKEN` (secret) |
| `env.optional` | same optional keys as `coding`: `GH_TOKEN`, Slack tokens, voice keys |
| `members`, `repos` | `[]` |
| `chat`, `voice` | `true`, `true` (same defaults as `coding`) |

No GitHub or task-store scope is granted by default: `repos: []`, no `shipwright` plugin, `GH_TOKEN` optional only.

### Known limitation (out of scope)

`identity.templatesDir` is not read at runtime; `agent/src/setup.ts` always loads `agent/workspace/`. A specialist agent still receives the coding-flavored workspace `CLAUDE.md` template. This is the "type-aware templates" step in CONTEXT.md. Record it in the manifest comment and docs; do not fix it here.

### Fallback hardening

`AgentTypeRegistry.getManifest()` falls back to the `coding` manifest for an unknown or unloadable type. That is a deliberate boot-path safety net, but it means a broken `specialist` manifest would silently seed enabled coding crons on a non-coding agent. Create-time already rejects an unknown type with 400 (`tryGetManifest`), so only the reconcile path needs hardening (SAT-1.2).

## Tasks

| ID | Title | Layer | Hours | Cx / Model | Branch | Deps |
|---|---|---|---|---|---|---|
| SAT-1.1 | Add `specialist` agent type manifest, tests and docs | Shared | 3 | 2 / haiku | `feat/sat-1-1-specialist-agent-type` | — |
| SAT-1.2 | Don't fall back to coding crons for a non-coding type | Background | 3 | 3 / sonnet | `feat/sat-1-2-reconcile-no-coding-fallback` | — |
| SAT-1.3 | ⚠ HITL: verify `specialist` end to end in the deployed admin | CLI | 1 | 1 / haiku | `feat/sat-1-3-verify-specialist` | SAT-1.1 |

```
[START]
  ├─ SAT-1.1  manifest + tests + docs
  │     └─ SAT-1.3  ⚠ HITL verify in deployed admin (needs 1.1)
  └─ SAT-1.2  reconcile: no coding fallback for non-coding types
```

Breaking-change scan: all additions. SAT-1.2 changes boot-path behavior only for a non-coding type with a missing manifest; all 11 live agents are `coding`. Safe to deploy standalone: yes for all three.

HITL scan: SAT-1.3 flagged Type A (requires the admin web UI).

## Out of scope

Runtime/coding split, external manifest loading, migrating Saul, Redis or other backing services, work-item base, publishing the schema, type-aware workspace templates.

## Follow-ups (not queued)

- Correct `CONTEXT.md`: WS-H (vitals-os specialty registry and `provision-specialty`) is implemented, not "Draft, not planned".
- vitals-os `planning/marketing-os/00-ORDER.md`: note the overlap between the specialty registry and Shipwright agent types.
- Later: migrate Saul to `specialist` (needs a deliberate type-change path and a cron-diff dry run).
