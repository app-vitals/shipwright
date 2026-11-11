---
name: prompt-eval
description: Run the calibration-gated prompt-audit eval tier (with/without, A/B on two checkouts, trigger sets, production series) for one ledger finding, print the estimated cost before running, and emit a PR-citable block. Refuses quality results unless docs/prompt-audit-calibration.md holds a signed passing record. Runs only inside a fix task or by a human, never from the cron.
---

# Prompt Eval

Measure one `prompt-scan` finding with the eval tier: `claude plugin eval` cases built from
the command's own steps (`scripts/prompt-audit/eval-harness.ts`), or the production series.
The result is a block a PR can cite, and `ledger.findings[fp].measured` is populated.

**Evals run only inside a fix task (the `prompt-fix` acceptance criteria call this skill) or
by a human, never from the cron.** The `prompt-audit-maintenance` cron scans and queues only.
If this skill was invoked by a cron prompt (the prompt names a cron job or this is an
unattended scheduled run), print `Refusing to run: evals never run from the cron.` and stop.

> **Task store setup:** only `--kind production-series` reads the admin API
> (`SHIPWRIGHT_API_URL`, `SHIPWRIGHT_AGENT_API_KEY`). The other kinds need `claude` on PATH.

---

## Setup: Parse Arguments

- `--finding <fp>` — **required.** Ledger fingerprint (full or unambiguous prefix; if the
  prefix matches several, list them and stop)
- `--kind with-without|ab|trigger|production-series` — **required**
  - `with-without`: plugin vs no-plugin baseline arm (double cost); for CLAUDE.md-class
    findings pass the file as `append_system_prompt`
  - `ab`: the same cases on a base and a head checkout (`abOnTwoCheckouts`), diffed with the
    paired McNemar test
  - `trigger`: should / shouldn't prompts graded by `tool_used: Skill`
  - `production-series`: `productionSeries` compares completion rate by `contextFingerprint`
    from `/outcomes`; it runs no model and costs nothing
- `--max-cost-usd <n>` — spend cap, default `5`
- `--model <id>` — model under test, pinned with `--model`
- `--runs <n>` — seeds per case per arm, default `3`, minimum `3`

---

## Step 1: Calibration Gate

Read `docs/prompt-audit-calibration.md` and its **Verdict** table (`Status`, `Calibrated on`,
`Signed`). The model-run kinds (`with-without`, `ab`, `trigger`) may state a quality result
only when the gate passes:

| Record | Behaviour |
|--------|-----------|
| File missing, no Verdict table, or `Signed` empty or pending | **No calibration record.** Refuse any quality result and say why: `Refusing quality result: no signed calibration record in docs/prompt-audit-calibration.md (PAU-5.4). Run the calibration first.` Stop. |
| `Status` is **FAIL**, signed | **Failed record.** Report cost-only output (Step 2 estimate plus `cli.ts measure` token delta) and run no model arm. Print the consequence line from the record. Never state that quality is unchanged. |
| `Status` is **PASS**, signed | Proceed. Quality results are allowed, with the Step 4 wording rules. |

`--kind production-series` runs no eval and is not gated by the record, but it is subject
to the same wording rules.

A record older than a change to the case builder, graders or grader targets is stale; say so
in the output and recommend re-calibration.

---

## Step 2: Cost Gate

Build the cases (`buildEvalCases`) and compute the estimate with `estimateEvalCost`
(cases x runs x arms x per-case cost, default $0.10). **Print the estimated cost before
running anything:**

```
Estimated cost: ${estimate} ({cases} cases x {runs} runs x {arms} arms) — cap ${max}
```

Refuse without a cap: if `--max-cost-usd` is absent or not a positive number, or the
estimate exceeds it, print the `assertCostGate` refusal and stop. Never raise the cap
yourself. A failed calibration record stops after this step.

---

## Step 3: Run

Run through `eval-harness.ts` (`prepareEvals` then `runPluginEval` / `abOnTwoCheckouts`,
or `productionSeries`), passing `--max-cost-usd` through to `claude plugin eval`.

**Sandbox caveat.** `claude plugin eval` loads only the plugin and gives each run a temporary
home and an environment allowlist, so `SHIPWRIGHT_TASK_STORE_*` and `gh` credentials do not
reach the run. `dev-task`, `review` and `patch` are side-effect-free under eval but inert
past their first task-store or `gh` call, so they cannot be replayed. CLAUDE.md-class
findings need `production-series` or `with-without` with `append_system_prompt`.

---

## Step 4: Report

Diff with `diffEvals`; the verdict and the minimum detectable effect (MDE) are always
printed together.

- Say `no-regression-detected-within-MDE`, with the MDE in points. **Never state that
  quality is unchanged**: a null result at 90 pairs cannot rule out an effect smaller than
  the MDE, and the calibration records an MDE of 11-16 points against the 5-10 points the
  audit expects.
- Report only what the graders measure. A grader that rewards a degraded prompt (the
  calibration's B1 variant) is not quality evidence.

Print the PR-citable block:

```
## Prompt eval — {fp}
Kind: {kind} | Model: {model} | Runs: {runs} | Cost: ${actual} of ${max} cap
Calibration: {PASS|FAIL|none}, signed {date} (docs/prompt-audit-calibration.md)
Verdict: {verdict} (MDE {mde} pp, p {p}, pairs {n})
```

For a failed record the block says `Quality: not measured (calibration failed); cost-only`.

---

## Step 5: Record

Write `ledger.findings[fp].measured` (`kind`, `before`, `after`, `delta`, `costUsd`,
`artifacts`, `runAt`) and set the status to `measured` with a history event. A cost-only
or refused run writes nothing. Attach the result JSON to the PR.

---

## Constraints (Do Not Violate)

- Evals run only inside a fix task or by a human, never from the cron
- Print the estimated cost before running; refuse without `--max-cost-usd`
- Without a signed passing calibration record, refuse any quality result and say why
- With a failed record, report cost-only output and run no model arm
- Never state that quality is unchanged
