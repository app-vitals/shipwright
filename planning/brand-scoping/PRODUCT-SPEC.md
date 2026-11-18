<!-- shipwright: session=brand-scoping repos=app-vitals/shipwright,app-vitals/agent spec=0001 -->
# Brand Token Scoping — Product Specification

**Date**: 2026-11-18
**Session**: brand-scoping
**Repos**: app-vitals/shipwright, app-vitals/agent
**Status**: Draft

## Overview

`shipwright/brand/tokens.json` (dark navy + green) is labeled the single source of truth for "Shipwright Harness" but is unrelated to either live app surface it could get compared against. This session relocates that file to where it's actually true (the marketing site), and adds two new, accurate token files so the planned `ux` plugin's directory-based brand auto-detection reflects reality instead of silently mismatching.

## Problem Statement

`shipwright/brand/tokens.json` is auto-detected by the `ux` plugin's `./brand/` resolution whenever a command runs from the shipwright repo root — which is the expected habit for evaluating the metrics dashboard, since that dashboard's code lives inside the shipwright repo. But the dashboard (`metrics/src/dashboard/styles.css`) and the admin UI (`agent/admin/src/admin-ui-styles.ts`) are both a separate white/light theme, sharing a common base via `agent/lib/web/toolbar.ts`, with no relationship to the dark/green brand file. Comparing the real white UI against the wrong dark brand would generate findings that push toward a redesign nobody wants. The dark brand file is still legitimately needed elsewhere (PWA manifest chrome, marketing collateral) — so the fix is to scope it correctly, not remove it.

## Users & Context

Primary users are App Vitals engineers (and any Shipwright agent running autonomously) using `/ux:evaluate`/`/explore`/`/apply` against live Shipwright surfaces (the metrics dashboard, the admin UI), who need brand-comparison findings that reflect what's actually rendered. Secondary users are existing consumers of `shipwright/brand/tokens.json` for marketing/collateral purposes (the `shipwright-brand` skill, `build-brand-css.ts`, the PWA manifest) — they need that file to keep working exactly as today, just correctly scoped.

---

## Features

### Feature 1: Relocate the existing dark brand under `shipwright/site/`

**Priority**: High
**Description**: Move `shipwright/brand/` to `shipwright/site/brand/` with no content changes, and re-point every current consumer's import path.

**User Stories**:
- As an engineer, I want the dark/green brand file to live where it's actually true (the marketing site) so it stops being auto-detected against unrelated surfaces.

**Requirements**:
- Move the entire `shipwright/brand/` directory wholesale to `shipwright/site/brand/` — `tokens.json`, `BRAND.md`, `MESSAGING.md`, `brand.css`, `brand-lint.ts`, `build-brand-css.ts`, their unit tests, `admin-theme-tokens.unit.test.ts`, `assets/` (og, videos) and `templates/`. Nothing is left behind except Feature 3's new `brand/tokens.json`.
- Update every reference to the old path, including prose/comment references (`CLAUDE.md`, `docs/architecture.md`, `scripts/competitive-refresh-runbook.md`, `demo/brand-overlay.sh`, `site/tailwind.config.mjs`, `site/README.md`, and `brand/MESSAGING.md` comment references in `site/src/`); verified by a `git grep -n 'brand/'` sweep.
- Re-point `admin-theme-tokens.unit.test.ts`'s import of `./tokens.json` to the new path; it keeps comparing against the dark brand per Feature 2's decision.
- Re-point the `shipwright-brand` skill's path resolution to the new location.
- No value changes — verified by diffing file content before/after the move.

**Acceptance Criteria**:
- [ ] The old `shipwright/brand/` contents no longer exist at repo root (only Feature 3's new `tokens.json` occupies `brand/` afterward)
- [ ] `git grep -n 'brand/'` shows no stale references to the old location
- [ ] `shipwright/site/brand/tokens.json` has byte-identical `color`/`font`/`type`/`gradient`/`glow`/`layout`/`links` values to the pre-move file
- [ ] `bun test` passes in `shipwright/site/` and `shipwright/brand/admin-theme-tokens.unit.test.ts` (at its new path) still passes

**Technical Considerations**: `@app-vitals/agent-admin`'s published package still points at the old shipwright path conceptually (it's a hand-copied subset, not a live import, so no republish is required for this feature alone — only Feature 4/5's new export needs a publish).

**Source Map**:
- `app-vitals/shipwright`: all of `brand/` (`tokens.json`, `BRAND.md`, `MESSAGING.md`, `brand.css`, `brand-lint.ts`, `build-brand-css.ts`, the three `*.unit.test.ts` files, `assets/`, `templates/`) — relocate to `site/brand/`
- `app-vitals/shipwright`: prose/comment consumers listed under Requirements — update path wording
- `app-vitals/shipwright`: `plugins/shipwright/` (shipwright-brand skill) — update path resolution

**Testing Strategy**: Layer: unit — pure path/content move, existing unit tests re-run at new location with no logic change beyond one relative-path fix (`build-brand-css.unit.test.ts` reads `../demo/slides/close.html`, which becomes `../../demo/slides/close.html`).

---

### Feature 2: Resolve the PWA-manifest brand source

**Priority**: Medium
**Description**: Decide, and record, whether the admin UI's installed-PWA chrome (`theme_color`/`background_color`) keeps using the relocated dark/green brand.

**User Stories**:
- As the owner, I want install-moment branding (splash screen, tab tint) to stay recognizably "Shipwright" even though in-page content doesn't use that palette.

**Requirements**:
- No code change beyond what Feature 1 already does (re-pointing the import path) — `agent/admin/src/theme-tokens.json` and `pwa.ts` keep sourcing from the dark/green brand at its new relocated path.

**Acceptance Criteria**:
- [ ] `agent/admin/src/pwa.unit.test.ts` passes unchanged after Feature 1's path update propagates through the published `@app-vitals/agent-admin` package

**Source Map**:
- `app-vitals/agent`: `admin/src/theme-tokens.json`, `admin/src/pwa.ts`, `admin/src/pwa.unit.test.ts` — no content change, decision only

**Testing Strategy**: Layer: unit — existing `pwa.unit.test.ts` is the coverage; no new tests needed.

---

### Feature 3: New `shipwright/brand/tokens.json` (dashboard's real palette)

**Priority**: High
**Description**: A new, accurate tokens file at the path Feature 1 vacates, describing the metrics dashboard's actual current palette.

**User Stories**:
- As an engineer running `/ux:evaluate` against `/dashboard` from the shipwright repo root, I want brand-comparison findings based on the dashboard's real colors, not a mismatched brand.

**Requirements**:
- `color` (+`font`) only — no `gradient`/`glow`/`type`/`layout`/`links`/`tagline`, since this file isn't used for collateral generation.
- Values sourced from `agent/lib/web/toolbar.ts` (shared base) + `metrics/src/dashboard/styles.css` (dashboard-specific state colors): `bg.base #f7f7fb`, `surface #ffffff`, `text #1a1a2e`, `accent #4f46e5`, borders `#e8e8ee`/`#d1d5db`, muted text `#6b7280`/`#9ca3af`, state colors `#15803d`/`#d97706`/`#b91c1c`/`#3b82f6`/`#8b5cf6`.

**Acceptance Criteria**:
- [ ] `shipwright/brand/tokens.json` exists with `color` values matching every custom property in `metrics/src/dashboard/styles.css`'s `:root` block
- [ ] Running `/ux:evaluate http://localhost:<port>/dashboard` from the shipwright repo root on an unmodified page produces zero off-palette brand findings
- [ ] A unit test asserts the file is valid JSON matching the agreed color-only schema

**Technical Considerations**: No changes to the dashboard itself — documentation of existing reality only.

**Source Map**:
- `app-vitals/shipwright`: `brand/tokens.json` (new), `metrics/src/dashboard/styles.css` (reference, unmodified)
- `app-vitals/agent`: `lib/web/toolbar.ts` (reference, unmodified)

**Testing Strategy**: Layer: unit — static JSON content check, no I/O.

---

### Feature 4: New `agent/admin/src/brand-tokens.json` (admin UI's real palette)

**Priority**: High
**Description**: A new tokens file inside the already-published `agent-admin` package, describing the admin UI's actual current palette, so `agent` repo evaluations get a real brand-comparison reference instead of silently skipping brand comparison. Kept separate from the existing `theme-tokens.json` (which stays PWA-chrome-only, per Feature 2) rather than conflating two different palettes in one file.

**User Stories**:
- As an engineer running `/ux:evaluate` against an admin page from the agent repo root, I want brand-comparison findings based on the admin UI's real colors.

**Requirements**:
- Lives at `agent/admin/src/brand-tokens.json` — inside the `agent-admin` package boundary, alongside the existing `theme-tokens.json` precedent, not a new package.
- Exported from `@app-vitals/agent-admin`'s `exports` map with an explicit literal entry (mirroring the existing `"./theme-tokens.json": "./src/theme-tokens.json"` entry — the package's `"./*": "./src/*.ts"` wildcard only covers `.ts` files).
- `color` (+`font`) only, same schema as Feature 3.
- Values sourced from `toolbar.ts`'s shared base plus admin's richer status/badge set from `admin-ui-styles.ts`/`admin-ui-pages.ts` (success/warning/danger/info/violet/teal families).

**Acceptance Criteria**:
- [ ] `agent/admin/src/brand-tokens.json` exists, exported via `@app-vitals/agent-admin`'s `package.json` `exports` map
- [ ] Running `/ux:evaluate` against an admin page from the agent repo root produces a brand-comparison section (not the "no brand" internal-consistency fallback)
- [ ] A unit test asserts the file is valid JSON matching the agreed color-only schema

**Source Map**:
- `app-vitals/agent`: `admin/src/brand-tokens.json` (new), `admin/package.json` (add export entry), `lib/web/toolbar.ts` (reference), `admin/src/admin-ui-styles.ts`, `admin/src/admin-ui-pages.ts` (reference, unmodified)

**Testing Strategy**: Layer: unit — static JSON content check, no I/O.

---

### Feature 5: Drift guard between the two new token files

**Priority**: Medium
**Description**: A unit test ensuring the shared-base values in Feature 3's and Feature 4's files (and `toolbar.ts` itself) never silently diverge.

**User Stories**:
- As an engineer, I want a future edit to one app's token file to fail CI if it drifts from the other, since both derive from the same shared base.

**Requirements**:
- Lives in `shipwright` (mirrors the existing `admin-theme-tokens.unit.test.ts` pattern, which already reads an `agent`-published package from shipwright).
- Imports `@app-vitals/agent-admin`'s new `brand-tokens.json` export and compares its shared-base leaves against shipwright's own local `brand/tokens.json` (Feature 3's file) — the exact same import pattern the existing `admin-theme-tokens.unit.test.ts` already uses, just a second instance pointed at the new export.
- Depends on Feature 3 and Feature 4 both existing, and on shipwright's `@app-vitals/agent-admin` dependency being bumped to the first published version whose `exports` map contains `./brand-tokens.json` (verified against the published package, not a hard-coded version number).

**Acceptance Criteria**:
- [ ] A new unit test in `shipwright/brand/` fails if the shared-base color values disagree between the two new files
- [ ] `bun test` is green in shipwright only after the `@app-vitals/agent-admin` dependency bump lands — sequencing is explicit in the task, not assumed

**Source Map**:
- `app-vitals/shipwright`: `brand/` (new drift test file), `package.json` (bump `@app-vitals/agent-admin` dependency)

**Testing Strategy**: Layer: unit — pure data comparison, no I/O.

---

## Technical Constraints

- Both repos are separate — all work goes through worktrees + PRs, no direct main commits; each repo's own `bun test`/`biome`/typecheck must stay green throughout.
- `shipwright` is a public repo — no client/org/agent names beyond what's already public.
- Feature 1's relocation must not change any `tokens.json` value — pure path move, verified by content diff.
- `@app-vitals/agent-admin` is published via semantic-release on merge to `agent`'s main — Feature 4's new export only becomes consumable by shipwright once that publish happens and shipwright's own dependency is bumped; Feature 5 is explicitly sequenced after that.
- No changes to the actual rendered output of the dashboard or admin UI in this session — Features 3/4 document existing reality, they don't restyle anything.

## Scope

**In Scope**:
- Relocating the existing dark brand file and re-pointing its consumers
- Two new, accurate token files (color+font only) for the dashboard and admin UI
- A drift guard between the two new files

**Out of Scope**:
- Actually restyling the dashboard or admin UI
- The `ux` plugin itself (`UXP-*` tasks) — this session only fixes what it will read
- App Vitals' own brand token file (`feat/brand-system` branch, `goals` repo)
- The marketing site's `global.css` (Tailwind-based, not a `tokens.json` consumer)
- Deciding whether the dashboard and admin UI should ever be visually unified

## Priorities & Sequence

1. Feature 1 (relocate) and Feature 3 (new shipwright file) together — Feature 3 reclaims the path Feature 1 vacates; sequencing them in the same window avoids a gap where `shipwright/brand/tokens.json` doesn't exist.
2. Feature 2 is a decision folded into Feature 1's scope, not separately sequenced.
3. Feature 4 can run independently/in parallel with 1+3 — no path collision.
4. Feature 5 last — depends on Feature 3 and Feature 4 both existing, and on the `@app-vitals/agent-admin` publish/dependency-bump cycle completing.

## Testing Strategy

| Feature | Layer | Rationale |
|---------|-------|-----------|
| Feature 1: Relocate dark brand | unit | Pure path/content move; existing unit tests re-run at new location; only `build-brand-css.unit.test.ts`'s `../demo/slides/close.html` path needs a one-line fix |
| Feature 2: PWA-manifest source decision | unit | Existing `pwa.unit.test.ts` is sufficient coverage; no new logic |
| Feature 3: New shipwright tokens.json | unit | Static JSON content check against live CSS, no I/O |
| Feature 4: New agent/admin/src/brand-tokens.json | unit | Static JSON content check against live styles, no I/O |
| Feature 5: Drift guard | unit | Pure data comparison between two JSON files, no I/O |

## Resolved Decisions

- **PWA-manifest brand source**: Stays on the relocated dark/green brand. — Rationale: install-moment chrome (splash, tab tint) is legitimate product branding, separate from in-page content; no need to change it to fix the original auto-detection risk.
- **Token schema scope**: `color` (+`font`) only for both new files — no `gradient`/`glow`/`type`/`layout`/`links`/`tagline`. — Rationale: these files exist for internal-consistency/ux-plugin comparison, not collateral generation; the existing admin subset precedent is also color-only.
- **Admin's new token file location**: `agent/admin/src/brand-tokens.json`, exported via `@app-vitals/agent-admin`, kept separate from the existing `theme-tokens.json`. — Rationale: the content is specifically admin's own rendered palette (sourced from `admin-ui-styles.ts`/`admin-ui-pages.ts`), not a reusable cross-package utility like `toolbar.ts` — so it belongs with the package that owns and already publishes admin-specific token data (`theme-tokens.json` is the existing precedent), not `agent-lib`. Kept as a separate file rather than expanding `theme-tokens.json` so the PWA-chrome palette (dark/green, Feature 2) and the page-content palette (white/light, Feature 4) don't get conflated in one schema.
- **Feature 5's test location and import direction**: Lives in `shipwright`, importing `agent`'s new export — mirrors the existing `admin-theme-tokens.unit.test.ts` pattern, which already reads an `agent`-published package from shipwright.

## Success Criteria

- The old `shipwright/brand/` contents no longer exist at repo root; they're at `shipwright/site/brand/` with identical content, and every prior consumer still works with its path updated (including the one relative `../demo/slides/close.html` path in `build-brand-css.unit.test.ts`).
- `shipwright/brand/tokens.json` exists at the repo root with `color`(+`font`) values matching the live metrics dashboard exactly.
- `agent/admin/src/brand-tokens.json` exists, exported via `@app-vitals/agent-admin`, with values matching the live admin UI exactly.
- A drift test fails if the shared-base values between the two new files and `toolbar.ts` disagree.
- Running `/ux:evaluate` against `/dashboard` from the shipwright repo root, on an unmodified page, produces zero spurious brand-category findings.
- All existing tests (`bun test` in both repos) stay green throughout, with the `agent-admin` version bump sequenced so the pre-existing drift test doesn't go red mid-migration.
