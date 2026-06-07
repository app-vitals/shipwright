# Metrics Schema Reference

Single source of truth for `planning/{folder-name}/metrics.jsonl`. Referenced by `dev-task.md` (writer), `dev-loop.md` (retrospective consumer), `plan-session.md` (historical consumer), and `metrics.md` (query command).

---

## File Format

- **Location:** `planning/{folder-name}/metrics.jsonl`
- **Format:** JSONL — one JSON object per line, newline-terminated
- **Mode:** Append-only for new tasks. Existing lines may be updated in-place by `/review` to add review data (see Write Lifecycle below).
- **Created by:** `dev-task.md` Step 12a-standalone or Step 12e.2. File is created if it doesn't exist.

---

## Write Lifecycle

Metrics are written in two phases to support the standalone `/dev-task` → `/review` workflow:

### Phase 1: dev-task (always runs)

`dev-task.md` writes a metrics line at the end of every run, in both standalone and merge-mode:

- **Standalone (Step 12a-standalone):** Writes all fields EXCEPT `review` (which hasn't run yet). Fields populated: core fields, `simplify`, `requirements`, `ci`, `coverage`, `model`.
- **Merge-mode (Step 12e.2):** Writes all fields INCLUDING `review` (inline review ran in Steps 12b-d).

### Phase 2: /review (optional enrichment)

`review.md` Step 10b updates the existing metrics line for the task with `review` data after the verdict is determined. This is a targeted in-place update (find-and-replace the JSON line), not a new append.

### Implications for consumers

- A record **without** a `review` field means `/review` hasn't run yet — NOT that the review passed clean. Exclude from review aggregates and FTQ calculation.
- A record **with** a `review` field is fully enriched and can be used for all aggregates including FTQ.
- The `/metrics` command categorizes records as "enriched" (has `simplify`/`ci`/`coverage`) and "review-enriched" (also has `review`).

---

## Schema

### Core Fields (v1.2.0+)

| Field | Type | Source Step | Default if Absent | Description |
|-------|------|------------|-------------------|-------------|
| `task` | string | Planning doc | — | Task ID (e.g., `"WS-1.1"`) |
| `title` | string | Planning doc | — | Full task title |
| `estimated_h` | number | Planning doc | — | Planned hours from task table |
| `actual_h` | number | Step 6 → 12e.2 | — | Elapsed hours from branch creation to merge |
| `complexity` | integer (1-5) | Planning doc | `0` | Complexity score (`0` = pre-B1.2 planning doc) |
| `retries` | integer | dev-loop retryMap | `0` | Retry count (`0` in standalone dev-task) |
| `ci_fix_attempts` | integer | Step 11b | `0` | CI fix subagent attempts (`0` = passed first try or no CI) |
| `pr` | integer | Step 11 | — | GitHub PR number |
| `hotfixes` | integer | dev-loop Phase 3b | `0` | Hotfix tasks spawned by this task |
| `files_changed` | integer | `git diff --stat` | — | Files changed vs main |
| `started_at` | string (ISO-8601) | Step 6b | `null` | Timestamp when the feature branch was created (task start). Used for phase timing when combined with `ts`. New in v1.9.0. |
| `ts` | string (ISO-8601) | Step 12e.2 | — | Timestamp when metrics line was written (task end) |

### Fix Cascade Fields (v1.4.0+)

These fields measure post-implementation rework. All are optional for backward compatibility.

#### `simplify` — Step 8 fix counts

| Field | Type | Default if Absent | Description |
|-------|------|-------------------|-------------|
| `simplify.total` | integer | `0` | Total fixes applied during simplify |
| `simplify.dry` | integer | `0` | DRY violation fixes (duplicated code extraction) |
| `simplify.dead_code` | integer | `0` | Dead code removals (unused imports, variables, functions) |
| `simplify.naming` | integer | `0` | Naming improvements (unclear or inconsistent names) |
| `simplify.complexity` | integer | `0` | Complexity reductions (over-engineered solutions) |
| `simplify.consistency` | integer | `0` | Consistency fixes (patterns not matching codebase) |

#### `requirements` — Step 9 verification counts

| Field | Type | Default if Absent | Description |
|-------|------|-------------------|-------------|
| `requirements.met` | integer | `0` | Acceptance criteria fully satisfied |
| `requirements.partial` | integer | `0` | Criteria with incomplete implementation |
| `requirements.not_met` | integer | `0` | Criteria with no evidence of implementation |
| `requirements.unverifiable` | integer | `0` | Criteria that cannot be determined from code |
| `requirements.total` | integer | `0` | Total acceptance criteria evaluated |

Omit the `requirements` object entirely if Step 9 was not reached.

#### `review` — Steps 12b-12d review metrics

| Field | Type | Default if Absent | Description |
|-------|------|-------------------|-------------|
| `review.verdict` | string | `null` | One of: `"SHIP IT"`, `"NEEDS FIXES"`, `"NEEDS WORK"` |
| `review.findings` | integer | `0` | Total validated findings across all review agents |
| `review.fixes_applied` | integer | `0` | Findings auto-fixed in Step 12d |
| `review.agents` | string[] | `[]` | Names of review agents that ran |

Omit the `review` object entirely in standalone (non-merge) mode where Steps 12b-d don't run.

#### `ci` — Step 11b CI gate details

| Field | Type | Default if Absent | Description |
|-------|------|-------------------|-------------|
| `ci.fix_attempts` | integer | `0` | Mirrors top-level `ci_fix_attempts` |
| `ci.failures` | string[] | `[]` | One-line description per CI failure (under 100 chars each) |

Falls back to top-level `ci_fix_attempts` if the `ci` object is absent.

#### `model` — execution model

| Field | Type | Default if Absent | Description |
|-------|------|-------------------|-------------|
| `model` | string | `null` | Model tier that executed this task (e.g., `"haiku"`, `"sonnet"`, `"opus"`) |

Read from the planning doc's Model column. `null` if not specified (pre-model-routing planning docs).

#### `research` — Step 7a research context loading

| Field | Type | Default if Absent | Description |
|-------|------|-------------------|-------------|
| `research.docs_scanned` | integer | `0` | Total docs found in the project's docs/ directory |
| `research.docs_selected` | integer | `0` | Docs deemed relevant to the task and loaded |
| `research.docs_loaded` | string[] | `[]` | Filenames of the selected docs (e.g., `["architecture.md", "api-billing.md"]`) |
| `research.web_search` | boolean | `false` | Whether web search was triggered (local docs had gaps) |
| `research.web_queries` | integer | `0` | Number of web search queries run |

Omit the `research` object entirely if the research agent was not invoked for this task (e.g., no docs/ directory found).

#### `coverage` — Step 10 coverage delta

| Field | Type | Default if Absent | Description |
|-------|------|-------------------|-------------|
| `coverage.before` | number | `null` | Baseline coverage % (from main branch, if measurable) |
| `coverage.after` | number | `null` | Coverage % after this task's changes |
| `coverage.delta` | number | `null` | `after - before` (positive = coverage improved) |

Best-effort measurement. Use `null` for any field the toolchain can't provide.

#### `auto_docs` — Step 8.5 auto-refresh docs

| Field | Type | Default if Absent | Description |
|-------|------|-------------------|-------------|
| `auto_docs.updated` | boolean | `false` | `true` if the docs-refresher agent made a `docs: refresh` commit on this branch |
| `auto_docs.files_changed` | integer | `0` | Number of `docs/*.md` files edited |
| `auto_docs.lines_changed` | integer | `0` | Total `+/-` lines in the docs commit |
| `auto_docs.skipped_reason` | string \| null | `"legacy_record"` | When `updated=false`, one of: `"no_docs_dir"`, `"no_source_changes"`, `"no_stale_refs"`, `"commit_failed"` (a `docs: refresh` commit was attempted but did not land — hook rejected, signing failed, or empty index), `"agent_error"` (the docs-refresher returned no parseable metrics block — caller-recorded, never emitted by the agent). When `updated=true`, `null`. `"legacy_record"` is consumer-derived for absent `auto_docs` and is never emitted by either the agent or the caller. |

Records written before v4.5.0 will be missing the `auto_docs` object entirely. Consumers should treat absent `auto_docs` as `{updated: false, files_changed: 0, lines_changed: 0, skipped_reason: "legacy_record"}` rather than excluding the record — old tasks didn't have the chance to refresh docs, but they did ship.

#### `deploy` — deploy command pipeline result

| Field | Type | Default if Absent | Description |
|-------|------|-------------------|-------------|
| `deploy.canary_result` | string | `null` | One of: `"success"`, `"failure"`, `"skipped"`. `"skipped"` means the promote step was never reached (canary was skipped in the pipeline). |
| `deploy.pipeline_minutes` | number | `null` | Total elapsed minutes from merge to promote completion (or failure). Covers Deploy → Canary → Promote poll loop. |
| `deploy.reverted` | boolean | `false` | `true` if a revert PR was opened after canary failure. The revert PR is never auto-merged — this flags that one was opened. |

Records written before the deploy command existed will be missing the `deploy` object. Consumers should treat absent `deploy` as `{canary_result: null, pipeline_minutes: null, reverted: false}`.

#### `test_layers` — TLM-2.1 test layer tracking

Tracks which test layers were added or removed during a task, what the AC planned, and any discrepancies between plan and reality.

| Field | Type | Default if Absent | Description |
|-------|------|-------------------|-------------|
| `test_layers.configured` | `false \| undefined` | — | `false` when test-system.md is absent — when present, all other sub-keys are omitted. When test-system.md is present, this field is absent and all standard sub-keys are emitted. |
| `test_layers.measured` | `Record<string, number>` | `{}` | Per-layer file counts from `parseDiff(git diff main...HEAD)`. Positive = files added, negative = files deleted. Keys are layer names: `"unit"`, `"integration"`, `"smoke"`, `"e2e"`. |
| `test_layers.planned` | `ParsedDecision[]` | `[]` | Parsed "Test decision" bullets from the task's acceptance criteria. Each entry has `layers` (layer names), `added` (file paths planned to be added), `retired` (file paths planned to be removed). |
| `test_layers.drift` | `Array<{planned: string, observed: string}>` | `[]` | Discrepancies between planned and measured. Each entry has a human-readable `planned` description and an `observed` description of what actually happened. Example: `{"planned":"retire foo.unit.test.ts","observed":"no removal detected in layer unit"}`. |
| `test_layers.coverage_per_layer` | `Record<string, number> \| null` | `null` | Per-layer coverage percentages when the toolchain supports it; `null` otherwise. Most toolchains do not support per-layer coverage — emit `null` and do not fabricate values. The aggregate `coverage.delta` is unaffected. |
| `test_layers.coverage_per_layer_reason` | `string \| null` | `null` | When `coverage_per_layer` is `null`, the reason it could not be populated (e.g. `"toolchain does not support per-layer coverage"`). When `coverage_per_layer` is populated, this field is `null`. |

**Every `test_layers` sub-key must be present on every emitted record.** When a task has no test changes, emit `test_layers` with `measured` as an all-zero counts object, `planned` as `[]`, `drift` as `[]`, `coverage_per_layer` as `null`, and `coverage_per_layer_reason` as the reason string. Never omit the `test_layers` block or any of its sub-keys. (The `conformance` field has its own emit rules — see the `conformance` section below.) When test-system.md is absent, `test_layers` is `{"configured":false}` — no other sub-keys are emitted.

Computed by `dev-task.md` Step 10b.1 using `parseDiff` and `parsePlanned` from `shipwright/classify_test_layer.ts`.

Records written before v4.6.0 will be missing the `test_layers` object entirely. Consumers should treat absent `test_layers` as `{measured: {}, planned: [], drift: [], coverage_per_layer: null, coverage_per_layer_reason: null}` — legacy records had no test layer tracking.

#### `conformance` — TLM-3.1 test-system.md conformance flagging

Advisory check of whether diff additions follow the conventions defined in `docs/test-readiness/test-system.md`.

| Field | Type | Default if Absent | Description |
|-------|------|-------------------|-------------|
| `conformance.checked` | boolean | `false` | Whether test-system.md was found and checked against the diff |
| `conformance.deviations` | ConformanceDeviation[] | `[]` | Advisory deviations from the test system spec. Each entry is `{ module: string, prescribed: LayerName, observed: LayerName }`. Empty when test-system.md is absent or when no deviations were found. This field is advisory only — deviations do not block merges. |

**The `conformance` field must be present on every emitted record.** When test-system.md is absent (source `'defaults'`), emit `"conformance": {"checked": false, "deviations": []}`. When test-system.md is present but no test-file additions were found in the diff, emit `"conformance": {"checked": true, "deviations": []}`.

Computed by `dev-task.md` Step 10b.1 using `checkConformance` and `parseDiffAdditions` from `shipwright/classify_test_layer.ts`.

Records written before v4.15.0 will be missing the `conformance` object entirely. Consumers should treat absent `conformance` as `{checked: false, deviations: []}`.

---

## Example Records

### v1.2.0 record (core fields only)

```json
{"task":"WS-1.1","title":"Add workspace model","estimated_h":2,"actual_h":1.5,"complexity":3,"retries":0,"ci_fix_attempts":0,"pr":42,"hotfixes":0,"files_changed":4,"ts":"2026-03-31T14:30:00Z"}
```

### v1.4.0 record (with fix cascade fields)

```json
{"task":"WS-1.2","title":"Add workspace API routes","estimated_h":3,"actual_h":2.8,"complexity":3,"retries":0,"ci_fix_attempts":1,"pr":43,"hotfixes":0,"files_changed":6,"ts":"2026-03-31T16:45:00Z","simplify":{"total":2,"dry":1,"dead_code":0,"naming":1,"complexity":0,"consistency":0},"requirements":{"met":5,"partial":0,"not_met":0,"unverifiable":0,"total":5},"review":{"verdict":"NEEDS FIXES","findings":3,"fixes_applied":2,"agents":["code-reviewer","silent-failure-hunter","test-analyzer"]},"ci":{"fix_attempts":1,"failures":["jest: 1 test suite failed — missing mock for workspace service"]},"model":"sonnet","coverage":{"before":87.2,"after":91.5,"delta":4.3}}
```

### v1.9.0 record (with started_at for phase timing)

```json
{"task":"WS-1.3","title":"Add workspace switcher UI","estimated_h":4,"actual_h":3.5,"complexity":4,"retries":0,"ci_fix_attempts":0,"pr":44,"hotfixes":0,"files_changed":8,"started_at":"2026-04-10T14:00:00Z","ts":"2026-04-10T17:30:00Z","simplify":{"total":1,"dry":0,"dead_code":0,"naming":1,"complexity":0,"consistency":0},"requirements":{"met":6,"partial":0,"not_met":0,"unverifiable":0,"total":6},"review":{"verdict":"SHIP IT","findings":0,"fixes_applied":0,"agents":["code-reviewer","silent-failure-hunter"]},"ci":{"fix_attempts":0,"failures":[]},"model":"sonnet","coverage":{"before":89.1,"after":92.3,"delta":3.2}}
```

### v4.5.0 record (with auto_docs)

```json
{"task":"WS-1.4","title":"Add workspace billing endpoint","estimated_h":3,"actual_h":2.6,"complexity":3,"retries":0,"ci_fix_attempts":0,"pr":45,"hotfixes":0,"files_changed":5,"started_at":"2026-05-12T09:00:00Z","ts":"2026-05-12T11:30:00Z","simplify":{"total":0,"dry":0,"dead_code":0,"naming":0,"complexity":0,"consistency":0},"requirements":{"met":4,"partial":0,"not_met":0,"unverifiable":0,"total":4},"review":{"verdict":"SHIP IT","findings":0,"fixes_applied":0,"agents":["code-reviewer"]},"ci":{"fix_attempts":0,"failures":[]},"model":"sonnet","coverage":{"before":91.2,"after":92.4,"delta":1.2},"auto_docs":{"updated":true,"files_changed":2,"lines_changed":28,"skipped_reason":null}}
```

### v4.6.0 record (with test_layers — TLM-2.1)

Task added an integration test and removed a unit test. AC had a "Test decision" bullet planning to retire the unit test; measured confirms it:

```json
{"task":"WS-1.5","title":"Migrate workspace unit tests to integration layer","estimated_h":2,"actual_h":1.8,"complexity":2,"retries":0,"ci_fix_attempts":0,"pr":46,"hotfixes":0,"files_changed":3,"started_at":"2026-05-28T10:00:00Z","ts":"2026-05-28T11:48:00Z","simplify":{"total":0,"dry":0,"dead_code":0,"naming":0,"complexity":0,"consistency":0},"requirements":{"met":3,"partial":0,"not_met":0,"unverifiable":0,"total":3},"ci":{"fix_attempts":0,"failures":[]},"model":"sonnet","coverage":{"before":88.0,"after":88.5,"delta":0.5},"auto_docs":{"updated":false,"files_changed":0,"lines_changed":0,"skipped_reason":"no_stale_refs"},"test_layers":{"measured":{"unit":-1,"integration":1,"smoke":0,"e2e":0},"planned":[{"layers":["unit","integration"],"added":["accounts/workspace.integration.test.ts"],"retired":["accounts/workspace.unit.test.ts"]}],"drift":[],"coverage_per_layer":null,"coverage_per_layer_reason":"toolchain does not support per-layer coverage"}}
```

Task with no test changes (all sub-keys still present):

```json
{"task":"WS-1.6","title":"Fix workspace config typo","estimated_h":0.5,"actual_h":0.3,"complexity":1,"retries":0,"ci_fix_attempts":0,"pr":47,"hotfixes":0,"files_changed":1,"started_at":"2026-05-28T12:00:00Z","ts":"2026-05-28T12:18:00Z","simplify":{"total":0,"dry":0,"dead_code":0,"naming":0,"complexity":0,"consistency":0},"requirements":{"met":1,"partial":0,"not_met":0,"unverifiable":0,"total":1},"ci":{"fix_attempts":0,"failures":[]},"model":"haiku","coverage":{"before":88.5,"after":88.5,"delta":0.0},"auto_docs":{"updated":false,"files_changed":0,"lines_changed":0,"skipped_reason":"no_stale_refs"},"test_layers":{"measured":{"unit":0,"integration":0,"smoke":0,"e2e":0},"planned":[],"drift":[],"coverage_per_layer":null,"coverage_per_layer_reason":"toolchain does not support per-layer coverage"}}
```

### v4.15.0 record (unconfigured — test-system.md absent)

test-system.md was absent — `test_layers` is `{"configured":false}` with no other sub-keys, and `conformance` is `{"checked":false,"deviations":[]}`.

```json
{"task":"WS-1.7","title":"Fix billing edge case","estimated_h":1,"actual_h":0.8,"complexity":2,"retries":0,"ci_fix_attempts":0,"pr":48,"hotfixes":0,"files_changed":2,"started_at":"2026-05-28T14:00:00Z","ts":"2026-05-28T14:48:00Z","simplify":{"total":0,"dry":0,"dead_code":0,"naming":0,"complexity":0,"consistency":0},"requirements":{"met":2,"partial":0,"not_met":0,"unverifiable":0,"total":2},"ci":{"fix_attempts":0,"failures":[]},"model":"sonnet","coverage":{"before":90.1,"after":90.1,"delta":0.0},"auto_docs":{"updated":false,"files_changed":0,"lines_changed":0,"skipped_reason":"no_stale_refs"},"test_layers":{"configured":false},"conformance":{"checked":false,"deviations":[]}}
```

---

## Backward Compatibility Rules

1. **New fields are always optional.** Consumers must never error on records missing fix cascade fields.
2. **Absent objects = zero/null defaults.** If `simplify` is absent, treat as zero fixes. If `review` is absent, the task hasn't been reviewed yet — exclude from review aggregates and FTQ calculation (do not treat as "passed").
3. **Top-level `ci_fix_attempts` is kept.** The `ci.fix_attempts` field mirrors it for consistency. Consumers should read `ci.fix_attempts` first, fall back to `ci_fix_attempts`.
4. **Old records are included in basic aggregates** (hours, retries, files changed) but excluded from fix cascade aggregates that require the new fields.
5. **Absent `test_layers` = legacy record (pre-v4.6.0).** Treat as `{measured: {}, planned: [], drift: [], coverage_per_layer: null, coverage_per_layer_reason: null}`. Do not exclude legacy records from aggregates that don't require test layer data.
6. **`test_layers.configured: false` = test-system.md absent (v4.15.0+).** When `configured` is `false`, no other `test_layers` sub-keys are present. Pre-v4.15.0 records with a full `test_layers` object cannot be assumed to have had test-system.md present — the old code used PLAN_SESSION_DEFAULTS as a fallback, producing identical output. Treat absent `configured` on pre-v4.15.0 records as unknown (not as true).

---

## Incremental PostHog Events (v1.9.0+)

In addition to the batch export at task end, Shipwright fires individual PostHog events at each pipeline checkpoint. These events share the same `distinct_id` as the batch events (`shipwright/{project}/{task_id}`), so they can be joined in PostHog to reconstruct the full task lifecycle.

This catalogue lists what `dev-task.md` and `review.md` **actually fire** today (step numbers are the current headings, not legacy numbering).

| Event Name | Fired At | Key Properties |
|------------|----------|----------------|
| `shipwright_task_started` | dev-task Step 2 — task marked in-progress | `task_id`, `project`, `title`, `layer`, `estimated_h`, `session` |
| `shipwright_simplify_complete` | dev-task Step 6 — after simplify pass | `task_id`, `project`, `total`, `dry`, `dead_code`, `naming`, `complexity_fixes`, `consistency` |
| `shipwright_task_blocked` | dev-task Step 7 / 9 / 9b — requirements not met, PR creation failed, or CI retries exhausted | `task_id`, `project`, `reason` |
| `shipwright_auto_docs` | dev-task Step 8.5 — after docs-refresher agent | `task_id`, `project`, `updated`, `files_changed`, `lines_changed`, `skipped_reason` |
| `shipwright_pr_created` | dev-task Step 9 — after PR creation | `task_id`, `project`, `pr`, `files_changed` |
| `shipwright_ci_result` | dev-task Step 9b — after CI pass / no-CI skip | `task_id`, `project`, `passed_first_try`, `fix_attempts`, `failures`, `no_ci` (only when no CI configured) |
| `shipwright_task_complete` | dev-task Step 10c — at task end (after PR + metrics) | `task_id`, `project`, `title`, `session`, `layer`, `estimated_h`, `actual_h`, `retries`, `pr`, `files_changed`, `started_at`; `complexity` when the task carries it |
| `shipwright_task_reviewed` | review Step 13 — after review verdict | `task_id`, `project`, `pr`, `verdict`, `findings`, `fixes_applied`, `agents` |
| `shipwright_task_deployed` | deploy command — after promote success | `task_id`, `project`, `canary_result`, `pipeline_minutes`, `reverted` |

**Historical event-name aliases.** Two events were renamed; the plugin emits only the current name, but PostHog still holds events under the old names and dashboards alias both:

| Current (emitted) | Historical (still in PostHog) |
|-------------------|-------------------------------|
| `shipwright_task_complete` | `shipwright_task_completed` |
| `shipwright_task_reviewed` | `shipwright_review_complete` |

CI-retry exhaustion does **not** fire a `shipwright_ci_result` with an `exhausted` flag — it fires `shipwright_task_blocked` with `reason="ci_max_retries_exhausted"`.

All events include a `$insert_id` property set to `{event_name}/{project}/{task_id}` for PostHog deduplication — re-exporting is safe. `posthog_send.py` derives `properties.task_id` from `--task` automatically, so every event carries `task_id` even when not passed explicitly.

These events are fired by `scripts/posthog_send.py`, which is a no-op when `POSTHOG_PROJECT_API_KEY` is not set.

---

## Writers

| Writer | File | What It Writes | When |
|--------|------|----------------|------|
| **Dev-task** | `dev-task.md` Step 2 | `started_at` via the `shipwright_task_started` PostHog event (not in JSONL) | At task start |
| **Dev-task** | `dev-task.md` Step 10b | All JSONL fields except `review` | After PR creation |
| **Dev-task** | `dev-task.md` Step 10c | Full task summary incl. `actual_h`, `retries`, `started_at` via the `shipwright_task_complete` PostHog event | At task end |
| **Review** | `review.md` Step 13 | `review.*` fields (updates existing JSONL line) + `shipwright_task_reviewed` PostHog event | After review verdict |

## Consumers

| Consumer | File | What It Reads | When |
|----------|------|---------------|------|
| **Dev-loop retrospective** | `dev-loop.md` | All fields | LOOP END — aggregates, trends, learnings |
| **Plan-session estimation** | `plan-session.md` | `estimated_h`, `actual_h`, fix cascade summary | Phase 4 — calibrate estimates for new tasks |
| **Metrics command** | `metrics.md` | All fields | On demand — full analysis and recommendations |
| **PostHog export** | `metrics.md` (--export) | All fields | On demand — batch event export |

---

## Derived Metrics

These are computed by consumers, not stored in the JSONL:

| Metric | Formula | Interpretation |
|--------|---------|----------------|
| **First-time quality rate** | % tasks where `simplify.total == 0` AND `review.verdict == "SHIP IT"` AND `ci_fix_attempts == 0` | Higher = less rework after implementation |
| **Simplify fix rate** | Mean `simplify.total` per task | Lower = better initial code quality |
| **Review SHIP IT rate** | % tasks with `review.verdict == "SHIP IT"` | Higher = cleaner code from implementation |
| **CI first-pass rate** | % tasks with `ci_fix_attempts == 0` | Higher = fewer CI surprises |
| **Estimation accuracy** | `mean((actual_h / estimated_h) - 1) * 100` | Closer to 0% = better estimates |
| **Coverage trend** | Mean `coverage.delta` over time | Positive = coverage improving |
| **Research hit rate** | Mean `research.docs_selected / research.docs_scanned` | Higher = docs are well-organized and relevant |
| **Web search frequency** | % tasks with `research.web_search == true` | Higher = local docs have more gaps |
| **Auto-docs update rate** | % tasks with `auto_docs.updated == true` (legacy records excluded) | Higher = docs stay in sync as code ships |
| **Auto-docs mean lines/task** | Mean `auto_docs.lines_changed` across tasks where `updated == true` | Indicates doc churn per task that does trigger a refresh |
