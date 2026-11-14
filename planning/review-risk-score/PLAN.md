# Plan: review-risk-score (initiative SWI-3)

Repo: app-vitals/shipwright

## Goal
The final review comment posted to GitHub includes a Low/Medium/High risk rating when the
verdict is APPROVE. Review subagents contribute to the assessment. The rating is a
transparent heuristic: the scoring factors are published in the comment.

## Design
- **Contract**: optional `riskAssessment` on the reviewer output
  (`{level: low|medium|high, factors: [{factor, level, evidence}]}`). Omitting it is valid, so
  custom reviewers keep working. `code-reviewer.md` emits it for judgment-based factors
  (blast radius, data integrity, reversibility, hot paths, public API). Step 7's merge unions
  every reviewer's factors. `finding-verifier` is unchanged.
- **Deterministic signals**: `scripts/compute-pr-risk-signals.ts` computes size, diffusion and
  entropy, sensitive paths, file churn / bug-fix history / contributor count, code-without-tests,
  CI status and CODEOWNERS coverage from the diff, git history and CI. No author/person-based
  signals (no author experience, reviewer load or incident rate).
- **Merge**: `scripts/compute-risk-rating.ts`, a pure function. Heuristic points set a baseline
  band; a subagent can raise the level (a subagent "high" floors the result at High) but never
  lower it below the heuristic. Bands come from a published scoring table.
- **Posting**: Step 10 adds `Risk: Low|Medium|High - {reason}` after the `Verdict: APPROVE`
  lead-in, plus a collapsed factor table. Only when `verdictLabel` is APPROVE (includes
  self-authored PRs whose event is forced to COMMENT). The literal `Verdict: APPROVE` phrase
  stays first so `isSelfCleanApprove` and the verdict validator keep working. The same section
  goes in `PR_REVIEW_{pr}.md`.
- No policy toggle in v1.

## Tasks
| Task | Title | Depends on |
|---|---|---|
| RSK-1.1 | feat: add optional riskAssessment to review contract and code-reviewer | - |
| RSK-1.2 | feat: add compute-pr-risk-signals script | - |
| RSK-1.3 | feat: add compute-risk-rating merge script | RSK-1.1, RSK-1.2 |
| RSK-2.1 | feat: wire risk rating into review and post Risk line on APPROVE | RSK-1.3 |
| RSK-2.2 | docs: document review risk scoring | RSK-2.1 |

All changes are additive: Safe to deploy standalone: yes for every task.

## Decisions (Dan, 2026-11-14)
- Subagents can raise but not lower the heuristic rating.
- Risk line on APPROVE only.
- No policy toggle.
- Own session slug `review-risk-score`.
