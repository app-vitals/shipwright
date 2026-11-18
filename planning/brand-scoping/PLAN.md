# Plan: brand-scoping

**Session:** `brand-scoping` · **Repos:** `app-vitals/shipwright`, `app-vitals/agent`
**Spec:** `planning/brand-scoping/PRODUCT-SPEC.md`

## Technical Design

No DB/API/Views layers apply — this is file relocation and build config, not application logic.

**Relocation (shipwright):** `brand/` moves to `site/brand/` with no content changes. Every consumer's path updates: `.claude/skills/shipwright-brand/SKILL.md` (6 prose path references), `.gitignore` (`brand/out/` → `site/brand/out/`), `site/package.json`'s `brand-lint` script (`bun ../brand/brand-lint.ts` → `bun brand/brand-lint.ts`, sibling becomes child), and `bunfig.toml`'s test exclusion (`"**/site/**"` → `"**/site/**/*.spec.ts"` — narrowed so `site/brand/*.unit.test.ts` keeps running under root `bun test`; the original blanket exclusion exists only to stop Bun running Playwright's `*.spec.ts` files, and would otherwise silently drop the three existing brand unit tests from `task ci`). `brand/admin-theme-tokens.unit.test.ts`'s own `./tokens.json` import needs no change (relative, resolves wherever the file lands). `site/src/styles/brand.css` is already a manually-copied generated artifact (not symlinked) — its copy-source comment path updates, the manual-copy workflow is unaffected.

**New accurate token files:** `shipwright/brand/tokens.json` (reclaims the vacated path) describes the metrics dashboard's real palette — `color` (+`font`) only, values from `agent/lib/web/toolbar.ts`'s shared base plus `metrics/src/dashboard/styles.css`'s own state colors. `agent/admin/src/brand-tokens.json` (new file, inside the already-published `agent-admin` package, separate from the existing PWA-only `theme-tokens.json`) describes the admin UI's real palette — same schema, values from the shared base plus admin's richer status/badge set (`admin-ui-styles.ts`/`admin-ui-pages.ts`). Both exist purely for `ux`-plugin brand-comparison and internal-consistency checking, not collateral generation.

**Drift guard:** a new unit test in `shipwright/brand/`, mirroring the existing `admin-theme-tokens.unit.test.ts` pattern, imports `@app-vitals/agent-admin`'s new `brand-tokens.json` export and compares shared-base leaves against shipwright's own `brand/tokens.json`. Gated by a RELEASE GATE task on `@app-vitals/agent-admin`'s next published version, since the export doesn't exist in the pinned `1.68.0`.

## Tasks

| Task | Title | Repo | Layer | Deps | Branch | Hrs |
|---|---|---|---|---|---|---|
| BRD-1.1 | chore: relocate brand/ to site/brand/ and fix consumer paths | app-vitals/shipwright | Shared | — | `feat/brd-relocate-brand` | 2 |
| BRD-1.2 | feat: add shipwright/brand/tokens.json for the dashboard's real palette | app-vitals/shipwright | Shared | BRD-1.1 | `feat/brd-relocate-brand` | 1 |
| BRD-2.1 | feat: add admin/src/brand-tokens.json for the admin UI's real palette | app-vitals/agent | Shared | — | `feat/brd-admin-brand-tokens` | 2 |
| BRD-2.2 | chore: wait for @app-vitals/agent-admin > 1.68.0 in shipwright | app-vitals/shipwright | Shared | BRD-2.1 | `feat/brd-admin-brand-gate` | 0.5 |
| BRD-3.1 | test: add drift guard between shipwright and admin brand tokens | app-vitals/shipwright | Shared | BRD-1.2, BRD-2.2 | `feat/brd-drift-guard` | 1 |

```
[START]
  ├─ BRD-1.1: relocate brand/ (no deps)
  │     └─ BRD-1.2: new shipwright tokens.json (needs 1.1, same branch)
  ├─ BRD-2.1: new admin brand-tokens.json (no deps)
  │     └─ BRD-2.2: release gate (needs 2.1 deployed)
  │           └─ BRD-3.1: drift guard (needs 1.2 + 2.2)
```

| Task | Depends on | Blocks |
|---|---|---|
| BRD-1.1 | — | BRD-1.2 |
| BRD-1.2 | BRD-1.1 | BRD-3.1 |
| BRD-2.1 | — | BRD-2.2 |
| BRD-2.2 | BRD-2.1 | BRD-3.1 |
| BRD-3.1 | BRD-1.2, BRD-2.2 | — |

## Breaking Change Safety

- **BRD-1.1 + BRD-1.2** (bundled, same branch): a path move + recreate at the same final path in one PR — no external consumer sees an intermediate state where `shipwright/brand/tokens.json` is missing. Safe to deploy standalone: yes.
- **BRD-2.1**: additive-only — new file, new export entry, no removals or renames of existing `@app-vitals/agent-admin` contract. Safe to deploy standalone: yes.
- **BRD-2.2 / BRD-3.1**: explicit sequencing for the one real cross-repo dependency (shipwright's drift test needs the new export published and pinned before it can import it).

## Decision Log

Carried from the PRD session (`planning/brand-scoping/PRODUCT-SPEC.md`, Resolved Decisions):
- PWA-manifest brand source stays on the relocated dark/green brand — no task required, zero code change.
- Token schema scope is `color` (+`font`) only for both new files.
- Admin's new file lives at `agent/admin/src/brand-tokens.json` (inside `agent-admin`, not `agent-lib`), kept separate from the existing `theme-tokens.json`.
- The drift test lives in shipwright, importing agent's published export — mirrors the existing `admin-theme-tokens.unit.test.ts` pattern.

Added during this planning pass:
- `bunfig.toml`'s test exclusion narrows from `"**/site/**"` to `"**/site/**/*.spec.ts"` so the relocation doesn't silently drop three existing unit tests from `task ci` — confirmed via `site/package.json`'s own `test` script (`playwright test`) not covering `*.unit.test.ts` either.
- BRD-1.1 is flagged `hitl: true` because `.claude/skills/shipwright-brand/SKILL.md` is one of the files needing a path update, and the Claude Code CLI blocks agent writes under `.claude/**` unconditionally — not a Shipwright permission setting. Everything else in BRD-1.1's diff is normal agent work; only that one file needs a human hand.
