# Handoff (Step 10)

Mechanics for `commands/dev-task.md`.

```bash
PR_CREATED_AT=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
PATCH_CODE=$(curl -s -o /tmp/task_patch_10a.json -w '%{http_code}' -X PATCH -H "$AUTH" -H "Content-Type: application/json" \
  "$SHIPWRIGHT_TASK_STORE_URL/tasks/{id}" \
  -d "{\"status\":\"pr_open\",\"pr\":{pr_number},\"prCreatedAt\":\"$PR_CREATED_AT\",\"ciFixAttempts\":{ci_attempt},\"simplifyTotal\":{simplify_total},\"simplifyDry\":{simplify_dry},\"simplifyDeadCode\":{simplify_dead_code},\"simplifyNaming\":{simplify_naming},\"simplifyComplexity\":{simplify_complexity},\"simplifyConsistency\":{simplify_consistency},\"coverageDelta\":{coverage_delta},\"model\":\"{EFFECTIVE_MODEL}\"}")
```
2xx → print the task and the handoff. Non-2xx → print `⚠ Step 10a PATCH failed with status $PATCH_CODE — handoff aborted.` and
stop; the store would otherwise still show the task unclaimed with an open PR.

Handoff (inside `━` rules): a headline starting `DONE: {id}`, then at most 3 bullets, then the PR link. Risk, breaking
changes, and follow-ups go in the headline or the first bullets and are never trimmed. Other stats (simplify fixes, CI
attempts, coverage, reqs, docs) are logged and PATCHed, not listed unless notable.
