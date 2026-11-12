# Plan: patch-red-main

Repo: app-vitals/shipwright. Requested by Dan.

## Problem
`patch.md` Step 6b.9 (and `references/patch-lean/guards-ci.md`) settles a CI failure it judges "not caused by this PR" (e.g. same check red on main) by writing a `ci:{headSha}:{signature}` `rejected` ledger entry, releasing the claim and ending the cycle. It sets no `blocked`/`hitl`, posts no comment, and records nothing visible. A red main therefore silently stalls every open PR, which looks idle in the task store and Slack.

## Design (chosen: just block)
When Step 6b.9 finds the failure is inherited from main, escalate through the existing `commands/references/escalation-pattern.md` instead of writing the ledger entry:
- **Verify, don't guess:** confirm the same failing jobs (`CI_FAILURE_SIGNATURE`) are red on the latest completed CI run on the base branch (`gh run list --branch main`). Only then take the main-red path. Otherwise existing 6b.9 behavior is unchanged.
- **Block:** escalation-pattern sequence (PATCH linked task to `blocked`, or PR record `blocked: true` if no task; one PR comment; release claim) with `blockedReason` starting `main_red:` e.g. `main_red: CI failing on main@{sha} ({signature}) — not caused by this PR`.
- **No ledger entry on this path.** A `ci:` rejected entry is keyed on head SHA; if present, unblocking at the same SHA would leave the PR silently settled again. Without it, an unblock re-qualifies the PR for patch.
- **Comment text** tells the human how to resume: once main is green, re-run CI or update the branch, then `/shipwright:unblock`.
- `check-patch.ts` already skips blocked PRs/tasks (`isTaskBlockedForDispatch`/`isPrRecordBlockedForDispatch`), so no selector change.
- `/shipwright:unblock` gets a `main_red:` row in its origin-phase table so it is classified as patch, not "unknown origin phase".

## Out of scope (deliberate)
Automatic resume when main goes green, and a red-main detector that files a single "fix main" task. Both need cross-PR coordination; revisit only if red main recurs after this ships (only known incident: 2026-10-27, shipwright#4585/#4584/#4588).

## Tasks
| Task | Depends on | Layer | Model |
|---|---|---|---|
| MRB-1.1 fix: block PRs whose CI failure is inherited from main | — | CLI | sonnet |
| MRB-1.2 docs: recognize main_red blocks in unblock | MRB-1.1 | CLI | haiku |

Dependency graph: `[START] └─ MRB-1.1 └─ MRB-1.2`

Breaking change safety: additive prose + one new reason string; safe to deploy standalone: yes (both).

## Risks
- Whether the PR-record vs task block target works for unlinked PRs is already covered by escalation-pattern step 1; reuse unchanged.
- Bundle-gate deadlock (blocked sibling task starves a bundle PR) is a known pre-existing hazard of any block; the comment/reason must make the cause obvious.
