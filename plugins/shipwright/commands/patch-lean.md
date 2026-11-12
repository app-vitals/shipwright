---
description: Lean patch variant — address review findings, merge conflicts, and failing CI on a specific own open PR (spine plus references)
argument-hint: "<org/repo#number>"
---

# Patch (lean)

Check one given PR for unaddressed review/PR comments (List A), merge conflicts (List C), and failing CI (List D); fix each in a
worktree through a subagent and push. Same behavior contract as `patch.md`; mechanics live in `plugins/shipwright/references/patch-lean/`
and cuts are listed in [dropped-details.md](../references/patch-lean/dropped-details.md). Each step ends with a **Proof:** line, the
observable signal that it ran (`plugins/shipwright/references/required-steps/patch.json`). No size exemption: an inline or sed-style fix
counts as skipping the subagent. Guards stay here; when one fires, apply its stop rule and Read the linked reference for exact strings.
**This command runs autonomously. Do not pause for user input.** Task store env unset → invoke `/shipwright:task-store` for setup.
Not wired to any cron: reached only via `SHIPWRIGHT_LOOP_PATCH_ALT_COMMAND`.

## Step 0: Require Explicit Target

`org/repo#number` is **required**. If `$ARGUMENTS` is empty, append `[silent]` and stop — no GitHub scan, no PR discovery.
An optional trailing `[preclaim:{recordId}:{commitSha}]` marker (loop orchestrator only, CBD-1.3): extract `PRECLAIM_RECORD_ID` and
`PRECLAIM_COMMIT_SHA` once and strip it before parsing the target. Each claim site re-validates it against the live head.

## Steps 1–2.5: Own Login, Target PR, BEHIND / DIRTY

Step 1: `CURRENT_USER=$(bun run "${CLAUDE_PLUGIN_ROOT}/scripts/login-identity.ts")`; fetch `PATCH_AUTHOR_ALLOWLIST` (`.patchAuthorAllowlist // []`
from `GET /agents/{id}/config`) as a JSON array, fail-closed to `[]`. Mechanics: [classification.md](../references/patch-lean/classification.md).
Step 2: `gh pr view {number} --repo {org}/{repo} --json number,title,headRefName,headRefOid,additions,deletions,mergeStateStatus,state,author`;
capture `PR_AUTHOR`, `PR_TITLE`, `PR_HEAD_REF`. In scope iff the canonical author equals `CURRENT_USER` or **exactly** equals an
allowlist entry (`jq -e` element-wise, never a substring test). Not found, `state != "OPEN"`, or out of scope → print
`⚠ PR {org}/{repo}#{number} not found among own open PRs.` and stop. Then resolve, once, `PATCH_MODEL` and `PR_TASK_ID` (2.1: one tier
above the highest matched task's model; no match → `sonnet`) and `PATCH_SUBAGENT_TYPE` (2.2: `.phaseMethodology.patch // "general-purpose"`),
reused by every dispatch: [model-resolution.md](../references/patch-lean/model-resolution.md).
Step 2.5: BEHIND → `gh pr update-branch {number} --repo {org}/{repo}` (merge, not `--rebase`); success → re-resolve `headRefOid`; failure → log
and continue. DIRTY → `gh pr update-branch --rebase {number} --repo {org}/{repo}`; failure leaves it for List C. BEHIND never joins List C.

## Step 3: Classify into Lists A / C / D

One GraphQL query (reviews, reviewThreads, comments) plus the PR record's findings ledger feed `compute-unaddressed-findings.ts`;
`unaddressedFindings: true` → List A. Never override the script by judgment (a clean self-APPROVE with no ledger entry IS in List A).
`mergeStateStatus == "DIRTY"` → List C. For a PR not in List C, a latest-run-per-workflow `failure`/`timed_out` → List D with
`CI_HAS_FAILING=true`; a latest run `cancelled` → List D with `CI_HAS_CANCELLED=true` and `CANCELLED_RUN_ID`. Queries and scripts:
[classification.md](../references/patch-lean/classification.md).

**Dependency-risk trigger (DBP-1.2).** If `PR_AUTHOR` is a Renovate/Dependabot bot, or the changed files include a package manifest or
lockfile, Read [dependency-risk.md](../references/patch-lean/dependency-risk.md) and apply it before finalizing List A. It sets
`DEPENDENCY_RISK_FINDING`, routes `hold`/`review` into List A, and clears the finding when `dependency-risk@{headRefOid}` is already held.

## Step 3d: Summary and No-Op Exit

If all three lists are empty, print `No PRs need attention.` and, if `PRECLAIM_RECORD_ID` is set, release the pre-claim by record id
first (regardless of head SHA; a failure is non-fatal; no marker → call nothing):
```bash
[ -n "$PRECLAIM_RECORD_ID" ] && curl -s -o /dev/null -X POST -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
  "$SHIPWRIGHT_TASK_STORE_URL/prs/$PRECLAIM_RECORD_ID/release" || true
```
Then emit `[silent]` with `[skip-reason:patch:deferred:no-op-at-dispatch:{pr}]`. `[silent]` is reserved for this genuinely-empty case:
a List A PR with nothing to fix ends settle-with-rejected (5c.5), never `[silent]`. Otherwise print the `Found {A} PR(s)...` summary.
**Proof:** `POST /prs/{id}/release` on the no-op exit when all lists are empty.

## Lane Skeleton (shared by Steps 4, 5, 6)

Lanes run in order 4 (List C) → 5 (List A) → 6 (List D); fully finish one (fix → push → cleanup) before the next. Each lane runs this
skeleton, parameterized by lane (full text: [lane-shared.md](../references/patch-lean/lane-shared.md)). Every guard that stops a lane
releases the claim (`POST /prs/{id}/release`) before moving on.

1. **Setup** — `fetch`, then `worktree add` `{repo}-{branch-slug}` (`/` → `-`), removing a leftover worktree first.
2. **Toolchain** — cache-first detection per [toolchain-patterns.md](../references/toolchain-patterns.md); prefer cached `lintScoped`.
3. **Claim** — Pre-Claim Fast Path: re-fetch live `headRefOid`; equal to `PRECLAIM_COMMIT_SHA` → `PR_RECORD_ID = PRECLAIM_RECORD_ID`, no
   claim call; else `POST /prs/claim` with `phase: "patch"` (+ `authorLogin`/`headRef`/`title`). `409` → print
   `⏸ PR #{pr} is already claimed by another patch run — skipping.` and skip the lane.
4. **Dispatch** — renew `POST /prs/{id}/heartbeat`, then dispatch `PATCH_SUBAGENT_TYPE` via the Agent tool with `model: PATCH_MODEL` and
   `run_in_background: false`, using the lane's prompt. Never apply the fix inline instead.
5. **Status** — no parseable `STATUS:` → retry once, then built-in fallback or BLOCKED (model-resolution.md). DONE → upsert.
   DONE_WITH_CONCERNS → upsert if pushed (lane 5 always upserts). BLOCKED → escalate via
   [escalation-pattern.md](references/escalation-pattern.md) with the lane's `{blockedReason}`/`{comment_body}`/slug; skip upsert.
6. **Upsert** — heartbeat, then `POST /prs/{id}/patch` with `commitSha` = `HEAD_SHA_POST_PATCH`; warn and continue on failure.
7. **Cleanup** — `worktree remove --force` after a successful push.

## Step 4: Merge Conflicts (List C)

Prompt and status strings: [lane-conflicts.md](../references/patch-lean/lane-conflicts.md). No pre-dispatch guards; 4a/4d = skeleton 1–2/7.

- **4a.6** Claim (skeleton 3). **Proof:** `POST /prs/claim` with `phase: "patch"` (or pre-claim marker validation).
- **4b** Heartbeat, then dispatch the conflict-resolution subagent (skeleton 4). **Proof:** an Agent dispatch.
- **4c** Status (skeleton 5); BLOCKED slug `blocked-4c`.
- **4c.5** Upsert (skeleton 6). **Proof:** `POST /prs/{id}/patch` with `commitSha` and heartbeat renewal.

## Step 5: Review Findings (List A)

Inputs, prompt, REJECT bookkeeping and ledger write: [lane-findings.md](../references/patch-lean/lane-findings.md). Guard strings and
mutations: [guards-escalation.md](../references/patch-lean/guards-escalation.md). Order is fixed: 5a.6 → 5a.6b → 5a.7 → 5b; 5d = skeleton 7.

- **5a** Setup, toolchain, inputs: diff vs base, unresolved threads (`id`/`path`/`line`), review bodies, `filter-bot-comments.ts` output.
- **5a.6** Claim (skeleton 3). **Proof:** `POST /prs/claim` with `phase: "patch"` (or pre-claim marker validation).
- **5a.6b** `.claude/**` check (CDH-1.2). An unresolved List A thread whose first comment's `path` starts with `.claude/` matches; a
  review body with a backticked `.claude/` span → apply guards-escalation.md's body fallback (ambiguous → no match). Match → do not
  dispatch, skip 5a.7 and 5b, escalate via escalation-pattern.md (slug `claude-dir`), resolve **all** unresolved inline threads,
  release the claim, print the `⏸ ... .claude/** write` line. **Proof:** that `⏸` line, or print `5a.6b .claude/** check: no match`.
- **5a.7** Second-round check (RPF-1.3). Candidates: PR-level comments by `PR_AUTHOR` with `createdAt` before a qualifying review's
  `submittedAt`. For each, print the candidate/finding block with `Judgment: SAME_FINDING | DIFFERENT_FINDING` and `Justification:`.
  A timestamp alone never escalates. Any `SAME_FINDING` → no dispatch, no rebuttal, no `reviewState` reset; escalate (slug
  `escalation`), resolve all unresolved inline threads, release, print the `⏸ ... second-round disagreement` line.
  **Proof:** the printed `Judgment:` block(s), or print `5a.7 second-round check: no candidate replies`.
- **5b** Heartbeat, then dispatch the fix subagent (skeleton 4) with Instructions [A]–[F]; add the DEPENDENCY-RISK REMEDIATION
  PROTOCOL block only when `DEPENDENCY_RISK_FINDING` is set with `review`/`hold`. **Proof:** an Agent dispatch.
- **5c** Status (skeleton 5); BLOCKED slug `blocked-5c`. Confirm the rebuttal comment and resolved REJECT threads; set
  `REJECTED_FINDINGS_THIS_CYCLE` to cover every List A item not fixed (PHS-2.1).
- **5c.5** Upsert (skeleton 6), then one `POST /prs/{id}/findings` (`source: "patch"`, `disposition: "rejected"`) per entry. Fixed
  nothing → settle-with-rejected, never `[silent]`. **Proof:** `POST /prs/{id}/patch` with `commitSha` and heartbeat renewal;
  `POST /prs/{id}/findings` for rejected findings ledger settlement.

## Step 6: Failing CI (List D)

Logs, prompt and upsert body: [lane-ci.md](../references/patch-lean/lane-ci.md); guard `curl` bodies and poll loop:
[guards-ci.md](../references/patch-lean/guards-ci.md); 6a/6e = skeleton 1–2/7. Fixed order: 6b.5 → 6b.6 → 6b.7 → 6b.8 → 6b.9 → 6c.

- **6b** Collect the latest failed run's logs (`tail -200`) and `CI_FAILURE_SIGNATURE` (failing job names, sorted, comma-joined).
- **6b.5** Claim (skeleton 3). **Proof:** `POST /prs/claim` with `phase: "patch"` (or pre-claim marker validation).
- **6b.6** Escalation check (CFE-1.1): fresh `GET /prs/{id}` → `PR_BLOCKED` (`.blocked`); `GET /tasks?repo={org}/{repo}&pr={pr}` →
  `TASK_BLOCKED` = ANY task with `hitl == true` OR `status == "blocked"`; `PR_TASK_ID` = first match (reused by 6d). Either true →
  release, print `⏸ PR #{pr} already has an unresolved HITL escalation — skipping CI-fix dispatch.`, end the lane.
  **Proof:** both GETs run; that `⏸` line, or print `6b.6 escalation check: none`.
- **6b.7** Bundle gate (PH-1.1): `GET /tasks?branch={branch}`; any task `pending`/`in_progress`/`blocked` → release, print the
  `⏸ Bundle gate:` list, and stop the whole command with `[silent]` and `[skip-reason:patch:deferred:bundle-incomplete:{branch}]`.
  **Proof:** the branch query runs; the skip-reason marker, or the bundle is complete.
- **6b.8** Rerun-first (PCC-1.1), only when `CI_HAS_CANCELLED=true` and `CI_HAS_FAILING` is not true: `gh run rerun "$CANCELLED_RUN_ID"`,
  poll `gh run view` every 15 s up to 8 times, renewing the heartbeat each iteration. Terminal non-failure, non-cancelled → release,
  print the `✓ ... rerun succeeded` line, skip 6c. Rerun `cancelled`/`failure`/inconclusive → collect `{repeated-timeout-context}`.
  **Proof:** `gh run rerun` plus the poll, or the gate did not hold.
- **6b.9** Out-of-scope CI judgment (SLS-2.2): first, if the same failing jobs fail on base's latest completed CI run → `main_red:` block
  (MRB-1.1), no `ci:` write. Otherwise failure not caused by this PR → POST a `source: "patch"`,
  `disposition: "rejected"` finding with ref `ci:{headSha}:{ciFailureSignature}`, release, skip 6c–6e. Never exit `[silent]` without
  that entry. Caused by this PR, or unsure → write nothing. **Proof:** the `ci:` ledger POST, or proceeding to 6c.
- **6c** Heartbeat, then dispatch the CI-fix subagent (skeleton 4), plus the REPEATED TIMEOUT/HANG note after 6b.8. **Proof:** an Agent dispatch.
- **6d** Status (skeleton 5); BLOCKED slug `blocked-6d`, reusing 6b.6's `PR_TASK_ID`.
- **6d.5** Upsert (skeleton 6), adding `ciFailureSignature` when set. **Proof:** `POST /prs/{id}/patch` with `commitSha`,
  `ciFailureSignature`, and heartbeat renewal.

## Step 6.5: Verify CI After Patch

Only if this cycle pushed; otherwise print `⏭ No commit pushed this cycle — skipping CI verification.` Re-fetch the live head SHA, poll
Actions runs every 30 s up to 10 times (heartbeat each iteration), classify with `is-ci-green.ts`; no runs after 2 polls → no-CI skip.
Still red after the window → exactly one bonus CI-fix subagent (6c prompt, fresh logs), no further retries. Mechanics:
[verify-ci.md](../references/patch-lean/verify-ci.md).
**Proof:** `is-ci-green.ts` run on the polled runs (`✓ CI checks passed after patch`), a skip line, or the bonus dispatch.

## Step 7: Report

Print the `PATCH COMPLETE` summary (List A/C/D outcomes, settled refs, blockers) from verify-ci.md's template.
**Proof:** the `PATCH COMPLETE` block.
