# Learnings: patch prompt trial baseline (DTA-9.5)

Source: `GET /agents/all/cron-runs/dev-task-adherence?command=patch` (fleet-wide,
admin-scoped), queried on 2026-11-14, `from=2026-11-03T03:33:34Z` (DTA-9.2 deploy
time, the point from which patch runs carry adherence telemetry).

## Baseline (unchanged prompt, default command variant only — no trial yet)

- 158 task-bearing patch runs over ~11.6 days (~13.6 runs/day — higher than the
  plan's ~9/day estimate; re-check the per-arm sample math against this real rate
  before setting the trial's stop-condition day count).
- Overall step adherence: 3.8% (6/158 fully adherent runs).
- Of the 14 required-steps-table rows, only 2 are currently measured:
  - **Upsert PR Record** (4c.5): 77.2% ran (122/158)
  - **Dispatch Fix Subagent** (5b): 3.8% ran (6/158) — the rest fixed inline
    without a subagent dispatch. Consistent with the plan doc's pre-baseline
    spot check ("8 of 172 task-bearing patch runs dispatched any subagent").
- Cost: mean $0.72/run, $114.29 total across 158 runs. Patch is cheap; this is a
  step-adherence problem, not a cost problem (same conclusion the plan reached
  before this baseline).
- Outcomes: mean patch cycles 1.03; 22.8% of PRs needed zero patch cycles, 19.0%
  needed 2+; mean review cycles 0.75. CI first-pass rate / mean ciFixAttempts:
  not available yet (null) for patch.
- Patch guardrails: repeat-patch rate 19.0%; CI-green-after-patch rate 90.2%;
  mean patch cycles 1.03 (same figure as outcomes.meanPatchCycles — same PRs).
- All 158 runs are on `commandVariant: default` — trial had not started as of
  this read.

Earlier read (2026-11-09, 66 runs, ~6.6 days in) showed the same shape: 4.5%
adherence, 4.5% fix-dispatch rate, $0.69 mean cost — the pattern held steady as
volume more than doubled, which is a good sign the baseline isn't noisy at this
sample size.

## Trial scope (confirmed with Dan, 2026-11-14)

- **Agents: warchild, doc, maverick** — same three agents as the dev-task lean
  trial (DTA-2.3 addendum, 2026-10-21).
- Lean share: 70% (per plan proposal, given the ~13.6 runs/day fleet-wide
  volume this read found — higher than the ~9/day the plan assumed when it
  proposed 70%, so the per-arm sample should accumulate faster than planned).
- Mechanism (per DTA-9.8, not yet started): `SHIPWRIGHT_LOOP_PATCH_ALT_COMMAND=/shipwright:patch-lean`,
  `SHIPWRIGHT_LOOP_PATCH_ALT_SHARE=70` set via agent-admin on each of the three
  agents.

## Caveats

- Fleet-wide report, not single-agent — reflects whichever agents happened to
  run patch in this window, not just the three agents the trial will scope to.
  No pre-trial baseline split by agent was pulled; if a per-agent baseline is
  needed later, re-query `/agents/{id}/dev-task-adherence?command=patch` for
  warchild, doc and maverick individually.
- Only 2 of 14 required-steps-table rows are wired up for patch scoring (see
  DTA-9.2/DTA-9.3 scope — "first cut scores lane-agnostic steps"). Low overall
  adherence is mostly a measurement-coverage gap, not evidence that 12 other
  steps are being skipped at a 96%+ rate.
- CI first-pass rate is null for patch — don't conclude anything about CI
  impact from this baseline; `ciGreenAfterPatchRate` (90.2%) is a proxy only
  (patched PRs with no recorded CI failure), not a true first-pass metric.

## Trial outcome and promotion (DTA-9.9, retroactive readout, 2026-11-16)

The trial was cut short: Dave promoted `patch-lean` to be the default `patch`
(PR #5201, DTA-9.10, merged 2026-11-16) after ~2 days and 44 total runs, not
the ~100 runs/arm the plan's stop condition targeted. DTA-9.9 itself was never
claimed before the promotion landed, so this is a readout of a decision
already made and deployed, not a gate on it.

- Prompt: `commands/patch.md` vs `commands/patch-lean.md` (lean promoted to be
  the only `patch`; old default content deleted in #5201).
- Hypothesis: the default prompt's optional subagent-dispatch step for fixes
  (5b) was being skipped almost always; a trimmed spine that makes it
  mandatory should raise adherence without raising cost or hurting CI.
- Arms: `commandVariant=default` vs `alternate`, 70% lean share via
  `SHIPWRIGHT_LOOP_PATCH_ALT_COMMAND`/`_ALT_SHARE` on warchild, doc, maverick
  (DTA-9.8, started 2026-11-14T18:26:52Z).
- n: 44 total task-bearing runs at cutover (31 lean, 10 default with cost
  data) — well short of the ~100/arm target, especially the default arm.
- Stop condition (as set in DTA-9.8): adherence no lower than baseline; patch
  cycles and CI pass no worse; cost recorded beside adherence. Promotion
  happened before this was formally checked against the target n.
- Reference load rates: not tracked for patch (DTA-9.4's tally script covers
  dev-task only; patch is scored via the adherence report's step dispatch
  detection, not transcript reference reads).
- Cost / turns: mean $0.71/run lean vs $0.61/run default (live report at
  cutover, close to the PR body's $0.71 vs $0.72 citation — small differences
  from a few more runs landing between the PR snapshot and this read).
- Adherence: **90.6% lean (29/32) vs 25% default (3/12)** — the fix-dispatch
  step (5b) alone went from ~4% ran-rate at baseline to 90.6% under lean. This
  is the real result: a ~65-point gap on 44 runs is not plausibly noise, even
  though the arm sizes are small.
- CI first-pass: not available (null) for patch in either arm; don't read
  anything into its absence.
- Patch cycles: mean 1.00 lean vs 0.70 default; CI-green-after-patch 85.7%
  lean vs 100% default (n=10, not a real signal at that size).
- Decision: **adopt.** The adherence win is large and directionally exactly
  what was hypothesized; cost/cycles/CI differences are within noise on a
  thin control arm, not evidence of a regression. Re-running for a bigger
  control sample wouldn't change the decision now — `patch-lean` content is
  already the deployed default fleet-wide, not just for the 3 trial agents.
- Caveats: default arm (n=10-12) is too small to trust the cost/cycles/CI
  comparisons individually; only the adherence gap is large enough to stand
  on its own at this sample size. DTA-9.10 was executed outside the normal
  plan-session → task-store flow (no task-store record for it). Post-merge
  cleanup done 2026-11-16: `SHIPWRIGHT_LOOP_PATCH_ALT_COMMAND`/`_ALT_SHARE`
  deleted from warchild, doc, maverick (both env vars, confirmed removed via
  `DELETE /agents/{id}/envs/{key}`).

## Learnings template for later prompts

Copy per prompt trial (same template as `learnings-dev-task.md`).

```markdown
### <prompt name>

- Prompt: <file / skill, versions compared>
- Hypothesis: <what should change and why>
- Arms: <variant A vs variant B, how assigned>
- n: <runs per arm>
- Stop condition: <n reached, date, or a regression threshold>
- Reference load rates: <per file, per arm>
- Cost / turns: <mean and median, main vs subagent, per arm>
- Adherence: <did required steps happen; evidence beyond load rate>
- CI first-pass: <rate per arm>
- Patch cycles: <mean per PR per arm>
- Decision: <adopt / revert / extend trial>
- Caveats: <confounds, estimated cost, sample limits>
```
