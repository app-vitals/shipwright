# patch-lean: model tier and subagent type resolution

Mechanics for `commands/patch-lean.md` Steps 2.1 and 2.2. Both run once, right after Step 2 resolves
the target PR, independent of claim state; every dispatch (4b, 5b, 6c, 6.5b) reuses the values.

## Step 2.1: Resolve `PATCH_MODEL` (MTR-2.1)

Every patch dispatch reacts to a failure signal, so `PATCH_MODEL` starts one tier above the linked
task's planned tier. `PullRequest.taskId` no longer exists (PTL-3.1) — query by PR number:

```bash
MATCHED_TASKS=$(curl -sf -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
  "$SHIPWRIGHT_TASK_STORE_URL/tasks?repo={org}/{repo}&pr={pr}")
```

**One or more tasks match** (a bundled branch can link several): take the **highest tier among ALL
matched tasks' `.model`** (`model ?? 'sonnet'` when unset) and escalate one tier, the same ladder
`references/dev-task/implementation-dispatch.md`'s BLOCKED handling climbs:

| Highest `TASK_MODEL` among matches | `PATCH_MODEL` |
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

`PR_TASK_ID` is the id of the task that produced the highest tier (first match on a tie). It stays a
single scalar: the escalation sequence (`commands/references/escalation-pattern.md`) only ever PATCHes
one task. Sites 4c, 5a.6b, 5a.7 and 5c reuse it; 6d instead reuses 6b.6's first-match `PR_TASK_ID`.

**Zero matches, or the `curl -sf` fails**: plain `sonnet`, no escalation, empty `PR_TASK_ID`; warn and
continue (not a hard stop):

```bash
PATCH_MODEL="sonnet"
PR_TASK_ID=""
echo "⚠ no matching tasks found (or lookup failed) for PR #{pr} — PATCH_MODEL defaulting to sonnet, no escalation"
```

## Step 2.2: Resolve `PATCH_SUBAGENT_TYPE` (PTM-1.2)

Same fail-soft shape; any failure leaves the built-in default:

```bash
PATCH_SUBAGENT_TYPE=$(curl -sf -H "Authorization: Bearer $SHIPWRIGHT_AGENT_API_KEY" \
  "$SHIPWRIGHT_API_URL/agents/$SHIPWRIGHT_AGENT_ID/config" | jq -r '.phaseMethodology.patch // "general-purpose"')
PATCH_SUBAGENT_TYPE=${PATCH_SUBAGENT_TYPE:-general-purpose}
```

Any compliant subagent (built-in or a configured override, per
`references/methodology-contracts/patch.md`, PTM-1.1) accepts the same inputs and returns the same
`STATUS`/`CONCERNS`/`BLOCKER` shape, so status handling and the `POST /prs/{id}/patch` handback apply
unchanged whichever type ran.

## Unparseable or failed dispatch (PTM-1.2)

If the Agent dispatch errors (including an invalid `subagent_type` from a misconfigured override) or
the response has no parseable `STATUS:` line, retry once with the same `PATCH_SUBAGENT_TYPE` and the
same prompt. If the retry also fails:

- **Built-in default** (`general-purpose`): treat as `BLOCKED` — the lane's BLOCKED handling, with
  `{blockedReason}` noting "no parseable status after retry".
- **Configured override**: dispatch the built-in `general-purpose` fresh with the same prompt, and
  print a one-line note that `{PATCH_SUBAGENT_TYPE}` failed after retry and the built-in fixer was
  used as a fallback. If that also fails, retry the built-in once more; only then fall into BLOCKED.

Chain: override → override-retry → built-in-fresh → built-in-fresh-retry → BLOCKED. Every dispatch site
must end with some valid parsed response — an unparsed report would leave the pre-work claim held
indefinitely.
