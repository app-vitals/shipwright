# Plan Session: biome-v2-upgrade

Repo: `app-vitals/shipwright`

## Background

Renovate opened PR #3389 (`@biomejs/biome` `^1.9.4` → `^2.0.0`) and it's been stuck: CI
fails outright because `biome.json` is still written in the v1 config schema and the v2
CLI rejects it (`organizeImports`, `linter.rules.recommended`, `files.ignore` are all
deprecated/renamed in v2). `/shipwright:patch` correctly refused to auto-fix this twice —
a config-schema migration is outside `dependency-patch.md`'s bounded remediation catalog
(transitive-dependency pins and first-party call-site updates only), so it was left as a
hold requiring deliberate human execution rather than a silent auto-fix. This mirrors the
`vitals-os-prisma-7-upgrade` precedent: a major-version bump that needs real migration
work gets a plan session, not a bot-driven bump.

## Design

Explored the actual migration in a scratch worktree (installed `@biomejs/biome@2.5.13`,
ran `bunx @biomejs/biome migrate --write`, then `bunx biome lint . --max-diagnostics=1000`
against the whole monorepo) rather than guessing at scope. Findings:

- The config migration itself is mechanical and low-risk — `biome migrate --write`
  regenerates `biome.json` cleanly (`organizeImports` → `assist.actions.source`,
  `linter.rules.recommended` → `linter.rules.preset`, `files.ignore` → `files.includes`
  with negation globs). No workspace has its own `biome.json` override to reconcile.
- Once the config parses, only **12 diagnostics are error-severity** (the rest are
  warnings/infos that don't fail `bunx biome lint .`'s exit code, which is what
  `task lint`/CI actually gates on): 1 `noUnsafeOptionalChaining`, 3 `noSvgWithoutTitle`
  (brand logo SVGs missing a `<title>`), 2 `useSemanticElements` (metrics dashboard HTML),
  6 `noInnerDeclarations` (all in one non-shipped demo HTML reference file). All are
  contained, single-purpose fixes with no cross-file blast radius.
- `noDelete` dropped out of v2's `recommended` rule set. The 121 existing
  `// biome-ignore lint/performance/noDelete: ...` suppression comments (mostly guarding
  `delete process.env.X` in tests) are now dead and flagged `suppressions/unused` — noise
  that should be cleaned up in the same pass since it's the same config-driven change that
  orphaned them.
- The remaining ~320 warnings (`noUnusedVariables`, `noUnusedFunctionParameters`,
  `noUnusedImports`, `useArrowFunction`, `useTemplate`, `noTemplateCurlyInString`, a
  handful of others) come from v2's `recommended` preset picking up rules that weren't in
  v1.9.4's — they don't block CI and span hundreds of files. Deliberately **not** bundled
  into the unblocking task: that diff would be large, mostly mechanical, and unrelated to
  what's actually gating #3389. Split into their own follow-up tasks instead so the
  CI-unblocking PR stays small and reviewable.

**No breaking changes.** This is a dev-tooling/lint-config change only — no DB, API, or
deploy-pipeline surface touched. Safe to deploy standalone for every task below.

**Test decision (applies to all three tasks):** none of this touches business logic, so
no new tests are added. The existing suite (`task ci`'s typecheck/test steps, untouched by
lint-config or lint-fix changes) is the regression signal — each task's acceptance
criteria requires `task ci` to stay green, which is the correct verification for a
tooling-config change per the architecture/testing principles (no production logic is
being added or changed).

## Tasks

### BV2-1.1 — Migrate biome.json to v2 schema and fix CI-blocking errors

**Description:** Run `bunx @biomejs/biome migrate --write` to bring `biome.json` onto the
v2 schema, bump `@biomejs/biome` from `^1.9.4` to `^2.0.0` in the root `package.json` (and
`bun.lock`), fix the 12 error-severity lint diagnostics that block `task lint`, and remove
the now-dead `biome-ignore lint/performance/noDelete` suppression comments flagged
`suppressions/unused`. This is what unblocks CI and lets PR #3389 be closed out.

**Acceptance Criteria:**
- `biome.json` matches the v2 schema (produced via `biome migrate --write`, not hand-edited)
- `@biomejs/biome` is `^2.0.0` in `package.json`, `bun.lock` regenerated
- All 12 CI-blocking errors fixed: `noUnsafeOptionalChaining` in
  `agent/src/slack-progress.unit.test.ts`; `noSvgWithoutTitle` in
  `assets/logo/shipwright-icon-named.svg`, `assets/logo/shipwright-icon.svg`,
  `site/public/shipwright-icon.svg` (add a `<title>`); `useSemanticElements` (x2) in
  `metrics/src/dashboard/index.html`; `noInnerDeclarations` (x6) in
  `plugins/shipwright/references/metrics-dashboard-demo.html`
- All 121 dead `biome-ignore lint/performance/noDelete` comments removed
- `task lint` and `task ci` pass locally
- **Test decision:** no new tests — pure lint/tooling-config fix, no production logic
  changed; `task ci`'s existing typecheck/test steps are the regression guard

**Dependencies:** none
**Branch:** `feat/bv2-1-1-migrate-biome-v2`
**Layer:** Shared
**Hours:** 3
**Complexity:** 3
**Model:** sonnet
**HITL:** none
**Safe to deploy standalone:** yes

### BV2-2.1 — Auto-fix mechanical v2 lint warnings

**Description:** Fix the mechanical, non-blocking warnings that v2's wider `recommended`
preset surfaced: `noUnusedVariables`, `noUnusedFunctionParameters`, `noUnusedImports`,
`useArrowFunction`, `useTemplate` (~314 occurrences across the repo). Use biome's own
fixer as a starting point but review every unsafe-fix hunk before committing — arrow-
function conversion can change `this`/`arguments` binding, and removing an unused
parameter can break a callback signature a caller depends on positionally.

**Acceptance Criteria:**
- `bunx biome lint --write` (safe fixes) applied first; remaining occurrences requiring
  `--unsafe` reviewed individually before applying
- Zero regressions: `task ci` (typecheck + full test suite) passes after the fixes
- No behavior change in any reviewed unsafe-fix hunk (arrow-function conversions checked
  for `this`/`arguments` usage; unused-parameter removals checked against call sites)
- **Test decision:** no new tests — mechanical style/dead-code cleanup with no logic
  change; the existing suite passing unmodified is the correct verification

**Dependencies:** BV2-1.1
**Branch:** `feat/bv2-2-1-autofix-mechanical-warnings`
**Layer:** Shared
**Hours:** 4
**Complexity:** 3
**Model:** sonnet
**HITL:** none
**Safe to deploy standalone:** yes

### BV2-2.2 — Review noTemplateCurlyInString warnings for real bugs

**Description:** v2 flags 37 occurrences of `${...}`-looking syntax inside a regular
(non-template) string literal. Most are likely intentional (shell/YAML/HTML content
embedded as a string), but this rule exists because the pattern is a common symptom of a
forgotten backtick — a string that was supposed to be a template literal. Review each one
individually rather than mass-suppressing.

**Acceptance Criteria:**
- All 37 flagged occurrences reviewed
- Any genuine bug (a string that should be a template literal, evidenced by the
  interpolation never actually happening at runtime) is fixed and gets a regression test
  covering the previously-broken interpolation
- Every remaining occurrence confirmed as an intentional literal gets a `biome-ignore`
  comment naming why (e.g. "literal shell placeholder, not JS interpolation") so the next
  scan doesn't have to re-review it from scratch
- `task ci` passes
- **Test decision:** a unit test is added only where a fix changes runtime behavior (a
  genuine bug); confirmed false positives need no test — they're annotated in place with
  the reasoning instead

**Dependencies:** BV2-1.1
**Branch:** `feat/bv2-2-2-review-template-curly-warnings`
**Layer:** Shared
**Hours:** 2
**Complexity:** 3
**Model:** sonnet
**HITL:** none
**Safe to deploy standalone:** yes

## Dependency Map

```
[START]
  └─ BV2-1.1: Migrate biome.json to v2 schema and fix CI-blocking errors (no deps)
        ├─ BV2-2.1: Auto-fix mechanical v2 lint warnings (needs 1.1)
        └─ BV2-2.2: Review noTemplateCurlyInString warnings for real bugs (needs 1.1)
```

| Task    | Depends on | Blocks   | HITL |
|---------|-----------|----------|------|
| BV2-1.1 | —         | 2.1, 2.2 |      |
| BV2-2.1 | 1.1       | —        |      |
| BV2-2.2 | 1.1       | —        |      |

## HITL Scan

No tasks match the keyword heuristic or judgment step — no infra, secrets, or
console-driven steps involved. `HITL scan: no tasks require human steps`.

## Follow-up

Once BV2-1.1 merges, close out Renovate PR #3389 (or let Renovate auto-close it once it
sees `package.json` already at `^2.0.0`).
