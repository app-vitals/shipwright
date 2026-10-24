# Prompt Audit

> Measured, report-only auditing of the prompts the agent loads (CLAUDE.md files, rules, skills, commands, agents, templates). `prompt-scan` finds token-cost, staleness, structure and instruction-density problems, tracks them in a ledger, and lets a human accept a cost deliberately. The `prompt-audit-maintenance` cron runs it weekly (disabled by default, opt-in per agent). Design rationale: [`docs/superpowers/specs/2026-10-07-prompt-audit-patrol-design.md`](./superpowers/specs/2026-10-07-prompt-audit-patrol-design.md).

## Overview

Prompt files grow by accretion. Every always-loaded line is paid for on every run, and a long or emphatic prompt is not automatically a better one. The prompt-audit subsystem has three layers, mirroring [`docs/consolidation.md`](./consolidation.md):

1. **Detection** — `prompt-scan` runs deterministic rules over a prompt inventory, adds two judgment passes the rules cannot make, and writes a report. It never edits a prompt.
2. **Decision** — `.claude/shipwright/prompt-audit-decisions.md` is a human-edited registry of findings that were reviewed and deliberately accepted. The scan re-reads it live every run and suppresses matches.
3. **Action** — `prompt-fix` turns proposed findings into propose-only task-store tasks with measurement plans, and a later `prompt-eval` skill runs the eval tier. `prompt-eval` is specified in the design doc but not shipped yet.

Every finding is labelled **cost-only** (the proof is a same-model token delta; quality is unmeasured and the report says so) or **quality-claimed** (the change could alter what the model reads, so it always carries an eval). Size alone has no measured adherence effect, so every "shorten" finding is cost-only unless an eval says otherwise.

## What `prompt-scan` does

Flags: `--summary`, `--dry-run`, `--model <id>` (repeatable), `--scope <path>`, `--with-doctor`, `--since-days <n>` (default 28).

1. Load the decisions registry (missing file is a no-op).
2. Load `state/prompt-audit-ledger.json`.
3. Run `plugins/shipwright/scripts/prompt-audit/cli.ts scan --json` — the mechanical rules.
4. Judgment pass: class (e) `move-to-path-rule` candidates, and with `--with-doctor` the class (d) dated-model patterns from `/doctor prompt-audit` (Claude Code ≥ 2.1.283; without it the scan applies the bundled checklist inline and says so).
5. Fingerprint and merge into the ledger; class (d) findings need two consecutive runs.
6. Suppress findings the registry accepted.
7. Write the ledger and `prompt-audit-report.md`.

`--dry-run` writes neither the ledger nor the report (the token cache is the only other write). `--summary` skips the report. The skill makes no code, git or task-store writes. Rule thresholds live in [`skills/prompt-scan/references/thresholds.md`](../plugins/shipwright/skills/prompt-scan/references/thresholds.md); the `THRESHOLDS` constant in `scripts/prompt-audit/finding.ts` is authoritative.

### Finding classes

| Class | Covers |
|-------|--------|
| a | Always-loaded cost: CLAUDE.md length, always-set tokens, rules without `paths:`, import chains, listing budget |
| b | On-invoke cost: heavy commands/skills, weekly invocation cost |
| c | Staleness: unresolvable paths/commands/flags, retired model ids, orphaned auto-maintained sections, blame age |
| d | Dated-model patterns, from `/doctor prompt-audit` |
| e | Structure: frontmatter, duplicate listing entries, oversize skills, instruction placement, sections that belong in a path rule |
| f | Instruction density: instruction count, caps emphasis, prohibition clusters |

## What `prompt-fix` does

Flags: `--dry-run`, `--class <a-f>`, `--finding <fp>`. Steps: report exists, filter `proposed`, live registry re-check (decisions and `**Autonomy:**` entries), pre-filing verification ([`references/pre-filing-verification.md`](../plugins/shipwright/references/pre-filing-verification.md): `file:line` still matches), cutover freeze check, weekly cap check, `--dry-run` preview, cap of 10 tasks per run (class c first, then projected saving), dedup against `pending`/`in_progress` tasks on the `prompt-` id prefix (`limit=1000` with the pagination guard), `POST /tasks/bulk`, then mark the ledger `queued` with `taskId`. It mirrors `entropy-fix` and `consolidation-fix` but is stricter on `hitl`.

Task shape: `id: prompt-{class}-{fp8}-shipwright-{YYYY-Www}`, `title: "Prompt audit: {rule} - {file}"`, `source: prompt-fix`, `branch: chore/prompt-{fp8}-{slug}`, `layer: Docs`. The body carries the evidence, the metric before and projected after, the measurement plan, an embedded blast-radius report (the executing agent re-runs `cli.ts blast` and stops and escalates if the output differs), the acceptance criteria, a PR must-prove list (content tests pass, same-model token delta, every removed line dispositioned, always-loaded set did not grow, eval or production series for behavioral edits, `docs:`/`chore:` title) and a "suppress instead" note.

### Guardrails

- **Propose-only at launch.** `hitl` is computed by the pure function in `scripts/prompt-audit/hitl-policy.ts`, never by model judgment. With no promoted rule every task is `hitl: true`, including class c.
- **Promotion is human-controlled.** A rule can reach `hitl: false` only through an `**Autonomy:** <rule>, <evidence>` entry in the decisions registry citing at least 5 accepted proposals, and then only for a pure fact repair (class c, replacement verified by command) on a low-fanout file (not a `CLAUDE.md`, `.claude/**`, command, agent, `agent/workspace/*.template`, methodology contract, or any file a cron invokes) with no pinning content test, no description or frontmatter change, a diff of 20 lines or fewer and a single lever. Quality-claimed findings are always `hitl: true`.
- **Cutover freeze.** Nothing is filed while PAU-2.3 is done and PAU-2.4 is not, so prompt edits are not confounded with the model change.
- **Weekly cap.** At most 2 prompt-fix tasks open or merged per ISO week, so each change is isolable in the series.
- **Visibility.** The `prompt-scan` summary lists open prompt-fix HITL tasks older than 14 days.
- **Known gap.** `hitl: true` blocks agent pickup, not merge: branch protection requires 0 approvals and the merging account is a bypass actor, so a hand-opened PR can still merge unreviewed. A CODEOWNERS rule with required code-owner review would close it but conflicts with the bypass-actor design; this is an open question, not scheduled work.

## The ledger

`state/prompt-audit-ledger.json` is workspace state (git-ignored): a current-state snapshot overwritten each run, except each finding's append-only `history`. Findings move through `tracking → proposed → queued → measured → resolved`, or `suppressed`. Fingerprints are `sha256(class|rule|file|normalizedEvidence)[:12]`, free of counts and line numbers so they survive drift. Schema: [`skills/prompt-scan/references/ledger-schema.md`](../plugins/shipwright/skills/prompt-scan/references/ledger-schema.md).

## The decisions registry

`.claude/shipwright/prompt-audit-decisions.md` holds four-field entries (**Finding**, **Decision**, **Rationale**, **Revisit**). It is edited by humans only; the skills load it and never write it. It is the third instance of the shared pattern in [`references/decisions-registry.md`](../plugins/shipwright/references/decisions-registry.md).

## The cron

`prompt-audit-maintenance` (`0 7 * * 1`, weekly Monday 07:00, `silent: true`, **disabled by default**) is defined in `specialties/coding/manifest.yaml`. Its `check-prompt-audit.ts` precheck exits 0 when the ledger is missing or unreadable (so the first scan can bootstrap it), when `lastRun` is null or 7+ days old, or when a recent ledger holds `proposed` findings; otherwise it exits 1 and the run is skipped. See [`docs/agent-ops.md`](./agent-ops.md) for the cron table.

## Measurement

`cli.ts` also provides `measure` (same-model token delta between two refs), `blast` (reverse-reference blast radius of a file) and `watch` (post-merge regression check comparing before/after context fingerprints per phase). Run telemetry (per-run context baseline, per-skill attribution, outcome metrics) is exposed through the admin cron-run stats endpoints; see [`docs/agent-api-ops.md`](./agent-api-ops.md).

### Eval case format and runner

The eval harness (`scripts/prompt-audit/eval-*.ts`) emits cases in the layout `claude plugin eval` loads: `evals/<case>/prompt.md` (frontmatter `max_turns`, `allowed_tools: [Read, Glob, Grep, Skill]`, prompt as body) plus `evals/<case>/graders/NN-<kind>.md` with YAML frontmatter.

| Harness grader | Plugin-eval grader |
|----------------|--------------------|
| `tool_used` present | `type: tool_used`, `tool: Skill`, `input_match: '"skill"\s*:\s*"(?:shipwright:)?<skill>"'`, `min: 1` |
| `tool_used` absent | same, `min: 0`, `max: 0` |
| `transcript_contains` | `type: regex`, `target: last_message`, `pattern: <escaped text>` |
| `llm_judge` | `type: llm`, rubric as the body (judge model chosen with `--judge-model`) |
| `tests_pass`, `task_store_state` | **dropped**, with a logged reason per case |

`transcript_contains` targets `last_message`, not `trace`: the trace includes the user prompt, which names the step, so a trace regex would pass vacuously. `tests_pass` and `task_store_state` are dropped rather than faked because plugin eval has no repo checkout to run tests in and runs cannot reach the task store; historical cases keep their `tool_used` grader only.

`runPluginEval` takes an eval-dir name (cases live under `<pluginDir>/<evalDir>/`), writes `--json` to a scratch file and parses the `schemaVersion: 1` document: seeds come from `cases[].arms.with[].passed`, and a `partial: true` result throws. It passes `--ablation none` unless the caller asks for `with-without` (which adds a no-plugin baseline arm, doubling cost, and excludes `tool_used: Skill` graders from the score; read `aggregates.meanDelta`), and `--threshold 0` so imperfect cases do not make the CLI exit non-zero.

**Run isolation.** Plugin-eval runs get a temporary home and only an env allowlist plus `EVAL_*` variables, so `SHIPWRIGHT_TASK_STORE_*` and `gh` auth do not reach the run. `dev-task`, `review` and `patch` are therefore side-effect-free under plugin eval, but also inert past their first task-store or `gh` call. Historical replay would need `case.yaml` `execution.env` pointed at a local task store plus a `scaffold_script`; that is out of scope and remains a PAU-5.4 limitation.

## Model cutover decision (2026-10-24)

**Decision: keep `claude-sonnet-5-5` as the fleet default** (PAU-2.4). The `prompt-fix` cutover freeze lifts with this note.

**What was actually measured.** PAU-2.x was written as a Sonnet 4.6 → 5.5 bump. Run telemetry (PAU-1.x) began on 2026-10-08, by which point the fleet was already on 5.5; the previous default was `claude-sonnet-5`, retired during the week of 2026-09-29 (`claude-sonnet-4-6` was a minor model, ~1.6% of lifetime spend, last used before 2026-10-05). PAU-2.3's agent audit on 2026-10-13 found every phase-running agent on 5.5 and made no env writes; two agents are intentionally on Opus 5.5 and run no phases. So this is a `claude-sonnet-5` → `claude-sonnet-5-5` production series over pre-telemetry run records, not an A/B with per-run baselines on both sides.

**Windows.** Sonnet 5: 2026-09-08 → 09-29 (21 days). Sonnet 5.5: 2026-10-06 → 10-25 (19 days). Sources: `GET /agents/all/cron-runs/outcomes` and `/stats` with `from`/`to`, and the task-store `/prs` records for this repo (bot authors excluded). The ≥20 runs per phase gate is met on 5.5 for deploy, dev-task, patch and review; `plan` has 3 runs (the phase ships disabled) and is excluded.

| Phase | Completed runs | Cost / completed run | Output tokens / completed run | Cache-read tokens / completed run | Mean duration | Skip rate |
|-------|----------------|----------------------|-------------------------------|-----------------------------------|---------------|-----------|
| deploy | 424 → 591 | $0.84 → $0.32 | 8.0K → 3.0K | 1.38M → 0.45M | 427s → 366s | 7.6% → 13.0% |
| dev-task | 529 → 567 | $4.77 → $0.97 | 47.9K → 16.2K | 12.1M → 2.2M | 1,297s → 463s | 7.7% → 1.5% |
| patch | 496 → 340 | $3.18 → $0.67 | 27.6K → 5.5K | 5.2M → 1.1M | 746s → 218s | 8.0% → 19.0% |
| review | 1,042 → 1,191 | $3.06 → $0.54 | 35.8K → 5.4K | 5.1M → 0.8M | 285s → 68s | 5.2% → 19.7% |

First-turn context on 5.5 (no Sonnet 5 comparator exists; the tokenizer caveat below applies to any future cross-model read): deploy 33.0K, dev-task 32.5K, patch 34.2K, review 33.7K tokens; mean turns 8.0 / 25.3 / 12.0 / 10.9.

PR outcomes for merged agent PRs on this repo: 285 → 420 merged; review cycles 1.26 → 0.79; patch cycles 0.54 → 0.20; merged with zero patch cycles 67% → 88%; `reviewState: approved` at merge 76.5% → 63.8%. That last number means part of the cycle drop is fewer reviews completing before merge, not only cleaner first drafts.

**Caveats.**

- Recorded USD uses the rate table in effect when each run was recorded, and 5.5 is priced lower per token. The token and duration columns are price-independent and point the same way: 3–7× fewer output tokens and 2–6× fewer cache-read tokens per completed run.
- Failure rate is not a model signal in this series. The Sonnet 5 window is dominated by one incident week (2026-09-22: 666 review failures; the week of 09-08 had 0). Since 2026-10-06 phase runs report 0 failures while review/patch skip rates rose from ~5–8% to ~19%, because the deferral markers (DBV-1.1) now classify already-reviewed-at-head and no-op-at-dispatch runs as skips.
- The plugin changed continuously across both windows (~700 PRs merged), so this is a window correlation, the same `attribution: "window-correlation"` caveat `GET /metrics/pr-outcomes` carries, not attribution to the model.
- No quality claim is made. The eval tier is uncalibrated (PAU-5.4); this is the cost-only-plus-production-series reading that PAU-5.4's fail path prescribes anyway.

**Revisit if** PAU-5.4's calibration passes and a with/without eval shows a regression attributable to the model, or the failure accounting above turns out to hide real failures. A revert would target `claude-sonnet-5`, which has no per-run telemetry, so it would be a move to an unmeasured state.

## Risks and gates

- **API spend:** `count_tokens` is near-free; evals are capped by `--max-cost-usd` and never run from the cron.
- **Auth:** `count_tokens` needs `ANTHROPIC_API_KEY`; agents on OAuth get labelled estimates.
- **Version gates:** `/doctor prompt-audit` needs Claude Code ≥ 2.1.283; the scan degrades gracefully and says so.
- **Tokenizer changes:** only same-model comparisons are valid across a model bump; both models are reported until the fleet has moved.
- **Transcripts are machine-local:** usage attribution runs in-process right after each run, not from persisted transcripts.

## Bootstrap verification

The exit gate for the feature: `prompt-scan --dry-run` on this repo (commit `17c9c67`) against the ten bootstrap findings in the [design spec](./superpowers/specs/2026-10-07-prompt-audit-patrol-design.md). Counts drift as the repo changes; what matters is that each finding reproduces or its miss is explained.

| # | Finding | Result |
|---|---------|--------|
| 1 | `c/orphaned-auto-section`, "Shipwright Learned Facts" in root `CLAUDE.md` | **Reproduced after a fix.** Missed at first: the section's heading was mentioned in `docs/` and a design spec, which counted as a writer. Docs are no longer writers. |
| 2 | `c/retired-model-id`, `claude-sonnet-4-5` | `docs/agent.md` reproduced. `admin/prisma/schema/` is not scanned: it is not a prompt file and never enters model context. The design spec itself now also matches. |
| 3 | `a/claude-md-over-200-lines` | Reproduced for root `CLAUDE.md` (local-dev) and `agent/workspace/CLAUDE.md.template` (agent-runtime). |
| 4 | `b/on-invoke-heavy` for `commands/patch.md` | Reproduced (9 on-invoke-heavy findings in total). |
| 5 | `e/frontmatter-missing-name` for commands | **Reproduced after a fix.** The rule only looked at skills and agents. Commands are listed too, so it now covers them (22 findings). |
| 6 | `e/description-multiline` | Reproduced: 21 findings (the spec said 18; more files have since gained block scalars). |
| 7 | `e/duplicate-listing-entry` | **Not reproduced, by design.** The command stubs no longer share a description with their skill, so there is nothing to flag. The rule now also compares commands, with a regression test. |
| 8 | `e/skill-over-500-lines` | Reproduced for `investigate-cron`, `test-fix`, `security-scan` and `error-fix`. |
| 9 | `a/listing-budget-share` per model | Reproduced for `claude-sonnet-5-5` and `claude-sonnet-4-6`. |
| 10 | At least one class-d row, `tracking` | Class d has no rule function. The judgment pass tracks it at `consecutiveRuns` 1, for example the emphasis-heavy "never `git add -A` blindly" rule in root `CLAUDE.md`'s "Before you commit". |

A false positive was also fixed. The banner matcher fired on any prose containing "auto-maintained", including this page's finding-class table. It now requires the banner to open its line.

`--dry-run` leaves `state/` and `prompt-audit-report.md` untouched; `git status` stayed clean apart from the git-ignored token cache.
