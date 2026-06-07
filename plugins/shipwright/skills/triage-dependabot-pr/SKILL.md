---
name: triage-dependabot-pr
description: Analyze a single Dependabot PR — fetch metadata and diff, classify risk (merge/review/hold), stage a patrol-style comment to `state/dependabot-reviews/`, and update `state/dependabot-reviews.json`. Use when asked to triage one specific Dependabot PR. Does not post to GitHub. Arguments — `<pr-number>` (required), `--repo owner/repo` (optional; detected from cwd if omitted).
---

# Triage a Dependabot PR

Parse the invocation arguments: first token is the PR number. Optional `--repo owner/repo` specifies the repo — if not provided, detect from current directory.

## 1. Resolve repo

If `--repo` not in arguments:
```bash
gh repo view --json nameWithOwner -q '.nameWithOwner'
```

Set REPO (e.g. `app-vitals/vitals-os`) and REPO_SLUG (replace `/` with `_`, e.g. `app-vitals_vitals-os`).

## 2. Fetch PR context

```bash
gh pr view $PR --repo $REPO --json number,title,body,author,headRefName,baseRefName,files,url
gh api "repos/$REPO/actions/runs?branch=$(gh pr view $PR --repo $REPO --json headRefName -q '.headRefName')&per_page=5" \
  --jq '.workflow_runs[] | {name, status, conclusion}' 2>/dev/null || true
```

Extract:
- `title` — e.g. "Bump axios from 1.6.0 to 1.7.0"
- `body` — Dependabot's description
- `headRefName` — branch name
- `files` — changed files
- CI check statuses (from Actions API — PATs do not have Checks API access)

## 3. Fetch the diff

```bash
gh pr diff $PR --repo $REPO
```

Look at the actual version bumps — what changed and how many semver levels.

## 4. Analyze risk

**Recommendation options:**
- `merge` — safe patch/minor update, no breaking changes, low risk
- `review` — significant bump, possible breaking changes, or security-relevant
- `hold` — known breaking change, deprecated package, or requires code changes first

**Flags to assess:**
- `breakingChange` — major version bump (X.0.0 → Y.0.0), or body explicitly mentions breaking changes
- `securityRelevant` — CVE mentioned in body, or security-focused package (e.g. `helmet`, `bcrypt`, `jsonwebtoken`)
- `productionImpact` — package is in `dependencies` (not `devDependencies`)

**Heuristics:**
- Patch bump (x.y.Z → x.y.Z+1) → almost always `merge` unless security-flagged
- Minor bump (x.Y.z → x.Y+1.z) → usually `merge`, check for deprecation warnings in body
- Major bump (X.y.z → X+1.y.z) → usually `review` or `hold`; read the body carefully
- CVE in body → `review` minimum; flag `securityRelevant`
- `devDependencies` only → lower production risk; usually `merge` or `review`

## 5. Format the comment

```
### {icon} Patrol: {label}

**{summary}**

{flags}

{reasoning}

<sub>🏔️ [shipwright](https://github.com/app-vitals/shipwright) · claude-sonnet-4-6</sub><!-- shipwright -->
```

Where:
- `{icon}`: ✅ for merge, ⚠️ for review, 🛑 for hold
- `{label}`: "Safe to merge" / "Needs review" / "Hold — action required"
- `{summary}`: one sentence, e.g. "Bumps axios from 1.6.0 to 1.7.0 — minor release, no breaking changes."
- `{flags}`: space-separated, only include applicable: `🔴 Breaking change`, `🔒 Security relevant`, `🏭 Production impact`
- `{reasoning}`: 2-3 sentences explaining the recommendation

## 6. Write staged file

```bash
mkdir -p state/dependabot-reviews
```

Write the formatted comment to `state/dependabot-reviews/DEP_REVIEW_{REPO_SLUG}_{PR}.md`.

## 7. Update state file

Read `state/dependabot-reviews.json` (create `[]` if missing).

Find the entry matching `pr == $PR && repo == $REPO_NAME` (just the repo name, not org). If not found, create a new entry.

Set/update:
```json
{
  "pr": <number>,
  "repo": "<repo-name>",
  "org": "<org-name>",
  "title": "<pr title>",
  "branch": "<headRefName>",
  "firstSeen": "<now if new, else preserve existing>",
  "lastTriagedAt": "<now>",
  "recommendation": "<merge|review|hold>",
  "stagedFile": "state/dependabot-reviews/DEP_REVIEW_{REPO_SLUG}_{PR}.md",
  "status": "staged",
  "postedAt": null,
  "mergedAt": null
}
```

Write back to `state/dependabot-reviews.json`.

## 8. Report

Output the formatted comment inline so it's immediately readable, then:

```
---
Staged → state/dependabot-reviews/DEP_REVIEW_{REPO_SLUG}_{PR}.md
Recommendation: {merge|review|hold}
```

Do NOT post the comment to GitHub.
