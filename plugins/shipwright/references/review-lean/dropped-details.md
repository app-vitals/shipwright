# Intentionally dropped from the review-lean spine

`commands/review-lean.md` is a trimmed variant of the 1960-line `commands/review.md`, built from the DTA-10.4 audit
(`planning/dev-task-adherence/review-drop-audit.md`). The spine carries every step, every guard's trigger, deciding command
and stop rule, and a **Proof:** line per `required-steps/review.json` step; mechanics moved to the sibling files in this
directory. It is reachable only through `SHIPWRIGHT_LOOP_REVIEW_ALT_COMMAND` (not wired to any cron); `review.md` is
unchanged. Nothing in the audit's incident-driven guard list was dropped. The only guard demoted to a reference is the
multi-reviewer algorithm, behind the mechanical "`REVIEW_SUBAGENT_TYPE` contains a comma" trigger, with its four must-run
rules still in the spine.

## Dropped text

| Dropped | Reason |
|---|---|
| jq `//` vs `select(. != null)` essay (Step 1) | Reduced to one clause; evidence in commit `c41f32be2`. |
| "Always use `origin/$base`" explanation | The rule and the file-count sanity check stay; narrative in `b0b104725`. |
| GraphQL extraction exposition ("the `_JSON` variables hold the full connection object ...") | Reduced to "pass whole connection objects through"; the script's input check fixes the shape. |
| PR #89 ledger-ordering race timeline | Kept as the one-line rule "every ledger POST completes before `/complete`"; evidence in `345521154`. |
| "Before this fix, Step 5 ran this decision freehand ..." | History; in `145071f2e` (UCC-1.1). |
| "This is the same computation Step 9.5 performs" restatements | The scripts' unit tests are the spec. |
| Watched-path script exposition (`managers`, `package-ecosystem`, the universal list) | Duplicates `resolve-dependency-watched-paths.ts` and its tests; the empty-set rule is recorded in `ba5f1cd5a`. |
| Step 9.5 exclusion list and the "ledger breaks the deadlock" story | Duplicates `compute-unaddressed-findings.ts`; a short summary is kept in `ledger-and-findings.md`; story in `7c4f0e658` and `ddafdc573`. |
| Step 10 worked example (Cases 1-3) and the 8-row truth table | Restates `computeVerdict` and `compute-review-verdict.unit.test.ts`; the one live rule (self-review: `event` COMMENT, label APPROVE) stays in the spine. Incidents: `41476a142`, `ddfd6e607`. |
| `review-staged` scoping note on PFL-5.2 | No action for this command; kept as one sentence in `ledger-and-findings.md`. |
| Step 11b `else`/`fi` wrapping instructions and stale "lines 926, 935" cross-reference | Collapsed into a single `[ -n "$PR_RECORD_ID" ]` guard; the line references pointed nowhere. |
| Step 3 staged-reviews and "Step 14 parses it" paragraphs | Duplicated by Step 14's staged branch, kept as one bullet. |
| Five of the twelve Review Quality Rules | "Keep it tight" (Step 8 trims), "Never REQUEST_CHANGES" (the script's `event` is APPROVE or COMMENT), "APPROVE means clean" and "Check for unresolved feedback first" (Steps 9.5/10), "Concise approvals" (judgment guidance covered by the code-reviewer's own rules). |
| Three copies of the skip-reason and RCT-1.1 "perpetual retrigger" explanations | Stated once in the shared settle-and-stop block; detail in `guards-detail.md`. |

## Merged (behavior-preserving)

| Change | Note |
|---|---|
| One `GET /agents/:id/config` fetch | Policy, `phaseMethodology.review` and `repos[0]` were three calls to the same endpoint; each keeps its fail-soft default. |
| PR identity captured once | `PR_AUTHOR`/`PR_TITLE`/`PR_HEAD_REF` come from the Live-Review Pre-Check's response instead of three `gh` calls; Step 5's metadata still re-reads `PR_AUTHOR`. |
| One record lookup | By `PRECLAIM_RECORD_ID` or repo+prNumber, reused for the terminal write-back, staged check and dedup. |
| One settle-and-stop block | The three `reviewState: posted` write-backs share one PATCH; callers supply the reason and print line. The UCC caller also sets `commitSha`; the terminal caller keeps its "only when the record does not already reflect it" guard. Still one atomic write, no separate release (`dca470d37`). |
| One claim call | Self-claim and the staged-refresh re-claim use the same body and 409 handling; the claim runs before the worktree is created (the audit's order), so a 409 has no worktree to remove. |
| One release line | Used by the RHR-1.1 abort and the post-failure path. |
| One ledger POST form, built with `jq -n --arg` | Replaces four hand-built JSON strings; also removes the interpolation risk the PFL-2.1 and PFL-5.2 literals carried. |
| Staged PATCH | The two verdict-specific curls are one PATCH with a verdict-dependent `reviewState`. |

## Added

| Change | Note |
|---|---|
| `PRIOR_FINDINGS_STATUS_JSON` is assigned in Step 7 | `review.md` uses it in Step 9.5 but never assigns it (audit gap); the lean spine assigns it from the parsed `priorFindingsStatus[]`, or `[]`. |
| Printed proof lines for Steps 5, 6.1, 9.5 and 10.5 | `review.json` marks them "marker needed"; each now prints one line. Print-only; no state change. |

## Deliberately not changed (tracked separately per the audit)

- Step 10 and Step 10.5 stay two calls to `compute-review-verdict.ts`, invoked exactly as in `review.md`.
- No `check-live-review.ts` or `merge-review-responses.ts` script yet; the live-review query and jq predicate stay literal.
- `review.md` keeps its unassigned `PRIOR_FINDINGS_STATUS_JSON`; fixing it there is a separate task.
