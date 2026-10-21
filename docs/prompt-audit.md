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

`prompt-audit-maintenance` (`0 7 * * 1`, weekly Monday 07:00, `silent: true`, **disabled by default**) is defined in `agent-types/coding/manifest.yaml`. Its `check-prompt-audit.ts` precheck exits 0 when the ledger is missing or unreadable (so the first scan can bootstrap it), when `lastRun` is null or 7+ days old, or when a recent ledger holds `proposed` findings; otherwise it exits 1 and the run is skipped. See [`docs/agent-ops.md`](./agent-ops.md) for the cron table.

## Measurement

`cli.ts` also provides `measure` (same-model token delta between two refs), `blast` (reverse-reference blast radius of a file) and `watch` (post-merge regression check comparing before/after context fingerprints per phase). Run telemetry (per-run context baseline, per-skill attribution, outcome metrics) is exposed through the admin cron-run stats endpoints; see [`docs/agent-api-ops.md`](./agent-api-ops.md).

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
