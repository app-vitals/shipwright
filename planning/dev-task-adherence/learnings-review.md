# Learnings: review prompt trial baseline (DTA-10.6)

Source: `GET /agents/all/cron-runs/dev-task-adherence?command=review` (fleet-wide,
admin-scoped), queried on 2026-11-24, `from=2026-11-18T01:15:44Z` (DTA-10.2 deploy
time, the point from which review runs carry adherence telemetry).

## Baseline (unchanged prompt, default command variant only — no trial yet)

- 444 task-bearing review runs over ~6.0 days (~74 runs/day fleet-wide — in the
  range the plan expected, ~75-97/day as of 2026-11, and far higher than patch's
  ~13.6/day baseline).
- Overall step adherence: 6.1% (27/444 fully adherent runs).
- Of the 6 required-steps-table rows, only 2 are currently measured:
  - **Deep Review / dispatch code-reviewer subagent** (7): 6.1% ran (27/444) —
    confirms the pre-check sample (8/60 sampled runs across
    warchild/doc/okwow/maverick, ~13%); the full-fleet rate is even lower than
    that sample suggested.
  - **Mark PullRequest Record Posted** (11b): 99.8% ran (443/444) — not the
    problem step.
  - Steps 5 (fetch reviewThreads), 6.1 (risk-signals script), 9.5
    (unaddressed-findings gate) and 10.5 (hard-gate validation) remain
    unmeasured — no telemetry hook exists yet for them (per the DTA-10.1/10.2
    scoping note), not evidence they're being skipped at a high rate.
- Cost: mean $0.69/run, $307.08 total across 444 runs.
- Outcomes: mean patch cycles 0.11 (90.5% of PRs needed zero); mean review
  cycles 1.60. CI first-pass rate / mean ciFixAttempts: not available (null)
  for review, same as patch.
- Review guardrails: repeat-review rate 26.7%; clean-first-pass-approve rate
  71.0%; mean review cycles 1.60 (confounded by the known unaddressed-findings
  false positive, DTA-11.1, not yet shipped — don't read a lean-vs-default
  signal into repeat-review rate until that lands).
- All 444 runs are on `commandVariant: default` — trial had not started as of
  this read. 7 distinct `contextFingerprint` variants all show a similarly low
  Step 7 dispatch rate (1-15% each), so the gap is fleet-wide, not one agent
  dragging the average down.

## Trial scope (confirmed with Dan, 2026-11-24)

- **Agents: warchild, doc, maverick, okwow.** Same three agents as the patch
  trial (DTA-9.8) plus okwow — okwow is the single largest reviewer
  (147 of the 403 combined runs from these four agents over the baseline
  window) and wasn't part of the patch trial, worth including this time.
  Per-agent baseline volume over the same ~6-day window: doc 113, maverick 46,
  okwow 147, warchild 97 (403 combined, ~67/day across the four).
- Lean share: **70%**, same as patch (DTA-9.8 precedent). At ~67 runs/day
  combined, even the 30% control arm accumulates ~20 runs/day — unlike patch,
  where the 70/30 split left a thin control arm (n=10-12) that couldn't
  support the secondary-metric comparisons. 50/50 was considered and rejected:
  it would only slow the lean arm's accumulation with no real precision gain,
  since control volume isn't the bottleneck at this fleet size.
- Mechanism (per DTA-10.7, not yet started):
  `SHIPWRIGHT_LOOP_REVIEW_ALT_COMMAND=/shipwright:review-lean`,
  `SHIPWRIGHT_LOOP_REVIEW_ALT_SHARE=70` set via agent-admin on each of the
  four agents.

## Caveats

- Fleet-wide report, not single-agent — reflects whichever agents happened to
  run review in this window, not just the four agents the trial will scope
  to. Per-agent baselines for warchild, doc, maverick and okwow were pulled
  separately (see Trial scope above) for the volume estimate, but not
  per-agent adherence/cost splits — re-query
  `/agents/{id}/dev-task-adherence?command=review` individually if a
  per-agent baseline is needed later.
- Only 2 of 6 required-steps-table rows are wired up for review scoring (see
  DTA-10.1/10.2 scope — risk-signals script and `reviewThreads` fetch have no
  existing telemetry hook). Low overall adherence is mostly the Step 7
  dispatch gap, not evidence the other 4 steps are being skipped at a high
  rate — they're simply unmeasured.
- CI first-pass rate is null for review, same as patch — don't conclude
  anything about CI impact from this baseline.
- Repeat-review rate / clean-first-pass-approve rate are confounded by the
  unaddressed-findings hard-gate false positive (DTA-11.1, independent,
  not yet shipped) — a PR can show as needing re-review because of that gate
  bug, not because the review itself was wrong. Keep this caveat live through
  the trial readout (DTA-10.8) until DTA-11.1 lands.

## Learnings template for later prompts

Copy per prompt trial (same template as `learnings-dev-task.md` /
`learnings-patch.md`).

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
