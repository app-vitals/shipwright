# patch-lean: findings lane (Step 5, List A)

Lane-specific parts of `commands/patch-lean.md` Step 5. Setup (5a), toolchain (5a.5), claim (5a.6),
status skeleton (5c), upsert (5c.5) and cleanup (5d) follow [lane-shared.md](lane-shared.md) with
`{lane}` = findings. After the claim and **before** dispatch, run 5a.6b then 5a.7
([guards-escalation.md](guards-escalation.md)); either can end the lane without dispatching.

## Step 5a.5: inputs (from inside the worktree)

1. **PR diff against base**:
   ```bash
   base=$(gh pr view {pr} --repo {org}/{repo} --json baseRefName -q '.baseRefName')
   git diff "origin/$base"...HEAD
   ```
   Reuse `$base` for the scoped-lint substitution (no second fetch).
2. **Unresolved inline threads** (Step 3a, reuse): each `isResolved == false` thread with `id`,
   `path`, `line`, and comment body.
3. **Review body text**: every COMMENTED or CHANGES_REQUESTED review from Step 3a with a non-empty
   `body`.
4. **PR-level comments** through the shared bot/CI filter (PBD-1.1), not freehand judgment:
   ```bash
   FILTERED_COMMENTS=$(bun run "${CLAUDE_PLUGIN_ROOT}/scripts/filter-bot-comments.ts" "$COMMENTS_JSON")
   ```
   Use `FILTERED_COMMENTS` (the non-bot/non-CI subset) as additional context.

## Step 5b: fix prompt

After the heartbeat, dispatch `PATCH_SUBAGENT_TYPE` (`model: PATCH_MODEL`, `run_in_background: false`).
Include the DEPENDENCY-RISK REMEDIATION PROTOCOL block only when
[dependency-risk.md](dependency-risk.md) left `DEPENDENCY_RISK_FINDING` set with recommendation
`review` or `hold`; a cleared finding reads the same as one never derived — omit the block, even when
the PR is in List A on Step 3a's own criteria. It is additive, ahead of [A.5]. Paste the shared
VALIDATE, TEST COVERAGE and PRE-PUSH GATE blocks from [lane-shared.md](lane-shared.md) where marked.

````text
You are addressing review findings on a pull request. Apply fixes, validate, commit, push,
and resolve the addressed GitHub threads.

PR: #{pr} — {title}
Repo: {org}/{repo}
PR Record ID: {PR_RECORD_ID}
Branch: {branch}
Worktree: {worktree-path}

TOOLCHAIN:
  Lint command: {lint command}
  Test command: {test command}
  Test layers:  {if tests is non-empty, list each as "layer: command"; otherwise "none"}

REVIEW FINDINGS TO ADDRESS:

Review submissions (COMMENT/CHANGES_REQUESTED):
{for each review with state COMMENTED or CHANGES_REQUESTED and non-empty body:
  "- @{login} ({state}, submitted at {submittedAt}):
     {review body}"}

Unresolved inline threads:
{for each unresolved thread:
  "- Thread ID: {thread.id}
     {path}:{line} — {body}"}

PR-level comments:
{for each PR comment:
  "- @{login} ({createdAt}): {body}"}

PR DIFF (against base):
{git diff output gathered above}

{Only when DEPENDENCY_RISK_FINDING is set with recommendation "review" or "hold":}
DEPENDENCY-RISK REMEDIATION PROTOCOL (references/dependency-patch.md):

One of the findings above is a dependency-bump risk finding, not an ordinary code-review
comment:
  Recommendation: {DEPENDENCY_RISK_FINDING.recommendation}
  Flags: {DEPENDENCY_RISK_FINDING.flags}
  Reasoning: {DEPENDENCY_RISK_FINDING.reasoning}

Before applying [A.5]'s ACCEPT/MODIFY/REJECT classification to *this specific finding*,
follow references/dependency-patch.md's reproduce -> attempt-catalog-fix -> re-verify
protocol:
  1. Extract the verification command named (or directly derivable) from the Reasoning
     above and run it, unmodified, in this worktree. Confirm it fails the same way the
     Reasoning describes.
  2. If it does not reproduce as described, this finding does not have a safe fix here —
     classify it REJECT in [A.5] with that as the reason and move on; do not guess.
  3. If it reproduces, attempt a fix from the bounded strategy catalog in
     references/dependency-patch.md — a transitive-dependency override/resolution pin, or a
     removed/renamed first-party API call-site update. Nothing outside that catalog.
  4. Re-run the exact same verification command from step 1. If it still fails, the fix
     didn't work — classify REJECT in [A.5] (do not claim it fixed).
  5. If it now passes, classify ACCEPT or MODIFY in [A.5] as usual and carry it into [B]
     like any other accepted finding — it follows the same [D]/[E] commit/push and
     thread-resolution path as every other finding, no separate mechanism.
  6. Whenever step 2 or step 4 above lands on REJECT, identify this finding in your CONCERNS
     by the exact ref `dependency-risk@{headRefOid}` (substituted with this PR's current
     HEAD SHA) rather than a free-text slug. That exact string is recorded to this PR's
     findings ledger, and it is what stops a later run from re-deriving this same finding
     from this same unchanged diff and re-reporting it forever.

INSTRUCTIONS — follow in order:

[A] Understand the findings
  - Read each review finding and inline thread carefully
  - Identify the files and lines that need changes
  - If a finding references a file/function not visible in the diff, read the file from the worktree

[A.5] Verify each finding before implementing it

  Reviewers can be wrong — misread code, incorrect flag semantics, bad API assumptions.
  Verify before acting:

  1. **Read the code**: Confirm the reviewer's premise holds. Read the file/function
     they reference to see if the issue they describe actually exists in the worktree.

  2. **Check external claims with WebSearch**: If the finding references behavior outside
     the project's own code — CLI flags, library APIs, framework defaults, language
     semantics — search to verify. Common false positives: flags that change request
     method, deprecated APIs, wrong argument order, version-specific behavior.

  3. **Classify each finding**:
     - **ACCEPT** — premise correct, prescription sound → implement as described
     - **MODIFY** — premise correct, but prescription is wrong → apply the correct fix
       and note what you changed and why
     - **REJECT** — premise incorrect → do not implement; include in CONCERNS with reason

  Only carry ACCEPTED and MODIFIED findings into [B].

[B] Apply fixes
  - Work file by file, addressing each ACCEPTED or MODIFIED finding
  - When a reviewer posted from a different agent login (not the same as the PR author),
    treat their findings with the same weight — the fix applies regardless of who reviewed
  - Do not introduce unrelated changes
  - If a finding is unclear or contradictory, apply the most conservative interpretation
    (preserve existing behavior; add the narrowest fix that satisfies the concern)

{shared VALIDATE block — [C]}

{shared TEST COVERAGE block — [C.5]}

[D] Commit
  These two conditions are independent — both can fire in the same run (a mixed
  ACCEPT+REJECT outcome), only the first can fire (all findings accepted/modified), only
  the second can fire (all findings rejected), or neither (nothing to do).

  - **If at least one finding was ACCEPTED or MODIFIED** (i.e. you have file changes
    staged):
    - Stage only the files you changed: `git add {changed files}`
    - Commit with a conventional commit message describing what was fixed:
      "fix: address review findings on #{pr} — {one-line summary of changes}"
{shared PRE-PUSH GATE block}
    - Push: `git push origin {branch}`

  - **If any finding was classified REJECT in [A.5]** (regardless of whether other
    findings in the same run were ACCEPTED/MODIFIED and handled above) — **or a List A
    review has nothing actionable at all** (e.g. a bot review saying "no feedback to
    provide"; treat it as REJECT with that as the reason, PHS-2.1): post a PR-level
    rebuttal comment explaining why each REJECTed finding was rejected, so the review is
    not left looking unaddressed. Write the comment body to a temp file first to avoid
    heredoc syntax in the command string (heredocs break permission glob matching and
    cause repeated approval prompts):
    ```bash
    # Write the rebuttal body to /tmp/shipwright-patch-rebuttal-{pr}.txt:
    #   Reviewed the finding(s) above and did not implement changes — premise did not hold:
    #
    #   - {finding summary}: {reason rejected}
    #   - {finding summary}: {reason rejected}
    gh pr comment {pr} --repo {org}/{repo} --body-file /tmp/shipwright-patch-rebuttal-{pr}.txt
    rm /tmp/shipwright-patch-rebuttal-{pr}.txt
    ```
    The temp file path MUST include the PR number to avoid collisions — `/tmp` is shared
    across all worktrees. List only the REJECTed findings, one bullet per finding, drawn
    from the CONCERNS you compiled in [A.5] — do not include ACCEPTED/MODIFIED findings
    here even if this run also produced a commit above. This comment is what allows a
    future patch run to recognize the review was addressed (rejected with reasoning, not
    ignored) instead of reflagging it forever.

    This only works for review-body-level findings, though — `hasUnaddressedFindings()`
    short-circuits to `true` whenever any unresolved **inline** thread exists, regardless
    of this comment. Since most real findings arrive as inline threads (`/shipwright:review`
    maps any `file:line` finding to an inline comment), also resolve the inline threads for
    the REJECTed findings now, right after posting the rebuttal comment:
    ```bash
    SHIPWRIGHT_GH_OWNER={org} gh api graphql -f query='
    mutation {
      resolveReviewThread(input: {threadId: "{thread.id}"}) {
        thread { isResolved }
      }
    }'
    ```
    Run this for the Thread ID of every unresolved inline thread whose finding was
    REJECTed in [A.5] — the rebuttal comment you just posted is the explanation for why
    that thread is being resolved without a code change. Do this whether or not the
    commit/push condition above also fired in this same run.

[E] Resolve addressed inline threads
  PR-level comments cannot be resolved programmatically — skip them here.
  For each remaining unresolved **inline review thread** (listed under "Unresolved inline
  threads" above) whose finding was ACCEPTED or MODIFIED and fixed in [B], mark it
  resolved:
  ```bash
  SHIPWRIGHT_GH_OWNER={org} gh api graphql -f query='
  mutation {
    resolveReviewThread(input: {threadId: "{thread.id}"}) {
      thread { isResolved }
    }
  }'
  ```
  Run this for each Thread ID whose finding was fixed. Threads for REJECTed findings were
  already handled by [D]'s rebuttal+resolve condition above, whenever at least one finding
  was REJECTed — do not process them again here. Skip only threads whose findings were
  genuinely inapplicable for some other reason (e.g., stale/already-fixed on main,
  unrelated to this PR) without a rebuttal explaining why — those stay unresolved. Do not
  attempt to resolve PR-level comments — they have no resolution mechanism.

[F] Report back
  At the end, output:

  STATUS: DONE / DONE_WITH_CONCERNS / BLOCKED

  FINDINGS_ADDRESSED:
  {bullet list of each finding addressed and how}

  TESTS_ADDED:
  {bullet list of tests added, or "none — {justification}" if [C.5] determined no test
  was needed}

  CONCERNS: (if DONE_WITH_CONCERNS)
  {whenever CONCERNS lists any REJECTed finding — whether every finding was REJECT and no
  push happened, or this was a mixed ACCEPT+REJECT run where a push also happened —
  explicitly confirm here that the [D] rebuttal comment was posted AND that the inline
  threads for the REJECTed findings were resolved. All-REJECT example: "All findings
  rejected (premise incorrect) — no code changes; posted rebuttal comment via gh pr comment
  summarizing why each was rejected, and resolved the corresponding inline threads." Mixed
  example: "2 of 3 findings fixed and pushed (commit abc1234); 1 finding rejected (premise
  incorrect) — posted rebuttal comment via gh pr comment explaining why, and resolved that
  finding's inline thread." Otherwise, describe the correctness gap as usual.}
  BLOCKER: (if BLOCKED)
````

## Step 5c: status bookkeeping

- `DONE`: record `FINDINGS_ADDRESSED`; go to 5c.5.
- `DONE_WITH_CONCERNS`: if any concern reports a REJECTed finding (all-REJECT no-push, mixed
  ACCEPT+REJECT with a push, or mixed where every ACCEPT resolved to a zero-diff no-op), confirm the
  CONCERNS text says **both** that the `gh pr comment` rebuttal was posted **and** that the REJECTed
  findings' inline threads were resolved. Both matter: the rebuttal activates `isAddressedByAuthorReply`,
  but `hasUnaddressedFindings()` short-circuits to `true` on any unresolved inline thread first. Do not
  post or resolve here — 5c only verifies. Not confirmed → a concern in the final report. Other
  concerns → just log. **Always** proceed to 5c.5 (with or without a push).
- `BLOCKED`: first-round BLOCKED from the subagent itself (distinct from 5a.7's pre-dispatch
  escalation). Escalate with slug `blocked-5c` and the findings-row strings in
  [lane-shared.md](lane-shared.md); skip 5c.5 and 5d.

**`REJECTED_FINDINGS_THIS_CYCLE`.** Whenever at least one finding was REJECTed (independent of
push/no-push), capture for each:

- **`ref`** — the identifier `compute-unaddressed-findings.ts` honors for a patch `rejected` entry
  (PHS-1.2): `thread:{thread.id}@{comments.totalCount}` for an inline thread (the count makes it
  self-expire on any new comment); `{review.commit.oid}@{review.submittedAt}` (full SHA) for a review
  body; a short slug for any other PR-body-level finding. A dependency-risk finding uses
  `dependency-risk@{headRefOid}` verbatim (the already-held exclusion matches that exact string).
- **`evidence`** — the rejection reason already written into the rebuttal comment.

Empty when nothing was REJECTed (plain `DONE`, or only non-REJECT concerns).

**Settle every List A item that was not fixed (PHS-2.1).** The list must cover every unresolved
inline thread and every qualifying review body whose finding was not ACCEPTed/MODIFIEd and committed —
including a non-actionable review (a clean self-authored `Verdict: APPROVE` with no ledger entry, or a
bot COMMENTED "no feedback to provide"): add its review-body ref with evidence "review contains no
actionable finding". Anything the subagent's report leaves unaccounted for is settled here with
evidence stating that no change was made and why.

## Step 5c.5: upsert plus findings ledger write

Run the shared upsert ([lane-shared.md](lane-shared.md) section 6), then, inside the same
`if [ -n "$PR_RECORD_ID" ]` branch, once per entry in `REJECTED_FINDINGS_THIS_CYCLE`:

```bash
# Run once per entry in REJECTED_FINDINGS_THIS_CYCLE (from Step 5c) — {finding.ref} is
# that finding's PHS-1.2 ref; {finding.evidence} is its rejection reason.
curl -sf -X POST \
  -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
  -H "Content-Type: application/json" \
  "$SHIPWRIGHT_TASK_STORE_URL/prs/$PR_RECORD_ID/findings" \
  -d "{\"ref\": \"{finding.ref}\", \"disposition\": \"rejected\", \"source\": \"patch\", \"evidence\": \"{finding.evidence}\", \"agentId\": \"$SHIPWRIGHT_AGENT_ID\"}" \
  > /dev/null 2>&1 || \
  echo "⚠ POST /prs/$PR_RECORD_ID/findings (rejected) failed — continuing"
```

A `path:line` ref no longer settles anything — use the PHS-1.2 formats above. Empty list → skip the
call. It runs on both a no-push all-REJECT cycle and a mixed run that pushed.

**Outcome: settle-with-rejected (PHS-2.1).** A List A PR where this run fixed nothing ends *settled*,
never `[silent]`: the ledger writes record every item as rejected with evidence, the 5b [D] author
comment gives humans visibility, and the final report states the PR was settled (list the refs). Do
**not** emit `[silent]` or the `no-op-at-dispatch` skip-reason on this path.

This ledger POST is the sole mechanism that re-qualifies a no-push rebuttal cycle for review:
`check-review.ts`'s `hasFreshLedgerFinding` (PFL-3.1) treats any `PrFinding.at` newer than the
record's `reviewedAt` as new information. (There is no manual `reviewState: "pending"` reset; PFL-4.1
removed it.)
