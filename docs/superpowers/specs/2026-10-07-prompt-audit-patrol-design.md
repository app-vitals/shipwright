# Prompt-audit patrol for Shipwright — design spec (2026-10-07)

## Context

Shipwright runs on a large body of LLM-facing markdown: root `CLAUDE.md` (221 lines), `agent/workspace/CLAUDE.md.template` (228 lines, the file the deployed agent actually loads every session), 29 plugin commands (~150k tokens), 26 skills (~115k tokens), 4 agents, `.claude/` rules/skills, and 31 docs. Much of it was written against a Sonnet that no longer exists: the fleet default is `claude-sonnet-4-6` (`lib/default-agent-env.ts`), current Sonnet is 5.5, and `lib/pricing.ts` has no 5.x model at all. Nobody re-audits this text when models change, and there is no token accounting per file, per skill, or per run.

Goal: a **periodic audit** (scan → report → queue fixes) that proposes markdown changes which lower input/output tokens and improve fit for the model in use. **Every proposed change carries a measurable result.**

Decisions made with the user (2026-10-07):
1. **Measurement is two-tier, gated.** Free static metrics on every run. Model-run evals only where quality could move, with cost estimated and capped before running.
2. **Shipwright only.** Scripts avoid hardcoded paths where free, but no multi-repo design. If the audit needs metrics Shipwright does not emit today, producing them is in scope.
3. **Home: a new patrol pair in the shipwright plugin** (`prompt-scan` / `prompt-fix`, plus `prompt-eval`), mirroring entropy/consolidation/security/error patrols: ledger in `state/`, decisions registry in `.claude/shipwright/`, disabled-by-default cron with a precheck.
4. **Target model is Sonnet 5.5**, and the fleet bump from 4.6 → 5.5 is itself a measured change in this plan.

Three research findings (ETH Zurich arXiv 2602.11988 and arXiv 2605.10039; the official Claude Code loading docs; Anthropic's context-engineering guidance) drive the design: (i) context files raise cost >20% and rarely raise success, and file *size* has no measurable adherence effect (ETH Zurich 2602.11988; 2605.10039), so "shorter" is never a justification by itself; (ii) what matters is *which text loads every turn* vs on demand, and the official loading rules are exact (imports load at launch; `paths:` rules and skill bodies load on demand; skill descriptions always, under a 1%-of-context budget with a 1,536-char cap per entry); (iii) official tooling already covers dated-model patterns (`/doctor prompt-audit`), with/without evals (`claude plugin eval`), and exact token counts (`count_tokens`), so the plugin wraps them and adds the two things missing: production measurement and a tracked, queued, measured loop.

## Design overview

```
PR 1  metrics production        agent emits per-run context baseline + per-skill token attribution
                                 admin stores them, exposes bySkill / baselines / outcomes series
                                 pricing knows 5.x models + context windows
PR 2  model bump (measured)      DEFAULT_ANTHROPIC_MODEL → claude-sonnet-5-5; before/after read from PR 1 series
PR 3  prompt-scan (static)       inventory → tokens per model per context → stale refs → structure → density
                                 (+ /doctor prompt-audit for dated patterns) → ledger + prompt-audit-report.md
PR 4  prompt-fix (queue)         report → task-store tasks whose body embeds the measurement plan + acceptance criteria
PR 5  prompt-eval (evals)        with/without, A/B on two checkouts, trigger sets, production series → ledger.measured
```

Two **contexts** are reported everywhere, because load class differs:
- `local-dev`: cwd = repo root. Always-loaded = root `CLAUDE.md` + `.claude/rules/*.md` without `paths:` + skill/agent listing.
- `agent-runtime`: cwd = `$AGENT_HOME/workspace`. Always-loaded = rendered `agent/workspace/CLAUDE.md.template` (+ its `@SOUL/IDENTITY/BOOTSTRAP/VOICE` imports) + listing. Root `CLAUDE.md` is a *subdirectory* file, loaded on demand when the agent touches `repos/shipwright/`.

## PR 1 — Metrics production

**Why first:** without per-run and per-skill token data, every "saving" is an estimate and no quality regression is detectable. The agent's stream-json already carries what is needed; it is just not recorded.

### A1. Per-run context baseline
- `agent/src/claude.ts` `_consumeStream`: on the first `assistant` line with `message.usage`, capture `FirstTurnUsage { model, inputTokens, cacheCreationTokens, cacheReadTokens, contextTokens (sum of three), messageId }`. The three-way sum is the full turn-1 context regardless of cache warmth (verified on a local transcript: 2 + 41,415 + 37,771 ≈ 79k before any work). Also count `turns` (distinct message ids) and `toolCalls` (tool_use blocks). Expose on `ClaudeRunResult` and on the partial-usage paths of `ClaudeTimeoutError` / `ClaudeRunError` (same pattern as `partialModelUsage`).
- New `agent/src/context-stamp.ts`: `computeContextStamp(deps) → { contextFingerprint, pluginVersion, claudeCodeVersion }` where fingerprint = sha256(workspace CLAUDE.md + sorted no-`paths` rules + plugin version)[:12]. Lets series be grouped by *content*, not merge date. Reuse `detectClaudeCodeVersion` (`agent/src/claude-version.ts`).
- `agent/src/cron-handler.ts` `buildTokenPayload(usage, modelUsage, extra?)` and `agent/src/cron-run-reporter.ts` `RunReportOpts`: add `contextBaseline`, `turns`, `toolCalls`, `claudeCodeVersion`, `pluginVersion`, `contextFingerprint`. Pass at all call sites (`cron-handler.ts` ~476/495, `loop-orchestrator.ts` ~1049/1105/1163).
- `admin/prisma/schema.prisma` `AgentCronRun`: nullable additive columns `baselineModel`, `baselineContextTokens`, `baselineInputTokens`, `baselineCacheCreationTokens`, `baselineCacheReadTokens`, `turns`, `toolCalls`, `claudeCodeVersion`, `pluginVersion`, `contextFingerprint` (+ index). Migration; `admin/src/agent-cron-runs.ts` PATCH `runData` spreads them; `openapi-schemas.ts` updated.

### A2. Per-skill / per-command attribution (primary: in-process transcript attribution)
- New `agent/src/transcript-attribution.ts` (pure, I/O injected): `attributeTranscript(lines) → SkillUsageRow[]` with `{ kind: command|skill|agent|root, name, invocations, turns, input/output/cacheRead/cacheCreation tokens, invokeContextDelta }`. Rules: a `user` line with `<command-name>/shipwright:X</command-name>` sets bucket `command:X`; an assistant `tool_use` named `Skill` sets `skill:<input.skill>`; `Agent` with `subagent_type` sets `agent:<type>` for that turn; each usage-bearing assistant line (dedup by message id) accrues to the current bucket; `invokeContextDelta` = cache_creation jump on the first turn after a Skill invoke (the measured on-invoke body cost). `transcriptPathFor(home, cwd, sessionId)` encodes the path the way Claude Code does.
- Runs **in-process immediately after `completeRun`/`skipRun`** because `$HOME` in the container is not the persistent volume, so transcripts can vanish on restart.
- New admin model `AgentCronRunSkillUsage` (unique `[cronRunId, kind, name]`), written via the existing PATCH run endpoint (`skillUsage: rows[]`, upsert like `modelBreakdown`). `CronRunReporter.recordSkillUsage(...)` + no-op in `NoopCronRunReporter`.
- `admin/src/agent-cron-run-stats.ts`: add `bySkill` and `baselines` (`{ contextFingerprint, baselineModel, phase, runs, avg/min/max contextTokens, firstSeen, lastSeen }`) to `CronRunTokenStats`; mirror types in `metrics/src/lib/admin-metrics-client.ts`.
- OpenTelemetry (`CLAUDE_CODE_ENABLE_TELEMETRY=1`, `OTEL_LOG_TOOL_DETAILS=1`, `claude_code.token.usage{skill.name,…}`) documented in `docs/configuration-agent.md` as an operator-side alternative; not wired (needs a collector; redacts names by default; unavailable on Bedrock/Vertex).

### A3. Outcome metrics (the "accuracy didn't regress" side)
- Already stored: `AgentCronRun.outcome/error/skipReason/duration/phaseId/itemId`; task-store `PullRequest.patchCycles/reviewCycles/blocked*/mergedAt` + commit-count columns; `Task.ciFixAttempts`; `VerificationCheck.status/durationMs`. Corrective-commit ratio is computed ad hoc from `git log` (as `test-debt` does today).
- New: `turns`/`toolCalls` (A1); task-store `PullRequest.lastReviewVerdict` + `lastReviewVerdictAt` (written by `review`'s record step; verdict histogram is not stored today); admin `GET /agents/all/cron-runs/outcomes?from&to` returning per `(phase, contextFingerprint)`: runs, completed, failed, skipped, skipReasons, avg/p50 duration, avgTurns, avgToolCalls, avgContextTokens.
- Decision rule for any markdown change to a phase command: compare that phase's series for `contextFingerprint` before vs after; require **n ≥ 20 runs per arm** before calling a result.

### A4. Pricing
`lib/pricing.ts`: add `claude-opus-5-5`, `claude-sonnet-5-5`, `claude-haiku-5-5` (rates from the bundled claude-api skill's table, not from memory); add `CONTEXT_WINDOW` per model (for the 1% listing budget); `normalizeModelToRateKey` maps the 5.x ids. Bare `sonnet/opus/haiku` aliases move to 5.5 **in PR 2**, not here. New unit test: every `claude-*` id in `agent-types/*/manifest.yaml`, `agent/src`, `lib/`, and `docs/configuration-agent.md` resolves.

### A5. Tests + docs
Unit: `claude.unit.test.ts` (first-turn capture, dedupe, partials on timeout), `transcript-attribution.unit.test.ts` (scrubbed JSONL fixture under `agent/src/fixtures/transcripts/`), `context-stamp.unit.test.ts`, `pricing.unit.test.ts`. Integration: `cron-run-reporter.integration.test.ts` (new PATCH fields), `agent-cron-run-stats.integration.test.ts` (bySkill, baselines). Smoke: `agents-api.smoke.test.ts` (`/outcomes`, admin-only). Docs: `docs/agent.md` (model count), `docs/agent-api-ops.md`, `docs/configuration-agent.md`, `docs/metrics.md`. Backward compatible: all columns nullable, old agents omit fields. No cron change in this PR.

## PR 2 — Model bump as a measured change

- Capture **≥ 2 weeks** (or ≥ 20 runs/phase) of PR 1 series on `claude-sonnet-4-6` first.
- Change `DEFAULT_ANTHROPIC_MODEL` (`lib/default-agent-env.ts`) and the runtime fallback (`agent/src/config.ts`, `agent/src/claude.ts`) to `claude-sonnet-5-5`; move pricing aliases; update `docs/configuration-agent.md`. Existing agents keep their seeded `ANTHROPIC_MODEL` env, so the PR includes a HITL step: update each agent's env via the admin API (`shipwright:agent-admin` skill) and record the date.
- Measurement: `baselines` and `/outcomes` split by `baselineModel`. Report cost per completed task, context tokens at turn 1 (expect a different count on the same markdown: new tokenizer), turns, failure/skip rates, patch cycles, per phase. Keep or revert on evidence. Note for the audit: **token deltas for a markdown edit are only valid same-model**; the scan always reports both models until the fleet is fully on 5.5.

## PR 3 — `prompt-scan` (static tier)

### Scripts: `plugins/shipwright/scripts/prompt-audit/` (Bun/TS, pure core + injected deps, each file < ~250 lines, unit test beside each)

| File | Exports |
|---|---|
| `inventory.ts` | `walkInventory(root, deps) → InventoryEntry[]` — kind (`claude-md|rule|import|skill|command|agent|reference|template|doc`), `loadClass` per context (`always|on-demand-path|on-invoke|on-reference|listing`), frontmatter (`name`, `description`, `paths`), description chars, body lines, `@` imports (≤ 4 hops). Treats `agent/workspace/CLAUDE.md.template` as the `agent-runtime` always file. |
| `token-count.ts` | `countTokens(texts, models, deps:{fetchFn, apiKey, cache})` → per id per model `{tokens, estimated}`. Raw `fetch` to `POST /v1/messages/count_tokens` (the plugin is self-contained: no SDK dependency, see `scripts/clock.ts` header). No key or non-2xx → `ceil(bytes/4)` with `estimated: true`, always labelled. Cache `state/prompt-audit/token-cache.json` keyed by sha256(model+content). `listingBudget(model)` = `CONTEXT_WINDOW × 0.01` chars. |
| `reference-resolver.ts` | `extractReferences(content) → Ref[]` (path, command, flag, model-id, env-var) and `resolveReferences(refs, deps:{exists, taskNames, packageScripts, commandFlags, knownModels}) → Unresolved[]`; `findOrphanedAutoSections(content, deps:{grepRepo})`. |
| `instruction-density.ts` | `measureDensity(content)` → imperatives, caps emphasis (`MUST|NEVER|ALWAYS|CRITICAL`), numbered steps, bold imperatives, first-hard-constraint line ratio. |
| `usage-attribution.ts` | `attributeLocalTranscripts(deps, sinceDays)` (local `~/.claude/projects` parse, same rules as A2, ~40 lines duplicated by design) and `fetchCronSkillStats(deps, from, to)` (admin `bySkill`; unreachable → null, never fail the scan). |
| `blame-age.ts` | `blameAges(path, deps:{gitBlame})` → max/median age, oldest line. |
| `rules.ts` | one function per rule; `runStaticRules(...) → Finding[]`. Thresholds documented in `skills/prompt-scan/references/thresholds.md`. |
| `fingerprint.ts`, `ledger.ts`, `report.ts` | fingerprint = sha256(class|rule|file|normalizedEvidence)[:12] (no line numbers); ledger read/merge/write with injected `now`; `renderReport` → `prompt-audit-report.md`. |
| `cli.ts` | `scan --repo <dir> --model <id>… --scope <path> [--json] [--dry-run] [--since-days 28]` and `measure --finding <fp> --before <ref> --after <ref> --model <id>` (same-model token delta of the file at two refs; the fix task's acceptance check). |
| `../check-prompt-audit.ts` | precheck: missing ledger → exit 0 (bootstrap); `lastRun` < 7 days and no `proposed` findings → exit 1; else exit 0 + summary. Mirrors `check-consolidation-patrol.ts` incl. unit test. |

### Finding record (shared by scripts, ledger, report, task bodies)
`{ fingerprint, class, rule, file, line, lineEnd?, loadClass, contexts[], evidence, metrics:{before, projectedAfter?, units, estimated}, measurement:{tier: static|eval, evals?:[{kind, estCostUsd}], acceptance}, confidence, action, severity }`

### Finding taxonomy + measurement contract

| Class | Rules (v1) | Static proof | Eval required? |
|---|---|---|---|
| **a** always-loaded cost | `claude-md-over-200-lines`, `always-set-tokens` (per context × model), `rule-without-paths`, `import-chain`, `listing-budget-share`, `listing-entry-over-1536` | `count_tokens` per model; share of context window; listing chars vs 1% budget; **measured** `baselineContextTokens` from A1 when reachable | Only when deleting behavioral text (with/without). Otherwise cost-only. |
| **b** on-invoke cost | `on-invoke-heavy` (body > 8k tokens), `invoke-cost-weekly` | tokens(body) × invocations/week (`bySkill`, else local transcripts, else "usage unavailable"); `avgInvokeContextDelta` replaces the static count when present | Production series by phase (A3) or A/B on two checkouts |
| **c** stale facts | `unresolvable-path`, `unresolvable-command`, `unknown-flag`, `retired-model-id`, `orphaned-auto-section`, `blame-age` (> 180 d) | Resolvability against FS / `Taskfile.yml` / `package.json` / stub flags; id ∉ `RATES`; banner with no writer; blame age | None. Correctness fix, static-only. |
| **d** dated-model patterns | delegated to `/doctor prompt-audit` (pressure language, scaffolds, over-specification, fossils, prohibition clusters, brittle config files) | token delta of the proposed diff; doctor confidence; **2 consecutive runs** to promote (judgment noise) | **Yes** when removing behavioral text; static-only for pure fossils/history narrative |
| **e** structure vs loading rules | `move-to-path-rule` (overview prose in an always file), `skill-to-docs-index` (skill invoked in > 60% of runs), `skill-over-500-lines`, `key-instructions-not-near-top` (first hard constraint after 40% of file; 5k-token post-compaction cap), `description-over-1536`, `description-multiline`, `frontmatter-missing-name`, `duplicate-listing-entry` (stub + skill same description, paid twice in the listing) | tokens moved always → on-demand × sessions/week; listing chars saved; position ratio | Trigger-set eval whenever a description changes; with/without for reclassification |
| **f** instruction density | `instruction-count-high` (> 60 imperatives/file), `caps-emphasis-ratio`, `prohibition-cluster` | counts per file | Only when consolidating instructions |

Every report row is labelled **cost-only** or **quality-claimed**; the latter cannot be queued as `hitl: false`.

### Skill `plugins/shipwright/skills/prompt-scan/SKILL.md` + stub `commands/prompt-scan.md`
Flags: `--summary`, `--dry-run`, `--model <id>` (repeatable; default `[ANTHROPIC_MODEL, claude-sonnet-5-5, claude-sonnet-4-6]`), `--scope <path>`, `--with-doctor`, `--since-days <n>`.
Steps (consolidation-scan shape): parse args → load `.claude/shipwright/prompt-audit-decisions.md` → load `state/prompt-audit-ledger.json` → run `cli.ts scan --json` → judgment pass: class (e) `move-to-path-rule` candidates; with `--with-doctor`, invoke `/doctor prompt-audit <scope>` (≥ 2.1.283; Dockerfile pins 2.1.285; if unavailable, apply the bundled claude-api `shared/prompt-audit.md` checklist inline and say so) and parse rows into class (d) findings → fingerprint + merge (class d needs 2 consecutive runs) → suppress via registry → write ledger (not on `--dry-run`) → write report (not on `--summary`/`--dry-run`) → summary → Constraints (no code/git/task-store writes; token cache is the only other write; estimates labelled).
Report: header (models, contexts, Claude Code version, estimated?), always-loaded baseline table (context × model: static vs measured), listing budget table, one section per class sorted by projected weekly token saving, each row with before → projected after, tier, est. eval cost, cost-only/quality-claimed.

### Ledger `state/prompt-audit-ledger.json` (snapshot; `history` append-only) — schema in `skills/prompt-scan/references/ledger-schema.md`
`{ lastRun, models[], claudeCodeVersion, baselines:{context:{model:{alwaysTokens, listingChars, estimated}}}, findings:{fp:{…Finding, status: tracking|proposed|queued|measured|resolved|suppressed, firstSeen, lastSeen, runsSeen, taskId, measured:{kind, before, after, delta, costUsd, series:{endpoint, from, to, phase, contextFingerprintBefore/After, runsBefore/After}, artifacts[], runAt}, history[]}} }`. `resolved` only when a `queued`/`measured` entry stops reproducing; a vanished `tracking` entry is left alone.

### Registry `.claude/shipwright/prompt-audit-decisions.md`
Four-field entries (`**Finding:** / **Decision:** / **Rationale:** / **Revisit:**`), human-edited only. Add as the third instance in `plugins/shipwright/references/decisions-registry.md` + its content test. Seed with one entry (e.g. keep the "Before you commit" section's density deliberately).

### Cron, docs, marketplace
- `agent-types/coding/manifest.yaml`: `prompt-audit-maintenance`, `0 7 * * 1`, prompt `/shipwright:prompt-scan --with-doctor` then `/shipwright:prompt-fix`, `silent: true`, `preCheck: shipwright:check-prompt-audit.ts`, **`enabled: false`**. Extend any manifest content test enumerating cron names; regenerate schema if needed.
- `docs/agent-ops.md` cron row; new `docs/prompt-audit.md`; root `CLAUDE.md` Reference bullet; `plugins/shipwright/README.md` (+3 commands); `TESTING.md` scenarios (scan reproduces the bootstrap checklist; `--dry-run` writes nothing; fix `--dry-run` preview; eval cost gate prints before running). Conventional `feat:` commits; no manual version edits (CI syncs).
- Tests: unit per script (temp-dir mini repo fixture: CLAUDE.md, rules with/without `paths:`, skill + duplicate stub, workspace template, a doc with `claude-sonnet-4-5`, an orphaned banner; recorded `count_tokens` JSON; injected `fetchFn` asserting request shape; estimate fallback), `check-prompt-audit.unit.test.ts`, content tests for SKILL.md and stub (flags, step order, Constraints, registry + pre-filing citations). Nothing hits the API, `claude`, or the admin API.

### Bootstrap acceptance checklist (first `/prompt-scan --with-doctor` on this repo must produce)
1. `c / orphaned-auto-section` — `CLAUDE.md:71-81` "Shipwright Learned Facts" (writer removed in #3701; only `dev-task.content.test.ts` asserts its absence).
2. `c / retired-model-id` — `docs/agent.md:78`, `admin/prisma/schema.prisma:297` (`claude-sonnet-4-5` ∉ RATES).
3. `a / claude-md-over-200-lines` — root `CLAUDE.md` (221, local-dev) and `CLAUDE.md.template` (228, agent-runtime), with per-model tokens and window share.
4. `b / on-invoke-heavy` — `commands/patch.md` (2,601 lines, ~36k tokens) × patch invocations/week, or "usage unavailable".
5. `e / frontmatter-missing-name` — the 20 commands without `name`.
6. `e / description-multiline` — 18 commands.
7. `e / duplicate-listing-entry` — thin stubs duplicating their skill's description.
8. `e / skill-over-500-lines` — `investigate-cron` (899), `test-fix` (630), `security-scan` (611), `error-fix` (511).
9. `a / listing-budget-share` — listing chars vs 1% budget per model, naming which entries lose descriptions first.
10. ≥ 1 `d` row from `/doctor prompt-audit` (e.g. pressure language in "Before you commit"), `tracking` until run 2.

## PR 4 — `prompt-fix` (queue with measurement plans)

Skill `skills/prompt-fix/SKILL.md` + stub. Flags `--dry-run`, `--class <a-f>`, `--finding <fp>`. Steps: report exists → filter `proposed` → live registry re-check → pre-filing verification (`file:line` still matches) → `--dry-run` preview → cap 10/run (class c first: static-only, then by projected saving) → dedup `GET /tasks?status=pending|in_progress&repo=…&limit=1000` on the `prompt-` id prefix → `POST /tasks/bulk` → mark ledger `queued` + `taskId`.
Task: `id: prompt-{class}-{fp8}-shipwright-{YYYY-Www}`, `source: prompt-fix`, `branch: chore/prompt-{fp8}-{slug}`, `layer: Docs`, `hitl: true` for class d/e changes that remove or move behavioral text, else `false`. Body template embeds evidence, static metric before → projected after (model, estimated?), measurement plan, and **acceptance criteria the executing agent must prove**: (1) `cli.ts measure --finding {fp} --before main --after HEAD --model {m}` reports `tokenDelta ≤ −N`; (2) if eval tier: `/shipwright:prompt-eval --finding {fp} --kind {…} --max-cost-usd {X}` reports score delta ≥ 0 and the JSON is attached to the PR; (3) ledger `measured` populated and cited in the PR body. Plus "suppress instead: add a registry entry".

## PR 5 — `prompt-eval` (eval tier)

Skill `skills/prompt-eval/SKILL.md` + stub; flags `--finding`, `--kind with-without|ab|trigger|production-series`, `--max-cost-usd` (default 5), `--model`, `--runs` (default 3). Harness `scripts/prompt-audit/eval-harness.ts`: `buildEvalCases` (20–30 frozen prompts derived from the command's own steps; trigger sets = should/shouldn't prompts with `tool_used: Skill` grader), `runPluginEval` (wraps `claude plugin eval --json --trust-plugin --no-publish --max-cost-usd`), `abOnTwoCheckouts` (`git worktree add` base/head, same cases, diff JSON), `productionSeries` (reads `/outcomes` + `/stats` by `contextFingerprint`). Prints estimated cost (cases × runs × arms × last per-case cost, default $0.10) **before** running and refuses without a cap. Writes `ledger.findings[fp].measured` and a PR-citable block. Caveat enforced: `claude plugin eval` loads only the plugin, so CLAUDE.md-class findings use `production-series` or `with-without` with `append_system_prompt`.

## Verification

- `task ci` green on every PR (lint, check-strings, typecheck, check-config-docs, version-sync, coverage ≥ 90/89, secret-scan).
- PR 1: run `task stack`, create an agent, let one cron tick run, confirm `GET /agents/all/cron-runs/stats` shows `bySkill` and `baselines` rows and the run row has `baselineContextTokens`, `turns`, `contextFingerprint`.
- PR 2: after ≥ 2 weeks, `/outcomes` and `/stats` split by `baselineModel`; decision written into `docs/prompt-audit.md`.
- PR 3: `/shipwright:prompt-scan --with-doctor --dry-run` on this repo reproduces the 10-item bootstrap checklist; `--dry-run` leaves `state/` and the report untouched (`git status` clean except the token cache).
- PR 4: `/shipwright:prompt-fix --dry-run` previews tasks with acceptance criteria; a real run creates ≤ 10 tasks visible via the task-store query in `CLAUDE.md`.
- PR 5: `/shipwright:prompt-eval --finding <fp> --kind ab --max-cost-usd 2` prints the estimate first, runs, and writes `measured`.

## Risks and gates (state in `docs/prompt-audit.md`)

- **API spend:** `count_tokens` is near-free; evals are capped by `--max-cost-usd` and never run from the cron (cron scans and queues only).
- **Auth:** `count_tokens` needs `ANTHROPIC_API_KEY`; agents on OAuth get labelled estimates. The measured turn-1 baseline (PR 1) is the exact number on agents.
- **Version gates:** `/doctor prompt-audit` ≥ 2.1.283, `/skill-doctor` ≥ 2.1.252; scan degrades gracefully and says so.
- **Transcripts are machine-local and `$HOME` is non-persistent in the container:** attribution runs in-process right after each run.
- **Tokenizer change at the model bump:** same-model comparisons only; both models reported until the fleet is on 5.5.
- **Evidence caveat:** size alone has no measured adherence effect; every "shorten" finding is cost-only unless an eval says otherwise.
- **Plugin CLAUDE.md "System Cron Changes":** new cron ships disabled; no existing cron restructured; no migration path needed.
- **Public repo:** fixtures scrubbed; no client names, no local paths, no secrets in recorded transcripts.

Research appendix (verified sources, repo inventory) lives in the planning session notes; the findings that drive this design are summarized in the Context section above.

