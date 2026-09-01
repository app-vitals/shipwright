# BLOCKED-Escalation Pattern

Shared PATCH/comment/release sequence used by `patch.md` whenever a subagent reports
`STATUS: BLOCKED`, or a pre-dispatch check detects a condition that should be escalated to
a human instead of retried automatically. A generic claim release with no escalation flag
would make the PR immediately re-eligible for `check-patch.ts`'s `getPatchCandidates()` on
the next `shipwright-loop` tick, re-dispatching the same automated attempt indefinitely.
Escalating first — flagging the linked task (or PR record) as `blocked` and posting a PR
comment — breaks that loop by giving a human the context to decide, and by giving
`check-patch.ts`/`check-review.ts` a durable signal to stop re-flagging the PR.

Each call site in `patch.md` links here for the mechanics and states its own trigger
condition and parameter values inline. `PR_TASK_ID` and `PR_RECORD_ID` are assumed already
resolved by the caller before this sequence runs — most sites reuse `PR_TASK_ID` from Step
2.1 (resolved once, right after Step 2 resolves the target PR, by querying
`GET /tasks?repo=&pr=` and picking the task among the matches that produced the highest
model tier); Step 6d's BLOCKED handling instead reuses the `PR_TASK_ID` resolved by Step
6b.6's escalation check (its own `GET /tasks?repo=&pr=` query, picking the first matched
task). Either way this sequence only ever PATCHes a single task — the multi-match
resolution behind `PR_TASK_ID` at each site does not change that. `PR_RECORD_ID` comes from
that site's own pre-work claim (Step 4a.6 / 5a.6 / 6b.5).

## Parameters

- **`{blockedReason}`** — the human-readable reason string sent to the task-store/PR-record
  `blockedReason` field. Distinct per call site (e.g. "merge-conflict resolution blocked —
  automated conflict resolution could not complete").
- **`{comment_body}`** — the PR comment text explaining the escalation to a human reader.
  Distinct per call site.
- **`{temp_file_slug}`** — used to build the temp file path
  `/tmp/shipwright-patch-{temp_file_slug}-{pr}.txt`. Distinct per call site (e.g.
  `blocked-4c`, `blocked-5c`, `blocked-6d`, `escalation`).

## The sequence

**1. Flag the linked task, or the PR record if no task is linked.**

Reuse the already-resolved `PR_TASK_ID` — do not re-fetch it here. If `PR_TASK_ID` is
non-empty, PATCH the linked task to `status: 'blocked'` so it's flagged for a human
decision:

```bash
curl -sf -X PATCH -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
  -H "Content-Type: application/json" \
  "$SHIPWRIGHT_TASK_STORE_URL/tasks/$PR_TASK_ID" \
  -d '{"status": "blocked", "blockedReason": "{blockedReason}"}' > /dev/null 2>&1 || \
  echo "⚠ PATCH /tasks/$PR_TASK_ID blocked status failed — continuing"
```

If `PR_TASK_ID` is empty (no linked task on the PR record), PATCH the PR record itself
instead — otherwise nothing is ever recorded to stop this PR from re-qualifying as a patch
candidate every cycle, spinning forever:

```bash
curl -sf -X PATCH -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
  -H "Content-Type: application/json" \
  "$SHIPWRIGHT_TASK_STORE_URL/prs/$PR_RECORD_ID" \
  -d '{"blocked": true, "blockedReason": "{blockedReason}"}' > /dev/null 2>&1 || \
  echo "⚠ PATCH /prs/$PR_RECORD_ID blocked flag failed — continuing"
```

Still post the PR comment below either way, regardless of which PATCH fired.

**2. Post exactly one PR comment via a temp file.**

Write the body to a temp file first — heredocs break permission glob matching. The temp
file path MUST include the PR number to avoid collisions, since `/tmp` is shared across all
worktrees:

```bash
# Write {comment_body} to /tmp/shipwright-patch-{temp_file_slug}-{pr}.txt
gh pr comment {pr} --repo {org}/{repo} --body-file /tmp/shipwright-patch-{temp_file_slug}-{pr}.txt
rm /tmp/shipwright-patch-{temp_file_slug}-{pr}.txt
```

**3. (Site-specific hook point.)** Any extra step a call site needs happens here, between
posting the comment and releasing the claim — e.g. Step 5a.7 resolves all currently-
unresolved inline threads on the PR at this point, since escalating there means giving up
on automated resolution for the PR this cycle, and leaving threads unresolved would make
Step 3a re-flag the PR every cycle forever. Most sites have no extra step and skip straight
to step 4.

**4. Release the pre-work claim.**

```bash
[ -n "$PR_RECORD_ID" ] && curl -s -o /dev/null -X POST \
  -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
  "$SHIPWRIGHT_TASK_STORE_URL/prs/$PR_RECORD_ID/release"
```

This ensures a subsequent patch run within the reaper's TTL is not 409-blocked by a stale
`phase: "patch"` lock — the fix never completed (or was never dispatched), so nothing is
actually in flight.

**5. Log and continue — stays inline at the call site.** Each site prints its own status
line and names its own "skip these steps, move to the next PR in List X" continuation. This
step is not documented here because it differs structurally per site — different List
letters, different skipped step numbers — so it belongs with the site's own prose, not in
this shared reference.
