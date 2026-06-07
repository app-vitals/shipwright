---
name: test-debt
description: >
  Post-execution skill for the test-readiness pipeline. Computes a corrective-commit ratio per milestone from git log to surface over-specified or under-specified tasks. A high corrective-commit ratio flags milestones where the plan underestimated scope, tasks were too large, or acceptance criteria were ambiguous. Invoke after any milestone completes to catch planning debt before the next run.
---

# test-debt skill

## Purpose

Measure execution quality, not just completion. A milestone that closes all its tasks but generates a long tail of fix commits was under-specified. The corrective-commit ratio makes this visible as data so the next roadmap generation can improve.

## When invoked

By the `/test-debt` command. Requires:
- A git repository with commits since the roadmap was executed
- `docs/test-readiness/test-readiness-plan.md` (to read milestone task IDs and start dates)

## The corrective-commit ratio

### Definition

For a given milestone M:

```
corrective_ratio(M) = corrective_commits(M) / total_commits(M)
```

Where:
- **total_commits(M)** — all commits whose message references a task ID from M (e.g., `T-001`, `T-002a`) or the milestone label (e.g., `M1`, `milestone-1`)
- **corrective_commits(M)** — commits in total_commits(M) whose message matches a corrective pattern (see below)

### Corrective commit patterns

A commit is corrective if its subject line matches any of:

| Pattern | Examples |
|---|---|
| `fix:` or `bugfix:` prefix | `fix: correct auth middleware import path` |
| `fix(T-NNN)` reference | `fix(T-042): teardown was leaving DB rows` |
| `revert:` prefix | `revert: revert T-015 — broke smoke layer` |
| `chore: retry` / `chore: re-run` | `chore: retry T-008 after infra fix` |
| Explicit correction language | commit body contains "corrects T-NNN", "follow-up to T-NNN", "missed in T-NNN" |

Match case-insensitively. A commit may match multiple patterns — count it once.

### Computing from git log

```bash
# All commits referencing milestone M1 tasks
git log --oneline --all --grep="T-0[0-9][0-9]\|M1\|milestone.1" \
  --after="<milestone-start-date>" --before="<milestone-end-date>"

# Corrective commits only
git log --oneline --all \
  --grep="^fix:\|^bugfix:\|^revert:\|fix(T-\|corrects T-\|follow-up to T-\|missed in T-" \
  --after="<milestone-start-date>" --before="<milestone-end-date>"
```

Dates come from `test-readiness-plan.md` task start/close timestamps if recorded, or from the PR merge timestamps in git history.

## Red-flag threshold

| Ratio | Signal |
|---|---|
| < 0.10 | Healthy — fewer than 1 in 10 commits are corrections |
| 0.10 – 0.25 | Watch — moderate churn; review task sizing for this milestone |
| > 0.25 | **Red flag** — more than 1 in 4 commits were corrections; milestone was under-specified |

A ratio above 0.25 triggers a milestone review:
1. List the corrective commits with their referenced task IDs
2. Group by task — which tasks had the most corrections?
3. Classify the root cause per task: oversized task, ambiguous acceptance criteria, missing dependency, wrong layer prescription, or external blocker
4. Emit a **planning debt note** summarizing the findings for inclusion in the next roadmap's Open Risks section

## Output

The skill writes `docs/test-readiness/test-debt.md` with:

### Per-milestone summary table

| Milestone | Total commits | Corrective | Ratio | Flag |
|---|---|---|---|---|
| M1 — Infrastructure baseline | 34 | 6 | 0.18 | watch |
| M2 — Critical-path coverage | 51 | 4 | 0.08 | healthy |
| M3 — Canary suite live | 22 | 9 | 0.41 | 🚩 red flag |

### Per-task breakdown (red-flag milestones only)

For each flagged milestone, list the tasks with ≥2 corrective commits and their classified root cause.

### Planning debt notes

Free-text recommendations for the next roadmap run based on the root-cause classification. Examples:
- "M3 canary tasks had 5 corrections due to missing `TEST_TARGET_URL` wiring — add an explicit canary-wiring infra task to M1 in future roadmaps"
- "T-042 had 3 fix commits — the 6-service fan-out was correct but the verification command didn't account for the shared auth fixture; update the task template"

## Process

1. Read `docs/test-readiness/test-readiness-plan.md`. Extract task IDs grouped by milestone.
2. For each milestone, run the git log queries above against the repo.
3. Compute the ratio per milestone.
4. For ratios > 0.25, extract and classify the corrective commits.
5. Write `docs/test-readiness/test-debt.md`.
6. Print a summary table to stdout.

## Failure modes to avoid

- **Don't count commits that fix infrastructure outside the task scope.** If the CI runner broke independently, those revert commits aren't a planning signal.
- **Don't aggregate across all milestones into a single ratio.** M1 (infra) and M3 (canary) have different expected churn profiles. Per-milestone ratios catch milestone-specific planning debt.
- **Don't flag a milestone red if it has fewer than 5 total commits.** Small milestones have high ratio variance; the threshold is only meaningful with enough signal.
