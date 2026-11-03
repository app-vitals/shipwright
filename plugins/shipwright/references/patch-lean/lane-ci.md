# patch-lean: CI lane (Step 6, List D)

Lane-specific parts of `commands/patch-lean.md` Step 6. Setup (6a), toolchain (6a.5), claim (6b.5),
status skeleton (6d), upsert (6d.5) and cleanup (6e) follow [lane-shared.md](lane-shared.md) with
`{lane}` = ci. After the claim and **before** dispatch, run 6b.6 → 6b.7 → 6b.8 → 6b.9
([guards-ci.md](guards-ci.md)); any of them can end the lane (6b.7 ends the whole command).

## Step 6b: collect CI failure output and signature

```bash
# Get the most recent failed run ID
RUN_ID=$(gh run list --branch {branch} --repo {org}/{repo} \
  --json databaseId,conclusion \
  --jq '[.[] | select(.conclusion == "failure")] | first | .databaseId')

# Collect failure logs (last 200 lines to keep context manageable)
gh run view "$RUN_ID" --log --failed --repo {org}/{repo} 2>&1 | tail -200
```

Store the log output for the prompt. Compute a stable failure signature — failing job names, sorted
and comma-joined, so the same set always produces the same value (CSD-1.1):

```bash
CI_FAILURE_SIGNATURE=$(gh run view "$RUN_ID" --repo {org}/{repo} --json jobs \
  --jq '[.jobs[] | select(.conclusion=="failure") | .name] | sort | join(",")')
```

`CI_FAILURE_SIGNATURE` is reused by 6b.9's `ci:` ref and 6d.5's upsert body. Only this lane computes
it; lanes 4 and 5 have no signature to report.

## Step 6b.8 fall-through: repeated-timeout context

When the cancelled-only rerun itself ends `cancelled`/`failure`, or its poll window is exhausted,
collect best-effort duration context for the 6c prompt before dispatching (skipping it costs prompt
quality only):

```bash
gh api "repos/{org}/{repo}/actions/runs/$CANCELLED_RUN_ID/jobs" \
  --jq '.jobs[] | {name, started_at, completed_at}'
```

Approximate a typical duration from a handful of recent successful runs of the same workflow (use
judgment on depth — context, not a statistical guarantee):

```bash
gh run list --workflow {workflow-name-or-id} --repo {org}/{repo} --status success \
  --limit 5 --json startedAt,updatedAt
```

Store both durations (or a note that the typical duration was unavailable) as
`{repeated-timeout-context}`, then continue to 6b.9.

## Step 6c: CI-fix prompt

After the heartbeat, dispatch `PATCH_SUBAGENT_TYPE` (`model: PATCH_MODEL`, `run_in_background: false`).
Paste the shared VALIDATE, TEST COVERAGE and PRE-PUSH GATE blocks from [lane-shared.md](lane-shared.md)
where marked. Step 6.5b's bonus dispatch reuses this exact template with fresh logs.

````text
You are fixing failing CI on a pull request. Diagnose the failures, apply fixes, validate locally, commit, and push.

PR: #{pr} — {title}
Repo: {org}/{repo}
PR Record ID: {PR_RECORD_ID}
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

{shared VALIDATE block — [C]}

{shared TEST COVERAGE block — [C.5]}

[D] Commit
  - Stage only the files you changed: `git add {changed files}`
  - Commit with a conventional commit message describing what was fixed:
    "fix: resolve CI failures on #{pr} — {one-line summary of changes}"
{shared PRE-PUSH GATE block}
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
````

## Step 6d: status notes

- `DONE`: record `FAILURES_FIXED`; go to 6d.5.
- `BLOCKED`: escalate with slug `blocked-6d` and the ci-row strings in [lane-shared.md](lane-shared.md),
  reusing **6b.6's** `PR_TASK_ID` (first matched task — differs from the other BLOCKED sites, which
  reuse Step 2.1's). This sets the same `blocked` flag 6b.6 reads next cycle. Skip 6d.5 and 6e.

## Step 6d.5: upsert body with `ciFailureSignature`

Same as the shared upsert, but the patch body carries the signature only when one was computed:

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
