# Toolchain Detection Patterns

Lookup table for auto-detecting project toolchains from config files. Used by all Shipwright commands at startup, after the docs-first discovery and cache check below.

## Docs-First Discovery

Before scanning config files, check whether the project's own docs already say how to build/test/lint it. Many projects wrap the raw tool commands — a custom script, a task runner (`Taskfile.yml`, `Makefile` targets that shell out further), a mise-managed runtime, a monorepo command that fans out per-package — and the config-file detection below can miss or misrepresent those wrappers entirely (e.g. detecting bare `jest` when the project actually requires `./scripts/test.sh` for DB setup first).

1. Read `CLAUDE.md` (repo root, plus any nested `CLAUDE.md` the root one `@`-references) for an explicit commands section.
2. Read `docs/*.md` and `ai-docs/*.md` — whichever directory exists — for a quickstart/setup/contributing doc naming build/test/lint/typecheck commands.
3. Treat any explicit command, wrapper script, or "use X, not Y" rule found this way as authoritative — it overrides the config-file tables below for that command.
4. Fall back to the config-file detection tables below only to fill gaps the docs didn't cover (e.g., docs document `test` but not `lint`).

A project with no `CLAUDE.md`/`docs/`/`ai-docs/` just falls straight through to config-file detection — this step costs nothing extra in that case beyond checking those paths exist.

**Record the source, not just the values.** When step 1 or 2 finds the authoritative commands section, record a `docsSource: { path, heading }` pointer to exactly where it was found (e.g. `{"path": "CLAUDE.md", "heading": "## Commands"}`) alongside the derived commands in the cache entry below — not just the commands themselves. This pointer is what lets the fingerprint (see "Caching Across Runs") scope itself to the one heading that actually matters instead of the whole file. When detection falls through to config-file scanning with nothing found in docs, omit `docsSource` entirely (never set it to `null`).

### Multi-Layer Test Detection

Many projects have more than one test command — unit, integration, smoke, e2e, schema-conformance, contract, acceptance, etc. During detection, populate `tests` when distinct test layers are discovered:

**Docs-first signals:** CLAUDE.md or docs mentioning multiple test commands, test suffixes, or separate test scripts (e.g., "run `pytest tests/unit` for unit tests, `pytest tests/integration` for integration tests").

**Config-file signals:**
- **Node.js:** `package.json` scripts prefixed with `test:` (e.g., `test:unit`, `test:integration`, `test:e2e`, `test:schema`). Each becomes a `tests` entry keyed by the suffix.
- **Java/Gradle:** `sourceSets` blocks (`integrationTest`, `acceptanceTest`), or `src/integrationTest/`, `src/acceptanceTest/` directories. Maven profiles (`-Pintegration`, `-Pit`).
- **Python:** multiple test directories (`tests/unit/`, `tests/integration/`), or tox environments.
- **Rust:** `cargo test` vs `cargo test --test <name>` for specific test binaries.
- **Mixed-ecosystem:** a project with both `cargo test` and `npm test` (e.g., Rust backend + JS e2e) — each is a separate layer.

Set `test` to the fastest/default layer (usually unit or the project's main test runner). If only one test command exists, omit `tests` — `test` alone covers everything.

## Caching Across Runs

Toolchain detection (docs-first + config-file fallback) is redundant to redo on every single command invocation — most projects don't change their toolchain often. Cache the result **one level up from the repo checkout** (same tier as `state/error-patrol-ledger.json`), **one file per repo**, so `/dev-task` and `/patch` share one cache instead of each redetecting independently:

```
state/toolchain-cache/{repo}.json
```

```json
{
  "fingerprint": "<content hash or git commit sha — see Fingerprint below>",
  "detectedAt": "<ISO timestamp>",
  "docsSource": { "path": "CLAUDE.md", "heading": "## Commands" },
  "commands": {
    "validate": "...",
    "test": "...",
    "tests": { "<layer>": "<command>", ... },
    "lint": "...",
    "lintScoped": "...",
    "typecheck": "...",
    "typecheckScoped": "...",
    "testScoped": "...",
    "build": "..."
  }
}
```

- **`test`** — the fast default test command for TDD cycles (unit tests, or the project's main test runner). Always populated.
- **`tests`** — optional object mapping layer names to commands, populated when the project has distinct test commands per layer. Keys are free-form (e.g., `unit`, `integration`, `smoke`, `e2e`, `schema-conformance`, `contract` — whatever the project calls them). When present, `test` should match one of these entries (typically the fastest layer). When absent or empty, `test` alone covers everything.
- **Scoped fields (`lintScoped`, `typecheckScoped`, `testScoped`)** — all follow the same pattern: an optional command template for scoping that check to only the changed files/packages/modules in the current diff instead of the whole repo, so a large monorepo doesn't pay a full-repo run on every change. Each is populated independently when a monorepo/affected-graph tool or a changed-files fallback yields a usable command for *that* check, and omitted (never set to `null`) when no scoped command is available for it — the plain (unscoped) command is then the only option, and that's fine. A project can have some scoped fields populated and others omitted (e.g. `lintScoped` set via eslint-on-changed-files but no equivalent `testScoped` fallback). Per-ecosystem detection rules for each scoped field live in the ecosystem sections below (see the Node.js "Scoped Check Detection" subsection, and the "Scoped Test Detection" subsections under Java, Rust, and Go).
- **`docsSource`** — optional `{ path, heading }` pointer to exactly where Docs-First Discovery found the authoritative commands (e.g. `{"path": "CLAUDE.md", "heading": "## Commands"}`, or a `docs/*.md`/`ai-docs/*.md` file). Populated only when detection found commands in an existing doc; omitted (never set to `null`) when detection fell through to config-file scanning with no docs pointer to record. This is what the fingerprint below scopes itself to.

One file per repo (not one shared file keyed by repo) — a shared file read-modify-written from multiple concurrent processes is not atomic: two agents updating *different* repos' entries at the same time can each read the whole file and clobber the other's addition on write, even though they touched different keys. Splitting by repo removes that cross-repo collision entirely. A same-repo collision (two runs racing on the same repo) can still happen, but it's benign — both would compute the same commands from the same repo state, so a lost update just costs a redundant re-detection next time, not data loss.

**Fingerprint** — a cheap staleness check scoped only to the content that can actually change the *detected commands*, so unrelated commits — including a routine lockfile-only dependency bump — don't force a redundant re-detection. Lockfiles (`package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`, `bun.lock`, `bun.lockb`, `Cargo.lock`, `go.sum`, `poetry.lock`, `Gemfile.lock`) are never part of either recipe below — a dependency-version bump touches only those files, never the commands themselves. Which recipe to use depends on whether `docsSource` was populated:

- **`docsSource` populated** (Docs-First Discovery found the commands in an existing doc): hash the pointed-to heading's own content plus `package.json`'s `scripts` block — config-file fallback can still supplement docs-first for gaps the docs didn't cover, so the scripts block still matters even when a docs pointer exists, but nothing else in the pointed-to file (other headings) and no other doc file matters:

  ```bash
  heading_content=$(awk -v h="{docsSource.heading}" '
    BEGIN { match(h, /^#+/); level = RLENGTH }
    $0 == h { found=1; next }
    found && /^#+[ \t]/ { match($0, /^#+/); if (RLENGTH <= level) exit }
    found { print }
  ' {docsSource.path} | awk -v h="{docsSource.heading}" '
    BEGIN {
      match(h, /^#+/)
      marker_level = RLENGTH + 1; if (marker_level > 6) marker_level = 6
      marker = substr("######", 1, marker_level) " Shipwright Learned Facts"
    }
    $0 ~ "^" marker "[ \t]*$" { skip=1; next }
    skip && /^#+[ \t]/ { match($0, /^#+/); if (RLENGTH <= marker_level) skip=0 }
    !skip { print }
  ')
  scripts_json=$(test -f package.json && jq -c '.scripts // {}' package.json || echo "{}")
  fingerprint=$(printf '%s\n%s' "$heading_content" "$scripts_json" | sha256sum | cut -d' ' -f1)
  ```

  **The second pass strips Shipwright's own `Shipwright Learned Facts` subsection before hashing** — the same exclusion principle as lockfiles, for the same reason. That subsection is written by "Writing Learned Facts Back to Docs" below, *nested one level deeper than `{docsSource.heading}`*, so it is part of the hashed section's content by the same-or-shallower rule described next. Its heading level is **derived from `{docsSource.heading}`'s own level, not a fixed `###`** — hence the second pass recomputes `marker_level` from the same `h` rather than hardcoding `3`, so the strip keeps working when the pointed-to heading is itself level 3 or deeper. Hashing it would make the mechanism self-invalidating: every write would change the next run's fingerprint, forcing a cache miss on essentially every subsequent run for every docsSource-pointer repo. The content Shipwright itself auto-maintains carries no signal about whether the *human-authored* commands changed, which is the only thing the fingerprint is trying to detect.

  (Degenerate case: a level-6 `{docsSource.heading}` has no deeper level to nest into, so the marker caps at level 6 and sits as a sibling. Pass 1 then exits *at* the marker heading and pass 2 is a harmless no-op — the subsection still never reaches the hash, which is all the guard needs.)

  **The section ends at the next heading of the same or shallower level — not at the next heading of *any* level.** `{docsSource.heading}` is stored as the literal heading line including its `#` markers (e.g. `## Commands`), so the recipe derives the target's level from it and only exits on a subsequent heading whose level is `<=` that. Nested subheadings *are* part of the section's own content: a monorepo whose commands doc is structured as `## Commands` → `### Build` / `### Test` must hash all of it. Exiting at the first heading of any level would capture only the intro prose before the first subsection, so an edit to a command nested under `### Test` would never change the hash — a silent false cache *hit* serving a stale command, which is strictly worse than the cache *miss* that is this design's intended worst case. (`#+` rather than `#{1,6}` also keeps the pattern working under awk implementations that don't enable ERE interval expressions; a run of 7+ `#` isn't a valid ATX heading anyway, and the level comparison already excludes it from ending a level-1–6 section.)

- **No `docsSource`** (pure config-file detection): scope to the manifest/config files that directly define commands, still excluding lockfiles — this is the canonical "routine dependency bump" case the fingerprint targets. `CLAUDE.md`/`docs`/`ai-docs` stay in this pathspec even though docs-first found nothing this time, so a *later* addition of a commands section still invalidates the cache and gets picked up on the next run:

  ```bash
  git -C {repo-dir} log -1 --format=%H -- CLAUDE.md docs ai-docs package.json Cargo.toml go.mod pyproject.toml setup.py Gemfile Makefile Taskfile.yml justfile Justfile mise.toml .mise.toml pom.xml build.gradle build.gradle.kts ':(exclude)docs/toolchain.md'
  ```

  The `':(exclude)docs/toolchain.md'` pathspec is the no-pointer half of the same self-invalidation guard as the marker-subsection strip above: `docs/toolchain.md` is the file "Writing Learned Facts Back to Docs" below *creates* for this exact case, and it lives inside the `docs` pathspec entry, so without the exclusion every learned-facts commit would move this recipe's `%H` and force a cache miss on the next run.

`{repo-dir}` / `{docsSource.path}` (when relative) is whichever checkout is live at the point detection runs — `${SHIPWRIGHT_REPO_DIR:-$HOME/src}/{repo}` for dev-task's pre-worktree detection (Step 1/0b runs before the worktree exists); the active `{worktree-path}` for patch, which always operates on an already-existing branch.

1. Read `state/toolchain-cache/{repo}.json`. If it exists and its `fingerprint` matches the value above (computed with whichever recipe matches the cached entry's own `docsSource` presence/absence), reuse the cached `commands` (including `tests` and `docsSource` if present) and skip both Docs-First Discovery and config-file scanning entirely.
2. Otherwise — file missing, or a fingerprint mismatch (first run, or toolchain-relevant content changed since the last detection) — run Docs-First Discovery above, then the config-file fallback tables below, and overwrite `state/toolchain-cache/{repo}.json` with the new fingerprint + `docsSource` (if found) + commands (a whole-file write — no cross-repo merge needed, since this file only ever holds this one repo's data). **Exception — broken `docsSource` pointer:** when the cached entry has a populated `docsSource` whose path/heading no longer resolves, "Relocation on Broken Pointer" below refines this step and governs instead; run its relocation attempt *first*, and only reach this step's config-file fallback / doc recreation if relocation also fails.

A missing or stale cache never blocks progress — worst case is a cache miss, which costs exactly what a full detection would cost with no cache at all.

### Relocation on Broken Pointer

This subsection **refines step 2 above** — it is not a parallel alternative to it. A broken pointer *is* a fingerprint mismatch (the populated-`docsSource` recipe hashes the pointed-to heading's content, so a moved file or restructured heading changes the hash), so it enters step 2; what follows overrides step 2's routing for that one case only. Every other mismatch keeps step 2's behavior unchanged.

A `docsSource` pointer can go stale in a more specific way than a generic fingerprint mismatch: the file was moved/renamed, or the heading was restructured, while the underlying commands still exist somewhere in the docs. Treat this as its own case rather than letting it fall silently into a full re-scan.

**Broken-pointer check** — reuse doc-refresh-recipe.md's verification-table pattern (Part 1, "File path" and "Script" rows) rather than re-deriving it here:
- `docsSource.path` no longer exists — the "File path" check (`Glob` for the path).
- `docsSource.path` exists but `docsSource.heading` is no longer found in it — the same heading-extraction check the fingerprint recipe above already runs; an empty result means the heading is gone, the same failure mode the "Script" check covers for a renamed/removed script.

Either condition means the pointer is broken.

**On a broken pointer, attempt relocation before falling back.** Before treating `docsSource` as absent and running the full config-file fallback / doc recreation:

1. Re-run Docs-First Discovery's search (`CLAUDE.md`, `docs/*.md`, `ai-docs/*.md` — see above) scoped to finding the same kind of commands section that was originally pointed to — same heading text, or a heading covering the same command keys (`validate`/`test`/`lint`/etc.) — elsewhere in the docs.
2. **Relocation succeeds** — a new path/heading is found containing the same authoritative commands: update the stored `docsSource.path`/`docsSource.heading` to the new location and treat this as a cache refresh, not a full fallback — recompute the fingerprint from the new location and overwrite the cache entry. Do not run the config-file fallback or recreate the default doc; the pointer was found, just moved.
3. **Relocation also fails** — no matching section is found anywhere in the docs: only now treat `docsSource` as absent. Run the full config-file fallback tables below, and (re)create/derive the default doc-less commands per the "No `docsSource`" fingerprint recipe above.

Relocation is always attempted first — a broken pointer never immediately triggers doc recreation. Falling back to config-file detection / (re)creating the default doc is strictly the last resort, reached only when relocation also fails.

**Known limitation, not addressed here:** the cache stores root-level commands only — the same granularity the config-file fallback already used before caching existed. A monorepo with genuinely different per-package toolchains (turborepo/nx/pnpm-workspaces) isn't newly broken by caching, but isn't specially handled either; per-package cache scoping is a candidate follow-up if it turns out to matter in practice.

## Writing Learned Facts Back to Docs

Toolchain detection produces things worth recording somewhere more visible than `state/toolchain-cache/{repo}.json` — a project's own docs are what a human (or a later agent skimming `CLAUDE.md` instead of the cache) actually reads. Once the run has both a worktree and its verification results in hand (see "When this runs" below), write a small, best-effort summary of what was learned back into the project's own doc tree.

**What counts as a learned fact:**
- **Scoped-command variants** actually detected for this repo — the `lintScoped`/`typecheckScoped`/`testScoped` values from the cache entry, when present (see "Caching Across Runs" above).
- **The enforced per-check verification budget** actually used for this repo — the `{budget}` value (see Step 8's enforced per-check timeout budgets), and whether it was `ci-derived` or the `fallback-10m` constant.
- **Skip-locally classifications** (LVB-4.4) — a small table, inside the marker subsection, of checks this repo has learned to stop attempting locally. One row per `checkName`:

  | Check | Reason | Classified At |
  |-------|--------|----------------|
  | `{checkName}` | `{reasonCategory}` | `{ISO timestamp}` |

  `Reason` is one of `VerificationCheckReasonCategory`'s ENVIRONMENTAL values (`check_timeout`,
  `install_timeout`, `resource_limit`, `missing_tool`, `missing_secret`, `missing_dependency`,
  `not_configured`) — never `learned_skip` itself, since `learned_skip` is the *meta*-category
  the read side below POSTs when *citing* this table, not a value this table ever stores.
  `Classified At` is the ISO timestamp of the write that produced or last updated the row.

  **Read side** (dev-task.md Step 8's "Skip-Locally Classification: Read Before Attempting Each
  Check", and patch.md's three verification-check call sites): before attempting a check, look
  up its `checkName` in this table. A match means the check is not attempted at all this run —
  no `setsid timeout ...` wrapper, no budget spent even trying — and a `VerificationCheck` row is
  POSTed directly instead, with `status: "skipped"`, `reasonCategory: "learned_skip"`, and
  `learnedFromCategory` set to the table row's `Reason`, so the recorded (environmental, never a
  correctness judgment) reason is surfaced in that run's structured outcome.

  **Write side — the learning trigger** (dev-task.md Step 8's "Skip-Locally Learning Trigger"
  subsection only; `patch.md` never writes this table — see below): after a REAL check attempt
  (one that actually ran, not a skip-on-read short-circuit) POSTs a `skipped`/`timed_out`
  outcome, dev-task queries `GET /verification-checks?repo=&checkName=&limit=` — the repo+check
  history mode, ordered by `at` DESCENDING (most recent first) specifically so a caller can walk
  backward from the latest outcome — and counts the CONSECUTIVE run of `skipped`/`timed_out` rows
  starting from the most recent. A `ran_passed` or `ran_failed` row breaks/resets that count: a
  real pass or a real test/lint failure is a completely separate, expected outcome and must never
  contribute to this counter or by itself trigger a write — a check that reliably fails because
  the code under review is wrong keeps running and keeps failing loudly, not silently getting
  marked as something the agent stops attempting. Once the streak reaches 2, dev-task writes (or
  updates) this table's row for that `checkName`, carrying the 2nd (triggering, most recent)
  outcome's `reasonCategory` forward as the new `Reason`.

  **`patch.md` is read-only against this table.** It checks the table before attempting each of
  its own verification-check call sites, same as dev-task, but has no write hook — LVB-4.2 only
  wired the write mechanism into dev-task.md, and this task preserves that asymmetry rather than
  building a second, parallel write path. A `patch` run still benefits from classifications
  dev-task has already learned; it just never adds new ones itself.

**The marker subsection.** All of the above is written into a fixed, idempotent subsection — `Shipwright Learned Facts` — that this mechanism owns exclusively. Every write is a **full replace** of everything between that heading and the next heading of the same-or-shallower level, never an append that duplicates prior content. Reuse the exact heading-boundary technique already documented under "Caching Across Runs" → **Fingerprint** (the awk recipe that derives a heading's level from its own `#` markers and only exits at a subsequent heading whose level is `<=` that one) rather than reimplementing a slightly different boundary rule that could drift from it. Open the subsection with a one-line auto-maintained note so a human editing the doc by hand knows not to maintain it:

> _Auto-maintained by Shipwright's toolchain detection — edits here are overwritten on the next run._

**The marker's heading level is derived, never hardcoded.** The heading *text* (`Shipwright Learned Facts`) is fixed; its `#` depth is always **one level deeper than the heading it nests under** — `parent level + 1`, capped at markdown's maximum of 6. "Nested under X" and "a fixed `###`" are only the same thing when X happens to be level 2, and nothing guarantees that: Docs-First Discovery also scans arbitrary `docs/*.md`/`ai-docs/*.md` files, where a commands section is plausibly itself at level 3 or deeper. Emitting a level-3 marker under a level-3 (or deeper) parent would make it a *sibling*, not a child — by this file's own same-or-shallower boundary rule it would terminate the parent section instead of nesting inside it, breaking both the Fingerprint's pass-1 extraction and this mechanism's own full-replace boundary detection on the next run. Derive the level from the parent heading's own `#` run (the same `match($0, /^#+/); RLENGTH` idiom the Fingerprint recipe uses) and build the marker from it:

| Parent heading | Marker heading |
|---|---|
| `## Commands` (level 2) | `### Shipwright Learned Facts` |
| `### Commands` (level 3, nested under e.g. `## Development`) | `#### Shipwright Learned Facts` |
| `#### Build & Test` (level 4) | `##### Shipwright Learned Facts` |
| `###### Commands` (level 6 — degenerate, no deeper level exists) | `###### Shipwright Learned Facts` (sibling; the cap) |

Every boundary check downstream — the full-replace range here, and the Fingerprint's second-pass strip — keys off that same derived level, not a literal `###`.

**Target location** depends on whether `docsSource` was populated for this repo. Both paths resolve their target **inside the active `{worktree-path}`** — see "Which checkout" below; neither ever writes to the shared pre-worktree repo checkout:

- **Pointer exists** (`docsSource: { path, heading }` populated): the target is `{worktree-path}/{docsSource.path}`, and the `Shipwright Learned Facts` marker — at `{docsSource.heading}`'s own level **+ 1**, per the derivation rule above — is inserted/updated as a nested subsection immediately under `{docsSource.heading}`, appended at the end of that heading's own content, before the next heading of the same or shallower level. Apply `doc-refresh-recipe.md`'s Part 2 **Update** operation: read the doc in full, then use the `Edit` tool with a focused old/new string scoped to the marker subsection (or its insertion point, if it doesn't exist yet), leaving everything else in `{docsSource.path}` untouched. This updates the existing doc — not a new file. Because the level is derived, an existing marker from a prior run is found by matching the heading *text*, not a hardcoded `###` prefix.
- **No pointer** (`docsSource` absent — config-file-only detection): the target is the default `{worktree-path}/docs/toolchain.md`. If it doesn't exist yet, create it with a minimal header — a one-line `# Toolchain` title plus a short sentence noting this file is Shipwright's own record of the detected toolchain — followed by the marker subsection. The same derivation rule applies here: the parent is that `# Toolchain` title (level 1), so the marker is `## Shipwright Learned Facts`. If it already exists (e.g. a prior run already created it), update just the marker subsection via the same Edit-based mechanics as the pointer-exists case above — never a whole-file rewrite.

**Which checkout — always the worktree, never the shared repo checkout.** Detection itself runs pre-worktree, against `${SHIPWRIGHT_REPO_DIR:-$HOME/src}/{repo}` (see the `{repo-dir}` note above), but this *write* must not. That shared checkout is the one every concurrent and future dev-task/patch/deploy run for this repo depends on staying clean, and dev-task's own Step 4 runs `git pull` against it — uncommitted learned-facts edits sitting there would collide with that pull and leak into unrelated runs. The write therefore always targets the task's own `{worktree-path}`, where it is committed on the task's branch and lands in the task's PR like any other change.

**When this runs.** Not at detection time — at **dev-task.md Step 8.6**, after Step 8's pre-ship checks and Step 8.5's docs refresh, and before Step 9's push. Two reasons this is the only viable point, and both are structural rather than stylistic:

1. **The worktree exists by then.** Step 0b/Step 1 detection runs before Step 4 creates `{worktree-path}`, so there is no repo-safe place to write at detection time (see "Which checkout" above).
2. **`{budget}` exists by then.** The enforced per-check verification budget is derived inside Step 8 ("Budget derivation"), several steps after detection. Writing at Step 0b would record scoped commands with an empty budget field and no later hook to backfill it. At Step 8.6 all three fact categories — scoped commands (from the Step 0b cache entry), the budget and its `ci-derived`/`fallback-10m` source, and this run's skip-locally classifications table (populated in-memory by Step 8's read and learning-trigger sections, empty when nothing was learned this run) — are simultaneously in hand, so one write covers all of them.

A single write per run, at one hook, is deliberate: there is no second write hook to keep in sync, and the full-replace marker subsection makes re-running idempotent.

This write is best-effort and never blocks the pipeline — the same "never blocks" posture already used for Step 8's enforced verification timeouts and Step 8.5's docs refresh: a failure to write it (or to commit it) is logged and skipped, not escalated, and Step 9 proceeds regardless.

## Detection Order

Scan the project root for these files in priority order. A project may match multiple ecosystems (e.g., Node.js + Rust in a monorepo).

## Node.js

| Signal | Detection |
|--------|-----------|
| `package-lock.json` | npm |
| `yarn.lock` | yarn |
| `pnpm-lock.yaml` | pnpm |
| `bun.lockb` or `bun.lock` | bun |
| `package.json` (no lockfile) | npm (fallback) |

**Commands** — read from `package.json` `scripts` field:

| Script Key | Purpose | Fallback |
|------------|---------|----------|
| `validate` | Full validation (lint + types + tests + build) | Run `lint`, `typecheck`, `test`, `build` individually |
| `build` | Build/compile | `tsc` if `tsconfig.json` exists |
| `test` | Unit tests | `vitest run` or `jest` based on devDependencies |
| `lint` | Linting | `eslint .` if eslint config exists |
| `typecheck` or `check` | Type checking | `tsc --noEmit` if TypeScript |
| `format` | Code formatting | `prettier --check .` if prettier config exists |

**Monorepo detection:**
- `pnpm-workspace.yaml` → pnpm workspaces
- `package.json` → `workspaces` field (npm/yarn workspaces)
- `lerna.json` → Lerna monorepo
- `nx.json` → Nx monorepo
- `turbo.json` → Turborepo

**Per-package commands** (monorepo): `{manager} --filter {package} {script}`

### Scoped Check Detection (Lint, Test, Typecheck)

Populates the `lintScoped`, `testScoped`, and `typecheckScoped` cache fields (see "## Caching Across Runs" above) with commands that scope each check to the current diff instead of the whole repo, so a large monorepo doesn't pay a full-repo run on every change. Check signals in this priority order — first match wins, `{base}`/`{head}` are the diff's base and head refs — and apply the same priority order independently per check (a repo can resolve `lintScoped` via Turborepo and still have no `typecheckScoped` if the `typecheck` script isn't wired into `turbo.json`'s pipeline):

| Priority | Signal | `lintScoped` | `testScoped` | `typecheckScoped` |
|----------|--------|---------------|---------------|---------------------|
| 1 | `turbo.json` present (Turborepo) | `turbo lint --filter=...[{base}...{head}]` | `turbo test --filter=...[{base}...{head}]` | `turbo typecheck --filter=...[{base}...{head}]` |
| 2 | `nx.json` present (Nx) | `nx affected --target=lint --base={base}` | `nx affected --target=test --base={base}` | `nx affected --target=typecheck --base={base}` |
| 3 | `pnpm-workspace.yaml` present (pnpm workspaces) | `pnpm --filter "...[{base}]" lint` | `pnpm --filter "...[{base}]" test` | `pnpm --filter "...[{base}]" typecheck` |
| 4 | No monorepo tool detected | Generic `eslint {changed files}` fallback — run against the git-diff-changed files that are lintable (JS/TS extensions eslint covers), not the whole repo | No generic fallback — a changed-files test run is unsound in JS/TS (a test can exercise code far from the file that changed); omit `testScoped` rather than guess | No generic fallback — `tsc` type-checks the whole project graph by design, so there's no sound per-file scoping; omit `typecheckScoped` rather than guess |

Priority 1–3 commands require the target script (`test`, `typecheck`) to actually be declared in the monorepo tool's pipeline/target config (e.g. `turbo.json`'s `pipeline`/`tasks`, or an `nx.json` target default) — a tool being present doesn't guarantee every check is wired into it. Verify the target exists before emitting the scoped command; if it doesn't, fall through to the next priority (or omit) for that check only.

When none of these signals produce a usable command for a given check (e.g. a non-Node ecosystem with no equivalent scoped tool, or priority 4's "no sound fallback" cases above), omit that field from the cache entirely — never set it to `null`.

## Rust

| Signal | Detection |
|--------|-----------|
| `Cargo.toml` | Cargo |
| `Cargo.lock` | Confirms Rust project |

| Command | Purpose |
|---------|---------|
| `cargo build` | Build |
| `cargo test` | Tests |
| `cargo clippy --workspace -- -D warnings` | Lint |
| `cargo fmt --check` | Format check |
| `cargo doc --no-deps` | Documentation |

**Workspace detection:** `[workspace]` section in root `Cargo.toml`

### Scoped Test Detection

Populates `testScoped` (see "## Caching Across Runs" above). Rust has no ecosystem-standard affected-graph tool comparable to turbo/nx — there is no built-in "which crates does this diff affect" command, only per-crate scoping you construct yourself:

| Signal | Command |
|--------|---------|
| `[workspace]` section in root `Cargo.toml`, and the diff's changed files map to a single member crate | `cargo test -p {crate}` — `{crate}` is the package name (from that crate's `Cargo.toml`) containing the changed paths |
| Diff touches files in multiple member crates | Either run `cargo test -p {crate}` once per touched crate, or fall through to the plain `cargo test` (workspace-wide) — per-crate scoping doesn't compose into one command the way a graph-aware `affected` command would |
| No workspace (single-crate repo), or changed paths don't map cleanly to one crate | Omit `testScoped` — the plain `cargo test` is the only option |

**Caveat:** this is per-crate scoping, not a true dependency-affected-graph query — `cargo test -p {crate}` runs only that crate's own tests, it does not also run tests in crates that depend on the changed crate (Nx/Turbo's `affected` does traverse that graph). It also doesn't catch a workspace-wide integration test crate that indirectly exercises the changed code. Given Rust workspaces are typically small enough that a full `cargo test` is cheap, treat this as an available optimization, not a strong recommendation — falling through to the plain `test` command is a reasonable default, especially for smaller workspaces.

## Go

| Signal | Detection |
|--------|-----------|
| `go.mod` | Go modules |
| `go.sum` | Confirms Go project |

| Command | Purpose |
|---------|---------|
| `go build ./...` | Build |
| `go test ./...` | Tests |
| `go vet ./...` | Vet |
| `golangci-lint run` | Lint (if installed) |
| `gofmt -l .` | Format check |

**Workspace detection:** `go.work` file

### Scoped Test Detection

Populates `testScoped` (see "## Caching Across Runs" above). Like Rust, Go has no ecosystem-standard affected-graph tool — scoping is per-package, not dependency-graph-aware:

| Signal | Command |
|--------|---------|
| Diff's changed files map to one or a small number of packages | `go test ./{changed-package}/...` — one invocation per changed package (or a comma-joined package list in one `go test` call) |
| `go.work` present (multi-module workspace) and changes span multiple modules | Run the per-package command above scoped within each affected module, or fall through to `go test ./...` at the workspace root |
| Changed paths span most of the tree, or don't map cleanly to specific packages | Omit `testScoped` — the plain `go test ./...` is the only option |

**Caveat:** `go test ./{package}/...` tests the changed package and its subpackages, but not packages elsewhere in the module that import the changed package and could be affected by the change — there's no built-in "affected" resolution the way Nx/Turbo provide for Node. As with Rust, Go compiles and tests fast enough in most repos that a full `go test ./...` is often cheap; treat per-package scoping as an available option for large repos where the full run has become slow, not a default recommendation.

## Java

| Signal | Detection |
|--------|-----------|
| `pom.xml` | Maven |
| `build.gradle` | Gradle (Groovy DSL) |
| `build.gradle.kts` | Gradle (Kotlin DSL) |
| `gradlew` | Gradle wrapper (prefer over global `gradle`) |
| `mvnw` | Maven wrapper (prefer over global `mvn`) |

**Commands** — prefer wrapper scripts when present:

| Tool | Build | Test | Lint | Format check |
|------|-------|------|------|--------------|
| Maven (wrapper) | `./mvnw package -DskipTests` | `./mvnw test` | `./mvnw checkstyle:check` | — |
| Maven (global) | `mvn package -DskipTests` | `mvn test` | `mvn checkstyle:check` | — |
| Gradle (wrapper) | `./gradlew build -x test` | `./gradlew test` | `./gradlew checkstyleMain` | `./gradlew spotlessCheck` |
| Gradle (global) | `gradle build -x test` | `gradle test` | `gradle checkstyleMain` | `gradle spotlessCheck` |

**Profile/variant detection:**
- Check `pom.xml` for `<profiles>` — integration tests often live behind `-Pintegration` or `-Pit`
- Check `build.gradle` / `build.gradle.kts` for `sourceSets` blocks — acceptance tests may be in a separate source set (e.g., `acceptanceTest`, `integrationTest`)
- Check for `src/test/`, `src/integrationTest/`, `src/acceptanceTest/` directories

**Multi-module detection:**
- Maven: root `pom.xml` with `<modules>` section
- Gradle: `settings.gradle` or `settings.gradle.kts` with `include(...)` statements

### Scoped Test Detection

Populates `testScoped` (see "## Caching Across Runs" above), for multi-module Maven/Gradle projects:

| Tool | Signal | Command |
|------|--------|---------|
| Maven | `<modules>` section in root `pom.xml`, and the diff's changed files map to one or more member modules | `mvn test -pl {module} -am` (wrapper: `./mvnw test -pl {module} -am`) — `-pl` selects the changed module(s) (comma-separated for multiple), `-am` ("also make") builds their upstream dependencies first so the scoped run still reflects a consistent reactor build |
| Gradle | `settings.gradle`/`settings.gradle.kts` `include(...)` statements, and the diff maps to one member module | `./gradlew :{module}:test` (global: `gradle :{module}:test`) — Gradle only rebuilds/retests the targeted module and its dependencies via its own up-to-date/dependency tracking |
| Either | Diff spans most/all modules, or an affected-modules Gradle plugin isn't installed and changes don't map cleanly to a single module | Omit `testScoped` — the plain multi-module `test` command (full reactor / `./gradlew test`) is the only option |

**Determining "changed module":** map each changed file path to the module/subproject whose root directory contains it — the module boundary is the directory holding that module's own `pom.xml` (Maven) or its entry in `settings.gradle`'s `include(...)` (Gradle). A diff touching files in more than one module's directory means more than one `{module}` value — either run the scoped command once per touched module, or fall through to the full multi-module command if that's simpler than composing several scoped invocations. A shared/root-level file changing (e.g. the parent `pom.xml`, `build.gradle` at the root, a shared BOM) should be treated as touching every module, since it can affect the reactor build for all of them — fall through to the full command in that case rather than scoping to just the file's own directory.

**Mixed-language test suites** (common in Java projects):
- `src/test/` in Java + `playwright.config.*` or `package.json` with Playwright → TypeScript E2E tests alongside Java unit tests
- `requirements.txt` / `pyproject.toml` at root or in `tests/` → Python acceptance tests (e.g., pytest + requests)
- In these cases, detect both ecosystems and run each test suite independently

## Python

| Signal | Detection |
|--------|-----------|
| `pyproject.toml` | Modern Python (check `[build-system]` for tool) |
| `setup.py` / `setup.cfg` | Legacy Python |
| `requirements.txt` | pip |
| `Pipfile` | pipenv |
| `poetry.lock` | Poetry |
| `uv.lock` | uv |

| Tool | Build | Test | Lint | Format |
|------|-------|------|------|--------|
| Poetry | `poetry build` | `poetry run pytest` | `poetry run ruff check` | `poetry run ruff format --check` |
| uv | `uv build` | `uv run pytest` | `uv run ruff check` | `uv run ruff format --check` |
| pip | `python -m build` | `pytest` | `ruff check` | `ruff format --check` |

**Monorepo detection:** Multiple `pyproject.toml` files in subdirectories

**Scoped detection:** not attempted. Python has no ecosystem-standard affected-graph tool comparable to turbo/nx (a monorepo of multiple `pyproject.toml` packages has no equivalent of `nx affected`/`turbo --filter` built into the standard tooling). Best-effort/full-suite is the default — `testScoped`/`lintScoped`/`typecheckScoped` are omitted for Python and the plain full-repo commands above are used, even in a multi-package layout.

## Ruby

| Signal | Detection |
|--------|-----------|
| `Gemfile` | Bundler |
| `Gemfile.lock` | Confirms Ruby project |
| `*.gemspec` | Gem project |

| Command | Purpose |
|---------|---------|
| `bundle exec rake build` | Build (if Rakefile) |
| `bundle exec rspec` | Tests (RSpec) |
| `bundle exec rake test` | Tests (Minitest) |
| `bundle exec rubocop` | Lint |
| `bundle exec standardrb` | Lint (Standard) |

**Scoped detection:** not attempted, for the same reason as Python — no ecosystem-standard affected-graph tool exists for Ruby/Bundler. Best-effort/full-suite is the default; `testScoped`/`lintScoped`/`typecheckScoped` are omitted and the plain commands above are used.

## Generic / Makefile

| Signal | Detection |
|--------|-----------|
| `Makefile` | Make-based project |

Scan for common targets: `build`, `test`, `lint`, `check`, `clean`, `install`

| Command | Purpose |
|---------|---------|
| `make build` | Build |
| `make test` | Test |
| `make lint` | Lint |
| `make check` | Full check |

## Bun-Specific Gotchas

### `bunx` vs local binary — always prefer local after `bun install`

`bunx` checks `node_modules/.bin` first and uses the local binary when present. However, if the package is **not** installed locally (e.g., before `bun install`, in a fresh CI environment, or in a Docker build stage without `node_modules`), `bunx` silently fetches the **latest version** from the npm registry — ignoring whatever version `package.json` or `bun.lock` specifies. This silent fallback is the gotcha:

```bash
# RISKY — silently fetches latest if node_modules is missing or incomplete
bunx prisma migrate dev

# SAFE — fails loudly if not installed, uses pinned version if installed
bun run db:migrate           # via package.json scripts
# OR
./node_modules/.bin/prisma migrate dev
```

**Practical impact**: A project with `"prisma": "^6.0.0"` in `package.json` will get Prisma v7.x from `bunx` if `node_modules` is missing and v7 is the latest — potentially breaking the schema syntax (Prisma v7 dropped `url` in `schema.prisma`, requiring `prisma.config.ts`).

**Rule for Shipwright**: Always use `bun run <script>` or `./node_modules/.bin/<binary>` for tools that have strict version pinning. These approaches fail loudly when `node_modules` is missing rather than silently fetching a potentially incompatible version. Never use `bunx` for database tooling, schema generators, or any tool where a major version bump would break the project.

> Note: `bunx` is fine for one-off tools not pinned in `package.json` (e.g., `bunx create-hono`).

### Prisma migrations must run synchronously — never in background

`prisma migrate dev` is interactive and long-running. Running it as a background task causes it to time out or receive SIGTERM (exit code 143):

```bash
# WRONG — times out as a background task
run_in_background("./node_modules/.bin/prisma migrate dev --name init")

# CORRECT — run synchronously, wait for completion
bun run db:migrate    # via package.json scripts
# OR
./node_modules/.bin/prisma migrate dev --name init
```

**Rule for Shipwright**: Always run `prisma migrate dev` as a foreground synchronous command. For applying existing migrations (e.g., after pulling new migration files from a teammate), use `prisma migrate deploy` instead — it's non-interactive and faster.

---


## Environment Passthrough to Install Children

Package managers only honor a cache location if its env var actually survives the trip to the process doing the installing. Two layers can break that, and only one of them is under Shipwright's control.

**Layer 1 — the agent's own spawn (verified fine).** `agent/src/claude.ts` spawns the `claude` CLI with `env: { ...process.env, ...extraEnv }` and strips exactly one variable, `SENTRY_DSN`. Everything else — `npm_config_cache`, `YARN_CACHE_FOLDER`, `PNPM_HOME`/`npm_config_store_dir`, `BUN_INSTALL_CACHE_DIR`, `PIP_CACHE_DIR`, `CARGO_HOME`, `GOMODCACHE`, `GRADLE_USER_HOME` — is inherited wholesale, and POSIX env inheritance carries it transparently through the CLI to the Bash-tool child and on to the install process it runs. Verified empirically two levels deep. Adding a cgroup to that spawn (see `agent/src/process-tree-kill.ts`) does not touch env; cgroup membership and environment are independent.

**Layer 2 — the target repo's task runner (the real risk).** Monorepo task runners deliberately hash and whitelist the environment so task output is cacheable. Turborepo runs in `envMode: "strict"` by default (2.0+): a task's child process receives **only** the vars declared in `turbo.json`'s `env`/`globalEnv`, plus a small built-in passthrough list. Nx's `runtime`/`env` inputs behave similarly. An undeclared `npm_config_cache` is silently dropped — the install then writes to the default per-user cache, which in a fresh container means a full cold download on every run.

```bash
# RISKY — a strict-env task runner can strip npm_config_cache before the
# install child ever sees it, silently defeating the warm cache.
npm_config_cache=/cache/npm turbo run setup

# SAFE — invoke the package manager directly; nothing sits in between.
npm_config_cache=/cache/npm npm ci
```

```jsonc
// OR declare it, if the install genuinely has to run through the task runner:
// turbo.json
{ "globalPassThroughEnv": ["npm_config_cache", "YARN_CACHE_FOLDER", "PIP_CACHE_DIR"] }
```

**Detection:** a `turbo.json` with no `envMode` (strict is the default) or `"envMode": "strict"`, or an `nx.json` with `namedInputs` declaring `runtime`/`env` entries. Confirm cheaply from inside the repo with `<runner> run <task>` wrapping `sh -c 'echo $npm_config_cache'` — an empty result means the var is being stripped, not that it was never set.

**Rule for Shipwright**: run dependency installation as a direct package-manager invocation (`npm ci`, `bun install`, `pip install`, `cargo fetch`), never behind a monorepo task runner, unless the repo's runner config explicitly passes the cache vars through. Detected commands that bundle installation into a task-runner target (`turbo run setup`, `nx run-many -t install`) should be treated as cache-defeating and flagged, not silently used.


## Never Run a Target the Diff Doesn't Touch

This is a general rule, not specific to Node/monorepo tooling: never invoke a build, test, or export target whose declared source-path scope the current diff does not touch. The mechanism is the same regardless of ecosystem — compare the diff's changed file paths against each target's declared source-path scope, and only run targets whose scope overlaps the diff.

"Declared source-path scope" means whatever the project's own tooling uses to say a target belongs to a given set of paths — a Turborepo/Nx/pnpm-workspace package boundary, a Maven/Gradle module directory, a Cargo/Go workspace member, a Makefile target's documented inputs, or a platform-specific build step (e.g. a mobile/native export step whose inputs are an `ios/`, `android/`, or platform-specific asset directory) are all instances of the same pattern. The mobile/native export step is one example among many, not a distinguished case — the same logic applies to, say, a docs-site build target scoped to `site/`, or a database-migration-generation target scoped to a `prisma/` or `migrations/` directory.

Running an out-of-scope target isn't just wasted time: some targets have side effects (writing generated output, hitting external services, requiring credentials or platform-specific toolchains that may not even be installed in the current environment) that are actively harmful or simply fail outright when invoked without a reason tied to the diff. A native export step, for example, may require a full mobile toolchain (Xcode, Android SDK) unavailable in this environment — invoking it on a diff that never touched `ios/`/`android/` is both wasted effort and likely to fail for reasons unrelated to the change under test.

This rule composes with, but is distinct from, scoped-check detection (`lintScoped`/`testScoped`/`typecheckScoped`) above: scoped-check detection narrows a check's *default* target set to just the affected packages/modules as an optimization; this rule is the harder constraint that a target outside the diff's scope should not run at all, regardless of whether a scoped or full command is otherwise in use.

## Multi-Ecosystem Projects

Some projects use multiple ecosystems. When this happens:
1. Detect all ecosystems present
2. Run validation commands for each ecosystem
3. Report results per-ecosystem in coverage and pre-ship checks

Example: A project with `package.json` + `Cargo.toml` runs both `pnpm validate` and `cargo test`.

## Permission Patterns

Map detected tools to Bash permission patterns for `.claude/settings.local.json`:

| Tool | Pattern |
|------|---------|
| git | `Bash(git:*)` |
| GitHub CLI | `Bash(gh:*)` |
| pnpm | `Bash(pnpm:*)` |
| npm | `Bash(npm:*)` |
| yarn | `Bash(yarn:*)` |
| bun | `Bash(bun:*)` |
| cargo | `Bash(cargo:*)` |
| go | `Bash(go:*)` |
| mvn / mvnw | `Bash(mvn:*)`, `Bash(./mvnw:*)` |
| gradle / gradlew | `Bash(gradle:*)`, `Bash(./gradlew:*)` |
| python/pytest | `Bash(python:*)`, `Bash(pytest:*)` |
| poetry | `Bash(poetry:*)` |
| uv | `Bash(uv:*)` |
| bundle | `Bash(bundle:*)` |
| make | `Bash(make:*)` |
| npx | `Bash(npx:*)` |
| node | `Bash(node:*)` |
| Shell utilities | `Bash(wc:*)`, `Bash(find:*)`, `Bash(grep:*)` |
| playwright | `Bash(npx playwright:*)` |

## E2E Testing Detection

When a project has a UI/frontend layer, Playwright E2E tests should be included in the plan. Detection signals:

| Signal | Indicates UI |
|--------|-------------|
| `src/frontend/`, `src/app/`, `src/pages/`, `src/components/` | Frontend directories |
| `index.html`, `*.html` in src | Web app entry point |
| `leaflet`, `react`, `vue`, `svelte`, `angular`, `solid` in deps | UI framework |
| `vite`, `webpack`, `parcel`, `esbuild` in devDeps | Frontend bundler |
| Browser extension manifest (`manifest.json` with `manifest_version`) | Browser extension |
| `tauri.conf.json`, `electron-builder.yml` | Desktop app with webview |

When UI detected, add `@playwright/test` to the toolchain and include E2E test tasks in the breakdown.
