# Plan Session: agent-platform-plugin

Repo: app-vitals/shipwright (tasks also touch app-vitals/agent and app-vitals/specialists)

## Background

Specialists are rebasing onto the bare platform image (`ghcr.io/app-vitals/agent`) and no
longer inherit `plugins/shipwright`. The platform image ships no Claude plugin, so
specialists lose the Shipwright-flavoured agent skills that talk to the admin API and the
Slack harness. Dan's direction: move the agent-facing, Shipwright-related part of the
plugin into `app-vitals/agent` so every consumer gets it.

## Scope

Moves to a new `agent-platform` plugin in `app-vitals/agent`:

- `agent-admin` skill (generic rewrite; coding-cron guidance stays in shipwright)
- `slack-say` skill + `scripts/slack-say.ts` + its unit test
- a generic `investigate-cron` skill: the name+time flow, i.e. cron lookup via the admin
  cron-runs API, transcript extraction, Sentry cross-check, verified/inferred synthesis

Stays in shipwright:

- a stuck-item investigation skill (`investigate-stuck`): the existing `--item` flow, i.e.
  work-queue snapshot, task-store PR/task records, live GitHub diff. It delegates run lookup,
  transcript and Sentry to `agent-platform:investigate-cron`. Dan plans to expand it later
  to cover why a task or PR is stuck; this plan only re-homes what exists.
- `login-identity.ts` and the review/patch/merge scripts (not agent-platform material)

Explicitly deferred: `learn` / `learning-capture` / `learn-dream`. They overlap with the
specialists memory service; APP-6.1 writes the recommendation before anything moves.

## Findings

- `slack-say` has no callers outside docs (README, user-guide); removal breaks nothing.
- `agent-admin` hard-codes `shipwright:check-*` preChecks and a coding-specialty-defaults
  path in its examples.
- The `investigate-cron-overhaul` session (IC-1.1 to IC-1.4) is fully deployed, so nothing is
  unfinished. The seam is clean: the cron-runs API (`phaseId`, `itemId`, `parentCronId`) is
  in the platform admin; the work-queue API is shipwright coding admin
  (`admin/src/coding/`).
- Baked marketplaces under `/opt/shipwright/marketplaces/<name>/` are registered at boot,
  but registration does not install: the `AgentPlugin` table selects plugins. Default
  activation is therefore its own task (APP-1.4).

## Design

New `plugins/agent-platform/` in `app-vitals/agent` with its own marketplace manifest
(marketplace `app-vitals-agent`), a `COPY --chown=1000:1000` in `runtime/Dockerfile` into
`/opt/shipwright/marketplaces/app-vitals-agent/`, and the base-image contract smoke test and
boundary gate updated together. Skills are namespaced `agent-platform:*`.

Cross-repo sequence (additive, then migrate, then contract):

1. Expand (agent): APP-1.1 to 1.4.
2. Release gate: APP-2.1 waits for the platform release.
3. Migrate: APP-3.1 (shipwright enables the plugin, bumps the pin), APP-3.2 (specialists
   bumps BASE_TAG and verifies).
4. Contract (shipwright): APP-4.1 removes `agent-admin` and `slack-say`; APP-4.2 replaces
   `investigate-cron` with `investigate-stuck`. Both depend on APP-3.1 being deployed.

## Tasks

| Task | Repo | Depends on | Summary |
|---|---|---|---|
| APP-1.1 | agent | none | Scaffold plugin, marketplace, Dockerfile COPY, contract tests, `slack-say` |
| APP-1.2 | agent | 1.1 | Generic `agent-admin` skill |
| APP-1.3 | agent | 1.1 | Generic `investigate-cron` skill |
| APP-1.4 | agent | 1.1 | Default activation for platform agents |
| APP-2.1 | shipwright | 1.1-1.4 | Release gate |
| APP-3.1 | shipwright | 2.1 | Enable plugin for coding agents, bump pin |
| APP-3.2 | specialists | 2.1 | Bump BASE_TAG, verify skills in image |
| APP-4.1 | shipwright | 3.1 | Remove `agent-admin` + `slack-say` |
| APP-4.2 | shipwright | 3.1 | `investigate-stuck` replaces `investigate-cron` |
| APP-6.1 | shipwright | none | learn vs memory overlap recommendation |

## Breaking Change Safety

- Removing the `agent-admin`, `slack-say` and `investigate-cron` skills (`/shipwright:<name>`)
  is a removal of skill names. Consumers: README, `references/user-guide.md`, cron prompts
  and agent memory/docs that cite `shipwright:agent-admin`. APP-4.1 and APP-4.2 each grep for
  consumers and update them in the same PR (atomic), and both run only after APP-3.1 is
  deployed, so no agent is left without the replacement.
- `shipwright:check-*` preCheck names in cron configs are unaffected (those scripts stay).

## Decision Log

- Plugin name: defaulted to `agent-platform` (marketplace `app-vitals-agent`), since `agent` is
  too generic (Dan, fine with other options).
- Default activation: defaulted to on for platform-built agents, because `slack-say` is inert
  without Slack env vars and `agent-admin` is gated by the agent's API key. Revisit in APP-1.4
  if the seam makes opt-in per specialty cleaner.
- `investigate-cron` split: generic name+time flow moves; item flow stays as `investigate-stuck`
  (new name defaulted to avoid two same-named skills across plugins).
- learn/memory: deferred to APP-6.1.
