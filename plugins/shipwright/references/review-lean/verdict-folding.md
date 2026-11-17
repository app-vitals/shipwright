# review-lean: building `pr_review_{pr}.json`

Mechanics for `commands/review-lean.md` Step 10. The `event`/`verdictLabel` always come verbatim from
`compute-review-verdict.ts`; nothing in this file feeds that computation. Full posting mechanics:
`references/post-review-guide.md`.

## JSON shape

```json
{
  "commit_id": "{head_sha}",
  "body": "Verdict: APPROVE — Looks good, approved.",
  "event": "APPROVE|COMMENT",
  "comments": [
    {
      "path": "path/to/file.ts",
      "line": 123,
      "side": "RIGHT",
      "body": "Comment text"
    }
  ]
}
```

For a COMMENT verdict the `body` follows the same convention, e.g.
`"body": "Verdict: COMMENT — {one-line summary of the most important finding}"`. The literal `Verdict: ...` label leads the
body on both the initial-review and re-review paths; `agent/src/check-patch.ts`'s `isSelfCleanApprove` scans for it
(`VERDICT_APPROVE_LABEL = /verdict\**\s*:\s*\**approve\b/i`) to recognize a clean self-approve where `event` is forced to
`COMMENT`.

## Dependency risk clause (DBR-3.2)

When Step 5.8 triggered and `DEPENDENCY_RISK_ANALYSIS` is set, append a short, clearly-labeled clause after the
`Verdict: ...` lead-in, e.g. `"Verdict: COMMENT — {code-review summary}; dependency risk:
{DEPENDENCY_RISK_ANALYSIS.recommendation} — {DEPENDENCY_RISK_ANALYSIS.reasoning}"`. It is additive: the dependency-risk
`recommendation` (`merge`/`review`/`hold`) never feeds the verdict. When Step 5.8 did not trigger, omit the clause.

## Risk line (RSK-2.1)

Only when `verdictLabel` is `APPROVE` (including self-authored PRs whose `event` is forced to `COMMENT`) and `RISK_RATING`
is set, append after the `Verdict: APPROVE — ...` lead-in (the label stays first in the body):

```
Risk: Low|Medium|High - {reason}

<details>
<summary>Risk factors</summary>

{RISK_RATING.table}

</details>
```

Use `RISK_RATING.level` capitalized and a short reason from `RISK_RATING.reason`. Never add it to a `Verdict: COMMENT`
body, and omit it when `RISK_RATING` is empty. Step 10.5's validation still passes because the body leads with the label.

## Diff-line mapping

For each finding with a `file:line` reference, check whether the line is in the diff
(`git diff origin/{base}...HEAD -- {file}`). Only lines within diff hunks are valid for inline comments; move the others to
the review body. Inline comments are included regardless of verdict.
