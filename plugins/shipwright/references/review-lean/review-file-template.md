# review-lean: classification categories and the review file

Mechanics for `commands/review-lean.md` Step 6 (classification) and Step 9 (`$WORKSPACE_ROOT/state/reviews/PR_REVIEW_{pr}.md`,
consumed by `/shipwright:review-staged`).

## Step 6 categories

Before reading individual files, build a structural picture from the PR body, commit messages, and file list:

- **Why**: What problem is this solving? What's the motivation? (PR body, linked issues, commit messages)
- **What changed**: High-level summary of affected areas — which features, services, or layers are touched
- **View changes**: New or modified pages, components, or UI flows — business logic changes, not just layout tweaks
- **API changes**: New, removed, or modified endpoints; changed request/response shapes; auth changes; new event streams (SSE, WebSocket)
- **Database changes**: New tables or columns, dropped columns, index changes, migrations, schema-affecting model changes
- **Architecture changes**: New services or packages, new ways of exposing functionality, changes to service boundaries
- **Breaking changes**: Anything that breaks backwards compatibility — removed endpoints, changed shapes, renamed fields,
  dropped columns, changed auth semantics, changed event contracts. Assume rolling deployments.
- **Testing changes**: "test-touching" (modifies or adds test files) or "untested logic" (production code with no
  corresponding test additions), identified by the project's language and toolchain conventions rather than fixed
  filename patterns; note which test files were added, modified, or removed, or "none".

Note which categories are present (even if "none") — this drives review focus.

## Step 9 template

```markdown
# PR Review: #{pr} - {title}

**Author**: @{author}
**Branch**: {head} -> {base}
**Date**: {date}
**Reviewed commit**: {head_sha}

## Summary

{Brief description of what this PR does}

## Change Summary

**Why**: {motivation}
**What changed**: {high-level summary of affected areas}
**View changes**: {or "none"}
**API changes**: {or "none"}
**Database changes**: {or "none"}
**Architecture changes**: {or "none"}
**Breaking changes**: {or "none"}
**Testing changes**: {"test-touching", "untested logic", or "none", with the files}

## CI Status

{Current status of checks}

## Risk

{Only when RISK_RATING is set (RSK-2.1); omit the whole section, heading included, otherwise.}

**Risk**: {RISK_RATING.level — Low|Medium|High}
**Reason**: {RISK_RATING.reason}

{RISK_RATING.table}

## Dependency Risk Analysis

{Only when Step 5.8 triggered; omit the whole section, heading included, otherwise. Populated from
DEPENDENCY_RISK_ANALYSIS and never folded into the Critical/Important/Suggestions lists.}

**Recommendation**: {merge|review|hold}
**Flags**: {breakingChange, securityRelevant, productionImpact — whichever apply, or "none"}
**Reasoning**: {DEPENDENCY_RISK_ANALYSIS.reasoning}

## Critical Issues ({count})

### 1. {Issue title}
- **File**: `path/to/file.ts:123`
- **Confidence**: 95
- **Issue**: {description}
- **Suggestion**: {fix, if applicable}

## Important Issues ({count})

## Suggestions ({count})

- {suggestion with file:line reference}

## Strengths

- {What's done well -- keep brief}

## Recommendation

{APPROVE or COMMENT}
{One-sentence reasoning}
```

## Re-review (update)

If `$WORKSPACE_ROOT/state/reviews/PR_REVIEW_{pr}.md` already exists (`test -f`), append an update section instead of
creating a new file. Do not use the task store's `reviewCycles` — another agent may have incremented it; the local file is
the signal that *this* agent has a prior review.

```markdown
---

## Review Update - {date}

### New Commits Since Last Review

- {sha}: {message}

### Prior Findings Resolution

| Finding | Status | Evidence |
|---------|--------|----------|
| {ref} | Addressed | {evidence, e.g. Fixed in `file.ts:45`} |
| {ref} | Not addressed | {evidence, e.g. Still missing validation} |

### New Issues ({count})

### Updated Recommendation

{APPROVE or COMMENT}
**Previous**: {previous verdict}
**Now**: {updated verdict with reasoning}
```

Populate the Prior Findings Resolution table from the subagent's `priorFindingsStatus[]` (one row per entry,
`resolved: true` → `Addressed`, `resolved: false` → `Not addressed`, `evidence` verbatim). Omit that subsection when the
`Prior Findings — Requires Resolution Check` input was not passed.
