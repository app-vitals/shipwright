# Plan: agent-readiness

## Pass 1 — 2026-11-28 — specs 1

**Home repo**: app-vitals/shipwright (sole target). Builds on `patrol-system-crons`, which has landed (`RepoCronRun`, recorder, system-cron contract).

### Technical design

**Readiness model and scorer (Features 1, 2).** One TypeScript catalogue module in `plugins/shipwright/scripts/` is the source of truth for the 28 checks (id, level, title, one owner). A pure `computeLevel` returns the highest N where every check at levels 1..N passes (`n/a` counts as pass; 0 if a Level 1 check fails). `docs/readiness.md` lists the same checks and a content test fails on drift; a banned-word content test keeps competitor names out of every file this session adds. Detectors are pure functions of repo files, the GitHub settings API and task-store run history, and are split by what they read: file-based (checkout) and GitHub/run-history. Toolchain-aware detectors reuse plan-session/prd toolchain detection and fall back to `n/a`. The `agent-readiness` skill runs the deterministic scorer (no LLM scoring), posts one `ReadinessSnapshot` and one `RepoCronRun` (`metrics: {}`), queues no tasks and writes no repo files.

**Storage (deviation from spec, approved by Dan).** The spec put `{level, checks}` in `RepoCronRun.metrics`, but `validateMetrics` (`task-store/src/repo-cron-run-service.ts:101`) accepts only an object of finite numbers, and `machineState` is documented for small carry-over state, not run output. Readiness is a measurement of a repo at a commit, like coverage, so it gets a dedicated `ReadinessSnapshot` model modelled on `CoverageSnapshot`: one row per (account, repo, commit), upserted by commit, typed `level`/`passing`/`failing` columns, a `checks` JSON array of `{id, level, result, owner}` with a zod schema, and `POST /readiness-snapshots`, `GET /readiness-snapshots`, `GET /readiness-snapshots/latest`. `RepoCronRun` stays for run history and the system-cron contract (a failed run leaves no snapshot), with `metrics: {}` (an empty object passes validation; no contract change).

**Owners (Feature 3).** Entropy gains a fixed baseline of built-in tooling checks (linter, formatter, type checker, pre-commit, CI lint/type) in `entropy-scan`/`entropy-fix`, routed auto (add matching config, hooks, wire into CI) or review (stricter mode that may break the build); findings go in `docs/patrols/entropy.md`. A new `environments` system cron (`environments-scan` + `environments-fix`, modelled on entropy and test-readiness, seeded disabled, `0 3 * * 1`) owns lockfile, tool versions, preview environment, structured logging, error tracking, tracing/metrics and staged/canary deploy, routed auto / review / plan, with `docs/patrols/environments.md` capped at 150 lines. The plan task for a missing preview environment models Shipwright's own (`docs/preview-environment.md`).

**Summary API and display (Features 4, 5).** `GET /readiness/summary` reads `ReadinessSnapshot`: `percentAtOrAboveFloor` (Level 3+), `repoCount`, `levelDistribution` (0-5), per-repo latest level + failing checks with owner + `scoredAt`, and a 12-week `trend` (each week's latest snapshot per repo). Repos whose latest snapshot is over 7 days old are `stale` and excluded from the percentage. Agent tokens see only their repos; admin sees all. Each failing check carries `ownerRunning`, computed server-side from the system-cron table (owner disabled or not scoped to the repo = false), so the metrics service does not fetch cron config. **Deviation from spec (approved by Dan):** the display is a "Readiness by repo" section on the metrics dashboard next to "Coverage by repo", fed by a new `/metrics/readiness` route over the task-store summary, instead of a new admin page. Flagged checks show "no owner running"; the section is authenticated-only.

**Breaking change scan.** Everything is additive (new table, routes, skills, seeds, docs, dashboard section). No renames or removals; every task is safe to deploy standalone. Seeds only insert missing ids and ship disabled.

**Testing.** Unit for catalogue/level/detectors/renderer; content for doc sync, banned words and skill contracts; integration for the scorer, the new table/trend aggregation and cron routing against fixture repos; smoke for the routes and the dashboard section.

### Tasks

| Task | Title | Layer | Model | Complexity | Depends on |
|------|-------|-------|-------|-----------|------------|
| RDY-1.1 | feat: add readiness catalogue, level calculation and docs page | Shared | sonnet | 3 | — |
| RDY-1.2 | feat: add ReadinessSnapshot model and routes | Database | sonnet | 4 | — |
| RDY-2.1 | feat: add file-based readiness detectors | Shared | sonnet | 4 | 1.1 |
| RDY-2.2 | feat: add GitHub-settings and run-history readiness detectors | Shared | sonnet | 4 | 1.1 |
| RDY-2.3 | feat: add agent-readiness scorer, skill and seeded cron | CLI | sonnet | 4 | 1.2, 2.1, 2.2 |
| RDY-3.1 | feat: add built-in tooling checks to entropy scan and fix | CLI | sonnet | 3 | 1.1 |
| RDY-3.2 | feat: add environments-scan skill, doc renderer and seeded cron | CLI | sonnet | 4 | 1.1 |
| RDY-3.3 | feat: add environments-fix skill | CLI | sonnet | 3 | 3.2 |
| RDY-4.1 | feat: add GET /readiness/summary | API | sonnet | 4 | 1.2, 2.3 |
| RDY-5.1 | feat: add readiness section to metrics dashboard | Frontend | sonnet | 3 | 4.1 |

### Dependency Map

```
[START]
  ├─ RDY-1.1: catalogue + level calc + docs (no deps)
  │     ├─ RDY-2.1: file-based detectors
  │     ├─ RDY-2.2: GitHub/run-history detectors
  │     ├─ RDY-3.1: entropy tooling checks
  │     └─ RDY-3.2: environments-scan + seed
  │           └─ RDY-3.3: environments-fix
  └─ RDY-1.2: ReadinessSnapshot model + routes (no deps)
RDY-1.2 + 2.1 + 2.2 ── RDY-2.3: scorer, skill, seed
RDY-1.2 + 2.3 ── RDY-4.1: summary API
RDY-4.1 ── RDY-5.1: dashboard section
```

| Task | Depends on | Blocks | HITL |
|------|-----------|--------|------|
| RDY-1.1 | — | 2.1, 2.2, 3.1, 3.2 | |
| RDY-1.2 | — | 2.3, 4.1 | |
| RDY-2.1 | 1.1 | 2.3 | |
| RDY-2.2 | 1.1 | 2.3 | |
| RDY-2.3 | 1.2, 2.1, 2.2 | 4.1 | |
| RDY-3.1 | 1.1 | — | |
| RDY-3.2 | 1.1 | 3.3 | |
| RDY-3.3 | 3.2 | — | |
| RDY-4.1 | 1.2, 2.3 | 5.1 | |
| RDY-5.1 | 4.1 | — | |

HITL scan: no tasks require human steps. All tasks are `Safe to deploy standalone: yes`.

Not carried: `task ci` green (the merge gate enforces it); "owners fix a failing repo and its next score rises" (depends on an operator enabling the crons, not a task).

## Decision Log

- Storage: `ReadinessSnapshot` table instead of `RepoCronRun.metrics` — numbers-only validator, `machineState` documented for carry-over state (Dan).
- `RepoCronRun`: kept, `metrics: {}`, for run history and the system-cron contract (Dan).
- Display: metrics dashboard section instead of a new admin page (Dan). `ownerRunning` computed in the task-store summary so the metrics service needs no cron config.
- Task prefix `RDY` (`AGR` taken). Owner left as the spec's owner.
