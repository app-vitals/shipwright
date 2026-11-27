<!-- shipwright: session=patrol-system-crons repos=app-vitals/shipwright spec=0001 -->
# Patrol System Crons — Product Specification

**Date**: 2026-11-27
**Session**: patrol-system-crons
**Repos**: app-vitals/shipwright
**Status**: Draft

## Overview

Move the entropy, security, consolidation and error patrols off per-agent crons and onto admin-run system crons. Each firing queues one task per repo, the same way docs-freshness and test-readiness work today (SCR-1.5). The agent-local `state/*.json` files go away and their contents split along one rule, the test-readiness pattern:
- **Run history and numbers** go to the task store: when a run happened, its outcome, the commit it scanned, and its counts.
- **Human-readable detail** goes to the repo's docs.
- **Machine state** (ledgers, fingerprints, mappings) lives in the task store as part of the run record, never as JSON in the repo. Security and error-patrol detail stays there entirely, with nothing in the repo.

Any agent can then pick up any repo's patrol task with full history. This is the foundation for the `agent-readiness` session, which adds a readiness score and a floor-raising cron on top.

## Problem Statement

The four maintenance patrols run as agent-level crons that scan every repo an agent has cloned in one long session. Their memory lives in agent-local files: `state/security-patrol-ledger.json`, `state/consolidation-ledger.json`, `state/error-patrol-ledger.json` and `state/entropy-patrol-last-run.json`. Docs-freshness has the same problem with `state/docs-last-synced.json`. Their reports (`entropy-report.md`, `security-report.md`) are written to the clone's root and never committed. Once the admin fans out one task per repo, any agent may claim the task, so agent-local memory means a different, empty history each run. Consolidation is hit hardest: it only proposes a pattern after it has stabilized across several weekly runs. There is also no central record of when each patrol last ran on each repo, or what it found.

## Users & Context

- **Operators** (whoever runs a Shipwright deployment) enable, scope and watch patrols from the admin system-crons settings page, and see per-repo run history there.
- **Coding agents** claim per-repo patrol tasks. They need the repo's prior results no matter which agent ran the last pass.
- **Humans (operators/engineers)** only step in on findings that need judgment: they review and unblock a blocked fix task, or run a plan session for a bigger one (Feature 7).
- **The `agent-readiness` session (next PRD)** reads this run history as input to the readiness score.

---

## Features

### Feature 1: Per-repo cron run history in the task store

**Priority**: High
**Description**: An append-only task-store record of every per-repo system-cron run. It holds run history and numbers, plus each run's `machineState`, which the next run diffs against.

**User Stories**:
- As an operator, I want to see when each patrol last ran on each repo, against which commit, and what it found, so I can trust the patrols are running.
- As a coding agent running security-patrol, I want the previous run's findings, even if another agent ran it, so new and regressed findings are diffed correctly.

**Requirements**:
- New Prisma model (working name `RepoCronRun`), one row per run, append-only:
  - `accountId`, `cronId` (the system-cron definition id), `repo` (`org/repo`), `taskId` (the SC task that ran it, nullable)
  - `startedAt`, `finishedAt`, `commitSha` (HEAD scanned), `outcome` (`ok` | `no_op` | `failed`)
  - `metrics` (JSON numbers, e.g. findings new/open/resolved, tasks filed, phases run)
  - `machineState` (JSON, nullable): whatever the next run needs to diff against, such as ledger entries, fingerprints, sightings and mappings. It is the only home for machine-readable patrol state, and repos never hold JSON state.
  - Indexed on `(accountId, cronId, repo, finishedAt)`.
- `POST /cron-runs` records a run.
- `GET /cron-runs?cronId=&repo=&limit=&cursor=` lists newest-first, with cursor paging per the existing list conventions.
- `GET /cron-runs/latest?cronId=&repo=` returns the newest successful run, or `404`.
- `machineState` is returned only to the writing cron's own reads and to admin tokens. List responses omit it unless `?includeDetail=true` is passed by an admin token or an in-scope agent token.
- Scope: agent tokens read and write only repos in their scope (`403` otherwise) and always their own account. Admin tokens are unrestricted, matching `CoverageSnapshot`.
- OpenAPI updated, and the MCP tool docs regenerated.

**Acceptance Criteria**:
- [ ] Migration adds the model and index. Two POSTs for the same `(cronId, repo)` create two rows, and `/latest` returns the newer `ok` one (integration test).
- [ ] `/latest` skips `failed` runs and returns `404` when there is no `ok`/`no_op` run (smoke test).
- [ ] An agent token POST for an out-of-scope repo returns `403` (smoke test).
- [ ] `GET /cron-runs` omits `machineState` by default and includes it only with `includeDetail=true` (smoke test).

**Technical Considerations**: Append-only removes the concurrent-writer problem entirely: two runs simply produce two rows, and readers take the latest. Mirror `coverage-snapshot-service.ts` and `routes/coverage-snapshots.ts` for scope and account rules. The model name must not collide with the admin's existing `AgentCronRun`.

**Source Map**:
- `app-vitals/shipwright`: `task-store/prisma/schema.prisma`: adds the model
- `app-vitals/shipwright`: `task-store/src/app.ts`: mounts the route
- `app-vitals/shipwright`: `task-store/src/routes/coverage-snapshots.ts`, `task-store/src/coverage-snapshot-service.ts`: patterns to mirror
- `app-vitals/shipwright`: `task-store/openapi.json`, `docs/task-store.md`, `docs/mcp-tools.md`

**Testing Strategy**: Layer: smoke for route contracts (scope, `404`, detail omission). Integration for the service against the test database.

---

### Feature 2: Patrol skills run one repo and split output by the storage rule

**Priority**: High
**Description**: The entropy, security, consolidation and error scan/fix(/resolve) skills take a required `--repo org/repo`. Each run records its history in Feature 1 and writes its detail to the right home.

**User Stories**:
- As a coding agent handed `SC-security-patrol-…-org-repo`, I want `/shipwright:security-scan --repo org/repo` to scan only that repo and diff against the previous run's `machineState`.
- As a maintainer, I want entropy and consolidation findings to arrive as a docs PR I can review, not as a file left on some agent's disk.

**Requirements**:
- Each skill requires `--repo org/repo` and prints a usage message without it. There is no `repos/` multi-repo scan and no precheck fallback (the SCR-1.5 precedent). The clone is found under `repos/` or cloned.
- Every run ends with one `POST /cron-runs` carrying outcome, commit and `metrics`. Numbers live only here, never in the repo.
- **Where detail goes:**

  | Patrol | Prior state read from | Detail written to |
  |---|---|---|
  | entropy | `/cron-runs/latest` (last run, commit, `machineState`) | `docs/patrols/entropy.md` (readable only) |
  | consolidation | `/cron-runs/latest` `machineState` (pattern fingerprints, sightings, first-seen) | `docs/patrols/consolidation.md` (readable patterns only) |
  | security | `/cron-runs/latest` `machineState` | `machineState` only; nothing in the repo |
  | error | `/cron-runs/latest` `machineState` (including the Sentry project-to-repo mapping) | `machineState` only; nothing in the repo |

- **One file per patrol, kept clear and concise:** `docs/patrols/<patrol>.md` is overwritten each run with the current state only: open items, each with a one-line why and the file paths. It has no run history (that's in the task store), no resolved items, no counts, and a hard cap of 150 lines. When open items exceed the cap, it lists the highest-priority ones and says the rest are tracked in the fix tasks.
- Repo docs are committed through a docs PR, the way test-readiness publishes its phase artifacts. A PR is opened only when the content changed materially, never for a timestamp or reordering alone. Repo docs hold detail only, with no count or summary-number tables.
- **One-time import:** when `/latest` returns `404` and the legacy agent-local file holds entries for this repo, import them as the first run's prior state. Security and error entries go to `machineState`. Consolidation entries seed `machineState`. Do this once and log it. The local file is never read again.
- **Error-patrol per repo:** `error-scan --repo` keeps only the Sentry issues whose project-to-repo mapping resolves to this repo. Issues that map to no repo are counted in `metrics` and get no task.
- `--dry-run` keeps today's meaning: a full scan with no run recorded and no PR.
- Fix skills route every finding through the three-way split in Feature 7.
- Follow-on tasks carry `originKind: "cron"` and `originRef` = the patrol's system-cron id.

**Acceptance Criteria**:
- [ ] Each of the 4 scan skills and their fix/resolve skills prints a usage error when `--repo` is missing (content test per skill).
- [ ] No patrol skill reads or writes `state/*-patrol-*.json` or `state/consolidation-ledger.json` except in the one-time import step (content test).
- [ ] The security-scan and error-scan skill bodies never write findings to any repo path (content test asserts there is no repo write path for them).
- [ ] The import helper turns a legacy multi-repo ledger fixture into the single-repo prior state for the named repo and ignores other repos (unit test).
- [ ] The run recorder posts exactly one run per invocation with `outcome` set, including `failed` on error, using an injected fake store (unit test).
- [ ] `error-scan --repo a/b` against a recorded Sentry fixture returns only issues mapped to `a/b` (integration test with recorded fixtures).
- [ ] An unchanged consolidation file produces no PR (unit test on the material-change check).
- [ ] Each patrol writes exactly one file under `docs/patrols/`, never over 150 lines, with no count tables or run-history section (unit test on the renderer with a large finding fixture).

**Technical Considerations**: Add one shared run-recorder and history client in `plugins/shipwright/scripts/`, following `check-helpers.ts` conventions (env auth, injected fetch and clock). Ledger keys in the security and consolidation skills are already namespaced per repo, so the import is a filter. Reuse test-readiness's docs-PR publishing path rather than inventing one.

**Source Map**:
- `app-vitals/shipwright`: `plugins/shipwright/skills/entropy-scan/SKILL.md`, `skills/entropy-fix/SKILL.md`
- `app-vitals/shipwright`: `plugins/shipwright/skills/security-scan/SKILL.md`, `skills/security-fix/SKILL.md`
- `app-vitals/shipwright`: `plugins/shipwright/skills/consolidation-scan/SKILL.md`, `skills/consolidation-fix/SKILL.md`
- `app-vitals/shipwright`: `plugins/shipwright/skills/error-scan/SKILL.md`, `skills/error-fix/SKILL.md`, `skills/error-resolve/SKILL.md`
- `app-vitals/shipwright`: `plugins/shipwright/skills/test-readiness/SKILL.md`: docs-PR publishing pattern to reuse
- `app-vitals/shipwright`: `plugins/shipwright/scripts/check-helpers.ts`: client conventions
- `app-vitals/shipwright`: `docs/consolidation.md`: ledger moves from agent state to `docs/patrols/`

**Testing Strategy**: Layer: content for the skill contracts. Unit for the recorder, the import filter and the material-change check. Integration for the error-scan repo filter on recorded Sentry fixtures.

---

### Feature 3: Seed the four patrol system-cron definitions

**Priority**: High
**Description**: The task store seeds `entropy-patrol`, `security-patrol`, `consolidation-patrol` and `error-patrol` as system-cron definitions, disabled. The admin scheduler fans them out per repo like the existing two.

**Requirements**:
- Seed next to `docs-freshness` and `test-readiness` in `system-cron-service.ts`: disabled, `default` account, missing ids only (never overwrite edits). Schedules stay as today: entropy `0 4 * * 1`, error `0 4 * * *`, security `0 6 * * 1`, consolidation `0 5 * * 1`.
- Each `descriptionTemplate` chains scan, fix (and resolve, for error) with `--repo {repo}` in one task, carrying over the error-patrol prompt's run-all-steps-in-one-session instruction.
- `repoScope` defaults to `all`, and operators narrow it on the existing settings page.

**Acceptance Criteria**:
- [ ] A fresh task store boots with 6 system-cron definitions, the 4 new ones disabled, with the schedules above (integration test).
- [ ] Re-seeding after an operator edits a patrol definition leaves the edit intact (integration test).
- [ ] Firing `security-patrol` for 2 repos creates 2 `SC-security-patrol-…` tasks whose descriptions carry `--repo {that repo}` on every command (integration test).

**Source Map**:
- `app-vitals/shipwright`: `task-store/src/system-cron-service.ts`, `task-store/src/system-cron-service.integration.test.ts`
- `app-vitals/shipwright`: `docs/task-store.md` (System crons section)

**Testing Strategy**: Layer: integration, because seeding and firing hit the task-store database.

---

### Feature 4: Retire the agent-level patrol crons

**Priority**: High
**Description**: Remove the four `*-patrol-maintenance` agent crons and the prechecks only they use. Reconciliation deletes already-seeded rows. `prompt-audit-maintenance` and `learn-dream` stay agent-level.

**Requirements**:
- Remove the four patrol crons from `coding-specialty-defaults.ts`.
- Delete `check-error-patrol.ts`, `check-consolidation-patrol.ts` and `check-patrol-scope.ts` (all used only by these crons) and their tests.
- `reconcileSystemCrons` deletes the four seeded rows from existing coding agents, as SCR-1.5 did.
- Add a `docs/migration.md` entry: patrols are now admin system crons, enable them on the settings page, and agent-local ledgers are imported on each repo's first run.

**Acceptance Criteria**:
- [ ] Coding specialty defaults no longer contain the four patrol crons, and still contain `prompt-audit-maintenance` and `learn-dream` (unit test).
- [ ] Reconciling an agent with the four legacy rows deletes them and leaves its other crons untouched (integration test, mirroring SCR-1.5).
- [ ] `task ci` passes with the prechecks removed.

**Source Map**:
- `app-vitals/shipwright`: `admin/src/coding/coding-specialty-defaults.ts`
- `app-vitals/shipwright`: `admin/src/agent-cron-jobs.coding.integration.test.ts`: deletion-test precedent
- `app-vitals/shipwright`: `plugins/shipwright/scripts/check-error-patrol.ts`, `check-consolidation-patrol.ts`, `check-patrol-scope.ts`
- `app-vitals/shipwright`: `docs/agent-ops.md`, `docs/architecture.md`, `docs/migration.md`, `plugins/shipwright/references/coding-cron-guidance.md`

**Testing Strategy**: Layer: unit for the defaults list. Integration for reconcile deletion.

---

### Feature 5: Bring docs-freshness and test-readiness onto the same contract

**Priority**: High
**Description**: All six system crons follow one contract (see "System-cron contract" under Technical Constraints). docs-freshness and test-readiness already run per repo, but they change wherever they differ.

**Requirements**:
- **Run history:** both record every run through the shared recorder (Feature 2), outcome and metrics included. docs-freshness takes its last-synced point from `/cron-runs/latest?cronId=docs-freshness` (`commitSha` of the last `ok` run) instead of `state/docs-last-synced.json`, with the one-time import rule.
- **Numbers out of the repo:** the refresh logs and count lines in `docs/test-readiness/*.md` (e.g. "N rows added, N removed, N re-verified") and any equivalent docs-freshness summaries move into run `metrics`. The artifacts keep only detail: the inventory rows, blueprint, migration buckets and roadmap tasks.
- **Three-way routing:** `test-fix` and research-docs' A5.5 task filing route findings through Feature 7 (auto / review / plan), replacing their current `hitl: true` "human does it" outcome.
- **Same task shape:** each description template runs the scan step and then the queue-tasks step in one task with `--repo {repo}`. test-readiness's `--publish` stays as the "queue for real" switch.
- **Detail through PRs, only on material change:** both already commit detail to the repo. They adopt the shared material-change check so a run that changes nothing opens no PR.

**Acceptance Criteria**:
- [ ] `research-docs.md` no longer references `state/docs-last-synced.json` except in the import step (content test).
- [ ] Both skill bodies end with a run-record step through the shared recorder (content test).
- [ ] The test-readiness phase skills no longer write refresh-log or count lines into `docs/test-readiness/*.md` (content test). The existing refresh-log blocks are removed from those files in the same PR.
- [ ] `test-fix` and research-docs document the three routes and emit no `hitl: true` tasks (content test).

**Source Map**:
- `app-vitals/shipwright`: `plugins/shipwright/commands/research-docs.md`
- `app-vitals/shipwright`: `plugins/shipwright/skills/test-readiness/SKILL.md`, `test-inventory/SKILL.md`, `test-design/SKILL.md`, `test-migration/SKILL.md`, `test-roadmap/SKILL.md`, `test-fix/SKILL.md`
- `app-vitals/shipwright`: `docs/test-readiness/*.md`: drop refresh-log and count lines
- `app-vitals/shipwright`: `task-store/src/system-cron-service.ts`: align description templates

**Testing Strategy**: Layer: content, because the behavior lives in skill and command prose. The recorder, routing and material-change check are unit/integration-tested in Features 2 and 7.

---

### Feature 6: Run history on the admin system-crons page

**Priority**: Low
**Description**: The admin system-crons settings page shows, per definition, a per-repo table: last run, outcome, commit, and key metrics from the latest run.

**Requirements**:
- Read-only, via `GET /cron-runs`. Never renders `machineState`.
- A repo with no runs shows "never run". A repo whose latest run `failed` is visibly flagged.

**Acceptance Criteria**:
- [ ] The page renders one row per repo with last run and outcome, "never run" for repos with no history, and a failed marker for a failed latest run (smoke test on the admin route).
- [ ] The rendered HTML contains no `machineState` content when the fixture run has one (smoke test).

**Source Map**:
- `app-vitals/shipwright`: `admin/src/coding/admin-ui-system-crons.ts`
- `app-vitals/shipwright`: `admin/src/coding/task-store-fetchers.ts`, `task-store-types.ts`

**Testing Strategy**: Layer: smoke, because it's an in-process admin route render.

---

### Feature 7: Three-way routing of fix findings (auto / review / plan)

**Priority**: High
**Description**: Every `*-fix` skill routes each finding one of three ways, so a human is involved only when judgment is needed and agents still do the execution. This replaces today's `hitl: true` meaning ("a human does the work") for patrol findings.

**User Stories**:
- As an operator, I want unclear fixes to wait for my review and then be executed by an agent once I unblock them, not done by hand.
- As an operator, I want findings too big for one task to arrive as a plan task I can run through a normal plan session.

**Requirements**:
- **Auto (obvious fix):** a `kind: dev`, `status: pending`, `hitl: false` task. Agents scoped to the repo execute it through the normal loop.
- **Review (non-obvious fix):** a `kind: dev` task created in `status: blocked`, with a `blockedReason` holding the specific question for the human, prefixed `needs-review:`. A human unblocks it with the existing `POST /tasks/{id}/unblock` (optionally editing the description first), and agents execute it. It must not be `hitl: true`.
- **Plan (bigger than one task):** a `kind: prd`, `hitl: true` task whose description is a draft problem statement plus the findings. The autonomous plan phase must skip it. A human runs it through `/shipwright:prd` or `/shipwright:plan-session`, which produces agent-executable tasks.
- **Human-only (exception):** security-fix's credential rotation/revocation findings keep today's `hitl: true` route to `/shipwright:hitl`, because no agent can rotate a credential.
- Each fix skill documents its routing criteria: what makes a finding auto, review or plan. The current per-finding HITL criteria map to review, and multi-PR or architectural findings (e.g. consolidation's strangler-fig plans spanning several PRs) map to plan.
- Every routed task carries `originKind: "cron"` / `originRef` and the repo, and the run's `metrics` count auto/review/plan separately.

**Acceptance Criteria**:
- [ ] Each of entropy-fix, security-fix, consolidation-fix and error-fix documents the three routes and their criteria, and no longer emits `hitl: true` except security-fix's credential route (content test per skill).
- [ ] A review-routed task lands in the store as `status: blocked` with a `needs-review:` `blockedReason`, is absent from `?ready=true`, and after `POST /tasks/{id}/unblock` appears in `?ready=true` (integration test against the task store).
- [ ] The autonomous plan phase's candidate provider (`check-plan.ts`) skips a `kind: prd`, `hitl: true` task (unit test).
- [ ] A run that routes 2 auto, 1 review and 1 plan finding records `metrics` with those three counts (unit test on the recorder).

**Technical Considerations**: If `POST /tasks` cannot create directly into `blocked` with a reason, add that (preferred) rather than create-then-block, so a task is never briefly ready. Check whether `check-plan.ts` already filters `hitl`. If not, add the filter, because without it an enabled autonomous plan phase would plan these unattended.

**Source Map**:
- `app-vitals/shipwright`: `plugins/shipwright/skills/entropy-fix/SKILL.md`, `security-fix/SKILL.md`, `consolidation-fix/SKILL.md`, `error-fix/SKILL.md`
- `app-vitals/shipwright`: `task-store/src/routes/tasks.ts`: create-as-blocked support if missing
- `app-vitals/shipwright`: `agent/src/coding/check-plan.ts`: skip `hitl` prd tasks
- `app-vitals/shipwright`: `plugins/shipwright/skills/task-store/SKILL.md`: document the three routes
- `app-vitals/shipwright`: `docs/task-store.md`

**Testing Strategy**: Layer: content for the skill routing rules. Integration for blocked-create and unblock against the task store. Unit for the check-plan filter and the metrics counts.

---

## Technical Constraints

**System-cron contract (all six: docs-freshness, test-readiness, entropy, security, consolidation, error):**
1. One task per repo from the admin scheduler, with `--repo {repo}` required. There is no multi-repo mode and no agent-level cron.
2. One task runs the scan step, then the queue-tasks step.
3. Every run records one `RepoCronRun` with outcome, commit and metrics. All numbers live there.
4. Human-readable detail goes to one concise repo doc per cron, through a PR, only on material change, with no count tables. Machine state goes to the run record's `machineState` and never into a repo file. Security and error detail stays out of the repo entirely.
5. Every queued finding is routed auto / review / plan (Feature 7). `hitl: true` is used only for credential rotation.
6. No agent-local `state/` files after the one-time import.
7. Seeded disabled. Operators enable and scope them on the admin system-crons page.


- Any future system cron must meet the contract above. Plan-session should treat the contract as acceptance criteria for any new cron task.
- Follow the SCR system-cron model exactly: the task store holds definitions and claims slots, and the admin `system-cron-scheduler` fires them. No new scheduler.
- The plugin stays repo-agnostic. Skills reach the store only through `SHIPWRIGHT_TASK_STORE_URL`/`TOKEN`.
- Test isolation rules apply: injected clock and fetch, recorded fixtures for Sentry and the task store, no `mock.module()` or global overrides.
- Public-repo hygiene: no client names, internal hosts or org-specific ids in seeds, fixtures or docs. Security and error detail never enters any repo.
- No finding may become auto-routed that today's per-finding HITL criteria would have sent to a human; those become review or plan, never auto.
- Follow the storage rule in Resolved Decisions for every new artifact.

## Scope

**In Scope**:
- The `RepoCronRun` model and routes. The four patrols move to per-repo system crons with required `--repo`. The detail split (repo docs for entropy and consolidation, private store detail for security and error). Three-way routing of fix findings (auto / review / plan). One-time legacy import. Agent-level patrol crons and prechecks removed. docs-freshness and test-readiness brought fully onto the shared contract (run history, numbers out of repo docs, three-way routing). Read-only history view in admin.

**Out of Scope**:
- `prompt-audit-maintenance` and `learn-dream`: they stay agent-level, because they audit the plugin's own prompts and the agent's own transcripts.
- Moving `docs/test-readiness/*.md`, plans, specs or decisions registries out of the repo (only their count/refresh-log lines move).
- New patrol types, readiness scoring and floor remediation (the `agent-readiness` session).
- Changing schedules, finding classification or fix behavior.
- Per-repo schedule overrides (repoScope is enough).

## Priorities & Sequence

1. Feature 1 (run history) comes first, because everything records into it.
2. Feature 2 (skills) and Feature 3 (seed definitions) run in parallel once Feature 1 lands.
3. Feature 4 (retire agent crons) ships after Features 2 and 3 merge, so there is never a window with neither path.
4. Feature 7 (routing) ships with or before Feature 2, so the first system-cron runs already route three ways.
5. Feature 5 depends on Features 1, 2 (shared recorder) and 7 (routing). Feature 6 depends on Feature 1 and comes last.

## Testing Strategy

| Feature | Layer | Rationale |
|---------|-------|-----------|
| 1. Run history store | smoke + integration | Route contracts plus a DB-backed service |
| 2. Skills per repo + detail split | content + unit + integration | Prose contracts, a pure recorder/import/material-change check, and a Sentry repo filter on recorded fixtures |
| 3. Seed definitions | integration | Seeding and firing hit the task-store DB |
| 4. Retire agent crons | unit + integration | Defaults list is pure; reconcile deletion hits the admin DB |
| 5. docs/test-readiness on the contract | content | Behavior lives in skill and command prose |
| 6. Admin history view | smoke | In-process admin route render |
| 7. Three-way routing | content + integration + unit | Skill routing prose, blocked-create/unblock against the store, plan-phase filter and metrics |

## Resolved Decisions

- **Storage rule (applies to this and later sessions)**: The **task store holds run history, numbers and all machine state**: when, outcome, commit, counts and metrics, plus `machineState` (ledgers, fingerprints, mappings). The **repo holds only human-readable detail** in docs: one concise file per patrol, plans, specs, `docs/test-readiness/*.md`, suppressions and decisions registries. It has no count tables and no JSON state files. **Exception:** security and error-patrol detail never enters the repo at all. — Rationale: Dan, 2026-11-27: "follow what we do for test readiness… run history in the task store, details in the repo docs"; "counts… feel more like task store numbers"; "why do we need json if we have the task store?" Security findings in a public repo would disclose unfixed vulnerabilities, and Sentry stack traces can carry user data.
- **Run history shape**: Append-only, one row per run. — Rationale: Gives operators and the readiness score real history rather than only latest state, and removes concurrent-overwrite risk without version locking.
- **Repo detail location**: One concise file per patrol, `docs/patrols/<patrol>.md`, holding current open items only and capped at 150 lines. All machine-readable tracking (e.g. consolidation's fingerprints and sightings) lives in the run record's `machineState`, never as JSON in the repo. Committed through a docs PR only on material change. — Rationale: Dan, 2026-11-27: "a file per scan seems likely to just generate noise for agents… one file per patrol that we keep clear and concise." History stays in the task store.
- **Error-patrol shape**: One task per repo, filtering Sentry issues by the derived project-to-repo mapping. Unmapped issues are counted, not tasked. — Rationale: Dan, 2026-11-27.
- **Schedules and enablement**: Keep today's schedules and seed disabled. — Rationale: Dan accepted defaults, 2026-11-27. Same as SCR-1.5, and nothing changes until an operator opts in.
- **Task shape**: Scan, fix (and resolve) chained in one task. — Rationale: The fix step needs the scan's fresh findings.
- **Human guard = three-way routing**: Auto: pending, agent executes. Review: created blocked, human unblocks, agent executes. Plan: `kind: prd` + `hitl`, human runs a plan session, agents execute the result. `hitl: true` "human does the work" stays only for credential rotation. — Rationale: Dan, 2026-11-27: non-obvious fixes go to blocked so a human can review and unblock for agents; bigger ones become a hitl plan task run through a standard plan session.
- **Consistency across system crons**: All six system crons follow one contract, and docs-freshness and test-readiness change wherever they differ. — Rationale: Dan, 2026-11-27: "We want consistency across all system crons. If test readiness and docs crons need to change then they should."
- **Legacy state**: Imported once per repo on first run, then ignored. — Rationale: Keeps consolidation's multi-week history and security/error suppressions across the cutover.

## Success Criteria

- An operator enables `security-patrol` on the admin settings page, and the next slot queues one task per in-scope repo. Any coding agent completes them, and the admin page shows each repo's run (time, outcome, commit) with no `state/*.json` written and no security detail in any repo. An unclear finding shows up blocked with its question, and after a human unblocks it an agent opens the PR.
- After the first `consolidation-patrol` run on a repo, its run record's `machineState` contains the patterns from that repo's legacy agent-local ledger, and `docs/patrols/consolidation.md` lists the open ones.
- No coding agent has a `*-patrol-maintenance` cron after its next boot, and `task ci` is green.
