# Dependency Risk Analysis

Heuristics for classifying the risk of a dependency-bump PR (Dependabot or Renovate) and
producing a recommendation. This is pure analysis — given a PR's **diff**, **body**, and
**author** (`author.login`), it produces flags and a recommendation. It has no opinion on
how the caller fetched that PR, how it formats a comment from the result, or how/whether it
persists any state — those are the calling skill's concerns, not this reference's.

## Inputs

- **`diff`** — the PR's diff (e.g. `gh pr diff`). Used to see the actual version bump(s) and
  how many semver levels each spans.
- **`body`** — the bot's PR description. For Dependabot, a single-package changelog snippet.
  For Renovate, typically a grouped markdown table (one row per bumped package).
- **`author.login`** — the actual PR author (not a heuristic guess). Drives which analysis
  path below applies.
- **`labels`** (optional) — the PR's labels, if available. Used only by the Renovate path's
  needs-human signal; safe to omit entirely (see below).

## Output

- **`recommendation`** — one of `merge` / `review` / `hold` (exactly one per PR, see the
  Renovate rollup below for the grouped case).
- **`flags`** — `breakingChange`, `securityRelevant`, `productionImpact` (booleans).
- **`reasoning`** — free text explaining why the recommendation was reached.

## Recommendation options

Shared across both the Dependabot and Renovate paths:

- `merge` — safe patch/minor update, no breaking changes, low risk
- `review` — significant bump, possible breaking changes, or security-relevant
- `hold` — known breaking change, deprecated package, or requires code changes first

## Flags to assess

Shared across both paths:

- `breakingChange` — major version bump (X.0.0 → Y.0.0), or the body explicitly mentions
  breaking changes
- `securityRelevant` — a CVE is mentioned in the body, or the package is security-focused
  (e.g. `helmet`, `bcrypt`, `jsonwebtoken`)
- `productionImpact` — the package is in `dependencies` (not `devDependencies`)

## Dependabot path (single package)

Applies when `author.login == "app/dependabot"`.

**Heuristics:**

- Patch bump (x.y.Z → x.y.Z+1) → almost always `merge` unless security-flagged
- Minor bump (x.Y.z → x.Y+1.z) → usually `merge`, check for deprecation warnings in the body
- Major bump (X.y.z → X+1.y.z) → usually `review` or `hold`; read the body carefully
- CVE in body → `review` minimum; flag `securityRelevant`
- `devDependencies` only → lower production risk; usually `merge` or `review`
- Package in `dependencies` (production) → flag `productionImpact`

## Renovate path (grouped)

Applies when `author.login == "app/renovate"`.

Renovate bundles multiple package bumps into a single PR. Its body typically contains a
markdown table with columns like `Package | Type | Update | Change` (one row per bumped
package). Parse that table out of `body`.

Unlike the Dependabot path, **do not re-derive the update type from the version strings** —
each row already carries Renovate's own classification (`patch` / `minor` / `major`) in its
`Update` column; use it as-is.

This analysis always produces exactly **one** recommendation per PR, never one per package.
Apply the same flags (`breakingChange`, `securityRelevant`, `productionImpact`) and the same
recommendation options (`merge`/`review`/`hold`) to *each row*, then roll the group up by
taking the **maximum-severity row** across the group — e.g. if 4 rows are patch bumps and 1
is a major bump, the PR-level recommendation is driven by that one major row (`review` or
`hold`), not diluted by the others.

**Needs-human label signal:** check the PR's `labels` (when available) for a needs-human-style
label — e.g. `renovate:needs-human`. When present, treat it as a first-class signal that
forces the recommendation to at least `review` (or `hold` if the group also has a breaking
row), regardless of what the table analysis alone would have produced.

This label convention is **repo-specific** — it comes from that repo's own `renovate.json`
config, not from Renovate itself. Some repos define a label like `renovate:needs-human` for
this purpose; others may not have any such label configured, or may name it differently. The
table-based heuristics above must **degrade gracefully** when no matching label is present or
configured — i.e. they must still produce a correct recommendation from the table alone, with
the label check only ever adding a stricter floor, never something the analysis depends on.

## Author mismatch fallback

When `author.login` is neither `app/dependabot` nor `app/renovate`, fall back to the
Dependabot path's heuristics as a best-effort default, and explicitly note the author
mismatch in the reasoning text — e.g. "author `{login}` did not match a known
dependency-bot login; treated as a single-package update using Dependabot heuristics".
