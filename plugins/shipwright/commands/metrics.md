---
description: Analyze pipeline metrics — fix cascade trends, quality rates, and actionable recommendations across planning sessions
arguments:
  - name: options
    description: "Optional: project name, --from YYYY-MM-DD, --to YYYY-MM-DD, --compare projectA projectB"
    required: false
allowed-tools: [Read, Glob, Grep, Bash, Write, Skill]
---

# Pipeline Metrics

Analyze shipwright pipeline metrics across planning sessions. Surfaces fix cascade trends, code quality rates, and actionable recommendations for improving execution.

---

## Step 1: Parse Arguments

Parse `$ARGUMENTS` to extract:
- **project**: A project folder name (filters to `planning/{project}/metrics.jsonl`)
- **--from YYYY-MM-DD**: Start date filter (inclusive, compared against `ts` field)
- **--to YYYY-MM-DD**: End date filter (inclusive)
- **--compare projectA projectB**: Side-by-side analysis of two projects

If no arguments provided, analyze all `planning/*/metrics.jsonl` files.

---

## Step 2: Load Data

1. Glob `planning/*/metrics.jsonl` (or `planning/{project}/metrics.jsonl` if project filter specified)
2. If no files found:
   ```
   No metrics data found. Run /dev-task to generate metrics.
   ```
   Stop.

3. Read each file line by line, parse each line as JSON
4. Filter by date range if `--from` and/or `--to` specified (compare against `ts` field)
5. Categorize records:
   - **Enriched**: has at least one of `simplify`, `ci` (nested object), or `coverage` fields. Note: the `review` field may be absent on enriched records if `/review` hasn't run yet — this does NOT make them legacy.
   - **Review-enriched**: enriched records that also have the `review` field (added by `/review` Step 10b)
   - **Legacy**: core fields only (v1.2.0 format)

6. Print:
   ```
   Loaded {N} records from {M} projects ({K} enriched, {R} with review data, {N-K} legacy)
   ```

---

## Step 3: Compute Fix Cascade Aggregates

These are the core quality metrics. Only enriched records contribute to fix cascade calculations.

### 3a. First-Time Quality Rate (north star metric)

A task has "first-time quality" if ALL of these are true:
- `simplify.total == 0` (no fixes needed during simplify)
- `review.verdict == "SHIP IT"` (review passed clean)
- `ci_fix_attempts == 0` (CI passed on first try)

FTQ can only be computed for review-enriched records (records that have the `review` field). Tasks where `/review` hasn't run yet are excluded from FTQ calculation — they lack the review verdict needed for a complete quality assessment.

```
ftq_rate = (count of first-time-quality tasks / count of review-enriched tasks) * 100
```

If no review-enriched records exist, report a partial FTQ based on simplify + CI only:
```
partial_ftq_rate = (count where simplify.total == 0 AND ci_fix_attempts == 0 / count of enriched tasks) * 100
```
Label it: "Partial FTQ (review data pending): {rate}%"

**Per-layer First-Time Quality breakdown** (when `layer` field is present on records):

- Group review-enriched records by their `layer` field value; records with no `layer` field are excluded from the breakdown (they are still counted in the overall FTQ rate)
- For each layer with **3 or more** review-enriched records: compute `layer_ftq_rate = (count of FTQ tasks in this layer / total review-enriched records in this layer) * 100`, using the same formula as overall FTQ: `simplify.total == 0 AND review.verdict == "SHIP IT" AND ci_fix_attempts == 0`
- For each layer with **fewer than 3** review-enriched records: omit from the display, but note: "(N record(s) — too few for breakdown)"
- If no records have a `layer` field (pre-MDR-1.1 data): skip the breakdown entirely — output is byte-identical to the pre-layer version
- **If no layer has 3 or more records** (all layers fall below the threshold): skip the entire per-layer block including the Omitted note — output nothing for the per-layer section

### 3b. Simplify Phase

For enriched records with `simplify` data:
- Mean `simplify.total` per task
- Mean per category: `dry`, `dead_code`, `naming`, `complexity`, `consistency`
- Top category: the category with the highest average

### 3c. Review Phase

For review-enriched records (records that have the `review` field — added by `/review` Step 10b):
- Verdict distribution: count and percentage of SHIP IT / NEEDS FIXES / NEEDS WORK
- **Finding count** — handle both old integer and new array formats:
  - Old integer format: `findings_count = review.findings` (where `review.findings` is an integer)
  - New array format: `findings_count = review.findings_count ?? review.findings.length` (where `review.findings` is an array of `{category, severity, resolved}` objects)
  - To detect format: if `Array.isArray(review.findings)` → array format; else → integer format
- Mean `findings_count` per task (finding density)
- Mean `review.fixes_applied` per task
- **Finding category breakdown** (only for records with array findings format):
  - Collect all `category` values from every finding across all such records
  - Count occurrences of each category value
  - Report as ranked list: `{category}: {count}` sorted descending
  - If no records have array findings, report: "No category data (pre-enrichment records)"
- **Avg `review_latency_h`** — mean of `review.review_latency_h` across review-enriched records that have this field. If no records have it, skip this sub-metric.
- **Avg `rework_cycles`** — mean of `review.rework_cycles` across review-enriched records that have this field. If no records have it, skip this sub-metric.

### 3d. CI Gate

For all records (both enriched and legacy have `ci_fix_attempts`):
- CI first-pass rate: percentage where `ci_fix_attempts == 0`
- Mean `ci_fix_attempts` for tasks that failed CI (i.e., where `ci_fix_attempts > 0`)
- If enriched `ci.failures` data exists, collect and count the most common failure patterns
- If enriched `ci.checks` data exists, group by check name and display frequency: e.g. `test/unit (4×) | lint/biome (2×)` — sorted by frequency descending

### 3e. Coverage

For enriched records with `coverage` data:
- Mean `coverage.delta`
- Mean `coverage.after`

### 3f. Research Context Loading

For enriched records with `research` data:
- Mean `research.docs_selected / research.docs_scanned` (research hit rate — what fraction of docs are relevant per task)
- Web search frequency: % of tasks where `research.web_search == true`
- Most loaded docs: rank `research.docs_loaded` entries by frequency across all tasks

### 3g. Estimation Accuracy

For all records:
- Mean estimation error: `mean((actual_h / estimated_h) - 1) * 100` as percentage
- Breakdown by complexity tier: 1-2 (simple), 3 (standard), 4-5 (complex)

### 3h. Auto-docs Maintenance

For records that have an `auto_docs` field (records from v4.5.0+):

- **Doc update rate**: `% of records where auto_docs.updated == true`
- **Mean lines/task (all)**: mean `auto_docs.lines_changed` across every record (zeros included)
- **Mean lines/task (updated only)**: mean `auto_docs.lines_changed` across records where `updated == true`
- **Skip reason breakdown**: count and percentage by `auto_docs.skipped_reason` value across non-updated records — values: `no_docs_dir`, `no_source_changes`, `no_stale_refs`, `commit_failed`, `agent_error`, `legacy_record`. `commit_failed` and `agent_error` are *failure* buckets (the refresher tried but a commit didn't land, or the agent returned nothing parseable) — surface them distinctly from the benign skips; a non-trivial rate in either means the auto-docs step is malfunctioning, not idle.

Records without an `auto_docs` field are counted under `skipped_reason: "legacy_record"`. They are pre-v4.5.0 tasks that pre-date this feature — they couldn't have updated docs, but they did ship.

If zero records have any `auto_docs` data, skip this section entirely.

### 3i. Test Health

For records that have a `test_layers` field (records from v4.6.0+). Records **without** a `test_layers` field are pre-feature legacy records — treat them as "not captured", not errors. This section is deterministic and side-effect-free: same input always produces the same output; no files are created or modified.

If zero records have a `test_layers` field (entirely legacy session), skip this section entirely.

Otherwise compute:

- **Records with test layer data**: count of records that have `test_layers` field. Report as `{N}/{total}`. If `N < total`, note `"{total-N} pre-feature records not captured"`.
- **Per-layer tests added**: for each layer (`unit`, `integration`, `smoke`, `e2e`), sum all positive `test_layers.measured[layer]` values across records with `test_layers` data.
- **Per-layer tests removed**: for each layer, sum the absolute value of all negative `test_layers.measured[layer]` values.
- **Removal rate**: `removed_total / (added_total + removed_total) * 100` where `removed_total` is the sum of all layer removal counts and `added_total` is the sum of all layer addition counts. If both are zero, report "0% (no test changes)".
- **Drift rate**: `(count of records where test_layers.drift is non-empty) / (count of records with test_layers data) * 100`
- **Conformance deviation rate**: `(count of records where test_layers.planned is non-empty AND test_layers.drift is non-empty) / (count of records with test_layers data) * 100`
- **Per-layer coverage**: when `test_layers.coverage_per_layer` is non-null for at least one record, aggregate the values. When `coverage_per_layer` is null for **all** records with `test_layers` data, state explicitly: `"not captured (null for all records)"` — do not show 0% or leave blank.

---

## Step 4: Compute Trends

If 10 or more enriched records exist, split them into two halves by timestamp (first half = older, second half = newer) and compare:

| Metric | First Half | Second Half | Trend |
|--------|-----------|-------------|-------|
| First-time quality rate | {ftq_1}% | {ftq_2}% | {improving/declining/stable} |
| Simplify fixes/task | {avg_1} | {avg_2} | {improving/declining/stable} |
| Review SHIP IT rate | {rate_1}% | {rate_2}% | {improving/declining/stable} |
| CI first-pass rate | {rate_1}% | {rate_2}% | {improving/declining/stable} |

A metric is "improving" if the second half is better by 5+ percentage points (or 0.5+ for per-task counts), "declining" if worse by the same margin, "stable" otherwise.

If fewer than 10 enriched records, skip trends: "Not enough data for trend analysis (need 10+ enriched records, have {K})."

---

## Step 5: Generate Recommendations

Based on the aggregates, generate 1-3 actionable recommendations. Apply rules in priority order, stop after 3:

| Priority | Condition | Recommendation |
|----------|-----------|----------------|
| 1 | First-time quality rate < 50% | "Less than half your tasks ship without rework. Biggest contributors: {identify which of simplify/review/CI is the primary driver}. Focus improvement efforts on {primary driver}." |
| 2 | `simplify.dry` > 1.5 avg/task | "Simplify is catching {N} DRY violations per task on average. Consider adding a DRY checklist to implementation prompts or extracting shared utilities earlier in the task." |
| 3 | `simplify.dead_code` > 1.0 avg/task | "Dead code removal is frequent ({N} avg/task). Implementation is leaving unused imports and variables. Consider adding cleanup verification to the implementation step." |
| 4 | `simplify.naming` > 1.0 avg/task | "Naming issues are common ({N} avg/task). Consider adding naming conventions to your project's CLAUDE.md or the task Context field." |
| 5 | Review SHIP IT rate < 60% | "Only {N}% of tasks ship clean on review. Consider strengthening implementation prompts for the most common finding categories." |
| 6 | CI first-pass rate < 70% | "CI fails on first try for {N}% of tasks. Most common failure: {pattern from ci.failures if available}. Consider running the full validation command before pushing." |
| 7 | `simplify.complexity` > 1.0 avg/task | "Complexity reductions are frequent ({N} avg/task). Implementation is over-engineering solutions. Consider adding 'keep it simple' guidance to task briefs." |
| 8 | `coverage.delta` < 0 avg | "Coverage is declining (avg delta: {N}%). Tasks are adding code without proportional test coverage." |
| 9 | Estimation error > 30% | "Tasks are taking {N}% longer than estimated. Complexity tier {tier} is the biggest driver. Consider padding estimates for that tier." |
| 10 | Estimation error < -30% | "Tasks are completing {N}% faster than estimated. Consider tightening estimates to improve planning accuracy." |
| 11 | `research.web_search` true > 50% of tasks | "Web search is triggered on more than half of tasks. Your local docs have gaps — run `/research-docs` to generate missing documentation." |
| 12 | Auto-docs update rate < 20% AND mean `files_changed` > 5/task across the same window | "Auto-docs refreshed only {N}% of tasks despite tasks averaging {M} files changed. Docs may be falling behind — run `/research-docs` to backfill, or audit `docs/` for references the refresher can detect." |
| 13 | Auto-docs `skipped_reason` is `no_docs_dir` for > 30% of recent records | "Most tasks ran in a repo with no `docs/` directory. Run `/research-docs` once to bootstrap a doc tree so the auto-refresher can keep it in sync." |
| 14 | Auto-docs `skipped_reason` is `commit_failed` or `agent_error` for > 10% of recent records | "The auto-docs step is failing ({N}% commit_failed / agent_error), not idle-skipping. Check for a failing pre-commit hook, signing misconfiguration, or a docs-refresher agent error — stale docs are silently accumulating." |
| 15 | Drift rate > 20% (from Test Health 3i) | "Planned-vs-actual test drift is high ({rate}%). Plans are committing to tests that aren't being written — either update acceptance criteria 'Test decision' bullets to match actual practice or improve test coverage discipline." |
| 16 | Records with `test_layers` data < 50% of total (and at least one record has test_layers) | "More than half your records pre-date the test layer feature. Run newer tasks to build up test health data." |
| 17 | Finding category breakdown available AND the most common finding category appears in >30% of all findings | "Most common finding category: {category} ({N} occurrences, {pct}% of all findings). Consider adding targeted guidance for this category to implementation prompts." |

If no conditions are met: "All metrics are within healthy ranges. Keep it up."

---

## Step 6: Present Report

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
PIPELINE METRICS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Data: {N} tasks from {M} projects ({date range or "all time"})
Enriched: {K}/{N} records have fix cascade data

FIX CASCADE
───────────
First-time quality:  {ftq_rate}% ({ftq_count}/{review_enriched_count} tasks)
  ↳ Zero simplify fixes AND SHIP IT verdict AND CI pass on first try
  {If per-layer breakdown has at least one layer with 3+ records:}
  Per layer:  {layer}: {rate}% ({count}/{total} tasks) | {layer2}: {rate}%...
    {If any layers were omitted:}
    Omitted:  {layer1} (N records, too few) | {layer2} (N records, too few)

Simplify:
  Avg fixes/task:  {mean_total}
  By category:     DRY {dry_avg} | Dead code {dc_avg} | Naming {name_avg} | Complexity {cx_avg} | Consistency {con_avg}
  {If trends available: Trend: {first_half_avg} → {second_half_avg} ({improving/declining/stable})}

Review:
  SHIP IT:           {ship_pct}% ({ship_count})
  NEEDS FIXES:       {fixes_pct}% ({fixes_count})
  NEEDS WORK:        {work_pct}% ({work_count})
  Avg findings:      {mean_findings}/task
  Avg fixes:         {mean_fixes}/task
  Categories:        {top 1-3 categories with counts (e.g. "silent-failure: 4, missing-test: 2, type-error: 1"), or "none (no findings)" if no category data}
  Avg latency:       {avg_latency_h}h {(or "n/a" if no review_latency_h data)}
  Avg rework cycles: {avg_rework} {(or "n/a" if no rework_cycles data)}

CI Gate:
  First-pass rate:  {ci_pct}%
  Avg fix attempts: {ci_avg} (when failed)
  {If ci.failures data: Common failures: {top 2-3 failure patterns}}
  {If ci.checks data: Check names: {groupChecksByName output, e.g. test/unit (4×) | lint/biome (2×)}}

{If coverage data exists:}
Coverage:
  Avg delta:  {delta}%
  Avg after:  {after}%

{If any records have test_layers data (from 3i):}
Test Health:
  Records with test layer data: {N}/{total}{If N < total: " ({total-N} pre-feature records not captured)"}
  Tests added:    unit {+N} | integration {+N} | smoke {+N} | e2e {+N}
  Tests removed:  unit {-N} | integration {-N} | smoke {-N} | e2e {-N}
  Removal rate:   {rate}% of test changes were removals
  Drift rate:     {rate}% of tasks had planned-vs-actual drift
  Deviation rate: {rate}% of tasks had conformance deviations
  Per-layer coverage: {values if coverage_per_layer is non-null for any record | "not captured (null for all records)"}

ESTIMATION
──────────
Accuracy:      {error}% avg error
By complexity: 1-2: {err_12}% | 3: {err_3}% | 4-5: {err_45}%

{If trends available:}
TRENDS (first half → second half)
─────────────────────────────────
| Metric               | Before  | After   | Direction |
|----------------------|---------|---------|-----------|
| First-time quality   | {v1}%   | {v2}%   | {arrow}   |
| Simplify fixes/task  | {v1}    | {v2}    | {arrow}   |
| Review SHIP IT rate  | {v1}%   | {v2}%   | {arrow}   |
| CI first-pass rate   | {v1}%   | {v2}%   | {arrow}   |

{If --compare mode:}
COMPARISON: {projectA} vs {projectB}
────────────────────────────────────
| Metric                 | {projectA} | {projectB} |
|------------------------|------------|------------|
| Tasks                  | {count}    | {count}    |
| First-time quality     | {rate}%    | {rate}%    |
| Simplify avg fixes     | {avg}      | {avg}      |
| Review SHIP IT rate    | {rate}%    | {rate}%    |
| CI first-pass rate     | {rate}%    | {rate}%    |
| Estimation error       | {err}%     | {err}%     |

RECOMMENDATIONS
───────────────
{1-3 actionable recommendations from Step 5}
{If none: "All metrics are within healthy ranges. Keep it up."}

{If any auto_docs data exists:}
Auto-docs:
  Update rate:        {update_rate}% ({updated_count}/{auto_docs_total} tasks)
  Lines/task (all):   {mean_lines_all}
  Lines/task (when updated): {mean_lines_updated}
  Skipped:            no_stale_refs {n_no_stale}% | no_source_changes {n_no_src}% | no_docs_dir {n_no_docs}% | legacy {n_legacy}%
  Failures:           commit_failed {n_commit_failed}% | agent_error {n_agent_error}%

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

---

## PostHog Data

PostHog events are emitted automatically by `/dev-task` at each pipeline checkpoint — no manual export step needed. See `references/metrics-schema.md` for the full event catalogue.

To query pipeline data in PostHog, use the PostHog MCP (`mcp__plugin_posthog_posthog__query-run`) or build dashboards directly:

> Event names: the plugin emits `shipwright_task_complete` and `shipwright_task_reviewed`. Historical events also exist in PostHog as `shipwright_task_completed` and `shipwright_review_complete` — match **both** the current and historical name in every query (see the alias table in `references/metrics-schema.md`).

1. **First-time quality rate over time** — filter `shipwright_task_complete` / `shipwright_task_completed` where `simplify_total=0`, `review_verdict="SHIP IT"`, `ci_fix_attempts=0`
2. **Simplify fix breakdown** — stacked bar of `shipwright_simplify_complete` by category
3. **Review verdict distribution** — pie chart of `shipwright_task_reviewed` / `shipwright_review_complete` by `verdict`
4. **CI pass rate** — trend of `shipwright_ci_result` by `passed_first_try`
5. **Pipeline funnel** — funnel from `shipwright_task_started` → `shipwright_pr_created` → `shipwright_task_complete` / `shipwright_task_completed`
6. **Auto-docs maintenance** — trend `shipwright_auto_docs` filtered to `updated=true` and sum `lines_changed` over time; pie chart of `skipped_reason` for `updated=false`
