# Review risk rating

`/shipwright:review` rates how risky a PR is to merge as **Low**, **Medium** or **High**. The rating is a property of the *change*, never of the author. It combines deterministic heuristic factors with the judgment of the review subagents.

Source of truth: `plugins/shipwright/scripts/compute-pr-risk-signals.ts` (heuristics), `plugins/shipwright/scripts/compute-risk-rating.ts` (merge and thresholds), and Steps 6.1 / 7 of `plugins/shipwright/commands/review.md`.

## Factor categories

### Heuristic factors (deterministic, scored in points)

| Factor | What it measures | Points |
|--------|------------------|--------|
| `size` | Lines changed (+ files changed) | Lines: <100 → 0, <500 → 2, <1000 → 3, else 4. Files: <15 → 0, <30 → 1, <60 → 2, else 4. Summed. |
| `diffusion` | Spread across top-level subsystems, directories, change entropy, shared-library paths | Subsystems: ≤1 → 0, ≤3 → 1, ≤5 → 2, else 4; +1 for ≥10 directories; +1 for ≥4 files with entropy >0.9; +2 if any `shared/common/lib/core/utils` path |
| `sensitive-paths` | Auth/security, migrations/schema, infra/CI/deploy, dependency manifests | 2 per category touched |
| `file-history` | Recent churn, bug-fix and revert commits, distinct contributors, young files | Up to 2 each for churn (≥8 → 1, ≥20 → 2) and bug-fixes (≥1 → 1, ≥3 → 2); +1 for reverts; contributors ≥4 → 1, ≥6 → 2; +1 if a file is <30 days old. 0 when history is unknown. |
| `evidence-tests` | Production code changed without test changes | 0 if tests changed or no code changed; otherwise 2 (3 if >200 lines) |
| `evidence-ci` | CI status of the head commit | passing/unknown → 0, pending → 1, failing → 4 |
| `evidence-codeowners` | Changed files with no CODEOWNERS owner | 0 if all covered or unknown; 1 if some uncovered; 2 if ≥50% uncovered |

Unknown signals (no git history, no CODEOWNERS, CI status unavailable) score 0 rather than failing.

### Judgment factors (review subagents)

Each reviewer may return an optional `riskAssessment` (`{level, factors[]}`) covering only:

- **Blast radius**
- **Data integrity / migrations**
- **Reversibility / rollback**
- **Availability hot paths**
- **Public API changes**

## Scoring and thresholds

Heuristic points are summed and mapped to a baseline band (inclusive lower bounds, `RISK_THRESHOLDS` in `compute-risk-rating.ts`):

| Total heuristic points | Baseline level |
|------------------------|----------------|
| 8 or more | High |
| 4 – 7 | Medium |
| 0 – 3 | Low |

## Subagent merge rule: raise only

Subagent assessments can only **raise** the rating. Any subagent `high` (overall level or any factor) floors the result at High; any `medium` floors it at Medium. A subagent can never lower the result below the heuristic baseline. Malformed assessments (bad level, missing factor name, non-object entries) are ignored, and missing assessments yield the heuristic-only rating. When the level was raised, the reason reads `Risk: high (raised from medium by reviewer assessment) — ...`.

## Where it appears

The rating is posted **only on APPROVE** reviews (including self-authored PRs where the event is forced to `COMMENT`). The review body keeps `Verdict: APPROVE` first, followed by `Risk: Low|Medium|High - {reason}` and a collapsible "Risk factors" table. COMMENT and REQUEST_CHANGES reviews carry no Risk line. The saved review file has a `## Risk` section with the full table.

Rating is non-fatal: if signals or the merge script fail, the Risk line is omitted and the review proceeds.

## Author-based signals are excluded

No factor reads author identity, seniority, experience, reviewer load or incident rate. The only person-adjacent input is the distinct-contributor count of a *file's* history, which describes the file, not the PR author. Reviewers are instructed never to use person-based factors.
