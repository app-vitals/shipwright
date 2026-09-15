# Plan: Agent bootstrap fixes

**Session:** `agent-bootstrap-fixes`
**Repo:** `app-vitals/shipwright`

## Problem

Bootstrapping a new agent (Maverick) surfaced three separate defects:

1. **Stale onboarding text.** `agent/workspace/BOOTSTRAP.md.template:15-18` tells a
   newly-provisioned agent its three default crons (`shipwright-dev-task`,
   `shipwright-review`, `shipwright-patch`) run "every 30 min" and "pick up
   approved todos automatically." Both are wrong: the manifest schedule is
   `* * * * *` (every minute), and dispatch is gated behind the
   `shipwright-loop` parent cron, which is explicit-target-only and disabled
   by default — not a self-discovering poller. The sibling `CLAUDE.md.template`
   already got this correction under a prior task (DPF-1.1) and has a
   content-regression test guarding it; `BOOTSTRAP.md.template` was missed in
   that pass and has no such guard, so it silently drifted back to the wrong
   description.

2. **GitHub App credentials require a restart.** `setupGitHubAuth()`
   (`agent/src/setup-github-auth.ts`) only runs once, at process boot
   (`agent/src/entrypoint.ts`, Step 5). The running agent's `syncConfig()` loop
   (`agent/src/index.ts`) does pick up newly-set `GH_APP_ID` /
   `GH_APP_INSTALLATION_ID` / `GH_APP_PRIVATE_KEY` env vars within 60s of a
   GitHub App install, but nothing re-invokes GitHub App auth setup when that
   happens. Slack already solved the identical problem —
   `startSlackIfPossible()` is retried on every `syncConfig()` tick
   (`index.ts` ~391-408) — GitHub App auth has no equivalent, so a freshly
   installed GitHub App silently does nothing until the agent process is
   restarted.

3. **New agents can end up with zero allowed tools.** There are two
   `agentService.create()` call sites: `POST /agents` in `admin/src/agents-api.ts`
   (JSON API) and `POST /admin/agents` in `admin/src/admin-ui.ts` (the "New
   Agent" web form — the actual path used to create Maverick). Path A resolves
   the agent-type manifest and seeds `manifest.tools` / `manifest.plugins` via
   `agentToolService.add()` / `agentPluginService.add()`, rolling back the
   agent on any seeding failure. Path B resolves the manifest only to check
   the type name is valid — `tryGetManifest()`'s result is discarded — and
   never seeds tools or plugins at all. An agent created through the web form
   ends up with zero `AgentTool` rows and falls back to the bare
   `FLOOR_TOOLS` set (`agent/src/claude.ts`): no Bash, no WebSearch, no
   WebFetch, no Agent. This is exactly Maverick's symptom.

## Investigation notes (why the fix is scoped the way it is)

- **No shared-core extraction needed.** `POST /agents` (Path A) has **no
  caller anywhere in this repo** — no Taskfile target, no script, no CI job.
  `task stack`'s dev workflow explicitly points developers at the web form
  (`/admin/agents/new`) instead. The only reference to `POST /agents` outside
  its own implementation/tests is the `agent-admin` skill's docs. A third,
  independent reimplementation of the same manifest-seeding logic already
  exists in `scripts/seed-dev-agent.ts` (raw Prisma upserts for the special
  `dev-agent` bootstrap case) — so the manifest-driven tools/plugins seeding
  pattern has been hand-copied three times, not two.
- **Decision: fix Path B, then retire Path A**, rather than building a shared
  `createAgentWithSeeding()` core both paths call. Since Path A is being
  deleted, none of the cross-path reconciliation work (differing rollback
  semantics, differing validation timing, differing provisioning gates) is
  needed — that complexity only existed because two live paths would
  otherwise have needed to agree.
- **Checked the manifest for surprises before wiring seeding up.**
  `agent-types/coding/manifest.yaml` (the only agent type that exists today)
  has non-empty `tools` (the standard 10-tool set, already documented in
  `docs/agent-ops.md`) and `plugins: [shipwright]` (the one plugin an agent
  needs to run any shipwright command at all). `members: []` and `repos: []`
  are both empty, so seeding those from the manifest is a no-op for the only
  agent type in existence — no risk of surprising a human who fills out the
  form.
- **Plugin string format confirmed correct.** `plugins: [shipwright]` is a
  bare name with no `@marketplace` suffix. `admin/src/api.ts:207-217`
  explicitly defaults a bare name (no `@`) to the `shipwright` marketplace —
  this is the documented, tested contract (`agent/src/agent-plugins.ts`
  docstring, `docs/agent-types.md`'s worked example), not an oversight. The
  fix passes `manifest.plugins` entries through unmodified, exactly as
  `agents-api.ts` already does.

## Design

1. **ABF-1.1** — Correct `BOOTSTRAP.md.template`'s cron description to match
   `CLAUDE.md.template`'s already-fixed language, and add a content-regression
   test so it can't drift back silently a second time.
2. **ABF-2.1** — Give GitHub App auth setup a Slack-style retry inside
   `syncConfig()` so a GitHub App install takes effect on the next config-sync
   tick instead of requiring a pod restart.
3. **ABF-3.1** — Fix `POST /admin/agents` to seed `manifest.tools` and
   `manifest.plugins`, mirroring `agents-api.ts`'s existing loop exactly, with
   the same rollback-on-failure pattern Path B already uses for other
   provisioning failures.
4. **ABF-3.2** — Retire `POST /agents` (agents-api.ts) and the `agent-admin`
   skill's references to it, now that Path B is the sole, fixed creation path.
   Depends on ABF-3.1 (fix before remove — add → fix → remove sequencing, not
   remove-then-fix). **Flagged HITL**: no external caller was found in this
   repo, but the admin service is deployed and could in principle be called
   by something outside this codebase (a personal script, an external
   integration) — removal should not proceed until a human confirms no live
   external caller exists.

## Tasks

| Task | Title | Layer | Hours | Complexity/Model | HITL | Depends on |
|---|---|---|---|---|---|---|
| ABF-1.1 | Fix stale cron description in BOOTSTRAP.md.template + add regression test | Shared | 2 | 2 / sonnet | | — |
| ABF-2.1 | Add GitHub App auth retry to agent's config-sync loop (no-restart activation) | Background | 5 | 4 / sonnet | | — |
| ABF-3.1 | Seed manifest tools + plugins on POST /admin/agents (fix zero-tool bug) | API | 4 | 3 / sonnet | | — |
| ABF-3.2 | Retire POST /agents JSON API + agent-admin skill references | API | 2 | 2 / sonnet | ⚠ HITL | ABF-3.1 |

### Dependency graph

```
[START]
  ├─ ABF-1.1 (no deps)
  ├─ ABF-2.1 (no deps)
  └─ ABF-3.1 (no deps)
        └─ ABF-3.2 ⚠HITL (confirm no external caller before removal)
```

### Breaking-change safety

- ABF-1.1, ABF-2.1, ABF-3.1 are pure additions/fixes — safe to deploy standalone.
- ABF-3.2 removes a documented, external-facing API endpoint
  (`POST /agents`). No consumer was found anywhere in this repo (see
  Investigation notes above), but the admin service is a deployed API and
  could have callers this repo can't see. Sequenced strictly after ABF-3.1
  (fix the surviving path first) and flagged HITL so a human confirms zero
  live external callers before the removal PR merges.

### HITL scan

`ABF-3.2` — removing a documented external API surface based on an
in-repo-only "no caller found" check is a judgment call a human should make,
not something dev-task should decide unilaterally from a grep. Flagged HITL
with a `## Human steps` note. No other task in this plan requires human
steps.
