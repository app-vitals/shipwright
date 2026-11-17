# review-lean: multiple reviewers (MPS-2.1, MPS-2.2, MPS-2.3)

Read this when `REVIEW_SUBAGENT_TYPE` contains a comma (`commands/review-lean.md` Step 7). The spine keeps the four
must-run rules: dispatch all reviewers in one parallel call, merge before any Step 8 threshold, verify with
`shipwright:finding-verifier` when more than one response survives, and verifier failure is non-fatal.

## List parsing

`REVIEW_SUBAGENT_TYPE` may hold a comma-separated list of `subagent_type` names (the API accepts up to 5 entries for the
review phase). Split it on commas into `REVIEWERS`, trim whitespace around each entry, and ignore empty entries. If
`REVIEWERS` has exactly one entry (including a list that resolves to one entry after trimming, such as
`"shipwright:code-reviewer,"`), follow the single-reviewer path unchanged — everything below applies only when `REVIEWERS`
has more than one entry.

## Parallel dispatch

Dispatch every reviewer in ONE parallel Agent call: a single message containing one Agent tool use per entry in
`REVIEWERS`, each with `subagent_type` set to that entry, the same `model: TASK_MODEL ?? 'sonnet'`,
`run_in_background: false`, and the identical prompt block and contract inputs. The fan-out is still synchronous and
blocking; there is no wakeup or poll step. Each response is parsed independently.

## Per-reviewer failure

A reviewer whose response is malformed, or whose dispatch itself fails, is retried once by re-dispatching the same
`subagent_type` with a reminder of the schema. If the retry also fails, drop that reviewer and print
`reviewer {subagent_type} failed after retry and was dropped`. Do not substitute the built-in reviewer for an individual
dropped reviewer while others survive.

**All reviewers failed.** If every reviewer is dropped, fall back to the built-in `shipwright:code-reviewer`: dispatch it
fresh, retry once on failure, then the inline main-thread review — at most built-in → retry → inline. If at least one
reviewer succeeded, proceed with the surviving responses.

## Merge (MPS-2.2)

With more than one surviving response, merge them into ONE response before Step 8; a single surviving response skips the
merge. Merge BEFORE applying any policy threshold.

- **Duplicate rule.** Two findings are duplicates when ALL of: (1) identical `file`; (2) lines within a 3-line window
  (`abs(a.line - b.line) <= 3`; a `null` line matches only another `null` line on the same file); (3) title similarity —
  after lowercasing and stripping punctuation, one title contains the other, or the token sets share Jaccard overlap
  >= 0.6. Group transitively (if A~B and B~C, all three are one group).
- **Collapse each group** into one finding: keep the member with the highest `severity` (`critical` > `important` >
  `suggestion`), breaking ties by highest `confidence`, and use that member's `title`, `file`, `line`, `category`,
  `description`, and `suggestion`. Set the merged `confidence` to the group's maximum. Severities never average.
- **Agreement count.** Record `agreement` = the number of DISTINCT reviewers that reported a member of the group, in a
  main-thread side map keyed by the merged finding. It is NOT added to the finding object; use it only to break ties when
  Step 8 trims to `max_findings` (higher `agreement` kept first among equal `confidence`).
- **Non-duplicates** pass through unchanged, with `agreement` = 1.
- **`priorFindingsStatus[]`.** Merge conservatively, per `ref`: `resolved: true` only if EVERY surviving reviewer that
  returned an entry for that `ref` attested `resolved: true`; if any said `false`, the merged entry is `resolved: false`
  with `evidence` from a `resolved: false` reviewer. A reviewer that omitted the `ref` does not count as attesting
  resolved. Emit exactly one entry per input `ref`.
- **`riskAssessment` (RSK-2.1).** Keep each surviving reviewer's `riskAssessment` in `RISK_ASSESSMENTS` and take the union
  of their `factors[]` (`compute-risk-rating.ts` de-duplicates and raises the level itself). Not added to findings.
- **Other fields.** `strengths[]` is the de-duplicated union; `recommendation` is `COMMENT` if any surviving reviewer said
  `COMMENT`, else `APPROVE`; `summary` and `recommendation_reason` come from the reviewer that supplied the
  highest-severity finding (else the first surviving reviewer).

The merged object conforms to the unchanged review contract shape, so Steps 8-11 consume it exactly as a single
reviewer's response.

## Verify (MPS-2.3)

Runs only when `REVIEWERS` had more than one entry AND more than one surviving response was merged; after the Merge and
BEFORE any policy threshold. The verifier is a fixed built-in: dispatch `shipwright:finding-verifier` — never read from
config, no `phaseMethodology` key — with `model: TASK_MODEL ?? 'sonnet'` and `run_in_background: false`, passing the diff,
the changed-files list, and the merged `findings[]` each tagged with its `index`. It returns
`{"verdicts": [{"index", "substantiated", "evidence"}]}`.

- Drop every merged finding whose verdict is `substantiated: false`, and remove it from the `agreement` side map.
  Findings with `substantiated: true`, or with no verdict, are kept.
- The verifier can only drop findings: it never adds findings or alters `severity`, `confidence`, or any other field.
- **Non-fatal failure.** If the dispatch fails or the output is malformed (no retry), keep the merged findings unverified
  and print `finding verifier failed; using unverified merged findings`. Verifier failure never blocks Step 8.
