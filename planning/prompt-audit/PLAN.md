# Plan: prompt-audit

Repo: app-vitals/shipwright · Spec: planning/prompt-audit/PRODUCT-SPEC.md

## Technical Design

- **Agent:** pure accumulator `run-telemetry.ts` feeds `ClaudeRunResult.telemetry` and the error classes' `partialTelemetry`; `context-stamp.ts` computes the fingerprint; the existing reporter and both dispatchers forward the new fields. Most of this is cherry-picked from `origin/feat/prompt-audit-metrics` (closed PR #3977).
- **Admin (API/DB):** additive nullable columns plus an `AgentCronRunSkillUsage` table in one migration; PATCH upserts `skillUsage` with `modelBreakdown`; stats gain `bySkill` and `baselines`; new admin-only `/outcomes`; `lib/admin-types.ts` hand-synced.
- **Task store:** nullable `lastReviewVerdict`/`lastReviewVerdictAt` on `PullRequest`, written by `review.md`'s record step.
- **Plugin:** pure Bun/TS scripts under `plugins/shipwright/scripts/prompt-audit/` with injected fs/fetch/git/clock; skills and stubs are markdown asserted by content tests; cron ships `enabled: false`.

## Tasks

| Task | Title | Layer | Depends on | h | Cx/Model | HITL |
|---|---|---|---|---|---|---|
| PAU-1.1 | Add 5.x rates and CONTEXT_WINDOW to pricing | Shared | — | 2 | 2/haiku |  |
| PAU-1.2 | Add run-telemetry accumulator and stream wiring | Background | — | 5 | 4/sonnet |  |
| PAU-1.3 | Add context-stamp fingerprint reader | Background | — | 3 | 3/sonnet |  |
| PAU-1.5 | Add admin telemetry columns, skillUsage table and PATCH upserts | Database | — | 6 | 5/opus |  |
| PAU-1.4 | Forward telemetry through reporter, cron-handler and orchestrator | Background | PAU-1.2, PAU-1.3, PAU-1.5 | 5 | 4/sonnet |  |
| PAU-1.6 | Add bySkill and baselines stats and metrics client types | API | PAU-1.5 | 5 | 4/sonnet |  |
| PAU-1.7 | Add /cron-runs/outcomes admin endpoint | API | PAU-1.5 | 4 | 3/sonnet |  |
| PAU-1.8 | Add lastReviewVerdict columns and PR route fields | Database | — | 3 | 3/sonnet |  |
| PAU-1.9 | Write review verdict from review.md record step | Shared | PAU-1.8 | 1 | 1/haiku |  |
| PAU-1.10 | Document Feature 1 metrics in agent docs | Shared | PAU-1.4, PAU-1.6, PAU-1.7 | 2 | 2/haiku |  |
| PAU-2.1 | Verify >= 20 runs per phase of 4.6 baseline exists | Shared | PAU-1.4, PAU-1.6, PAU-1.7 | 1 | 1/haiku | ⚠ HITL |
| PAU-2.2 | Bump default model and pricing aliases to Sonnet 5.5 | Shared | PAU-2.1, PAU-1.1 | 2 | 2/haiku |  |
| PAU-2.3 | Update existing agents' env to Sonnet 5.5 and record cutover | Shared | PAU-2.2 | 1 | 1/haiku | ⚠ HITL |
| PAU-2.4 | Write dated keep/revert decision note | Shared | PAU-2.3, PAU-3.12 | 2 | 1/haiku | ⚠ HITL |
| PAU-3.1 | Add inventory walker and finding fingerprint | CLI | — | 5 | 4/sonnet |  |
| PAU-3.2 | Add count_tokens counter with cache and listing budget | CLI | PAU-1.1 | 3 | 3/sonnet |  |
| PAU-3.3 | Add reference resolver and orphaned-auto-section finder | CLI | PAU-3.1 | 5 | 4/sonnet |  |
| PAU-3.4 | Add instruction-density and blame-age analyzers | CLI | PAU-3.1 | 3 | 3/sonnet |  |
| PAU-3.5 | Add usage attribution from transcripts and admin bySkill | CLI | PAU-3.1, PAU-1.6 | 3 | 3/sonnet |  |
| PAU-3.6 | Add rule functions and thresholds reference | CLI | PAU-3.2, PAU-3.3, PAU-3.4, PAU-3.5 | 6 | 4/sonnet |  |
| PAU-3.7 | Add ledger, report and CLI (scan and measure) | CLI | PAU-3.6 | 6 | 4/sonnet |  |
| PAU-3.8 | Add check-prompt-audit.ts precheck | CLI | PAU-3.7 | 2 | 2/haiku |  |
| PAU-3.10 | Seed .claude/shipwright/prompt-audit-decisions.md | Shared | — | 1 | 1/haiku | ⚠ HITL |
| PAU-3.9 | Add prompt-scan skill, stub, ledger schema and registry instance | Shared | PAU-3.7, PAU-3.10 | 5 | 3/sonnet |  |
| PAU-3.11 | Add disabled prompt-audit-maintenance cron and manifest test | Background | PAU-3.8, PAU-3.9 | 2 | 2/haiku |  |
| PAU-3.12 | Add docs/prompt-audit.md, README, TESTING, CLAUDE.md bullet and design doc | Shared | PAU-3.9, PAU-3.11 | 3 | 2/haiku |  |
| PAU-3.13 | Run bootstrap dry-run and verify the ten findings (exit gate) | CLI | PAU-3.12 | 3 | 2/haiku |  |
| PAU-4.1 | Add prompt-fix skill, stub, content tests and docs | Shared | PAU-3.13 | 5 | 3/sonnet |  |
| PAU-5.1 | Add eval case generation, cost gate and JSON diff | CLI | PAU-3.7 | 5 | 4/sonnet |  |
| PAU-5.2 | Add plugin-eval runner, A/B checkouts and production series | CLI | PAU-5.1, PAU-1.7 | 5 | 5/opus |  |
| PAU-5.3 | Add prompt-eval skill, stub, content tests and docs | Shared | PAU-5.2, PAU-4.1 | 4 | 3/sonnet |  |

## Dependency Map

```
F1: 1.1 · 1.2 · 1.3 · 1.5 · 1.8 (no deps)
    1.5 → 1.4 (also 1.2, 1.3), 1.6, 1.7
    1.8 → 1.9;  1.4+1.6+1.7 → 1.10
F2: 1.4+1.6+1.7 → 2.1 ⚠ → 2.2 (also 1.1) → 2.3 ⚠ → 2.4 ⚠ (also 3.12)
F3: 3.1 → 3.3, 3.4, 3.5 (also 1.6);  1.1 → 3.2
    3.2+3.3+3.4+3.5 → 3.6 → 3.7 → 3.8
    3.10 ⚠ + 3.7 → 3.9;  3.8+3.9 → 3.11;  3.9+3.11 → 3.12 → 3.13
F4: 3.13 → 4.1
F5: 3.7 → 5.1;  5.1+1.7 → 5.2;  5.2+4.1 → 5.3
```

## Breaking Change Safety

All admin and task-store changes are additive and nullable: safe to deploy standalone. PAU-1.4 depends on PAU-1.5 (and PAU-1.9 on PAU-1.8) so the receiving service accepts new fields before senders emit them. PAU-2.2 moves the bare pricing aliases; it ships atomically with its alias test.

## HITL

PAU-2.1 (data gate), PAU-2.3 (agent env cutover), PAU-2.4 (keep/revert judgment), PAU-3.10 (`.claude/**` write).

## Decision Log

- Deploy ordering: defaulted to making the agent forwarder depend on the admin schema task — a stricter admin schema could 400 on unknown fields.
- listingBudget constants: defaulted to a plugin-local window map with a parity test against lib/pricing — plugin is self-contained.
- Layer field for markdown-skill tasks: defaulted to Shared (CLI for scripts); `layer: Docs` is only for prompt-fix generated tasks.
- Design doc: lands on main via PAU-3.12 from the closed branch.
- Seeded registry file: separate HITL task (PAU-3.10) because of the `.claude/**` write block.
- Pricing alias move: atomic with its test in PAU-2.2.
- Root CLAUDE.md Reference bullet: accepted despite the file being over 200 lines.
