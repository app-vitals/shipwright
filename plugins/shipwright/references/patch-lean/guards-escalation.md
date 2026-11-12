# patch-lean: findings-lane escalation guards (CDH-1.2, RPF-1.3)

Mechanics for `commands/patch-lean.md` Steps 5a.6b and 5a.7. Both run after the 5a.6 claim and before
the 5b dispatch, in that order. The trigger checks and stop rules are in the spine; this file holds
the matching fine print, exact strings and the thread-resolution mutation. Both escalate through
[escalation-pattern.md](../../commands/references/escalation-pattern.md)'s shared PATCH/comment/release
sequence, using `PR_TASK_ID` from Step 2.1 and `PR_RECORD_ID` from the 5a.6 claim, with the
"resolve all unresolved threads" step inserted at that sequence's site-specific hook (step 3, between
the comment and the claim release).

## Shared: resolve all unresolved inline threads

Run for the Thread ID of **every** thread in Step 3a's `reviewThreads.nodes[]` with
`isResolved == false` — not only the matching ones. Step 3a's query has no field linking a thread to
the review that raised it, and leaving any thread unresolved would re-qualify the PR for List A next
cycle and re-fire the same escalation forever. The escalation comment already tells the human
everything was escalated, so there is no silent-dismissal risk. None unresolved → nothing to do.

```bash
SHIPWRIGHT_GH_OWNER={org} gh api graphql -f query='
mutation {
  resolveReviewThread(input: {threadId: "{thread.id}"}) {
    thread { isResolved }
  }
}'
```

## Step 5a.6b: `.claude/**` path escalation (CDH-1.2)

The Claude Code CLI blocks writes under `.claude/**` unconditionally in headless (`-p`) runs, so a fix
subagent can never make such an edit; without this check the PR loops through 5b every cycle
(rooted in app-vitals/shipwright#3366). It fires on the **first** round — a `.claude/**` write is
structurally unfixable, so there is no reason to wait for 5a.7's second round.

Scan every finding contributing to List A membership (unresolved `reviewThreads.nodes[]` and the
qualifying COMMENTED/CHANGES_REQUESTED review bodies):

- **Inline thread finding**: the thread's first comment `path` starts with `.claude/`. This is the
  reliable signal.
- **Review-body fallback** (no inline thread): the body mentions a `.claude/`-rooted path **inside an
  inline code span** (backtick-delimited, contents starting with `.claude/`) **and** that span is in
  the **same sentence** as a remediation verb — `edit`, `update`, `change`, `modify`, `rewrite`,
  `add`, `remove`, `delete`, `fix`, in any inflection (`edits`/`editing`/`edited`, ...). A sentence is
  the text between sentence-ending punctuation *followed by whitespace* (`. `, `! `, `? `) or a line
  break; the dot inside `.claude/` is never a boundary. A bare `.claude/` substring is **not** enough —
  review agents cite `.claude/` files as *context* for ordinary fixes. Genuinely ambiguous → **do not
  match** (a false negative only runs the normal fix; a false positive strands a fixable PR in HITL).

**No match** → print `5a.6b .claude/** check: no match` and continue to 5a.7.

**Match** → do not dispatch this cycle; skip 5a.7 and 5b. Escalate:

- **`{blockedReason}`**: `"structurally unfixable — finding requires a write under .claude/**, which the Claude Code CLI blocks unconditionally — escalated to HITL"`
- **`{comment_body}`**: "This finding requires editing a file under `.claude/**`, which the Claude Code
  CLI blocks unconditionally in automated runs — no automated fix is possible here. Flagging for a
  human to make the change directly instead of looping on a fix attempt that can never succeed."
- **`{temp_file_slug}`**: `claude-dir` (temp file: `/tmp/shipwright-patch-claude-dir-{pr}.txt`)
- **Hook step**: resolve all unresolved inline threads (above), before releasing the 5a.6 claim.

After releasing the claim, print:

```
⏸ PR #{pr} — finding requires a .claude/** write, which the CLI cannot make — escalating to
HITL (task {PR_TASK_ID or "none"}). Skipping fix dispatch for this cycle.
```

Then end the findings lane (continue to Step 6).

## Step 5a.7: second-round escalation (RPF-1.3)

A REJECTed finding gets a rebuttal comment and a `rejected` ledger entry (5c.5), which
`check-review.ts`'s `hasFreshLedgerFinding` (PFL-3.1) treats as new information, re-triggering review.
If the fresh review still raises the same issue, another rebuttal would loop forever — a genuine
human-judgment deadlock.

**Step 1 — cheap timestamp pre-filter.** For each qualifying review (`state == "COMMENTED"` or
`"CHANGES_REQUESTED"`, contributing to List A), look in Step 3a's `comments.nodes` for a comment with
`author.login == PR_AUTHOR` (from Step 2, so an allowlisted PR's real author counts — not a hardcoded
`CURRENT_USER`) and `createdAt` **before** that review's `submittedAt`. These are only **candidates**.

**Anti-pattern:** a reply predating the review is not sufficient by itself to classify a second round
or to escalate — a timestamp alone never escalates (RPF-1.5 rewrote this step after an unrelated
earlier rebuttal caused a false escalation that recurred when the HITL flag was cleared).

**Step 2 — content-correlation judgment, printed for each candidate:**

```
Candidate reply ({createdAt}): "{reply body, or a representative excerpt}"
Current finding ({review submittedAt}): "{finding text, or a representative excerpt}"
Judgment: SAME_FINDING | DIFFERENT_FINDING
Justification: {one or two sentences — what specifically makes this the same issue
  recurring, or a different issue that happens to share a timestamp ordering}
```

"Current finding's text": the qualifying review's `body` for a review-body finding; for an inline
thread finding prefer the thread's anchor — first comment's `path` and `line`, plus `body` — over
freeform prose matching. If the candidate is itself a reply in that thread, correlate on `path`/`line`
first and text second. `SAME_FINDING` = a rebuttal of the same issue the reviewer is raising again
after reading it. `DIFFERENT_FINDING` = unrelated content that merely predates the review.

No candidates → print `5a.7 second-round check: no candidate replies`.

**Any candidate judged `SAME_FINDING`** → skip the rest of Step 5: no dispatch, no new rebuttal, no
`reviewState` reset. Escalate:

- **`{blockedReason}`**: `"second-round disagreement between reviewer and automated fix — escalated to HITL"`
- **`{comment_body}`**: "This finding was already rebutted once and the review still disagrees after
  re-evaluating that rebuttal — this looks like a genuine disagreement between the reviewer and the
  automated fix, not something another automated pass will resolve. Flagging for a human decision
  instead of rebutting again."
- **`{temp_file_slug}`**: `escalation` (temp file: `/tmp/shipwright-patch-escalation-{pr}.txt` — not
  `blocked-5a7`, since it fires before dispatch rather than after a BLOCKED report)
- **Hook step**: resolve all unresolved inline threads (above), before releasing the 5a.6 claim.

After releasing the claim, print:

```
⏸ PR #{pr} — second-round disagreement detected, escalating to HITL (task {PR_TASK_ID or "none"}). Skipping rebuttal/reset for this cycle.
```

Then end the findings lane (continue to Step 6).

**Otherwise** (no candidates, or every candidate `DIFFERENT_FINDING`): a first-round finding —
proceed to 5b. RPF-1.1/1.2 behavior applies as before.

## Related: lane-6 escalation check

Step 6b.6 (CFE-1.1) reads the `blocked` state these escalations leave behind, so the CI lane does not
dispatch against a recorded HITL decision. Its mechanics are in [guards-ci.md](guards-ci.md).
