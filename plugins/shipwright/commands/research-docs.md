---
description: Analyze codebase and generate or update project documentation
argument-hint: "[module-or-topic | --auto]"
---

# Research Docs

Analyze the codebase, audit existing documentation, identify gaps and stale content, then generate or update docs. Like `/init` but for the `docs/` directory.

If `$ARGUMENTS` contains `--auto`, run in **auto mode** — unattended, cron-safe, no user confirmation prompts. Otherwise, run the interactive mode below.

If `$ARGUMENTS` is provided without `--auto`, focus on just that module or topic. Otherwise, audit the entire project.

---

## Auto Mode (`--auto`)

When `$ARGUMENTS` includes `--auto`, skip all interactive steps. Run the following steps in sequence, then stop. Do NOT enter the Interactive Mode steps.

### Step A0: Confirm Auto Mode

Check that `--auto` is present in `$ARGUMENTS`. Print:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
RESEARCH-DOCS AUTO RUN
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Mode: auto (unattended)
```

### Step A1: Read Sync Anchor

Read `state/docs-last-synced.json` to get the last-synced SHA:

```bash
cat state/docs-last-synced.json 2>/dev/null
```

Extract the `"sha"` field. If the file does not exist or is absent, treat all source files as changed (full audit scope — no SHA filter applied).

Store: `ANCHOR_SHA={sha from file, or empty string if absent}`

### Step A2: Find Changed Source Files

If `ANCHOR_SHA` is set, get the list of source files changed since the last sync:

```bash
git diff --name-only {ANCHOR_SHA}...HEAD
```

Filter to source files only (exclude `docs/`, `state/`, `.github/`). Store as `CHANGED_FILES`.

If `ANCHOR_SHA` is empty (no sync anchor), set `CHANGED_FILES` to all source files (full scope).

### Step A3: Filter Docs to Candidates

For each file in `docs/*.md`:

- Extract changed filenames, changed base names, and key symbols from `CHANGED_FILES`
- `grep` the doc file for any of those names
- If at least one match is found, the doc is a **candidate** for staleness check

This is the same scoping logic as `agents/docs-refresher.md` — only docs with overlap enter the staleness check. `docs/test-readiness/` files are always excluded (read-only).

If `ANCHOR_SHA` is empty (full scope), all `docs/*.md` files are candidates.

### Step A4: Staleness Check on Candidates

For each candidate doc, run the staleness check from `references/doc-refresh-recipe.md` Part 1 (Staleness Detection).

Mark each as **current**, **stale**, or **untouched**.

### Step A5: Update Stale Docs (No Confirmation)

For each stale candidate, apply `references/doc-refresh-recipe.md` Part 2 (Section Rewrite) directly — no user confirmation, no "Proceed?" gate.

Use the `Edit` tool for section-level changes; fall back to `Write` only for the `docs/testing.md` re-digest case.

### Step A6: Update CLAUDE.md References

Check if `CLAUDE.md` has a reference or docs section (patterns: `@docs/`, `docs/`, or a "Reference" heading).

If it does:
- Add entries for any newly-covered docs (files created or scope expanded)
- Remove entries pointing to docs that no longer exist

If it doesn't, skip this step.

### Step A7: Task Out Missing Docs

For any module that has no corresponding doc (identified by scanning for modules without a `docs/{module}.md` counterpart among the changed source files):

Do NOT generate the doc automatically. Instead, write a follow-on task via the task store API:

```bash
curl -sf -X POST \
  -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
  -H "Content-Type: application/json" \
  "$SHIPWRIGHT_TASK_STORE_URL/tasks/bulk" \
  --data-binary @/tmp/missing-docs-tasks.json | jq .
```

Each missing module produces one task with: `title: "Document {module} module"`, `layer: "CLI"`, `session: "docs-freshness-cron"`.

### Step A8: Write Sync Anchor

After all updates complete, write the sync anchor:

```bash
echo '{"sha":"'$(git rev-parse HEAD)'","timestamp":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'"}' > state/docs-last-synced.json
```

The `"sha"` and `"timestamp"` fields are required. Any future auto run will diff against this SHA.

### Step A9: Auto Run Summary

Print a non-interactive summary:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
AUTO RUN COMPLETE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Candidates checked: {N docs}
Updated: {list of updated docs, or "none"}
Skipped (current): {list, or "none"}
CLAUDE.md: {updated | unchanged}
Tasks created: {N missing-doc tasks, or "none"}
Sync anchor: {HEAD SHA} → state/docs-last-synced.json
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

Stop here. Do not enter the Interactive Mode steps below.

---

## Interactive Mode

The steps below run when `$ARGUMENTS` does **not** contain `--auto`. The interactive flow is unchanged — it prompts for confirmation before writing any files.

---

## Step 1: Detect Project Structure

Scan the project to build a structural map:

1. Read `CLAUDE.md` for project overview, module list, and conventions
2. Read the project manifest (`package.json`, `Cargo.toml`, `go.mod`, `pyproject.toml`) for metadata
3. Glob for top-level source directories that represent modules or services. Common patterns:
   - Monorepo services: `accounts/`, `billing/`, `api/`, etc.
   - Single app layers: `src/api/`, `src/models/`, `src/services/`
   - Library packages: `packages/`, `crates/`, `internal/`
4. For each module/service directory, quickly scan for:
   - Route definitions (API endpoints)
   - Model/schema files (database models, types)
   - Entry points (index files, main files, server setup)
5. Identify the project type: monorepo with services, single app, library, CLI tool
6. Detect testing infrastructure as a first-class module category. Scan for:
   - Test runner configs: `vitest.config.*`, `jest.config.*`, `playwright.config.*`, `cypress.config.*`, `pytest.ini`, `pyproject.toml` (`[tool.pytest]` section), `bun.test.*`, `karma.conf.*`, `Makefile` test targets
   - Go-style inline tests: `*_test.go`
   - TypeScript/JS test patterns: `*.test.ts`, `*.test.tsx`, `*.spec.ts`, `*.spec.tsx`
   - Python test patterns: `test_*.py`, `*_test.py`
   - Test directories: `tests/`, `test/`, `__tests__/`, `e2e/`, `smoke/`, `integration/`
   - CI workflows: `.github/workflows/*.yml` lines that invoke test runners
   - Record detected runners, directories, and how tests are invoked (npm scripts, Makefile targets, raw commands)

   The **testing module** is always added to the project map, even when no tests are detected — in that case it represents an unfilled placeholder.

Store this as the **project map** — it drives the gap analysis.

---

## Step 2: Audit Existing Docs

Check for a documentation directory:

1. Glob for `docs/` at project root
2. Fallback: check `documentation/`, `doc/`
3. If no docs directory exists, create `docs/` and note that all docs are missing — skip to Step 4

If docs exist:

1. List all `.md` files in the docs directory
2. Read each file's first 5-10 lines to extract its heading and purpose
3. Map each doc to its corresponding module/topic:
   - `api-billing.md` → billing module
   - `architecture.md` → system-level
   - `data-model.md` → database/schema
   - `development.md` → setup/operations
   - `testing.md` → testing module (first-class category — always expected)
4. If `docs/test-readiness/` exists, list its `.md` files separately. Tag them as **authoritative test source** — they are produced by the `test-readiness` plugin and are not candidates for editing by `/research-docs`. Specifically watch for:
   - `test-system.md` — the test blueprint (primary source for `docs/testing.md`)
   - `test-readiness-plan.md` — roadmap and open work
   - `test-inventory.md` — code-area classification
   - `test-migration.md` — existing-test buckets
5. For each doc, run the staleness check from `references/doc-refresh-recipe.md` Part 1 (Staleness Detection). The recipe defines exactly which reference types to extract (file paths, endpoints, symbols, scripts, env vars), how to verify each, and the special case for `docs/testing.md` vs `docs/test-readiness/test-system.md` mtime. Mark each doc **current** or **stale** based on the recipe's output.

---

## Step 3: Gap Analysis

Compare the project map (Step 1) against the docs inventory (Step 2).

Categorize each module/topic:

- **Current** — has a doc, references are valid
- **Stale** — has a doc, but contains outdated references
- **Missing** — module exists in code but has no corresponding doc

`testing` is a **mandatory** topic — every project's doc set is expected to include `docs/testing.md` regardless of whether tests currently exist:
- If `docs/testing.md` is missing → mark as **missing** (always, even in a greenfield repo with no tests)
- If `docs/testing.md` exists and `docs/test-readiness/test-system.md` exists with a newer mtime → mark as **stale**
- The doc will be generated by Step 5's testing.md flow even when the project has no tests yet (in that case it is a placeholder stub)

If `$ARGUMENTS` was provided, filter to only the specified module/topic.

Present the audit summary:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
DOCS AUDIT
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

docs/ directory: {exists (N files) | created (empty)}

CURRENT:
  ✓ {filename} — {what it covers}

STALE:
  ⚠ {filename} — {what's outdated and why}

MISSING:
  ✗ {suggested filename} — {module/topic} has {N endpoints / N models / etc.}, no doc

TEST-READINESS:
  ◆ docs/test-readiness/{filename} — {role} (read-only; source for docs/testing.md)

Proceed? (Generate missing + update stale / Pick specific / Skip)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

Omit the TEST-READINESS section if `docs/test-readiness/` does not exist. Files listed there are reported for transparency only — `/research-docs` does not edit them.

Wait for user confirmation before writing any files.

---

## Step 4: Detect Doc Style

Before generating or updating, detect the project's existing doc conventions. If existing docs are present, analyze them:

1. **Naming pattern**: `api-{service}.md`, `{service}-api.md`, `{service}.md`, or `{topic}.md`
2. **Heading structure**: H1 title, H2 sections, H3 subsections — what patterns are used?
3. **Content patterns**: tables for endpoints? ASCII diagrams? Code examples? Inline bash commands?
4. **Level of detail**: service capability level (endpoints, CLI commands, MCP tools) vs function-level (exports, parameters)
5. **Opening format**: quote block? plain paragraph? badge/version line?

If no existing docs, use this default structure:

```markdown
# {Module Name}

> {One-line description of what this module does}

## Overview

{2-3 sentences on the module's role in the system}

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | /api/... | ... |

## Key Files

| File | Purpose |
|------|---------|
| src/... | ... |

## Data Models

{Key models/types this module owns or uses}
```

---

## Step 5: Generate Missing Docs

For each missing doc the user approved:

1. Read the module's source code:
   - Route/handler files → extract endpoints, methods, parameters
   - Model/schema files → extract types, fields, relationships
   - Entry point → understand module structure and exports
   - Test files → understand expected behavior
2. Generate the doc following the detected style from Step 4
3. Write the file to `docs/{detected-naming-pattern}.md`
4. Report what was created

For `docs/testing.md` specifically, use this structure (sections may be marked TODO when the project is greenfield):

```markdown
# Testing

> {One-line description of the project's testing approach}

## Layers

| Layer | Framework | Location | How to run | Speed budget |
|-------|-----------|----------|------------|--------------|
| Unit | {e.g., Vitest} | {e.g., src/**/*.test.ts} | {e.g., npm test} | {e.g., <50ms p95} |
| Integration | ... | ... | ... | ... |
| Smoke | ... | ... | ... | ... |
| E2E | ... | ... | ... | ... |

## Running tests

{Project commands — `bun test`, `npm test`, `go test ./...`, `pytest`, etc. Include any setup steps (test database, fixtures, env vars).}

## Conventions

{Naming, file location, fixture strategy, what to mock vs use real, how to add a new test.}

## CI gates

{Which tests run on PR, which on merge, which on deploy. Reference `.github/workflows/*` files.}

## Canary mode (if applicable)

{TEST_TARGET_URL contract; which tests run against a deployed env. Omit this section if the project doesn't have a canary suite.}

## References

- docs/test-readiness/test-system.md — full blueprint (if present)
- docs/test-readiness/test-readiness-plan.md — roadmap and open work (if present)
```

### Special case: `docs/testing.md`

This sub-flow always runs when `testing.md` is missing — there is no skip path. Pick exactly one of the three generation paths below based on what was detected.

**Path A — Authoritative source available.** `docs/test-readiness/test-system.md` exists. Digest it:

1. Read `docs/test-readiness/test-system.md` in full
2. Read `docs/test-readiness/test-readiness-plan.md` if it exists, to learn current state vs target
3. Extract into `docs/testing.md`:
   - Test layers in active use (which of unit / integration / smoke / E2E)
   - Framework per layer
   - Local-substitute strategy for external dependencies (docker, testcontainers, in-memory, recorded fixtures)
   - Speed budget per layer (p95 and hard cap if specified)
   - Canary contract (`TEST_TARGET_URL` mode), if defined
   - CI shape and repo-config requirements
4. Keep the digest concise (~150 lines max). Use the testing.md template from Step 4
5. Add a `## References` section that links back to `docs/test-readiness/test-system.md` and `docs/test-readiness/test-readiness-plan.md` for full detail

**Path B — Tests exist but no test-readiness blueprint.** No `docs/test-readiness/test-system.md`, but Step 1 detected runner configs and/or test files. Infer from observed state:

1. Frameworks observed (runner configs found in Step 1)
2. Test directories and naming patterns observed
3. How to run tests — extract from `package.json` scripts, `Makefile` targets, CI workflow command lines
4. Layer guess based on directory names (`unit/`, `integration/`, `e2e/`, `smoke/`) — if no explicit split, default to a single "unit + integration" row and mark smoke/E2E as TODO
5. Mark the doc as **inferred** with a note at the top: `> This document was inferred from observed test infrastructure. Run \`/test-design\` to produce an authoritative blueprint.`

**Path C — No tests at all.** Step 1 detected no runner configs and no test files. Generate a placeholder stub:

1. Suggest a stack-appropriate default framework based on the project manifest:
   - `package.json` (TypeScript/JS) → Vitest (or Jest if older patterns are present elsewhere)
   - `pyproject.toml` or `requirements.txt` → pytest
   - `go.mod` → built-in `go test`
   - `Cargo.toml` → built-in `cargo test`
2. Populate the layers table with `TODO` markers for unit / integration / smoke / E2E
3. Suggest a recommended directory layout for the detected stack
4. Add a prominent footer:
   ```
   ## Next steps

   This project has no tests yet. To plan a testing strategy, install the `test-readiness` plugin and run:

   1. `/test-inventory` — classify every code area and prescribe the canonical test layer
   2. `/test-design` — produce the authoritative test blueprint
   3. `/test-roadmap` — synthesize a phased plan
   ```

In all three paths, write the file to `docs/testing.md` (not under `docs/test-readiness/` — that subdirectory is owned by the test-readiness plugin).

---

## Step 6: Update Stale Docs

For each stale doc the user approved, follow the procedure in `references/doc-refresh-recipe.md` Part 2 (Section Rewrite). The recipe defines:

- How to map each broken reference back to a heading/section
- When to update vs remove vs replace vs delete a section
- What to preserve unconditionally (heading hierarchy, manual prose, diagrams, examples)
- The special case for `docs/testing.md` re-digest when only the test-system.md mtime check fired
- How to report per-doc changes

Use the `Edit` tool for focused section-level changes; only fall back to `Write` for the `docs/testing.md` re-digest case.

---

## Step 7: Update CLAUDE.md Reference

After generating or updating docs, check if `CLAUDE.md` has a reference or docs section (look for patterns like `@docs/`, `docs/`, or a "Reference" heading).

If it does:
- Add entries for any newly created docs, following the existing format
- Example: `- **docs/api-accounts.md** — accounts service API reference`

If it doesn't:
- Skip this step — don't create a reference section that doesn't already exist

---

## Step 8: Summary

Present a final summary of all changes:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
DOCS UPDATED
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Created:
  + docs/api-accounts.md (accounts service — 16 endpoints)
  + docs/api-gateway.md (API gateway routes)

Updated:
  ~ docs/api-cal.md (removed stale CalendarSync references, added new BookingType endpoints)

CLAUDE.md:
  + Added docs/api-accounts.md reference
  + Added docs/api-gateway.md reference

No action needed:
  ✓ docs/architecture.md
  ✓ docs/api-billing.md
  ✓ docs/api-time.md
  ✓ docs/data-model.md
  ✓ docs/development.md
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```
