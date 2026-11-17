# review-lean: Step 7 dispatch details

Mechanics for `commands/review-lean.md` Step 7. The spine keeps the dispatch, the full input list, the failure-chain
summary and the multi-reviewer trigger; this file holds the output shape and the override branches. Read it when the
subagent response is malformed or an override `REVIEW_SUBAGENT_TYPE` is configured.

## Inputs (full wording)

- **`testReadinessContext`** — contents of `docs/test-readiness/test-system.md` plus the Testing section of the repo's
  CLAUDE.md (gathered in Step 5.7); omit the field entirely when no test-readiness content was gathered. The subagent then
  falls back to the universal baseline in the testing-domain entries of the project's principles source: a project-level
  override at `.claude/shipwright/principles.md` first, then `references/principles.md` (relative to the plugin root).
- **`Prior Findings — Requires Resolution Check`** (PVD-1.2) — only when `priorQualifyingReviews` is non-empty: each prior
  qualifying review's `ref` and full `body`. Instruct the subagent that, for each entry, it must explicitly assess whether
  the issue that review originally described is still present in the current diff, and return one `priorFindingsStatus[]`
  entry per input `ref` (see the Output Format section of `agents/code-reviewer.md`). Omitted, never passed empty — the
  same rule as `acceptanceCriteria` and `testReadinessContext`.

## Output shape

The subagent returns a JSON object with `summary`, `findings[]`, `strengths[]`, `recommendation`,
`recommendation_reason`, and — whenever the `Prior Findings — Requires Resolution Check` input was passed —
`priorFindingsStatus[]`, an array of `{ ref, resolved, evidence }` entries, one per prior qualifying review passed in.
`ref` identifies which prior review the entry addresses (matching the `ref` passed in), `resolved` is a boolean, and
`evidence` (required in both the `resolved: true` and `resolved: false` cases) is a `file:line` reference or diff excerpt
proving the fix, or explaining why the issue is not resolved. Parse the full response and carry the data into Step 8 and
Step 9 (Step 9's "Prior Findings Resolution" table is populated from `priorFindingsStatus[]`).

`PRIOR_FINDINGS_STATUS_JSON` is that parsed array as compact JSON (`[]` when the field is absent); Step 9.5 passes it to
`compute-unaddressed-findings.ts` as `priorFindingsStatus`.

**`riskAssessment` (RSK-2.1).** Each response may carry an optional top-level `riskAssessment` (`{level, factors[]}`, see
`agents/code-reviewer.md`). Append every response's `riskAssessment` to `RISK_ASSESSMENTS` (a list). A reviewer that omits
it (or returns a malformed one) contributes nothing; absence is never an error and never triggers a retry.
`RISK_RATING` from `compute-risk-rating.ts` is `{level, heuristicLevel, factors, table, reason}`; if `RISK_SIGNALS` is
empty, `RISK_ASSESSMENTS` is not valid JSON, or the script errors, leave `RISK_RATING` empty and omit the Risk line and Risk
section — it never blocks Steps 8-11.

## Malformed or failed response (RVM-1.2)

If the subagent returns malformed JSON, retry once with a reminder of the schema. Treat an outright failure of the Agent
tool dispatch itself (it errors, or `REVIEW_SUBAGENT_TYPE` names an invalid/nonexistent `subagent_type` from a
misconfigured override) identically. The retry re-dispatches the exact same `REVIEW_SUBAGENT_TYPE` that failed.

If the retry still fails, branch on what `REVIEW_SUBAGENT_TYPE` resolved to:

- **Built-in default** (`shipwright:code-reviewer`): fall back to an inline review in the main thread using the same
  rules (see `agents/code-reviewer.md` for the canonical rule set).
- **Configured override** (a non-default `subagent_type`): do not attempt an inline main-thread review of the failed
  override — the main thread has no knowledge of a custom methodology's rules. Dispatch the built-in
  `shipwright:code-reviewer` fresh as the safety net and print a one-line note that the configured subagent
  `{REVIEW_SUBAGENT_TYPE}` failed after retry and the built-in reviewer was used as a fallback. If that fresh built-in
  dispatch also fails, it is governed by the **Built-in default** branch: its own single retry, then the inline review.
  Do not re-dispatch `{REVIEW_SUBAGENT_TYPE}` again and do not loop: at most override → override retry → built-in →
  built-in retry → inline.

Either way, Step 7 must end with SOME valid parsed response before Step 8 runs. Steps 9-11's claim-owning writes
(`reviewedCommitSha`/`reviewState`/`reviewedAt`) run afterward regardless of which path produced the response, so a hanging
or unparsed Step 7 would leave the PR claim outstanding.
