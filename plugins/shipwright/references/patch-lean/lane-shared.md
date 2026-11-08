# patch-lean: shared lane mechanics

Steps 4 (List C, conflicts), 5 (List A, findings) and 6 (List D, CI) of `commands/patch-lean.md` run
the same skeleton. Each section below is parameterized by `{lane}`:

| `{lane}` | List | Setup | Toolchain | Claim | Dispatch | Status | Upsert | Cleanup | BLOCKED slug | Lane file |
|---|---|---|---|---|---|---|---|---|---|---|
| conflicts | C | 4a | 4a.5 | 4a.6 | 4b | 4c | 4c.5 | 4d | `blocked-4c` | [lane-conflicts.md](lane-conflicts.md) |
| findings | A | 5a | 5a.5 | 5a.6 | 5b | 5c | 5c.5 | 5d | `blocked-5c` | [lane-findings.md](lane-findings.md) |
| ci | D | 6a | 6a.5 | 6b.5 | 6c | 6d | 6d.5 | 6e | `blocked-6d` | [lane-ci.md](lane-ci.md) |

Run lanes in order conflicts → findings → ci. Fully complete one PR in a lane (fix → push → cleanup)
before moving on. Pre-dispatch guards sit between Claim and Dispatch: findings runs 5a.6b then 5a.7
([guards-escalation.md](guards-escalation.md)); ci runs 6b.6, 6b.7, 6b.8, 6b.9
([guards-ci.md](guards-ci.md)); conflicts has none.

## 1. Setup worktree

```bash
git -C ${SHIPWRIGHT_REPO_DIR:-$HOME/src}/{repo} fetch origin
git -C ${SHIPWRIGHT_REPO_DIR:-$HOME/src}/{repo} worktree add ${SHIPWRIGHT_WORKTREE_DIR:-$HOME/worktrees}/{repo}-{branch-slug} origin/{branch}
```

Branch slug = branch name with `/` replaced by `-`. If the worktree already exists (prior interrupted
run):

```bash
git -C ${SHIPWRIGHT_REPO_DIR:-$HOME/src}/{repo} worktree remove ${SHIPWRIGHT_WORKTREE_DIR:-$HOME/worktrees}/{repo}-{branch-slug} --force
git -C ${SHIPWRIGHT_REPO_DIR:-$HOME/src}/{repo} worktree add ${SHIPWRIGHT_WORKTREE_DIR:-$HOME/worktrees}/{repo}-{branch-slug} origin/{branch}
```

All later steps for the PR run from that worktree (`{worktree-path}`).

## 2. Detect toolchain

Check the cache before fresh detection, then docs-first discovery and config-file scanning — see
[toolchain-patterns.md](../toolchain-patterns.md)'s "Caching Across Runs" and "Docs-First Discovery":

1. Compute the fingerprint against `{worktree-path}` and read `state/toolchain-cache/{repo}.json`. On
   a fingerprint match, reuse the cached **lint**/**test**/**tests** commands and go to item 5.
2. Otherwise read `CLAUDE.md` + `docs/*.md`/`ai-docs/*.md` for explicit lint/test commands first
   (authoritative if found), then fill gaps from the config-file lookup table.
3. Store **{lint command}** (e.g. `bun run lint`), **{test command}** (e.g. `bun test`), and optional
   **{tests}** (extra layers, e.g. `{"integration": "pytest tests/integration"}`; omit when there is one).
4. On a cache miss, overwrite `state/toolchain-cache/{repo}.json` with the new fingerprint + commands.
5. **Prefer scoped lint when available.**
   ```bash
   base=$(gh pr view {pr} --repo {org}/{repo} --json baseRefName -q '.baseRefName')
   head=$(git -C {worktree-path} rev-parse HEAD)
   ```
   `commands.lintScoped` present → substitute `{base}`/`{head}` into its template (e.g.
   `turbo lint --filter=...[{base}...{head}]`) as **{lint command}** for this lane's dispatch only (the
   cache entry is untouched). Absent → the unscoped `lint` command.

## 3. Claim the PR record (pre-work lock)

The subagent can run long enough to overlap another patch run (or a stale `phase: "review"` claim
left by `/shipwright:review`). Claim with `phase: "patch"` before dispatching, mirroring merge.md's
pre-merge claim.

**Pre-Claim Fast Path (CBD-1.5).** If Step 0 captured a marker, validate it against this site's live
head — it can have moved since Step 2 or since an earlier lane pushed:

```bash
headRefOid=$(gh pr view {pr} --repo {org}/{repo} --json headRefOid -q '.headRefOid')
```

- `headRefOid == PRECLAIM_COMMIT_SHA`: set `PR_RECORD_ID = PRECLAIM_RECORD_ID` and **skip the
  `/prs/claim` call** — the orchestrator already holds the PR under `phase: "patch"`.
- Different, or no marker: self-claim:

```bash
HEAD_SHA_PRE_PATCH=$(git -C ${SHIPWRIGHT_WORKTREE_DIR:-$HOME/worktrees}/{repo}-{branch-slug} rev-parse HEAD)
PR_CLAIM=$(curl -s -o /tmp/pr_claim_patch.json -w '%{http_code}' -X POST \
  -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
  -H "Content-Type: application/json" \
  "$SHIPWRIGHT_TASK_STORE_URL/prs/claim" \
  -d "$(jq -n --arg repo "{org}/{repo}" --argjson prNumber {pr} --arg commitSha "$HEAD_SHA_PRE_PATCH" \
        --arg authorLogin "$PR_AUTHOR" --arg headRef "$PR_HEAD_REF" --arg title "$PR_TITLE" \
        '{repo: $repo, prNumber: $prNumber, commitSha: $commitSha, phase: "patch", authorLogin: $authorLogin, headRef: $headRef, title: $title}')")
PR_RECORD_ID=$(jq -r '.id // empty' /tmp/pr_claim_patch.json)
```

**`409`** (another patch run holds it): do NOT dispatch. Print
`⏸ PR #{pr} is already claimed by another patch run — skipping.`, skip the rest of the lane for this
PR, and continue with the next lane (or Step 7 after the ci lane). **`200`/`201`**: `PR_RECORD_ID` is
reused by the upsert — no second claim.

## Release snippet (used by every guard that stops a lane)

```bash
curl -s -o /dev/null -X POST \
  -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
  "$SHIPWRIGHT_TASK_STORE_URL/prs/$PR_RECORD_ID/release"
```

## 4. Heartbeat, then dispatch

Renew the claim heartbeat right before dispatching (the subagent can threaten the claim TTL on its
own):

```bash
curl -s -o /dev/null -X POST \
  -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
  "$SHIPWRIGHT_TASK_STORE_URL/prs/$PR_RECORD_ID/heartbeat"
```

Dispatch a `PATCH_SUBAGENT_TYPE` subagent via the Agent tool (Step 2.2; built-in `general-purpose` by
default), passing `model: PATCH_MODEL` (Step 2.1) and `run_in_background: false`, with the lane's
prompt from its lane file. Every lane prompt embeds the two shared blocks below verbatim. Sed-style or
inline fixing in place of the dispatch counts as skipping the step — there is no size exemption.

### Shared prompt block: VALIDATE (`[C]` in every lane prompt)

````text
[C] Validate (best-effort — CI Gate is the real arbiter)
  Verifications are crucial to ensuring your work is valid — run {lint command} and
  {test command} (and each additional test layer listed in TOOLCHAIN above) before
  committing. Fix any failure you can clearly attribute to your change; note anything else
  (pre-existing, flaky) in CONCERNS and continue to the next step regardless — never loop
  waiting for a clean pass, and a failed, timed-out, or skipped check never blocks the
  commit/push.

  Run each check with the Bash tool's `timeout` parameter set to `600000` ms (10 minutes). If
  a verification exceeds 10 minutes, skip the local run for it and rely on CI — this PR's CI
  Gate is what actually decides mergeability.

  **Record every outcome** — passes and failures included, not just skips — by POSTing to
  `$SHIPWRIGHT_TASK_STORE_URL/verification-checks` with `prId` (the PR Record ID from the top
  of this prompt — substitute its literal value; `$PR_RECORD_ID` is not set in your shell),
  `repo` (`{org}/{repo}`), `checkName`, `status`, and an optional `reasonCategory`:

  - `status` is one of `ran_passed`, `ran_failed`, `skipped`, `timed_out`.
  - `reasonCategory` is only valid with `skipped` or `timed_out` — never send it with
    `ran_passed` or `ran_failed`. Values: `check_timeout`, `install_timeout`,
    `resource_limit`, `missing_tool`, `missing_secret`, `missing_dependency`,
    `not_configured`, `learned_skip` (`learned_skip` also takes `learnedFromCategory`).
  - A failure caused by the agent's own environment (missing tool, secret, or dependency, or a
    resource limit) rather than the code is a judgment call from reading the output: record
    it as `skipped` with the matching category. If unsure, record `ran_failed`.

  ```bash
  curl -sf -X POST -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
    -H "Content-Type: application/json" \
    "$SHIPWRIGHT_TASK_STORE_URL/verification-checks" \
    -d '{"prId": "{PR_RECORD_ID}", "repo": "{org}/{repo}", "checkName": "{checkName}", "status": "{status}"}' \
    > /dev/null 2>&1 || echo "⚠ verification-check POST for {checkName} failed — continuing"
  ```

  **Learned skip.** Before running a check, fetch its recent history:

  ```bash
  curl -sf -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
    "$SHIPWRIGHT_TASK_STORE_URL/verification-checks?repo={org}/{repo}&checkName={checkName}&limit=2" | jq '.checks'
  ```

  Rows come back most-recent-first. If both rows are `skipped` or `timed_out`, skip the check
  locally and record `skipped` with `reasonCategory: "learned_skip"` and
  `learnedFromCategory` set to the most recent row's `reasonCategory`.
````

### Shared prompt block: PRE-PUSH GATE (inside `[D]` in every lane prompt, before `git push`)

````text
  **Required pre-push gate — verification record.** Before `git push`, check that this PR's
  verification outcomes were recorded (substitute the literal PR Record ID from the top of this
  prompt; `$PR_RECORD_ID` is not set in your shell):

  ```bash
  curl -sf -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
    "$SHIPWRIGHT_TASK_STORE_URL/verification-checks?prId={PR_RECORD_ID}&limit=1" | jq '.checks'
  ```

  If the result is empty, record each check that was run (or skipped, and why) now, using the
  POST shape from [C] Validate, then continue. This gate never blocks the push.
````

### Shared prompt block: TEST COVERAGE (`[C.5]` in the findings and ci prompts)

```
[C.5] Add test coverage
  - Detect the test framework and file-naming conventions from nearby existing tests in
    the repo
  - Add or update a test covering the new or changed behavior, following those existing
    patterns
  - Re-run {test command} from [C] to confirm the new
    test passes alongside the rest
  - If no test is needed (test-file-only change, config change, or pure deletion with no
    new behavior), state that explicitly instead of adding one
```

## 5. Handle subagent status

| STATUS | Action |
|---|---|
| none parseable | [model-resolution.md](model-resolution.md)'s "Unparseable or failed dispatch": retry once, then built-in fallback (override case) or BLOCKED (default case). |
| `DONE` | Record what was fixed; go to Upsert. |
| `DONE_WITH_CONCERNS` | conflicts/ci: if the push happened, log concerns and upsert; if not, note it for the report and skip Upsert. findings: always go to Upsert (see [lane-findings.md](lane-findings.md) for the REJECT checks). |
| `BLOCKED` | Escalate (below), skip Upsert and Cleanup, include the blocker in the report. |

**BLOCKED escalation.** A generic release with no escalation flag makes the PR immediately re-eligible
for `check-patch.ts`'s `getPatchCandidates()` next tick (`claimedBy`/`blocked` are the only exclusions).
Escalate first via [escalation-pattern.md](../../commands/references/escalation-pattern.md)'s shared
PATCH/comment/release sequence, with the lane's values:

| `{lane}` | `{blockedReason}` | `{comment_body}` | `{temp_file_slug}` | `PR_TASK_ID` from |
|---|---|---|---|---|
| conflicts | `"merge-conflict resolution blocked — automated conflict resolution could not complete"` | "The merge-conflict resolution subagent reported BLOCKED and could not complete — flagging for a human decision instead of retrying indefinitely." | `blocked-4c` | Step 2.1 |
| findings | `"review-finding fix blocked — automated fix subagent could not complete"` | "The review-finding fix subagent reported BLOCKED and could not complete — flagging for a human decision instead of retrying indefinitely." | `blocked-5c` | Step 2.1 |
| ci | `"CI-fix blocked — automated CI-fix subagent could not complete"` | "The CI-fix subagent reported BLOCKED and could not complete — flagging for a human decision instead of retrying indefinitely." | `blocked-6d` | Step 6b.6 (first match) |

Temp file: `/tmp/shipwright-patch-{temp_file_slug}-{pr}.txt`. Claim released: this lane's pre-work
claim. Log the blocker and move on. For the ci lane this sets the same `blocked` flag 6b.6 reads
pre-dispatch; the two compose without conflict.

## 6. Upsert the PR record

The record is already claimed, so this renews the heartbeat and increments `patchCycles` rather than
re-claiming. Warn and continue on any failure.

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

Lane additions: findings also writes one `POST /prs/{id}/findings` per rejected item
([lane-findings.md](lane-findings.md)); ci sends `ciFailureSignature` in the patch body when set
([lane-ci.md](lane-ci.md)).

## 7. Cleanup worktree

After a successful push (DONE, or DONE_WITH_CONCERNS with the push completed):

```bash
git -C ${SHIPWRIGHT_REPO_DIR:-$HOME/src}/{repo} worktree remove ${SHIPWRIGHT_WORKTREE_DIR:-$HOME/worktrees}/{repo}-{branch-slug} --force
```
