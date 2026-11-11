# prompt-scan thresholds

Every threshold below lives in `THRESHOLDS` in
`plugins/shipwright/scripts/prompt-audit/finding.ts`; the rule functions are in
`rules-cost.ts` (a, b), `rules-stale.ts` (c) and `rules-structure.ts` (e, f),
re-exported from `rules.ts`. Class (d) dated-model patterns are delegated to
`/doctor prompt-audit` by the skill and have no rule function here.

## Labels

Every finding is **cost-only** or **quality-claimed**.

- **cost-only**: the proof is a same-model token (or char/line) delta. Static tier.
  Reduced tokens are certain; unchanged quality is unmeasured, and the report must
  say so.
- **quality-claimed**: the change could alter what the model reads or when it
  loads. The finding always carries an eval (`measurement.tier: eval`, with a
  kind and estimated cost). A quality-claimed finding is never eval-free;
  `makeFinding` derives the label from `evalKind`, so there is no way to build
  one without an eval. Always-loaded files use `production-series` (plugin eval
  loads only the plugin under test); other files use `with-without`; the
  `skill-to-docs-index` rule uses `trigger`.

Eval cost estimate: 8 cases × 3 runs × arms × $0.10 per case (2 arms; 1 for
`trigger`; $0 for `production-series`). Evals never run from the cron.

## Fingerprints

`sha256(class|rule|file|normalizedEvidence)[:12]`. Evidence text is kept free of
counts and line numbers so a finding keeps its fingerprint as numbers drift.

## Rules

| Class | Rule | Fires when | Label |
|-------|------|-----------|-------|
| a | `claude-md-over-200-lines` | always-loaded CLAUDE.md body > 200 lines | cost-only |
| a | `always-set-tokens` | always-loaded set, per context × model, > 20,000 tokens (high at 2×) | cost-only |
| a | `rule-without-paths` | `.claude/rules` file with no `paths:` | cost-only |
| a | `import-chain` | `@`-import reached in > 2 hops | cost-only |
| a | `listing-budget-share` | summed listing descriptions > 80% of the model's 1% listing budget (high when over 100%) | cost-only |
| a | `listing-entry-over-1536` | skill/agent listing description > 1,536 chars | cost-only |
| b | `on-invoke-heavy` | command or skill body > 8,000 tokens (max across models) | cost-only |
| b | `invoke-cost-weekly` | tokens per invocation × weekly invocations > 500,000. Uses measured `avgInvokeContextDelta` when present, else static tokens. No usage data: no finding | cost-only |
| c | `unresolvable-path` / `unresolvable-command` / `unknown-flag` / `retired-model-id` | the reference resolver cannot resolve a reference | cost-only |
| c | `orphaned-auto-section` | "auto-maintained" section whose writer no longer exists | cost-only |
| c | `blame-age` | **median** line age > 180 days. Median, not max: one old line is normal, mostly-old lines mean a stale file | cost-only |
| e | `move-to-path-rule` | `##` section of an always-loaded CLAUDE.md/import, ≥ 15 lines, ≥ 3 path references, all under one two-segment directory | quality-claimed |
| e | `skill-to-docs-index` | skill appears in > 60% of observed runs. No usage data: no finding | quality-claimed |
| e | `skill-over-500-lines` | skill body > 500 lines | cost-only |
| e | `key-instructions-not-near-top` | file ≥ 30 lines whose first hard constraint (MUST/NEVER/ALWAYS/CRITICAL) is after 40% of the file; high severity when it lands past the 5,000-token post-compaction cap | quality-claimed |
| e | `description-over-1536` | description > 1,536 chars on a non-listing item (commands). Listing items are covered by `listing-entry-over-1536` | cost-only |
| e | `description-multiline` | `description:` uses a YAML block scalar (`>` or `|`) | cost-only |
| e | `frontmatter-missing-name` | skill or agent with no `name:` | cost-only |
| e | `duplicate-listing-entry` | two listing entries share a description (stub plus skill); the later path is flagged | cost-only |
| f | `instruction-count-high` | > 60 imperative lines in a file | quality-claimed |
| f | `caps-emphasis-ratio` | ≥ 5 MUST/NEVER/ALWAYS/CRITICAL and > 5% of non-blank lines | quality-claimed |
| f | `prohibition-cluster` | ≥ 4 prohibition lines (never / do not / don't / must not) within a 10-line span | quality-claimed |

Class f rules apply to claude-md, rule, import, skill, command, agent and
template items; fenced code and frontmatter are ignored.

## Post-merge regression watch

`cli.ts watch` (`watch.ts`, constants `WATCH_THRESHOLDS` / `MIN_WATCH_RUNS`)
compares a merged prompt-fix finding's before and after context fingerprints,
per phase. Sources: admin `/agents/all/cron-runs/outcomes` and metrics
`/metrics/pr-outcomes`.

| Metric | Source | Regressed when |
|--------|--------|----------------|
| cost per run | `avgContextTokens` (first-turn context tokens; the outcomes endpoint has no per-run dollar cost) | after > before by more than 20% |
| turns | `avgTurns` | after > before by more than 20% |
| skip rate | `skipped / runs` | after - before > 0.10 (absolute) |
| patch cycles | `avgPatchCycles` per PR window | after - before > 0.5 (absolute); ignored under 20 PRs on either side |

**Insufficient data.** Fewer than 20 non-skipped runs (completed + failed) in a
phase on either side reports `insufficient-data` for that phase; no verdict and
no task. The finding is `regressed` if any phase regresses, `ok` if at least one
phase is `ok` and none regress, else `insufficient-data`.

**On regression** the ledger entry becomes `regressed` and exactly one
`hitl: true` revert-proposal task is filed per finding (id
`PAU-REVERT-<fingerprint>`, so a rerun gets a 409 and a `regressed` finding is
not re-filed). The watch never reverts, merges, or edits files.

**Confounds.** Every report and task body states: the series are time-window
correlations, not per-run attribution; simultaneous prompt changes land in the
same window; the model cutover moves cost, turns and skip rate for every phase at
once and cannot be separated from this change; patch cycles are per
fingerprint window, not per phase.
