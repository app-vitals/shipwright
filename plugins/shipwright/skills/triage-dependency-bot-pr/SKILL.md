---
name: triage-dependency-bot-pr
description: Analyze a single Dependabot or Renovate PR — fetch metadata and diff, classify risk (merge/review/hold), and post (or stage, per policy) a patrol-style comment, updating `state/dependency-bot-reviews.json`. Use when asked to triage one specific dependency-bot PR. Arguments — `<pr-number>` (required), `--repo owner/repo` (optional; detected from cwd if omitted).
---

# Triage a Dependency Bot PR

Parse the invocation arguments: first token is the PR number. Optional `--repo owner/repo` specifies the repo — if not provided, detect from current directory.

## 1. Resolve repo

If `--repo` not in arguments:
```bash
gh repo view --json nameWithOwner -q '.nameWithOwner'
```

Set REPO (e.g. `my-org/my-repo`) and REPO_SLUG (replace `/` with `_`, e.g. `my-org_my-repo`).

## 2. Fetch PR context

```bash
gh pr view $PR --repo $REPO --json number,title,body,author,headRefName,headRefOid,baseRefName,files,labels,url
gh api "repos/$REPO/actions/runs?branch=$(gh pr view $PR --repo $REPO --json headRefName -q '.headRefName')&per_page=5" \
  --jq '.workflow_runs[] | {name, status, conclusion}' 2>/dev/null || true
```

Extract:
- `title` — e.g. "Bump axios from 1.6.0 to 1.7.0"
- `body` — the bot's description (a single-package changelog snippet for Dependabot, or a
  grouped markdown table for Renovate)
- `author.login` — drives which analysis path Step 4 uses
- `headRefName` — branch name
- `headRefOid` — current head commit SHA; embedded in the idempotency marker (Step 4.5) and
  the comment footer (Step 5), and recorded as `triagedCommitSha` in state
- `labels` — checked in the Renovate path for a needs-human signal (see Step 4)
- `files` — changed files
- CI check statuses (from Actions API — PATs do not have Checks API access)

## 3. Fetch the diff

```bash
gh pr diff $PR --repo $REPO
```

Look at the actual version bumps — what changed and how many semver levels.

## 4. Analyze risk

Branch on `author.login` (the actual PR author, not a heuristic guess):

**Recommendation options** (shared across both paths):
- `merge` — safe patch/minor update, no breaking changes, low risk
- `review` — significant bump, possible breaking changes, or security-relevant
- `hold` — known breaking change, deprecated package, or requires code changes first

**Flags to assess** (shared across both paths):
- `breakingChange` — major version bump (X.0.0 → Y.0.0), or body explicitly mentions breaking changes
- `securityRelevant` — CVE mentioned in body, or security-focused package (e.g. `helmet`, `bcrypt`, `jsonwebtoken`)
- `productionImpact` — package is in `dependencies` (not `devDependencies`)

### If `author.login == "app/dependabot"` — Dependabot path (single package)

**Heuristics:**
- Patch bump (x.y.Z → x.y.Z+1) → almost always `merge` unless security-flagged
- Minor bump (x.Y.z → x.Y+1.z) → usually `merge`, check for deprecation warnings in body
- Major bump (X.y.z → X+1.y.z) → usually `review` or `hold`; read the body carefully
- CVE in body → `review` minimum; flag `securityRelevant`
- `devDependencies` only → lower production risk; usually `merge` or `review`

### If `author.login == "app/renovate"` — Renovate path (grouped)

Renovate bundles multiple package bumps into a single PR. Its body typically contains a
markdown table with columns like `Package | Type | Update | Change` (one row per bumped
package). Parse that table out of `body`.

Unlike the Dependabot path, **do not re-derive the update type from the version strings** —
each row already carries Renovate's own classification (`patch` / `minor` / `major`) in its
`Update` column; use it as-is.

This skill always emits exactly **one** recommendation per PR, never one per package. Apply
the Dependabot path's same flags (`breakingChange`, `securityRelevant`, `productionImpact`)
and the same recommendation options (`merge`/`review`/`hold`) to *each row*, then roll the
group up by taking the **maximum-severity row** across the group — e.g. if 4 rows are patch
bumps and 1 is a major bump, the PR-level recommendation is driven by that one major row
(`review` or `hold`), not diluted by the others.

**Needs-human label signal:** check the `labels` fetched in Step 2 for a needs-human-style
label — e.g. `renovate:needs-human`. When present, treat it as a first-class signal that
forces the recommendation to at least `review` (or `hold` if the group also has a breaking
row), regardless of what the table analysis alone would have produced.

This label convention is **repo-specific** — it comes from that repo's own `renovate.json`
config (e.g. vitals-os's `renovate.json` defines `renovate:needs-human`), not from Renovate
itself. Other repos may not have any such label configured, or may name it differently. The
table-based heuristics above must degrade gracefully when no matching label is present or
configured — i.e. they must still produce a correct recommendation from the table alone,
with the label check only ever adding a stricter floor, never something the analysis
depends on.

### Otherwise (author is neither `app/dependabot` nor `app/renovate`)

Fall back to the Dependabot path's heuristics as a best-effort default, and explicitly note
the author mismatch in the reasoning text (e.g. "author `{login}` did not match a known
dependency-bot login; treated as a single-package update using Dependabot heuristics").

## 4.5. Idempotency check

Before formatting, staging, or posting anything, check whether this exact commit was
already triaged and posted:

```bash
gh api "repos/$REPO/issues/$PR/comments" --paginate --jq \
  ".[] | select(.body | contains(\"<!-- shipwright:dependency-bot-triage:$HEAD_SHA -->\"))"
```

Where `$HEAD_SHA` is `headRefOid` from Step 2.

If any comment matches, this commit was already triaged — skip straight to the Report step
(Step 8) after reconciling state in case the local copy was lost: update the matching entry
in `state/dependency-bot-reviews.json` to `status: "posted"`, preserve `postedAt` if already
set (else set it to now), and set `triagedCommitSha: $HEAD_SHA`. Do not re-format the
comment, and do not call `gh pr comment` or write a staged file.

This check is the idempotency backstop independent of local `state/` — per the plugin's
Independence Principle #1, local state is a cache, never load-bearing, so GitHub itself must
be able to answer "was this already done?" on its own.

## 5. Format the comment

**Dependabot path** (and the author-mismatch fallback):

```
### {icon} Patrol: {label}

**{summary}**

{flags}

{reasoning}

<sub>🏔️ [shipwright](https://github.com/app-vitals/shipwright) · claude-sonnet-4-6</sub><!-- shipwright:dependency-bot-triage:{headRefOid} -->
```

**Renovate path** — same framing, plus a rolled-up package table beneath the summary so the
reviewer can see what's actually bundled:

```
### {icon} Patrol: {label}

**{summary}**

| Package | Type | Update | Change |
|---------|------|--------|--------|
| {package} | {type} | {update} | {change} |
| ... | ... | ... | ... |

{flags}

{reasoning}

<sub>🏔️ [shipwright](https://github.com/app-vitals/shipwright) · claude-sonnet-4-6</sub><!-- shipwright:dependency-bot-triage:{headRefOid} -->
```

Where:
- `{icon}`: ✅ for merge, ⚠️ for review, 🛑 for hold
- `{label}`: "Safe to merge" / "Needs review" / "Hold — action required"
- `{summary}`: one sentence — e.g. "Bumps axios from 1.6.0 to 1.7.0 — minor release, no breaking changes." (Dependabot), or "Bundles 5 package updates — 1 major bump drives this to review." (Renovate)
- `{flags}`: space-separated, only include applicable: `🔴 Breaking change`, `🔒 Security relevant`, `🏭 Production impact`
- `{reasoning}`: 2-3 sentences explaining the recommendation
- `{headRefOid}`: the current head commit SHA from Step 2 — makes the marker commit-scoped so Step 4.5 can detect "already posted at this exact commit" purely from GitHub state

The footer marker is skill-specific and commit-scoped: `<!-- shipwright:dependency-bot-triage:{headRefOid} -->`, not the generic `<!-- shipwright -->` used elsewhere.

## 6. Read policy

Read `state/agent-policy.md`. If the file doesn't exist, or the `auto_post_dependency_bot_triage`
key is absent, default to `true`.

Print a one-line policy summary:
```
Policy: {staging|auto-posting} dependency-bot triage
```

## 7. Stage or post, per policy

### If `auto_post_dependency_bot_triage` is true (default) — post directly

Write the formatted comment body to a temp file, then post it via `--body-file` (never an
inline heredoc):

```bash
gh pr comment $PR --repo $REPO --body-file /tmp/shipwright-dependency-bot-triage-{REPO_SLUG}-{PR}.txt
rm /tmp/shipwright-dependency-bot-triage-{REPO_SLUG}-{PR}.txt
```

Update the entry in `state/dependency-bot-reviews.json` matching `pr == $PR && repo == $REPO_NAME`
(just the repo name, not org; create a new entry if none exists):

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
  "status": "posted",
  "triagedCommitSha": "<headRefOid>",
  "stagedFile": null,
  "postedAt": "<now>",
  "mergedAt": null
}
```

Write back to `state/dependency-bot-reviews.json`. Do NOT write a staged file in this
branch — posting supersedes staging.

### If `auto_post_dependency_bot_triage` is false — stage only (original behavior, unchanged)

```bash
mkdir -p state/dependency-bot-reviews
```

Write the formatted comment to `state/dependency-bot-reviews/DEP_REVIEW_{REPO_SLUG}_{PR}.md`.

Update the entry in `state/dependency-bot-reviews.json` matching `pr == $PR && repo == $REPO_NAME`
(create a new entry if none exists):

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
  "status": "staged",
  "triagedCommitSha": "<headRefOid>",
  "stagedFile": "state/dependency-bot-reviews/DEP_REVIEW_{REPO_SLUG}_{PR}.md",
  "postedAt": null,
  "mergedAt": null
}
```

Write back to `state/dependency-bot-reviews.json`. Do NOT call `gh pr comment` in this
branch.

## 8. Report

Output the formatted comment inline so it's immediately readable, then a short summary
reflecting what actually happened:

```
---
Posted → GitHub (comment on #{PR})
Recommendation: {merge|review|hold}
```

or, when staged:

```
---
Staged → state/dependency-bot-reviews/DEP_REVIEW_{REPO_SLUG}_{PR}.md
Recommendation: {merge|review|hold}
```

or, when the idempotency check (Step 4.5) short-circuited:

```
---
Already triaged at {headRefOid} — skipped
Recommendation: {merge|review|hold}
```
