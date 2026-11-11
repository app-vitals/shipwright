# BEHIND branches and strict mode

How Shipwright keeps a PR mergeable when its base branch has moved on.

## When GitHub reports BEHIND

GitHub reports `mergeStateStatus: "BEHIND"` only when the base branch requires branches to be
up to date before merging (the "strict" status-checks setting, via classic branch protection
or a ruleset). Without it, a stale PR reports `CLEAN`/`MERGEABLE` however far behind it is,
and Shipwright does nothing.

Shipwright keys off `BEHIND` itself. It does not read branch protection (agent tokens get
403 on `/branches/main/protection`), does not use `compare/behind_by`, and has no config flag.
A repo with strict mode off never reports `BEHIND`, so none of this code runs there.

## Who handles it

- **`dev-task`** takes no action on `BEHIND` (Step 9b.1). It merges `origin/main` only to
  resolve a real conflict (`DIRTY`).
- **`check-patch`** (`agent/src/coding/check-patch.ts`, `isBehindReady`) makes a `BEHIND` PR a
  patch candidate once it is ready to merge: approved, CI green on the head, and no
  unaddressed findings. A PR already needing a patch for another reason (findings, failing CI,
  `DIRTY`) is handled in the same run.
- **`patch`** (Step 2.5) runs `gh pr update-branch` (a merge, not `--rebase`). On failure it
  logs and continues without escalating; a real conflict later surfaces as `DIRTY`.

## Gating and CI churn

With strict mode on, every merge to main makes every other open PR `BEHIND`. Updating them all
would re-run CI on each. Gating on readiness, combined with oldest-first candidate ordering,
means roughly one PR at a time, at the front of the queue, gets updated.

## Allowlisted authors and bots

Self-authored PRs and PRs by `patchAuthorAllowlist` authors are both in scope. Caveats:

- `update-branch` on an allowlisted user's PR can fail for lack of push rights; this takes the
  failure path above, not an escalation.
- Bots that manage their own branches (e.g. Renovate) may treat a foreign merge commit as a
  manual edit and stop rebasing that branch. This was not confirmed in testing; if a bot PR
  stops updating after a Shipwright update, remove the bot from `patchAuthorAllowlist`.
- Not addressed: a merge-train race (the PR is `BEHIND` again before CI finishes).
