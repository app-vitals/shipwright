# Competitive Page Freshness — Product Specification

**Date**: 2026-09-24
**Session**: competitive-freshness
**Status**: Draft
**Repo**: `app-vitals/shipwright`

## Overview

A precheck + command pair, mirroring the existing `check-site-docs-freshness.ts` / `research-docs --auto` pattern, that periodically re-verifies the factual claims on the marketing site's competitive-comparison pages (`site/src/pages/vs/*.astro`, `site/src/pages/compare.astro`) against their cited external sources — catching drift like a competitor's pricing change, certification, or acquisition (the exact gap that let SpaceX's acquisition of Cursor go unnoticed on `/compare` for a month). Unlike the existing docs-freshness mechanism, which diffs this repo's own source against its own docs, this checks external, third-party facts that no git diff can ever surface.

## Problem Statement

`site/src/pages/vs/devin.astro` already carries a `verifiedDate` and a structured `src` object of cited URLs, and is genuinely well-maintained by hand (re-verified 2026-09-09). But nothing automates the re-verification — it happens only when someone remembers to do it manually. `compare.astro`'s per-tool rows have citations but no `verifiedDate` at all. Neither page type is covered by `site/docs-source-map.json` or the `shipwright-site-docs-freshness` cron, because that mechanism's entire design (anchor SHA + `getCommitsSince` against this repo's own git history) has no way to represent "an external company changed something" — there's no commit to diff against.

## Users & Context

- **The `shipwright-site-docs-freshness`-adjacent cron infrastructure**: gets a sibling precheck/command pair built the same way, for a different (external) staleness signal.
- **Whoever reviews the resulting PRs**: material factual changes (pricing, ownership, certification) go through a normal PR + review, not a silent auto-commit — these are public claims about competitors and deserve a second look, per `brand/MESSAGING.md`'s existing competitor-naming policy.

---

## Features

### Feature 1: `check-competitive-freshness.ts` precheck + `verifiedDate` on `compare.astro`

**Priority**: High
**Description**: A precheck script matching `check-site-docs-freshness.ts`'s exit 0/1 contract, but staleness-by-age instead of staleness-by-git-diff. Extend `compare.astro` to carry a `verifiedDate` per tool row (mirroring the `vs/*.astro` pattern) so both page types can be checked uniformly.

**Requirements**:
- Add a `verifiedDate` field to each tool entry in `site/src/pages/compare.astro`'s data array, seeded with today's date for entries not otherwise re-verified as part of this work (this spec does not require re-verifying every row — just adding the field so future runs have a baseline).
- `scripts/check-competitive-freshness.ts` (repo-root — this is App-Vitals-specific tooling, not part of the distributed `plugins/shipwright/` plugin): scans `site/src/pages/vs/*.astro` (parsing the `verifiedDate` const) and `compare.astro`'s per-tool `verifiedDate` fields. A page/row qualifies (is a candidate) when its `verifiedDate` is more than a configurable threshold old — default 30 days. Exit 0 with a summary listing qualifying pages/rows (page name, days since last verified) when at least one qualifies; exit 1 with no output when none do. Mirror `check-site-docs-freshness.ts`'s structure (injectable deps, one page's parse failure isolated and treated as qualifying, doesn't block others).

**Acceptance Criteria**:
- [ ] `compare.astro`'s tool entries each carry a `verifiedDate` field
- [ ] `check-competitive-freshness.ts` exits 0 and lists qualifying pages/rows when at least one is older than the threshold; exits 1 with no output when none are
- [ ] A page/row with an unparseable or missing `verifiedDate` is treated as qualifying (fail toward checking, not skipping)
- [ ] Test decision: unit test with injected fixture dates covering fresh, stale, missing, and unparseable cases — mirroring `check-site-docs-freshness.unit.test.ts`'s injected-dependency approach, no real filesystem/git I/O

**Source Map**:
- `plugins/shipwright/scripts/check-site-docs-freshness.ts` — pattern to mirror
- `plugins/shipwright/scripts/check-site-docs-freshness.unit.test.ts` — test pattern to mirror
- `site/src/pages/vs/devin.astro`, `vs/factory.astro`, `vs/openhands.astro` — existing `verifiedDate` pattern
- `site/src/pages/compare.astro` — gains `verifiedDate` per row

**Testing Strategy**: Layer: unit — injected fixture dates, no real I/O, matching the mirrored script's own test approach.

---

### Feature 2: `scripts/competitive-refresh-runbook.md` repo-local runbook

**Priority**: High
**Description**: A plain, repo-local markdown runbook (not a distributed `/shipwright:*` command) that a custom, non-system cron's plain-language prompt references directly, per `docs/extending.md`'s pattern for repo-specific scheduled automation. It re-verifies a flagged page's claims against its cited sources plus a general recent-news check for that competitor, and either bumps `verifiedDate` (no material change) or opens a PR with the update (material change) — never a silent direct-to-main edit for a material factual change. No `--auto`/interactive mode-switching and no `$ARGUMENTS` convention: this is a one-off, single-repo automation, not a reusable capability, so there's no companion plugin and no distinct invocation modes to switch between.

**Requirements**:
- `scripts/competitive-refresh-runbook.md` (repo-root, alongside `scripts/hitl.ts`/`scripts/dev-tmux.ts` — not under `plugins/shipwright/commands/`): plain-language instructions the cron's prompt points Claude at directly for every page/row the precheck flagged.
- For each page/row the precheck flagged: WebFetch every URL in the page's `src`/`citations` object and re-check the specific claim it supports (pricing figures, certification status, deployment model, etc.); additionally run one general web search along the lines of "{competitor} acquisition funding news {current year}" to catch structural changes (acquisitions, shutdowns, rebrands) that no single cited URL would reveal — this is the SpaceX/Cursor gap specifically: no existing citation URL would have surfaced that on its own.
- Read `brand/MESSAGING.md`'s competitor-naming policy (D10, cited in `vs/devin.astro`'s file header) before writing or editing any competitor claim — this runbook must respect the same policy human editors already follow.
- **No material change found**: bump `verifiedDate` to today, commit directly (matches `research-docs --auto`'s Step A5 pattern for low-risk internal updates — this is the equivalent low-risk case, since nothing in the visible claims actually changed).
- **Material change found** (pricing, certification, ownership/acquisition, deployment model, or any claim the page currently asserts that's now false): update the content and citations, but open a PR rather than committing to `main` directly — these are public claims about named competitors, lower-confidence than an internal git-diff-sourced update, and should go through the same review path as any other content change.
- Never fabricates a claim it can't source — if a competitor's current state is genuinely ambiguous or a source is unreachable, leave the existing claim and file a task-store task (same `/tasks/bulk` pattern `research-docs --auto` already uses) rather than guessing.

**Acceptance Criteria**:
- [ ] Running against a page whose cited sources return unchanged content bumps only `verifiedDate`, committed directly
- [ ] Running against a page where a cited source's content changed (e.g. a pricing figure) updates the specific claim, updates the citation if the source URL changed, and opens a PR instead of committing to `main`
- [ ] The general recent-news search step is present and documented as the mechanism that would have caught the SpaceX/Cursor gap — an acquisition isn't necessarily reflected on any single previously-cited URL
- [ ] `brand/MESSAGING.md`'s competitor-naming policy is read and cited as a constraint before any claim is written or edited
- [ ] An unreachable/ambiguous source results in a filed task-store task, not a fabricated claim or a silent skip
- [ ] Test decision: `scripts/competitive-refresh-runbook.md` is not a `plugins/shipwright/` command or skill file, so the usual command/skill-scoped `*.content.test.ts` convention doesn't strictly apply by that rule alone — but this repo has precedent for content tests on other non-command/skill markdown (`docs/agent-types.content.test.ts`), and CF-2.1 should follow that precedent: add `scripts/competitive-refresh-runbook.content.test.ts` asserting the runbook's required sections/instructions exist, plus unit tests for any pure logic split out (e.g. material-vs-cosmetic change classification, if implemented as a separate testable function)

**Technical Considerations**: This runbook depends on live web access (WebFetch/WebSearch) at run time — unlike `research-docs`, which is purely git-based and works fully offline. Runs must handle a fetch failure gracefully (treat as "couldn't verify," file a task, don't block the rest of the run) rather than erroring out the whole pass over one unreachable source.

**Source Map**:
- `plugins/shipwright/commands/research-docs.md` — task-filing pattern, and the material-vs-cosmetic commit/PR risk split to mirror (its `--auto`/interactive mode-switching itself does not apply here)
- `docs/extending.md` — the custom-cron / repo-local-runbook pattern this feature follows instead of a distributed command
- `brand/MESSAGING.md` — competitor-naming policy (D10) to respect
- `site/src/pages/vs/*.astro`, `site/src/pages/compare.astro` — pages this runbook edits

**Testing Strategy**: Layer: content — runbook-file prose assertions via `scripts/competitive-refresh-runbook.content.test.ts`, following the `docs/agent-types.content.test.ts` precedent for content tests on non-command/skill markdown; unit tests for any extracted pure logic.

---

## Technical Constraints

- Never auto-commit a material factual change about a named competitor directly to `main` — always a PR, per Feature 2.
- Must respect `brand/MESSAGING.md`'s existing competitor-naming policy, not invent a new one.
- The precheck (Feature 1) must stay pure/offline (date comparison only) — all external verification happens in the runbook (Feature 2), not the precheck, matching the existing precheck-is-cheap / command-does-the-work split used throughout this repo's patrol crons.

## Scope

**In Scope**:
- `verifiedDate` on `compare.astro` rows
- `check-competitive-freshness.ts` precheck
- `scripts/competitive-refresh-runbook.md` repo-local runbook

**Out of Scope**:
- Creating the actual cron on any specific agent — that's a config action (`POST /agents/:id/crons`) taken once this code is merged and deployed, not part of this PRD's build.
- Re-verifying every existing claim on every page as part of this work — Feature 1 seeds `verifiedDate` fields but doesn't mandate a full manual re-audit; that's what the new automated mechanism is for, going forward.
- Adding dedicated `vs/*.astro` pages for competitors that only appear in `compare.astro` today (e.g. a dedicated `vs/cursor.astro`) — out of scope, a content decision, not part of this freshness mechanism.

## Priorities & Sequence

Feature 1 must land before Feature 2 (the runbook depends on the precheck's data shape and the `verifiedDate` field existing on `compare.astro`). No other ordering constraints.

## Testing Strategy

| Feature | Layer | Rationale |
|---------|-------|-----------|
| Precheck + verifiedDate | unit | injected fixture dates, no real I/O |
| competitive-refresh-runbook.md | content | runbook-file prose assertions, following the `docs/agent-types.content.test.ts` precedent for non-command/skill markdown |

## Resolved Decisions

- **Material changes go through a PR, cosmetic changes (date bump only) commit directly.** — Rationale: mirrors `research-docs --auto`'s existing risk-tiered pattern (low-risk internal updates apply directly, riskier size-governance/quality-pass proposals go through a task/review gate) — external, third-party facts are lower-confidence than an internal git diff and deserve the same review a human editor's claim would get.
- **A general recent-news search, not just re-fetching cited URLs.** — Rationale: the SpaceX/Cursor gap specifically wasn't visible from any single previously-cited URL — an acquisition is exactly the kind of structural change that only a broader search catches, and it's the concrete case that motivated this whole PRD.
- **30-day default staleness threshold.** — Rationale: matches the cadence implied by `vs/devin.astro`'s own re-verification history (verified July 14, re-verified September 9 — roughly 8 weeks, but this is a fast-moving market per this session's own competitive-landscape research); 30 days is a reasonable default, easily adjusted later, not something to over-index on now.
- **Cron creation is a follow-up action, not part of this PRD.** — Rationale: the cron can't meaningfully exist until `scripts/competitive-refresh-runbook.md` exists for its prompt to reference; creating it is a one-line `POST /agents/:id/crons` call once this ships, not build work.

## Success Criteria

- `scripts/check-competitive-freshness.ts` correctly identifies stale pages/rows by age, mirroring the existing site-docs-freshness precheck's contract.
- The custom cron (once created, post-merge) can run unattended, re-verify a page's claims against live sources per `scripts/competitive-refresh-runbook.md`, and either bump `verifiedDate` or open a review-gated PR depending on materiality.
- The specific gap this session found (SpaceX/Cursor) would be caught by this mechanism going forward, via the general recent-news search step.
- `task ci` passes with no regression to the mirrored `check-site-docs-freshness` test suite.

## 2026-09-24 correction: not a plugin capability

Dan caught this after the spec was first written: this is App-Vitals-specific business content (hardcoded competitor names, dependency on `brand/MESSAGING.md`'s App-Vitals-specific competitor-naming policy) — not a generic, repo-agnostic capability any shipwright-plugin installer would want. It does not belong under `plugins/shipwright/` (which ships to every user who installs the plugin). Both tasks were still `pending` with no code written, so amended in place rather than rebuilt from scratch:

- **Feature 1**'s precheck moves from `plugins/shipwright/scripts/check-competitive-freshness.ts` to `scripts/check-competitive-freshness.ts` (repo-root — this repo's own tooling, matching the existing `scripts/hitl.ts`/`scripts/dev-tmux.ts` precedent, distinct from the distributed plugin's `plugins/shipwright/scripts/`). Its internal date-comparison *mechanism* still mirrors `check-site-docs-freshness.ts` — only its location changed.
- **Feature 2** is no longer a distributed `/shipwright:competitive-refresh` command with `$ARGUMENTS`-based auto/interactive mode-switching. It's `scripts/competitive-refresh-runbook.md` — a plain, repo-local markdown runbook a custom (non-system) cron's plain-language prompt references directly, per `docs/extending.md`'s pattern for repo-specific scheduled automation ("a nightly report, a weekly changelog sync, a custom compliance check — that doesn't belong in the shared shipwright plugin"). No new companion plugin either — this is a one-off, single-repo automation, not a reusable capability, so a companion plugin would be over-engineering for what it's solving.
- Every acceptance criterion carries over unchanged in substance (re-fetch cited sources, general recent-news search, `brand/MESSAGING.md` read first, commit-vs-PR risk split, unreachable-source fallback) — only the *location* and *distribution model* changed, not the behavior.
