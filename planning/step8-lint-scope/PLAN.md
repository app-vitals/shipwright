# Plan: step8-lint-scope

## Problem

`dev-task.md`'s Step 8 ("Pre-Ship Checks") runs the toolchain cache's `lint`/`validate`
command verbatim on every run, with no mechanism to scope it to the files or packages
actually touched by the diff. On a monorepo, the cached command is typically a root-level,
repo-wide script (e.g. a Turborepo `lint` pipeline that fans out to every workspace). This
is asymmetric with the Coverage Gate section of the same step, which already scopes
explicitly to "packages that have changed files on this branch"
(`dev-task.md:747-777`) — Build & Lint (`dev-task.md:779-781`) has no equivalent scoping.

Concretely observed on a large monorepo: the toolchain cache held `"lint": "npm run lint"`
(a Turborepo pipeline script), so every dev-task's pre-ship check relinted the entire
codebase regardless of diff size — and it already caused at least one unrelated pre-ship
failure (a flaky sandbox worker-thread timeout in an unrelated package, unrelated to the
actual change).

`patch.md` has the identical pattern at three separate call-sites (CI-fix flow, review-fix
flow, conflict-resolution flow — `patch.md:643-649`, `860-866`, `1549-1555`), pulling the
same cached `lint` field verbatim. Patch diffs are typically even smaller than dev-task
diffs, so the unscoped-relint cost is proportionally worse there.

This system is markdown-only — there is no TypeScript/code implementation of toolchain
detection or lint execution; `dev-task.md`, `patch.md`, and `toolchain-patterns.md` are
prompt instructions the agent follows directly. "Implementation" here means writing
correct, tested prompt content — the repo already has `*.content.test.ts` files
(`dev-task.content.test.ts`, `patch.content.test.ts`) that assert on the Markdown body of
these commands for exactly this reason.

## Design

Add an optional `lintScoped` field to the `state/toolchain-cache/{repo}.json` schema
documented in `toolchain-patterns.md`. It is populated only when the detected toolchain
supports native diff/package-scoped linting:

- **Turborepo** (`turbo.json` present): `turbo lint --filter=...[{base}...{head}]`
- **Nx** (`nx.json` present): `nx affected --target=lint --base={base}`
- **pnpm workspaces** (`pnpm-workspace.yaml` present): `pnpm --filter "...[{base}]" lint`
- **No monorepo tool detected** (generic Node.js/eslint): `eslint {changed files}` —
  scoped to the git-diff-changed lintable files
- **No ecosystem match**: `lintScoped` is omitted entirely (not set to `null`), so
  consumers can detect absence with a simple existence check and fall back to the
  existing unscoped `lint`/`validate` command — unchanged behavior for every repo that
  doesn't populate it.

Both consumers — `dev-task.md` Step 8 and `patch.md`'s three lint-command sites — are
wired to prefer `lintScoped` when present, reusing whatever `{base}`/`{head}` values each
site already computes for diffing (no new diff-computation logic introduced).

## Decision Log

- Scoped-lint detection covers Turborepo, Nx, pnpm workspaces, and a generic eslint
  changed-files fallback — chosen as the highest-value/most common Node.js monorepo
  tooling; other ecosystems (Rust/Go/Python/Java) are out of scope for this pass since the
  observed problem and existing examples in `toolchain-patterns.md` are Node.js-specific.
  Can be extended later if a non-Node ecosystem hits the same issue.
- `patch.md`'s three lint-command sites are included in scope alongside `dev-task.md`,
  even though the originating report was dev-task-specific — confirmed with Dan McAulay
  in Slack, since the root-cause fix lives in the shared `toolchain-patterns.md` cache
  schema and leaving patch unfixed would leave the identical bug in place there.

## Tasks

| Task | Depends on | Blocks | HITL |
|------|-----------|--------|------|
| LSC-1.1 — Add scoped-lint detection to toolchain-patterns.md | — | 1.2, 1.3 | |
| LSC-1.2 — Wire dev-task.md Step 8 to use scoped lint | 1.1 | — | |
| LSC-1.3 — Wire patch.md's lint sites to use scoped lint | 1.1 | — | |

### LSC-1.1 — Add scoped-lint detection to toolchain-patterns.md

**Layer:** Shared · **Branch:** `feat/lsc-1-1-toolchain-scoped-lint` · **Hours:** 3 ·
**Complexity:** 3 · **Model:** sonnet

Add the `lintScoped` field to the toolchain-cache JSON schema in the "Caching Across Runs"
section, and per-ecosystem detection rules (Turborepo, Nx, pnpm workspaces, generic eslint
fallback) to the Node.js section of `toolchain-patterns.md`.

Acceptance criteria:
- `lintScoped` documented as an optional cache field, with a one-line note on when it's
  populated vs. omitted (never set to `null` — omitted means "no scoped command available").
- Detection rules added for: Turborepo (`turbo lint --filter=...[{base}...{head}]`), Nx
  (`nx affected --target=lint --base={base}`), pnpm workspaces
  (`pnpm --filter "...[{base}]" lint`), and a generic eslint changed-files fallback for
  projects with no monorepo tool.
- Test decision: extend the existing `toolchain-patterns.md`-content describe blocks in
  `dev-task.content.test.ts` (or add a new co-located describe block) asserting the doc
  contains the `lintScoped` field name, the Turborepo and generic-eslint-fallback rules,
  and the "omitted when no match" behavior. Purely additive — no existing tests retired.

Safe to deploy standalone: yes.

### LSC-1.2 — Wire dev-task.md Step 8 to use scoped lint

**Layer:** Shared · **Branch:** `feat/lsc-1-2-devtask-scoped-lint` · **Hours:** 2 ·
**Complexity:** 3 · **Model:** sonnet · **Dependencies:** LSC-1.1

Update `dev-task.md`'s Step 8 Build & Lint section to prefer `lintScoped` from the
toolchain cache when present, falling back to the existing unscoped `lint`/`validate`
command when absent.

Acceptance criteria:
- Step 8 reads `lintScoped` from the cache populated in Step 0/0b and runs it in place of
  the unscoped command when present; falls back unchanged when absent.
- `{base}`/`{head}` placeholders resolve to whatever value(s) Step 8 (or an earlier step)
  already computes for diffing against the target branch — no new diff-computation logic.
- Pre-Ship Checks output reports which lint mode ran (scoped vs. full) so a human
  reviewing the run can tell.
- Test decision: extend `dev-task.content.test.ts` with a new describe block asserting
  Step 8 references `lintScoped` and documents the fallback-to-full behavior. Purely
  additive — no existing tests retired.

Safe to deploy standalone: yes.

### LSC-1.3 — Wire patch.md's lint sites to use scoped lint

**Layer:** Shared · **Branch:** `feat/lsc-1-3-patch-scoped-lint` · **Hours:** 3 ·
**Complexity:** 3 · **Model:** sonnet · **Dependencies:** LSC-1.1

Update all three of `patch.md`'s lint-command sites (CI-fix flow, review-fix flow,
conflict-resolution flow) identically to prefer `lintScoped` when present.

Acceptance criteria:
- All three sites (`patch.md` CI-fix ~L1855-1894, review-fix ~L1180-1285,
  conflict-resolution ~L621-748) updated identically: prefer `lintScoped`, computing
  `{base}`/`{head}` from the PR's existing base/head refs already in scope at each site;
  fall back to the current unscoped `{lint command}` when absent.
- Behavior for repos without a `lintScoped` entry is unchanged — no regression to
  existing patch flows.
- Test decision: extend `patch.content.test.ts` with assertions that each of the three
  lint-command sites references the scoped-lint fallback logic. Purely additive — no
  existing tests retired.

Safe to deploy standalone: yes.
