# Plan: prompt-audit

Repo: app-vitals/shipwright · Spec: planning/prompt-audit/PRODUCT-SPEC.md

## Technical Design

- **Agent:** pure accumulator `run-telemetry.ts` feeds `ClaudeRunResult.telemetry` and the error classes' `partialTelemetry`; `context-stamp.ts` computes the fingerprint; the existing reporter and both dispatchers forward the new fields. Most of this is cherry-picked from `origin/feat/prompt-audit-metrics` (closed PR #3977).
- **Admin (API/DB):** additive nullable columns plus an `AgentCronRunSkillUsage` table in one migration; PATCH upserts `skillUsage` with `modelBreakdown`; stats gain `bySkill` and `baselines`; new admin-only `/outcomes`; `lib/admin-types.ts` hand-synced.
- **PR outcomes (no core-loop change):** no new `PullRequest` columns and no edit to `review.md`. PR outcome series (reviewState mix, `reviewCycles`, `patchCycles`, time to merge) are aggregated read-only from existing `PullRequest` fields. `review.md` never issues REQUEST_CHANGES, so a verdict column would only ever hold APPROVE/COMMENT, which `reviewState` (`approved` / `posted`) already encodes. The agent-side `pr-state-reconciler` was evaluated and rejected as the host (poll-only, skips `approved` records, `reviews(first: 50)` can miss the latest review, adds GraphQL load).
- **Safety model for automated prompt edits:** `prompt-scan` embeds a deterministic blast-radius report (referrers, cron prompts, pinning content tests, source-map pages, load class) in every finding; `prompt-fix` derives `hitl` from that report, not from judgment, and ships propose-only (every task `hitl: true`) until a human promotes a rule in the decisions registry. A post-merge watch compares the before/after fingerprint series and flags regressions; nothing auto-reverts or auto-merges.
- **Eval tier is gated by calibration:** quality claims are impossible until a human-signed calibration record exists (known-bad variants flagged, A/A no-op not flagged, minimum detectable effect stated). Mechanical graders, paired cases, multiple seeds.
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
| PAU-1.8 | Add read-only PR outcome aggregates from existing PullRequest fields | API | PAU-1.7 | 4 | 3/sonnet |  |
| PAU-1.10 | Document Feature 1 metrics in agent docs | Shared | PAU-1.4, PAU-1.6, PAU-1.7, PAU-1.8 | 2 | 2/haiku |  |
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
| PAU-3.14 | Add reverse-reference blast-radius analyzer | CLI | PAU-3.1, PAU-3.3 | 5 | 4/sonnet |  |
| PAU-3.7 | Add ledger, report and CLI (scan, measure, blast) | CLI | PAU-3.6, PAU-3.14 | 6 | 4/sonnet |  |
| PAU-3.8 | Add check-prompt-audit.ts precheck | CLI | PAU-3.7 | 2 | 2/haiku |  |
| PAU-3.10 | Seed .claude/shipwright/prompt-audit-decisions.md | Shared | — | 1 | 1/haiku | ⚠ HITL |
| PAU-3.9 | Add prompt-scan skill, stub, ledger schema and registry instance | Shared | PAU-3.7, PAU-3.10 | 5 | 3/sonnet |  |
| PAU-3.11 | Add disabled prompt-audit-maintenance cron and manifest test | Background | PAU-3.8, PAU-3.9 | 2 | 2/haiku |  |
| PAU-3.12 | Add docs/prompt-audit.md, README, TESTING, CLAUDE.md bullet and design doc | Shared | PAU-3.9, PAU-3.11 | 3 | 2/haiku |  |
| PAU-3.13 | Run bootstrap dry-run and verify the ten findings (exit gate) | CLI | PAU-3.12 | 3 | 2/haiku |  |
| PAU-4.1 | Add propose-only prompt-fix skill with deterministic hitl and guardrails | Shared | PAU-3.13, PAU-3.14 | 6 | 4/sonnet |  |
| PAU-4.2 | Add post-merge regression watch (cli.ts watch) | CLI | PAU-3.7, PAU-1.7, PAU-1.8 | 4 | 3/sonnet |  |
| PAU-5.1 | Add paired eval case builder, mechanical graders, cost gate and diff | CLI | PAU-3.7 | 5 | 4/sonnet |  |
| PAU-5.2 | Add plugin-eval runner, A/B checkouts and production series | CLI | PAU-5.1, PAU-1.7 | 5 | 5/opus |  |
| PAU-5.4 | Calibrate the eval tier against known outcomes (gate) | CLI | PAU-5.2 | 6 | 4/sonnet | ⚠ HITL |
| PAU-5.3 | Add calibration-gated prompt-eval skill, stub, content tests and docs | Shared | PAU-5.2, PAU-4.1, PAU-5.4 | 4 | 3/sonnet |  |

## Dependency Map

```
F1: 1.1 · 1.2 · 1.3 · 1.5 (no deps)
    1.5 → 1.4 (also 1.2, 1.3), 1.6, 1.7;  1.7 → 1.8
    1.4+1.6+1.7+1.8 → 1.10
F2: 1.4+1.6+1.7 → 2.1 ⚠ → 2.2 (also 1.1) → 2.3 ⚠ → 2.4 ⚠ (also 3.12)
F3: 3.1 → 3.3, 3.4, 3.5 (also 1.6);  1.1 → 3.2;  3.1+3.3 → 3.14
    3.2+3.3+3.4+3.5 → 3.6;  3.6+3.14 → 3.7 → 3.8
    3.10 ⚠ + 3.7 → 3.9;  3.8+3.9 → 3.11;  3.9+3.11 → 3.12 → 3.13
F4: 3.13+3.14 → 4.1;  3.7+1.7+1.8 → 4.2
F5: 3.7 → 5.1;  5.1+1.7 → 5.2;  5.2 → 5.4 ⚠;  5.2+4.1+5.4 → 5.3
```

## Breaking Change Safety

All admin and task-store changes are additive and nullable: safe to deploy standalone. PAU-1.4 depends on PAU-1.5 so the receiving service accepts new fields before senders emit them. No `PullRequest` schema change and no `review.md` edit remain in the plan, so the task store and the review phase are untouched. PAU-2.2 moves the bare pricing aliases; it ships atomically with its alias test.

## HITL

PAU-2.1 (data gate), PAU-2.3 (agent env cutover), PAU-2.4 (keep/revert judgment), PAU-3.10 (`.claude/**` write), PAU-5.4 (eval calibration: human-labeled gold set and sign-off). Every task `prompt-fix` generates is `hitl: true` until a human promotes a rule (see Decision Log).

## Decision Log

- Deploy ordering: defaulted to making the agent forwarder depend on the admin schema task — a stricter admin schema could 400 on unknown fields.
- listingBudget constants: defaulted to a plugin-local window map with a parity test against lib/pricing — plugin is self-contained.
- Layer field for markdown-skill tasks: defaulted to Shared (CLI for scripts); `layer: Docs` is only for prompt-fix generated tasks.
- Design doc: lands on main via PAU-3.12 from the closed branch.
- Seeded registry file: separate HITL task (PAU-3.10) because of the `.claude/**` write block.
- Pricing alias move: atomic with its test in PAU-2.2.
- Root CLAUDE.md Reference bullet: accepted despite the file being over 200 lines.
- Review verdict: dropped `lastReviewVerdict` columns and the `review.md` write (was PAU-1.8/1.9). `review.md` never issues REQUEST_CHANGES, `reviewState` already encodes approved vs posted, and `reviewCycles`/`patchCycles` are better outcome proxies. Aggregated read-only from existing fields (PAU-1.8). Trade-off: `reviewState` is overwritten by later patches, so only the current state and cycle counts are available, not a per-review history.
- Reconciler as host: rejected. It lives in `agent/src/pr-state-reconciler.ts` (poll-only, skips `approved`, first-50 reviews, extra GraphQL load). Capturing out-of-band human/bot verdicts is a possible later task, not part of this plan.
- Evals demoted to a gated tier: synthetic cases generated from a command's own steps are smoke tests, not quality evidence. Quality claims need mechanical graders, paired cases with repeated seeds, and a signed calibration record (PAU-5.4). If calibration fails, the tier stays off and only cost-only findings and the production series remain.
- Paper claims narrowed: 2602.11988 shows repo context files do not generally raise task success and add over 20% cost; 2605.10039 shows no detectable effect of file size, position, architecture or conflicts on compliance with a trivial annotation (Bayes factors support the size null) and a within-session decay of about 5.6% per generated function. Neither studies orchestration prompts like Shipwright's, and neither tested trimming. Treated as "measure, do not assume".
- Automated edit safety: `prompt-fix` is propose-only at launch (all tasks `hitl: true`). `hitl: false` is reachable only for a rule a human has promoted, and only for pure fact repair on a low-fanout file with no pinning test and a diff of 20 lines or fewer. `hitl` is computed from the blast-radius report, not judged.
- Blast radius is computed at filing and re-checked at execution: the task body embeds the report; the executing agent re-runs `cli.ts blast` and stops if it differs.
- Cutover freeze: `prompt-fix` files nothing between PAU-2.3 and PAU-2.4 so prompt edits are not confounded with the model change. At most 2 prompt-fix tasks per ISO week so a series can isolate each change.
- Regressions never auto-revert: PAU-4.2 flags them in the next scan and files a `hitl: true` revert-proposal; reverting is a human decision.
- CODEOWNERS path rules: not planned. `hitl: true` only blocks agent pickup; branch protection has 0 required reviews and a bypass actor, so a hand-opened PR can still merge. Closing that gap needs an owner decision (see Open Questions in the spec).
