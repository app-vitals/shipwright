# patch-lean: dependency-risk detection (DBP-1.2)

Loaded by `commands/patch-lean.md` Step 3 when `PR_AUTHOR` is a Renovate/Dependabot bot, or the PR's
changed files include a package manifest or lockfile. That trigger is a superset of the watched-path
test below: a false positive only costs this read, because step 1 still decides "triggered" from the
real watched-path set. Apply this before finalizing List A.

The result is `DEPENDENCY_RISK_FINDING`, a nullable `{recommendation, flags, reasoning}` shape read by
List A routing (step 2), the already-held exclusion (step 3) and Step 5b's protocol gate. It is
**re-derived from the PR's own diff** every run, because the review that reaches GitHub carries only a
one-line clause without `flags`, which [dependency-patch.md](../dependency-patch.md) needs.

## 1. Derive the finding from the PR's own diff

Mirror `review.md`'s Step 5.8 exactly, substituting `gh` calls for worktree file reads — no worktree
exists yet at Step 3.

a. **Build the repo's watched-path set** from the PR's head branch:

```bash
RENOVATE_JSON=$(gh api "repos/{org}/{repo}/contents/renovate.json?ref={branch}" \
  --jq '.content' 2>/dev/null | base64 -d 2>/dev/null || echo "")
DEPENDABOT_YML=$(gh api "repos/{org}/{repo}/contents/.github/dependabot.yml?ref={branch}" \
  --jq '.content' 2>/dev/null | base64 -d 2>/dev/null || echo "")
WATCHED_PATHS_RESULT=$(bun run "${CLAUDE_PLUGIN_ROOT}/scripts/resolve-dependency-watched-paths.ts" \
  "$(jq -n --arg renovateJson "$RENOVATE_JSON" --arg dependabotYml "$DEPENDABOT_YML" \
    '{renovateJson: (if $renovateJson == "" then null else $renovateJson end),
      dependabotYml: (if $dependabotYml == "" then null else $dependabotYml end)}')")
# -> {"paths":["package.json","go.mod",...],"source":"renovate"|"dependabot"|"both"|"fallback"}
```

b. **Compare against the PR's changed files**:

```bash
CHANGED_FILES=$(gh pr diff {pr} --repo {org}/{repo} --name-only)
```

A changed file matches under `review.md` Step 5.8's three rules: exact match, basename match for a
bare-filename watched path, directory-prefix match for a watched path ending in `/`.

c. **Triggered** (at least one match): apply [dependency-risk-analysis.md](../dependency-risk-analysis.md)'s
heuristics — `gh pr diff {pr} --repo {org}/{repo}` for the diff, the PR `body` and `PR_AUTHOR`, and
`gh pr view {pr} --repo {org}/{repo} --json labels` for labels — to produce
`{recommendation, flags, reasoning}`. Set `DEPENDENCY_RISK_FINDING`.

d. **Not triggered**: `DEPENDENCY_RISK_FINDING` stays unset.

## 2. Route a `hold`/`review` recommendation into List A

When `DEPENDENCY_RISK_FINDING` is set with `recommendation` `"hold"` or `"review"`, add the PR to
**List A** regardless of Step 3a's own result. `"merge"` has nothing to remediate and does not affect
List A. Needed because `review.md` excludes the dependency-risk clause from
`compute-review-verdict.ts`'s event, so a dependency-only PR gets a clean `Verdict: APPROVE` that the
ledger exclusion would otherwise keep out of List A forever — leaving Step 5b's DEPENDENCY-RISK
REMEDIATION PROTOCOL unreachable for exactly the case it targets.

## 3. Already-held exclusion (keep whole — Independence Principle #6)

The finding is synthesized fresh every cycle and carries no "dealt with" state of its own. Without
this exclusion, a fix subagent that hits [dependency-patch.md](../dependency-patch.md)'s
no-safe-strategy exit (`outcome: held`) and classifies the finding REJECT gets re-added next cycle
from the identical diff, reposting the same rebuttal indefinitely.

```bash
HELD_DEP_FINDINGS=$(curl -sf -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
  "$SHIPWRIGHT_TASK_STORE_URL/prs?repo={org}/{repo}&prNumber={pr}" \
  | jq -r --arg ref "dependency-risk@{headRefOid}" \
    '[.prs[0].findings[]? | select(.ref == $ref and .disposition == "rejected")] | length')
```

`{headRefOid}` is the SHA Step 3a already extracted. Keying on the head SHA makes the exclusion
self-expiring: a new commit yields a ref with no entry, so a changed bump re-routes normally.

- **`HELD_DEP_FINDINGS` non-zero**: **clear `DEPENDENCY_RISK_FINDING` back to unset**, exactly the
  state 1d produces. Do not add the PR to List A on its strength (List A membership is left to Step
  3a's own criteria), and Step 5b's gate omits the protocol block. Clearing the variable — not only
  skipping step 2 — also stops a PR that is in List A for an ordinary finding from being handed the
  already-held finding again.
- **`0`, empty, or the lookup fails** (non-200, no record, store unreachable): leave the finding as
  step 1 set it and route normally — a missing ledger must never suppress first-round remediation.

## Cross-references the findings lane must carry

- Step 5b includes the protocol block only when the finding is set with `review`/`hold`
  ([lane-findings.md](lane-findings.md)).
- The protocol tells the fix subagent to name this finding `dependency-risk@{headRefOid}` in its
  CONCERNS on REJECT; Step 5c carries that ref verbatim into `REJECTED_FINDINGS_THIS_CYCLE` and Step
  5c.5 writes it to the ledger. Both ends of the exclusion use that one identifier.
