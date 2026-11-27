<!-- shipwright: session=patrol-system-crons repos=app-vitals/shipwright plan=1 -->
# Patrol System Crons — Plan

## Pass 1 — 2026-11-27 — specs 1

Spec: [PRODUCT-SPEC.md](./PRODUCT-SPEC.md). Repo: `app-vitals/shipwright` (home and sole target). Task prefix: `PCR`.

### Technical design

**Storage rule applied to every artifact.** The task store holds run history, numbers and structured cross-run state, behind APIs that skills call. The repo holds only human-readable detail that any agent working on that repo can read. The agent workspace is local to one agent, so its JSON files are migrated to the task store and then deleted. Nothing repo-resident gets a task-store API: the agent reads and writes the repo locally and opens a PR.

**Task store (core, behind APIs)**
- `RepoCronRun` (PCR-1.1): append-only, one row per per-repo system-cron run. Fills the missing per-repo grain between `SystemCronTrigger` (one row per fired slot, no outcome/commit/metrics) and the task itself. Links via `taskId` and `scheduledFor`. Does not collide with the platform's `AgentCronRun`. `POST /cron-runs`, `GET /cron-runs` (omits `machineState` unless `includeDetail=true`), `GET /cron-runs/latest` (newest `ok`/`no_op`, includes `machineState`, else 404). Server validates `metrics` (finite numbers; auto/review/plan counts are non-negative ints). `machineState` is small non-finding state only (Sentry project-to-repo mapping, page anchors).
- `PatrolFinding` (PCR-1.2): structured cross-run ledger of scan findings, keyed `(accountId, cronId, repo, fingerprint)`, with `status`, `firstSeen`, `lastSeen`, `occurrenceCount`, append-only `history`, `detail` JSON and a nullable `taskId`. Needed because findings exist before and independent of tasks (consolidation tracks patterns for weeks before proposing; suppressed or unmapped findings never become tasks; a closed task does not mean a finding is resolved; error-resolve needs the finding-to-task link). Used by consolidation, security and error; entropy has no per-finding ledger today.
- Create-as-blocked (PCR-1.3): `POST /tasks` and `/tasks/bulk` already accept `status: blocked` plus `blockedReason`, so review-routed tasks can be created blocked in one call. The gap is that `blockedAt` is only stamped by the block endpoints, so the task stamps it server-side on create.
- Four seeded patrol system-cron definitions, disabled (PCR-1.4).

**Plugin (local, thin)**
- Recorder + legacy import script (PCR-2.1): posts exactly one run per invocation (including `failed`), reads prior state, and performs the one-time import of the agent-local legacy file filtered to the repo, then deletes that file after a successful post.
- `patrol-docs` checker (PCR-2.2): local script — 150-line cap, no count tables or run-history section, material-change detection. No API, because the file lives in the repo.
- Skills require `--repo org/repo`, write `docs/patrols/{entropy,consolidation}.md` locally and open a docs PR only on material change (reusing test-readiness's docs-PR path). Security and error write nothing to any repo path; the scan-to-fix handoff goes through the store instead of `*-report.md` files.

**Three-way routing (Feature 7)** — documented once (PCR-2.3), applied by each fix skill: auto (pending dev task), review (dev task created blocked with a `needs-review:` reason, unblocked by a human), plan (`kind: prd`, `hitl: true`), plus the human-only credential-rotation exception. `check-plan.ts` already skips `hitl` tasks; PCR-1.5 only pins it.

**Admin**: read-only per-repo history on the system-crons page (PCR-5.1); never renders `machineState`.

**Cleanup**: PCR-6.1 retires the four `*-patrol-maintenance` agent crons, the three prechecks, and adds a content test that fails if any patrol legacy state reader remains outside the import script. The `docs-last-synced.json` reader is removed by PCR-4.1; site-docs anchors move to run history in PCR-4.3 (the precheck reader and `.claude/commands/docs-sync.md` writer together); refresh-log and count lines leave `docs/test-readiness/*.md` in PCR-4.2.

### Decision Log

- Feature 2 split: one shared-helpers pair (recorder/import and docs checker) plus one task per patrol — chosen over a per-layer split so each PR stays reviewable (Dan).
- Where logic lives: anything task-store-backed sits behind an API; repo-resident files and the agent-local legacy files are handled locally by the plugin. Dropped the `/cron-runs/import` and `/patrols/*` endpoints proposed earlier (Dan).
- Machine state is structured: a `PatrolFinding` table instead of an opaque `machineState` blob; `machineState` shrinks to small non-finding state (Dan).
- `RepoCronRun` is a new table linked to the existing task and trigger, not fields on `Task` (Dan).
- `site-docs-last-synced.json` is migrated too: anything legacy moves to the right home (Dan). Resolved at planning time: the only writer is `.claude/commands/docs-sync.md`, the cron is not wired by default and no anchor file has ever existed, so there is nothing to import (Dan: resolve open items when planning, not in tasks).
- Reader and writer move in one task (PCR-4.3), not two, and it is not HITL: Edit/Write is blocked for `.claude/**` in headless runs, but Bash writes are not covered by that guard, so the dev-task agent applies the `.claude/commands/docs-sync.md` edits with Bash (Dan).
- Create-as-blocked was checked in the code at planning time rather than left to the task: create already accepts blocked + `blockedReason`; only the `blockedAt` stamp is missing (PCR-1.3). `check-plan.ts` was also confirmed to already skip `hitl: true` tasks (PCR-1.5 is test-only).
- `prompt-audit-ledger.json` and `learn-dream-last-run.json` stay out: agent-local by nature, prompt-audit's design is unrelated to this session (Dan).
- Legacy files are deleted after a successful import (Dan).
- Deviation from the spec's Testing Strategy: none beyond the above — recorder, import and docs-checker remain unit-tested as specified.

### Tasks

| Task | Title | Layer | Model | Hours | Depends on |
|---|---|---|---|---|---|
| PCR-1.1 | feat: add RepoCronRun model and cron-runs routes | Database | sonnet | 6 | — |
| PCR-1.2 | feat: add PatrolFinding model and routes | Database | sonnet | 6 | 1.1 |
| PCR-1.3 | feat: stamp blockedAt when creating blocked tasks | API | haiku | 2 | — |
| PCR-1.4 | feat: seed the four patrol system-cron definitions | Background | sonnet | 3 | 1.1 |
| PCR-1.5 | test: pin check-plan skipping hitl prd tasks | Background | haiku | 1 | — |
| PCR-2.1 | feat: add cron-run recorder and legacy import script | CLI | sonnet | 6 | 1.1, 1.2 |
| PCR-2.2 | feat: add patrol-docs cap and material-change checks | CLI | sonnet | 3 | — |
| PCR-2.3 | docs: document the three-way finding routing contract | Shared | haiku | 2 | 1.3 |
| PCR-3.1 | feat: run the entropy patrol per repo with docs/patrols output | CLI | sonnet | 6 | 2.1, 2.2, 2.3 |
| PCR-3.2 | feat: run the consolidation patrol per repo with store-backed ledger | CLI | sonnet | 7 | 2.1, 2.2, 2.3 |
| PCR-3.3 | feat: run the security patrol per repo with store-only detail | CLI | sonnet | 6 | 2.1, 2.3 |
| PCR-3.4 | feat: run the error patrol per repo with Sentry repo filter | CLI | sonnet | 7 | 2.1, 2.3 |
| PCR-4.1 | refactor: move docs-freshness onto the system-cron contract | CLI | sonnet | 4 | 2.1, 2.2, 2.3 |
| PCR-4.2 | refactor: move test-readiness onto the system-cron contract | CLI | sonnet | 6 | 2.1, 2.2, 2.3 |
| PCR-4.3 | refactor: move site-docs anchors from the state file to run history | CLI | sonnet | 5 | 1.1, 2.1 |
| PCR-5.1 | feat: show per-repo run history on the system-crons page | Frontend | sonnet | 4 | 1.1 |
| PCR-6.1 | chore: retire patrol agent crons, prechecks and legacy state readers | Shared | sonnet | 6 | 1.4, 3.1, 3.2, 3.3, 3.4 |

No HITL tasks. No bundles: every task is its own PR and branch.

### Dependency Map

```
[START]
  ├─ PCR-1.1: RepoCronRun model + routes
  │    ├─ PCR-1.2: PatrolFinding model + routes
  │    ├─ PCR-1.4: seed four patrol definitions
  │    ├─ PCR-5.1: admin run-history view
  │    └─ (with 1.2) PCR-2.1: recorder + legacy import
  ├─ PCR-1.3: create-as-blocked
  │    └─ PCR-2.3: routing contract docs
  ├─ PCR-1.5: check-plan hitl prd test
  └─ PCR-2.2: patrol-docs checker

PCR-2.1 + 2.2 + 2.3 ─┬─ PCR-3.1: entropy patrol
                      ├─ PCR-3.2: consolidation patrol
                      ├─ PCR-4.1: docs-freshness contract
                      └─ PCR-4.2: test-readiness contract
PCR-2.1 + 2.3 ───────┬─ PCR-3.3: security patrol
                      └─ PCR-3.4: error patrol
PCR-1.1 + 2.1 ───────── PCR-4.3: site-docs anchors to run history (precheck + docs-sync)

PCR-1.4 + 3.1 + 3.2 + 3.3 + 3.4 ── PCR-6.1: retire agent crons, prechecks, legacy readers
```

Ordering follows the spec: run history first; routing (2.3) lands before or with the patrol skills so the first system-cron runs already route three ways; retirement (6.1) ships only after the patrol skills and seeded definitions merge, so there is never a window with neither path.

### Breaking Change Safety

- Additions are safe standalone: PCR-1.1, 1.2, 1.3, 1.4, 1.5, 2.1, 2.2, 2.3, 5.1 add new tables, routes, scripts or docs. Safe to deploy standalone: yes.
- Skill changes (PCR-3.x, 4.x) switch a patrol from multi-repo/agent-local to per-repo/store-backed. The seeded definitions are disabled, and the agent-level crons keep running until PCR-6.1, so there is no window with neither path. Each skill's legacy-state reader is removed in its own PR, but the legacy file is only consumed through the import step, so an agent that has not yet run the new skill still has its file.
- PCR-6.1 is the only removal. Consumers of the removed crons/prechecks are `coding-specialty-defaults.ts`, `agent-cron-jobs.coding.integration.test.ts` and the docs listed in the task; they update atomically in that one PR. It depends on all four patrol skills and the seeds being merged.
- Site-docs anchors: PCR-4.3 moves the precheck (reader) and the docs-sync command (writer) together (atomic), so they never disagree.

### Spec-Level Carry-Through

Success Criteria and Priorities & Sequence are carried by the task acceptance criteria and dependency edges above (enable-and-run flow: 1.4, 2.1, 3.x, 5.1; legacy import into the store: 2.1 + 3.2; no `*-patrol-maintenance` cron after boot and green `task ci`: 6.1).

Not carried:
- "`task ci` passes" is enforced by the repo merge gate on every PR; PCR-6.1 lists it explicitly only because the prechecks are removed there.
- Operator actions after merge (enabling the patrols on the admin page) are not tasks, per standing guidance that deploy/enable steps are not tracked as follow-up tasks.

### Out of scope and follow-ups

- `prompt-audit-ledger.json` and `learn-dream-last-run.json` stay agent-local; prompt-audit may later warrant its own design (repo-scoped system cron), unrelated to this session.
- `state/reviews.json` and `state/agent-policy.md` are untouched.
- Readiness scoring and floor remediation belong to the `agent-readiness` session.
