# patch-lean: CI-lane guards (CFE-1.1, PH-1.1, PCC-1.1, SLS-2.2)

Mechanics for `commands/patch-lean.md` Steps 6b.6 → 6b.7 → 6b.8 → 6b.9. They run in that order after
the 6b.5 claim and before the 6c dispatch. Each one that stops the lane releases the claim with
[lane-shared.md](lane-shared.md)'s release snippet first.

## Step 6b.6: existing-escalation check (CFE-1.1)

Step 5a.7 escalates in List A only. Once its comment exists, CPF-2.3's reply-after-review exclusion
drops the PR from List A; if CI is still red, Step 3c puts it in List D, and without this check a CI-fix
subagent would contradict the recorded HITL decision every cycle.

1. Fetch the PR record fresh (do not trust a possibly-stale claim response):
   ```bash
   PR_RECORD=$(curl -sf -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
     "$SHIPWRIGHT_TASK_STORE_URL/prs/$PR_RECORD_ID")
   PR_BLOCKED=$(echo "$PR_RECORD" | jq -r '.blocked // false')
   ```
2. Query every task linked to this PR (`PR_RECORD.taskId` no longer exists, PTL-3.1):
   ```bash
   MATCHED_TASKS=$(curl -sf -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
     "$SHIPWRIGHT_TASK_STORE_URL/tasks?repo={org}/{repo}&pr={pr}")
   TASK_BLOCKED=$(echo "$MATCHED_TASKS" | jq -r \
     '[.tasks[]? | select(.hitl == true or .status == "blocked")] | length > 0')
   PR_TASK_ID=$(echo "$MATCHED_TASKS" | jq -r '.tasks[0].id // empty')
   ```
   `TASK_BLOCKED` is an **OR across every matched task** (mirrors `isTaskBlockedForDispatch` in
   `agent/src/check-helpers.ts`, PTL-1.1). `PR_TASK_ID` is the first match (or empty) and is the value
   Step 6d's BLOCKED escalation reuses.

**`PR_BLOCKED` is `true` OR `TASK_BLOCKED` is `true`** → do not dispatch. Release the claim, print
`⏸ PR #{pr} already has an unresolved HITL escalation — skipping CI-fix dispatch.`, and end the CI
lane (continue to Step 7).

**Otherwise** → print `6b.6 escalation check: none` and continue to 6b.7. With zero matched tasks, only
`PR_BLOCKED` can trigger the skip.

## Step 6b.7: bundle completeness gate (PH-1.1)

`check-patch.ts`'s `isBundleComplete` (CPB-1.1) only guards the loop-driven path; a human invoking
the command directly bypasses it, and a bundle-mate can start or block between selection and dispatch.
Re-query right before the CI-fix dispatch (mirrors merge.md's live-state re-check):

```bash
BRANCH_TASKS=$(curl -sf -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" "$SHIPWRIGHT_TASK_STORE_URL/tasks?branch={branch}" 2>/dev/null || echo '{"tasks":[],"total":0,"limit":50,"offset":0}')
INCOMPLETE_TASKS=$(echo "$BRANCH_TASKS" | jq '[.tasks[] | select(.status == "pending" or .status == "in_progress" or .status == "blocked") | {id, status}]')
INCOMPLETE=$(echo "$INCOMPLETE_TASKS" | jq 'length')
```

**`INCOMPLETE > 0`** → do NOT dispatch (a CI fix would land on a branch other tasks are still
building):

1. Release the claim.
2. Print:
   ```
   ⏸ Bundle gate: {INCOMPLETE} task(s) on branch {branch} are still in flight:
     {for each item in INCOMPLETE_TASKS: "  - {id} ({status})"}
     Deferring CI-fix dispatch until bundle-mates reach pr_open.
   ```
3. Stop the whole command — patch is explicit-single-PR-target-only (WLS-3.3), so there is no other
   candidate. Emit `[skip-reason:patch:deferred:bundle-incomplete:{branch}]` alongside `[silent]` (order
   does not matter). The marker lands in `AgentCronRun.skipReason` (admin cron-logs UI) instead of the
   generic `command:no-work`. A bundle-held PR being silently skipped is the intended behavior.

**`INCOMPLETE == 0`** (no tasks on the branch, or all past `pending`/`in_progress`/`blocked`) → continue
to 6b.8.

## Step 6b.8: rerun-first for cancelled-only CI (PCC-1.1)

Re-validates current state; it does not requalify (the candidate provider already saw `hasCancelled`).

**Gate:** `CI_HAS_CANCELLED=true` AND `CI_HAS_FAILING` is not true. A cancelled run is most often a job
that hit `timeout-minutes` (reported as `cancelled`, not `timed_out`) or an external cancellation. A
rerun is a safe, essentially no-op action even for workflows using `concurrency`/`cancel-in-progress`,
because the gate is scoped to the PR's latest-run state, not workflow identity.

**Gate does not hold** (`CI_HAS_FAILING=true`, with or without a cancelled run elsewhere) → skip this
step; continue to 6b.9.

**Cancelled-only** → rerun first; no commit, no dispatch in this branch:

```bash
gh run rerun "$CANCELLED_RUN_ID" --repo {org}/{repo}
```

Bounded poll (not the full CI gate): every 15 seconds, up to 8 times (~2 minutes). Renew the heartbeat
on each iteration:

```bash
curl -s -o /dev/null -X POST \
  -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
  "$SHIPWRIGHT_TASK_STORE_URL/prs/$PR_RECORD_ID/heartbeat"

gh run view "$CANCELLED_RUN_ID" --repo {org}/{repo} --json status,conclusion
```

Keep polling while `status` is `queued`, `in_progress`, or `waiting`; stop at `status == "completed"`.

- **Terminal `success`, or any non-cancelled, non-failure terminal state** (`neutral`, `skipped`):
  release the claim, print
  `✓ PR #{pr} — cancelled run {CANCELLED_RUN_ID} rerun succeeded, no fix needed — skipping CI-fix dispatch.`,
  skip 6c, and end the CI lane.
- **Rerun ends `cancelled` or `failure`, or the poll window is exhausted** (inconclusive — the rerun
  must not leave the PR in limbo): a repeated-timeout/hang signal. Collect `{repeated-timeout-context}`
  per [lane-ci.md](lane-ci.md), then continue to 6b.9 and on to 6c with the REPEATED TIMEOUT/HANG note.

## Step 6b.9: out-of-scope CI judgment (SLS-2.2)

Having read the 6b logs, decide whether the failing check is caused by this PR.

**Main-red path (MRB-1.1) — check first.** Before judging out of scope, check that the same failing
jobs (`CI_FAILURE_SIGNATURE`) are failing on the latest completed CI run of the base branch
(`gh run list --repo {org}/{repo} --branch {base} --status completed --limit 1`). If so, escalate via
`commands/references/escalation-pattern.md` (task blocked, or PR record `blocked: true` when no linked
task) with a `blockedReason` starting `main_red:` naming main's sha and the signature; post one PR
comment saying the PR is waiting on main and how to resume (re-run CI or update the branch once main is
green, then `/shipwright:unblock`); release the claim and skip 6c–6e. **Do NOT write the `ci:` ledger
entry on this path** (an unblock at the same SHA would stay settled). This path ends blocked, so it never
ends `[silent]`. If main is green or its failures differ, continue below.

If it is not — e.g.
the same check already fails on the base branch, or the failure is in code this PR does not touch and
no change to the PR can fix it — the run must not end with nothing recorded: without a ledger entry,
`check-patch.ts` re-selects the PR every tick. **Never exit `[silent]` without it.**

Reuse `CI_FAILURE_SIGNATURE` from 6b (no new computation). The ref is
`ci:{headSha}:{ciFailureSignature}`, the format SLS-2.1's `check-patch.ts` honors: a matching
`source: "patch"`, `disposition: "rejected"` entry settles that exact failure state at that exact head.

```bash
HEAD_SHA=$(gh pr view {pr} --repo {org}/{repo} --json headRefOid --jq .headRefOid)
curl -sf -X POST \
  -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
  -H "Content-Type: application/json" \
  "$SHIPWRIGHT_TASK_STORE_URL/prs/$PR_RECORD_ID/findings" \
  -d "{\"ref\": \"ci:$HEAD_SHA:$CI_FAILURE_SIGNATURE\", \"disposition\": \"rejected\", \"source\": \"patch\", \"evidence\": \"{failing check} is not caused by this PR: {why out of scope}\", \"agentId\": \"$SHIPWRIGHT_AGENT_ID\"}" \
  > /dev/null 2>&1 || \
  echo "⚠ POST /prs/$PR_RECORD_ID/findings (ci rejected) failed — continuing"
```

Then release the claim, skip 6c–6e, and end the CI lane. The final report states the PR was settled
as out-of-scope CI, with the ref. A later push changes `$HEAD_SHA`, so the entry stops matching and the
PR re-qualifies. If the failure *is* caused by this PR, or you cannot tell, write nothing and continue
to 6c.
