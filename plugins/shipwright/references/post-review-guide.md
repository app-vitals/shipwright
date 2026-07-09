# Post-Review Guide -- Submitting Reviews via GitHub API

How to build and submit a GitHub review with inline comments. Referenced by
`review.md` Steps 9-10.

---

## Diff Against the Correct Base Branch

Always diff against the PR's actual base branch, not main:

```bash
base=$(gh pr view <number> --repo <org/repo> --json baseRefName -q '.baseRefName')
git diff "$base"...HEAD
```

PRs targeting feature branches will show wrong diffs if compared to main.

---

## Mapping Inline Comments to Diff Lines

GitHub's reviews API only accepts `line` numbers for lines that appear in the diff.

For each finding with a `file:line` reference:

1. Get the file-specific diff: `git diff <base>...HEAD -- <file>`
2. Check if the line number falls within a diff hunk
3. If yes: include as an inline comment with `path`, `line`, `side: "RIGHT"`
4. If no: move the comment to the review body instead

For new files: any line works (the entire file is in the diff).
For modified files: only lines within `@@` hunk ranges are valid.

---

## Review JSON Format

Write to `state/reviews/pr_review_<number>.json`:

```json
{
  "commit_id": "<head_sha>",
  "body": "Verdict: APPROVE — <concise one-liner>",
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

### Body Guidelines

Keep the body minimal -- inline comments carry the detail. The body MUST start with the
literal phrase `Verdict: APPROVE` or `Verdict: COMMENT` (matching the verdict), followed
by a short one-liner. A good body is:

- **APPROVE**: "Verdict: APPROVE — Looks good, approved." or "Verdict: APPROVE — Looks
  good, a few suggestions inline."
- **COMMENT**: "Verdict: COMMENT — A few issues to address before merging." + one-line
  summary of the most important finding.

Don't enumerate findings in the body -- the author sees both body and inline comments.

**This literal phrase is load-bearing, not stylistic.** `check-patch.ts`'s
`isSelfCleanApprove` matches `Verdict: APPROVE` (case-insensitive, optional `**` markdown
bold) anywhere in a self-authored review body to recognize a clean self-approve -- this
matters because GitHub blocks self-APPROVE via the API, so a self-review's clean approval
is always posted as `event: COMMENT`. Free-form approval prose without the literal phrase
(e.g. "Clean conversion, no blocking issues.") never matches, and the patch cron then
treats the review as an unaddressed finding forever. Always lead with the `Verdict: ...`
label -- don't paraphrase it away.

### Tone

The `PR_REVIEW_<number>.md` file is a draft written for the agent's owner. The
review JSON body is addressed to the PR author. Be direct -- no filler language
("FYI", "Note:", "Just a heads up").

---

## Submitting the Review

```bash
gh api -X POST /repos/{org}/{repo}/pulls/{number}/reviews \
  --input state/reviews/pr_review_{number}.json
```

Capture `html_url` from the response to print the review link.

---

## APPROVE vs COMMENT Rule

- **COMMENT**: any finding at `important` (75-89) or `critical` (90-100) severity
  remains after threshold filtering — no exceptions
- **APPROVE**: all remaining findings are `suggestion` level (50-74), or there are
  no findings at all

APPROVE means the PR is clean enough to merge. If there is anything blocking or
important, COMMENT so it gets addressed before the deploy pipeline runs.

**Never use REQUEST_CHANGES** -- it blocks the PR and requires the reviewer to
dismiss. COMMENT achieves the same signal without the hard block.
