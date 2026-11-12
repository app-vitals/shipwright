# patch-lean: target resolution and list classification

Mechanics for `commands/patch-lean.md` Steps 1, 2, 2.5 and 3 (3a–3d). Moved from `commands/patch.md`
unchanged in behavior. **This command does not read `state/reviews.json`.** All data comes from GitHub
directly.

## Step 1: Own login and patch-author allowlist (PAS-1.1)

`CURRENT_USER` is the **canonical** login (the `app/` prefix and `[bot]` suffix stripped, lowercased)
from the shared login-identity helper, which resolves it via GraphQL `viewer` — the REST `/user`
endpoint 403s under installation tokens:

```bash
CURRENT_USER=$(bun run "${CLAUDE_PLUGIN_ROOT}/scripts/login-identity.ts")
```

The allowlist is an additive list of GitHub logins, beyond `CURRENT_USER`, whose own open PRs this
agent may patch. It mirrors `check-patch.ts`'s `patchAuthorAllowlistRef` (RAS-1.1/DBR-1.4):

```bash
PATCH_AUTHOR_ALLOWLIST=$(curl -sf -H "Authorization: Bearer $SHIPWRIGHT_AGENT_API_KEY" \
  "$SHIPWRIGHT_API_URL/agents/$SHIPWRIGHT_AGENT_ID/config" | jq -c '.patchAuthorAllowlist // []')
PATCH_AUTHOR_ALLOWLIST=${PATCH_AUTHOR_ALLOWLIST:-[]}
```

Keep it a **JSON array**, not a comma-joined string, so Step 2 can test exact membership.
**Fail-closed, not fail-open:** any curl failure, or an absent/empty `.patchAuthorAllowlist`, yields
`[]` — scope falls back to `CURRENT_USER` only. An unreachable config endpoint must never be read as
"allow everyone".

## Step 2: Resolve the target PR and check scope

Strip a trailing `[preclaim:{recordId}:{commitSha}]` marker first (extract `PRECLAIM_RECORD_ID` /
`PRECLAIM_COMMIT_SHA` once; leave them unset when there is no marker — the claim sites then
self-claim). Then:

```bash
gh pr view {number} --repo {org}/{repo} \
  --json number,title,headRefName,headRefOid,additions,deletions,mergeStateStatus,state,author
```

Capture `PR_AUTHOR` (`.author.login`), `PR_TITLE` (`.title`) and `PR_HEAD_REF` (`.headRefName`) from
the same JSON. `PR_AUTHOR` is reused by Step 5a.7's author-reply detection; all three are passed to
every `/prs/claim` call so the task store can derive `origin` server-side (POM-1.2).

In-scope test — an **exact** membership check, never a substring one:

```bash
# In scope iff PR_AUTHOR is CURRENT_USER, or equals an allowlist entry exactly — both
# compared in canonical form (CURRENT_USER is already canonical; `gh pr view` reports a bot
# as "app/<slug>", so strip/lowercase PR_AUTHOR and each allowlist entry the same way).
# `jq -e` exits 0 only when some element is equal to $a, and exits non-zero on `false` OR
# on malformed/empty input — so a failed config fetch in Step 1 fails closed here rather
# than widening scope.
PR_AUTHOR_CANON=$(printf '%s' "$PR_AUTHOR" | sed -E 's#^app/##; s#\[bot\]$##' | tr '[:upper:]' '[:lower:]')
if [ "$PR_AUTHOR_CANON" = "$CURRENT_USER" ] || \
   printf '%s' "$PATCH_AUTHOR_ALLOWLIST" \
     | jq -e --arg a "$PR_AUTHOR_CANON" 'def canon: sub("^app/"; "") | sub("\\[bot\\]$"; "") | ascii_downcase; any(.[]; canon == $a)' >/dev/null 2>&1; then
  IN_SCOPE=true
else
  IN_SCOPE=false
fi
```

Do **not** substitute `[[ "$PATCH_AUTHOR_ALLOWLIST" == *"$PR_AUTHOR"* ]]`: `bot` would match an
allowlisted `dependabot`, and patch takes write actions.

- **Not found, `state != "OPEN"`, or `IN_SCOPE` is false** (canonical `author.login != CURRENT_USER`
  and not equal to any allowlist entry): print `⚠ PR {org}/{repo}#{number} not found among own open PRs.`
  and stop.
- **Match found**: it is the sole entry in the PR list; continue to Step 2.5.

## Step 2.5: BEHIND / DIRTY

Use the `mergeStateStatus` already fetched in Step 2.

**BEHIND (no conflict).** Key off `mergeStateStatus == "BEHIND"` itself — do not read branch
protection (agent tokens 403 on it) and do not use compare/`behind_by`. Applies to self-authored and
allowlisted PRs alike. Merge the base in — **not** `--rebase`:

```bash
gh pr update-branch {number} --repo {org}/{repo}
```

- Exit 0: re-resolve `headRefOid` (`gh pr view {number} --repo {org}/{repo} --json headRefOid -q '.headRefOid'`)
  before Step 3c, since the update pushed a new commit. Print
  `↻ PR #{number} was BEHIND — branch updated from base, continuing normal flow`.
- Non-zero: log it and continue without escalating; do not add the PR to any list. A real conflict
  surfaces as `DIRTY`.

**DIRTY.**

```bash
gh pr update-branch --rebase {number} --repo {org}/{repo}
```

- Exit 0: print `↻ PR #{number} was DIRTY — auto-rebased successfully, continuing normal flow`; it
  will no longer be DIRTY in Step 3b.
- Non-zero: the PR is classified into List C in Step 3b and resolved in a worktree in Step 4.

## Step 3: Classify into Lists A, C, D

The PR may land in several lists; all applicable fixes run in step order (C → A → D).

### 3a: Unaddressed review findings (List A)

```bash
SHIPWRIGHT_GH_OWNER={org} gh api graphql -f query='
{
  repository(owner: "{org}", name: "{repo}") {
    pullRequest(number: {pr}) {
      headRefOid
      reviews(first: 50) {
        nodes {
          author { login __typename }
          state
          submittedAt
          body
          commit { oid }
        }
      }
      reviewThreads(first: 100) {
        nodes {
          id
          isResolved
          comments(first: 1) {
            totalCount
            nodes {
              author { login __typename }
              body
              path
              line
            }
          }
        }
      }
      comments(first: 50) {
        nodes {
          author { login __typename }
          body
          createdAt
        }
      }
    }
  }
}'
```

Keep each `_JSON` value as the **full connection object** (`{ nodes: [...] }`):

```bash
HEAD_REF_OID=$(jq -r '.data.repository.pullRequest.headRefOid' <<< "$RESPONSE")
REVIEWS_JSON=$(jq -c '.data.repository.pullRequest.reviews' <<< "$RESPONSE")
REVIEW_THREADS_JSON=$(jq -c '.data.repository.pullRequest.reviewThreads' <<< "$RESPONSE")
COMMENTS_JSON=$(jq -c '.data.repository.pullRequest.comments' <<< "$RESPONSE")
```

`COMMENTS_JSON` is reused unchanged by Step 5a (bot filter) and Step 5a.7 (author replies).

Fetch the PR record's findings ledger (fail soft to `[]`, never a hard stop):

```bash
if [ -n "$PRECLAIM_RECORD_ID" ]; then
  PR_FINDINGS_JSON=$(curl -sf -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
    "$SHIPWRIGHT_TASK_STORE_URL/prs/$PRECLAIM_RECORD_ID" | jq -c '.findings // []' 2>/dev/null || echo '[]')
else
  PR_FINDINGS_JSON=$(curl -sf -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
    "$SHIPWRIGHT_TASK_STORE_URL/prs?repo={org}/{repo}&prNumber={pr}" | jq -c '.prs[0].findings // []' 2>/dev/null || echo '[]')
fi
```

**List A membership is computed mechanically, not freehand** (PVD-1.1 — the same module
`check-patch.ts` and `review.md` Step 9.5 use):

```bash
bun run "${CLAUDE_PLUGIN_ROOT}/scripts/compute-unaddressed-findings.ts" \
  "$(jq -n --arg currentUser "$CURRENT_USER" \
    --arg prAuthor "$PR_AUTHOR" \
    --arg headRefOid "$HEAD_REF_OID" \
    --argjson reviews "$REVIEWS_JSON" \
    --argjson reviewThreads "$REVIEW_THREADS_JSON" \
    --argjson comments "$COMMENTS_JSON" \
    --argjson findings "$PR_FINDINGS_JSON" \
    '{currentUser: $currentUser, prAuthor: $prAuthor, headRefOid: $headRefOid, reviews: $reviews, reviewThreads: $reviewThreads, comments: $comments, findings: $findings}')"
# -> {"unaddressedFindings":true|false}
```

`true` → List A; `false` → not List A. Do not override it by narrative judgment. Only these settle a
review or thread (the script's unit tests are the authoritative spec): a ledger entry
(`isResolvedByLedger`, or a patch `rejected` entry via `isRejectedByPatchLedger`); a later `APPROVED`
review by the same reviewer at the same head (`isSupersededBySameHeadApproval`); a PR-author reply
after the review (`isAddressedByAuthorReply`) or within the thread (`isThreadAddressedByAuthorReply`).

**A clean self-APPROVE with no ledger entry IS in List A.** Such a PR must not exit `[silent]`; Step
5c.5 settles it with a `rejected` ledger entry ("review contains no actionable finding").

Store the unresolved threads (with `id`, needed by `resolveReviewThread`) and review bodies for Step 5.

If the spine's dependency-risk trigger fires, apply [dependency-risk.md](dependency-risk.md) here,
before 3b.

### 3b: DIRTY state (List C)

```bash
gh pr view {pr} --repo {org}/{repo} --json mergeStateStatus
```

`"DIRTY"` → List C. `"BEHIND"` is handled in Step 2.5 and never joins List C. Store the value — do
not re-fetch in 3c.

### 3c: Failing CI (List D), only for PRs not in List C

DIRTY PRs have unreliable CI until the conflict is resolved.

```bash
gh api "repos/{org}/{repo}/actions/runs?head_sha={headRefOid}&per_page=20" \
  -q '.workflow_runs[] | {id, workflow_id, run_number, conclusion}'
```

Judge only each workflow's **latest run** (highest `run_number` per `workflow_id`) — a rerun appears
as a separate entry, so evaluating every historical run would false-positive on a failed-then-passed
workflow (mirrors `gh pr checks`).

- Latest run `conclusion == "failure"` or `"timed_out"` → List D, `CI_HAS_FAILING=true`.
- **Stale-cancelled CI (PCC-1.1):** latest run `conclusion == "cancelled"` (e.g. a job that hit
  `timeout-minutes` and was reported as `cancelled`) → List D (if not already), `CI_HAS_CANCELLED=true`,
  and `CANCELLED_RUN_ID` = that run's `id` (highest `run_number` wins across workflows). Checked
  independently of the failing check; both can be true.

A cancelled-only PR (`CI_HAS_CANCELLED=true`, `CI_HAS_FAILING` not true) goes through Step 6b.8's
rerun-first branch; a PR with a genuine failure goes straight to 6c.

### 3d: Summary

Empty-lists exit: see the spine (pre-claim release, `[silent]`,
`[skip-reason:patch:deferred:no-op-at-dispatch:{pr}]`). The skip-reason records which PR found no work
in `AgentCronRun.skipReason` instead of the generic `command:no-work`, so the orchestrator's
SKIP_BLOCK_THRESHOLD handling classifies it correctly. Order relative to `[silent]` does not matter.

Otherwise print:

```
Found {A} PR(s) with unaddressed review findings, {C} PR(s) with merge conflicts, {D} PR(s) with failing CI:
  Review findings:  {for each in List A: "#{pr} — {title} ({org}/{repo})"}
  Merge conflicts:  {for each in List C: "#{pr} — {title} ({org}/{repo})"}
  Failing CI:       {for each in List D: "#{pr} — {title} ({org}/{repo})"}
```
