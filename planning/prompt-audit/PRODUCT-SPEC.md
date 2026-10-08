# Prompt-Audit Patrol — Product Specification

**Date**: 2026-10-07
**Session**: prompt-audit
**Status**: Draft

## Overview

A periodic, measured audit of Shipwright's own LLM-facing markdown (root `CLAUDE.md`, the agent workspace `CLAUDE.md.template`, plugin commands/skills/agents, `.claude/` rules, `@`-referenced docs). It produces the production metrics a markdown change can be measured against, scans the repo for cost and model-fit findings, queues fixes whose task bodies carry a measurement plan and acceptance criteria, and runs cost-capped evals when a change could affect quality. The design is approved in `docs/superpowers/specs/2026-10-07-prompt-audit-patrol-design.md`; this spec is the task-generation contract for `/plan-session`.

## Problem Statement

Shipwright runs on roughly 265k tokens of on-invocation markdown (29 plugin commands, 26 skills) plus two always-loaded CLAUDE.md files that are both over the official 200-line guidance. Much of it was written against a Sonnet that no longer exists: the fleet default is `claude-sonnet-4-6`, current Sonnet is 5.5, and `lib/pricing.ts` had no 5.x model. Nobody re-audits this text when models change, nothing resolves whether named paths/commands/model ids still exist (the root `CLAUDE.md` carries an "auto-maintained" section whose writer was removed in #3701), and there is no token accounting per file, per skill, or per run, so any claimed "saving" is unmeasurable and any quality regression is invisible.

## Users & Context

- **Shipwright operators (App Vitals engineers)** who maintain the plugin and the agent fleet. They want fewer wasted input/output tokens per run and markdown that fits the model actually deployed, without guessing which edits helped.
- **The autonomous agent fleet** that consumes the markdown every run. It is also the measurement source: every cron run becomes a data point.
- **The patrol itself** (a weekly, disabled-by-default cron), which must be safe to leave unattended: report and queue only, never spend eval budget on its own.

Workflow: metrics accrue from normal cron runs → weekly `prompt-scan` writes a report and ledger → `prompt-fix` queues task-store tasks (≤10/run) → an executing agent proves each task's measurement before its PR merges → `prompt-eval` runs with/without, A/B, trigger, or production-series measurements under a cost cap.

Two **contexts** are reported everywhere because load class differs by cwd:
- `local-dev` (cwd = repo root): always-loaded = root `CLAUDE.md` + `.claude/rules/*.md` without `paths:` + the skill/agent listing.
- `agent-runtime` (cwd = `$AGENT_HOME/workspace`): always-loaded = rendered `agent/workspace/CLAUDE.md.template` (+ its `@SOUL/IDENTITY/BOOTSTRAP/VOICE` imports) + listing. The repo's root `CLAUDE.md` is a *subdirectory* file there, loaded on demand.

---

## Features

### Feature 1: Metrics production (per-run context baseline, skill attribution, outcome series)

**Priority**: High
**Description**: Record, from the Claude CLI stream the agent already consumes, the numbers every later markdown change is measured against: the first-turn context baseline, turn and tool-call counts, per-skill token attribution, a fingerprint of the always-loaded markdown, and per-phase outcome series. Without this every "saving" is an estimate and no quality regression is detectable.

**User Stories**:
- As an operator, I want to see how many tokens the always-loaded context costs on every run, per model, so a CLAUDE.md edit shows up as a before/after number.
- As an operator, I want per-skill token attribution from production runs so I know which skill bodies are expensive and how often they load.
- As the patrol, I want runs grouped by what the model was given (not by merge date) so before/after series are comparable.

**Requirements**:
- The agent's stream consumer captures, per run: `FirstTurnUsage` (model, input, cache-creation, cache-read, `contextTokens` = sum of the three) from the first non-subagent assistant message; `turns` (distinct usage-bearing message ids); `toolCalls` (distinct `tool_use` ids); and `skillUsage[]` rows `{kind: skill|agent|root, name, invocations, turns, input/output/cacheRead/cacheCreation tokens, invokeContextDelta}`. Attribution is deterministic and last-wins (a `Skill` tool_use switches the bucket; turns with `parent_tool_use_id` go to `agent:<subagent_type>`; turns before any invoke go to `root`). `invokeContextDelta` = input + cache-creation of the first usage-bearing turn after the skill's first invoke.
- Telemetry is carried on `ClaudeRunResult.telemetry` and as `partialTelemetry` on `ClaudeRunError` / `ClaudeTimeoutError` / `ClaudeAbortedError`. A resumed (`-r`) session drops the first-turn baseline (its first turn replays history) but keeps counts and attribution.
- A context stamp `{contextFingerprint (sha256[:12]), pluginVersion, claudeCodeVersion}` is computed once per run from the workspace `CLAUDE.md`, its `@` imports (one hop, code spans/fences skipped), every `.claude/rules/**/*.md` without `paths:` frontmatter, and the plugin version; fail-soft (unstamped on error).
- `buildTokenPayload(usage, modelUsage, extras?)` forwards `contextBaseline`, `turns`, `toolCalls`, `skillUsage`, `contextFingerprint`, `pluginVersion`, `claudeCodeVersion` through `CronRunReporter` to the admin PATCH on every completion, skip, and failure path in `cron-handler.ts` and `loop-orchestrator.ts`; `contextStamp` is an optional injected dep on `CronHandlerDeps`, `LoopOrchestratorDeps`, the getter deps, and production options, wired in `index.ts`.
- Admin: nullable additive columns on `AgentCronRun` (`baselineModel`, `baselineContextTokens`, `baselineInputTokens`, `baselineCacheCreationTokens`, `baselineCacheReadTokens`, `turns`, `toolCalls`, `contextFingerprint` + index, `pluginVersion`, `claudeCodeVersion`); new `AgentCronRunSkillUsage` table unique on `[cronRunId, kind, name]`, cascade-deleted with its run; one migration; PATCH accepts the new fields and upserts `skillUsage` in the same transaction as `modelBreakdown`; OpenAPI schemas and the serialized run response include them; `lib/admin-types.ts` stays in sync.
- Stats: `GET /agents/all/cron-runs/stats` gains `bySkill` (per `(kind, name)`: runs, invocations, turns, token sums, `avgInvokeContextDelta`; skipped runs excluded) and `baselines` (per `(contextFingerprint, baselineModel, phase)`: runs, avg/min/max `contextTokens`, avg turns, avg tool calls, first/last seen; skipped runs **included** because a `[silent]` dispatch still paid its first-turn context; ordered by first appearance). The metrics client types mirror both as optional fields.
- Outcome series: new admin `GET /agents/all/cron-runs/outcomes?from&to` returning, per `(phase, contextFingerprint)`: runs, completed, failed, skipped, `skipReasons` histogram, avg and p50 duration, avg turns, avg tool calls, avg context tokens. Task-store `PullRequest` gains `lastReviewVerdict` + `lastReviewVerdictAt`, written by the review command's record step, so verdict distribution is queryable.
- Pricing: `lib/pricing.ts` adds `claude-opus-5-5`, `claude-sonnet-5-5`, `claude-haiku-5-5`, `claude-fable-5-1` (rates from the current rate card, never guessed) and a `CONTEXT_WINDOW` map per rate key; `normalizeModelToRateKey` maps 5.x ids to themselves; bare `sonnet`/`opus`/`haiku` aliases stay on the 4.x keys until Feature 2.
- Docs: `docs/agent-api-ops.md` (new dimensions, telemetry PATCH fields, outcomes endpoint), `docs/agent.md` (model table + count), `docs/agent-key-files.md` (new modules), `docs/configuration-agent.md` (OpenTelemetry documented as an optional operator-side alternative, not wired).

**Acceptance Criteria**:
- [ ] A fixture stream with a `Skill` invoke, a sub-agent turn, and repeated message ids yields exactly the expected `RunTelemetry` (baseline from the first non-subagent turn; root/skill/agent rows with the documented sums; `invokeContextDelta` = input + cache-creation of the first turn after the invoke).
- [ ] A run spawned with `-r` reports no `contextBaseline` but does report `turns`, `toolCalls`, and `skillUsage`.
- [ ] `ClaudeRunError`, `ClaudeTimeoutError`, and `ClaudeAbortedError` each carry `partialTelemetry` when the stream was consumed, and both dispatchers forward it on the failure path.
- [ ] Editing the workspace `CLAUDE.md`, one of its `@` imports, a no-`paths` rule, or the plugin version changes `contextFingerprint`; editing a `paths:`-scoped rule does not; rule file order does not.
- [ ] `PATCH /agents/:id/crons/:cronId/runs/:runId` with `contextBaseline`, counts, stamp fields, and `skillUsage` persists every column and upserts rows per `[cronRunId, kind, name]`; a second PATCH with the same key updates rather than duplicates; rows cascade-delete with the run.
- [ ] `GET /agents/all/cron-runs/stats` returns `bySkill` and `baselines` with the documented aggregation (skipped runs excluded from `bySkill`, included in `baselines`; runs with no baseline excluded from `baselines`), and empty arrays when nothing was reported.
- [ ] `GET /agents/all/cron-runs/outcomes` returns the per-`(phase, contextFingerprint)` series above and is admin-only (agent-scoped bearer → 403).
- [ ] Every `claude-*` id referenced in `agent-types/*/manifest.yaml`, `agent/src`, `lib/`, and `docs/configuration-agent.md` resolves via `normalizeModelToRateKey`, and every `RATES` key has a `CONTEXT_WINDOW` entry.
- [ ] All new columns are nullable and an agent build that predates them reports nothing without error (backward compatible; no cron change).
- [ ] `task ci` passes; coverage ≥ 90/89 lines/functions.

**Technical Considerations**: The stream consumer in `agent/src/claude.ts` (`_consumeStream`) already walks every assistant event's content blocks and usage, so attribution is computed in-stream; transcript JSONL files are not read (the container `$HOME` is not the persistent volume). The three-way sum makes the baseline independent of cache warmth (verified on a real transcript: ~79k tokens before any work). Reuse `detectClaudeCodeVersion` (`agent/src/claude-version.ts`) and the existing upsert-in-transaction pattern for `modelBreakdown`. `openapi-typescript@7` fails under this repo's TypeScript 7, so `lib/admin-types.ts` is hand-synced until the generator is fixed. An implementation of everything except the outcomes endpoint and review verdict already exists on branch `feat/prompt-audit-metrics` (closed PR #3977) and may be cherry-picked.

**Source Map**:
- `agent/src/claude.ts` — telemetry accumulation in `_consumeStream`; `telemetry` on results and errors
- `agent/src/run-telemetry.ts` (new) — pure accumulator
- `agent/src/context-stamp.ts` (new) — fingerprint + production reader
- `agent/src/cron-handler.ts` — `buildTokenPayload` extras; `contextStamp` dep; all completion/skip/failure call sites
- `agent/src/loop-orchestrator.ts` — same, across the three deps interfaces and pass-throughs
- `agent/src/cron-run-reporter.ts` — `RunReportOpts` fields and `applyRunReportOpts`
- `agent/src/index.ts` — wires `createContextStampReader`
- `agent/src/fixtures/stream-json/` — new fixture
- `admin/prisma/schema.prisma` + `admin/prisma/migrations/` — columns, table, migration
- `admin/src/agent-cron-runs.ts` — input types, PATCH upserts
- `admin/src/openapi-schemas.ts`, `admin/src/agents-api.ts` — body/response schemas, handler mapping, serializer, outcomes route
- `admin/src/agent-cron-run-stats.ts` — `bySkill`, `baselines`, outcomes queries
- `admin/openapi.json`, `lib/admin-types.ts` — regenerated / hand-synced
- `metrics/src/lib/admin-metrics-client.ts` — mirrored types
- `task-store/prisma/schema.prisma`, `task-store/src/` PR record routes — `lastReviewVerdict`
- `plugins/shipwright/commands/review.md` — record step writes the verdict
- `lib/pricing.ts`, `lib/pricing.unit.test.ts`
- `docs/agent-api-ops.md`, `docs/agent.md`, `docs/agent-key-files.md`, `docs/configuration-agent.md`

**Testing Strategy**: Layer: unit for the accumulator, stamp, payload builder, pricing (pure); integration for the reporter PATCH body (stub HTTP server), admin upserts and stats aggregation (real test Postgres); smoke for the stats and outcomes route shapes via in-process `app.request()`.

---

### Feature 2: Model bump as a measured change

**Priority**: High
**Description**: Move the fleet default from `claude-sonnet-4-6` to `claude-sonnet-5-5` only after a baseline exists, and read the before/after from Feature 1's series so the bump is a measured decision, not an assumption.

**User Stories**:
- As an operator, I want the model upgrade to show its cost-per-task, context size, turn count, and failure-rate deltas per phase before I keep it.

**Requirements**:
- Precondition: ≥ 2 weeks or ≥ 20 runs per phase of Feature 1 series on `claude-sonnet-4-6`.
- Change `DEFAULT_ANTHROPIC_MODEL` in `lib/default-agent-env.ts` and the runtime fallback in `agent/src/config.ts` / `agent/src/claude.ts` to `claude-sonnet-5-5`; move the bare pricing aliases to 5.5; update `docs/configuration-agent.md`.
- Existing agents keep their seeded `ANTHROPIC_MODEL` env, so the task includes a HITL step: update each agent's env via the admin API (`shipwright:agent-admin` skill) and record the cutover date.
- Measurement: `baselines` and `/outcomes` split by `baselineModel`; report cost per completed task, first-turn context tokens (a different count on identical markdown is expected: new tokenizer), turns, failure/skip rates, patch cycles, per phase; keep or revert on evidence.
- Rule inherited by every later feature: token deltas for a markdown edit are only valid same-model; the scan reports both models until the fleet is fully on 5.5.

**Acceptance Criteria**:
- [ ] A new agent created after the change is seeded with `ANTHROPIC_MODEL=claude-sonnet-5-5`; the runtime fallback agrees.
- [ ] `normalizeModelToRateKey("sonnet")` returns `claude-sonnet-5-5` and the unit test pinning the alias table is updated.
- [ ] `GET /agents/all/cron-runs/stats` shows `baselines` rows for both `baselineModel` values with ≥ 20 runs per phase on the new model before the decision is written.
- [ ] A dated decision note (keep or revert, with the per-phase numbers) is written to `docs/prompt-audit.md`.

**Technical Considerations**: `lib/default-agent-env.ts` seeds the env on `createAgent` only (PR #3971), so existing agents need the admin-API step. The 4.6 → 5.5 tokenizer change means `baselineContextTokens` will differ on unchanged markdown; the series is keyed by model to keep this honest.

**Source Map**:
- `lib/default-agent-env.ts`, `lib/default-agent-env.unit.test.ts`
- `agent/src/config.ts`, `agent/src/claude.ts`
- `lib/pricing.ts`, `lib/pricing.unit.test.ts`
- `docs/configuration-agent.md`, `docs/prompt-audit.md`

**Testing Strategy**: Layer: unit — constants and alias mapping are pure; the measurement itself is a read of production series, documented, not a test.

---

### Feature 3: `prompt-scan` (static tier: inventory, tokens, staleness, structure, density)

**Priority**: High
**Description**: A report-only scan of this repo's LLM-facing markdown that classifies every file by load class per context, counts exact tokens per target model, resolves every referenced path/command/flag/model id, flags structure that fights the loading rules, measures instruction density, optionally folds in `/doctor prompt-audit` findings for dated-model patterns, and tracks findings across runs in a ledger with a human-owned decisions registry. Mirrors the existing patrol shape (`consolidation-scan`).

**User Stories**:
- As an operator, I want a weekly report that tells me what loads every turn, what it costs per model, what is stale, and what structural change would move cost from always-loaded to on-demand, each with the number that proves it.
- As the patrol, I want findings fingerprinted so the same finding is tracked, not re-reported, and suppressed when a human has decided to keep it.

**Requirements**:
- Scripts under `plugins/shipwright/scripts/prompt-audit/` (Bun/TS, pure core + injected deps, each file < ~250 lines, unit test beside each, no SDK dependency — the plugin is self-contained):
  - `inventory.ts` — `walkInventory(root, deps)` → entries with kind (`claude-md|rule|import|skill|command|agent|reference|template|doc`), `loadClass` per context (`always|on-demand-path|on-invoke|on-reference|listing`), frontmatter (`name`, `description`, `paths`), description chars, body lines, `@` imports (≤ 4 hops); treats `agent/workspace/CLAUDE.md.template` as the `agent-runtime` always file.
  - `token-count.ts` — `countTokens(texts, models, deps)` via raw `fetch` to `POST /v1/messages/count_tokens`; no key or non-2xx → `ceil(bytes/4)` labelled `estimated: true`; cache in `state/prompt-audit/token-cache.json` keyed by sha256(model + content); `listingBudget(model)` = `CONTEXT_WINDOW × 0.01` chars.
  - `reference-resolver.ts` — extract paths, commands, flags, model ids, env vars; resolve against the filesystem, `Taskfile.yml`, `package.json` scripts, command stub flags, `RATES` keys; `findOrphanedAutoSections` (an "auto-maintained" banner with no writer outside tests).
  - `instruction-density.ts` — imperatives, caps emphasis (`MUST|NEVER|ALWAYS|CRITICAL`), numbered steps, bold imperatives, first-hard-constraint line ratio.
  - `usage-attribution.ts` — local `~/.claude/projects` transcript parse (same rules as Feature 1, ~40 lines duplicated by design) and `fetchCronSkillStats` from the admin `bySkill` dimension; unreachable → null, never fails the scan.
  - `blame-age.ts` — max/median line age and oldest line via injected `git blame`.
  - `rules.ts` — one function per rule; thresholds documented in `skills/prompt-scan/references/thresholds.md`.
  - `fingerprint.ts` (sha256(class|rule|file|normalizedEvidence)[:12], no line numbers), `ledger.ts` (read/merge/write with injected `now`), `report.ts` (`prompt-audit-report.md`).
  - `cli.ts` — `scan --repo <dir> --model <id>… --scope <path> [--json] [--dry-run] [--since-days 28]` and `measure --finding <fp> --before <ref> --after <ref> --model <id>` (same-model token delta of a file at two refs).
  - `plugins/shipwright/scripts/check-prompt-audit.ts` — precheck: missing ledger → exit 0 (bootstrap); `lastRun` < 7 days and no `proposed` findings → exit 1; else exit 0 + summary; mirrors `check-consolidation-patrol.ts` with a unit test.
- Finding record: `{fingerprint, class, rule, file, line, lineEnd?, loadClass, contexts[], evidence, metrics:{before, projectedAfter?, units, estimated}, measurement:{tier: static|eval, evals?:[{kind, estCostUsd}], acceptance}, confidence, action, severity}`. Every row is labelled **cost-only** or **quality-claimed**.
- Finding classes and v1 rules:
  - (a) always-loaded cost: `claude-md-over-200-lines`, `always-set-tokens` (per context × model), `rule-without-paths`, `import-chain`, `listing-budget-share`, `listing-entry-over-1536`. Static proof: `count_tokens` per model, share of window, listing chars vs 1% budget, measured `baselineContextTokens` when reachable.
  - (b) on-invoke cost: `on-invoke-heavy` (> 8k tokens), `invoke-cost-weekly` (tokens × invocations/week from `bySkill`, else local transcripts, else "usage unavailable"; `avgInvokeContextDelta` replaces the static count when present).
  - (c) stale facts: `unresolvable-path`, `unresolvable-command`, `unknown-flag`, `retired-model-id`, `orphaned-auto-section`, `blame-age` (> 180 d). Static-only.
  - (d) dated-model patterns: delegated to `/doctor prompt-audit` (≥ Claude Code 2.1.283; the Dockerfile pins 2.1.285); if unavailable, apply the bundled claude-api `prompt-audit` checklist inline and say so; rows parsed into findings; **two consecutive runs** to promote (judgment noise).
  - (e) structure vs loading rules: `move-to-path-rule`, `skill-to-docs-index` (skill invoked in > 60% of runs), `skill-over-500-lines`, `key-instructions-not-near-top` (first hard constraint after 40% of file; 5k-token post-compaction cap), `description-over-1536`, `description-multiline`, `frontmatter-missing-name`, `duplicate-listing-entry` (stub + skill same description, paid twice in the listing).
  - (f) instruction density: `instruction-count-high` (> 60 imperatives/file), `caps-emphasis-ratio`, `prohibition-cluster`.
- Skill `plugins/shipwright/skills/prompt-scan/SKILL.md` + stub `commands/prompt-scan.md`; flags `--summary`, `--dry-run`, `--model <id>` (repeatable; default `[ANTHROPIC_MODEL, claude-sonnet-5-5, claude-sonnet-4-6]`), `--scope <path>`, `--with-doctor`, `--since-days <n>`. Steps mirror `consolidation-scan`: parse args → load `.claude/shipwright/prompt-audit-decisions.md` → load `state/prompt-audit-ledger.json` → run `cli.ts scan --json` → judgment pass (class e `move-to-path-rule`; class d via doctor) → fingerprint + merge → suppress via registry → write ledger (not on `--dry-run`) → write report (not on `--summary`/`--dry-run`) → summary → Constraints (no code/git/task-store writes; token cache is the only other write; estimates labelled).
- Report: header (models, contexts, Claude Code version, estimated?), always-loaded baseline table (context × model: static vs measured), listing-budget table, one section per class sorted by projected weekly token saving, each row with before → projected after, tier, estimated eval cost, cost-only/quality-claimed.
- Ledger `state/prompt-audit-ledger.json` (snapshot; `history` append-only; schema in `skills/prompt-scan/references/ledger-schema.md`): `lastRun`, `models[]`, `claudeCodeVersion`, `baselines{context{model{alwaysTokens, listingChars, estimated}}}`, `findings{fp{…Finding, status: tracking|proposed|queued|measured|resolved|suppressed, firstSeen, lastSeen, runsSeen, taskId, measured{kind, before, after, delta, costUsd, series{…}, artifacts[], runAt}, history[]}}`. `resolved` only when a `queued`/`measured` entry stops reproducing; a vanished `tracking` entry is left alone.
- Registry `.claude/shipwright/prompt-audit-decisions.md`: four-field entries (`**Finding:** / **Decision:** / **Rationale:** / **Revisit:**`), human-edited only; added as the third instance in `plugins/shipwright/references/decisions-registry.md` + its content test; seeded with one entry.
- Cron `prompt-audit-maintenance` in `agent-types/coding/manifest.yaml`: `0 7 * * 1`, prompt `/shipwright:prompt-scan --with-doctor` then `/shipwright:prompt-fix`, `silent: true`, `preCheck: shipwright:check-prompt-audit.ts`, **`enabled: false`**; `docs/agent-ops.md` row; new `docs/prompt-audit.md`; root `CLAUDE.md` Reference bullet; `plugins/shipwright/README.md`; `TESTING.md` scenarios.

**Acceptance Criteria**:
- [ ] `/shipwright:prompt-scan --with-doctor --dry-run` on this repo reproduces all ten bootstrap findings: (1) `c/orphaned-auto-section` for the "Shipwright Learned Facts" section in root `CLAUDE.md`; (2) `c/retired-model-id` for `claude-sonnet-4-5` in `docs/agent.md` and `admin/prisma/schema.prisma`; (3) `a/claude-md-over-200-lines` for root `CLAUDE.md` (local-dev) and `agent/workspace/CLAUDE.md.template` (agent-runtime) with per-model tokens and window share; (4) `b/on-invoke-heavy` for `commands/patch.md` with invocations/week or "usage unavailable"; (5) `e/frontmatter-missing-name` for the 20 commands without `name`; (6) `e/description-multiline` for 18 commands; (7) `e/duplicate-listing-entry` for thin stubs duplicating their skill's description; (8) `e/skill-over-500-lines` for `investigate-cron`, `test-fix`, `security-scan`, `error-fix`; (9) `a/listing-budget-share` per model naming which entries lose descriptions first; (10) ≥ 1 class-d row marked `tracking` until run 2.
- [ ] `--dry-run` leaves `state/` and `prompt-audit-report.md` untouched (`git status` clean except the token cache).
- [ ] With no API key, every token figure in the report is labelled `estimate`; with a key, `count_tokens` is called with the target model id and results are cached by content hash (second run makes zero API calls for unchanged files).
- [ ] A registry entry whose Finding matches suppresses the finding and the ledger records `suppressed`.
- [ ] The precheck exits 0 with no ledger, 1 when `lastRun` is < 7 days old with nothing `proposed`, 0 with a summary otherwise, and 0 on a corrupt ledger; `now` is injected.
- [ ] Unit tests cover every script against a temp-dir mini repo fixture (CLAUDE.md, rules with/without `paths:`, skill + duplicate stub, workspace template, a doc with a retired model id, an orphaned banner; recorded `count_tokens` JSON; injected `fetchFn` asserting the request shape). Nothing hits the API, the `claude` binary, or the admin API.
- [ ] Content tests assert the SKILL.md and stub: flags, step order, Constraints section, citations of `decisions-registry.md`.
- [ ] The cron ships `enabled: false` and any manifest content test enumerating cron names is extended.

**Technical Considerations**: Official loading rules drive `loadClass`: `@` imports load at launch (they do not reduce cost), `paths:` rules and skill bodies load on demand, skill descriptions are always in context under a 1%-of-window budget with a 1,536-char cap per entry, block-level HTML comments in CLAUDE.md are stripped. Token counts must be model-specific (`count_tokens`, never tiktoken). The `Clock` pattern in `plugins/shipwright/scripts/clock.ts` and the shared `check-helpers.ts` are reused. Evidence caveat enforced in the report: file size alone has no measured adherence effect (arXiv 2605.10039), so every "shorten" finding is cost-only unless an eval says otherwise.

**Source Map**:
- `plugins/shipwright/scripts/prompt-audit/*` (new), `plugins/shipwright/scripts/check-prompt-audit.ts` (new)
- `plugins/shipwright/skills/prompt-scan/SKILL.md` + `references/{thresholds,ledger-schema}.md` (new), `plugins/shipwright/commands/prompt-scan.md` (new)
- `plugins/shipwright/references/decisions-registry.md` (+ content test) — third instance
- `.claude/shipwright/prompt-audit-decisions.md` (new, seeded)
- `agent-types/coding/manifest.yaml` — cron entry
- `docs/agent-ops.md`, `docs/prompt-audit.md` (new), `CLAUDE.md` (Reference bullet), `plugins/shipwright/README.md`, `plugins/shipwright/TESTING.md`
- `plugins/shipwright/scripts/clock.ts`, `plugins/shipwright/scripts/check-helpers.ts` — reused

**Testing Strategy**: Layer: unit for every script (pure core, injected fs/fetch/git/clock, recorded fixtures); content for the skill and stub markdown; the precheck is unit-tested like its siblings.

---

### Feature 4: `prompt-fix` (queue fixes with embedded measurement plans)

**Priority**: Medium
**Description**: Turn `proposed` findings into task-store tasks whose bodies carry the evidence, the projected metric, the measurement plan, and acceptance criteria the executing agent must prove, so no markdown change merges on a hypothesis.

**User Stories**:
- As an operator, I want each queued fix to say exactly which number it will move and how that will be verified before merge.
- As an executing agent, I want the acceptance command in the task body so I can prove the delta without re-deriving the method.

**Requirements**:
- Skill `plugins/shipwright/skills/prompt-fix/SKILL.md` + stub `commands/prompt-fix.md`; flags `--dry-run`, `--class <a-f>`, `--finding <fp>`.
- Steps: report exists → filter `proposed` → live registry re-check → pre-filing verification (`file:line` still matches) → `--dry-run` preview → cap 10 tasks/run (class c first, then by projected saving) → dedup `GET /tasks?status=pending|in_progress&repo=…&limit=1000` on the `prompt-` id prefix with the pagination guard → `POST /tasks/bulk` → mark ledger `queued` + `taskId`.
- Task shape: `id: prompt-{class}-{fp8}-shipwright-{YYYY-Www}`, `title: "Prompt audit: {rule} — {file}"`, `source: prompt-fix`, `branch: chore/prompt-{fp8}-{slug}`, `layer: Docs`, `hitl: true` for class d/e changes that remove or move behavioral text, else `false`.
- Body template: evidence; static metric before → projected after (model, estimated?); measurement plan (tier, evals + estimated cost); acceptance criteria: (1) `cli.ts measure --finding {fp} --before main --after HEAD --model {m}` reports `tokenDelta ≤ −N`; (2) if eval tier, `/shipwright:prompt-eval --finding {fp} --kind {…} --max-cost-usd {X}` reports score delta ≥ 0 and the JSON is attached to the PR; (3) ledger `measured` populated and cited in the PR body; plus "suppress instead: add a registry entry".
- Quality-claimed findings can never be queued with `hitl: false`.

**Acceptance Criteria**:
- [ ] `/shipwright:prompt-fix --dry-run` prints every task it would create, with the full body, and writes nothing to the task store or ledger.
- [ ] A real run creates ≤ 10 tasks, each visible via the task-store query, with ids matching `prompt-{class}-{fp8}-shipwright-{YYYY-Www}` and bodies containing all three acceptance criteria.
- [ ] Re-running does not create a duplicate for a finding already `pending`/`in_progress` (dedup by id prefix across paginated results).
- [ ] A finding whose `file:line` no longer matches is skipped with a printed reason and left `proposed`.
- [ ] A class-d or class-e finding that removes or moves behavioral text is queued with `hitl: true`; a class-c finding with `hitl: false`.
- [ ] Content tests assert the stub, the flags, the step order, the cap, the task-id format string, and the acceptance-criteria template.

**Technical Considerations**: Mirrors `entropy-fix` / `consolidation-fix` exactly (cap, dedup, bulk POST, `hitl` classification). Task-store connection is env-var-only (`SHIPWRIGHT_TASK_STORE_URL` + `SHIPWRIGHT_TASK_STORE_TOKEN`).

**Source Map**:
- `plugins/shipwright/skills/prompt-fix/SKILL.md` (new), `plugins/shipwright/commands/prompt-fix.md` (new)
- `plugins/shipwright/skills/prompt-scan/references/ledger-schema.md` — `queued`/`taskId` fields
- `plugins/shipwright/references/pre-filing-verification.md` — cited
- `docs/prompt-audit.md`, `plugins/shipwright/README.md`, `plugins/shipwright/TESTING.md`

**Testing Strategy**: Layer: content — the skill is markdown executed by the model; its contracts (flags, cap, id format, body template) are asserted as static content, and task-store I/O is exercised manually per `TESTING.md`.

---

### Feature 5: `prompt-eval` (eval tier: with/without, A/B, trigger sets, production series)

**Priority**: Medium
**Description**: The gated measurement channel for changes that could affect quality. Builds a frozen case set per finding, runs it with/without or on two checkouts, measures trigger precision/recall for description changes, or reads the production series for CLAUDE.md-class findings, always with the cost estimated and capped before anything runs.

**User Stories**:
- As an operator, I want to see the estimated spend before an eval runs and refuse it with a cap.
- As an executing agent, I want a PR-citable block with before/after score and cost per task written into the ledger.

**Requirements**:
- Skill `plugins/shipwright/skills/prompt-eval/SKILL.md` + stub `commands/prompt-eval.md`; flags `--finding <fp>`, `--kind with-without|ab|trigger|production-series`, `--max-cost-usd <n>` (default 5), `--model <id>`, `--runs <n>` (default 3).
- Harness `plugins/shipwright/scripts/prompt-audit/eval-harness.ts`: `buildEvalCases(finding, repoDir, deps)` (20–30 frozen prompts derived from the command's own steps; trigger sets = should/shouldn't prompts with a `tool_used: Skill` grader) written as `evals/<case>/prompt.md` + `graders/*.md`; `runPluginEval` wrapping `claude plugin eval --json --trust-plugin --no-publish --max-cost-usd`; `abOnTwoCheckouts` (`git worktree add` base/head, same cases, diff JSON); `productionSeries` reading `/outcomes` + `/stats` by `contextFingerprint`.
- Prints the estimated cost (cases × runs × arms × last per-case cost, default $0.10) **before** running and refuses without a cap.
- Writes `ledger.findings[fp].measured` (kind, before, after, delta, costUsd, series or artifacts, runAt) and prints a PR-citable block.
- Caveat enforced: `claude plugin eval` loads only the plugin under test, so CLAUDE.md-class findings use `production-series` or `with-without` with `append_system_prompt`.
- Evals never run from the cron; only inside a fix task or by a human.

**Acceptance Criteria**:
- [ ] `/shipwright:prompt-eval --finding <fp> --kind ab --max-cost-usd 2` prints the estimate first, runs on two checkouts with identical cases, and writes `measured` with before/after score, delta, and cost.
- [ ] Without `--max-cost-usd` (or with the estimate above the cap) the skill refuses to run and says why.
- [ ] A `trigger` run writes should/shouldn't cases with a `tool_used: Skill` grader and reports precision and recall.
- [ ] A `production-series` run reads `/outcomes` and `/stats` for the finding's before/after `contextFingerprint`, refuses to call a result with < 20 runs per arm, and records both run counts.
- [ ] Unit tests cover case generation, cost estimation, JSON diffing, and the series reader with injected `exec`/`fetchFn`; nothing spawns `claude` or hits the network in tests.
- [ ] Content tests assert the stub, flags, cost-gate wording, and the sandbox caveat.

**Technical Considerations**: `claude plugin eval` JSON exposes a top-level `costUsd` and per-case `score`/`delta` but no per-case tokens; version A/B is not built in, hence two checkouts. Decision rules follow the cost-optimization method: one lever per diff, pass rate and cost per task read together, revert anything that gives back accuracy, never decide on a one-case swing.

**Source Map**:
- `plugins/shipwright/scripts/prompt-audit/eval-harness.ts` (new)
- `plugins/shipwright/skills/prompt-eval/SKILL.md` (new), `plugins/shipwright/commands/prompt-eval.md` (new)
- `plugins/shipwright/skills/prompt-scan/references/ledger-schema.md` — `measured` field
- `docs/prompt-audit.md`, `plugins/shipwright/README.md`, `plugins/shipwright/TESTING.md`

**Testing Strategy**: Layer: unit for the harness (injected exec/fetch, recorded eval JSON); content for the skill and stub.

---

## Technical Constraints

- The plugin stays repo-agnostic in structure and self-contained (no SDK dependency in `plugins/shipwright/scripts`; raw `fetch` only), even though the scan targets this repo first.
- Local-first and offline by default: tests never hit the Anthropic API, the `claude` binary, the admin API, or the task store; `Clock` is injected; no `mock.module()`, no `global.fetch` overrides.
- Tests land with the code at the correct layer (`*.unit.test.ts`, `*.integration.test.ts`, `*.smoke.test.ts`, `*.content.test.ts`); coverage gate ≥ 90/89.
- Env var namespacing (`SHIPWRIGHT_*`, `DATABASE_URL_SHIPWRIGHT_*`); every `process.env.*` read must be documented (`check-config-docs`).
- Public repo: no client names, local paths, secrets, or operator identity in code, fixtures, or docs (`task check-strings`); stage specific files only.
- New system crons ship `enabled: false`; no existing cron is restructured; all new DB columns nullable and additive; no migration path needed for older agents.
- `count_tokens` requires `ANTHROPIC_API_KEY`; agents on OAuth get labelled estimates, and the measured turn-1 baseline is the exact number there.
- `/doctor prompt-audit` ≥ Claude Code 2.1.283 (Dockerfile pins 2.1.285); the scan degrades gracefully and says so when unavailable.
- Token deltas are only comparable same-model across the 4.6 → 5.5 tokenizer change.
- Conventional Commits; versions are synced by CI, never edited by hand.

## Scope

**In Scope**:
- Features 1–5 above, applied to the shipwright repo (root `CLAUDE.md`, `agent/workspace/CLAUDE.md.template` and its imports, `plugins/shipwright/{commands,skills,agents,references,CLAUDE.md}`, `.claude/`, docs referenced from `CLAUDE.md`).
- The production metrics Shipwright must emit for the audit to be measurable, including the outcomes endpoint and review-verdict field.
- The fleet model bump as a measured change.

**Out of Scope**:
- Auditing other repos in the workspace (goals, squadron, marketplace, …); the scripts avoid hardcoded paths where free, but no multi-repo design.
- Wiring Claude Code OpenTelemetry into the Helm chart or manifests (documented as optional only).
- Applying markdown edits automatically; the patrol reports and queues, humans and fix tasks edit.
- Rewriting `/doctor prompt-audit`'s dated-pattern tables; they are delegated to, not reimplemented.
- Fixing the `openapi-typescript` / TypeScript 7 incompatibility (hand-sync `lib/admin-types.ts` meanwhile).
- Format conversions (markdown ↔ XML ↔ JSON) of prompt text; evidence shows no reliable accuracy effect.

## Priorities & Sequence

Strict order, each feature gated on the previous:
1. **Feature 1 (metrics production)** first; nothing downstream is measurable without it. Within it, the agent/admin/pricing core before the outcomes endpoint and review verdict.
2. **Feature 2 (model bump)** only after ≥ 2 weeks or ≥ 20 runs per phase of Feature 1 data.
3. **Feature 3 (`prompt-scan`)** can start in parallel with Feature 2's waiting period; scripts and precheck before the skill; the bootstrap checklist is its exit gate.
4. **Feature 4 (`prompt-fix`)** after Feature 3 (it reads the report and ledger).
5. **Feature 5 (`prompt-eval`)** after Feature 4 (fix tasks cite its command) and after Feature 1's outcomes endpoint (the production-series kind reads it).

## Testing Strategy

| Feature | Layer | Rationale |
|---------|-------|-----------|
| 1. Metrics production | unit + integration + smoke | pure accumulator/stamp/payload/pricing are unit; reporter PATCH body and admin upserts/aggregation need a stub server and real test Postgres; route shapes are in-process smoke |
| 2. Model bump | unit | constants and alias mapping are pure; the measurement is a documented read of production series |
| 3. `prompt-scan` | unit + content | scripts are pure with injected fs/fetch/git/clock and recorded `count_tokens` fixtures; skill and stub markdown are content-asserted; precheck unit-tested like siblings |
| 4. `prompt-fix` | content | markdown executed by the model; contracts (flags, cap, id format, body template) are static assertions; task-store I/O is exercised via `TESTING.md` scenarios |
| 5. `prompt-eval` | unit + content | harness with injected exec/fetch and recorded eval JSON; skill and stub content-asserted |

## Resolved Decisions

- **Measurement model**: Two tiers, gated. Static metrics on every run; model-run evals only for changes that could affect quality, with the cost estimated and capped before running. — Rationale: user decision; static metrics are near-free and sufficient for cost-only findings, while evals burn real spend.
- **Scope**: Shipwright repo only for the first delivery. — Rationale: user decision; the repo is both the plugin source and its first target, and producing the missing metrics is only possible here.
- **Home**: New patrol pair inside the shipwright plugin (`prompt-scan` / `prompt-fix` / `prompt-eval`) mirroring entropy/consolidation/security/error. — Rationale: user decision; reuses scheduling, task-store queuing, prechecks, registries, and the test/version machinery.
- **Target model**: Sonnet 5.5, with the fleet bump from 4.6 as its own measured change (Feature 2). — Rationale: user decision; auditing for the model being moved to avoids re-auditing after the bump.
- **Every change carries a measurable result**: findings are labelled cost-only or quality-claimed; quality-claimed changes require an eval or production series and can never be queued `hitl: false`. — Rationale: user's hard requirement; empirical evidence (arXiv 2602.11988, 2605.10039) shows length alone is not a quality lever.
- **Attribution source**: computed in-stream by the agent, not from transcript JSONL files. — Rationale: the stream already carries every event; the container `$HOME` is not the persistent volume, so files can vanish.
- **Baseline definition**: `input + cache_creation + cache_read` of the first non-subagent assistant turn; dropped on resumed sessions. — Rationale: cache-warmth independent; a resumed first turn replays history.
- **Series key**: `contextFingerprint` over the always-loaded set + plugin version, not merge date. — Rationale: compares what the model was given.
- **Skipped runs**: excluded from token dimensions, included in `baselines`. — Rationale: a `[silent]` dispatch still paid its first-turn context, which is exactly the cost measured.
- **Pricing aliases**: bare `sonnet`/`opus`/`haiku` stay on 4.x keys until Feature 2. — Rationale: the fleet default is still 4.6; aliases move with the measured bump.
- **Token counting**: `count_tokens` per target model via raw `fetch`, estimates labelled when no key; never tiktoken; same-model deltas only. — Rationale: model-specific tokenizers; plugin self-containment.
- **Dated-pattern findings**: delegated to `/doctor prompt-audit`, promoted only after two consecutive runs. — Rationale: judgment output is noisy; the official guide already encodes the keep-list.
- **Cron**: ships disabled; scan and queue only; evals never from the cron. — Rationale: plugin constitution and spend safety.
- **Statistical bar**: ≥ 20 runs per arm before calling a production-series result; ~20–30 frozen cases per eval decision. — Rationale: the cost-optimization guide's "never decide on a one-case swing".
- **Existing implementation**: branch `feat/prompt-audit-metrics` (closed PR #3977) holds most of Feature 1 and may be cherry-picked by the Feature 1 tasks. — Rationale: avoids redoing tested work; the PR was closed to re-plan through this PRD, not for defects.
- **Generated admin types**: hand-synced until the generator is fixed. — Rationale: `openapi-typescript@7` crashes under TypeScript 7 in this repo; fixing it is out of scope.

## Success Criteria

- Every cron run on an upgraded agent reports a first-turn baseline, counts, attribution, and a fingerprint, visible in `bySkill`, `baselines`, and `/outcomes`.
- The model bump is decided from before/after numbers per phase, written down, and either kept or reverted on evidence.
- The first `/shipwright:prompt-scan --with-doctor` on this repo reproduces the ten bootstrap findings, and every row states its metric, tier, and cost-only/quality-claimed label.
- Every `prompt-fix` task body contains an acceptance command whose output proves a same-model token delta, and quality-claimed tasks additionally cite an eval or production series in their PR.
- The patrol runs weekly, disabled by default, and can be enabled per agent with no other configuration.
