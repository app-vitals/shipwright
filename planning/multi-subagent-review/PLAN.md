# Plan: multi-subagent-review — parallel reviewer subagents for the review phase

Client request: run multiple reviewer subagents in parallel, inspired by Anthropic's
"Solving code review at Anthropic" post (several focused reviewers, then a filtering pass).

## Design

**Config: comma-separated list in the existing `subagentType` string.** Subagent types
(e.g. `shipwright:code-reviewer`) never contain commas, so the delimiter is safe. No DB
migration; the UI card, PUT endpoint and `GET /agents/:id/config` wire shape
(`phaseMethodology.<phase>` is still a string) are unchanged, and a single value is a list
of one — existing agents behave identically. If per-entry options (model, focus prompt) are
ever needed, move to a JSON array then.

**Scope: `review` only.** Reviewers are read-only so fan-out is safe. `dev-task`/`patch`
mutate a single worktree/branch (parallel runs collide); `plan-session`/`prd`/`deploy` have no
sensible fan-out. The API rejects multi-value lists for every other phase (400) rather than
accepting and ignoring them. List capped at 5 entries (cost is linear in N).

**Focus comes from the agent type.** N copies of one reviewer is wasted spend; each entry is a
distinct custom agent type whose definition carries its focus. The review contract is unchanged.

**review.md Step 7 fan-out.** Parse the list; dispatch all reviewers in a single parallel Agent
call, each with identical contract inputs. Per-reviewer failure: retry once, then drop with a
one-line note. All reviewers failed -> existing built-in fallback chain (built-in -> retry ->
inline). Single-entry lists take the existing code path untouched.

**Merge.** Dedupe findings by file + nearby line + title similarity; keep highest severity and
record agreement count; apply `min_confidence` / `max_findings` AFTER the merge, not per
reviewer. `priorFindingsStatus[]`: a prior finding is `resolved` only if every reviewer
attests it resolved (conservative).

**Verifier pass (built-in, NOT configurable in v1).** When >1 reviewer ran, a fixed built-in
verifier subagent re-checks each merged finding against the diff and drops ones it cannot
substantiate. Deliberately not exposed via `phaseMethodology` — no new phase key, no UI knob —
so we can tune it before committing to a contract.

## Tasks

| ID | Title | Depends on | Branch | Layer | Hrs | Cx | Model |
|----|-------|-----------|--------|-------|-----|----|-------|
| MPS-1.1 | feat: validate comma-separated subagent lists for the review phase | — | feat/mps-1-1-list-validation | API | 3 | 3 | sonnet |
| MPS-2.1 | feat: fan out review subagents in parallel in review Step 7 | MPS-1.1 | feat/mps-parallel-review | Shared | 4 | 4 | sonnet |
| MPS-2.2 | feat: merge and dedupe findings across parallel reviewers | MPS-2.1 | feat/mps-parallel-review | Shared | 4 | 4 | sonnet |
| MPS-2.3 | feat: add built-in verifier pass over merged findings | MPS-2.2 | feat/mps-parallel-review | Shared | 4 | 4 | sonnet |
| MPS-3.1 | docs: document multi-reviewer config, merge and verifier | MPS-2.3 | docs/mps-3-1-multi-reviewer-docs | Shared | 2 | 2 | haiku |

2.1–2.3 are bundled on one branch/PR (an unmerged fan-out with no merge step is not reviewable
or shippable). Bundle model inherits sonnet.

## Breaking Change Safety
All additive. Single-value config follows the unchanged path. Validation (1.1) only rejects
*new* multi-value writes outside `review`; existing single values are untouched. Safe to deploy
standalone: yes for every task.

## HITL scan
No tasks require human steps. No `.claude/**` paths are touched (verifier agent goes under
`plugins/shipwright/agents/`).
