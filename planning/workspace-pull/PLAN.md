# Plan: Agent Workspace Pull

**Session:** `workspace-pull`
**Repo:** `app-vitals/shipwright`

## Problem

Dan (co-founder) wants to run HITL (human-in-the-loop) tasks from the real, remote
task store locally, using local infra/resources a cloud-deployed agent doesn't have
access to. Today there is no way to stand up a local workspace that mirrors a specific
agent actually running in the remote k8s cluster — `scripts/hitl.ts` boots its own
local Postgres-backed task-store/admin and a throwaway `"hitl"` agent, which is a
different (and heavier) shape than "give me a local checkout of what agent X already
has, so I can drive `claude` against the real remote task store myself."

## Design

A new standalone script, `scripts/agent-workspace-pull.ts`, provisions a local
workspace mirroring a real remote agent — without running that agent's loop.

**Business logic / CLI:**
- Takes the target agent's id or name as a **required positional CLI argument**
  (`bun scripts/agent-workspace-pull.ts <id-or-name>`) — not an env var, so it can be
  re-run for multiple agents without re-exporting anything between runs.
- Resolves the argument against `GET /agents` (admin API, using `SHIPWRIGHT_API_URL` +
  `SHIPWRIGHT_ADMIN_API_KEY`) — matches by id first, then by name.
- Fetches the resolved agent's config bundle via the existing
  `HttpShipwrightRuntimeClient.getAgentConfigBundle()` (`agent/src/shipwright-runtime-client.ts`) —
  returns `repos`, `plugins`, `allowedTools`, `authorAllowlist`, `env`.
- Workspace root is **always keyed by the resolved agent name, never the raw id**:
  `${SHIPWRIGHT_WORKSPACE_PULL_ROOT:-~/.shipwright-agents}/<name>`.
- Scaffolds the workspace via the existing `ensureAgentHome()` (`agent/src/setup.ts`) —
  the same function a real cloud agent runs on boot: `repos/`, `worktrees/`, `.claude/`,
  `state/`, `CLAUDE.md`, `VOICE.md`, `SOUL.md`, `IDENTITY.md`, `state/agent-policy.md`.
- Clones every repo in the config bundle's `repos` list into `workspace/repos/` via
  `gh repo clone`, skipping repos already present — relies on the operator's own local
  `gh auth login`, not the agent's own `GH_TOKEN`.
- Installs the config bundle's `plugins` via the existing `installPlugins()`
  (`agent/src/setup.ts`), which already accepts an `agentPlugins: AgentPlugin[]` param.
- Prints the resolved workspace path plus the env vars still needed for local `claude`
  invocations (`SHIPWRIGHT_REPO_DIR`, `SHIPWRIGHT_WORKTREE_DIR`) — leaves
  `SHIPWRIGHT_TASK_STORE_URL`/`SHIPWRIGHT_TASK_STORE_TOKEN` exactly as the operator
  already has them exported; the script never touches task-store auth.
- Never writes the config bundle's `env` field to disk. If it contains secret-flagged
  entries, the script warns with the key names only, never the values.

**Refactor:** `computeMissingClones` currently lives only inside `scripts/hitl.ts`.
Extracted to `scripts/lib/clone-plan.ts` so the new script imports a shared helper
instead of reaching into another script file. Pure move, no behavior change.

**Explicitly out of scope:** no dispatch loop (operator drives `claude` themselves,
one task at a time), no local task-store/admin services, no task-store token
minting/rotation, no changes to the real remote agent's own K8s deployment.

**Assumption flagged and confirmed with Dan:** the config bundle has no `policy`
field, so `state/agent-policy.md` is always seeded from the static default template —
the mirrored workspace matches the real agent's repos/plugins, not its live autonomy
settings.

**APIs:** no new endpoints — consumes two existing admin endpoints (`GET /agents`,
`GET /agents/:id/config`), both already implemented and already used by
`scripts/hitl.ts` (list) and the real agent runtime (config bundle).

**DB:** none. **Views/UX:** none — CLI only.

### Test strategy

- **Unit** (`scripts/agent-workspace-pull.unit.test.ts`): agent resolution by id vs.
  name, including no-match/ambiguous cases; the `<root>/<name>` workspace-path builder.
- **Integration** (`scripts/agent-workspace-pull.integration.test.ts`): the script's
  HTTP calls (agent list + config bundle fetch) against an injected fake fetch, per the
  repo's recorded-fixture-double convention — no `global.fetch` override.
- **Relocated, not duplicated:** `computeMissingClones`'s existing test coverage moves
  from `hitl.unit.test.ts` to `scripts/lib/clone-plan.unit.test.ts` (same assertions).
- No smoke/e2e — CLI-only, no HTTP server or browser surface.

## Tasks

| Task | Title | Layer | Hours | Complexity/Model | HITL | Depends on |
|---|---|---|---|---|---|---|
| AWP-1.1 | Build `scripts/agent-workspace-pull.ts` (+ extract `clone-plan.ts`) | CLI | 5 | 3 / sonnet | | — |
| AWP-1.2 | Wire `task agent-workspace-pull` + docs | Shared | 1 | 1 / haiku | | AWP-1.1 |

### Dependency graph

```
[START]
  └─ AWP-1.1: Build scripts/agent-workspace-pull.ts (no deps)
        └─ AWP-1.2: Wire task target + docs (needs 1.1)
```

### Breaking-change safety

Both tasks are pure additions plus one internal, single-consumer refactor
(`computeMissingClones` relocation, fully contained within AWP-1.1). No renames or
removals with external consumers, no schema changes. Both tasks: safe to deploy
standalone.

### HITL scan

No tasks matched the Type A keyword heuristic or judgment step — this is a CLI script
consuming already-implemented, already-authenticated admin endpoints with credentials
the operator already holds. `HITL scan: no tasks require human steps.`
