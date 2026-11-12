# Intentionally dropped from patch-lean

`commands/patch-lean.md` is a trimmed variant of `commands/patch.md` (2549 lines), built from the
DTA-9.6 audit (`planning/dev-task-adherence/patch-drop-audit.md`). The spine carries every step, every
guard's trigger and stop rule, and a **Proof:** line per `required-steps/patch.json` step; mechanics
moved to the sibling files in this directory. `patch.md` itself is unchanged and remains the default
patch command. The items below were cut or reshaped; nothing in the audit's incident-driven guard list
was dropped.

## Dropped text

| Dropped | Reason |
|---|---|
| Step 3a.5 "Why this is re-derived rather than parsed off a prior review's analysis" essay | Design rationale only. The conclusion (re-derive from the diff; the posted review clause lacks `flags`) is kept as two lines in `dependency-risk.md`. History: `planning/dependency-patch-flow/PLAN.md`. |
| Step 3d "Design note" on why candidacy needs no write-back | Rationale for not building something. The actionable part (release the pre-claim, emit the skip-reason) is kept in the spine. History: `planning/patch-prose-lock-release/PLAN.md`. |
| Step 5a.7 paragraphs contrasting with `isAddressedByAuthorReply` and re-narrating the incident PR | Kept as one anti-pattern line ("a timestamp alone never escalates") plus the mandatory printed `Judgment:` block. History: commits `e83101ec7`, `959a34202`. |
| Repeated "`PR_TASK_ID` reused from Step 2.1, no fresh fetch" bullets at each escalation site | Stated once in `model-resolution.md` and the BLOCKED table in `lane-shared.md`; `commands/references/escalation-pattern.md` already says the caller resolves `PR_TASK_ID`. The 6d exception (reuses 6b.6's first match) is kept. |
| Duplicate toolchain text in 5a.5 and 6a.5, and the three copies of worktree setup, claim, heartbeat, status handling, upsert and cleanup | Identical modulo step numbers; merged into `lane-shared.md`, parameterized by lane. Merged, not lost. |
| The three verbatim copies of the subagent `[C] Validate`, `[C.5]` test-coverage and pre-push verification-record text | Kept once each as shared prompt blocks in `lane-shared.md`; each lane prompt marks where to paste them verbatim. |
| Step 2.2's long justification of why the commit-bump handback is subagent-agnostic | Reduced to one sentence in `model-resolution.md`; behavior unchanged. |
| Per-step "why a pre-work claim / heartbeat is needed" paragraphs | Kept once in `lane-shared.md`. |
| Step 5c.5 history of the removed manual `reviewState: "pending"` reset (PFL-2.2/PFL-4.1) | Kept as one sentence in `lane-findings.md`; the reset no longer exists in either variant. |

## Reshaped (behavior-preserving)

| Change | Note |
|---|---|
| Step 3a.5 dependency-risk detection runs only on a spine trigger (bot author, or a manifest/lockfile among changed files) | The audit's chosen trigger: a superset of the common watched-path cases, so false positives only cost a reference read. Risk: a repo whose `renovate.json`/`dependabot.yml` watches a non-manifest path and whose PR is human-authored would skip detection. The already-held exclusion is kept whole. |
| Steps 1, 2 and 2.5 compressed to one spine section | The exact-membership `jq -e` scope check and fail-closed allowlist are in `classification.md`; the spine keeps the "never a substring test" rule. |
| Unmeasured guards (5a.6b, 5a.7, 6b.6) gained a printed no-match line | Added so each step has an observable **Proof:** signal (`patch.json` marks them "marker needed"). Print-only; no state change. |

## Deliberately not changed (tracked separately per the audit)

- CFE-1.1 stays lane-6-only; hoisting it into the shared claim for lanes 4 and 5 would be a behavior
  change.
- `PR_TASK_ID` keeps its two semantics (Step 2.1 highest tier vs. 6b.6 first match).
- No shared `ciFailureSignature` source for lanes 4/5.
