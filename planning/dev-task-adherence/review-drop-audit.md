# review-lean drop audit (DTA-10.4)

Scope: decide what a lean version of `plugins/shipwright/commands/review.md` (1960 lines) may drop or demote before anyone writes `review-lean`. Docs-only; no prompt is changed here.

Context: `PLAN.md` (this directory) trims one prompt at a time, with the steps as the product and the "how" as the cut target. DTA-2.2 built the dev-task variant (spine + `references/`) and DTA-9.6 audited patch (`patch-drop-audit.md`); review is the next prompt. The DTA-10 section is not in this checkout's `PLAN.md` (the last addendum is DTA-9.x), so its scope and the loading figure below come from the DTA-10.4 brief, not from the repo. No `review-lean.md` exists. The trial would run it through the generic `SHIPWRIGHT_LOOP_REVIEW_ALT_COMMAND` style switch, so review-lean should copy the same shape as dev-task-lean and patch-lean: a spine that carries every step, plus reference files that carry mechanics.

## Guiding lesson

References load in only single-digit to twenty-percent of runs (figure supplied with the DTA-10.4 brief; the measurement is not in this repo, so treat it as given, not re-derived; `learnings-patch.md` and the DTA-9.x addendum record the dev-task rates, 2-27%). Therefore:

1. Anything that must run on every qualifying run goes in the spine. A step that lives only in a reference is skipped 80-99% of the time, and adherence is what PLAN.md exists to protect.
2. A reference is acceptable only for content that is (a) entered on a mechanical, spine-visible trigger (a config value, a matched file, a failed call), or (b) context/mechanics whose absence degrades quality but does not skip a step.
3. For a guard, split it: the trigger, the one command that decides, and the "stop / do not post" rule stay in the spine; long matching rules, payload templates, rationale and caveats move to a reference the spine names.
4. "Drop" is reserved for text that restates something already enforced elsewhere (a `compute-*.ts` script and its unit tests, `agent/src/check-*.ts`, the code-reviewer agent) or pure incident narrative. Incident narrative is not lost: it stays in commit messages, `planning/*/PLAN.md` and git history, which this audit cites.
5. Review has a property patch lacks: roughly a third of its length is already "call a script, use its output verbatim" (`compute-unresolved-comment-check.ts`, `compute-unaddressed-findings.ts`, `compute-review-verdict.ts`, `compute-pr-risk-signals.ts`, `compute-risk-rating.ts`, `resolve-dependency-watched-paths.ts`). The prose wrapped around those calls (truth tables, exclusion lists, "before this fix" histories) duplicates the scripts' unit tests, which are the stated spec in the file's own text (lines 535-538, 1206-1210). That prose is the biggest safe cut.

## Summary table

| Item | Section (review.md lines) | Verdict | One-line reason |
|---|---|---|---|
| Step 9.5 unaddressed-findings hard gate (RUC-1.1, PVD-1.1, PVD-1.3) | 1121-1233 | Keep in spine (script call, force COMMENT, "never skip because another input forces COMMENT"); exclusion prose to reference; deadlock narrative dropped | Forces COMMENT over a subagent APPROVE; skipping it posts an APPROVE over a live unresolved thread |
| Step 10 verdict computation | 1237-1347 | Keep in spine (script call, literal `Verdict:` label); truth table and worked cases dropped | Script and unit tests are the spec; the label rule is the incident |
| Step 10.5 hard-gate validation | 1409-1432 | Keep in spine (call + hard abort) | Only enforcement that the posted body carries the right label |
| Step 5 Unresolved Comment Check (UCC-1.1) | 479-580 | Keep in spine (head-moved bypass, script call, settle-and-stop); caveat and bot-detection prose to reference | Without the write-back the PR is re-selected every tick |
| Step 14 Live-Review Pre-Check (RVD-1.2) | 1623-1808 | Keep in spine (query, terminal rule, fresh-comment exception, settle-and-stop); mirror prose to reference | Only cross-task-store dedup layer; runs before any claim |
| Step 14 Pre-Claim Fast Path (CBD-1.4) | 1810-1831 | Keep in spine (6 lines) | Avoids a self-409 against the orchestrator's own claim |
| Step 5.8 dependency-manifest detection (DBR-3.2) | 594-676 | Keep detection in spine (script + 3 match rules + "any author"); analysis already in `references/dependency-risk-analysis.md`; script exposition dropped | Trigger is a file match, not an author; the reference loads only on a match |
| Step 6.1 risk signals (RSK-2.1) | 695-710 | Keep in spine (one script call, non-fatal) | Newest feature (2026-11-13); with no spine call there is no Risk line at all |
| Step 11 self-review ledger write (PFL-5.2) | 1495-1524 | Keep in spine (the `if` + POST, ordered before 11b) | Silent failure makes patch spin on a clean self-approved PR forever |
| Step 7 multi-reviewer Merge/Verify (MPS-2.1/2.2/2.3) | 850-948 | Move to reference behind a mechanical spine trigger (comma in `REVIEW_SUBAGENT_TYPE`); 4 must-run rules stay in spine | Opt-in config, 5-entry cap, runs only when configured |
| Other guards (RHR-1.1 stale-head, never re-POST, heartbeat, diff sanity, model tier, ledger ordering, RVM-1.2 failure chain, staged path) | various | Keep in spine, compressed (see "Other guards") | Each is a pre-post stop or a state write whose omission has an incident |
| Step 4 / Step 14 claim and dedup | 134-188, 1606-1935 | Merge into one shared "resolve, dedup, claim" section | Same claim body built 3 times, same settle-and-stop PATCH 3 times |
| Step 9 review-file template | 985-1117 | Move to reference (template); spine keeps "write the file" | Format guidance, not a decision; consumed by `review-staged` |

Nothing is dropped outright except the items listed under "Dropped text" at the end, each with a rationale.

## Incident-driven guards

For each guard: purpose, incident or design rationale (with evidence source), verdict, reason. "Not found" means `git log -S`/`--grep` for the ID, `planning/` and `docs/` turned up nothing beyond what is cited.

### Step 9.5: unaddressed-findings hard gate (lines 1121-1233)

- **Purpose.** Immediately before the verdict, call `compute-unaddressed-findings.ts` with the GraphQL `reviews`/`reviewThreads`/`comments` (Step 5.5), `PR_AUTHOR` as `prAuthor`, the ledger (`PR_FINDINGS_JSON`) and the subagent's `priorFindingsStatus[]`, and assign `UNADDRESSED_FINDINGS`. When true it forces `event`/`Verdict:` to `COMMENT`, overriding a subagent APPROVE, and is one of three independent inputs to Step 10 (it must not be skipped because another input already forces COMMENT).
- **Incident / rationale.** RUC-1.1: `72ff0a7c3` (#2419, 2026-07-31). Before it, Step 5 fetched only issue-level comments and review objects (`gh pr view --json comments,reviews`), blind to inline threads and their `isResolved`, so a PR with a genuinely unresolved inline thread was auto-approved the moment a new commit landed. PVD-1.1 extracted the logic into the script (mirroring DRO-1.1). PVD-1.3, `7c4f0e658` (#2601): same-pass resolution exclusion, closing a deadlock where a self-authored COMMENT finding could never be superseded. The exclusion list grew by CPF-2.1/2.3, DRO-1.2, URT-1.1 (`fad535376`, #2758), RAS-1.1 (`33e692834`, #2720: scope author-reply to the real PR author, not `currentUser`), PFL-3.2 (ledger), and PHS-1.2 (`30a93cdd1`, #4103: patch-source `rejected` ledger refs). PFL-4.1 (`ddafdc573`, #3010) then removed the inference heuristics, and PFL-5.1/5.2 (`c3e0ea875`, #3052; `planning/pfl-5-ledger-fallback-gap/PLAN.md`) restored a fallback and closed the gap at the root (see Step 11 below). The text itself says the script's unit tests, not the prose, are the behavioral spec (lines 1206-1210).
- **Verdict: keep in spine.** Spine (about 5 lines): the script invocation shape, the assignment `UNADDRESSED_FINDINGS=...`, pass `[]` when there is no `priorFindingsStatus[]`, "if true the verdict is COMMENT regardless of the subagent or the other two inputs". Reference (`ledger-and-findings.md`): a 20-line summary of the exclusions for human readers.
- **Why.** The gate is a stop on the exact failure that produced the incident (APPROVE over a live thread) and is cheap (one call). At a single-digit-to-20% load rate a reference would let it fail open on most runs. The 13-line "ledger breaks the deadlock" story (1192-1204) is rationale for how the script's exclusion works and is already in the commit bodies above, so it is dropped. One spine fix is required: `PRIOR_FINDINGS_STATUS_JSON` is used at line 1149 but is never assigned anywhere in the file (only described in prose at 1157-1163); the lean spine must say "assign it from Step 7's parsed `priorFindingsStatus[]`, or `[]`".

### Step 10: verdict computation (lines 1237-1347)

- **Purpose.** Compute `selfReview`, take `unaddressedFindings` (9.5) and `currentPassHasBlockingFindings` (Step 8, lines 975-981), call `compute-review-verdict.ts`, and use `event` and `verdictLabel` verbatim. The `body` must lead with the literal `Verdict: APPROVE` or `Verdict: COMMENT`, even when `event` is forced to `COMMENT` (self-review).
- **Incident.** Two. (1) `41476a142` (#1292, 2026-07-09): free-form approval prose never matched `check-patch.ts`'s `isSelfCleanApprove` regex, so a clean self-approve was treated as an unaddressed finding forever; it required the literal label. (2) `ddfd6e607` (#2515, 2026-08-09, DRO-1.1): prose guidance "alone let the same mislabeling bug recur days after it was first documented", across two PRs (one self-authored); it made the decision mechanical, and the review of that PR added the current-pass severity input (Case 3). Source: those commit bodies and lines 1288-1335 of the file.
- **Verdict: keep script call and label rule in spine; drop the worked example and 8-row table.** Spine keeps: the three inputs, the call, "use output verbatim", the literal-label rule with the self-review exception stated in one line, the JSON shape reference. The Case 1-3 narrative (1288-1335) and the 8-row table (1337-1346) restate `compute-review-verdict.ts`'s `computeVerdict` and `compute-review-verdict.unit.test.ts`; they are dropped (rationale below). The Risk and dependency fold-in formats (1369-1400) move to `verdict-folding.md` with a 3-line spine rule ("append after the `Verdict:` lead-in; Risk only when `verdictLabel` is APPROVE").
- **Why.** The failure was the model deciding the label itself; the script removed that, so the spine must keep the call. The truth table cannot be re-decided by a model that is told to use the script's output.

### Step 10.5: hard-gate validation (lines 1409-1432)

- **Purpose.** Re-invoke `compute-review-verdict.ts` in validation mode with the built `BODY`; `valid: false` means hard abort, fix the body to the right `Verdict:` phrase and re-validate before Step 11.
- **Incident.** Added with `ddfd6e607` (#2515) for the same recurrence as Step 10; the text calls it "the enforcement gate that the recurring mislabeling incidents above prove prose guidance alone did not provide" (lines 1430-1432).
- **Verdict: keep in spine** (about 5 lines). Step 10 and 10.5 are two calls to one script; merging them into one invocation would be a behavior change and is not part of "lean" (follow-up, see Risks).
- **Why.** This is the only place the posted body is checked against the computed verdict. It is a pre-post stop; a reference load rate this low makes it fail open.

### Step 5: Unresolved Comment Check (lines 479-580)

- **Purpose.** Before writing the review, skip the pass if a human is already mid-conversation and the head has not moved. If `lastReviewedCommit` is set and `headRefOid != lastReviewedCommit`, skip the check (new commits override all unresolved-thread skips). Otherwise call `compute-unresolved-comment-check.ts` and, on `hasSubstantiveUnresolvedFeedback: true`, PATCH the record to `reviewState: posted`, `commitSha`/`reviewedCommitSha: headRefOid`, `reviewedAt: {now}`, print the skip line, emit `[skip-reason:review:deferred:unresolved-human-feedback:{pr}]`, answer `[silent]` and stop.
- **Incident / rationale.** Several, each leaving a mark in the text. Mechanization: `145071f2e` (#3208, UCC-1.1, 2026-09-04): Step 5 decided freehand and never excluded author-replied feedback, so its wrong answer won even when Step 9.5 would have said resolved (lines 503-505 say this). Bot detection via GraphQL `__typename`: RBD-1.1, `389ec1378` (#3813, 2026-09-30); planning in `planning/review-bot-detection-fix/PLAN.md`. Skip marker: `1c9773121` (#2470, 2026-08-06, STD-1.4), so the loop's generic `[silent]` handling does not count a legitimate defer toward `SKIP_BLOCK_THRESHOLD` (`planning/pr-skip-loop-guard/PLAN.md`). `reviewedAt` advance: RCT-1.1/RVG-1.1 (the `hasFreshNonAgentComment` watermark in `agent/src/check-review.ts`, `d91b48cce` #2649). Replacing the old `release` with the PATCH: BHE-1.3 (asserted in `review.content.test.ts`, "Step 5 unresolved-feedback skip marks reviewed-at-commit").
- **Verdict: keep in spine** (about 6 lines, using the shared settle-and-stop block, see below). The reconciler caveat (562-572: a plain PR comment with no formal review at head is healed back to `pending` by `pr-state-reconciler.ts` every 30-60 min) and the bot-detection explanation (497-502) go to `guards-detail.md`. The "before this fix" history (503-505) and the "same computation as 9.5" restatement (535-538) are dropped.
- **Why.** The write-back and the skip marker are the parts that keep a stopped run from looping or tripping the HITL auto-block; they are mechanical and must run. The caveat is knowledge, not a step.

### Step 14: Live-Review Pre-Check, RVD-1.2 (lines 1623-1808)

- **Purpose.** Before any record fetch, claim or checkout, and even with a pre-claim marker, query GitHub for reviews at the current `headRefOid` and decide `terminal`: a review whose body matches the `Verdict: APPROVE|COMMENT` label, or whose `state` is `APPROVED`, with no fresh comment by anyone other than `CURRENT_USER` after the latest terminal review's `submittedAt`. If terminal: write the outcome back (PATCH `reviewState: posted`, `reviewedCommitSha`, `reviewedAt`, only when the record does not already reflect it), print the skip line, emit `[skip-reason:review:deferred:already-reviewed-at-head:{pr}]`, `[silent]`, stop, no claim, no checkout.
- **Incident / rationale.** Design: `f7fb29c39` (#2255, 2026-07-27, RVD-1.2): Step 14's dedup was task-store-record-based, blind to reviews from an agent on a different task-store instance or from a human running the command directly; it exports `VERDICT_TERMINAL_LABEL` from `check-helpers.ts` with a parity test. Candidate-selection mismatch that makes this load-bearing: `planning/review-candidacy-dedup-gap/PLAN.md` (PR #2600 and a downstream repo PR oscillated 12h47m+, 28 and 35 wasted dispatches). Write-back and race fix: `dca470d37` (#2730, 2026-08-19): the earlier separate `release` before a later PATCH left the PR unclaimed and `pending` if the run stopped between them (confirmed live on PR #89 in an external repo; the repo is not named in the commit, so not found here); the fix relies on the single atomic PATCH, which clears `claimedBy`/`claimedAt`/`heartbeatAt`/`phase` server-side when `reviewState` becomes `posted`. Broadened fresh-reply (any non-`CURRENT_USER` commenter): RCT-1.1/1.2, `d91b48cce` (#2649) and `planning/patch-comment-findings/PLAN.md`. Skip marker: `f8b1f3ff1` (#2478, 2026-08-07).
- **Verdict: keep in spine** with the GraphQL query and jq predicate compressed to the smallest form that still contains the `$currentUser` threading and the APPROVED branch. The 32 lines of prose mirroring `check-helpers.ts` `isTerminalReviewLabel` and `hasFreshNonAgentComment` (1689-1720) and the CHU-2.4 reconciler caveat (1780-1792: safe because `$terminal == true` implies a real review object at head, so `hasAnyReviewAtHead()` stays true) go to `guards-detail.md` (kept, not dropped), keeping only the one-line "`gh api` has no `--arg`; pipe to `jq`" gotcha in the spine.
- **Why.** It is the first thing that runs and a pre-claim stop; a reference load rate this low would put the cross-task-store defense in the 80-99% of runs that skip it. Note for the lean author: the jq program and the GraphQL query are literal code that must survive verbatim; the highest-value follow-up (not part of this audit) is a `check-live-review.ts` script, mirroring the `compute-*.ts` pattern, which would free about 15 spine lines.

### Step 14: Pre-Claim Fast Path, CBD-1.4 (lines 1810-1831)

- **Purpose.** If a `[preclaim:{recordId}:{commitSha}]` marker is present, fetch the live head and compare. A match: set `PR_RECORD_ID = PRECLAIM_RECORD_ID`, skip the record fetch, staged check, dedup check and Step 4's own `/prs/claim`. A mismatch or no marker: self-claim as before.
- **Incident / rationale.** Design, `aba32c7ba` (#1836, 2026-07-17, CBD-1.3/1.4/1.5/1.6): the orchestrator pre-claims before dispatch so a downstream skill must recognize the claim instead of 409-ing against itself.
- **Verdict: keep in spine** (about 6 lines), as part of the merged claim section. `LAST_REVIEWED_COMMIT` is unset on this path, so Step 5's Unresolved Comment Check treats the run as a first review; the lean spine must keep that sentence because it changes which branch of the check runs.
- **Why.** Skipping it is a self-409 and a silent no-op run, which the orchestrator's skip counter then charges.

### Step 5.8: dependency-manifest detection, DBR-3.2 (lines 594-676)

- **Purpose.** For any PR (not gated on author), build the repo's watched-path set via `resolve-dependency-watched-paths.ts` from `renovate.json`/`.github/dependabot.yml`, compare it with the changed files by exact, basename (bare-filename entries only) or directory-prefix (entries ending `/`) match, and on a hit apply `references/dependency-risk-analysis.md` to produce `DEPENDENCY_RISK_ANALYSIS` for Step 9's section and Step 10's body clause. No match: no section anywhere downstream.
- **Incident / rationale.** Design, `ba5f1cd5a` (#3112, 2026-09-03). A review fix on that PR is recorded in the commit body: an empty or unparseable-ecosystem `dependabot.yml` must resolve to an empty watched set, not the universal fallback, or Step 5.8 would fire on manifests the repo demonstrably does not watch. The retired Dependabot/Renovate-specific triage skill it superseded was DBR-3.4. The companion in patch is DBP-1.2 (`planning/dependency-patch-flow/PLAN.md`).
- **Verdict: keep detection in spine; analysis stays in its existing reference.** Spine (about 5 lines): the script call, the three match rules in one sentence each, "not gated on `PR_AUTHOR`", "on a match Read `references/dependency-risk-analysis.md` and carry `DEPENDENCY_RISK_ANALYSIS` forward", "no match: no section". The 19-line exposition of what the script does with `managers`, `package-ecosystem` and the universal fallback list (621-639) is dropped: the script and its tests own it, and the review that produced `ba5f1cd5a` shows the prose and script had already diverged once.
- **Why.** Same shape as patch's DBP trigger, but here the trigger test is a file match computed by a script on every PR, so the spine must run the detection; only the heuristics (already in a reference, 94 lines) are behind the "match" trigger. If the match step lived in a reference, bot-authored bump PRs would lose their Dependency Risk section on most runs, which is precisely what the incident protected.

### Step 6.1: risk signals, RSK-2.1 (lines 695-710)

- **Purpose.** Build `FILES_JSON` from `git diff --numstat "origin/$base"...HEAD`, map CI to `passing|failing|pending|unknown`, call `compute-pr-risk-signals.ts`, keep `RISK_SIGNALS` (empty on failure). Combined with the subagents' `riskAssessment` by `compute-risk-rating.ts` after Step 7 (lines 918-931) to produce a Risk line on `APPROVE` bodies.
- **Incident / rationale.** Feature, not incident: `40a18b7a1` (#5116, 2026-11-13) and `planning/review-risk-score/PLAN.md` (initiative SWI-3: the posted review includes a Low/Medium/High rating when the verdict is APPROVE; deterministic signals plus reviewer judgment; failure never blocks). Not found: any incident.
- **Verdict: keep in spine** (about 5 lines for 6.1 here, plus the rating call counted in Step 7's allocation). Non-fatal failure stays stated once.
- **Why.** The feature exists only if the call runs; a reference load rate this low means most APPROVEs would lose the Risk line without any failure signal, and the feature is 3 days old at audit time (2026-11-16), so adherence data for it does not exist yet. The Risk fold-in format moves to `verdict-folding.md`.

### Step 11: self-review ledger write, PFL-5.2 (lines 1495-1524)

- **Purpose.** After a successful direct post, if `SELF_REVIEW=true`, `UNADDRESSED_FINDINGS=false`, `CURRENT_PASS_HAS_BLOCKING_FINDINGS=false` and `SUBMITTED_AT` is set, POST a `resolved`/`source: review` ledger entry with `ref = ${headRefOid}@${SUBMITTED_AT}`. It must complete before Step 11b's `/complete`.
- **Incident.** `c3e0ea875` (#3052, 2026-09-02) and `planning/pfl-5-ledger-fallback-gap/PLAN.md`: a PR whose only review was a clean self-approve never got a later pass, so PFL-2.1 never ledgered it and `isResolvedByLedger` stayed false forever; patch spun on a PR that was already clean. Ordering: `345521154` (#2748, 2026-08-20) and the PR #89 timeline in lines 458-469: ledger POSTs landed about 13 s after `/complete`, so `hasFreshLedgerFinding` treated them as new information and re-claimed the PR next tick.
- **Verdict: keep in spine, in compressed form**: the `if` condition, the one POST, "non-fatal, but strictly before 11b". Same for PFL-2.1's two POSTs in Step 5 (373-446) and the attestation POST in Step 7 (776-810): the three curl shapes become one defined form (see the merge table below) and one rule "all ledger POSTs complete before `/complete`". The PR #89 timeline (12 lines) is dropped to the one-line rule; evidence stays in `345521154`. The scoping note about `review-staged` (1521-1524) is dropped.
- **Why.** Failure is invisible to outcome metrics: the PR just keeps being re-selected or re-patched. Skipping the ledger write breaks the `hasFreshLedgerFinding` and `isResolvedByLedger` contracts without any error, which is the worst class of guard to leave behind a reference. The PFL-2.1 POSTs also carry `priorQualifyingReviews` (PVD-1.2, lines 373-407), whose "reuse the script's exported helpers rather than re-derive" rule must be kept.

### Step 7: multi-reviewer Merge and Verify, MPS-2.1/2.2/2.3 (lines 850-948)

- **Purpose.** When `REVIEW_SUBAGENT_TYPE` holds a comma-separated list (up to 5 entries per the API), dispatch every reviewer in one parallel Agent call, retry a failed reviewer once then drop it, fall back to built-in -> retry -> inline only if all fail, merge the surviving responses before any threshold (duplicate rule: same file, lines within 3, title containment or Jaccard >= 0.6; keep highest severity, max confidence, `agreement` side map; conservative `priorFindingsStatus[]` merge; union of `riskAssessment`), then dispatch the built-in `shipwright:finding-verifier` and drop findings it cannot substantiate (non-fatal on failure).
- **Incident / rationale.** Design, not incident: `fdaea0621` (#4858, 2026-11-06, MPS-2.1/2.2/2.3) and `planning/multi-subagent-review/PLAN.md` (client request for parallel reviewers: single-entry lists take the existing path untouched; fan-out is safe only for read-only review; thresholds apply after the merge, never per reviewer). Not found: any incident.
- **Verdict: move to reference behind a mechanical trigger.** Spine keeps four must-run rules (about 4 lines): "if `REVIEW_SUBAGENT_TYPE` contains a comma, Read `references/review-lean/multi-reviewer.md` before dispatching"; "dispatch all in one parallel call"; "merge before Step 8 thresholds"; "verify with `shipwright:finding-verifier` when more than one response survives, non-fatally". Reference keeps the duplicate rule, collapse rule, `agreement` map, `priorFindingsStatus[]` and `riskAssessment` merge, and per-reviewer failure and verifier output shape.
- **Why.** The trigger is a config value the model has already resolved a few lines earlier, so the load decision is deterministic rather than discretionary, and the feature is opt-in (a single-entry list "follows the single-reviewer path unchanged"). With the four rules in the spine, a skipped reference degrades merge quality but cannot skip the merge or the verifier. Caveat: no figure for how many agents are configured with a list is in this repo; if it turns out to be most of the fleet, promote the duplicate rule into the spine. A `merge-review-responses.ts` script (the same pattern as the other `compute-*.ts` scripts) is the better follow-up and would remove the algorithm from the prompt entirely.

## Other guards found

| Guard | Section (lines) | Purpose | Incident / rationale | Verdict |
|---|---|---|---|---|
| Stale-head re-check before POST (RHR-1.1) | Step 11.1, 1440-1464 | Re-fetch `headRefOid` just before the POST; on mismatch release the claim, print the abort line, skip 11b | `668638a2d` (#2735, 2026-08-19): on app-vitals/shipwright PR #2728 a fix commit landed 29 s before the review posted, still citing the stale SHA | Keep in spine (about 3 lines) |
| Never re-execute the review POST | Step 11.2, 1465-1475 | Write the response to a temp file, never `echo "$var" \| jq`, never re-run `gh api -X POST` | `b3e202163` (#2319, 2026-07-28): newline corruption led to retries that posted duplicate COMMENT reviews GitHub cannot delete | Keep in spine (2 lines); this one is irreversible |
| Post-failure release | Step 11.4, 1481-1494 | A failed POST releases the claim and skips 11b | Same section's own rationale (11b would hide the PR from candidacy via the `commitSha`/`reviewState` dedup) | Keep in spine (2 lines) |
| Claim heartbeat | Step 5 item 8, 582-590 | Renew the heartbeat before the long review-writing phase | `5ecec1bea` (#1050, 2026-07-03): raised the PR claim TTL to 15 min and added renewal; the reaper otherwise resets a long review to `pending` | Keep in spine (2 lines) |
| Diff base and file-count sanity check | Step 5.2/5.3, 262-281 | Diff against `origin/$base`; stop if the diff has about 2x the files in `changedFiles` | `b0b104725` (#2336, 2026-07-28): a stale local `main` produced 68 files instead of 4 | Keep in spine (3 lines); the "why" prose (268-272) dropped |
| Linked-task model tier | 190-223 | Query `GET /tasks?repo&pr`, take the highest tier among matches, default `sonnet` | `db7b2afce` (#2989, 2026-08-31): `PullRequest.taskId` populated on about 10% of records, so the old lookup silently no-op'd | Keep in spine, compressed to the one `jq` (about 4 lines); quality enrichment but silently changes the reviewer model when skipped |
| Configured review subagent, fail-closed | 225-244 | `phaseMethodology.review` from `/agents/:id/config`, default `shipwright:code-reviewer` | RVM-1.2, `c85dc6ae1` (#3747, 2026-09-29) | Keep in spine, fold into the single config fetch shared with policy and `repos[0]` (see merge table) |
| Malformed/failed response chain | 812-848 | Retry once, then built-in, then inline; always end Step 7 with a valid response; never loop; at most override -> retry -> built-in -> retry -> inline | RVM-1.2; the stated reason is that 9-11's claim-owning PATCHes must run, or the claim hangs | Keep a 3-line version in spine; override-specific branches to `step7-dispatch.md` |
| Policy via DB-first, `select(. != null)` | 72-100 | Read policy from `/agents/:id/config`, hardcoded defaults | APM-1.2, `c41f32be2` (#3751, 2026-09-29); the `// empty` vs `select(. != null)` note (87-91) records that `//` would discard a deliberately-set `false` | Keep in spine (the jq shape and 4 defaults); essay dropped, one-line comment kept |
| Staged path (`auto_post_reviews: false`) | 1528-1555 | PATCH `staged: true` with the verdict-dependent `reviewState` and clear the claim | `f39481b65` (#1383, 2026-07-10) | Keep in spine as one PATCH with a variable `reviewState` (2 curls become 1) |
| Step 11b `/complete` + agentId/reviewedCommitSha | 1559-1603 | Mark posted; never change task status | Text: merge looks tasks up by `pr_open`; changing task status here breaks that | Keep in spine (about 4 lines) incl. "never update task status" |
| Review Quality Rules | 1936-1958 | Verify before flagging, scope to the diff, no CI echo, no filler, file/line order, never REQUEST_CHANGES | Present since the initial import (`b558378f2`, #75); no incident cited | Keep 5 rules in spine; 5 duplicates dropped (see Dropped text) |
| Self-review override rationale | 1243-1244 | `selfReview` = canonical `PR_AUTHOR == CURRENT_USER`; GitHub rejects self-APPROVE | Text of Step 10 (API restriction) | Keep in spine (1 line, part of Step 10) |

## Near-duplicate claim and dedup logic (Steps 4 and 14)

Step 14 runs first (the file says so at lines 1636-1637), then falls into Step 4, so the same data and the same writes are produced in several places. Evidence from the text:

- The `/prs/claim` body (`claimedBy`, `repo`, `prNumber`, `commitSha`, `authorLogin`, `headRef`, `title`) is built twice: Step 4 (170-179) and the staged-refresh path in Step 14 (1865-1872); the fast path (1810-1831) is a third entry into the same claim.
- `PR_AUTHOR`/`PR_TITLE`/`PR_HEAD_REF` are captured three times: Step 4 (164-168), Step 5.1 (256-260), Step 14 (1680-1687).
- `headRefOid` is fetched in Step 4 (164), the fast path (1817), the staged branch (1849), the dedup check (1894) and the pre-post re-check (1447).
- The "record already reflects this head" write-back, `PATCH {reviewState: "posted", reviewedCommitSha, reviewedAt: now}`, exists in Step 5 (550-556), the Live-Review Pre-Check (1766-1773) and the step-3 dedup (1919-1925), each with its own `reviewedAt`/RCT-1.1 explanation, its own print line, and the same `[skip-reason:review:deferred:...]` + `[silent]` tail.
- The release call is written out twice (1457-1460 and 1489-1491); the record is fetched twice (1743-1749 and 1836-1837).
- `GET /agents/$SHIPWRIGHT_AGENT_ID/config` is called three times: policy (Step 1, 77), the subagent type (Step 4, 235) and `repos[0]` (Step 14, 1617), each with its own fail-soft rule.

### What merges into one shared "resolve, dedup, claim" section

| Shared piece | Currently | Merged form |
|---|---|---|
| Config fetch | Step 1 (72-100), Step 4 RVM-1.2 (225-244), Step 14 bare-number inference (1615-1621) | One `GET /agents/:id/config` kept as a variable; read `autoPostReviews`, `allowSelfReview`, `minConfidence`, `maxFindings`, `phaseMethodology.review`, `repos[0]` from it; defaults stated once |
| PR identity | 164-168, 256-260, 1680-1687 | Capture `headRefOid`, `PR_AUTHOR`, `PR_TITLE`, `PR_HEAD_REF` once, in the Live-Review Pre-Check's response (it already fetches all of them) |
| Settle-and-stop block | 550-580, 1722-1805, 1896-1926 | One block: PATCH `{reviewState: posted, reviewedCommitSha: headRefOid, reviewedAt: now}`, print, emit the namespaced `[skip-reason:review:deferred:{reason}:{pr}]`, `[silent]`, stop. Callers supply only `{reason}` (`unresolved-human-feedback` or `already-reviewed-at-head`) and the print line. Stays the single atomic PATCH (no separate release) per `dca470d37` |
| Claim | 149-188, 1810-1831, 1861-1873 | One claim call with the single body; entered from three places: fast path (marker matches live head: no call), self-claim (no record or head moved), staged-refresh (record `staged: true` and head moved). 409 handling stated once (remove worktree, `[silent]`, stop) |
| Record lookup | 1743-1749, 1833-1838 | One lookup by repo+prNumber (or `PRECLAIM_RECORD_ID`); reuse for the terminal write-back, the staged check and the dedup check |
| Release | 1457-1460, 1489-1491 | One "release the claim" line used by both the stale-head abort and the post-failure path |
| Ledger POST | 421-427, 436-442, 785-795, 1509-1514 | One defined form `POST /prs/{id}/findings {ref, disposition, source: "review", evidence}`, built with `jq -n --arg` (also fixes the interpolation risk the Step 7 text already warns about at 799-803), non-fatal; four call sites state only their `ref`, `disposition` and `evidence` |
| Task-store curl boilerplate | about 24 occurrences of the Bearer + JSON headers | One sentence: all task-store calls use `curl -sf` with `Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN` and `Content-Type: application/json`; bodies via `jq -n --arg`. A shell function would not survive between Bash calls, so use a sentence, not a helper |

Ordering that must be preserved in the spine: identity, then Live-Review Pre-Check (before any claim), then fast path / record fetch / staged check / dedup, then claim, then worktree, then model tier and subagent type, then context. Within context, the Unresolved Comment Check runs after the ledger fetch and before the heartbeat. After the subagent: merge/verify, thresholds, `CURRENT_PASS_HAS_BLOCKING_FINDINGS`, write file, 9.5, verdict, 10.5, post, ledger writes, 11b.

### What stays separate

- Live-Review Pre-Check versus Step 5.5's GraphQL: different timing (before claim vs after checkout), different fields (the pre-check needs `comments(last: 50)` to match `check-review.ts`'s `fetchPrReviews`; Step 5.5 needs threads, `__typename`, `commits.pushedDate`). Reusing one response would let the head move between them; they stay separate. A script (see above) is the way to shrink them, not merging them.
- The staged-record branch keeps its own two outcomes (current: print and stop; stale: re-claim and continue), but only its two lines, not a copy of the claim.

## Size budget

Spine: `plugins/shipwright/commands/review-lean.md`, hard limit 150 lines counted with `wc -l` (blank lines and headings included). References live under `plugins/shipwright/commands/references/review-lean/` (new). Existing shared references (`references/post-review-guide.md` 149 lines, `references/dependency-risk-analysis.md` 94 lines, `references/methodology-contracts/review.md`) are reused unchanged and not counted. The budgets are targets, not measurements.

### Spine allocation (148)

| Block | Source (lines) | Lines |
|---|---|---|
| Frontmatter, scope, state-store note, task-store note, no-argument `[silent]` | 1-26, 48-51 | 6 |
| Arguments, `[preclaim:...]` parse, `bun` preflight, `WORKSPACE_ROOT`, curl convention, cwd rule | 28-47, 57-70 | 8 |
| Config fetch (policy, subagent type, repos), defaults, policy summary line, canonical identity script | 72-131 | 8 |
| Live-Review Pre-Check (query, `terminal` rule, fresh-comment exception) | 1623-1808 | 12 |
| Pre-claim fast path, record lookup, staged branch, already-reviewed-at-head dedup | 1810-1932 | 8 |
| Shared settle-and-stop block | 550-580, 1722-1805, 1896-1926 | 5 |
| Single claim call, 409 handling, worktree add | 134-188 | 7 |
| Linked-task model tier | 190-223 | 4 |
| Context: metadata, diff against `origin/$base` plus file-count sanity check, CI, GraphQL state (compressed), ledger fetch, CLAUDE.md, test-readiness | 248-372, 471-473 | 14 |
| Prior qualifying reviews and ledger POSTs (resolved / superseded), ordering rule | 373-469 | 6 |
| Unresolved Comment Check | 479-580 | 6 |
| Heartbeat | 582-590 | 2 |
| Dependency-manifest detection (5.8) | 594-676 | 5 |
| Classification pointer plus risk signals (6, 6.1) | 680-710 | 5 |
| Step 7: dispatch, inputs pointer, failure chain, multi-reviewer trigger and four rules, attestation POST, rating | 714-948 | 11 |
| Step 8: thresholds, trim, `CURRENT_PASS_HAS_BLOCKING_FINDINGS` | 952-981 | 3 |
| Step 9: write `PR_REVIEW_{pr}.md` (template in reference), re-review append | 985-1117 | 3 |
| Step 9.5: unaddressed-findings gate | 1121-1233 | 5 |
| Step 10 and 10.5: verdict, literal label rule, validation, hard abort | 1237-1432 | 8 |
| Step 11 and 11b: freshness re-check, POST, failure release, PFL-5.2 write, staged PATCH, `/complete` | 1436-1603 | 12 |
| Review Quality Rules (5 retained) | 1936-1958 | 4 |
| Section headings and separators not counted above | n/a | 6 |
| **Total** | | **148** |

This is tight because the two GraphQL queries and the live-review `jq` predicate are literal code that must stay in the spine. If the author cannot fit it, the pressure valve is extracting those into scripts (follow-up), never demoting a guard to a reference.

### Proposed files

| File | Budget (lines) | Contents | Loaded when |
|---|---|---|---|
| `review-lean.md` (spine) | <=150 (target 148) | Every step and every guard above, compressed | Always |
| `step7-dispatch.md` | 70 | Subagent input list (733-768), `priorFindingsStatus[]`/`riskAssessment` output shape, RVM-1.2 override branches | When the subagent response is malformed, or an override is configured |
| `multi-reviewer.md` | 70 | MPS-2.1 list parsing and failure rules, MPS-2.2 duplicate/collapse/`agreement`/merge rules, MPS-2.3 verifier | `REVIEW_SUBAGENT_TYPE` contains a comma |
| `ledger-and-findings.md` | 90 | Full POST bodies for PFL-2.1 (resolved/superseded/attested), PFL-5.2, `priorQualifyingReviews` rules (PVD-1.2), 9.5 exclusion summary, PR #89 ordering note | First ledger write on a PR with prior reviews; 9.5 when `UNADDRESSED_FINDINGS` looks wrong |
| `review-file-template.md` | 90 | Step 6 category definitions (682-693), Step 9 `PR_REVIEW` template and re-review update template | Writing the review file |
| `verdict-folding.md` | 50 | Dependency-risk clause and Risk line/factor table formats (1369-1400), diff-line mapping (1402-1407) | Building `pr_review_{pr}.json` with a dependency analysis, an APPROVE, or inline comments |
| `guards-detail.md` | 90 | UCC reconciler caveat and bot-detection note, RVD-1.2 `isTerminalReviewLabel`/`hasFreshNonAgentComment` mirror notes and CHU-2.4 caveat, `gh api --arg` gotcha, RHR-1.1 rationale | Only when a guard result looks wrong (reading material, never a required step) |
| **Total** | **608** (148 + 460) | | |

Overall: 1960 to about 608 lines (about 69% fewer). Compare patch-lean's 57%: review's extra margin comes from the script-wrapped prose being dropped, not from demoting steps.

### Current accounting (sums to 1960)

| Current block | Lines | Destination |
|---|---|---|
| Preamble and Arguments (1-54) | 54 | Spine (14) |
| Step 1 policy (55-108) | 54 | Spine (config block, 8); essay dropped |
| Step 3 identity (109-133) | 25 | Spine (3, inside the config block) |
| Step 4 checkout and claim (134-189) | 56 | Spine (merged claim, 7) |
| Model tier (190-224) | 35 | Spine (4) |
| Configured subagent (225-247) | 23 | Spine (folded into config fetch) |
| Step 5 items 1-5 and ledger fetch (248-372) | 125 | Spine (14), query compressed |
| Prior qualifying reviews and PFL-2.1 (373-470) | 98 | Spine (6) + `ledger-and-findings.md` |
| Step 5 items 6-7 (471-478) | 8 | Spine (inside the 14 above) |
| Unresolved Comment Check (479-581) | 103 | Spine (6) + `guards-detail.md` |
| Heartbeat (582-593) | 12 | Spine (2) |
| Step 5.8 (594-679) | 86 | Spine (5) + existing `dependency-risk-analysis.md` |
| Step 6 (680-694) | 15 | `review-file-template.md` (pointer in spine) |
| Step 6.1 (695-713) | 19 | Spine (5) |
| Step 7 dispatch (714-775) | 62 | Spine (part of 11) + `step7-dispatch.md` |
| Attestation POST (776-811) | 36 | Spine (merged ledger form) + `ledger-and-findings.md` |
| Failure chain (812-849) | 38 | Spine (3) + `step7-dispatch.md` |
| Multi-reviewer (850-951) | 102 | Spine (4) + `multi-reviewer.md` |
| Step 8 (952-984) | 33 | Spine (3) |
| Step 9 (985-1120) | 136 | Spine (3) + `review-file-template.md` |
| Step 9.5 (1121-1236) | 116 | Spine (5) + `ledger-and-findings.md` |
| Step 10 (1237-1408) | 172 | Spine (6 of the 8) + `verdict-folding.md`; Case table dropped |
| Step 10.5 (1409-1435) | 27 | Spine (2 of the 8) |
| Step 11 (1436-1558) | 123 | Spine (part of 12) + `guards-detail.md` |
| Step 11b (1559-1605) | 47 | Spine (part of 12) |
| Step 14 preamble (1606-1622) | 17 | Spine (inside the merged blocks) |
| Live-Review Pre-Check (1623-1809) | 187 | Spine (12) + `guards-detail.md` |
| Pre-Claim, staged refresh, dedup (1810-1935) | 126 | Spine (8 + the shared settle block) |
| Review Quality Rules (1936-1960) | 25 | Spine (4); 5 rules dropped |
| **Total** | **1960** | |

Because a spine of 148 plus references of 460 is 608, the other 1352 lines are removed. They are made of: duplicated claim/PATCH/ledger bodies collapsed by the merge table, restated script semantics, rationale and incident narrative, and the compression of multi-line code into one-line forms with the same operation. The specific text removed by content, rather than by reformatting, is listed next.

## Dropped text (with rationale)

| Text | Lines (approx) | Rationale |
|---|---|---|
| jq `//` vs `select(. != null)` essay | 87-91 (5) | Reduced to a one-line comment on the command; evidence stays in `c41f32be2` |
| "Always use `origin/$base`" explanation | 268-272 (5) | The rule stays (1 line) plus the sanity check; narrative in `b0b104725` |
| GraphQL extraction exposition ("the `_JSON` variables hold the full connection object ... Used below by ...") | 343-362 (20) | Reduced to "pass whole connection objects (`{nodes: [...]}`) through"; shape is also fixed by the script's own input check |
| PR #89 race timeline | 458-469 (12) | Rule retained as one line; evidence in `345521154` (#2748) |
| "Before this fix, Step 5 ran this decision freehand ..." | 503-505 (3) | History; in `145071f2e` (#3208) |
| "This is the same computation Step 9.5 performs" restatement | 535-538 (4) | Script's unit tests are the spec |
| Watched-path script exposition (`managers`, `package-ecosystem`, universal list) | 621-639 (19) | Duplicates `resolve-dependency-watched-paths.ts` and its tests; the empty-set rule is recorded in `ba5f1cd5a` |
| Step 9.5 exclusion list (kept as a 20-line summary in a reference) and "ledger breaks the deadlock" story | 1170-1210 (41) and 1192-1204 | Duplicates `compute-unaddressed-findings.ts`; story is in `7c4f0e658` and `ddafdc573` |
| Step 10 worked example (Cases 1-3) and 8-row truth table | 1288-1347 (60) | Restates `computeVerdict` and `compute-review-verdict.unit.test.ts`; the one live rule (self-review: `event` COMMENT but label APPROVE) stays in the spine |
| `review-staged` scoping note | 1521-1524 (4) | No action for this command; follow-up is a `review-staged` matter |
| Step 11b `else`/`fi` wrapping instructions | 1567-1575 (9) | Collapsed into a single `[ -n "$PR_RECORD_ID" ]` guard |
| Stale line refs in 11b ("lines 926, 935") | 1587 (1) | Wrong cross-references; no such lines exist in this file |
| Step 3 staged-reviews and "Step 14 parses it" paragraphs | 123-130 (8) | Duplicated by Step 14's own text (1840-1843), which the spine keeps in one line |
| Quality rules that duplicate other steps | 1946-1956 (5 rules) | "Keep it tight" (972), "Never REQUEST_CHANGES" (enforced by the script's `event`), "APPROVE means clean" and "Check for unresolved feedback first" (Step 9.5/10), "Concise approvals" (judgment guidance; code-reviewer's own rules cover it) |
| Repeated skip-reason explanation | 574-578, 1799-1803, 1902-1907 (3 x 5) | Replaced by one statement in the shared settle-and-stop block (all three tails name the same `SKIP_BLOCK_THRESHOLD` reason) |
| Repeated RCT-1.1 "perpetual retrigger" explanation | 543-549, 1758-1764, 1913-1918 (3 x 7) | Same: stated once in the shared block |

No guard in the incident-driven list is dropped. The only item demoted to a reference is the multi-reviewer algorithm, behind a config-value trigger with its four must-run rules still in the spine.

## Risks and follow-ups for the review-lean author

1. `review.content.test.ts` (2956 lines) asserts on exact phrases in `review.md` for most of the guards above (for example the pre-claim marker documentation, Step 5's `reviewState:posted` PATCH and `reviewedAt`, RVD-1.2's GraphQL and jq details, the skip-reason markers). review-lean needs an equivalent that reads the spine plus the references, the way the dev-task tests read `corpusOnly()`; and the existing file must keep passing for `review.md` while both exist.
2. Step order is behavior. The Live-Review Pre-Check must stay ahead of claim and checkout, the ledger POSTs ahead of `/complete`, and the stale-head re-check immediately before the POST. A merged skeleton must not let the model reorder them.
3. Step numbering has gaps (no Step 2, 12 or 13; Step 14 runs first), and cross-references like "Step 5.5", "Step 5.7" point at numbered items inside Step 5. Keep the numbers the content tests and other docs cite, or update them in the same PR.
4. Adherence for review is not yet measurable: `references/required-steps/` only has dev-task (DTA-2.1) and patch (DTA-9.1) tables. Add a review table before trialing; the observable markers are `[skip-reason:review:deferred:...]`, the `Verdict:` label, `/complete`, ledger writes, and the dispatches `agent:shipwright:code-reviewer` and `agent:shipwright:finding-verifier`. Otherwise a lean review could silently skip a guard exactly as dev-task skipped Step 5.
5. Follow-ups that change behavior or add code are deliberately not part of "lean": scripts for the two GraphQL queries and the live-review predicate (`check-live-review.ts`), a `merge-review-responses.ts` for MPS-2.2, folding Step 10 and 10.5 into one script call, and fixing the unassigned `PRIOR_FINDINGS_STATUS_JSON` in `review.md` itself (the lean text must assign it; do not copy the gap). Track them separately.
6. RSK-2.1 (Risk) is three days old at audit time, so there is no adherence baseline for it; do not drop or demote it on evidence that does not exist yet.
