---
description: Review a specific open PR -- deep single-pass review with inline comments, policy-controlled posting
argument-hint: "org/repo#number"
---

# Review

Evaluate open PRs and post findings. Scope: review only — no patching, merging, or deploying.

PR tracking state — claimed commit SHAs, review state, and staging status — lives in the
task store PR API (`$SHIPWRIGHT_TASK_STORE_URL/prs`). This is shared state across agents:
claims are atomic, so two agents won't review the same commit simultaneously. The review
narrative itself is still written locally to `state/reviews/PR_REVIEW_{pr}.md` and
`state/reviews/pr_review_{pr}.json` for posting.

Dedup is two-layered: the task-store-local atomic claim above prevents two agents *on the
same task-store instance* from racing on the same commit, but it's blind to reviews posted
by an agent running against a *different* task-store instance, or by a human running this
command directly. Step 14's live-GitHub pre-check is the cross-task-store defense layer that
closes that gap — it queries GitHub directly for a terminal review at the current head
commit before any claim or checkout happens, independent of what the local task-store record
says.

> **Task store setup:** This command updates task status in the Shipwright task store after review. If `SHIPWRIGHT_TASK_STORE_URL` or `SHIPWRIGHT_TASK_STORE_TOKEN` is missing, invoke `/shipwright:task-store` for setup instructions.

---

## Arguments

`$ARGUMENTS` is **required** — this command always targets one specific PR. There is no
self-scan/queue-building mode; the caller (loop orchestrator or a human) must name the PR.

Parse `$ARGUMENTS`:
- `org/repo#number` (e.g. `app-vitals/shipwright#123`): target a specific PR. If a staged
  review exists and has gone stale (new commits since staging), refresh it. Otherwise
  review it fresh. This command never posts a staged review — use `/shipwright:review-staged`
  for that.
- `number` or `#number`: same, using the repo from the task store API
- Optional trailing **pre-claim marker** — `[preclaim:{recordId}:{commitSha}]` — appended
  after `org/repo#number`/`number` by the loop orchestrator (`agent/src/loop-orchestrator.ts`'s
  `formatPreClaimMarker`, CBD-1.3) when it already claimed this PR in the task store before
  dispatch, e.g. `app-vitals/shipwright#123 [preclaim:ckz1abc123:8cb7b38cdb6a...]`. When
  present, strip it before parsing `org/repo#number`/`number` above — see Step 14's
  Pre-Claim Fast Path for how the marker is validated against the live head and used to
  skip re-claiming. A human invoking this command directly never supplies this marker; it
  is only ever produced by the orchestrator.

**No arguments**: respond `[silent]` and stop immediately — before any GitHub or task
store query (i.e. before Step 1). This is the expected outcome for a manual invocation
without a target; the loop orchestrator always passes a PR id, so this path is only hit
when a human runs `/shipwright:review` with no argument.

---

## Step 1: Load Policy

Capture the workspace root before Step 4's worktree checkout moves cwd:
```bash
WORKSPACE_ROOT=$(pwd)
```
Steps 9-11 and Step 14 use `$WORKSPACE_ROOT` to reference `state/reviews/` — that directory
only ever exists at the workspace root, never inside a worktree.

Read `state/agent-policy.md`. If the file doesn't exist, use these conservative defaults:

| Setting | Default |
|---------|---------|
| `auto_post_reviews` | true |
| `allowed_events` | [COMMENT, APPROVE] |
| `allow_self_review` | false |
| `min_confidence` | 75 |
| `max_findings` | 5 |

Print a one-line policy summary:
```
Policy: {staging|auto-posting} reviews
```

---

## Step 3: Resolve Current User and Target

Resolve the current GitHub CLI user once and remember the value — substitute it directly
into all subsequent commands that need it:

```bash
gh api /user -q '.login'
```

Staged reviews (`staged: true` records) are entirely out of scope for this command —
listing, walking, and posting them is owned exclusively by `/shipwright:review-staged`.
This command only ever produces or refreshes review content; see Step 14 for the one
exception (refreshing a stale staged review on explicit targeted invocation).

The target PR is `$ARGUMENTS`, already validated as present in the Arguments section
above. Step 14 parses it into `org`/`repo`/`pr`, fetches the PR record, and runs the
dedup check before checkout — see Step 14 for the full targeted flow.

---

## Step 4: Checkout into Worktree

```bash
git -C repos/{repo} fetch origin
git -C repos/{repo} worktree add ${SHIPWRIGHT_WORKTREE_DIR:-$HOME/worktrees}/{repo}-{branch-slug} origin/{branch}
```

Branch slug = branch name with `/` replaced by `-`.

If the worktree already exists (prior interrupted run):
```bash
git -C repos/{repo} worktree remove ${SHIPWRIGHT_WORKTREE_DIR:-$HOME/worktrees}/{repo}-{branch-slug} --force
git -C repos/{repo} worktree add ${SHIPWRIGHT_WORKTREE_DIR:-$HOME/worktrees}/{repo}-{branch-slug} origin/{branch}
```

### Claim using pre-captured commit SHA

**Skip this subsection if `PR_RECORD_ID` was already set by Step 14's Pre-Claim Fast Path**
(CBD-1.4) — the orchestrator's `/prs/claim` call already holds the claim; proceed directly
to Step 5. Otherwise (no valid marker), self-claim as today:

`LAST_REVIEWED_COMMIT` was already captured in Step 14 from the PR record fetched during
the dedup check (empty if no record existed). The claim will overwrite `commitSha` with the
new head — `LAST_REVIEWED_COMMIT` preserves the pre-claim value without an extra fetch.
Use it in Steps 5 and 9.

Then claim the PR atomically at the current head. Fetch the head SHA first:
```bash
headRefOid=$(gh pr view {pr} --repo {org}/{repo} --json headRefOid -q '.headRefOid')
```
```bash
PR_CLAIM=$(curl -s -o /tmp/pr_claim.json -w '%{http_code}' -X POST \
  -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
  -H "Content-Type: application/json" \
  "$SHIPWRIGHT_TASK_STORE_URL/prs/claim" \
  -d "{\"repo\": \"{org}/{repo}\", \"prNumber\": {pr}, \"commitSha\": \"{headRefOid}\"}")
```
- `201` (new) or `200` (update): claimed. Capture `.id` from `/tmp/pr_claim.json` as
  `PR_RECORD_ID`; the claim sets `reviewState: "in_progress"`.
- `409` (conflict): another agent holds the claim at this commit. Remove the worktree
  (`git -C repos/{repo} worktree remove ${SHIPWRIGHT_WORKTREE_DIR:-$HOME/worktrees}/{repo}-{branch-slug} --force 2>/dev/null`),
  respond `[silent]`, and stop — there is no other PR to fall back to in explicit-target mode.

All subsequent steps run from `${SHIPWRIGHT_WORKTREE_DIR:-$HOME/worktrees}/{repo}-{branch-slug}/` — except `state/reviews/`
file operations (Steps 9-11, Step 14's cross-reference), which use `$WORKSPACE_ROOT`
captured in Step 1, since `state/reviews/` only ever exists at the workspace root.

### Resolve the linked task's model tier

Runs once here, regardless of which Step 14 path produced `PR_RECORD_ID` (Pre-Claim Fast
Path or self-claim) — both paths reconverge at this point before Step 5 runs. Best-effort
enrichment only: any failure leaves `TASK_MODEL` unset and prints a one-line warning, never
a hard stop.

Query the task store directly by repo+PR (same shape as `agent/src/check-helpers.ts`'s
`createTaskStatusQuery`) instead of reading `PullRequest.taskId` off the claimed PR record —
that field is populated on only ~10% of PR records (0% in several repos), so the old lookup
silently no-op'd for most PRs. A PR can link more than one task (bundles, confirmed on ~7%
of PR-linked task groups); when more than one task matches, escalate to the **highest**
model tier among all matched tasks' models — `opus` > `sonnet` > `haiku` — mirroring
plan-session.md's "bundle inherits highest tier" rule, not just the first match:

```bash
TASK_MODEL=""
TASKS_RESPONSE=$(curl -sf -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
  "$SHIPWRIGHT_TASK_STORE_URL/tasks?repo={org}/{repo}&pr={pr}") || echo "⚠ failed to fetch linked tasks for model lookup — continuing"
if [ -n "$TASKS_RESPONSE" ]; then
  TASK_MODEL=$(echo "$TASKS_RESPONSE" | jq -r '
    [.tasks[]?.model | select(. != null)] as $models
    | {opus: 3, sonnet: 2, haiku: 1} as $rank
    | ($models | map($rank[.]) | max) as $maxRank
    | if $maxRank == null then empty
      else ($rank | to_entries | map(select(.value == $maxRank)) | .[0].key)
      end
  ')
fi
```

A non-200 (e.g. a 403 when a linked task is assigned to a different agent — task-store
agent tokens are scoped) or zero matching tasks (still the common case today) leaves
`TASK_MODEL` unset; Step 7 falls back to `'sonnet'`, unchanged from before.

---

## Step 5: Gather Context

1. **PR metadata**:
   ```bash
   gh pr view {pr} --repo {org}/{repo} \
     --json number,title,author,headRefName,baseRefName,headRefOid,additions,deletions,changedFiles,body
   ```

   Capture the PR's author login from this response as `PR_AUTHOR` — used by both Step 9.5
   (as `prAuthor`, RAS-1.1) and Step 10 (to derive `selfReview`):
   ```bash
   PR_AUTHOR={the .author.login from the metadata above}
   ```

2. **Diff against the correct base branch** (not always main):
   ```bash
   base=$(gh pr view {pr} --repo {org}/{repo} --json baseRefName -q '.baseRefName')
   git diff "origin/$base"...HEAD
   ```

   **Always use `origin/$base`, not bare `$base`.** The worktree is created from a
   remote-tracking ref (`origin/{branch}`) and Step 4 runs `fetch origin`, so
   `origin/main` is always fresh. But the local `main` branch is never updated — it
   can be hundreds of commits behind, producing a diff that includes unrelated changes
   from other merged PRs.

3. **Changed files**: extract from the diff

   **Sanity check**: compare the number of files in the diff against the PR metadata's
   `changedFiles` count. If the diff contains significantly more files (e.g. 2x+), the
   merge-base is likely wrong — the diff is picking up commits from other merged PRs.
   Stop and diagnose: verify `origin/$base` resolves to the expected commit, check
   whether `git merge-base origin/$base HEAD` matches what GitHub shows, and re-run
   `git fetch origin` if needed. Do not proceed with a review based on a wrong diff.

4. **CI status** via Actions API (not `gh pr checks` -- broken with PATs):
   ```bash
   gh api "repos/{org}/{repo}/actions/runs?branch={branch}&per_page=5" \
     -q '.workflow_runs[] | "\(.name): \(.status) \(.conclusion)"'
   ```

5. **Existing reviews, comments, and inline review threads** — a single GraphQL call,
   reusing the same query `/shipwright:patch`'s Step 3a issues (`### Step 3a: Check for
   Unaddressed Review Findings` in `commands/patch.md`), so this command sees the same
   inline-thread resolution state patch.md's unaddressed-findings check does, rather than
   the REST `gh pr view --json comments,reviews` call (issue-level comments and top-level
   review objects only — blind to inline diff-line review comments and their `isResolved`
   state):
   ```bash
   RESPONSE=$(gh api graphql -f query='
   {
     repository(owner: "{org}", name: "{repo}") {
       pullRequest(number: {pr}) {
         headRefOid
         reviews(first: 50) {
           nodes {
             author { login }
             state
             submittedAt
             commit { oid }
             body
           }
         }
         reviewThreads(first: 100) {
           nodes {
             id
             isResolved
             comments(first: 20) {
               nodes {
                 author { login }
                 body
                 path
                 line
                 createdAt
               }
             }
           }
         }
         comments(first: 50) {
           nodes {
             author { login }
             body
             createdAt
           }
         }
         commits(last: 1) {
           nodes {
             commit { pushedDate }
           }
         }
       }
     }
   }')
   ```
   Extract `HEAD_REF_OID`, `REVIEWS_JSON`, `REVIEW_THREADS_JSON`, `COMMENTS_JSON`, and
   `LAST_PUSH_DATE` from the response — each of the three `_JSON` variables holds the
   **full connection object** (`{ nodes: [...] }`), not the bare inner array, since Step 9.5
   passes them straight through to `compute-unaddressed-findings.ts`, which requires that shape:
   ```bash
   HEAD_REF_OID=$(jq -r '.data.repository.pullRequest.headRefOid' <<< "$RESPONSE")
   REVIEWS_JSON=$(jq -c '.data.repository.pullRequest.reviews' <<< "$RESPONSE")
   REVIEW_THREADS_JSON=$(jq -c '.data.repository.pullRequest.reviewThreads' <<< "$RESPONSE")
   COMMENTS_JSON=$(jq -c '.data.repository.pullRequest.comments' <<< "$RESPONSE")
   LAST_PUSH_DATE=$(jq -r '.data.repository.pullRequest.commits.nodes[0].commit.pushedDate' <<< "$RESPONSE")
   ```
   `REVIEWS_JSON.nodes[]` holds each review (including `commit.oid`, needed by Step 9.5's
   mechanical gate below to filter reviews at the current `headRefOid`),
   `REVIEW_THREADS_JSON.nodes[]` holds each thread (with `isResolved` and up to 20 comments per
   thread — `author.login`, `body`, `path`, `line`, and `createdAt` for each, not just the first
   comment; `createdAt` is what Step 9.5's `isThreadAddressedByAuthorReply` exclusion (URT-1.1)
   needs to detect a PR-author reply posted after a thread's first, flagging comment),
   `COMMENTS_JSON.nodes[]` holds each comment — the same shape patch.md's Step 3a extracts, and
   `LAST_PUSH_DATE` is the ISO-8601 `pushedDate` of the most recent commit at the current head.
   Used below by the Unresolved Comment Check and by the unaddressed-findings gate before Step 10.

   #### Prior Qualifying Reviews for Subagent Attestation (PVD-1.2)

   From the same `reviews.nodes[]` fetched above, separately identify **prior qualifying
   CURRENT_USER reviews** — reviews this agent posted on an earlier commit of this PR whose
   findings the subagent should be asked to re-verify in Step 7. A review is a prior
   qualifying review when ALL of the following hold:
   - `state === "COMMENTED"` or `state === "CHANGES_REQUESTED"`
   - `body` is non-empty
   - `author.login === CURRENT_USER` (resolved in Step 3)
   - `commit.oid !== headRefOid` (posted at a commit earlier than the current head — this is
     the "prior" distinction from Step 9.5's own `commit.oid === headRefOid` filter, which
     only looks at reviews **at** head; this collection deliberately looks at reviews
     **before** head)
   - NOT excluded by `isSelfCleanApprove` (a clean self-APPROVE) or by
     `isSupersededBySelfReview` (DRO-1.2 — an earlier self-review superseded by a later,
     genuinely clean self-review) — reuse these two functions exactly as exported from
     `compute-unaddressed-findings.ts` (PVD-1.1), the same module Step 9.5 below invokes as
     its single source of truth, rather than re-deriving their rules in prose here. This
     collection intentionally does **not** apply Step 9.5's other two conditions
     (unresolved-thread branching, `isAddressedByAuthorReply`) — those are specific to Step
     9.5's "unaddressed findings" definition; this collection surfaces prior reviews
     regardless of whether they've since been resolved, so the subagent can make its own
     resolved/not-resolved determination for each one.

   Call the result `priorQualifyingReviews` — a list of `{ ref, body }` pairs, where `ref` is
   built via `compute-unaddressed-findings.ts`'s exported `reviewRef(review)` helper: the
   review's FULL, untruncated `commit.oid` plus `submittedAt`, joined by `@`
   (`${review.commit.oid}@${review.submittedAt}`) — never a truncated/short SHA, since the
   GraphQL query above does not fetch a review `id`/`url` field and the findings-ledger
   exclusion (`isResolvedByLedger`, PFL-3.2) later does an exact string match against this
   exact format when matching a ledger entry's `ref` back to a specific prior review. When
   `priorQualifyingReviews` is empty (no prior reviews, or all excluded by the two reused
   exclusions above — e.g. a self-authored PR whose only prior reviews were clean self-approves
   or superseded self-reviews), the field is simply empty and Step 7 omits the corresponding
   prompt input entirely (see Step 7).

   #### Findings Ledger Persistence — Self-Review Judgments (PFL-2.1)

   The two exclusions just applied above (`isSelfCleanApprove`, `isSupersededBySelfReview`) are
   real judgments — a review is being decided as resolved or superseded right now, in order to
   exclude it from `priorQualifyingReviews`. This subsection makes that judgment durable by
   persisting it to the findings ledger (`POST /prs/:id/findings`, PFL-1.2). **This does not
   change what was just decided above** — it is purely additive logging of a decision already
   made; `priorQualifyingReviews` itself is unaffected by whether these POSTs succeed.

   For every CURRENT_USER review considered above (`author.login === CURRENT_USER`,
   `commit.oid !== headRefOid`) that was excluded from `priorQualifyingReviews` because
   `isSelfCleanApprove(review, CURRENT_USER)` is true, POST a `resolved` ledger entry:
   ```bash
   curl -sf -X POST \
     -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
     -H "Content-Type: application/json" \
     "$SHIPWRIGHT_TASK_STORE_URL/prs/${PR_RECORD_ID}/findings" \
     -d '{"ref": "{reviewRef(review)}", "disposition": "resolved", "source": "review", "evidence": "Self-review is a clean APPROVE with no blocking findings."}' \
     >/dev/null 2>&1 || echo "⚠ ledger POST failed for {reviewRef(review)} — continuing (non-fatal)"
   ```
   `ref` is `reviewRef(review)` (the same full-`commit.oid`+`submittedAt` format used
   throughout this step); `evidence` is a short description of the clean-APPROVE judgment, not
   freehand — it need not restate the review body.

   For every CURRENT_USER review considered above that was instead excluded because
   `isSupersededBySelfReview(review, allReviews, CURRENT_USER)` is true, POST a `superseded`
   ledger entry:
   ```bash
   curl -sf -X POST \
     -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
     -H "Content-Type: application/json" \
     "$SHIPWRIGHT_TASK_STORE_URL/prs/${PR_RECORD_ID}/findings" \
     -d '{"ref": "{reviewRef(review)}", "disposition": "superseded", "source": "review", "evidence": "Superseded by a later clean self-review submitted at {laterReview.submittedAt}."}' \
     >/dev/null 2>&1 || echo "⚠ ledger POST failed for {reviewRef(review)} — continuing (non-fatal)"
   ```
   `{laterReview.submittedAt}` is the `submittedAt` of the later, genuinely-clean self-review
   that `isSupersededBySelfReview` matched — cite it so the ledger entry's evidence is
   self-contained.

   **Best-effort content, but strictly ordered before Step 11b.** These POSTs persist judgments
   `isSelfCleanApprove` and `isSupersededBySelfReview` already computed above — they do not gate,
   delay, or alter `priorQualifyingReviews`, Step 7's subagent dispatch, or any other step's
   *decision*. A failed POST (non-2xx, timeout, or any other curl error) is still non-fatal: log
   the warning shown above and continue — the review pipeline must never block on a ledger write
   *failing*. But issuing the POST at all is not optional busywork to tack on whenever convenient:
   every findings-ledger POST for this pass — including the ones above — **must complete before
   Step 11b's `/prs/:id/complete` call** runs later in this same pass. Never defer them to "near
   the end of the turn" after Step 11b has already run.

   **Why this ordering matters (PR #89 race).** On PR #89, Step 11b's `/complete`
   call landed at `2026-08-21T04:10:53.901Z` and stamped `reviewedAt=2026-08-21T04:10:53.897Z`.
   Two `disposition: resolved, source: review` findings from this same PFL-2.1 section, from the
   very same review pass, were POSTed ~13 seconds later — at `2026-08-21T04:11:06.780Z` and
   `2026-08-21T04:11:06.820Z` — because the executing agent ran Step 11b first and only tacked the
   ledger POSTs on near the end of its turn. Since both findings postdated `reviewedAt`,
   `agent/src/check-review.ts`'s `hasFreshLedgerFinding` (PFL-3.1) saw them as new information and
   bypassed the already-reviewed-live exclusion, causing a spurious re-claim of the PR at
   `2026-08-21T04:12:45.114Z` on the very next loop tick. `hasFreshLedgerFinding`'s rule — a
   finding timestamped after `reviewedAt` means new information since the last pass — is correct;
   this ordering requirement is what makes `reviewedAt` a reliable "last write of the pass" marker
   instead of a false one.

6. **CLAUDE.md files**: read root CLAUDE.md + CLAUDE.md files in directories containing changed files

7. **Test-readiness context** (optional): try to read `${SHIPWRIGHT_WORKTREE_DIR:-$HOME/worktrees}/{repo}-{branch-slug}/docs/test-readiness/test-system.md`. If absent, note that no repo-specific test-readiness doc exists. When the changed files include any path that looks like a test file — by common conventions across languages (e.g. files named or located in a way that signals they contain tests, such as files in `test/`, `tests/`, `spec/`, or `__tests__/` directories, or files whose names follow typical test-naming conventions for the project's language), also extract the "## Testing" section from the root CLAUDE.md (if present). Use the project's language and toolchain (visible from the diff and CLAUDE.md) to recognise test files — do not apply a fixed set of glob patterns. Combine both pieces into `testReadinessContext`. If neither produces content, `testReadinessContext` is absent — omit it entirely from the subagent prompt.

`lastReviewedCommit` is the `LAST_REVIEWED_COMMIT` value saved from the pre-claim record in
Step 14 (the record's `reviewedCommitSha`, captured before the claim call — which only
overwrites the separate `commitSha` lock field).

#### Unresolved Comment Check

Before writing the review, check whether a human is already mid-conversation on this PR and
hasn't pushed since — don't talk over them.

**If `lastReviewedCommit` is set AND `headRefOid != lastReviewedCommit`: skip this check
entirely and continue — head has moved, re-review unconditionally.** New commits from the
author unconditionally override all unresolved thread skip conditions. Only run the check
below for first reviews (no `lastReviewedCommit`) or when the head has not moved
(`headRefOid == lastReviewedCommit`).

**This is computed mechanically, not freehand.** `compute-unresolved-comment-check.ts`
(UCC-1.1) is the single exported, tested implementation of this decision, mirroring
`compute-review-verdict.ts`'s (DRO-1.1) and `compute-unaddressed-findings.ts`'s (PVD-1.1) CLI
pattern. It reuses `compute-unaddressed-findings.ts`'s exported
`isAddressedByAuthorReply`/`isThreadAddressedByAuthorReply` helpers (CPF-2.3/URT-1.1) — so a
`CHANGES_REQUESTED` review, a substantive top-level comment, or an unresolved inline thread
that the PR author has already replied to and addressed does not count as substantive
unresolved feedback, the same exclusion Step 9.5's hard gate below already applies. Before
this fix, Step 5 ran this decision freehand and never applied that exclusion — since Step 5
runs earlier and stops the pipeline (deferring the review pass silently) on a match, its
wrong answer won even when Step 9.5's later, correct, mechanized gate would have said the
finding was resolved. Invoke it with the `reviews`, `comments`, and `reviewThreads` fetched above (no
extra API call needed), plus `headRefOid`, `LAST_REVIEWED_COMMIT`, `LAST_PUSH_DATE`,
`CURRENT_USER` resolved in Step 3, and `PR_AUTHOR` as `prAuthor` (RAS-1.1) — do not decide
`hasSubstantiveUnresolvedFeedback` by narrative judgment:

```bash
CURRENT_USER={the login resolved in Step 3}
```

```bash
bun run "${CLAUDE_PLUGIN_ROOT}/scripts/compute-unresolved-comment-check.ts" \
  "$(jq -n --arg currentUser "$CURRENT_USER" \
    --arg prAuthor "$PR_AUTHOR" \
    --arg headRefOid "$HEAD_REF_OID" \
    --arg lastReviewedCommit "$LAST_REVIEWED_COMMIT" \
    --arg lastPushDate "$LAST_PUSH_DATE" \
    --argjson reviews "$REVIEWS_JSON" \
    --argjson comments "$COMMENTS_JSON" \
    --argjson reviewThreads "$REVIEW_THREADS_JSON" \
    '{currentUser: $currentUser, prAuthor: $prAuthor, headRefOid: $headRefOid, lastReviewedCommit: (if $lastReviewedCommit == "" then null else $lastReviewedCommit end), lastPushDate: $lastPushDate, reviews: $reviews, comments: $comments, reviewThreads: $reviewThreads}')"
# -> {"hasSubstantiveUnresolvedFeedback":true|false}
```

Assign the script's output to a shell variable:

```bash
HAS_SUBSTANTIVE_UNRESOLVED_FEEDBACK={true or false, from the script's output above}
```

This is the same computation Step 9.5's hard gate performs further down this file, applied
here against the `reviews`, `comments`, and `reviewThreads` connections fetched above —
`compute-unresolved-comment-check.ts`'s own unit tests are the authoritative behavioral spec
for this definition, not this prose.

If `HAS_SUBSTANTIVE_UNRESOLVED_FEEDBACK` is `true`: print
`Skipping #{pr} — unresolved feedback from @{login} ({type} on {date}). No commits since.`,
mark the PR as reviewed-at-this-commit (without staging) so the record is not re-evaluated at the
same commit. Also advance `reviewedAt` to the current time (captured once as `{now}`, an
ISO-8601 UTC timestamp, e.g. `date -u +"%Y-%m-%dT%H:%M:%SZ"`) — this closes the
`hasFreshNonAgentComment` perpetual-retrigger gap (RCT-1.1/RVG-1.1): `agent/src/check-review.ts`'s
`hasFreshNonAgentComment` uses `reviewedAt` as its "is there new activity since we last looked"
watermark, and without advancing it here, the very comment that triggered this skip (or any
comment after it) would look perpetually fresh against a frozen watermark, causing this PR to be
re-selected for review on every subsequent tick indefinitely:
```bash
curl -sf -X PATCH \
  -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
  -H "Content-Type: application/json" \
  "$SHIPWRIGHT_TASK_STORE_URL/prs/{PR_RECORD_ID}" \
  -d '{"reviewState": "posted", "commitSha": "{headRefOid}", "reviewedCommitSha": "{headRefOid}", "reviewedAt": "{now}"}' >/dev/null
```
Note: `staged` is NOT set here, so this does not interact with `/shipwright:review-staged`'s
staged-record flow — this is purely a commit-level dedup to prevent re-review at the same head
until new commits land. The claim (`claimedBy`, `claimedAt`, `heartbeatAt`, `phase`) is
auto-cleared by `pull-request-service.ts` when `reviewState` is set to `posted`.

**Caveat:** this dedup only reliably holds when the substantive unresolved feedback came from a
formal `CHANGES_REQUESTED`/`COMMENTED` review object at head. `agent/src/pr-state-reconciler.ts`'s
background `reconcilePostedReviewStateRecord()` heals a `posted` record back to `pending` once its
`hasAnyReviewAtHead()` check finds no formal review object at the current head commit — it does not
inspect issue-level PR comments. So when the substantive unresolved feedback is a plain PR
comment with no accompanying formal review at head, the very next reconcile pass (every 30-60
min) PATCHes `reviewState` back to `pending`, and this PR becomes re-selectable for review — the
dedup set here does not persist for that case. This is not a regression vs. the old
`release`-based skip (which produced the same eventual `pending` state, just immediately instead
of after a reconcile delay); it just means the delay before the same re-review-at-this-commit
churn resumes is longer, not zero, for the plain-comment trigger.

Emit `[skip-reason:review:deferred:unresolved-human-feedback:{pr}]` immediately before the
following `[silent]` marker (interpolating `{pr}` from the value above) — this defer is a
legitimate backstop, not a genuine no-op, and without the tagged reason the loop
orchestrator's generic `[silent]` handling would count it toward `SKIP_BLOCK_THRESHOLD`,
risking a false HITL auto-block (see `agent/src/loop-orchestrator.ts`).

Respond `[silent]`, and stop.

8. **Renew the claim heartbeat**: context-gathering plus the deep review that follows can
   together run longer than the claim TTL, so renew the heartbeat now, before starting the
   review-writing phase — this keeps the claim alive so the stale-claim reaper does not reset
   it back to `pending` mid-review:
   ```bash
   curl -s -o /dev/null -X POST \
     -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
     "$SHIPWRIGHT_TASK_STORE_URL/prs/{PR_RECORD_ID}/heartbeat"
   ```

---

## Step 5.8: Dependency Manifest Detection (DBR-3.2)

Regardless of `PR_AUTHOR` — this step runs the same for any PR, human-authored or
bot-authored; it is not gated on `PR_AUTHOR`/`author.login` at all, unlike the retired,
Dependabot/Renovate-specific standalone triage skill it superseded (DBR-3.4). A
human-authored PR that happens to touch a dependency manifest (e.g. hand-editing
`package.json` to pin a version) gets the exact same dependency-risk analysis as a
bot-authored one.

1. **Build the repo's watched-path set.** cwd is already the worktree root at this point in
   the procedure (per Step 4's "All subsequent steps run from
   `.../{repo}-{branch-slug}/`" transition), so read the two config files relative to cwd
   if present:
   ```bash
   RENOVATE_JSON=$(cat renovate.json 2>/dev/null || echo "")
   DEPENDABOT_YML=$(cat .github/dependabot.yml 2>/dev/null || echo "")
   ```
   Then resolve the watched-path set — repo-specific, not a hardcoded global list — via
   `resolve-dependency-watched-paths.ts` (mirroring `compute-review-verdict.ts`'s CLI
   pattern):
   ```bash
   WATCHED_PATHS_RESULT=$(bun run "${CLAUDE_PLUGIN_ROOT}/scripts/resolve-dependency-watched-paths.ts" \
     "$(jq -n --arg renovateJson "$RENOVATE_JSON" --arg dependabotYml "$DEPENDABOT_YML" \
       '{renovateJson: (if $renovateJson == "" then null else $renovateJson end),
         dependabotYml: (if $dependabotYml == "" then null else $dependabotYml end)}')")
   # -> {"paths":["package.json","go.mod",...],"source":"renovate"|"dependabot"|"both"|"fallback"}
   ```
   The script reads `renovate.json`'s configured `managers` array (when present) to narrow
   scope to only the ecosystems it names; when `managers` is absent, Renovate's own default
   is "detect all supported manifests", so the script treats that as the full universal
   list rather than narrowing it. It reads `.github/dependabot.yml`'s `updates[]` array —
   each entry's `package-ecosystem` (e.g. `npm`, `bundler`, `pip`, `gomod`, `cargo`) maps to
   that ecosystem's manifest filename(s), joined with the entry's `directory` prefix (e.g.
   `directory: "/backend"` + `npm` -> `backend/package.json`). A dependabot.yml that yields
   zero recognized ecosystems — an empty `updates: []`, or entries whose `package-ecosystem`
   values this script doesn't map — resolves to an **empty** watched-path set, not the
   universal list: an explicit dependabot.yml is authoritative about what the repo watches,
   so this step simply no-ops for that repo rather than widening back out. (A dependabot.yml
   that can't be parsed at all — invalid YAML, or a missing `updates` key — is a different
   case and still degrades to the universal list.) When both config files are
   present, the two watched-path sets are unioned, not one picked over the other — a repo
   can run both tools at once. **When neither config file is present in the repo, this falls
   back to the universal manifest-file list**: `package.json` and common lockfiles
   (`package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`, `bun.lock`, `bun.lockb`), `go.mod`
   (and `go.sum`), `Gemfile` (and `Gemfile.lock`), `requirements.txt` (and `Pipfile`,
   `Pipfile.lock`, `pyproject.toml`), and `Cargo.toml` (and `Cargo.lock`).

2. **Compare against the changed files.** Using Step 5.3's already-extracted changed-files
   list and the `paths` array from the script's output above, a changed file matches the
   watched-path set when ANY of the following three rules apply:
   - **exact match**: the changed file is an exact, case-sensitive match to a watched path
     (e.g. changed file `package.json` matches watched path `package.json`), or
   - **basename match**: the changed file's **basename** matches a watched path that is
     itself a bare filename with no directory component (e.g. changed file
     `packages/foo/package.json` matches watched path `package.json` by basename, even
     though the watched-path set didn't anticipate that nested location) — this basename
     fallback only applies when the watched-path entry has no `/` in it; a watched path
     with a directory prefix (e.g. `backend/package.json`, from a dependabot.yml
     `directory` entry) requires the exact full-path match, since that prefix was an
     explicit scoping choice, not something a bare basename match should widen back out,
     or
   - **directory-prefix match**: the changed file's path starts with a watched path that
     itself ends with `/` (e.g. watched path `.github/workflows/` — as emitted for the
     `github-actions` ecosystem — matches changed file `.github/workflows/ci.yml`). This
     is distinct from the basename case above: a trailing `/` marks the entry as a
     directory-prefix convention rather than a bare filename, so no glob syntax is ever
     needed in the watched-path set.

3. **When triggered** (at least one changed file matches, by either rule above): apply
   `references/dependency-risk-analysis.md`'s heuristics — using this PR's `diff` (Step
   5.2), `body` and `author.login` (Step 5.1's PR metadata), and `labels` if available — to
   produce `recommendation` (`merge`/`review`/`hold`), `flags` (`breakingChange`,
   `securityRelevant`, `productionImpact`), and `reasoning`. Follow that reference's
   Dependabot path, Renovate path, or author-mismatch fallback exactly as documented there —
   this step does not restate those heuristics, only invokes them. Carry the resulting
   `{recommendation, flags, reasoning}` forward as `DEPENDENCY_RISK_ANALYSIS` for Step 9 (the
   review file's dedicated "Dependency Risk Analysis" section) and Step 10 (folded into the
   JSON body's reasoning) — kept distinguishable there from the ordinary code-review
   Critical/Important/Suggestions findings, never merged into that list.

4. **When not triggered** (no changed file matches): this step is a no-op — do not add a
   "Dependency Risk Analysis" section anywhere downstream; `DEPENDENCY_RISK_ANALYSIS` stays
   unset/absent for Steps 9 and 10.

---

## Step 6: Classify Changes by Domain

Before reading individual files, build a structural picture of what kind of work this PR does. Work from the PR body, commit messages, and file list:

- **Why**: What problem is this solving? What's the motivation? (PR body, linked issues, commit messages)
- **What changed**: High-level summary of affected areas — which features, services, or layers are touched
- **View changes**: Any new or modified pages, components, or UI flows — identify business logic changes, not just layout tweaks
- **API changes**: New, removed, or modified endpoints; changed request/response shapes; auth changes; new event streams (SSE, WebSocket)
- **Database changes**: New tables or columns, dropped columns, index changes, migrations, schema-affecting model changes
- **Architecture changes**: New services or packages, new ways of exposing functionality (new route groups, new event types, new integrations), changes to service boundaries
- **Breaking changes**: Any changes that break backwards compatibility — removed endpoints, changed request/response shapes, renamed fields, dropped columns, changed auth semantics, changed event contracts. Assume rolling deployments; clients and servers don't update atomically.
- **Testing changes**: Classify whether the PR is "test-touching" (modifies or adds test files) or "untested logic" (adds production code with no corresponding test additions). Identify test files using the project's language and toolchain — look at the diff context, the CLAUDE.md stack description, and common conventions for that language rather than applying a fixed set of filename patterns. Note which test files were added, modified, or removed. If neither applies (pure refactor of existing tested code, docs-only, etc.), note "none".

Note which categories are present (even if "none") — this drives review focus.

---

## Step 7: Deep Review (dispatch `shipwright:code-reviewer` subagent)

Delegate the per-file review to the bundled `shipwright:code-reviewer` subagent. This
keeps review context isolated from the main thread (policy, queue, posting).

Dispatch via the Agent tool with `subagent_type: "shipwright:code-reviewer"`, passing
`model: TASK_MODEL ?? 'sonnet'` (the linked task's model tier resolved at the end of Step 4,
falling back to `'sonnet'` when no task is linked or the lookup failed), and pass
a single prompt block containing:

**This call is synchronous and blocking** — the Agent tool result returns the subagent's
full JSON response directly, so Step 7 continues straight to parsing it into Step 8 and
Step 9. No wait/poll step is needed here: do not schedule a wakeup or background monitor
for this dispatch.

- **PR metadata** — `number`, `title`, `author`, `headRefName`, `baseRefName`, `headRefOid`
- **Full diff** — the `git diff "origin/$base"...HEAD` output from Step 5.2
- **Changed files** — the list extracted in Step 5.3
- **CLAUDE.md contents** — root CLAUDE.md + any CLAUDE.md in directories containing
  changed files (from Step 5.6). Include each as a labeled block so the subagent knows
  which directory it governs.
- **`acceptanceCriteria`** — if the PR maps to a shipwright task, paste the criteria;
  otherwise omit the field
- **`testReadinessContext`** — contents of `docs/test-readiness/test-system.md` plus the
  Testing section of the repo's CLAUDE.md (gathered in Step 5.7); omit this field entirely
  when no test-readiness content was gathered (the subagent falls back to the universal
  baseline in the testing-domain entries of the project's principles source when the field
  is absent — checking for a project-level override at `.claude/shipwright/principles.md`
  first, then falling back to `references/principles.md` (relative to the plugin root) if
  no override exists)
- **`Prior Findings — Requires Resolution Check`** (PVD-1.2) — when Step 5.5's
  `priorQualifyingReviews` is non-empty, include this labeled input listing each prior
  qualifying review's `ref` and full `body`. Omit this field entirely when
  `priorQualifyingReviews` is empty — mirroring how `acceptanceCriteria` and
  `testReadinessContext` are omitted rather than passed as an empty value. Instruct the
  subagent that, for each entry, it must explicitly assess whether the issue that review
  originally described is still present in the current diff, and return one
  `priorFindingsStatus[]` entry per input `ref` (see the Output Format section of
  `agents/code-reviewer.md`).
- **Policy** — pass `min_confidence` and `max_findings` from Step 1

The subagent returns a JSON object with `summary`, `findings[]`, `strengths[]`,
`recommendation`, `recommendation_reason`, and — whenever the `Prior Findings — Requires
Resolution Check` input was passed above — `priorFindingsStatus[]`, an array of
`{ ref, resolved, evidence }` entries, one per prior qualifying review passed in. `ref`
identifies which prior review the entry addresses (matching the `ref` passed in above),
`resolved` is a boolean, and `evidence` (required in both the `resolved: true` and
`resolved: false` cases) is a `file:line` reference or diff excerpt proving the fix, or
explaining why the issue is not resolved. Parse the full response and carry the data into
Step 8 and Step 9 (Step 9's Re-Review "Prior Findings Resolution" table is populated from
`priorFindingsStatus[]` — see Step 9).

#### Findings Ledger Persistence — Prior Findings Attestations (PFL-2.1)

Once `priorFindingsStatus[]` has been parsed above, persist each `resolved: true` attestation
to the findings ledger. **This does not change the attestation itself** — Step 9's Re-Review
table still consumes `priorFindingsStatus[]` exactly as parsed; this POST is what makes the
attestation durable so that Step 9.5's findings-ledger exclusion (`isResolvedByLedger`,
PFL-3.2) picks it up on the current and future passes. This is purely additive logging of the
subagent's own determination, using its own evidence string verbatim:

```bash
for entry in priorFindingsStatus[] where entry.resolved === true:
  BODY=$(jq -n --arg ref "{entry.ref}" --arg evidence "{entry.evidence}" \
    '{ref: $ref, disposition: "resolved", source: "review", evidence: $evidence}')
  curl -sf -X POST \
    -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
    -H "Content-Type: application/json" \
    "$SHIPWRIGHT_TASK_STORE_URL/prs/${PR_RECORD_ID}/findings" \
    -d "$BODY" \
    >/dev/null 2>&1 || echo "⚠ ledger POST failed for {entry.ref} — continuing (non-fatal)"
```

`{entry.ref}` and `{entry.evidence}` are the same `ref`/`evidence` values from the parsed
`priorFindingsStatus[]` entry — `evidence` is passed through verbatim, not rewritten, but
`entry.evidence` is subagent-authored free text (a `file:line` reference, diff excerpt, or
explanation — see Step 7's Output Format above), so it is built via `jq -n --arg` rather than
interpolated directly into a JSON string literal — the same escaping pattern Step 9.5 and
Step 10.5 use for LLM-authored free text elsewhere in this file. Entries with `resolved: false`
are not posted here (there is nothing resolved to persist; they remain a normal unaddressed
finding via the qualifying-review path).

**Best-effort, not a new decision.** These POSTs persist attestations the subagent already
made in its response above — they do not gate Step 8, Step 9, or Step 9.5's own consumption
of `priorFindingsStatus[]`. A failed POST (non-2xx, timeout, or any other curl error) is
non-fatal: log the warning shown above and continue — the actual review-posting logic must
not be gated on ledger-write success.

If the subagent returns malformed JSON, retry once with a reminder of the schema. If it
still fails, fall back to an inline review in the main thread using the same rules
(see `agents/code-reviewer.md` for the canonical rule set).

---

## Step 8: Score and Classify Findings

The subagent has already applied confidence scoring and verification (pre-existing
filter, CLAUDE.md endorsement check, silent-failure detection, breaking-API rule,
acceptance-criteria check). This step applies policy thresholds from `state/agent-policy.md`.

| Range | Category | Meaning |
|-------|----------|---------|
| 90-100 | Critical | Bug, CLAUDE.md violation, breaking API change |
| 75-89 | Important | Likely to cause problems |
| 50-74 | Suggestion | Valid concern, lower impact |
| < 50 | Discard | Nitpick or false positive |

Apply policy thresholds to the subagent's `findings[]`:
- Drop findings below `min_confidence` (default 75)
- Trim to `max_findings` (default 5), removing lowest confidence first
- Group remaining findings by their `severity` field (`critical`, `important`, `suggestion`)

**Keep it tight.** A good review has 2-5 actionable items. If the subagent returned
more, trim to the highest-confidence few.

**Compute `CURRENT_PASS_HAS_BLOCKING_FINDINGS`** from the threshold-filtered findings above:
`true` if any remaining finding is `important` or `critical` severity, else `false`. This is
Step 10/10.5's `currentPassHasBlockingFindings` input to `compute-review-verdict.ts` — it
reflects what THIS review pass found (fresh, post-threshold-filtering), independent of Step
9.5's `unaddressedFindings` (which only reflects prior, already-posted GitHub review state).
Without this input, a fresh critical finding in an otherwise-clean review pass with zero prior
unresolved threads would silently compute as `APPROVE` — see Step 10's worked example, Case 3.

---

## Step 9: Write Review File

Write `$WORKSPACE_ROOT/state/reviews/PR_REVIEW_{pr}.md`:

```markdown
# PR Review: #{pr} - {title}

**Author**: @{author}
**Branch**: {head} -> {base}
**Date**: {date}
**Reviewed commit**: {head_sha}

## Summary

{Brief description of what this PR does}

## Change Summary

**Why**: {motivation — problem being solved or feature being delivered}

**What changed**: {high-level summary of affected areas}

**View changes**: {new/modified pages or UI flows with business logic impact, or "none"}

**API changes**: {new, removed, or modified endpoints; shape changes; new event mechanisms (SSE, WebSocket), or "none"}

**Database changes**: {schema changes — tables, columns, indexes, migrations, or "none"}

**Architecture changes**: {new services, new ways of exposing functionality, service boundary changes, or "none"}

**Breaking changes**: {removed endpoints, changed shapes, renamed fields, dropped columns, auth changes — or "none"}

**Testing changes**: {test files added/modified/removed and classification: "test-touching", "untested logic", or "none"}

## CI Status

{Current status of checks}

## Dependency Risk Analysis

{Only present when Step 5.8 triggered — omit this entire section (heading included) when
Step 5.8 found no changed file matching the repo's watched-path set. When present, this
section is populated from `DEPENDENCY_RISK_ANALYSIS` (Step 5.8's application of
`references/dependency-risk-analysis.md`'s heuristics) and is kept visually and
structurally distinguishable from the ordinary code-review findings below — it is never
folded into Critical Issues/Important Issues/Suggestions, since it reflects a different
analysis (dependency-bump risk, not general code review) even on a PR that also has
ordinary findings.}

**Recommendation**: {merge|review|hold}
**Flags**: {breakingChange, securityRelevant, productionImpact — whichever apply, or "none"}
**Reasoning**: {DEPENDENCY_RISK_ANALYSIS.reasoning}

## Critical Issues ({count})

### 1. {Issue title}
- **File**: `path/to/file.ts:123`
- **Confidence**: 95
- **Issue**: {description}
- **Suggestion**: {fix, if applicable}

## Important Issues ({count})

### 1. {Issue title}
...

## Suggestions ({count})

- {suggestion with file:line reference}

## Strengths

- {What's done well -- keep brief}

## Recommendation

{APPROVE or COMMENT}
{One-sentence reasoning}
```

### Re-Review (Update)

If this agent reviewed this PR before — detected by the local file `$WORKSPACE_ROOT/state/reviews/PR_REVIEW_{pr}.md`
already existing (`test -f $WORKSPACE_ROOT/state/reviews/PR_REVIEW_{pr}.md`):

Append an update section instead of creating a new file. (Do not use `reviewCycles` from the
task store — another agent may have incremented it without this agent ever reviewing, so the
local file is the authoritative signal that *this* agent has a prior review to append to.)

```markdown
---

## Review Update - {date}

### New Commits Since Last Review

- {sha}: {message}

### Prior Findings Resolution

Populate this table from the subagent's structured `priorFindingsStatus[]` response (Step 7,
PVD-1.2) rather than freehand narrative — one row per entry, mapping `resolved: true` to
`Addressed` and `resolved: false` to `Not addressed`, with the `evidence` field verbatim in
the Evidence column:

| Finding | Status | Evidence |
|---------|--------|----------|
| {ref} | Addressed | {evidence, e.g. Fixed in `file.ts:45`} |
| {ref} | Not addressed | {evidence, e.g. Still missing validation} |

Only present when Step 7's subagent dispatch included the `Prior Findings — Requires
Resolution Check` input (i.e. `priorQualifyingReviews` was non-empty); omit this
subsection when there was nothing to check.

### New Issues ({count})
...

### Updated Recommendation

{APPROVE or COMMENT}
**Previous**: {previous verdict}
**Now**: {updated verdict with reasoning}
```

---

## Step 9.5: Unaddressed-Findings Hard Gate (RUC-1.1, PVD-1.1, PVD-1.3)

Immediately before Step 10 finalizes the verdict, this step determines whether this PR has
**unaddressed findings**, using the exact definition `/shipwright:patch`'s `### Step 3a: Check
for Unaddressed Review Findings` (`commands/patch.md`) already applies — reuse that definition
rather than re-deriving it (the drift PRB-2.1 previously fixed between `check-deploy.ts` and
`check-patch.ts`/`check-review.ts`).

**This is computed mechanically, not freehand.** `compute-unaddressed-findings.ts`
(PVD-1.1) is the single exported, tested implementation of `hasUnaddressedFindings` and its
helpers — extracted from `agent/src/check-patch.ts`'s List A qualification logic, mirroring
`compute-review-verdict.ts`'s CLI pattern (DRO-1.1). Invoke it with the `reviews`,
`reviewThreads`, `comments`, and `headRefOid` fetched in Step 5.5, plus `CURRENT_USER`
resolved in Step 3 — do not decide `unaddressedFindings` by narrative judgment. Pass
`PR_AUTHOR` as `prAuthor`, not `CURRENT_USER` (RAS-1.1):

```bash
CURRENT_USER={the login resolved in Step 3}
```

```bash
bun run "${CLAUDE_PLUGIN_ROOT}/scripts/compute-unaddressed-findings.ts" \
  "$(jq -n --arg currentUser "$CURRENT_USER" \
    --arg prAuthor "$PR_AUTHOR" \
    --argjson headRefOid "$(jq -Rs . <<< "$HEAD_REF_OID")" \
    --argjson reviews "$REVIEWS_JSON" \
    --argjson reviewThreads "$REVIEW_THREADS_JSON" \
    --argjson comments "$COMMENTS_JSON" \
    --argjson priorFindingsStatus "$PRIOR_FINDINGS_STATUS_JSON" \
    '{currentUser: $currentUser, prAuthor: $prAuthor, headRefOid: $headRefOid, reviews: $reviews, reviewThreads: $reviewThreads, comments: $comments, priorFindingsStatus: $priorFindingsStatus}')"
# -> {"unaddressedFindings":true|false}
```

`HEAD_REF_OID`, `REVIEWS_JSON`, `REVIEW_THREADS_JSON`, and `COMMENTS_JSON` are the
`headRefOid`, `reviews`, `reviewThreads`, and `comments` values from Step 5.5's GraphQL
response — pass them through unchanged, do not re-fetch or re-shape them. `PRIOR_FINDINGS_STATUS_JSON`
is the subagent's `priorFindingsStatus[]` array parsed in Step 7 (PVD-1.2's `{ ref, resolved, evidence }`
attestations — see Step 5.5's `priorQualifyingReviews` and Step 7). Each entry's `ref` is derived
via `compute-unaddressed-findings.ts`'s exported `reviewRef(review)` helper (full `commit.oid` +
`submittedAt`), so the match back to a specific prior review is mechanical, not a fuzzy short-SHA
comparison. Pass an empty array (`[]`) when no `priorFindingsStatus[]` was produced (no prior
qualifying reviews to re-verify) — the field is optional and defaults to `[]`. Assign the script's
`unaddressedFindings` output to a shell variable for Step 10 to consume:

```bash
UNADDRESSED_FINDINGS={true or false, from the script's output above}
```

A PR has **unaddressed findings** when ANY of the following are true:
- At least one review threads node has `isResolved == false` (unresolved inline thread),
  excluding one addressed by a later PR-author reply within it (URT-1.1's
  `isThreadAddressedByAuthorReply` — sixth exclusion, scoped to the thread's own timestamps
  since no review<->thread correlation exists in the schema; see patch.md's Step 5a.7).
- At least one review with `state == "COMMENTED"` or `state == "CHANGES_REQUESTED"` has a
  non-empty `body`, excluding:
  - a clean self-APPROVE (per `isCleanApproveBody`/CPF-2.1 — a review whose body starts with
    `APPROVE` or contains a `Verdict: APPROVE` label),
  - a review addressed by a subsequent PR-author reply (per CPF-2.3 — the PR author posted a
    PR-level comment with `createdAt` after that review's `submittedAt`, and all inline
    threads are resolved), and
  - an earlier self-authored review superseded by a later, genuinely clean self-review from
    the same author (per DRO-1.2 — a self-authored PR reviewed via a fresh review object each
    round, rather than a body rewrite, never triggers the clean-self-APPROVE exclusion above
    for earlier rounds even after every finding in them is fixed), and
  - a prior review whose finding is attested resolved/superseded in the findings ledger (per
    `isResolvedByLedger`/PFL-3.2): when the task-store ledger holds an entry (`source:
    "review"`) whose `ref` matches that review — matched by `reviewRef`, full `commit.oid` +
    `submittedAt` — with disposition `resolved` or `superseded`, the prior review is excluded.
    The entry is written durably by an earlier pass (see the "Findings Ledger Persistence —
    Prior Findings Attestations" subsection above). Routing resolution through the persisted
    ledger closes a structural deadlock: because Step 10/11 always posts a new review object per
    pass (never rewriting a prior body), a clean-self-APPROVE exclusion could only fire when a
    LATER self-review is itself clean — but that review can only be clean if
    `unaddressedFindings` was already false for its own pass, so a single self-authored
    `Verdict: COMMENT` finding would otherwise pin the PR at COMMENT forever, even after the
    finding is fixed. The ledger breaks the cycle by recording the finding resolved once,
    durably, so every subsequent pass sees it excluded. Each ledger entry is judged
    independently: a fresh, unrelated blocking finding elsewhere in a pass does **not** prevent
    an already-verified resolution from being excluded (that fresh finding still forces
    `COMMENT` on its own via `currentPassHasBlockingFindings` and/or the normal
    qualifying-review path). Unlike the removed self-review inference heuristics,
    `isResolvedByLedger` is NOT gated on self-authorship — it resolves the review it references
    regardless of whose review it was.

This is the same computation patch.md's Step 3a performs to decide whether a PR belongs in
its List A — see that section for the full clean-APPROVE, author-reply, and
superseded-self-review exclusion rules (not restated here to avoid a fourth divergent copy);
`compute-unaddressed-findings.ts`'s own unit tests are the authoritative behavioral spec for
this definition, not this prose.

**If unaddressed findings are present, force the verdict to `COMMENT`** — this
`unaddressedFindings` boolean is one of the three inputs Step 10's mechanical
`compute-review-verdict.ts` call uses to compute the `event` and `verdictLabel`; it is not
combined with the code-reviewer subagent's own top-line recommendation here (see Step 10 for
the full three-input truth table, which also folds in the `selfReview` input and
`currentPassHasBlockingFindings`). This gate:
- **Overrides the code-reviewer subagent's severity-based recommendation** from Step 7 —
  even if the subagent recommends APPROVE (e.g. only suggestion-level findings, or no
  findings at all in the new diff), a genuinely unresolved inline thread or qualifying
  review from a prior pass still forces `COMMENT`.
- **Is not mutually exclusive with the other two inputs to Step 10's mechanical
  computation** — the `selfReview` input (a self-review override: GitHub rejects
  self-APPROVE via the API) and the `currentPassHasBlockingFindings` input (Step 8's
  threshold-filtered findings for this pass) can each independently force `COMMENT` too; any
  one of the three is sufficient, and this gate must not be skipped just because another
  input already forces `COMMENT`. This holds even when the review narrative would otherwise
  self-report `Verdict: APPROVE` — the computed verdict always wins over narrative wording.

This gate is computed live from the GraphQL data fetched in Step 5.5 at review-post time —
consistent with the "GitHub is the Source of Truth" principle in
`plugins/shipwright/CLAUDE.md`, it is not persisted as a new dedup state field in the task
store.

---

## Step 10: Build Review JSON

Follow `references/post-review-guide.md` for the full mechanics.

**The event/verdict decision is mechanical, not freehand.** Three inputs are already computed
by this point in the procedure:
- `selfReview` = `true` if `PR_AUTHOR == CURRENT_USER` (captured in Step 5 from the PR
  metadata's `author.login`), else `false`.
- `unaddressedFindings` = the boolean Step 9.5's hard gate computed (real unresolved findings
  from BEFORE this review pass — unresolved prior GitHub review threads/comments — present at
  head, per that step's exact definition).
- `currentPassHasBlockingFindings` = `true` if Step 8's threshold-filtered `findings[]` for
  THIS review pass contains at least one `important` or `critical` severity finding, else
  `false`. This is distinct from `unaddressedFindings`: it reflects what the code-reviewer
  subagent found fresh in Steps 7/8, not prior GitHub-posted review state.

Invoke `compute-review-verdict.ts` to turn those three booleans into the `event` and
`verdictLabel` to use — do not decide the event or the body's `Verdict: ...` label by
narrative judgment. Assign each computed value to a shell variable first (each must be the
literal string `true` or `false`):

```bash
SELF_REVIEW={true or false, from selfReview above}
UNADDRESSED_FINDINGS={true or false, from unaddressedFindings above}
CURRENT_PASS_HAS_BLOCKING_FINDINGS={true or false, from currentPassHasBlockingFindings above}
```

```bash
bun run "${CLAUDE_PLUGIN_ROOT}/scripts/compute-review-verdict.ts" \
  "{\"selfReview\": ${SELF_REVIEW}, \"unaddressedFindings\": ${UNADDRESSED_FINDINGS}, \"currentPassHasBlockingFindings\": ${CURRENT_PASS_HAS_BLOCKING_FINDINGS}}"
# -> {"event":"APPROVE"|"COMMENT","verdictLabel":"APPROVE"|"COMMENT"}
```

Use the returned `event` for the JSON's `event` field, and the returned `verdictLabel` to
build the literal `Verdict: {verdictLabel}` phrase leading the `body`. This single script call
replaces both the old "Self-review event override" prose and the old "Event selection" prose
below — see the truth table and worked example that follow for *why* the gate exists, but the
*procedure* is: call the script, use its output verbatim.

**The `body` field MUST contain the literal phrase `Verdict: APPROVE` or `Verdict: COMMENT`**,
matching the `verdictLabel` computed above — not just implied wording or free-form approval
prose. `agent/src/check-patch.ts`'s `isSelfCleanApprove` (`VERDICT_APPROVE_LABEL =
/verdict\**\s*:\s*\**approve\b/i`) scans the GitHub-posted review body for this exact phrase to
recognize a clean self-approve on a self-authored PR (where `event` is forced to `COMMENT`,
since GitHub blocks self-APPROVE via the API). A body like "Clean conversion, all routes
verified, no blocking issues." reads as a genuine approval to a human but contains neither
`APPROVE` nor `Verdict: APPROVE`, so `isSelfCleanApprove` never matches it — the patch cron then
treats it as an unaddressed finding forever. Always lead the body with the literal `Verdict: ...`
label, on both the initial-review and re-review paths (Steps 10/11 run identically for both;
see Step 14's re-review flow).

**Worked example — the two cases production actually confused.** This convention was not
followed on two separate PRs in another repo in this deployment (one self-authored, one not),
and recurred again two days after that guidance landed, on another PR review in the same
deployment — proof that prose guidance alone was not sufficient enforcement, which is why the
decision is now mechanical (`compute-review-verdict.ts`) rather than freehand. All of these
mislabeled review bodies read `Verdict: COMMENT` even though the narrative was explicitly
clean — e.g. "No blocking issues found... checks out clean." In each case the underlying
situation was actually Case 1 below (a clean review that should read `Verdict: APPROVE`), but
it was written as if it were Case 2. Both cases resolve to the
**same `event: "COMMENT"`** — that surface-level identity is exactly why they get conflated —
but they MUST produce **different** `Verdict: ...` body labels:

- **Case 1 — self-authored PR, all findings resolved via Step 9.5's exclusions.** The PR's
  `author.login == CURRENT_USER` (`selfReview = true`), Step 9.5's unaddressed-findings gate
  computes no unaddressed findings (`unaddressedFindings = false`) — every review either is a
  clean self-APPROVE or was addressed by a subsequent author reply — and the current pass has
  no blocking findings (`currentPassHasBlockingFindings = false`). A genuinely clean approval.
  Result: `event: "COMMENT"` (forced by the self-review override, since GitHub blocks
  self-APPROVE via the API — not because there's anything wrong with the PR), body **must**
  read `"Verdict: APPROVE — ..."`. Writing `Verdict: COMMENT` here is the exact bug observed
  in production: it makes a clean PR invisible to `isSelfCleanApprove` and the patch cron
  treats it as an unaddressed finding forever.
- **Case 2 — any-author PR, a genuine unresolved finding still present at head.** Step 9.5's
  gate computes real unaddressed findings (`unaddressedFindings = true`) — an unresolved inline
  thread, or a qualifying `COMMENTED`/`CHANGES_REQUESTED` review body not excluded by the
  clean-APPROVE or author-reply rules. This holds regardless of `selfReview` or
  `currentPassHasBlockingFindings`. Result: `event: "COMMENT"`, body correctly reads
  `"Verdict: COMMENT — ..."`.
- **Case 3 — any-author PR, no prior unaddressed findings, but a fresh blocking finding in
  this pass.** `selfReview = false` and `unaddressedFindings = false` (zero prior unresolved
  GitHub review threads/comments), but Step 8's threshold-filtered `findings[]` for THIS review
  pass contains an important/critical severity finding (`currentPassHasBlockingFindings =
  true`). Without this input, this case would silently compute as a clean `APPROVE` — the same
  failure mode as Case 1 above, reintroduced by a different path. Result: `event: "COMMENT"`,
  body correctly reads `"Verdict: COMMENT — ..."`. This restores the old "Event selection"
  rule: "If any finding at important/critical severity remains after threshold filtering:
  COMMENT — no exceptions."
- **Normal clean approve — any-author PR, no unaddressed findings, no blocking findings this
  pass.** `selfReview = false`, `unaddressedFindings = false`, and
  `currentPassHasBlockingFindings = false`. Result: `event: "APPROVE"`, body reads
  `"Verdict: APPROVE — ..."`. This is the ordinary non-self-review approve path.

Both self-review-forced-COMMENT cases select `event: "COMMENT"` for entirely different reasons
(an API restriction on authorship vs. a real quality gate on content) — the `Verdict: ...`
body label is the *only* signal that distinguishes them for downstream automation, so it must
always reflect the actual computed verdict, never be copied from the `event` value or from
generic "this went through COMMENT" boilerplate. `compute-review-verdict.ts`'s `computeVerdict`
implements this exact 8-row truth table (2^3 boolean combinations) so it can never drift into
freehand narrative judgment again:

| selfReview | unaddressedFindings | currentPassHasBlockingFindings | event | verdictLabel |
|---|---|---|---|---|
| true | false | false | COMMENT (self-review override) | APPROVE |
| true | false | true | COMMENT (self-review override) | COMMENT |
| true | true | false | COMMENT (self-review override) | COMMENT |
| true | true | true | COMMENT (self-review override) | COMMENT |
| false | false | false | APPROVE | APPROVE |
| false | false | true | COMMENT | COMMENT |
| false | true | false | COMMENT | COMMENT |
| false | true | true | COMMENT | COMMENT |

Write `$WORKSPACE_ROOT/state/reviews/pr_review_{pr}.json`:

```json
{
  "commit_id": "{head_sha}",
  "body": "Verdict: APPROVE — Looks good, approved.",
  "event": "APPROVE|COMMENT",
  "comments": [
    {
      "path": "path/to/file.ts",
      "line": 123,
      "side": "RIGHT",
      "body": "Comment text"
    }
  ]
}
```

For a COMMENT verdict, the `body` follows the same convention, e.g.
`"body": "Verdict: COMMENT — {one-line summary of the most important finding}"`.

**Folding in the dependency risk analysis (DBR-3.2).** When Step 5.8 triggered and
`DEPENDENCY_RISK_ANALYSIS` is set, append a short, clearly-labeled dependency-risk clause to
the `body` after the `Verdict: ...` lead-in, e.g. `"Verdict: COMMENT — {code-review summary};
dependency risk: {DEPENDENCY_RISK_ANALYSIS.recommendation} — {DEPENDENCY_RISK_ANALYSIS.reasoning}"`.
This is additive to the verdict computed above, not a replacement for it — the
`compute-review-verdict.ts` truth table still solely determines `event`/`verdictLabel`; the
dependency-risk `recommendation` (`merge`/`review`/`hold`) does not feed into that
computation. When Step 5.8 did not trigger, omit this clause entirely — the body reads
exactly as it would without this feature.

**Diff-line mapping**: for each finding with a `file:line` reference, check if the
line is in the diff (`git diff origin/{base}...HEAD -- {file}`). Only lines within diff
hunks are valid for inline comments. Move others to the review body.

Inline comments are included regardless of verdict. The verdict signals whether the PR
should be held; the inline comments convey the specific feedback to the author.

### Step 10.5: Hard-Gate Validation (Before Posting)

Before Step 11 posts or stages anything, validate the constructed `body` against the same
`selfReview`/`unaddressedFindings`/`currentPassHasBlockingFindings` inputs used above, via the
script's validation mode. `SELF_REVIEW`, `UNADDRESSED_FINDINGS`, and
`CURRENT_PASS_HAS_BLOCKING_FINDINGS` carry over unchanged from Step 10; `BODY` is the `body`
string built for `pr_review_{pr}.json` above:

```bash
BODY={the "body" string built for pr_review_{pr}.json above}
```

```bash
bun run "${CLAUDE_PLUGIN_ROOT}/scripts/compute-review-verdict.ts" \
  "{\"selfReview\": ${SELF_REVIEW}, \"unaddressedFindings\": ${UNADDRESSED_FINDINGS}, \"currentPassHasBlockingFindings\": ${CURRENT_PASS_HAS_BLOCKING_FINDINGS}, \"body\": $(jq -Rs . <<< "$BODY")}"
```

- If the result's `valid` field is `true`, proceed to Step 11.
- If `valid` is `false` (mismatched label, or no `Verdict: ...` label found at all), **hard
  abort** — do not post or stage the review. Print the script's `error` field, fix the `body`
  in `pr_review_{pr}.json` to use the correct `Verdict: {verdictLabel}` phrase from Step 10,
  and re-run this validation before proceeding. This is the enforcement gate that the recurring
  mislabeling incidents above prove prose guidance alone did not provide — a mismatch must
  never silently proceed to posting.

---

## Step 11: Post or Stage

### If `auto_post_reviews` is true (default):

1. **Re-check freshness immediately before posting** (RHR-1.1). Time has passed since
   `headRefOid` was captured at claim time (Step 4 or Step 14's Pre-Claim Fast Path) — the
   review-writing phase (Steps 5-10.5) can take long enough for the author to push a new
   commit in the meantime. Re-fetch the live head into a new variable and compare against
   the canonical `headRefOid` captured earlier — do not overwrite `headRefOid` itself, and
   do not introduce any other new source of truth for it:
   ```bash
   currentHeadRefOid=$(gh pr view {pr} --repo {org}/{repo} --json headRefOid -q '.headRefOid')
   ```
   - **Match** (`"$currentHeadRefOid" = "$headRefOid"`): head hasn't moved since claim.
     Continue to step 2 below, unchanged.
   - **Mismatch** (`"$currentHeadRefOid" != "$headRefOid"`): the review body and inline
     comments were built against a commit that's no longer HEAD — some other change (often
     the very fix the review was about to flag) landed in the gap between claim and post.
     Do not POST. Release the claim so the record returns to `reviewState: "pending"` and
     the PR gets picked up fresh next pass:
     ```bash
     curl -s -o /dev/null -X POST \
       -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
       "$SHIPWRIGHT_TASK_STORE_URL/prs/${PR_RECORD_ID}/release"
     ```
     Print: `Aborted stale review for #{pr} -- head moved ({headRefOid[0..7]} -> {currentHeadRefOid[0..7]}) since claim; releasing for re-review.`
     Stop here — do not proceed to step 2 below, and do not run the record-completion
     step further down in this Step 11 (see "Mark PullRequest Record Posted"). No review
     was posted, so `reviewState` must never transition to posted/approved for this pass.
2. Submit via GitHub API, writing the response to a temp file (NOT a shell variable —
   the response JSON contains embedded newlines that corrupt `echo "$var" | jq` parsing):
   ```bash
   POST_EXIT=0
   gh api -X POST /repos/{org}/{repo}/pulls/{pr}/reviews \
     --input $WORKSPACE_ROOT/state/reviews/pr_review_{pr}.json \
     > "/tmp/pr_post_{pr}.json" 2>&1 || POST_EXIT=$?
   ```
   **Never re-execute this POST.** If parsing fails, re-parse the temp file — do not
   re-run `gh api -X POST`, which submits a duplicate review that cannot be deleted or
   dismissed (GitHub does not allow deleting/dismissing COMMENTED reviews via the API).
3. Capture `html_url` and `submitted_at` from the temp file:
   ```bash
   REVIEW_URL=$(jq -r '.html_url // empty' "/tmp/pr_post_{pr}.json")
   SUBMITTED_AT=$(jq -r '.submitted_at // empty' "/tmp/pr_post_{pr}.json")
   ```
4. **Check the post succeeded** before doing anything else — non-zero exit and/or a missing/empty `REVIEW_URL` both count as failure:
   - **Success** (`POST_EXIT == 0` and `REVIEW_URL` present): continue to steps 5-7 below.
   - **Failure**: the GitHub post did not land, so nothing was actually reviewed at HEAD.
     Do not run Step 11b — marking the record posted here would let
     `check-review.ts`'s `commitSha`/`reviewState` dedup permanently hide this PR from
     future review candidacy even though no review exists on GitHub. Instead:
     1. Release the claim so the record returns to `reviewState: "pending"`:
        ```bash
        curl -s -o /dev/null -X POST \
          -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
          "$SHIPWRIGHT_TASK_STORE_URL/prs/${PR_RECORD_ID}/release"
        ```
     2. Print a warning: `Warning: review post for #{pr} failed (exit {POST_EXIT}) — released claim, will retry next pass.`
     3. Stop — do not proceed to Step 11b.
5. **Self-review ledger write (PFL-5.2).** `isResolvedByLedger` (PFL-3.2) can only exclude a
   self-clean-approve once a ledger entry exists for it — but the PFL-2.1 section above only
   ledgers a *prior* review, evaluated at the start of a *subsequent* pass. A PR whose only
   review ever posted is a clean self-approve never gets a subsequent pass (nothing changed
   to re-review, per `check-review.ts`'s own candidacy gate), so PFL-2.1 never runs for it and
   no ledger entry is ever written — `isResolvedByLedger` stays false for that review forever.
   Close the gap by ledgering THIS pass's own just-posted review immediately, instead of
   waiting for a future pass that may never come. The condition below is exactly the one that
   produces `verdictLabel: APPROVE` in Step 10's truth table (the only row where
   `selfReview` is true and the verdict is a clean approve) — the same condition
   `isSelfCleanApprove` matches against the posted body:
   ```bash
   if [ "$SELF_REVIEW" = "true" ] && [ "$UNADDRESSED_FINDINGS" = "false" ] && \
      [ "$CURRENT_PASS_HAS_BLOCKING_FINDINGS" = "false" ] && [ -n "$SUBMITTED_AT" ]; then
     curl -sf -X POST \
       -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
       -H "Content-Type: application/json" \
       "$SHIPWRIGHT_TASK_STORE_URL/prs/${PR_RECORD_ID}/findings" \
       -d "{\"ref\": \"${headRefOid}@${SUBMITTED_AT}\", \"disposition\": \"resolved\", \"source\": \"review\", \"evidence\": \"Self-review is a clean APPROVE with no blocking findings (recorded at post time, PFL-5.2).\"}" \
       >/dev/null 2>&1 || echo "⚠ ledger POST failed for ${headRefOid}@${SUBMITTED_AT} — continuing (non-fatal)"
   fi
   ```
   `SELF_REVIEW`, `UNADDRESSED_FINDINGS`, and `CURRENT_PASS_HAS_BLOCKING_FINDINGS` carry over
   from Step 10 unchanged. Best-effort, non-fatal on failure — same as PFL-2.1's POSTs — but
   per the PR #89 ordering lesson above, this POST **must complete before step 6 (Step 11b's
   `/complete` call)** runs next, not deferred to "near the end of the turn."
   **Scoping note:** this step only fires on this direct-post path. `/shipwright:review-staged`'s
   separate "post it" action, which also runs Step 11b, does not populate `SUBMITTED_AT` — the
   `if` above simply no-ops there today (a known, flagged follow-up, not a silent gap: staged
   posting is the non-default `auto_post_reviews: false` path).
6. Run Step 11b to mark the PR record posted.
7. Print: `Posted review for #{pr}: {REVIEW_URL}`

### If `auto_post_reviews` is false (staged):

1. Mark the PR record staged, persisting the verdict so the APPROVE-first sort in
   `/shipwright:review-staged` works correctly. Both branches also release the claim
   (`claimedBy`/`claimedAt`/`heartbeatAt`/`phase` all cleared to `null`, mirroring
   `pull-request-service.ts`'s `patch()` claim-clearing) — the review-writing work is
   done regardless of posting status, so nothing should keep holding the claim:

   If `{verdict}` is `APPROVE`:
   ```bash
   curl -sf -X PATCH \
     -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
     -H "Content-Type: application/json" \
     "$SHIPWRIGHT_TASK_STORE_URL/prs/${PR_RECORD_ID}" \
     -d '{"staged": true, "reviewState": "approved", "reviewedCommitSha": "{headRefOid}", "claimedBy": null, "claimedAt": null, "heartbeatAt": null, "phase": null}' >/dev/null
   ```

   If `{verdict}` is `COMMENT`:
   ```bash
   curl -sf -X PATCH \
     -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
     -H "Content-Type: application/json" \
     "$SHIPWRIGHT_TASK_STORE_URL/prs/${PR_RECORD_ID}" \
     -d '{"staged": true, "reviewState": "posted", "reviewedCommitSha": "{headRefOid}", "claimedBy": null, "claimedAt": null, "heartbeatAt": null, "phase": null}' >/dev/null
   ```

   (`PR_RECORD_ID` is the claim response `.id` from Step 4.)
2. Print: `Review staged for #{pr}.`

---

## Step 11b: Mark PullRequest Record Posted

Run this step immediately after posting a review. The only place this command posts is Step 11's `auto_post_reviews: true` (default) path; `/shipwright:review-staged`'s `post it` action also runs this step (after its own staged-flag clear, which is the one thing this step doesn't do) since posting-then-completing is identical either way. Skip this step when the review is staged (not posted).

**Precondition:** any findings-ledger POSTs from this pass — chiefly Step 5's PFL-2.1 section — must already have completed before the `/complete` call below runs. Do not run this step and then circle back to Step 5's ledger POSTs afterward: that ordering is exactly what produced the PR #89 race (see Step 5's PFL-2.1 subsection for the timeline), where `reviewedAt` got stamped before same-pass ledger findings landed, tricking `hasFreshLedgerFinding` into treating stale self-review judgments as fresh and spuriously re-claiming the PR on the next loop tick.

Use `{verdict}` and `PR_RECORD_ID` — from Step 10 and the claim in Step 4 respectively when called from this command; `record.reviewState == "approved" ? APPROVE : COMMENT` and `record.id` respectively when called from `/shipwright:review-staged`.

### 1. Confirm the record ID

```bash
if [ -z "$PR_RECORD_ID" ]; then
  echo "Warning: no PR record ID available — skipping"
else
```

Wrap steps 2–3 in the `else` branch and close with `fi` after step 3.

### 2. Mark review as posted

```bash
curl -sf -X POST \
  -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
  "${SHIPWRIGHT_TASK_STORE_URL}/prs/${PR_RECORD_ID}/complete" >/dev/null 2>&1
```

### 3. Set agentId, reviewedCommitSha (and reviewState for APPROVE)

Set `agentId` from `$SHIPWRIGHT_AGENT_ID` and `reviewedCommitSha` from `{headRefOid}` (same shell variable used elsewhere in Step 11, e.g. lines 926, 935 — no re-fetch). For APPROVE verdicts, also set `reviewState=approved`; for COMMENT/CHANGES_REQUESTED, set agentId and reviewedCommitSha only:

```bash
if [ "{verdict}" = "APPROVE" ]; then
  PATCH_DATA="{\"agentId\": \"$SHIPWRIGHT_AGENT_ID\", \"reviewState\": \"approved\", \"reviewedCommitSha\": \"{headRefOid}\"}"
else
  PATCH_DATA="{\"agentId\": \"$SHIPWRIGHT_AGENT_ID\", \"reviewedCommitSha\": \"{headRefOid}\"}"
fi
curl -sf -X PATCH \
  -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
  -H "Content-Type: application/json" \
  "${SHIPWRIGHT_TASK_STORE_URL}/prs/${PR_RECORD_ID}" \
  -d "$PATCH_DATA" >/dev/null 2>&1
fi
```

**Never update task status when posting a review.** The deploy skill looks up tasks by PR number (expecting `status: 'pr_open'`) to perform post-deployment tracking — changing task status here breaks that linkage. Task status transitions are owned by the deploy skill (`pr_open` → `deployed`). This applies to the task store *task* record only; the PR *record* updates above (`complete`, `agentId`, `reviewState`) are expected.

---
## Step 14: Resolve and Claim the Target PR

This command always runs against a single explicitly-named PR (e.g.
`/shipwright:review app-vitals/shipwright#123` or `/shipwright:review 123`) — see the
Arguments section for the required no-argument `[silent]` stop.

1. Parse the argument: extract `org`, `repo`, and `pr` number. If `$ARGUMENTS` has a
   trailing `[preclaim:{recordId}:{commitSha}]` marker (see Arguments section), extract
   `PRECLAIM_RECORD_ID` and `PRECLAIM_COMMIT_SHA` from it and strip the marker before
   parsing the rest of the argument. For bare numbers, infer `org/repo` via:
   ```bash
   curl -sf -H "Authorization: Bearer $SHIPWRIGHT_AGENT_API_KEY" \
     "$SHIPWRIGHT_API_URL/agents/$SHIPWRIGHT_AGENT_ID/config" | jq -r '.repos[0] // empty'
   ```
   Fall back to the current workspace repo if the command fails.
   **Limitation**: bare numbers only check the first configured repo (`repos[0]`). Multi-repo agents should use the full `org/repo#number` form to target a PR in any repo beyond the first.

### Live-Review Pre-Check (RVD-1.2)

Run this **before** the Pre-Claim Fast Path below and before any task-store record fetch —
and even when a pre-claim marker is present. A pre-claim marker only proves the
orchestrator's own task-store instance had this PR queued; it says nothing about whether
some OTHER reviewer (an agent running against a different task-store instance, or a human)
already posted a terminal review at this exact head commit. This is the cross-task-store
defense layer described at the top of this file — it catches the race window between
candidate selection and dispatch, and the case of a human invoking this command directly
with an explicit PR#, both of which the task-store-record dedup further down in Step 14
can't see.

Query GitHub directly for reviews at the current head commit. This runs before Step 9.5's
own assignment (Step 14 executes ahead of Step 4/5/9.5 in the actual flow — see the
Arguments section), so re-resolve it here rather than assuming a shell variable set later
in the file's step numbering is already populated:

```bash
CURRENT_USER={the login resolved in Step 3}
```

```bash
precheck=$(gh api graphql -f query='
{
  repository(owner: "{org}", name: "{repo}") {
    pullRequest(number: {pr}) {
      author {
        login
      }
      headRefOid
      comments(last: 50) {
        nodes {
          author {
            login
          }
          createdAt
        }
      }
      reviews(first: 50) {
        nodes {
          body
          state
          submittedAt
          commit {
            oid
          }
        }
      }
    }
  }
}' | jq --arg currentUser "$CURRENT_USER" '.data.repository.pullRequest as $pr | ([$pr.reviews.nodes[] | select(.commit.oid == $pr.headRefOid and ((.body | test("verdict\\**\\s*:\\s*\\**(approve|comment)\\b"; "i")) or .state == "APPROVED")) | .submittedAt] | max) as $maxTerminalSubmittedAt | {headRefOid: $pr.headRefOid, terminal: (if $maxTerminalSubmittedAt != null then ([$pr.comments.nodes[] | select(.author.login != $currentUser and (.createdAt > $maxTerminalSubmittedAt)) | .createdAt] | length == 0) else false end)}')
headRefOid=$(echo "$precheck" | jq -r '.headRefOid')
terminal=$(echo "$precheck" | jq -r '.terminal')
```

`gh api`'s own `--jq`/`-q` flag does not support `--arg` — that's a `jq`-binary-only
flag for injecting external variables into a filter. Passing `--arg` to `gh api` fails
with `unknown flag: --arg`. Pipe the raw GraphQL response into the real `jq` binary
instead, where `--arg` is supported.

This filters reviews down to only those submitted at the current `headRefOid`, then tests
whether ANY of them is terminal — either its body matches a terminal verdict label, or its
`state` is `APPROVED` (a plain GitHub UI approval, typically with an empty or `LGTM` body
and no `Verdict:` line, still counts). If a terminal review exists, the query also fetches
the PR's comments (with author and `createdAt`), and the jq program computes whether anyone
_other than_ the resolved `$CURRENT_USER` (the reviewing agent's own identity, threaded in
via `--arg currentUser "$CURRENT_USER"`) has posted a comment _after_ the latest terminal
review's `submittedAt` timestamp. If such a fresh non-agent comment exists, `terminal` is
set to `false` (mirrors `hasFreshNonAgentComment` in `agent/src/check-review.ts`, which
applies the same broadened fresh-reply logic — any commenter other than the reviewing
agent, not just the PR author — at the TypeScript layer). The jq program outputs a JSON
object with the `headRefOid` string and a `terminal` boolean, captured into shell variables
of the same names.

This bash `select(...)` predicate (`(.body | test(...)) or .state == "APPROVED"`) mirrors
`agent/src/check-helpers.ts`'s exported `isTerminalReviewLabel()` — the single documented
source of truth for "already reviewed, terminal at this commit": a literal `Verdict:`
label match (`VERDICT_TERMINAL_LABEL`) OR a live `state === "APPROVED"`, rather than the
fuller thread/finding-body analysis `classifyReviewState()` does. The `Verdict:` half is
sufficient for review.md's own postings (Step 10 always carries an explicit
`Verdict: APPROVE` or `Verdict: COMMENT` line); the `state === "APPROVED"` half is what
catches a plain human or bot APPROVE submitted through the GitHub UI with no `Verdict:`
text, which the label match alone would silently miss and let a duplicate review get
posted. There is no author filtering on the terminal review check itself (any author's
review counts) — the fresh-reply exception is the only place author identity matters: it
checks whether anyone other than the reviewing agent itself (`$CURRENT_USER`) has replied
after the review, mirroring `hasFreshNonAgentComment` in `agent/src/check-review.ts`.

**If `$terminal` is `true`** (a terminal review already exists at head on GitHub):

Before printing the skip message, write this terminal outcome back to the task-store PR
record so the same mis-selection doesn't recur every tick — this is the fix for the
cross-task-store race this whole pre-check exists to catch: if the record's `reviewState`
doesn't already reflect "reviewed at this head", the next tick's candidate selection
(`check-review.ts`) or another pre-check run sees a stale `pending` (or a `posted` record
pinned to an older commit) and re-selects this PR again, indefinitely. This write-back is a
single atomic step, mirroring Step 5's and Step 14.3's write-backs — neither of them issues
a separate release call either — because the task-store auto-clears
`claimedBy`/`claimedAt`/`heartbeatAt`/`phase` server-side whenever `reviewState` transitions
to `posted`. So any inherited pre-claim (`PRECLAIM_RECORD_ID` non-empty) is cleared as a
side effect of the very same write below; there is no separate release step, and no window
where the PR sits claimed but still `pending` in between.

Determine `PR_RECORD_ID`: reuse `PRECLAIM_RECORD_ID` directly if it was set (it already
names the correct record — no extra fetch needed). Otherwise look the record up by
repo+prNumber, the same lookup Step 14's Pre-Claim Fast Path uses below:
```bash
if [ -n "$PRECLAIM_RECORD_ID" ]; then
  PR_RECORD_ID="$PRECLAIM_RECORD_ID"
  record=$(curl -sf -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
    "$SHIPWRIGHT_TASK_STORE_URL/prs/${PR_RECORD_ID}")
else
  record=$(curl -sf -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
    "$SHIPWRIGHT_TASK_STORE_URL/prs?repo={org}/{repo}&prNumber={pr}" | jq -c '.prs[0] // empty')
  PR_RECORD_ID=$(echo "$record" | jq -r '.id // empty')
fi
recordReviewState=$(echo "$record" | jq -r '.reviewState // empty')
recordReviewedCommitSha=$(echo "$record" | jq -r '.reviewedCommitSha // empty')
```

Only PATCH when the record doesn't already reflect this outcome — avoid a double-write when
it's already correct. The record is already correct when `reviewState` is `posted` or
`approved` AND `reviewedCommitSha` already equals `headRefOid`; a `posted`/`approved` record
still pinned to an older commit (`reviewedCommitSha != headRefOid`) is stale and needs the
write. The PATCH also advances `reviewedAt` to the current time, computed once as `$NOW` —
this closes the `hasFreshNonAgentComment` perpetual-retrigger gap (RCT-1.1/RVG-1.1):
`agent/src/check-review.ts`'s `hasFreshNonAgentComment` uses `reviewedAt` as its "is there new
activity since we last looked" watermark, and without advancing it here, any comment at or
after this head commit — including the terminal review itself — would look perpetually fresh
against a frozen watermark, causing this PR to be re-selected for review on every subsequent
tick indefinitely:
```bash
if [ -n "$PR_RECORD_ID" ] && ! { [ "$recordReviewState" = "posted" -o "$recordReviewState" = "approved" ] && [ "$recordReviewedCommitSha" = "$headRefOid" ]; }; then
  NOW=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
  curl -sf -X PATCH \
    -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
    -H "Content-Type: application/json" \
    "$SHIPWRIGHT_TASK_STORE_URL/prs/${PR_RECORD_ID}" \
    -d '{"reviewState": "posted", "reviewedCommitSha": "'"$headRefOid"'", "reviewedAt": "'"$NOW"'"}' >/dev/null
fi
```
Note this PATCH sets `reviewedCommitSha` only, not `commitSha` — `commitSha` is the separate
claim-lock field (overwritten on every claim, per Rule 2 in this plugin's design
constitution) and this code path takes no claim, so there's nothing to lock; only the
review-dedup field (`reviewedCommitSha`) is meaningful here.

**Caveat (why this is safe against the CHU-2.4 reconciler):** `agent/src/pr-state-reconciler.ts`'s
background `reconcileReviewState()` runs a posted-scan sub-pass via
`reconcilePostedReviewStateRecord()`, which reverts a `posted` record back to `pending` only
when `hasAnyReviewAtHead()` returns `false` for that record's live GitHub data — i.e. only
when NO review object exists at the current head commit at all. This write-back only ever
runs when `$terminal == true`, which by construction means a real, terminal-labeled review
object was found at `headRefOid` by the GraphQL query above — so `hasAnyReviewAtHead()` is
guaranteed `true` for this record on the very next reconcile pass, and
`reconcilePostedReviewStateRecord()` takes its `"no-op"` branch, leaving the record
untouched. Unlike the Step 5 "unresolved human feedback" write-back above (whose caveat
applies when the trigger is a plain issue-level PR comment with no accompanying formal
review object), there is no equivalent gap here: a formal review object is exactly what
`$terminal == true` asserts exists.

Then print:
```
Skipping #{pr} — a review already exists at this commit (${headRefOid:0:7}) on GitHub (cross-task-store check), nothing to do.
```

Emit `[skip-reason:review:deferred:already-reviewed-at-head:{pr}]` immediately before the
following `[silent]` marker (interpolating `{pr}` from the value above) — this defer is a
legitimate backstop, not a genuine no-op, and without the tagged reason the loop
orchestrator's generic `[silent]` handling would count it toward `SKIP_BLOCK_THRESHOLD`,
risking a false HITL auto-block (see `agent/src/loop-orchestrator.ts`).

Respond `[silent]`. Stop. No claim, no checkout (no worktree checkout happens).

**If `$terminal` is `false`**: continue to the Pre-Claim Fast Path subsection immediately
below, unchanged.

### Pre-Claim Fast Path (CBD-1.4)

If a pre-claim marker was captured above, validate it against the live head before
trusting it — a marker is only safe to trust if nothing has changed since the orchestrator
claimed this PR:

```bash
headRefOid=$(gh pr view {pr} --repo {org}/{repo} --json headRefOid -q '.headRefOid')
```

- **`headRefOid == PRECLAIM_COMMIT_SHA`** (marker is current): trust it. Set
  `PR_RECORD_ID = PRECLAIM_RECORD_ID` and skip the record fetch, staged-review check, and
  dedup check below entirely — the orchestrator's candidate provider (`check-review.ts`)
  already qualified this PR fresh, and its `/prs/claim` call already flipped `reviewState`
  to `in_progress` server-side. `LAST_REVIEWED_COMMIT` is unset on this path (no record
  fetch happened) — Step 5's Unresolved Comment Check treats this the same as a first
  review and runs its checks. Go directly to **Step 4**, skipping Step 4's own
  `/prs/claim` call (the "Claim using pre-captured commit SHA" subsection) since this PR
  is already claimed under `PR_RECORD_ID`.
- **`headRefOid != PRECLAIM_COMMIT_SHA`** (stale marker — new commits landed between
  orchestrator selection and dispatch) **or no marker present**: fall back to
  self-claiming exactly as today — continue with step 2 below unchanged.

2. Fetch the PR record from the task store:
   ```bash
   curl -sf -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
     "$SHIPWRIGHT_TASK_STORE_URL/prs?repo={org}/{repo}&prNumber={pr}" | jq -c '.prs[0] // empty'
   ```
   Capture the record's `id` as `PR_RECORD_ID` and `reviewedCommitSha` as `lastReviewedCommit`.

**This command never posts a staged review — posting a staged review is owned exclusively
by `/shipwright:review-staged`.** `/shipwright:review` only ever produces or refreshes
review content. The one thing a targeted invocation does with an existing staged record
is refresh it if it's gone stale — nothing more.

**If a record exists with `staged: true`**:

Fetch the current head commit and compare to `record.reviewedCommitSha` (`lastReviewedCommit`):
```bash
gh pr view {pr} --repo {org}/{repo} --json headRefOid --jq '.headRefOid'
```

- **`headRefOid == record.reviewedCommitSha`** (no new commits — the staged review is still
  current, nothing to refresh). Translate `record.reviewState` to a verdict the same way
  `/shipwright:review-staged` does (`approved` → APPROVE, `posted`/`in_progress` → COMMENT),
  then print:
  ```
  #{pr} already has a staged review ({verdict}) waiting on a decision.
  Run /shipwright:review-staged to post, skip, or discuss it.
  ```
  Stop.
- **`headRefOid != record.reviewedCommitSha`** (author pushed new commits since staging — the
  staged review is stale and needs a refresh). Re-claim the record at the new head to
  flip it to `in_progress`:
  ```bash
  curl -sf -X POST \
    -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
    -H "Content-Type: application/json" \
    "$SHIPWRIGHT_TASK_STORE_URL/prs/claim" \
    -d "{\"repo\": \"{org}/{repo}\", \"prNumber\": {pr}, \"commitSha\": \"{headRefOid}\"}" >/dev/null
  ```
  Print:
  ```
  Staged review is stale — {pr} has new commits since the review was written ({record.reviewedCommitSha[0..7]} → {headRefOid[0..7]}).
  Re-reviewing now.
  ```
  Continue from **Step 4** (checkout into worktree) with this PR as the target. The
  Step 9 "Re-Review (Update)" mechanics append an update section to the existing
  `$WORKSPACE_ROOT/state/reviews/PR_REVIEW_{pr}.md`, and Step 11 re-stages the record — the same
  policy-gated staging path any other review goes through. This command never posts
  it; running `/shipwright:review-staged` afterward is how the owner acts on it.

**If no record or record is not staged** — review it:

3. **Check if the PR was already reviewed at the current commit** (defense-in-depth dedup):

   If a record exists (from Step 14.2, `lastReviewedCommit` is non-empty) AND
   `record.reviewState` is `posted` or `approved` (a review was actually posted, not just
   claimed and abandoned — see `release()`, which sets `reviewState: "pending"` on an
   incomplete claim), fetch the current head commit:
   ```bash
   gh pr view {pr} --repo {org}/{repo} --json headRefOid --jq '.headRefOid'
   ```
   Compare to `record.reviewedCommitSha` (`lastReviewedCommit`). If `headRefOid == record.reviewedCommitSha`
   (the commit has already been reviewed and there are no new commits):
   - Print:
     ```
     Skipping #{pr} — already reviewed at this commit ({headRefOid[0..7]}), nothing to do.
     ```
   - Emit `[skip-reason:review:deferred:already-reviewed-at-head:{pr}]` immediately before
     the following `[silent]` marker (interpolating `{pr}` from the value above) — this
     defer is a legitimate backstop, not a genuine no-op, and without the tagged reason the
     loop orchestrator's generic `[silent]` handling would count it toward
     `SKIP_BLOCK_THRESHOLD`, risking a false HITL auto-block (see
     `agent/src/loop-orchestrator.ts`).
   - PATCH the already-fetched record (`PR_RECORD_ID`) to write back a terminal state
     before stopping — no extra query, reuses the record fetched in step 2 above. This is
     unconditional (mirroring the Step 5 precedent), not guarded on `record.reviewState`:
     the entry condition above already requires `record.reviewState` to be `posted` or
     `approved` to reach this point, so a guard re-checking the same unmutated field would
     be dead code. Also advance `reviewedAt` to the current time (captured once as `{now}`,
     an ISO-8601 UTC timestamp, e.g. `date -u +"%Y-%m-%dT%H:%M:%SZ"`) — this closes the
     `hasFreshNonAgentComment` perpetual-retrigger gap (RCT-1.1/RVG-1.1): without advancing
     it here, any activity at or after this head commit would look perpetually fresh against
     a frozen watermark in `agent/src/check-review.ts`'s `hasFreshNonAgentComment`, causing
     this PR to be re-selected for review on every subsequent tick indefinitely:
     ```bash
     curl -sf -X PATCH \
       -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
       -H "Content-Type: application/json" \
       "$SHIPWRIGHT_TASK_STORE_URL/prs/{PR_RECORD_ID}" \
       -d '{"reviewState": "posted", "reviewedCommitSha": "{headRefOid}", "reviewedAt": "{now}"}' >/dev/null
     ```
   - Respond `[silent]`. Stop.

   If no record exists (first review), or `record.reviewState` is `pending` (claimed but
   never completed — never actually reviewed), or `headRefOid` differs from
   `record.reviewedCommitSha` (new commits exist), proceed to Step 4 below.

4. Go directly to Step 4 (checkout) with this specific PR as the target.

---

## Review Quality Rules

These rules are non-negotiable regardless of policy settings:

- **Verify before flagging**: check actual code, not just the diff. Confirm library
  versions, check if both branches of a conditional do the same thing.
- **Check scope**: `git show origin/{base}:{file}` -- if the issue exists on the base branch,
  it's out of scope.
- **Don't echo CI**: don't call out failing tests unless confident your findings are
  the cause.
- **Don't contradict CLAUDE.md**: don't suggest patterns the project explicitly avoids.
- **No filler language**: no "FYI", "Note:", "Just a heads up". Be direct.
- **Keep it tight**: 2-5 actionable items. Drop low-confidence suggestions and nitpicks.
- **Organize by file and line**: list issues in diff order.
- **Never REQUEST_CHANGES**: only APPROVE or COMMENT.
- **APPROVE means clean**: any finding at important or critical severity means COMMENT —
  APPROVE is reserved for PRs with no blocking concerns (suggestions only, or none at all).
- **Check for unresolved feedback first**: this is mechanically enforced, not just a soft
  guideline — Step 9.5's unaddressed-findings hard gate forces `event`/`Verdict: ...` to
  `COMMENT` whenever a qualifying unresolved review or inline thread exists at head, even if
  the code-reviewer subagent recommends APPROVE.
- **Concise approvals**: if all items are addressed with no new issues, a brief APPROVE
  to unblock is more valuable than a detailed duplicate review.
- **Breaking API changes**: assume rolling deployments. Flag removed endpoints, changed
  shapes, renamed fields as critical.
