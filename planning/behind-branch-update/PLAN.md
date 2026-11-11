# Plan Session: behind-branch-update

Repo: app-vitals/shipwright

## Background

When a repo's base branch requires branches to be up to date before merging (the "strict"
status-checks setting, via classic branch protection or a ruleset), GitHub reports a stale PR
as `mergeStateStatus: "BEHIND"`. Without that setting a stale PR reports `CLEAN`/`MERGEABLE`
no matter how far behind it is (PR #4370 was 40 commits behind `main` and still `CLEAN`).

Shipwright currently ignores BEHIND on purpose (`patch.md` header note and Step 3b,
`check-patch.ts`, `dev-task.md` 9b.1, `dev-task-lean/push-and-ci.md`,
`methodology-contracts/patch.md`). On a strict repo that leaves a BEHIND PR unmergeable:
`deploy` runs `gh pr merge` and GitHub refuses it, and nothing ever updates the branch.

## Design

**Gating: key off BEHIND itself, nothing else.** Agents' tokens generally cannot read branch
protection (`/branches/main/protection` returns 403; classic-protection `strict` is not
exposed on `/branches/main`; rulesets are readable but only cover one of the two mechanisms).
GitHub computes `mergeStateStatus` with full access to the rules, so BEHIND is the only
reliable signal. A repo with strict off never reports BEHIND, so none of this code runs there.
No config flag, no `compare/behind_by`, no rule detection.

**Placement: `patch`, not `deploy`/`merge`.** `deploy` stays a pure merge executor. A failure
in patch leaves a PR un-updated (surfaced by the existing skip-streak auto-block); a failure
in deploy would sit in the riskiest phase (claim held, merge, canary/promote) and move the
head after approval.

**Mechanism.** `gh pr update-branch {n} --repo {org}/{repo}` (a merge of the base into the
branch — no `--rebase`; the existing DIRTY path keeps `--rebase`). On success, re-resolve
`headRefOid` before the Step 3c CI check. On failure, log and continue without escalating;
a real conflict turns the PR DIRTY and the existing List C path takes over.

**Dispatch (`check-patch.ts`).** `MergeStatusInfo` gains `isBehind`. BEHIND alone makes a PR a
patch candidate only when the PR is otherwise ready to merge: approved, CI green on the head,
no unaddressed findings. This avoids rerunning CI on every open PR after each merge to main
(with strict on, every merge makes every other open PR BEHIND) and, combined with oldest-first
task ordering, updates roughly one PR at a time at the front of the queue. A PR that needs a
patch for another reason (findings, failing CI, DIRTY) is unchanged — BEHIND is handled in
that same run via Step 2.5.

**Author scope.** Self-authored PRs and PRs by users/bots on the patch author allowlist
(`pr.author` set in `check-patch`) are both in scope.

**Task order.** Detection must not land before `patch.md` can act on BEHIND, or patch would
dispatch on BEHIND PRs and do nothing. So SBU-1.1 (command + contract) lands first and
SBU-1.2 (dispatch) depends on it. Each PR is safe to deploy standalone.

## Tasks

| Task | Title | Depends on | Layer | Model | Hours |
|---|---|---|---|---|---|
| SBU-1.1 | feat: handle BEHIND PRs in patch via update-branch | — | CLI | sonnet | 3 |
| SBU-1.2 | feat: dispatch patch for ready BEHIND PRs in check-patch | SBU-1.1 | Background | sonnet | 4 |
| SBU-1.3 | docs: clarify BEHIND handling and strict-mode semantics | SBU-1.2 | Shared | haiku | 1 |

```
[START]
  └─ SBU-1.1: patch.md + contract handle BEHIND (no deps)
        └─ SBU-1.2: check-patch dispatches on ready BEHIND PRs
              └─ SBU-1.3: docs / wording
```

Breaking Change Safety: no renames or removals; all three tasks are additive or wording.
Safe to deploy standalone: yes (each).

## Risks to verify during implementation

- Whether the update-branch merge commit moving the head SHA confuses review staleness
  (`commitSha`) or invalidates approvals on repos with `dismiss_stale_reviews_on_push`.
- A merge pushed with the agent PAT should trigger CI (unlike `GITHUB_TOKEN`) — confirm.
- Allowlisted bot branches (e.g. Renovate) may treat a foreign merge commit as a manual edit
  and stop rebasing; confirm behavior and note it in the docs if so.
- Write access: update-branch on an allowlisted user's PR can fail for lack of push rights —
  must fall through the failure path, not escalate.
- Merge-train race (BEHIND again before CI finishes). Not addressed; add a cooldown between
  update attempts only if it shows up in practice.

## Decision Log

- Gating: defaulted to BEHIND alone — agents cannot reliably read branch protection.
- Placement: patch, not deploy — Dan's call; keeps deploy a pure merge executor.
- Trigger scope: gated to ready-to-merge PRs — avoids CI churn on every open PR; ungated
  remains the fallback if the gate proves too complex.
- Author scope: includes allowlisted users/bots (Dan's call), despite the Renovate risk above.
- No HITL task to enable strict on `main` — Dan opted out.
