---
description: Lean review variant — review a specific open PR, deep single-pass review with inline comments, policy-controlled posting (spine plus references)
argument-hint: "org/repo#number"
---
# Review (lean)
Review one named PR; no patching or merging. Same behavior contract as `commands/review.md`; mechanics live in `plugins/shipwright/references/review-lean/` and cuts are listed in [dropped-details.md](../references/review-lean/dropped-details.md). Each
`plugins/shipwright/references/required-steps/review.json` step ends with a **Proof:** line. Guards stay here; when one fires, apply its stop rule. Execution order is the section order below (Step 14 runs first) — never reorder. **Runs autonomously.** PR state lives in the task store `/prs` API; the
narrative goes to `$WORKSPACE_ROOT/state/reviews/PR_REVIEW_{pr}.md` and `pr_review_{pr}.json`. Task store env unset → invoke `/shipwright:task-store`. Every task-store call: `curl -sf` with `Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN` (+ `Content-Type: application/json` with a body).
## Arguments
`$ARGUMENTS` (`org/repo#number`, or `number`/`#number` using `repos[0]`) is **required**. **No arguments**: respond `[silent]` and stop immediately — before any GitHub or task-store query; no PR discovery. A trailing `[preclaim:{recordId}:{commitSha}]` marker (loop orchestrator only, CBD-1.3):
extract `PRECLAIM_RECORD_ID`/`PRECLAIM_COMMIT_SHA` and strip it before parsing. Never posts a staged review.
## Step 1: Config, Identity
`WORKSPACE_ROOT=$(pwd)`. One config fetch serves policy, subagent type and `repos[0]` (`select(. != null)`,
never `// empty`, which would discard a deliberately-set `false`):
```bash
CONFIG_JSON=$(curl -sf -H "Authorization: Bearer $SHIPWRIGHT_AGENT_API_KEY" "$SHIPWRIGHT_API_URL/agents/$SHIPWRIGHT_AGENT_ID/config"); AUTO_POST_REVIEWS=$(echo "$CONFIG_JSON" | jq -r '.autoPostReviews | select(. != null)'); ALLOW_SELF_REVIEW=$(echo "$CONFIG_JSON" | jq -r '.allowSelfReview | select(. != null)')
MIN_CONFIDENCE=$(echo "$CONFIG_JSON" | jq -r '.minConfidence | select(. != null)'); MAX_FINDINGS=$(echo "$CONFIG_JSON" | jq -r '.maxFindings | select(. != null)'); REVIEW_SUBAGENT_TYPE=$(echo "$CONFIG_JSON" | jq -r '.phaseMethodology.review // "shipwright:code-reviewer"'); REVIEW_SUBAGENT_TYPE=${REVIEW_SUBAGENT_TYPE:-shipwright:code-reviewer}
```
Unset or failed → defaults `auto_post_reviews` true, `allow_self_review` false, `min_confidence` 75, `max_findings` 5; the subagent type fails closed to the built-in (RVM-1.2). Print `Policy: {staging|auto-posting} reviews`. Bare number → `org/repo` from `.repos[0] // empty` (else the workspace
repo). `CURRENT_USER=$(bun run "${CLAUDE_PLUGIN_ROOT}/scripts/login-identity.ts")` is the canonical login (`app/` and `[bot]` stripped, lowercased); canonicalize `author.login`/`PR_AUTHOR` the same way before every comparison.
## Step 14: Resolve, Dedup and Claim (runs before Steps 4-11)
**Live-Review Pre-Check (RVD-1.2)** — before any record fetch, claim or checkout, even with a pre-claim marker (the cross-task-store dedup layer). `gh api` has no `--arg`; pipe to `jq`:
```bash
precheck=$(SHIPWRIGHT_GH_OWNER={org} gh api graphql -f query='{ repository(owner: "{org}", name: "{repo}") { pullRequest(number: {pr}) { author { login } title headRefName headRefOid comments(last: 50) { nodes { author { login } createdAt } } reviews(first: 50) { nodes { body state submittedAt commit { oid } } } } } }' \
  | jq --arg currentUser "$CURRENT_USER" 'def canon: sub("^app/"; "") | sub("\\[bot\\]$"; "") | ascii_downcase; .data.repository.pullRequest as $pr | ([$pr.reviews.nodes[] | select(.commit.oid == $pr.headRefOid and ((.body | test("verdict\\**\\s*:\\s*\\**(approve|comment)\\b"; "i")) or .state == "APPROVED")) | .submittedAt] | max) as $maxTerminalSubmittedAt | {headRefOid: $pr.headRefOid, terminal: (if $maxTerminalSubmittedAt != null then ([$pr.comments.nodes[] | select((.author.login | canon) != ($currentUser | canon) and (.createdAt > $maxTerminalSubmittedAt)) | .createdAt] | length == 0) else false end), authorLogin: $pr.author.login, title: $pr.title, headRefName: $pr.headRefName}')
headRefOid=$(echo "$precheck" | jq -r '.headRefOid'); terminal=$(echo "$precheck" | jq -r '.terminal'); PR_AUTHOR=$(echo "$precheck" | jq -r '.authorLogin'); PR_TITLE=$(echo "$precheck" | jq -r '.title'); PR_HEAD_REF=$(echo "$precheck" | jq -r '.headRefName')
```
`terminal` = a review at head whose body carries a `Verdict: APPROVE|COMMENT` label or whose `state` is `APPROVED`, with no comment by anyone other than `CURRENT_USER` after the latest one ([guards-detail.md](../references/review-lean/guards-detail.md)). **Record lookup** (once, reused):
`PRECLAIM_RECORD_ID` set → `PR_RECORD_ID` = it, `record` = `GET /prs/{PR_RECORD_ID}`; else `record` = `GET /prs?repo={org}/{repo}&prNumber={pr}` piped to `jq -c '.prs[0] // empty'`, `PR_RECORD_ID` = `.id`; `LAST_REVIEWED_COMMIT` = `.reviewedCommitSha`. **Settle-and-stop `{reason}`** — one atomic
PATCH, no separate release (`reviewState: "posted"` clears `claimedBy`/`claimedAt`/`heartbeatAt`/`phase`): `NOW=$(date -u +"%Y-%m-%dT%H:%M:%SZ")`; `PATCH /prs/{PR_RECORD_ID}` with `-d "$(jq -n --arg sha "$headRefOid" --arg now "$NOW" '{reviewState: "posted", reviewedCommitSha: $sha, reviewedAt: $now}')"`
(advancing `reviewedAt` stops `hasFreshNonAgentComment` re-selecting the PR every tick, RCT-1.1); print the caller's line; emit `[skip-reason:review:deferred:{reason}:{pr}]` immediately before `[silent]` (a tagged defer never counts toward `SKIP_BLOCK_THRESHOLD`); stop.
- `terminal` true → record lookup, then settle-and-stop `already-reviewed-at-head` (PATCH only if `PR_RECORD_ID` is set and the record is not already `posted`/`approved` at `headRefOid`), printing `Skipping #{pr} — a review already exists at this commit (${headRefOid:0:7}) on GitHub (cross-task-store check), nothing to do.`
  No claim, no checkout.
- **Pre-Claim Fast Path (CBD-1.4)**: marker present → `headRefOid=$(gh pr view {pr} --repo {org}/{repo} --json headRefOid -q '.headRefOid')`; equal to `PRECLAIM_COMMIT_SHA` → `PR_RECORD_ID = PRECLAIM_RECORD_ID`, skip the record fetch, staged check, dedup check and the claim call; go to Step 4.
  `LAST_REVIEWED_COMMIT` stays unset, so Step 5's Unresolved Comment Check treats it as a first review. Stale or no marker → continue.
- Record lookup, then the live `headRefOid` (same `gh pr view`). **Staged** (`staged: true`): head == `reviewedCommitSha` → print `#{pr} already has a staged review ({verdict}) waiting on a decision.` and `Run /shipwright:review-staged to post, skip, or discuss it.` (`approved` → APPROVE, else
  COMMENT), stop; head moved → claim, print `Staged review is stale — {pr} has new commits since the review was written ({record.reviewedCommitSha[0..7]} → {headRefOid[0..7]}).`, re-review.
- **Dedup**: `reviewState` `posted`/`approved` and head == `reviewedCommitSha` → settle-and-stop `already-reviewed-at-head`, printing `Skipping #{pr} — already reviewed at this commit ({headRefOid[0..7]}), nothing to do.` No record, `pending`, or head moved → claim.
## Step 4: Claim, Worktree, Model Tier
```bash
PR_CLAIM=$(curl -s -o /tmp/pr_claim.json -w '%{http_code}' -X POST -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" -H "Content-Type: application/json" "$SHIPWRIGHT_TASK_STORE_URL/prs/claim" \
  -d "$(jq -n --arg repo "{org}/{repo}" --argjson prNumber {pr} --arg commitSha "$headRefOid" --arg authorLogin "$PR_AUTHOR" --arg headRef "$PR_HEAD_REF" --arg title "$PR_TITLE" --arg claimedBy "${SHIPWRIGHT_AGENT_ID:-local}" '{claimedBy: $claimedBy, repo: $repo, prNumber: $prNumber, commitSha: $commitSha, authorLogin: $authorLogin, headRef: $headRef, title: $title}')")
```
Skipped on the fast path. `201`/`200` → `PR_RECORD_ID` = `.id` of `/tmp/pr_claim.json`; `409` → another agent holds the claim: `[silent]`, stop. Then `git -C repos/{repo} fetch origin` and `git -C repos/{repo} worktree add ${SHIPWRIGHT_WORKTREE_DIR:-$HOME/worktrees}/{repo}-{branch-slug} origin/{branch}`
(`/` → `-`; a leftover worktree is `worktree remove --force`d first). Later steps run there; `state/reviews/` always uses `$WORKSPACE_ROOT`. Model tier — linked tasks by repo+PR, highest tier wins; failure or no match leaves it unset, never a stop: `TASK_MODEL=$(curl -sf -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" "$SHIPWRIGHT_TASK_STORE_URL/tasks?repo={org}/{repo}&pr={pr}" | jq -r '[.tasks[]?.model | select(. != null)] as $models | {opus: 3, sonnet: 2, haiku: 1} as $rank | ($models | map($rank[.]) | max) as $maxRank | if $maxRank == null then empty else ($rank | to_entries | map(select(.value == $maxRank)) | .[0].key) end') || echo "⚠ failed to fetch linked tasks for model lookup — continuing"`
## Step 5: Gather Context
1. `gh pr view {pr} --repo {org}/{repo} --json number,title,author,headRefName,baseRefName,headRefOid,additions,deletions,changedFiles,body`; `PR_AUTHOR` = `.author.login`. 2. `base=$(gh pr view {pr} --repo {org}/{repo} --json baseRefName -q '.baseRefName')`; `git diff "origin/$base"...HEAD` —
   always `origin/$base`, never bare `$base`. 3. Changed files from the diff. **Sanity check**: about 2x+ the metadata's `changedFiles` → wrong merge-base; stop and diagnose (`git fetch origin`), never review a wrong diff. 4. CI: `gh api "repos/{org}/{repo}/actions/runs?branch={branch}&per_page=5" -q '.workflow_runs[] | "\(.name): \(.status) \(.conclusion)"'`
   (not `gh pr checks`).
5. Review state in one GraphQL call (pass the whole `{nodes: [...]}` connection objects through unchanged), then the findings ledger (fail soft to `[]`):
```bash
RESPONSE=$(SHIPWRIGHT_GH_OWNER={org} gh api graphql -f query='{ repository(owner: "{org}", name: "{repo}") { pullRequest(number: {pr}) { headRefOid reviews(first: 50) { nodes { author { login __typename } state submittedAt commit { oid } body } } reviewThreads(first: 100) { nodes { id isResolved comments(first: 20) { totalCount nodes { author { login __typename } body path line createdAt } } } } comments(first: 50) { nodes { author { login __typename } body createdAt } } commits(last: 1) { nodes { commit { pushedDate } } } } } }')
P=.data.repository.pullRequest; HEAD_REF_OID=$(jq -r "$P.headRefOid" <<< "$RESPONSE"); LAST_PUSH_DATE=$(jq -r "$P.commits.nodes[0].commit.pushedDate" <<< "$RESPONSE"); REVIEWS_JSON=$(jq -c "$P.reviews" <<< "$RESPONSE")
REVIEW_THREADS_JSON=$(jq -c "$P.reviewThreads" <<< "$RESPONSE"); COMMENTS_JSON=$(jq -c "$P.comments" <<< "$RESPONSE")
PR_FINDINGS_JSON=$(curl -sf -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" "$SHIPWRIGHT_TASK_STORE_URL/prs/${PR_RECORD_ID}" | jq -c '.findings // []' 2>/dev/null || echo '[]')
```
**Prior qualifying reviews (PVD-1.2)**: `CURRENT_USER` reviews with `state` `COMMENTED`/`CHANGES_REQUESTED`, non-empty `body`, `commit.oid !== headRefOid`, not excluded by `compute-unaddressed-findings.ts`'s exported `isSelfCleanApprove`/`isSupersededBySelfReview` (reuse, never re-derive) →
`priorQualifyingReviews` = `{ref, body}`, `ref` = `reviewRef(review)` = full `${review.commit.oid}@${review.submittedAt}` (never a short SHA). **Ledger POST** — one form for every ledger write; non-fatal; every one completes before Step 11b's `/complete`, never after: `curl -sf -X POST ... "$SHIPWRIGHT_TASK_STORE_URL/prs/${PR_RECORD_ID}/findings" -d "$(jq -n --arg ref "$REF" --arg disposition "$DISPOSITION" --arg evidence "$EVIDENCE" '{ref: $ref, disposition: $disposition, source: "review", evidence: $evidence}')" >/dev/null 2>&1 || echo "⚠ ledger POST failed for $REF — continuing (non-fatal)"`.
**PFL-2.1**: each excluded review → POST `resolved` (clean self-APPROVE) or `superseded` (cite the later review's `submittedAt`); evidence strings: [ledger-and-findings.md](../references/review-lean/ledger-and-findings.md).
6. Root CLAUDE.md + CLAUDE.md files in directories containing changed files. 7. `testReadinessContext`: the worktree's `docs/test-readiness/test-system.md`, plus the root CLAUDE.md "## Testing" section when test files changed (by the project's conventions); neither → omit the field.

**Unresolved Comment Check (UCC-1.1).** `LAST_REVIEWED_COMMIT` set and `headRefOid != LAST_REVIEWED_COMMIT` → skip it (new commits override). Otherwise decide mechanically, never by judgment:
```bash
bun run "${CLAUDE_PLUGIN_ROOT}/scripts/compute-unresolved-comment-check.ts" "$(jq -n --arg currentUser "$CURRENT_USER" --arg prAuthor "$PR_AUTHOR" --arg headRefOid "$HEAD_REF_OID" --arg lastReviewedCommit "$LAST_REVIEWED_COMMIT" --arg lastPushDate "$LAST_PUSH_DATE" --argjson reviews "$REVIEWS_JSON" --argjson comments "$COMMENTS_JSON" --argjson reviewThreads "$REVIEW_THREADS_JSON" \
    '{currentUser: $currentUser, prAuthor: $prAuthor, headRefOid: $headRefOid, lastReviewedCommit: (if $lastReviewedCommit == "" then null else $lastReviewedCommit end), lastPushDate: $lastPushDate, reviews: $reviews, comments: $comments, reviewThreads: $reviewThreads}')"
```
`hasSubstantiveUnresolvedFeedback: true` → settle-and-stop `unresolved-human-feedback` (its PATCH also sets `commitSha` to `headRefOid`; never `staged`), printing `Skipping #{pr} — unresolved feedback from @{login} ({type} on {date}). No commits since.` Reconciler caveat: guards-detail.md.
8. Renew the claim heartbeat before the long review phase: `curl -s -o /dev/null -X POST -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" "$SHIPWRIGHT_TASK_STORE_URL/prs/{PR_RECORD_ID}/heartbeat"`.
**Proof:** the Step 5.5 GraphQL `reviewThreads` fetch runs; print `5.5 review state: {threads} reviewThreads, {reviews} reviews, {ledger} ledger entries`.
## Step 5.8: Dependency Manifest Detection (DBR-3.2)
```bash
RENOVATE_JSON=$(cat renovate.json 2>/dev/null || echo ""); DEPENDABOT_YML=$(cat .github/dependabot.yml 2>/dev/null || echo "")
WATCHED_PATHS_RESULT=$(bun run "${CLAUDE_PLUGIN_ROOT}/scripts/resolve-dependency-watched-paths.ts" "$(jq -n --arg renovateJson "$RENOVATE_JSON" --arg dependabotYml "$DEPENDABOT_YML" '{renovateJson: (if $renovateJson == "" then null else $renovateJson end), dependabotYml: (if $dependabotYml == "" then null else $dependabotYml end)}')")
```
Runs for any PR (from the worktree root) — not gated on `PR_AUTHOR`. A changed file matches a `paths` entry by **exact match**; by **basename match** only when the entry is a bare filename (no `/`); or by **directory-prefix match** when the entry ends with `/`. Match → Read
[dependency-risk-analysis.md](../references/dependency-risk-analysis.md), apply its heuristics and carry `DEPENDENCY_RISK_ANALYSIS` (`recommendation`, `flags`, `reasoning`) to Steps 9 and 10, never merged into the findings list. No match → no dependency section anywhere downstream.
## Step 6: Classify Changes
Classify why / what / view / API / database / architecture / breaking / testing changes ([review-file-template.md](../references/review-lean/review-file-template.md)); note each, even "none".
### Step 6.1: Compute Risk Signals (RSK-2.1)
```bash
RISK_SIGNALS=$(bun run "${CLAUDE_PLUGIN_ROOT}/scripts/compute-pr-risk-signals.ts" "$(jq -n --argjson files "$FILES_JSON" --arg ci "$CI_STATUS" --arg repoDir "." '{files: $files, ci: {status: $ci}, repoDir: $repoDir}')") || { RISK_SIGNALS=""; echo "⚠ risk signals failed — continuing without a Risk line (non-fatal)"; }
```
`FILES_JSON` = `[{path, additions, deletions}]` from `git diff --numstat "origin/$base"...HEAD`; `CI_STATUS` = Step 5's CI mapped to `passing|failing|pending|unknown`; failure is non-fatal.
**Proof:** `compute-pr-risk-signals.ts` runs; print `6.1 risk signals: {totalPoints} points`, or the `⚠ risk signals failed` line.
## Step 7: Deep Review (dispatch `shipwright:code-reviewer` subagent)
Dispatch `subagent_type: REVIEW_SUBAGENT_TYPE` via the Agent tool, `model: TASK_MODEL ?? 'sonnet'`, `run_in_background: false` (synchronous; no wakeup or poll), contract per [methodology-contracts/review.md](../references/methodology-contracts/review.md). One prompt block: PR metadata (`number`,
`title`, `author`, `headRefName`, `baseRefName`, `headRefOid`); the full `origin/$base` diff; the changed files; each CLAUDE.md as a labeled block; policy `min_confidence`/`max_findings`; `acceptanceCriteria` if the PR maps to a task; `testReadinessContext`; and, when `priorQualifyingReviews` is
non-empty, `Prior Findings — Requires Resolution Check` listing each `ref` and full `body`, asking for one `priorFindingsStatus[]` entry per `ref`. Omit each optional input when empty. Never review inline instead — no size exemption. Output shape:
[step7-dispatch.md](../references/review-lean/step7-dispatch.md). **Failure chain (RVM-1.2)**: malformed JSON or a failed dispatch → retry once (same type, schema reminder); then the built-in default falls back to an inline review per `agents/code-reviewer.md`, an override to a fresh built-in (own
retry, then inline). At most override → retry → built-in → retry → inline; never loop. Step 7 always ends with a valid response. **Multiple reviewers (MPS-2.1)**: if `REVIEW_SUBAGENT_TYPE` contains a comma, Read [multi-reviewer.md](../references/review-lean/multi-reviewer.md) before dispatching.
Dispatch all reviewers in one parallel Agent call; merge their responses before any Step 8 threshold; when more than one response survives, verify with `shipwright:finding-verifier` (non-fatal on failure). Assign `PRIOR_FINDINGS_STATUS_JSON` = the parsed `priorFindingsStatus[]` as a compact JSON
array, or `[]` when none was returned. Each `resolved: true` entry → ledger POST `resolved` with its `ref` and `evidence` verbatim. Append each `riskAssessment` to `RISK_ASSESSMENTS`, then (non-fatal, Risk line omitted on failure): `RISK_RATING=$(bun run "${CLAUDE_PLUGIN_ROOT}/scripts/compute-risk-rating.ts" "$(jq -n --argjson heuristic "$RISK_SIGNALS" --argjson subagents "$RISK_ASSESSMENTS" '{heuristic: $heuristic, subagents: $subagents}')") || { RISK_RATING=""; echo "⚠ risk rating failed — omitting Risk line (non-fatal)"; }`
**Proof:** an Agent dispatch of `REVIEW_SUBAGENT_TYPE` (each reviewer when multi-reviewer).
## Steps 8-10.5: Score, Write, Gate, Verdict
**Step 8.** Drop findings below `min_confidence`, trim to `max_findings` (lowest confidence first), group by `severity`; `CURRENT_PASS_HAS_BLOCKING_FINDINGS` = any remaining `important`/`critical` finding. **Step 9.** Write `$WORKSPACE_ROOT/state/reviews/PR_REVIEW_{pr}.md` from
[review-file-template.md](../references/review-lean/review-file-template.md); when the file already exists, append its Review Update section instead (Prior Findings Resolution table from `priorFindingsStatus[]`).
### Step 9.5: Unaddressed-Findings Hard Gate (RUC-1.1, PVD-1.1, PVD-1.3)
```bash
bun run "${CLAUDE_PLUGIN_ROOT}/scripts/compute-unaddressed-findings.ts" \
  "$(jq -n --arg currentUser "$CURRENT_USER" \
    --arg prAuthor "$PR_AUTHOR" \
    --arg headRefOid "$HEAD_REF_OID" \
    --argjson reviews "$REVIEWS_JSON" \
    --argjson reviewThreads "$REVIEW_THREADS_JSON" \
    --argjson comments "$COMMENTS_JSON" \
    --argjson priorFindingsStatus "$PRIOR_FINDINGS_STATUS_JSON" \
    --argjson findings "$PR_FINDINGS_JSON" \
    '{currentUser: $currentUser, prAuthor: $prAuthor, headRefOid: $headRefOid, reviews: $reviews, reviewThreads: $reviewThreads, comments: $comments, priorFindingsStatus: $priorFindingsStatus, findings: $findings}')"
# -> {"unaddressedFindings":true|false}
```
Computed mechanically, never by judgment (`PR_AUTHOR` as `prAuthor`; `PRIOR_FINDINGS_STATUS_JSON` from Step 7, `[]` when none). `UNADDRESSED_FINDINGS` = its output. True → the verdict is `COMMENT` regardless of the subagent's recommendation; never skip this gate because another input already forces
`COMMENT`. Exclusions summary: ledger-and-findings.md.
**Proof:** print `9.5 unaddressed findings: {UNADDRESSED_FINDINGS}`.
### Step 10: Build Review JSON
`SELF_REVIEW` = canonical `PR_AUTHOR == CURRENT_USER` (GitHub rejects self-APPROVE). Mechanics: [post-review-guide.md](../references/post-review-guide.md).
```bash
bun run "${CLAUDE_PLUGIN_ROOT}/scripts/compute-review-verdict.ts" \
  "{\"selfReview\": ${SELF_REVIEW}, \"unaddressedFindings\": ${UNADDRESSED_FINDINGS}, \"currentPassHasBlockingFindings\": ${CURRENT_PASS_HAS_BLOCKING_FINDINGS}}"
# -> {"event":"APPROVE"|"COMMENT","verdictLabel":"APPROVE"|"COMMENT"}
```
Use `event` and `verdictLabel` verbatim in `$WORKSPACE_ROOT/state/reviews/pr_review_{pr}.json` (`commit_id`, `body`, `event`, `comments[]`). The `body` MUST lead with the literal `Verdict: APPROVE` or `Verdict: COMMENT` matching `verdictLabel` — also when `event` is forced to `COMMENT` by
self-review. Append the dependency-risk clause and (only when `verdictLabel` is APPROVE and `RISK_RATING` is set) the Risk line after that lead-in; inline comments only on diff-hunk lines: [verdict-folding.md](../references/review-lean/verdict-folding.md).
### Step 10.5: Hard-Gate Validation (Before Posting)
```bash
bun run "${CLAUDE_PLUGIN_ROOT}/scripts/compute-review-verdict.ts" \
  "$(jq -n --arg body "$BODY" --argjson selfReview "$SELF_REVIEW" --argjson unaddressedFindings "$UNADDRESSED_FINDINGS" --argjson currentPassHasBlockingFindings "$CURRENT_PASS_HAS_BLOCKING_FINDINGS" '{selfReview: $selfReview, unaddressedFindings: $unaddressedFindings, currentPassHasBlockingFindings: $currentPassHasBlockingFindings, body: $body}')"
```
`BODY` = the built `body`. `valid: false` → **hard abort**: do not post or stage; print `error`, fix the body's `Verdict: {verdictLabel}` phrase, re-validate.
**Proof:** print `10.5 verdict validation: valid`, or the script's `error` before the fix.
## Step 11: Post or Stage
**Release** = `curl -s -o /dev/null -X POST -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" "$SHIPWRIGHT_TASK_STORE_URL/prs/${PR_RECORD_ID}/release"`. **`auto_post_reviews` false (staged):** `PATCH /prs/{PR_RECORD_ID}` with `{"staged": true, "reviewState": "approved" (APPROVE) or "posted" (COMMENT), "reviewedCommitSha": "{headRefOid}", "claimedBy": null, "claimedAt": null, "heartbeatAt": null, "phase": null}`,
print `Review staged for #{pr}.` No 11b. **`auto_post_reviews` true (default):**
1. **RHR-1.1**, immediately before the POST: `currentHeadRefOid=$(gh pr view {pr} --repo {org}/{repo} --json headRefOid -q '.headRefOid')`; mismatch with `headRefOid` → no POST, release, print `Aborted stale review for #{pr} -- head moved ({headRefOid[0..7]} -> {currentHeadRefOid[0..7]}) since claim; releasing for re-review.`,
   skip 11b, stop.
2. `POST_EXIT=0; gh api -X POST /repos/{org}/{repo}/pulls/{pr}/reviews --input $WORKSPACE_ROOT/state/reviews/pr_review_{pr}.json > "/tmp/pr_post_{pr}.json" 2>&1 || POST_EXIT=$?` — a temp file, never `echo "$var" | jq`. **Never re-execute this POST** (a duplicate review cannot be deleted); re-parse
   the file instead.
3. `REVIEW_URL`/`SUBMITTED_AT` = `.html_url // empty`/`.submitted_at // empty` from it. 4. `POST_EXIT != 0` or no `REVIEW_URL` → release, print `Warning: review post for #{pr} failed (exit {POST_EXIT}) — released claim, will retry next pass.`, skip 11b, stop.
5. **PFL-5.2**, before 11b: `SELF_REVIEW`=true, `UNADDRESSED_FINDINGS`=false, `CURRENT_PASS_HAS_BLOCKING_FINDINGS`=false and `SUBMITTED_AT` set → ledger POST `resolved`, `REF="${headRefOid}@${SUBMITTED_AT}"`. 6. Step 11b. 7. Print `Posted review for #{pr}: {REVIEW_URL}`.
### Step 11b: Mark PullRequest Record Posted
Only after a posted review, after every ledger POST. With `[ -n "$PR_RECORD_ID" ]` (else warn and skip): `POST /prs/{PR_RECORD_ID}/complete`, then `PATCH /prs/{PR_RECORD_ID}` with `agentId` = `$SHIPWRIGHT_AGENT_ID`, `reviewedCommitSha` = `headRefOid`, plus `reviewState: "approved"` for APPROVE.
**Never update task status when posting a review** — merge finds tasks by `pr_open`.
**Proof:** `POST /prs/{id}/complete` and the PATCH with `agentId`/`reviewedCommitSha`.
## Review Quality Rules
- **Verify before flagging** against the actual code, not just the diff; **check scope** with `git show origin/{base}:{file}` — present on base → out of scope.
- **Don't echo CI** unless your finding is the cause; **don't contradict CLAUDE.md**. **No filler language** ("FYI", "Note:"). **Organize by file and line**, in diff order. **Breaking API changes**: assume rolling deployments; flag removed endpoints, changed shapes and renamed fields as critical.
