# Prompt-audit eval calibration

The gate that decides whether the prompt-audit eval tier may make a quality claim (PAU-5.4). `prompt-eval` (PAU-5.3) reads this file: with a passing signed record it may report quality results; with a failing one it reports cost-only output. See [`docs/prompt-audit.md`](./prompt-audit.md) for the patrol and [`docs/superpowers/specs/2026-10-07-prompt-audit-patrol-design.md`](./superpowers/specs/2026-10-07-prompt-audit-patrol-design.md) for the design.

## Verdict

| Field | Value |
|-------|-------|
| Status | **FAIL** |
| Calibrated on | 2026-10-24 |
| Claude Code | 2.1.310 |
| Model under test | `claude-sonnet-5-5` (pinned with `--model`) |
| Command under test | `commands/dev-task.md` |
| Signed | Dave Odell, 2026-10-24 (approval of PR #4496) |

**Consequence.** The eval tier stays off. `prompt-fix` files cost-only findings; the production series (`cli.ts watch`, `productionSeries`) is the only quality signal, and it is currently saturated (see §5). Re-calibrate after PAU-5.5 lands and whenever the case builder, graders or grader targets change.

**Pass thresholds used** (from the task): every known-bad variant flagged as a regression; A/A false-positive rate ≤ 10%; minimum detectable effect at or below the 5–10 point changes the audit expects.

| Criterion | Result |
|-----------|--------|
| Known-bad variants flagged | **1 of 3** (B3 only) |
| A/A false positives | 0 of 2 verdicts; 20% discordant pairs |
| MDE vs 5–10 pt target | **11–16 pp** at 90 pairs |
| Gold set / judge kappa | not built (no human labels; no LLM judge used) |
| Replayable without side effects | dev-task / review / patch: **no** (§6) |

## 1. Setup

- **Cases:** the 30 frozen cases `buildEvalCases` derives from `commands/dev-task.md` — 20 `trigger-should` prompts of the form *run the `/dev-task` step "N: title"* and 10 `trigger-shouldnt` prompts. The harness labels all 30 `smoke`; no historical cases were available (§6).
- **Graders:** `tool_used` on `Skill` with an `input_match` for `dev-task` (`min: 1` for should, `min: 0, max: 0` for shouldn't) and, on should-cases, a `regex` over `last_message` for the step title. The regex targets the final message, not the trace, because the trace contains the user prompt, which already names the step.
- **Format:** the harness's on-disk cases do not load in `claude plugin eval` (`invalid case.yaml: graders: Required`), so the same cases were written by hand in the loadable format. PAU-5.5 (merged the same day) now makes `writeEvalCases` emit that format with the same grader mapping; this record predates it, which is one reason to re-calibrate. Runs used `--runs 3 -j 6 --ablation none --trust-plugin --no-publish --max-cost-usd 40`.
- **Arms** (identical `evals/` tree in each; only `commands/dev-task.md` differs):

| Arm | Change to `commands/dev-task.md` | Purpose |
|-----|----------------------------------|---------|
| A | none | baseline |
| A2 | none | A/A |
| N | whitespace normalised, trailing HTML comment (3 diff lines) | no-op rewrite |
| B1 | Steps 4 and 5 deleted (1,376 → 972 lines) | known-bad: key steps removed |
| B2 | both no-argument guards inverted to self-select a task | known-bad: instruction contradicted |
| B3 | file renamed so `/dev-task` no longer exists | known-bad: trigger broken |

- **Cost:** $9.5–12.0 per arm, $66.89 for the six arms, plus $3.6 of pilots; 3–5 turns and about $0.17 per run.
- **Statistics:** the harness's own `eval-diff.ts` (exact McNemar on discordant pairs, MDE at α 0.05 / power 0.8), run on the per-run pass booleans (`score === 1`).

## 2. Results

| Comparison | Run pass A → X | `tool_used` pass | Regex pass | Discordant (b/c) | p | MDE | Verdict |
|------------|----------------|------------------|------------|------------------|---|-----|---------|
| A → A2 | 54.4% → 58.9% | 100% → 100% | 31.7% → 38.3% | 7 / 11 | 0.48 | 13.2 pp | no-regression-detected-within-MDE |
| A → N | 54.4% → 63.3% | 100% → 100% | 31.7% → 45.0% | 4 / 12 | 0.077 | 12.5 pp | no-regression-detected-within-MDE |
| A → B1 | 54.4% → 67.8% | 100% → 100% | 31.7% → 51.7% | 7 / 19 | 0.029 | 15.9 pp | **improvement-detected** |
| A → B2 | 54.4% → 53.3% | 100% → 100% | 31.7% → 30.0% | 7 / 6 | 1.00 | 11.2 pp | no-regression-detected-within-MDE |
| A → B3 | 54.4% → 34.4% | 100% → 34.4% | 31.7% → 28.3% | 18 / 0 | <0.001 | 13.2 pp | regression-detected |

`b` = passed in A, failed in X; `c` = the reverse. 90 pairs per comparison (30 cases × 3 runs).

## 3. Known-bad variants

- **B1 (steps removed) scored as an improvement.** Deleting 400 lines made the final message echo step titles more often, so the only quality-shaped grader rewarded the degraded prompt. This is the failure mode the design spec warns about: shorter is not better, and a grader that cannot tell them apart must not back a quality claim.
- **B2 (contradicted guard) was invisible.** `tool_used` still fires and the final message changes in ways the step-title regex does not see. Under plugin eval the command cannot reach a task store anyway (§6), so the contradiction never produces an observable action.
- **B3 (trigger broken) was caught cleanly**: `tool_used` on should-cases dropped to 1/60 while shouldn't-cases stayed at 30/30. The tier is a dependable trigger-regression detector, and that is the only claim it supports.

## 4. A/A and no-op

Both null comparisons returned the right verdict, so the verdict-level false-positive rate is 0/2. The underlying signal is noisy: 20% of pairs were discordant in A/A (18/90) and 17.8% in the no-op arm, 12/30 and 10/30 cases changed their mean score between identical or equivalent prompts, and the no-op comparison came within p 0.077 of a false "improvement". The regex grader's per-run pass rate wandered from 31.7% to 45.0% across arms that differ by nothing or by whitespace. The `tool_used` grader was stable at 100% in every non-B3 arm.

## 5. Minimum detectable effect and the production series

At 90 pairs and ~20% discordance the MDE is 11–16 pp, above the 5–10 point changes the audit expects to see. Reaching a 5 pp MDE at the same discordance needs roughly 630 pairs (≈210 cases at 3 runs, or 30 cases at 21 runs), about seven times the spend per arm, before any improvement to the graders.

Cross-check against production: the Sonnet 4.6 → 5.5 series the task names does not exist (telemetry began 2026-10-08 with the fleet already on 5.5; see the cutover note in [`docs/prompt-audit.md`](./prompt-audit.md#model-cutover-decision-2026-10-24)). `productionSeries` was run on the two best-populated dev-task fingerprints since 2026-10-08 (25 and 23 non-skipped runs); both report a completion rate of 1.0, delta 0. No phase run has recorded `failed` since 2026-10-06 because deferrals are classified as skips, so the completion-rate series currently has no discriminating power either.

## 6. Replayability and the gold set

No gold set was built and no LLM judge was used, so there is no judge-vs-human kappa to report. Historical replay through `claude plugin eval` is not reachable for these commands:

- Runs get a temporary home and only an environment allowlist plus `EVAL_*` variables; `SHIPWRIGHT_TASK_STORE_URL`/`_TOKEN` and `gh` credentials are withheld, and `Bash` is granted only with `--allow-tools`.
- A probe run of `/dev-task <id>` with `Bash` granted made no task-store or GitHub call: it reported that `/dev-task` was not installed (the plugin loads it as `shipwright:dev-task`), `git` could not write its cache inside the sandbox, and it stopped after three turns ($0.08).

So `dev-task`, `review` and `patch` are side-effect-free under plugin eval but inert past their first task-store or `gh` call: not replayable as they stand. A replay would need `case.yaml` `execution.env` pointed at a local task-store, a `scaffold_script` that resets the repo to the pre-task commit, `Bash` granted, and outcome graders on produced files. That is a separate piece of work, not a configuration of the current harness.

## 7. What a passing tier would need

Recorded for the next attempt, not as a commitment:

1. Replace the step-title regex with outcome graders (`file_exists`, `regex` over a produced file) behind a scaffolded local task-store, so a removed step changes what is produced rather than what is said.
2. Keep `tool_used: Skill` as the trigger grader; it is the one stable signal here.
3. Add an LLM judge from a different model family with a human-labelled gold set and report kappa, or make no quality claim.
4. Size the suite to the effect: ~630 pairs for a 5 pp MDE at the observed discordance.
5. Restore a failure signal in production outcomes (deferrals as skips leave `failed` at zero), or the production series cannot cross-check anything.

## Reproducing

Build the dev-task cases into a scratch copy of the plugin with `writeEvalCases` (loadable format since PAU-5.5), make the variant copies described in §1, and run each with `claude plugin eval <copy> --runs 3 --ablation none --model claude-sonnet-5-5 --json <out> --trust-plugin --no-publish --max-cost-usd 40`. Convert each result's `cases[].arms.with[].score === 1` into an `EvalResult` and pass pairs to `diffEvals`. Result JSON files are not committed; they embed machine-local paths.
