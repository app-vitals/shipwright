---
description: Address unresolved review findings, merge conflicts, and failing CI on a specific own open PR — queries GitHub directly, fixes in worktree, pushes
argument-hint: "<org/repo#number>"
---

# Patch

Check one given PR for three conditions: unaddressed review/PR comments, merge conflicts
with base, and failing CI. Apply the appropriate fix. Goes silent when nothing needs
addressing, or when no target PR is given.

> **Note:** Branches merely BEHIND main (no conflict) are not patch-worthy. Main is only
> merged into a branch to resolve an actual conflict — see Step 2.5 and Step 4 for the
> conflict-only (DIRTY) path.

**This command runs autonomously. Do not pause for user input.**

> **Task store setup:** This command records patch cycles in the Shipwright task store after pushing fixes. If `SHIPWRIGHT_TASK_STORE_URL` or `SHIPWRIGHT_TASK_STORE_TOKEN` is missing, invoke `/shipwright:task-store` for setup instructions.

---

## Arguments

Parse `$ARGUMENTS`:
- `org/repo#number` (e.g. `app-vitals/shipwright#123`): **required** — target a specific
  PR. Fetch just this PR (still scoped to `CURRENT_USER` as author, or an entry in the
  agent's configured `patchAuthorAllowlist`, per the Independence Principles' "own PRs only"
  rule for patch — see Step 1/Step 2, PAS-1.1) and classify it into Lists A/C/D as usual from
  Step 3 onward.
- _(no arguments)_: not supported — respond `[silent]` and stop, with no GitHub scan across
  all open PRs (see Step 0).
- Optional trailing **pre-claim marker** — `[preclaim:{recordId}:{commitSha}]` — appended
  after `org/repo#number` by the loop orchestrator (`agent/src/loop-orchestrator.ts`'s
  `formatPreClaimMarker`, CBD-1.3) when it already claimed this PR in the task store before
  dispatch, e.g. `app-vitals/shipwright#123 [preclaim:ckz1abc123:8cb7b38cdb6a...]`. When
  present, strip it before parsing `org/repo#number` above — Step 2 extracts
  `PRECLAIM_RECORD_ID`/`PRECLAIM_COMMIT_SHA` from it once, and each claim site's Pre-Claim
  Fast Path (Steps 4a.6/5a.6/6b.5) independently re-validates the marker against that site's
  freshly-fetched live head before trusting it. A human invoking this command directly never
  supplies this marker; it is only ever produced by the loop orchestrator.

---

## Step 0: Require Explicit Target

If `$ARGUMENTS` is empty, append `[silent]` and stop. An explicit `org/repo#number` target
is required — patch no longer discovers PRs by scanning all own open PRs across configured
repos.

Otherwise, proceed to Step 1.

---

## Step 1: Get Own GH Login

Resolve the current GitHub CLI user once and remember the value — substitute it directly
into all subsequent commands that need it:

```bash
CURRENT_USER=$(gh api /user -q '.login')
```

Also resolve the agent's configured patch-author allowlist (PAS-1.1) — an additive list of
GitHub logins, beyond `CURRENT_USER`, whose own open PRs this agent may patch. This mirrors
`check-patch.ts`'s `patchAuthorAllowlistRef` (RAS-1.1/DBR-1.4), the same allowlist the
server-side candidate provider already applies when building patch candidates, and follows
`review.md`'s Step 14 config-fetch pattern (`GET /agents/{id}/config`):

```bash
PATCH_AUTHOR_ALLOWLIST=$(curl -sf -H "Authorization: Bearer $SHIPWRIGHT_AGENT_API_KEY" \
  "$SHIPWRIGHT_API_URL/agents/$SHIPWRIGHT_AGENT_ID/config" | jq -c '.patchAuthorAllowlist // []')
PATCH_AUTHOR_ALLOWLIST=${PATCH_AUTHOR_ALLOWLIST:-[]}
```

Keep `PATCH_AUTHOR_ALLOWLIST` as a **JSON array**, not a comma-joined string. Step 2's scope
check gates a write-action command, so it must test exact membership; a flattened string
invites a substring test (`[[ "$PATCH_AUTHOR_ALLOWLIST" == *"$PR_AUTHOR"* ]]`), which would
match `bot` against an allowlist entry of `dependabot`, or `renovate` against an author of
`not-renovate-bot`. The array form keeps `jq`'s element-wise equality available — see Step 2.

**Fail-closed, not fail-open.** On any curl failure, or when `.patchAuthorAllowlist` is
absent or an empty array, `PATCH_AUTHOR_ALLOWLIST` ends up as the empty JSON array `[]` (the
`${...:-[]}` default covers the curl-failure case, where the pipeline emits nothing) — Step
2's scope check then falls back to exactly today's `CURRENT_USER`-only behavior. An
unreachable config endpoint or an unsynced allowlist must never be read as "allow everyone";
it must be read as "no additional authors beyond `CURRENT_USER`," identical to
`patchAuthorAllowlistRef`'s own fail-closed default on the server side.

---

## Step 2: Resolve Target PR

Parse `$ARGUMENTS` for the `org/repo#number` target (per the Arguments section above). If
`$ARGUMENTS` has a trailing `[preclaim:{recordId}:{commitSha}]` marker (see Arguments
section), extract `PRECLAIM_RECORD_ID` and `PRECLAIM_COMMIT_SHA` from it and **strip the
marker** before parsing the rest of the argument — do this once here; each of the three
claim sites (Steps 4a.6/5a.6/6b.5) re-validates the same marker against its own live head
later. If no marker is present, leave `PRECLAIM_RECORD_ID`/`PRECLAIM_COMMIT_SHA` unset — the
claim sites then self-claim as today. Then fetch that PR:

```bash
gh pr view {number} --repo {org}/{repo} \
  --json number,title,headRefName,headRefOid,additions,deletions,mergeStateStatus,state,author
```

Capture `PR_AUTHOR` from this result's `author.login` field (e.g. via `jq -r '.author.login'`
on the same JSON) — reused unchanged at Step 5a.7's author-reply detection below, mirroring
`check-patch.ts`'s `prAuthor = data.prAuthor ?? currentUser` threading (RAS-1.1/DBR-1.4). For
a self-authored PR, `PR_AUTHOR` naturally equals `CURRENT_USER`; for an allowlisted PR it's
that PR's own real author.

Then evaluate the in-scope test with an **exact** membership check — never a substring one:

```bash
# In scope iff PR_AUTHOR is CURRENT_USER, or equals an allowlist entry exactly.
# `jq -e` exits 0 only when some element is character-for-character equal to
# $PR_AUTHOR, and exits non-zero on `false` OR on malformed/empty input — so a
# failed config fetch in Step 1 fails closed here rather than widening scope.
if [ "$PR_AUTHOR" = "$CURRENT_USER" ] || \
   printf '%s' "$PATCH_AUTHOR_ALLOWLIST" \
     | jq -e --arg a "$PR_AUTHOR" 'any(.[]; . == $a)' >/dev/null 2>&1; then
  IN_SCOPE=true
else
  IN_SCOPE=false
fi
```

Do **not** substitute a substring form such as `[[ "$PATCH_AUTHOR_ALLOWLIST" == *"$PR_AUTHOR"* ]]`.
Patch takes write actions (pushing commits, merging), so a false positive — `bot` matching an
allowlisted `dependabot`, or `renovate` matching an author `not-renovate-bot` — would let
patch act on an out-of-scope PR. This mirrors `check-patch.ts`'s server-side
`listAllowlistedOpenPrs`, which queries `gh pr list --author {login}` once per allowlist
entry and is therefore exact by construction.

- **Not found, or `state != "OPEN"`, or `IN_SCOPE` is false (i.e. `author.login != CURRENT_USER`
  AND `author.login` is not exactly equal to any entry in `PATCH_AUTHOR_ALLOWLIST`)**: this PR
  is not workable by patch (per the Independence Principles' "own PRs only" scope, widened by
  PAS-1.1 to include any agent-configured `patchAuthorAllowlist` entry from Step 1). Print
  `⚠ PR {org}/{repo}#{number} not found among own open PRs.` and stop.
- **Match found**: use it as the sole entry in the unified PR list and proceed directly to
  Step 2.5.

---

## Step 2.1: Resolve Patch Model Tier (MTR-2.1)

Every dispatch this command makes — conflict resolution (Step 4b), finding fixes (Step
5b), CI fixes (Step 6c) — is inherently a response to a failure signal (a conflict, a
review finding, a red CI run). There's no "first attempt" the way `dev-task` has one, so
`PATCH_MODEL` starts one tier above the linked task's planned tier rather than waiting to
hit `dev-task`'s own BLOCKED-escalation ladder. Resolve it once here, right after Step 2
resolves the target PR — this is independent of claim state (reading the linked task's
model doesn't require holding a claim), and the computed value is reused as-is at Step 4b,
Step 5b, Step 6c, and Step 5a.7. None of those four sites re-fetches it.

`PullRequest.taskId` no longer exists (removed in PTL-3.1 — it was populated only a
fraction of the time, and most PRs had no reliable task linkage through it). Query the
task store directly by PR number:

```bash
MATCHED_TASKS=$(curl -sf -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
  "$SHIPWRIGHT_TASK_STORE_URL/tasks?repo={org}/{repo}&pr={pr}")
```

- **One or more tasks match**: this PR can have more than one task linked to it (e.g. a
  bundled multi-task branch), so compute `PATCH_MODEL` from the **highest tier among ALL
  matched tasks' `.model` fields** (`model ?? 'sonnet'` for any task with the field unset),
  escalated one tier up the same ladder `dev-task.md`'s Step 5c BLOCKED handling already
  climbs — a patch dispatch is always reacting to a problem the way a BLOCKED
  implementation subagent is, so it starts where that ladder's first escalation would land,
  instead of waiting to hit it: `haiku`->`sonnet`, `sonnet`->`opus`, `opus`->`opus` (already
  at the top tier — stays put). This mirrors the "highest tier among all matches" rule
  PTL-1.2 applies to review.md's equivalent lookup — same idea, applied here.

  | Highest `TASK_MODEL` among matches (or `model ?? 'sonnet'` if the field is unset) | `PATCH_MODEL` |
  |---|---|
  | `haiku` | `sonnet` |
  | `sonnet` | `opus` |
  | `opus` | `opus` (already at the top tier — stays put) |

  ```bash
  TIER_RANK='{"haiku":0,"sonnet":1,"opus":2}'
  TIER_NEXT='{"haiku":"sonnet","sonnet":"opus","opus":"opus"}'

  PATCH_MODEL=$(echo "$MATCHED_TASKS" | jq -r --argjson rank "$TIER_RANK" --argjson next "$TIER_NEXT" '
    [.tasks[]? | (.model // "sonnet")] as $models
    | ($models | map($rank[.]) | max) as $maxRank
    | ($models | map($rank[.]) | index($maxRank)) as $idx
    | $next[$models[$idx]]
  ')
  PR_TASK_ID=$(echo "$MATCHED_TASKS" | jq -r --argjson rank "$TIER_RANK" '
    [.tasks[]? | (.model // "sonnet")] as $models
    | ($models | map($rank[.]) | max) as $maxRank
    | ($models | map($rank[.]) | index($maxRank)) as $idx
    | .tasks[$idx].id // empty
  ')
  ```

  Also set `PR_TASK_ID` to the id of the task that produced the highest tier (the first
  match on a tie). Several sites further down this file — Step 4c's BLOCKED handling, Step
  5a.7, Step 5c's BLOCKED handling, and `references/escalation-pattern.md`'s shared
  PATCH/comment/release sequence — reuse `PR_TASK_ID` as a single scalar to PATCH one task
  to `status: blocked` during HITL escalation. The model-tier calculation above now
  considers every matched task, but that downstream escalation-PATCH mechanism still only
  ever flags one task, so `PR_TASK_ID` stays a single value here rather than becoming a set.

- **Zero tasks match, or the `curl -sf` call above fails (non-200)**: `PATCH_MODEL =
  "sonnet"` — plain `sonnet`, with **no escalation**. `PR_TASK_ID` is empty. Print a
  one-line warning and continue; this is **not a hard stop**:
  ```bash
  PATCH_MODEL="sonnet"
  PR_TASK_ID=""
  echo "⚠ no matching tasks found (or lookup failed) for PR #{pr} — PATCH_MODEL defaulting to sonnet, no escalation"
  ```
  There's no known baseline tier to escalate from on a PR Shipwright didn't create (or
  whose linked task records aren't reachable), so defaulting straight to `opus` would be a
  surprise cost spike with no signal backing it — `sonnet` is the safe, unescalated
  default.

---

## Step 2.5: Handle DIRTY PRs (Auto-Rebase Attempt)

Using the `mergeStateStatus` field already fetched for the target PR resolved in Step 2, check whether it is DIRTY.

If the target PR is DIRTY, attempt an automatic rebase via GitHub:
```bash
gh pr update-branch --rebase {number} --repo {org}/{repo}
```

**If update-branch succeeds (exit 0)**: The merge conflict was auto-resolvable. The PR's branch is now up to date — it will no longer appear as `DIRTY` in Step 3b. Print:
```
↻ PR #{number} was DIRTY — auto-rebased successfully, continuing normal flow
```

**If update-branch fails (non-zero exit)**: Auto-rebase failed. The PR will be classified into **List C** in Step 3b and resolved via worktree in Step 4.

---

## Step 3: Classify PRs into Three Lists

Check the target PR against all three conditions independently. It may appear in multiple lists.

- **List A** — PRs with unresolved review or PR comments
- **List C** — PRs with merge conflicts (DIRTY)
- **List D** — PRs with failing CI

When the target PR appears in multiple lists, all applicable fixes run — processed in the order the steps execute (C → A → D).

**This command does not read `state/reviews.json`.** All data comes from GitHub directly.

### Step 3a: Check for Unaddressed Review Findings

For each PR, issue a single GraphQL query to get all reviews, all inline review threads,
and all PR-level comments:

```bash
gh api graphql -f query='
{
  repository(owner: "{org}", name: "{repo}") {
    pullRequest(number: {pr}) {
      headRefOid
      reviews(first: 50) {
        nodes {
          author { login }
          state
          submittedAt
          body
        }
      }
      reviewThreads(first: 100) {
        nodes {
          id
          isResolved
          comments(first: 1) {
            nodes {
              author { login }
              body
              path
              line
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
    }
  }
}'
```

From the response, extract:
- `headRefOid` — current HEAD SHA of the PR
- `reviews.nodes[]` — each with `author.login`, `state`, `submittedAt`, `body`
- `reviewThreads.nodes[]` — each with `id`, `isResolved`, and the first comment's `author.login`, `body`, `path`, `line`
- `comments.nodes[]` — PR-level (non-inline) comments with `author.login`, `body`, `createdAt`

A PR has **unaddressed findings** when ANY of the following are true:
- At least one inline thread has `isResolved == false`
- At least one review with `state == "COMMENTED"` or `state == "CHANGES_REQUESTED"` has a
  non-empty `body` (a review body without matching inline threads is itself a finding),
  excluding clean-APPROVE reviews (see below), reviews addressed via a subsequent author
  reply (see below), and self-authored reviews superseded by a later clean self-review
  (see below)

A PR has **no findings** (skip it) when ALL of the following are true:
- All inline threads are resolved (`isResolved == true` for every thread)
- No COMMENTED or CHANGES_REQUESTED review has a non-empty body, other than clean-APPROVE
  reviews (see below), reviews addressed via a subsequent author reply (see below), and
  self-authored reviews superseded by a later clean self-review (see below)

**Clean-APPROVE exclusion**: A review is excluded from the body check above when its body is
a clean APPROVE verdict, matched either by:
- leading markdown bold markers (`**`) stripped, the body starts with `APPROVE`, or
- a `Verdict: APPROVE` label appears anywhere in the body (case-insensitive, optional bold
  markers around either word) — **not** anchored to end-of-line, since the agent's narrative
  self-reviews often trail reasoning after the verdict on the same line, e.g.
  `"...All 5 acceptance criteria met. Verdict: APPROVE (posted as COMMENT — GitHub disallows
  self-approval via the API)."` (verbatim from shipwright PR #1272, the case that motivated
  this).

Not restricted to self-authored reviews (SRV-1.1): multiple distinct Shipwright agents
operate under different GitHub identities in the same repo, so WHO posted a clean APPROVE
verdict is not meaningful — the verdict text itself is the ground truth. Per review.md's
Step 10 mechanical verdict computation (the `selfReview` input), GitHub rejects self-APPROVE
via the API, so an agent's own clean approval of its own PR is always posted as `COMMENTED`
with a body like
`"APPROVE — looks good, no changes needed."` or a narrative containing `"Verdict: APPROVE"`
instead of an `APPROVED` review. Without this exclusion, that clean approval would look
identical to a real finding and loop the patch cron forever on an already-approved PR. The
exclusion is scoped to clean APPROVE verdicts only — a review whose body neither starts with
`APPROVE` nor contains a `Verdict: APPROVE` label (e.g. it contains `Verdict:
CHANGES_REQUESTED`, meaning the reviewer found a real issue) still counts as a finding,
regardless of who posted it.

**Third-party review body addressed via reply (CPF-2.3)**: A review's non-empty body is
excluded from the finding check when the PR author has posted a PR-level comment (from
`comments.nodes`, already fetched by this same query) with `createdAt` after that review's
`submittedAt`. This exclusion is distinct from and independent of the clean-APPROVE
exclusion above — a review can be excluded by either one on its own.

The self-review "Verdict: APPROVE" rewrite (via the `updatePullRequestReview` mutation)
only works because `updatePullRequestReview` can only edit a review's OWN author's body —
it cannot be used on a third-party reviewer's review (e.g. a review posted by a distinct
GitHub identity like `dodizzle`). When a third-party review flags a real finding, the fix
subagent replies with a rebuttal or fix explanation and resolves the inline thread, but the
review's own body text remains exactly as the third party wrote it — it can never be
rewritten to signal the finding was addressed. A subsequent PR-author reply is therefore
the only available signal that a third-party review's finding was addressed (fixed or
rejected with a rebuttal), so it is treated the same as a body rewrite would be for a
self-authored review. This exclusion still requires all inline threads to be resolved
(`isResolved == true`) — an unresolved thread on the same review continues to count as a
finding regardless of any reply.

**Self-review superseded by a later clean self-review (DRO-1.2)**: review.md's own Step
10/11 procedure always posts a *new* review object each pass rather than rewriting a prior
one's body (see Step 10's "the initial-review and re-review paths run identically"), so a
self-authored PR that goes through N review rounds — each finding and fixing one real issue
— ends up with N-1 COMMENT-bodied self-reviews on the PR even after every finding has been
fixed. None of those qualifies for the clean-APPROVE exclusion above (their bodies read
`Verdict: COMMENT`, not `Verdict: APPROVE`), and the reply exclusion doesn't apply either
(self-reviews aren't "third-party," and this PR's convention never posts a PR-level author
reply) — so without this exclusion, `unaddressedFindings` computes `true` forever and a
self-authored PR can never reach a clean verdict once it has had more than one review round.
An earlier self-authored COMMENTED review's body is excluded from the finding check when a
**later** review exists whose `author.login` is the same self-review identity AND that later
review's own body is a clean verdict (matched by the clean-APPROVE exclusion's pattern above
— i.e. the later self-review itself reads `Verdict: APPROVE` or leads with `APPROVE`, whether
or not GitHub's API forced its `state` to `COMMENTED`). This mirrors what an
`updatePullRequestReview` body rewrite would have signaled had review.md instead edited the
prior review in place — a later clean self-review is functionally the same "this round found
nothing new, prior issues are fixed" signal, just expressed as a new review object instead of
an edit to an old one. It does **not** exclude a later self-review that is itself non-clean
(e.g. `Verdict: COMMENT` because *this* round found a fresh issue) — only a prior self-review
is superseded, and only when the later one is genuinely clean. All inline threads must still
be resolved for the PR overall, same as the other two exclusions.

If neither condition applies (e.g., no reviews at all, only approved reviews, or only an
excluded clean-APPROVE, reply-addressed, or superseded-self-review), skip the PR — it does
not belong in List A.

If a PR has unaddressed findings, add it to **List A**. Store the unresolved threads (with their
`id` — needed for the `resolveReviewThread` mutation in Step 5) and review bodies for use in
Step 5.

### Step 3a.5: Dependency-Risk Detection (DBP-1.2)

For each PR, determine whether it has a dependency-risk finding, independently of whether
review and patch share an agent/session — any agent can claim either phase, and a review's
dependency-risk analysis is only ever persisted as text inside the GitHub-posted review
body, never in a shared in-memory or task-store field. Store the result as
`DEPENDENCY_RISK_FINDING` (a nullable `{recommendation, flags, reasoning}` shape) for use by
Step 5b. A `"hold"` or `"review"` recommendation additionally routes the PR into **List A**
directly — see step 3 below — because it has no ordinary review finding for Step 3a's
criteria to catch on its own.

1. **Scan the review bodies Step 3a already fetched.** For each review in `reviews.nodes[]`
   (already in memory from Step 3a's GraphQL query — do not re-fetch), check its `body` for
   a `## Dependency Risk Analysis` section — the exact heading `review.md`'s Step 9 template
   emits. When found, parse `{recommendation, flags, reasoning}` from that section's
   `**Recommendation**:`, `**Flags**:`, and `**Reasoning**:` lines. Set
   `DEPENDENCY_RISK_FINDING` from this parse and skip step 2 below — a review already did
   this analysis, so there's nothing to re-derive.

2. **Independent fallback, when no fetched review body contains the clause.** Mirror
   `review.md`'s Step 5.8 exactly, substituting `gh` calls for that step's worktree-relative
   file reads — Step 3 runs before any worktree exists (worktree setup happens later, in
   Step 4a/5a, scoped only to PRs already classified into List C/A):

   a. **Build the repo's watched-path set.** Read the two config files at the PR's head
      branch via the GitHub API instead of `cat`:
      ```bash
      RENOVATE_JSON=$(gh api "repos/{org}/{repo}/contents/renovate.json?ref={branch}" \
        --jq '.content' 2>/dev/null | base64 -d 2>/dev/null || echo "")
      DEPENDABOT_YML=$(gh api "repos/{org}/{repo}/contents/.github/dependabot.yml?ref={branch}" \
        --jq '.content' 2>/dev/null | base64 -d 2>/dev/null || echo "")
      ```
      Then resolve the watched-path set exactly as `review.md`'s Step 5.8 does:
      ```bash
      WATCHED_PATHS_RESULT=$(bun run "${CLAUDE_PLUGIN_ROOT}/scripts/resolve-dependency-watched-paths.ts" \
        "$(jq -n --arg renovateJson "$RENOVATE_JSON" --arg dependabotYml "$DEPENDABOT_YML" \
          '{renovateJson: (if $renovateJson == "" then null else $renovateJson end),
            dependabotYml: (if $dependabotYml == "" then null else $dependabotYml end)}')")
      # -> {"paths":["package.json","go.mod",...],"source":"renovate"|"dependabot"|"both"|"fallback"}
      ```
   b. **Compare against the PR's changed files**, fetched without a worktree:
      ```bash
      CHANGED_FILES=$(gh pr diff {pr} --repo {org}/{repo} --name-only)
      ```
      A changed file matches the watched-path set under the same three rules `review.md`'s
      Step 5.8 defines (exact match, basename match for a bare-filename watched path,
      directory-prefix match for a watched path ending in `/`) — reuse that step's rule
      definitions rather than restating them here.
   c. **When triggered** (at least one changed file matches): apply
      `references/dependency-risk-analysis.md`'s heuristics — using `gh pr diff {pr} --repo
      {org}/{repo}` for the diff, the PR's `body` and `PR_AUTHOR` (Step 2), and
      `gh pr view {pr} --repo {org}/{repo} --json labels` for labels — to produce
      `{recommendation, flags, reasoning}`. Set `DEPENDENCY_RISK_FINDING` from the result.
   d. **When not triggered** (no changed file matches): `DEPENDENCY_RISK_FINDING` stays
      unset for this PR.

3. **Route a `hold`/`review` recommendation into List A.** When `DEPENDENCY_RISK_FINDING`
   is set (from step 1 or step 2 above) and its `recommendation` is `"hold"` or `"review"`,
   add this PR to **List A** — regardless of whether Step 3a's own criteria (unresolved
   inline threads, a non-excluded COMMENTED/CHANGES_REQUESTED review body) independently
   found a finding for this PR. A `"merge"` recommendation has nothing to remediate and does
   not affect List A membership.

   This routing is necessary because the two signals are otherwise disconnected:
   `review.md`'s Step 9 template appends the dependency-risk clause on the same line as its
   `Verdict: ...` output but deliberately excludes it from `compute-review-verdict.ts`'s
   event computation (review.md:1118-1125). A dependency-bump-only PR with a `hold`/`review`
   recommendation and no other findings therefore still gets a clean `Verdict: APPROVE` —
   which Step 3a's own clean-APPROVE exclusion would otherwise keep out of List A
   indefinitely. Without this rule, Step 5b's DEPENDENCY-RISK REMEDIATION PROTOCOL block is
   unreachable for exactly the scenario it targets: a dependency-bump PR carrying a
   hold/review recommendation with no unrelated ordinary finding to piggyback List A
   membership on.

### Step 3b: Check for DIRTY State

For each PR, check its merge state:

```bash
gh pr view {pr} --repo {org}/{repo} --json mergeStateStatus
```

- If `mergeStateStatus` is `"DIRTY"` → add to **List C**
- Any other state (including `"BEHIND"`) → not patch-worthy on its own; being behind
  main without a conflict does not require action

Store the fetched `mergeStateStatus` — do not re-fetch in Step 3c.

### Step 3c: Check for Failing CI (for PRs not in List C)

For each PR not in List C (DIRTY PRs have unreliable CI until conflicts are resolved), check its CI checks:

```bash
gh api "repos/{org}/{repo}/actions/runs?head_sha={headRefOid}&per_page=20" \
  -q '.workflow_runs[] | {id, workflow_id, run_number, conclusion}'
```

A PR has **failing CI** when any workflow's **latest run** (highest `run_number` per
`workflow_id`) has `conclusion == "failure"` or `conclusion == "timed_out"`.

**Why deduplicate by workflow:** When a workflow run fails and is rerun, the GitHub API
returns both the original failed run and the new rerun as separate entries with the same
`workflow_id` but different `run_number` values. Evaluating every historical run would
produce a false positive if an older run failed but a newer rerun passed. Deduplication
by keeping only the latest run per workflow mirrors the behavior of `gh pr checks`.

If failing CI is found, add the PR to **List D** and set `CI_HAS_FAILING=true` for this PR.

**Stale-cancelled CI (PCC-1.1):** using the same latest-run-per-workflow dedup above, a PR
also has **cancelled CI** when any workflow's latest run has `conclusion == "cancelled"` —
e.g. a job that hit `timeout-minutes` and was reported by GitHub's API as `cancelled` rather
than `timed_out`. This is checked independently of, and is not mutually exclusive with, the
failing-CI check above — a PR can have one workflow whose latest run genuinely failed and a
different workflow whose latest run was cancelled at the same time. If cancelled CI is
found, add the PR to **List D** (if not already there) and set `CI_HAS_CANCELLED=true` and
record the qualifying run's `id` as `CANCELLED_RUN_ID` (highest `run_number` wins when more
than one workflow qualifies) for this PR.

A PR whose **only** List D signal is `CI_HAS_CANCELLED=true` (i.e. `CI_HAS_FAILING` is not
also true for this PR — cancelled-only, no failure/timed_out) is handled by the new Step
6b.8 rerun-first branch instead of going straight to Step 6c. A PR with a genuine
failure/timed_out run (`CI_HAS_FAILING=true`), with or without an additional cancelled run
elsewhere, is unaffected by Step 6b.8 and proceeds straight to Step 6c exactly as before.

### Step 3d: Summary

If all three lists are empty:

```
No PRs need attention.
```

Emit `[skip-reason:patch:deferred:no-op-at-dispatch:{pr}]` alongside `[silent]` (interpolating
the target PR number) — order relative to `[silent]` does not matter, both are recognized regardless
of position. The skip-reason marker records exactly which PR found no work in the `AgentCronRun.skipReason`
field (visible in the admin cron-logs UI) instead of the generic `command:no-work` reason, letting the
loop orchestrator's SKIP_BLOCK_THRESHOLD handling classify this correctly.

**Design note:** Reaching Step 3d is most likely a genuine race (CI went green, or a human fixed the
issue directly, between candidate selection and dispatch). Unlike `review.md`'s RVD-2.2/2.3 write-back
gaps, `getPatchCandidates()` re-derives DIRTY/CI/findings status fresh from live GitHub every tick with
no persisted "needs patch" cache field to drift, so there is no stale state to correct via a write-back
here. If telemetry later shows this recurring for the same PR repeatedly, that is the signal for a
follow-up write-back task, not something to speculatively build now.

Print a summary before proceeding:

```
Found {A} PR(s) with unaddressed review findings, {C} PR(s) with merge conflicts, {D} PR(s) with failing CI:
  Review findings:  {for each in List A: "#{pr} — {title} ({org}/{repo})"}
  Merge conflicts:  {for each in List C: "#{pr} — {title} ({org}/{repo})"}
  Failing CI:       {for each in List D: "#{pr} — {title} ({org}/{repo})"}
```

---

## Step 4: Resolve Merge Conflicts

For each PR in List C, check out the branch in a worktree, merge the base branch,
resolve conflicts, validate, and push. Fully complete one PR (resolve → push → cleanup)
before moving to the next.

### Step 4a: Set Up Worktree

```bash
git -C ${SHIPWRIGHT_REPO_DIR:-$HOME/src}/{repo} fetch origin
git -C ${SHIPWRIGHT_REPO_DIR:-$HOME/src}/{repo} worktree add ${SHIPWRIGHT_WORKTREE_DIR:-$HOME/worktrees}/{repo}-{branch-slug} origin/{branch}
```

Branch slug = branch name with `/` replaced by `-`.

If the worktree already exists (prior interrupted run):
```bash
git -C ${SHIPWRIGHT_REPO_DIR:-$HOME/src}/{repo} worktree remove ${SHIPWRIGHT_WORKTREE_DIR:-$HOME/worktrees}/{repo}-{branch-slug} --force
git -C ${SHIPWRIGHT_REPO_DIR:-$HOME/src}/{repo} worktree add ${SHIPWRIGHT_WORKTREE_DIR:-$HOME/worktrees}/{repo}-{branch-slug} origin/{branch}
```

### Step 4a.5: Detect Project Toolchain

Check the cache before any fresh detection, then fall back to docs-first discovery and config-file scanning — see `references/toolchain-patterns.md`'s "Caching Across Runs" and "Docs-First Discovery" sections for the exact protocol:

1. Compute the fingerprint against `{worktree-path}` and read `state/toolchain-cache/{repo}.json`. If the file exists and its fingerprint matches, reuse the cached **lint**/**test**/**tests** commands and skip to Step 4a.6.
2. Otherwise, read `CLAUDE.md` + `docs/*.md`/`ai-docs/*.md` for explicit lint/test commands first (authoritative if found), then fall back to the config-file lookup table in `references/toolchain-patterns.md` to fill any gaps.
3. Store detected commands:
   - **{lint command}**: e.g., `bun run lint`, `cargo clippy`, `golangci-lint run`
   - **{test command}**: e.g., `bun test`, `cargo test`, `go test ./...`, `pytest`
   - **{tests}**: optional object of additional test layers (e.g., `{"integration": "pytest tests/integration", "e2e": "npx playwright test"}`) — omit when only one test command exists
4. On a cache miss, overwrite `state/toolchain-cache/{repo}.json` with the new fingerprint + commands.

### Step 4a.6: Claim PR Record (pre-work lock)

The conflict-resolution subagent dispatched next can run long enough to overlap with
another patch run (or a stale leftover claim from `/shipwright:review`, e.g. a
still-claimed `phase: "review"` record left behind after posting — the record stays
claimed until released or reaped). Without a pre-work claim, two overlapping patch runs
could both dispatch competing fix subagents against the same branch. Claim the PR record
with `phase: "patch"` now, before starting the merge/resolve, mirroring deploy.md's Step
4a pre-merge claim:

**Pre-Claim Fast Path (CBD-1.5).** If a pre-claim marker was captured in Step 2, validate
it against this site's live head before trusting it — the head can have moved since Step 2
(or since an earlier List's fix ran), so re-fetch fresh here rather than trusting the
Step 2 parse:

```bash
headRefOid=$(gh pr view {pr} --repo {org}/{repo} --json headRefOid -q '.headRefOid')
```

- **`headRefOid == PRECLAIM_COMMIT_SHA`** (marker is current): trust it. Set
  `PR_RECORD_ID = PRECLAIM_RECORD_ID` and **skip this site's own `/prs/claim` call below**
  — the orchestrator's `/prs/claim` already holds this PR under `phase: "patch"`. Proceed
  directly to Step 4b (`PR_RECORD_ID` is reused by the post-fix update in Step 4c.5, same
  as the self-claim path).
- **`headRefOid != PRECLAIM_COMMIT_SHA`** (stale marker — new commits landed between the
  orchestrator's claim and now) **or no marker present**: fall back to self-claiming
  exactly as today — run the claim below unchanged.

```bash
HEAD_SHA_PRE_PATCH=$(git -C ${SHIPWRIGHT_WORKTREE_DIR:-$HOME/worktrees}/{repo}-{branch-slug} rev-parse HEAD)
PR_CLAIM=$(curl -s -o /tmp/pr_claim_patch.json -w '%{http_code}' -X POST \
  -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
  -H "Content-Type: application/json" \
  "$SHIPWRIGHT_TASK_STORE_URL/prs/claim" \
  -d "{\"repo\": \"{org}/{repo}\", \"prNumber\": {pr}, \"commitSha\": \"$HEAD_SHA_PRE_PATCH\", \"phase\": \"patch\"}")
PR_RECORD_ID=$(jq -r '.id // empty' /tmp/pr_claim_patch.json)
```

**If `PR_CLAIM` is `409`** (another patch run already claimed this PR at phase `patch`):
do NOT dispatch the conflict-resolution subagent. Print:
```
⏸ PR #{pr} is already claimed by another patch run — skipping.
```
Skip the rest of Step 4 for this PR. Move to the next candidate PR in List C. If no
candidates remain, continue to Step 5.

**Otherwise** (`200` or `201`): the claim succeeded. `PR_RECORD_ID` is reused by the
post-fix update in Step 4c.5 — no second claim call is needed. Proceed to Step 4b.

### Step 4b: Dispatch Conflict Resolution Subagent

Renew the claim heartbeat now, before dispatching — conflict resolution can run long
enough on its own to threaten the claim TTL, in addition to the renewal after it
completes in Step 4c.5:

```bash
curl -s -o /dev/null -X POST \
  -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
  "$SHIPWRIGHT_TASK_STORE_URL/prs/$PR_RECORD_ID/heartbeat"
```

Dispatch a `general-purpose` subagent via the Agent tool, passing `model: PATCH_MODEL`
(resolved once in Step 2.1) so the conflict-resolution subagent runs at the escalated
tier, with this prompt:

```
You are resolving merge conflicts on a pull request. Merge the base branch, resolve all
conflicts, validate, and push.

PR: #{pr} — {title}
Repo: {org}/{repo}
Branch: {branch}
Base branch: {base}
Worktree: {worktree-path}

TOOLCHAIN:
  Lint command: {lint command}
  Test command: {test command}
  Test layers:  {if tests is non-empty, list each as "layer: command"; otherwise "none"}

INSTRUCTIONS — follow in order:

[A] Merge the base branch
  - From the worktree: `git merge origin/{base}`
  - This will produce conflict markers in the affected files

[B] Resolve conflicts
  - Read each conflicted file
  - Resolve conflicts by keeping the PR's changes where they don't overlap with base
    changes, and integrating base changes where they don't conflict with PR intent
  - If both sides changed the same logic, prefer the PR's intent — the PR author's
    changes are the goal; base is just catching up
  - Stage resolved files: `git add {file}`

[C] Validate
  - Run: {lint command}
  - Run: {test command}
  - Fix any failures introduced by the merge
  - Re-run until both pass cleanly

[D] Commit and push
  - Complete the merge: `git commit -m "Merge branch '{base}' into {branch}"`
    (or `git merge --continue` if git is waiting for a commit)
  - Push: `git push origin {branch}`

[E] Report back
  At the end, output:

  STATUS: DONE / DONE_WITH_CONCERNS / BLOCKED

  CONFLICTS_RESOLVED:
  {bullet list of each conflicted file and how it was resolved}

  CONCERNS: (if DONE_WITH_CONCERNS)
  BLOCKER: (if BLOCKED)
```

### Step 4c: Handle Subagent Status

Parse the subagent's STATUS:

- **DONE**: Record the conflicts resolved. Proceed to Step 4c.5 (upsert PR record).
- **DONE_WITH_CONCERNS**: Read concerns. If the push already happened, log concerns and
  proceed to Step 4c.5 (upsert PR record). If the subagent did not push, note it in the
  final report and skip Step 4c.5.
- **BLOCKED**: The conflict-resolution subagent (dispatched in Step 4b) reported it could
  not complete. A generic BLOCKED release with no escalation flag makes this PR immediately
  re-eligible for `check-patch.ts`'s `getPatchCandidates()` on the next `shipwright-loop`
  tick — `claimedBy`/`blocked` are the only exclusions it checks, and releasing the claim
  below clears the former without setting the latter. Escalate to HITL first, following
  `references/escalation-pattern.md`'s shared PATCH/comment/release sequence, before
  releasing the claim:

  - **`{blockedReason}`**: `"merge-conflict resolution blocked — automated conflict
    resolution could not complete"`
  - **`{comment_body}`**: "The merge-conflict resolution subagent reported BLOCKED and
    could not complete — flagging for a human decision instead of retrying indefinitely."
  - **`{temp_file_slug}`**: `blocked-4c` (temp file:
    `/tmp/shipwright-patch-blocked-4c-{pr}.txt`)
  - **`PR_TASK_ID`**: reused from Step 2.1 (no fresh fetch)
  - **Claim released**: the pre-work claim from Step 4a.6

  Log the blocker. Skip Steps 4c.5 and 4d. Move to the next PR in List C.
  Include the blocker in the final report.

### Step 4c.5: Upsert PR Record

The record was already claimed pre-work in Step 4a.6 — `PR_RECORD_ID` is already set, so
this renews the claim's heartbeat and increments `patchCycles` rather than re-claiming.
Warn and continue on any failure — do not stop.

```bash
if [ -n "$PR_RECORD_ID" ]; then
  curl -s -o /dev/null -X POST \
    -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
    "$SHIPWRIGHT_TASK_STORE_URL/prs/$PR_RECORD_ID/heartbeat" || \
    echo "⚠ heartbeat renewal failed — continuing"
  HEAD_SHA_POST_PATCH=$(git -C ${SHIPWRIGHT_WORKTREE_DIR:-$HOME/worktrees}/{repo}-{branch-slug} rev-parse HEAD)
  curl -sf -X POST \
    -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
    -H "Content-Type: application/json" \
    "$SHIPWRIGHT_TASK_STORE_URL/prs/$PR_RECORD_ID/patch" \
    -d "{\"commitSha\": \"$HEAD_SHA_POST_PATCH\"}" > /dev/null 2>&1 || \
    echo "⚠ POST /prs/$PR_RECORD_ID/patch failed — continuing"
else
  echo "⚠ no PR_RECORD_ID from pre-work claim — skipping PR record update"
fi
```

Proceed to Step 4d (cleanup).

### Step 4d: Cleanup Worktree

After a successful push (subagent status DONE or DONE_WITH_CONCERNS with push completed):

```bash
git -C ${SHIPWRIGHT_REPO_DIR:-$HOME/src}/{repo} worktree remove ${SHIPWRIGHT_WORKTREE_DIR:-$HOME/worktrees}/{repo}-{branch-slug} --force
```

---

## Step 5: Address Findings in Worktree

For each qualifying PR in List A, work through the fixes in sequence. Fully complete one
PR (fix → push → cleanup) before moving to the next.

### Step 5a: Set Up Worktree

```bash
git -C ${SHIPWRIGHT_REPO_DIR:-$HOME/src}/{repo} fetch origin
git -C ${SHIPWRIGHT_REPO_DIR:-$HOME/src}/{repo} worktree add ${SHIPWRIGHT_WORKTREE_DIR:-$HOME/worktrees}/{repo}-{branch-slug} origin/{branch}
```

Branch slug = branch name with `/` replaced by `-`.

If the worktree already exists (prior interrupted run):
```bash
git -C ${SHIPWRIGHT_REPO_DIR:-$HOME/src}/{repo} worktree remove ${SHIPWRIGHT_WORKTREE_DIR:-$HOME/worktrees}/{repo}-{branch-slug} --force
git -C ${SHIPWRIGHT_REPO_DIR:-$HOME/src}/{repo} worktree add ${SHIPWRIGHT_WORKTREE_DIR:-$HOME/worktrees}/{repo}-{branch-slug} origin/{branch}
```

All subsequent steps for this PR run from `~/worktrees/{repo}-{branch-slug}/`.

### Step 5a.5: Detect Project Toolchain

Check the cache before any fresh detection, then fall back to docs-first discovery and config-file scanning — see `references/toolchain-patterns.md`'s "Caching Across Runs" and "Docs-First Discovery" sections for the exact protocol:

1. Compute the fingerprint against `{worktree-path}` and read `state/toolchain-cache/{repo}.json`. If the file exists and its fingerprint matches, reuse the cached **lint**/**test**/**tests** commands and skip to the diff collection below.
2. Otherwise, read `CLAUDE.md` + `docs/*.md`/`ai-docs/*.md` for explicit lint/test commands first (authoritative if found), then fall back to the config-file lookup table in `references/toolchain-patterns.md` to fill any gaps.
3. Store detected commands:
   - **{lint command}**: e.g., `bun run lint`, `cargo clippy`, `golangci-lint run`
   - **{test command}**: e.g., `bun test`, `cargo test`, `go test ./...`, `pytest`
   - **{tests}**: optional object of additional test layers (e.g., `{"integration": "pytest tests/integration", "e2e": "npx playwright test"}`) — omit when only one test command exists
4. On a cache miss, overwrite `state/toolchain-cache/{repo}.json` with the new fingerprint + commands.

From inside the worktree, collect the full picture of what needs fixing:

1. **PR diff against base**:
   ```bash
   base=$(gh pr view {pr} --repo {org}/{repo} --json baseRefName -q '.baseRefName')
   git diff "origin/$base"...HEAD
   ```

2. **Unresolved inline threads** (from Step 3a — already fetched, reuse):
   Each thread with `isResolved == false` — include `id`, `path`, `line`, and comment body.

3. **Review body text**: for each COMMENTED or CHANGES_REQUESTED review from Step 3a
   with a non-empty `body`, include the full body text.

4. **PR-level comments** (from Step 3a — already fetched, reuse):
   Include all non-bot comments as additional context.

### Step 5a.6: Claim PR Record (pre-work lock)

The fix subagent dispatched next can run long enough to overlap with another patch run
(or a stale leftover claim from `/shipwright:review`, e.g. a still-claimed
`phase: "review"` record left behind after posting — the record stays claimed until
released or reaped). Without a pre-work claim, two overlapping patch runs could both
dispatch competing fix subagents against the same branch. Claim the PR record with
`phase: "patch"` now, before starting the fix, mirroring deploy.md's Step 4a pre-merge
claim:

**Pre-Claim Fast Path (CBD-1.5).** If a pre-claim marker was captured in Step 2, validate
it against this site's live head before trusting it — the head can have moved since Step 2
(or since List C's fix ran), so re-fetch fresh here rather than trusting the Step 2 parse:

```bash
headRefOid=$(gh pr view {pr} --repo {org}/{repo} --json headRefOid -q '.headRefOid')
```

- **`headRefOid == PRECLAIM_COMMIT_SHA`** (marker is current): trust it. Set
  `PR_RECORD_ID = PRECLAIM_RECORD_ID` and **skip this site's own `/prs/claim` call below**
  — the orchestrator's `/prs/claim` already holds this PR under `phase: "patch"`. Proceed
  to Step 5a.7 (`PR_RECORD_ID` is reused by the post-fix update in Step 5c.5, same as the
  self-claim path).
- **`headRefOid != PRECLAIM_COMMIT_SHA`** (stale marker — new commits landed between the
  orchestrator's claim and now) **or no marker present**: fall back to self-claiming
  exactly as today — run the claim below unchanged.

```bash
HEAD_SHA_PRE_PATCH=$(git -C ${SHIPWRIGHT_WORKTREE_DIR:-$HOME/worktrees}/{repo}-{branch-slug} rev-parse HEAD)
PR_CLAIM=$(curl -s -o /tmp/pr_claim_patch.json -w '%{http_code}' -X POST \
  -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
  -H "Content-Type: application/json" \
  "$SHIPWRIGHT_TASK_STORE_URL/prs/claim" \
  -d "{\"repo\": \"{org}/{repo}\", \"prNumber\": {pr}, \"commitSha\": \"$HEAD_SHA_PRE_PATCH\", \"phase\": \"patch\"}")
PR_RECORD_ID=$(jq -r '.id // empty' /tmp/pr_claim_patch.json)
```

**If `PR_CLAIM` is `409`** (another patch run already claimed this PR at phase `patch`):
do NOT dispatch the fix subagent. Print:
```
⏸ PR #{pr} is already claimed by another patch run — skipping.
```
Skip the rest of Step 5 for this PR. Move to the next qualifying PR in List A. If no
candidates remain, continue to Step 6.

**Otherwise** (`200` or `201`): the claim succeeded. `PR_RECORD_ID` is reused by the
post-fix update in Step 5c.5 — no second claim call is needed. Proceed to Step 5a.7.

### Step 5a.7: Second-Round Escalation Check (RPF-1.3)

RPF-1.1/1.2 let a REJECTed finding get rebutted (a PR-author comment posted via
`gh pr comment`) and a `rejected` ledger entry recorded (Step 5c.5), which
`check-review.ts`'s `hasFreshLedgerFinding` (PFL-3.1) treats as new information,
re-qualifying the PR for a fresh review to re-evaluate the rebuttal. If that fresh review
still flags the same (or an equivalent) issue, another rebuttal cycle would repeat
indefinitely — the reviewer and the fix subagent disagree, and that is a genuine
human-judgment deadlock, not something another automated pass will resolve. Before
dispatching the fix subagent (which is where RPF-1.1's rebuttal-comment step lives, in Step
5b Instructions [D]), check whether this PR's List A finding is a *second* round of the
same disagreement.

**Step 1 — cheap timestamp pre-filter to find candidate prior replies.** This stays a cheap
pre-filter, not the final gate — see Step 2 below for the decisive judgment. For each
qualifying review from Step 3a (`state == "COMMENTED"` or `"CHANGES_REQUESTED"`, contributing
to this PR's List A membership), check the PR-level comments already fetched in Step 3a
(`comments.nodes`) for an author reply: a comment whose `author.login == PR_AUTHOR` (captured
in Step 2 from the PR's own `author.login`, per PAS-1.1 — not a hardcoded `CURRENT_USER`
comparison, so a genuine reply from an allowlisted PR's real author is recognized too) with
`createdAt` **before** that review's `submittedAt`. This mirrors `check-patch.ts`'s
`isAddressedByAuthorReply` (an author reply *after* a review marks that review addressed) as
a shared timestamp-comparison mechanism, but checks the opposite direction — a reply dated
*before* the current review is only a **candidate** signal that we already rebutted once and
the reviewer looked at that rebuttal before still raising a finding this round; unlike
`isAddressedByAuthorReply`, this direction is not treated as sufficient signal on its own.
A reply dated *after a review* is inherently a stronger, self-sufficient signal already — a
reply posted after a review is reasonably a response to that review, so timestamp order alone
is enough for `isAddressedByAuthorReply`. A reply dated *before* the review has no such
inherent connection: an earlier reply could be about a completely different, unrelated
finding that simply happens to predate this review's timestamp. That's exactly why this step
needs an extra layer `isAddressedByAuthorReply` doesn't: the content-correlation judgment in
Step 2 below, before a candidate can justify escalating.

**Anti-pattern:** a reply predating the review is not sufficient by itself to classify this
as a second round, and it is not sufficient by itself to escalate. Timestamp precedence only
narrows down which prior replies are worth reading — content must be verified before any
escalation decision is made. This is exactly the bug that motivated this step's rewrite
(RPF-1.5): PR #2153 had an unrelated earlier rebuttal comment (about a different, already-
fixed finding) that happened to predate a brand-new finding's review, and a timestamp-only
check escalated to HITL instead of ever attempting a fix — repeating the same false
escalation days later when the HITL flag was cleared, because nothing about the *content* had
actually recurred.

**Step 2 — content-correlation judgment for each candidate.** For each candidate reply found
in Step 1, read the reply's `body` and the current finding's text, then print an explicit
judgment before deciding anything:

```
Candidate reply ({createdAt}): "{reply body, or a representative excerpt}"
Current finding ({review submittedAt}): "{finding text, or a representative excerpt}"
Judgment: SAME_FINDING | DIFFERENT_FINDING
Justification: {one or two sentences — what specifically makes this the same issue
  recurring, or a different issue that happens to share a timestamp ordering}
```

The "current finding's text" depends on where the finding came from:
- **Review body** — use the qualifying review's `body` from Step 3a directly.
- **Inline thread** — when the finding originated from one of Step 3a's
  `reviewThreads.nodes[]` rather than (or in addition to) the review body, prefer that
  thread's inline-thread anchor — its first comment's stable `path` and `line`, plus its
  `body` — over freeform PR-comment text matching. A thread's `path`/`line` pinpoints the
  exact code location a finding is about; matching on freeform comment prose alone is
  comparatively unreliable prose-similarity guessing at what a comment refers to, especially
  across differently-worded restatements of the same underlying issue. If the candidate
  reply is itself a reply to that specific thread (an inline thread reply, not a PR-level
  comment), correlate against the thread's `path`/`line` first and its text second.

`SAME_FINDING` means the candidate reply is a rebuttal of the same underlying issue the
current review/finding is raising again — the reviewer read that rebuttal and is still
unconvinced. `DIFFERENT_FINDING` means the reply addresses a different issue that merely
happens to predate this review's timestamp (the PR #2153 case) — unrelated content, no real
second round.

**If at least one candidate reply is judged `SAME_FINDING`** (a genuine second round on the
same disagreement): escalate instead of looping. Skip the rest of Step 5 for this PR
entirely — do not dispatch the fix subagent, do not post another rebuttal, and do not reset
`reviewState`. Escalate to HITL following `references/escalation-pattern.md`'s shared
PATCH/comment/release sequence, with an extra thread-resolution step inserted between the
comment and the claim release:

- **`{blockedReason}`**: `"second-round disagreement between reviewer and automated fix —
  escalated to HITL"`
- **`{comment_body}`**: "This finding was already rebutted once and the review still
  disagrees after re-evaluating that rebuttal — this looks like a genuine disagreement
  between the reviewer and the automated fix, not something another automated pass will
  resolve. Flagging for a human decision instead of rebutting again."
- **`{temp_file_slug}`**: `escalation` (temp file: `/tmp/shipwright-patch-escalation-{pr}.txt`
  — note this site's slug is `escalation`, not `blocked-5a7`, since it fires before
  dispatch rather than after a BLOCKED report)
- **`PR_TASK_ID`**: reused from Step 2.1 (no fresh fetch — Step 2.1 queried
  `GET /tasks?repo={org}/{repo}&pr={pr}` and resolved `PR_TASK_ID` to the highest-tier match
  right after Step 2 resolved this same PR, independent of any claim, so it's already
  available by the time this check runs)
- **Claim released**: the pre-work claim from Step 5a.6

**Extra step, unique to this site — resolve unresolved inline threads before releasing the
claim.** Resolve **all** currently-unresolved inline threads on this PR (from Step 3a's
`reviewThreads.nodes[]`) — not just threads tied to the qualifying second-round review.
Step 3a's query carries no field linking a thread back to the review that raised it (only
`id`, `isResolved`, and the first comment's `author.login`/`body`/`path`/`line`), so scoping
resolution to "threads belonging to" a specific review isn't something this step can
actually determine. Escalating already means giving up on automated resolution for this
cycle — the PR comment posted above tells the human reader that everything was escalated
for manual review, not silently fixed, so resolving every open thread here carries no
silent-dismissal risk. Leaving any thread unresolved, however, would leave it
`isResolved == false`, so Step 3a's List A criteria would re-flag this same PR next cycle
and re-fire this same escalation indefinitely — the exact loop this step exists to close.
Use the same mutation as Step 5b [D]/[E]:

```bash
gh api graphql -f query='
mutation {
  resolveReviewThread(input: {threadId: "{thread.id}"}) {
    thread { isResolved }
  }
}'
```

Run this for the Thread ID of every thread in Step 3a's `reviewThreads.nodes[]` with
`isResolved == false`. If there are none, there is nothing to resolve — move on. Do this
before releasing the pre-work claim from Step 5a.6.

After releasing the claim, print:
```
⏸ PR #{pr} — second-round disagreement detected, escalating to HITL (task {PR_TASK_ID or "none"}). Skipping rebuttal/reset for this cycle.
```

Move to the next qualifying PR in List A. If no candidates remain, continue to Step 6.

**Otherwise** — either no candidate replies were found at all in Step 1 (a first-round
rebuttal, or no rebuttal history at all), or candidates were found but every one was judged
`DIFFERENT_FINDING` in Step 2 (timestamp precedence matched, but content correlation ruled
out a real second round, as in the PR #2153 incident): this is unaffected by RPF-1.3. Treat
it as a first-round finding and proceed normally to Step 5b.

RPF-1.1/1.2 behavior applies as before.

### Step 5b: Dispatch Fix Subagent

Renew the claim heartbeat now, before dispatching — addressing review findings can run
long enough on its own to threaten the claim TTL, in addition to the renewal after it
completes in Step 5c.5:

```bash
curl -s -o /dev/null -X POST \
  -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
  "$SHIPWRIGHT_TASK_STORE_URL/prs/$PR_RECORD_ID/heartbeat"
```

Dispatch a `general-purpose` subagent via the Agent tool, passing `model: PATCH_MODEL`
(resolved once in Step 2.1) so the fix subagent runs at the escalated tier, with this
prompt. When Step 3a.5 set `DEPENDENCY_RISK_FINDING` for this PR with recommendation
`review` or `hold`, include the DEPENDENCY-RISK REMEDIATION PROTOCOL block below — it is
additive, injected ahead of (not replacing) the existing [A.5] verify/classify
instructions:

```
You are addressing review findings on a pull request. Apply fixes, validate, commit, push,
and resolve the addressed GitHub threads.

PR: #{pr} — {title}
Repo: {org}/{repo}
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

{Only present when Step 3a.5 set DEPENDENCY_RISK_FINDING for this PR with recommendation
"review" or "hold" — a "merge" recommendation has nothing to remediate, per
references/dependency-patch.md's Inputs section, so omit this whole block for it. This
section is additive, ahead of the [A.5] verify/classify instructions below — it does not
replace them.}
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

[C] Validate
  - Run: {lint command}
  - Run: {test command}
  - Fix any failures introduced by your changes
  - Re-run until both pass cleanly

[C.5] Add test coverage
  - Detect the test framework and file-naming conventions from nearby existing tests in
    the repo
  - Add or update a test covering the new or changed behavior, following those existing
    patterns
  - Re-run {test command} from [C] to confirm the new test passes alongside the rest
  - If no test is needed (test-file-only change, config change, or pure deletion with no
    new behavior), state that explicitly instead of adding one

[D] Commit
  These two conditions are independent — both can fire in the same run (a mixed
  ACCEPT+REJECT outcome), only the first can fire (all findings accepted/modified), only
  the second can fire (all findings rejected), or neither (nothing to do).

  - **If at least one finding was ACCEPTED or MODIFIED** (i.e. you have file changes
    staged):
    - Stage only the files you changed: `git add {changed files}`
    - Commit with a conventional commit message describing what was fixed:
      "fix: address review findings on #{pr} — {one-line summary of changes}"
    - Push: `git push origin {branch}`

  - **If any finding was classified REJECT in [A.5]** (regardless of whether other
    findings in the same run were ACCEPTED/MODIFIED and handled above): post a PR-level
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
    gh api graphql -f query='
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
  gh api graphql -f query='
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
```

### Step 5c: Handle Subagent Status

Parse the subagent's STATUS:

- **DONE**: Record the findings addressed. Proceed to Step 5c.5 (upsert PR record).
- **DONE_WITH_CONCERNS**: Read concerns. If any concern reports a REJECTed finding (per
  Step 5b Instructions [D], this fires whenever at least one finding was REJECTed —
  whether every finding in the run was REJECTed with no push at all, one branch of a mixed
  ACCEPT+REJECT run where a push also happened, or a mixed run where no push happened
  because every ACCEPTED/MODIFIED finding in that run resolved to a zero-diff no-op
  alongside the REJECTed one(s)), confirm the subagent's CONCERNS text reports both that it
  already posted the required `gh pr comment` rebuttal AND that it resolved the inline
  threads for the REJECTed findings. Both are needed — the rebuttal activates the
  `isAddressedByAuthorReply` escape hatch in `check-patch.ts`, but
  `hasUnaddressedFindings()` short-circuits to `true` on any unresolved inline thread before
  that escape hatch is even consulted, so the threads must also be resolved or the review
  stops being reflagged only for body-level findings, not inline ones (the common case).
  Do not post the comment here or resolve the threads here; Step 5c only verifies it
  already happened. If the report doesn't confirm both, treat it as a concern in the final
  report (the reflagging loop will otherwise persist regardless of which no-push variant
  produced it). For other, non-REJECT correctness-gap concerns, just log them in the
  report. Either way, always proceed to Step 5c.5 (upsert PR record) — when a push happened
  there IS a new commit SHA to record, and when no push happened Step 5c.5's ledger write
  for any REJECTed findings still needs to run (see below), even though there is no new
  commit SHA.

  Record the set of REJECTed findings from this cycle for Step 5c.5's ledger write,
  whenever the rebuttal-confirmation check above found at least one REJECTed finding
  (independent of push/no-push — a mixed ACCEPT+REJECT run that also pushed a commit still
  has REJECTed findings needing a ledger entry). For each REJECTed finding in the
  subagent's CONCERNS, capture:
  - **`ref`**: the same identifier already used to resolve that finding's thread in Step 5b
    Instructions [D] — the inline thread's `path:line` for inline findings, or a short slug
    for PR-body-level findings with no inline thread.
  - **`evidence`**: the rejection reason already written into the rebuttal comment for that
    finding.

  Set `REJECTED_FINDINGS_THIS_CYCLE` to this list (empty if no finding was REJECTed this
  cycle, e.g. the plain `DONE` case above or a `DONE_WITH_CONCERNS` run with only
  non-REJECT concerns) before proceeding to Step 5c.5.
- **BLOCKED**: This is a first-round BLOCKED report from the fix subagent itself — distinct
  from Step 5a.7's (RPF-1.3) second-round-disagreement escalation, which fires *before*
  dispatch when the same finding was already rebutted once. Here the subagent was dispatched
  and came back unable to complete the fix. The same unbounded-retry risk applies: a generic
  release with no escalation flag makes this PR immediately re-eligible for
  `check-patch.ts`'s `getPatchCandidates()` on the next `shipwright-loop` tick. Escalate to
  HITL first, following `references/escalation-pattern.md`'s shared PATCH/comment/release
  sequence, before releasing the claim:

  - **`{blockedReason}`**: `"review-finding fix blocked — automated fix subagent could not
    complete"`
  - **`{comment_body}`**: "The review-finding fix subagent reported BLOCKED and could not
    complete — flagging for a human decision instead of retrying indefinitely."
  - **`{temp_file_slug}`**: `blocked-5c` (temp file:
    `/tmp/shipwright-patch-blocked-5c-{pr}.txt`)
  - **`PR_TASK_ID`**: reused from Step 2.1 (no fresh fetch)
  - **Claim released**: the pre-work claim from Step 5a.6

  Log the blocker. Skip Steps 5c.5 and 5d. Move to the next qualifying PR.
  Include the blocker in the final report.

### Step 5c.5: Upsert PR Record

The record was already claimed pre-work in Step 5a.6 — `PR_RECORD_ID` is already set, so
this renews the claim's heartbeat and increments `patchCycles` rather than re-claiming.
Warn and continue on any failure — do not stop.

```bash
if [ -n "$PR_RECORD_ID" ]; then
  curl -s -o /dev/null -X POST \
    -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
    "$SHIPWRIGHT_TASK_STORE_URL/prs/$PR_RECORD_ID/heartbeat" || \
    echo "⚠ heartbeat renewal failed — continuing"
  HEAD_SHA_POST_PATCH=$(git -C ${SHIPWRIGHT_WORKTREE_DIR:-$HOME/worktrees}/{repo}-{branch-slug} rev-parse HEAD)
  curl -sf -X POST \
    -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
    -H "Content-Type: application/json" \
    "$SHIPWRIGHT_TASK_STORE_URL/prs/$PR_RECORD_ID/patch" \
    -d "{\"commitSha\": \"$HEAD_SHA_POST_PATCH\"}" > /dev/null 2>&1 || \
    echo "⚠ POST /prs/$PR_RECORD_ID/patch failed — continuing"
  # Run once per entry in REJECTED_FINDINGS_THIS_CYCLE (from Step 5c) — {finding.ref} is
  # that finding's path:line (or slug); {finding.evidence} is its rejection reason.
  curl -sf -X POST \
    -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
    -H "Content-Type: application/json" \
    "$SHIPWRIGHT_TASK_STORE_URL/prs/$PR_RECORD_ID/findings" \
    -d "{\"ref\": \"{finding.ref}\", \"disposition\": \"rejected\", \"source\": \"patch\", \"evidence\": \"{finding.evidence}\", \"agentId\": \"$SHIPWRIGHT_AGENT_ID\"}" \
    > /dev/null 2>&1 || \
    echo "⚠ POST /prs/$PR_RECORD_ID/findings (rejected) failed — continuing"
else
  echo "⚠ no PR_RECORD_ID from pre-work claim — skipping PR record update"
fi
```

Run the ledger-write `curl` once for each entry in `REJECTED_FINDINGS_THIS_CYCLE` (assigned
in Step 5c — see there for how it's populated), POSTing one `source: "patch"`,
`disposition: "rejected"` finding per REJECTed finding this cycle to
`/prs/$PR_RECORD_ID/findings`, with `ref` set to that finding's identifying `path:line` (or
slug, for PR-body-level findings) and `evidence` set to the rejection reason already used in
the rebuttal comment. If `REJECTED_FINDINGS_THIS_CYCLE` is empty, skip this call entirely —
there is nothing to record. This runs unconditionally whenever
`REJECTED_FINDINGS_THIS_CYCLE` is non-empty, on both a no-push all-REJECT cycle and a mixed
ACCEPT+REJECT run that pushed a commit.

This ledger POST is now the sole mechanism that makes a no-push rebuttal cycle re-qualify
for review: `agent/src/check-review.ts`'s `hasFreshLedgerFinding` (PFL-3.1) treats any
`PrFinding.at` newer than the record's `reviewedAt` as new information, re-qualifying the PR
for review regardless of whether `headRefOid` changed. (PFL-4.1 removed this step's earlier
manual `reviewState: "pending"` reset, kept deliberately by PFL-2.2 as a stopgap until
PFL-3.1's ledger-timestamp trigger went live in production — the ledger POST above already
fires on every REJECTed finding, so the manual reset was fully redundant once PFL-3.1
shipped.)

Proceed to Step 5d (cleanup).

### Step 5d: Cleanup Worktree

After a successful push (subagent status DONE or DONE_WITH_CONCERNS with push completed):

```bash
git -C ${SHIPWRIGHT_REPO_DIR:-$HOME/src}/{repo} worktree remove ${SHIPWRIGHT_WORKTREE_DIR:-$HOME/worktrees}/{repo}-{branch-slug} --force
```

---

## Step 6: Fix Failing CI in Worktree

For each PR in List D, set up a worktree, collect CI failure output, check for an
already-recorded HITL escalation, and dispatch a fix subagent if none exists. Fully
complete one PR (fix → push → cleanup) before moving to the next.

### Step 6a: Set Up Worktree

Same pattern as Step 5a — branch slug = branch name with `/` replaced by `-`:

```bash
git -C ${SHIPWRIGHT_REPO_DIR:-$HOME/src}/{repo} fetch origin
git -C ${SHIPWRIGHT_REPO_DIR:-$HOME/src}/{repo} worktree add ${SHIPWRIGHT_WORKTREE_DIR:-$HOME/worktrees}/{repo}-{branch-slug} origin/{branch}
```

If the worktree already exists:
```bash
git -C ${SHIPWRIGHT_REPO_DIR:-$HOME/src}/{repo} worktree remove ${SHIPWRIGHT_WORKTREE_DIR:-$HOME/worktrees}/{repo}-{branch-slug} --force
git -C ${SHIPWRIGHT_REPO_DIR:-$HOME/src}/{repo} worktree add ${SHIPWRIGHT_WORKTREE_DIR:-$HOME/worktrees}/{repo}-{branch-slug} origin/{branch}
```

### Step 6a.5: Detect Project Toolchain

Check the cache before any fresh detection, then fall back to docs-first discovery and config-file scanning — see `references/toolchain-patterns.md`'s "Caching Across Runs" and "Docs-First Discovery" sections for the exact protocol:

1. Compute the fingerprint against `{worktree-path}` and read `state/toolchain-cache/{repo}.json`. If the file exists and its fingerprint matches, reuse the cached **lint**/**test**/**tests** commands and skip to Step 6b.
2. Otherwise, read `CLAUDE.md` + `docs/*.md`/`ai-docs/*.md` for explicit lint/test commands first (authoritative if found), then fall back to the config-file lookup table in `references/toolchain-patterns.md` to fill any gaps.
3. Store detected commands:
   - **{lint command}**: e.g., `bun run lint`, `cargo clippy`, `golangci-lint run`
   - **{test command}**: e.g., `bun test`, `cargo test`, `go test ./...`, `pytest`
   - **{tests}**: optional object of additional test layers (e.g., `{"integration": "pytest tests/integration", "e2e": "npx playwright test"}`) — omit when only one test command exists
4. On a cache miss, overwrite `state/toolchain-cache/{repo}.json` with the new fingerprint + commands.

### Step 6b: Collect CI Failure Output

Find the most recent failing run on the PR's branch and collect its logs:

```bash
# Get the most recent failed run ID
RUN_ID=$(gh run list --branch {branch} --repo {org}/{repo} \
  --json databaseId,conclusion \
  --jq '[.[] | select(.conclusion == "failure")] | first | .databaseId')

# Collect failure logs (last 200 lines to keep context manageable)
gh run view "$RUN_ID" --log --failed --repo {org}/{repo} 2>&1 | tail -200
```

Store the log output for use in the subagent prompt.

Compute a stable failure signature from the failing job names — sorted and comma-joined so
the same set of failing jobs always produces the same signature regardless of job-completion
order, matching Step 6d.5's already-existing `ciFailureSignature` field on the task store's
`POST /prs/:id/patch` (CSD-1.1):

```bash
CI_FAILURE_SIGNATURE=$(gh run view "$RUN_ID" --json jobs \
  --jq '[.jobs[] | select(.conclusion=="failure") | .name] | sort | join(",")')
```

Store `CI_FAILURE_SIGNATURE` for use in Step 6d.5's PR record upsert.

### Step 6b.5: Claim PR Record (pre-work lock)

The fix subagent dispatched next can run long enough to overlap with another patch run
(or a stale leftover claim from `/shipwright:review`, e.g. a still-claimed
`phase: "review"` record left behind after posting — the record stays claimed until
released or reaped). Without a pre-work claim, two overlapping patch runs could both
dispatch competing fix subagents against the same branch. Claim the PR record with
`phase: "patch"` now, before starting the fix, mirroring deploy.md's Step 4a pre-merge
claim:

**Pre-Claim Fast Path (CBD-1.5).** If a pre-claim marker was captured in Step 2, validate
it against this site's live head before trusting it — the head can have moved since Step 2
(or since List C's/List A's fix ran), so re-fetch fresh here rather than trusting the
Step 2 parse:

```bash
headRefOid=$(gh pr view {pr} --repo {org}/{repo} --json headRefOid -q '.headRefOid')
```

- **`headRefOid == PRECLAIM_COMMIT_SHA`** (marker is current): trust it. Set
  `PR_RECORD_ID = PRECLAIM_RECORD_ID` and **skip this site's own `/prs/claim` call below**
  — the orchestrator's `/prs/claim` already holds this PR under `phase: "patch"`.
  Proceed directly to Step 6b.6 (`PR_RECORD_ID` is reused by the post-fix update in Step
  6d.5, same as the self-claim path).
- **`headRefOid != PRECLAIM_COMMIT_SHA`** (stale marker — new commits landed between the
  orchestrator's claim and now) **or no marker present**: fall back to self-claiming
  exactly as today — run the claim below unchanged.

```bash
HEAD_SHA_PRE_PATCH=$(git -C ${SHIPWRIGHT_WORKTREE_DIR:-$HOME/worktrees}/{repo}-{branch-slug} rev-parse HEAD)
PR_CLAIM=$(curl -s -o /tmp/pr_claim_patch.json -w '%{http_code}' -X POST \
  -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
  -H "Content-Type: application/json" \
  "$SHIPWRIGHT_TASK_STORE_URL/prs/claim" \
  -d "{\"repo\": \"{org}/{repo}\", \"prNumber\": {pr}, \"commitSha\": \"$HEAD_SHA_PRE_PATCH\", \"phase\": \"patch\"}")
PR_RECORD_ID=$(jq -r '.id // empty' /tmp/pr_claim_patch.json)
```

**If `PR_CLAIM` is `409`** (another patch run already claimed this PR at phase `patch`):
do NOT dispatch the fix subagent. Print:
```
⏸ PR #{pr} is already claimed by another patch run — skipping.
```
Skip the rest of Step 6 for this PR. Move to the next PR in List D. If no candidates
remain, continue to Step 7.

**Otherwise** (`200` or `201`): the claim succeeded. `PR_RECORD_ID` is reused by the
post-fix update in Step 6d.5 — no second claim call is needed. Proceed to Step 6b.6.

### Step 6b.6: Escalation Check (CFE-1.1)

Step 5a.7 (RPF-1.3) escalates a second-round review disagreement to HITL instead of
dispatching a third automated fix — but it only guards List A (review findings). Once that
escalation comment exists on the PR, CPF-2.3's reply-after-review exclusion drops the PR
from List A on the next cycle (the comment postdates the review). If CI is still failing,
Step 3c puts the same PR into List D, and without this check Step 6 would dispatch a
CI-fix subagent that directly contradicts the HITL decision Step 5a.7 already recorded —
re-attempting exactly what that step decided not to retry a third time. Nothing else resets
`readyForPatchAt` or `reviewState` after that escalation releases its claim, so this can
re-trigger every patch cycle. Before dispatching the CI-fix subagent, check whether this PR
already has an unresolved HITL escalation.

1. Fetch the PR record fresh via `GET` — do not trust a possibly-stale claim response, same
   "re-fetch fresh" principle Step 6b.5's Pre-Claim Fast Path already applies to
   `headRefOid`:
   ```bash
   PR_RECORD=$(curl -sf -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
     "$SHIPWRIGHT_TASK_STORE_URL/prs/$PR_RECORD_ID")
   PR_BLOCKED=$(echo "$PR_RECORD" | jq -r '.blocked // false')
   ```
2. Query the task store directly by PR number — `PR_RECORD.taskId` no longer exists
   (PTL-3.1), and a direct query finds every task linked to this PR, including bundles:
   ```bash
   MATCHED_TASKS=$(curl -sf -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
     "$SHIPWRIGHT_TASK_STORE_URL/tasks?repo={org}/{repo}&pr={pr}")
   TASK_BLOCKED=$(echo "$MATCHED_TASKS" | jq -r \
     '[.tasks[]? | select(.hitl == true or .status == "blocked")] | length > 0')
   PR_TASK_ID=$(echo "$MATCHED_TASKS" | jq -r '.tasks[0].id // empty')
   ```
   `TASK_BLOCKED` is an **OR across every matched task** — `true` if ANY matched task has
   `hitl === true` OR `status === 'blocked'`, not just the first one. This mirrors the same
   multi-match semantics task PTL-1.1 applies on the TypeScript side in
   `agent/src/check-helpers.ts`'s `isTaskBlockedForDispatch`, kept consistent here in prose
   form. `PR_TASK_ID` is set to the first matched task's id (or empty if zero tasks match) —
   Step 6d's BLOCKED handling reuses this single scalar for its own PATCH-to-blocked
   escalation, so one task id is still exposed here even though the blocked-check above
   considers every match.

**If `PR_BLOCKED` is `true` OR `TASK_BLOCKED` is `true`** (an unresolved HITL escalation already
exists — most likely from Step 5a.7 on this same PR, this cycle or a prior one): skip —
do not dispatch the fix subagent, since doing so would silently contradict the escalation
decision already recorded on the PR.

1. Release the pre-work claim from Step 6b.5 — no fix is in flight, this cycle intentionally
   stops short of dispatching one:
   ```bash
   curl -s -o /dev/null -X POST \
     -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
     "$SHIPWRIGHT_TASK_STORE_URL/prs/$PR_RECORD_ID/release"
   ```
2. Print:
   ```
   ⏸ PR #{pr} already has an unresolved HITL escalation — skipping CI-fix dispatch.
   ```
3. Move to the next PR in List D. If no candidates remain, continue to Step 7.

**Otherwise** (neither the PR record has `blocked: true` nor any matched task has
`hitl === true` or `status === 'blocked'`): no escalation is on record for this PR —
proceed to Step 6b.7. If no matching tasks were found for this PR (zero results from the
`GET /tasks?repo=&pr=` query), this branch is the only possible outcome for the task side
of the check — there's no task-based escalation signal to read, so only `PR_BLOCKED` (from
the PR record) can trigger the escalation branch above, same as today's no-linked-task
default.

### Step 6b.7: Bundle Completeness Gate (PH-1.1)

`check-patch.ts`'s `isBundleComplete` (CPB-1.1) already filters this PR's candidacy on the
same signal before dispatch is ever considered — but that filter only guards the
`shipwright-loop`-driven path. A human running `/shipwright:patch org/repo#123` directly
bypasses `check-patch.ts` entirely, and time can also pass between candidate selection and
this point in the run (a bundle-mate task can start, or get blocked, after this PR was
selected). Mirror deploy.md's Step 2b here, immediately before Step 6c's dispatch, so an
incomplete bundle is caught on both paths — this is where a prior CI-fix-on-an-incomplete-
bundle incident actually happened: re-query the same sibling-branch-status signal now, right
before dispatching the CI-fix subagent, rather than trusting the state candidate selection saw.

```bash
BRANCH_TASKS=$(curl -sf -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" "$SHIPWRIGHT_TASK_STORE_URL/tasks?branch={branch}" 2>/dev/null || echo '{"tasks":[],"total":0,"limit":50,"offset":0}')
INCOMPLETE_TASKS=$(echo "$BRANCH_TASKS" | jq '[.tasks[] | select(.status == "pending" or .status == "in_progress" or .status == "blocked") | {id, status}]')
INCOMPLETE=$(echo "$INCOMPLETE_TASKS" | jq 'length')
```

**If `INCOMPLETE > 0`** (one or more bundle-mate tasks on this branch are still in flight):
do NOT dispatch the fix subagent — a CI-fix pushed now would land on top of a branch that
other tasks are still actively developing.

1. Release the pre-work claim from Step 6b.5 — no fix is in flight, this cycle intentionally
   stops short of dispatching one:
   ```bash
   curl -s -o /dev/null -X POST \
     -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
     "$SHIPWRIGHT_TASK_STORE_URL/prs/$PR_RECORD_ID/release"
   ```
2. Print:
   ```
   ⏸ Bundle gate: {INCOMPLETE} task(s) on branch {branch} are still in flight:
     {for each item in INCOMPLETE_TASKS: "  - {id} ({status})"}
     Deferring CI-fix dispatch until bundle-mates reach pr_open.
   ```
3. Stop here. `patch.md` is explicit-single-PR-target-only (WLS-3.3) — there is no other
   candidate to fall back to, so this fully stops the command rather than moving on to
   another PR the way Step 6b.6 does. Emit `[skip-reason:patch:deferred:bundle-incomplete:{branch}]`
   alongside `[silent]` (interpolating `{branch}` from the value already in scope) — order
   relative to `[silent]` does not matter, both are recognized regardless of position. The
   skip-reason marker records exactly which branch's bundle gate blocked this dispatch in the
   `AgentCronRun.skipReason` field, visible in the admin cron-logs UI, instead of the generic
   `command:no-work` reason the loop orchestrator falls back to for silent dispatches that
   don't tag a specific reason.

**Otherwise** (`INCOMPLETE == 0` — no tasks tracked on this branch, or all tasks are past
`pending`/`in_progress`/`blocked`): the bundle is complete — proceed to Step 6b.8.

### Step 6b.8: Rerun-First for Cancelled-Only CI (PCC-1.1)

Per the Candidate Selection Contract, `check-patch.ts`'s `getPatchCandidates` (via
`fetchCiStatus`'s `hasCancelled` field) already decided this PR is a valid patch candidate —
this step re-validates current-state safety immediately before acting, it does not
requalify. Step 3c tracked, per PR, which List D signal(s) applied: `CI_HAS_FAILING` (a
genuine `failure`/`timed_out` run) and/or `CI_HAS_CANCELLED` (a `cancelled` latest run for
some workflow, with `CANCELLED_RUN_ID` holding the qualifying run's `id`).

**Gate — cancelled-only, no failure/timed_out:** this step only applies when
`CI_HAS_CANCELLED=true` AND `CI_HAS_FAILING` is NOT also true for this PR. A cancelled run
is not equivalent to a real test failure — it is most often a job that hit
`timeout-minutes` and was reported by GitHub's API as `cancelled` rather than `timed_out`,
or an external cancellation with no code-level cause at all. A cheap rerun is a safe,
essentially no-op action even for workflows that use `concurrency`/`cancel-in-progress`
(e.g. `chart-release.yml`, `sync-plugin-version.yml`, `auto-bump-chart.yml`,
`deploy-site.yml`) — this gate is scoped to the PR's latest-run state, not to workflow
identity, so it is safe to run unconditionally whenever the cancelled-only condition holds.

**If the gate does not hold** (`CI_HAS_FAILING=true`, with or without an additional
cancelled run elsewhere on this PR): this PR has a genuine failure/timed_out run — skip this
step entirely, completely unaffected by the cancelled-only branch, and proceed directly to
Step 6c exactly as before.

**Otherwise** (cancelled-only): attempt a rerun before touching anything else — no commit,
no subagent dispatch in this branch.

```bash
gh run rerun "$CANCELLED_RUN_ID" --repo {org}/{repo}
```

Poll for a terminal result — a brief, bounded poll (not the full CI gate used elsewhere):
every 15 seconds, up to 8 times (~2 minutes total). On each poll iteration, renew the claim
heartbeat first, same reasoning as the heartbeat renewals before every subagent dispatch in
Steps 4b/5b/6c:

```bash
curl -s -o /dev/null -X POST \
  -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
  "$SHIPWRIGHT_TASK_STORE_URL/prs/$PR_RECORD_ID/heartbeat"

gh run view "$CANCELLED_RUN_ID" --repo {org}/{repo} --json status,conclusion
```

Keep polling while `status` is `queued`, `in_progress`, or `waiting`. Stop as soon as
`status == "completed"`.

**Poll window exhausted with no terminal result:** treat this as inconclusive — the rerun
must not leave the PR in limbo. Fall through to Step 6c exactly as the failed/cancelled case
below does.

**If the rerun's terminal `conclusion` is `success`, or any other non-cancelled,
non-failure terminal state** (e.g. `neutral`, `skipped`): the PR is resolved — the cancelled
CI was indeed stale/transient. Skip Step 6c entirely for this PR:

1. Release the pre-work claim from Step 6b.5 — no fix is in flight, the rerun alone resolved
   the PR:
   ```bash
   curl -s -o /dev/null -X POST \
     -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
     "$SHIPWRIGHT_TASK_STORE_URL/prs/$PR_RECORD_ID/release"
   ```
2. Print:
   ```
   ✓ PR #{pr} — cancelled run {CANCELLED_RUN_ID} rerun succeeded, no fix needed — skipping CI-fix dispatch.
   ```
3. Move to the next PR in List D. If no candidates remain, continue to Step 7.

**If the rerun itself ends `cancelled` or `failure` (or the poll window is exhausted without
a terminal result, per above):** this is a repeated-timeout/hang signal, not a normal test
failure — fall through to Step 6c as normal. Before dispatching, collect the job's abnormal
duration vs. its typical duration for the Step 6c prompt, if obtainable:

```bash
gh api "repos/{org}/{repo}/actions/runs/$CANCELLED_RUN_ID/jobs" \
  --jq '.jobs[] | {name, started_at, completed_at}'
```

Approximate a typical duration from a handful of recent successful runs of the same
workflow (best-effort — use your judgment on how deep to go; this is context for the
subagent prompt, not a statistical guarantee):

```bash
gh run list --workflow {workflow-name-or-id} --repo {org}/{repo} --status success \
  --limit 5 --json startedAt,updatedAt
```

Store both durations (or a note that typical duration was unavailable) as
`{repeated-timeout-context}` for use in Step 6c's prompt. Proceed to Step 6c.

### Step 6c: Dispatch Fix Subagent

Renew the claim heartbeat now, before dispatching — fixing CI can run long enough on its
own to threaten the claim TTL, in addition to the renewal after it completes in Step 6d.5:

```bash
curl -s -o /dev/null -X POST \
  -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
  "$SHIPWRIGHT_TASK_STORE_URL/prs/$PR_RECORD_ID/heartbeat"
```

Dispatch a `general-purpose` subagent via the Agent tool, passing `model: PATCH_MODEL`
(resolved once in Step 2.1) so the CI-fix subagent runs at the escalated tier, with this
prompt:

```
You are fixing failing CI on a pull request. Diagnose the failures, apply fixes, validate locally, commit, and push.

PR: #{pr} — {title}
Repo: {org}/{repo}
Branch: {branch}
Worktree: {worktree-path}

TOOLCHAIN:
  Lint command: {lint command}
  Test command: {test command}
  Test layers:  {if tests is non-empty, list each as "layer: command"; otherwise "none"}

CI FAILURE OUTPUT (last 200 lines):
{log output from Step 6b}

{if arriving via Step 6b.8's cancelled-only rerun-first branch (the rerun itself ended
cancelled or failure, or its poll window was exhausted with no terminal result), include:
"NOTE — REPEATED TIMEOUT/HANG SIGNAL: this PR's CI was cancelled (not a normal test
failure), a rerun was attempted, and the rerun ALSO ended {cancelled|failure|inconclusive
after polling}. This looks like a repeated timeout/hang rather than a deterministic test
failure. Job duration vs. typical duration: {repeated-timeout-context from Step 6b.8, or
'unavailable' if the duration lookup failed}. Investigate whether the job is hanging,
hitting `timeout-minutes`, or genuinely regressed before treating this as an ordinary
failing-test fix."}

INSTRUCTIONS — follow in order:

[A] Diagnose the failures
  - Read the CI failure output carefully
  - Identify which tests, lint rules, or build steps are failing
  - Read the relevant files from the worktree to understand the root cause

[B] Apply fixes
  - Work file by file, addressing each failure
  - Do not introduce unrelated changes
  - If a failure is caused by a flaky test or an external dependency, note it in concerns
    rather than patching around it

[C] Validate
  - Run: {lint command}
  - Run: {test command}
  - Fix any failures introduced by your changes
  - Re-run until both pass cleanly

[C.5] Add test coverage
  - Detect the test framework and file-naming conventions from nearby existing tests in
    the repo
  - Add or update a test covering the new or changed behavior, following those existing
    patterns
  - Re-run {test command} from [C] to confirm the new test passes alongside the rest
  - If no test is needed (test-file-only change, config change, or pure deletion with no
    new behavior), state that explicitly instead of adding one

[D] Commit
  - Stage only the files you changed: `git add {changed files}`
  - Commit with a conventional commit message describing what was fixed:
    "fix: resolve CI failures on #{pr} — {one-line summary of changes}"
  - Push: `git push origin {branch}`

[E] Report back
  At the end, output:

  STATUS: DONE / DONE_WITH_CONCERNS / BLOCKED

  FAILURES_FIXED:
  {bullet list of each CI failure addressed and how}

  TESTS_ADDED:
  {bullet list of tests added, or "none — {justification}" if [C.5] determined no test
  was needed}

  CONCERNS: (if DONE_WITH_CONCERNS)
  BLOCKER: (if BLOCKED)
```

### Step 6d: Handle Subagent Status

Parse the subagent's STATUS:

- **DONE**: Record the failures fixed. Proceed to Step 6d.5 (upsert PR record).
- **DONE_WITH_CONCERNS**: Read concerns. If the push already happened, log concerns and
  proceed to Step 6d.5 (upsert PR record). If the subagent did not push, note it in the
  final report and skip Step 6d.5.
- **BLOCKED**: The CI-fix subagent (dispatched in Step 6c) reported it could not complete.
  A generic BLOCKED release with no escalation flag makes this PR immediately re-eligible
  for `check-patch.ts`'s `getPatchCandidates()` on the next `shipwright-loop` tick — and,
  absent the `blocked` flag Step 6b.6 (CFE-1.1) checks for, also re-eligible to have this
  same CI-fix subagent re-dispatched against it next cycle. Escalate to HITL first,
  following `references/escalation-pattern.md`'s shared PATCH/comment/release sequence,
  before releasing the claim — this is the same `blocked` flag Step 6b.6 already reads
  pre-dispatch (it runs before dispatch, this runs after a BLOCKED report; they compose
  without conflict):

  - **`{blockedReason}`**: `"CI-fix blocked — automated CI-fix subagent could not
    complete"`
  - **`{comment_body}`**: "The CI-fix subagent reported BLOCKED and could not complete —
    flagging for a human decision instead of retrying indefinitely."
  - **`{temp_file_slug}`**: `blocked-6d` (temp file:
    `/tmp/shipwright-patch-blocked-6d-{pr}.txt`)
  - **`PR_TASK_ID`**: reused from Step 6b.6 (no fresh fetch — note this differs from the
    other BLOCKED sites, which reuse Step 2.1's resolution instead)
  - **Claim released**: the pre-work claim from Step 6b.5

  Log the blocker. Skip Steps 6d.5 and 6e. Move to the next PR in List D.
  Include the blocker in the final report.

### Step 6d.5: Upsert PR Record

The record was already claimed pre-work in Step 6b.5 — `PR_RECORD_ID` is already set, so
this renews the claim's heartbeat and increments `patchCycles` rather than re-claiming.
Warn and continue on any failure — do not stop.

This is the only site among Steps 4c.5/5c.5/6d.5 where a CI failure signature is available
— Step 6b computed `CI_FAILURE_SIGNATURE` above, but Steps 4 (merge conflicts) and 5 (review
findings) never run Step 6b, so they have no signature to report. Build the `patch` payload
body conditionally so this step only sends `ciFailureSignature` when one was actually
computed this cycle:

```bash
if [ -n "$PR_RECORD_ID" ]; then
  curl -s -o /dev/null -X POST \
    -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
    "$SHIPWRIGHT_TASK_STORE_URL/prs/$PR_RECORD_ID/heartbeat" || \
    echo "⚠ heartbeat renewal failed — continuing"
  HEAD_SHA_POST_PATCH=$(git -C ${SHIPWRIGHT_WORKTREE_DIR:-$HOME/worktrees}/{repo}-{branch-slug} rev-parse HEAD)
  if [ -n "$CI_FAILURE_SIGNATURE" ]; then
    PATCH_BODY="{\"commitSha\": \"$HEAD_SHA_POST_PATCH\", \"ciFailureSignature\": \"$CI_FAILURE_SIGNATURE\"}"
  else
    PATCH_BODY="{\"commitSha\": \"$HEAD_SHA_POST_PATCH\"}"
  fi
  curl -sf -X POST \
    -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
    -H "Content-Type: application/json" \
    "$SHIPWRIGHT_TASK_STORE_URL/prs/$PR_RECORD_ID/patch" \
    -d "$PATCH_BODY" > /dev/null 2>&1 || \
    echo "⚠ POST /prs/$PR_RECORD_ID/patch failed — continuing"
else
  echo "⚠ no PR_RECORD_ID from pre-work claim — skipping PR record update"
fi
```

Proceed to Step 6e (cleanup).

### Step 6e: Cleanup Worktree

After a successful push (subagent status DONE or DONE_WITH_CONCERNS with push completed):

```bash
git -C ${SHIPWRIGHT_REPO_DIR:-$HOME/src}/{repo} worktree remove ${SHIPWRIGHT_WORKTREE_DIR:-$HOME/worktrees}/{repo}-{branch-slug} --force
```

---

## Step 6.5: Verify CI After Patch

Steps 4, 5, and 6 each fix a different condition (merge conflict, review finding, failing
CI) and push independently. A push from any one of them can leave CI red in a way none of
the individual steps re-checks — e.g. a conflict resolution or a review-finding fix can
introduce a new test failure that Step 6's own CI-fix pass never ran against, since Step 6
only fires when List D already flagged the PR *before* any of this cycle's pushes. Before
reporting success in Step 7, verify the PR's actual, current HEAD SHA is green.

**Only runs if at least one push happened this cycle.** If Step 4c/4c.5, Step 5c/5c.5, and
Step 6d/6d.5 all completed this run with no successful push (no DONE or DONE_WITH_CONCERNS
report reached its post-fix upsert step with a changed HEAD SHA), there is nothing new to
verify — the PR's CI state is exactly what Step 3c already evaluated. Skip Step 6.5 entirely
with a one-line message and proceed directly to Step 7:
```
⏭ No commit pushed this cycle — skipping CI verification.
```

Otherwise, proceed below.

### Step 6.5a: Poll for the Final CI Result

Reuse the same "poll the GitHub Actions API, dedupe by latest run per workflow, skip
cleanly when nothing is configured" pattern as `dev-task.md`'s Step 9b.2 — same shape, a
tighter cadence: 30-second interval, capped at **~5 minutes** (10 polls max) rather than
Step 9b.2's 10-minute cap, since this is a final gate on a patch cycle that already ran
fixes, not a first-attempt wait.

Resolve the repo and current HEAD SHA (the worktree for whichever of Steps 4/5/6 pushed
last has already been cleaned up in 4d/5d/6e, so re-fetch live from GitHub rather than a
local worktree path):

```bash
REPO="{org}/{repo}"
HEAD_SHA=$(gh pr view {pr} --repo {org}/{repo} --json headRefOid -q '.headRefOid')
```

Poll every 30 seconds, up to 10 times (~5 minutes total). On **each poll iteration**, renew
the claim heartbeat first — this loop can run long enough on its own to threaten the claim
TTL, same reasoning as the heartbeat renewals before every subagent dispatch in Steps
4b/5b/6c:

```bash
curl -s -o /dev/null -X POST \
  -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
  "$SHIPWRIGHT_TASK_STORE_URL/prs/$PR_RECORD_ID/heartbeat"

gh api "repos/$REPO/actions/runs?head_sha=$HEAD_SHA&per_page=20" \
  --jq '[.workflow_runs[] | {id, name, workflow_id, run_number, status, conclusion}]'
```

Filter to runs where `head_sha == HEAD_SHA`. Keep polling while any run has `status` of
`queued`, `in_progress`, or `waiting`. **Deduplicate by workflow:** evaluate only the latest
run per workflow (highest `run_number` per `workflow_id`), same as Step 3c and `dev-task.md`
Step 9b.2, to avoid a stale failed run being counted alongside its passing rerun.

**No CI configured:** if no matching runs appear after 60 seconds (2 polls), skip the rest
of Step 6.5 and proceed to Step 7 — mirroring `dev-task.md` Step 9b.2's identical
no-CI-configured skip. Print:
```
⏭ No CI checks configured — skipping CI verification gate
```

**All checks pass:** if all latest-per-workflow runs have `conclusion == "success"`, print
and proceed to the existing Step 7 report unchanged:
```
✓ CI checks passed after patch
```

**Poll window exhausted (~5 minutes) with any check still failing or pending:** treat it as
still-red and continue to Step 6.5b.

### Step 6.5b: Dispatch One Bonus CI-Fix Subagent on Still-Red

If CI is still red after the poll window, collect fresh failure logs using the same
approach as Step 6b (most recent failed run on the branch, last 200 lines):

```bash
RUN_ID=$(gh run list --branch {branch} --repo {org}/{repo} \
  --json databaseId,conclusion \
  --jq '[.[] | select(.conclusion == "failure")] | first | .databaseId')

gh run view "$RUN_ID" --log --failed --repo {org}/{repo} 2>&1 | tail -200
```

Re-set up the worktree the same way Step 6a does (it was already removed by whichever of
4d/5d/6e cleaned up after this cycle's push), then dispatch **exactly one** bonus CI-fix
subagent using the exact same prompt template as Step 6c — do not restate or duplicate that
prompt text here — substituting these freshly-collected failure logs for the `CI FAILURE
OUTPUT` block and this same `{pr}`/`{title}`/`{org}`/`{repo}`/`{branch}`/`{worktree-path}`
context. Pass `model: PATCH_MODEL`, same as Step 6c. This bonus dispatch pushes once if the
subagent succeeds — do not re-poll or retry further after it reports back, regardless of
outcome. This is a single bonus attempt, not a new fix loop.

**On DONE or DONE_WITH_CONCERNS with a push:** log the fix, clean up the worktree (same
pattern as Step 6e), and proceed to the existing Step 7 report unchanged.

**On BLOCKED:** reuse the exact same HITL-escalation branch as Step 6d's BLOCKED handling —
same `status: 'blocked'` PATCH to the linked task (or the PR record when no task is linked),
same PR comment convention, same claim release — rather than adding a new escalation path
here. Log the blocker and proceed to the existing Step 7 report unchanged.

---

## Step 7: Report

After processing all three lists, print a summary:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
PATCH COMPLETE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

REVIEW FINDINGS ({A} PR(s)):
{for each PR in List A:
  "#{pr} — {title} ({org}/{repo})
   {if DONE or DONE_WITH_CONCERNS with push: "✓ Fixed and pushed"}
   {if BLOCKED: "✗ Blocked: {blocker summary}"}
   {if DONE_WITH_CONCERNS: "⚠ Concerns: {concern summary}"}
   Findings addressed:
   {bullet list from subagent FINDINGS_ADDRESSED}"}

MERGE CONFLICTS ({C} PR(s)):
{for each PR in List C:
  "#{pr} — {title} ({org}/{repo})
   {if DONE or DONE_WITH_CONCERNS with push: "✓ Conflicts resolved and pushed"}
   {if BLOCKED: "✗ Blocked: {blocker summary}"}
   {if DONE_WITH_CONCERNS: "⚠ Concerns: {concern summary}"}
   Conflicts resolved:
   {bullet list from subagent CONFLICTS_RESOLVED}"}

FAILING CI ({D} PR(s)):
{for each PR in List D:
  "#{pr} — {title} ({org}/{repo})
   {if DONE or DONE_WITH_CONCERNS with push: "✓ Fixed and pushed"}
   {if BLOCKED: "✗ Blocked: {blocker summary}"}
   {if DONE_WITH_CONCERNS: "⚠ Concerns: {concern summary}"}
   Failures fixed:
   {bullet list from subagent FAILURES_FIXED}"}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```
