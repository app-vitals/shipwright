# Doc Refresh Recipe

Shared reference for keeping a single `docs/*.md` file in sync with the current codebase. Consumed by:

- `commands/research-docs.md` — full repo audit (Steps 2 and 6)
- `agents/docs-refresher.md` — targeted refresh of docs affected by a branch diff (called from `dev-task` Step 8.5)

Both paths use the same staleness rules and the same section-rewrite procedure so the manual and auto flows can't drift apart.

---

## Part 1: Staleness Detection

A doc is **stale** when references inside it no longer match what's in the codebase. Run these checks against a single doc and return one of:

- **current** — every checked reference still resolves
- **stale** — at least one reference is broken; record which ones
- **untouched** — no detectable references to changed code (only relevant when a diff is provided)

### Reference extraction

From the doc, extract candidates to verify:

1. **File paths** — anything matching `src/...`, `packages/...`, `crates/...`, `internal/...`, a `*.ts`/`*.tsx`/`*.go`/`*.py`/`*.rs`/`*.rb` filename, or a path in a code fence
2. **API endpoints** — lines in endpoint tables: `| GET | /api/foo | ... |`; also inline `GET /api/foo`, `POST /api/foo` patterns
3. **Function / class / model names** — symbols in code fences, inline backticks containing CamelCase or snake_case identifiers
4. **CLI commands** — bash code fences (`npm run …`, `cargo test`, `bun run …`) — verify the underlying script still exists in `package.json`, `Makefile`, or equivalent
5. **Environment variables** — `ALL_CAPS_NAMES` in backticks — verify they appear in source, `.env.example`, or config files

### Verification rules

For each extracted reference, decide:

| Check | Method | Stale if |
|-------|--------|----------|
| File path | `Glob` for the path | File no longer exists |
| Endpoint | `Grep` for the path + method in route definitions | No matching route handler found |
| Symbol | `Grep` for `function {name}\|class {name}\|const {name}\|model {name}\|def {name}\|fn {name}` | No definition found anywhere |
| Script | Read `package.json`/`Makefile`/equivalent | Script name absent |
| Env var | `Grep` for the name in source + config | Not referenced anywhere |

**Skip these — they are not staleness signals:**

- Manually-written prose, explanations, design rationale
- ASCII or Mermaid diagrams (rewrite only on explicit author intent)
- Example snippets that don't claim to mirror current code
- External links (don't grade local docs based on external sites)
- References inside `## References` sections — those point to other docs by design

### Special case: `docs/testing.md`

In addition to the rules above, mark `docs/testing.md` stale if **both** are true:

1. `docs/test-readiness/test-system.md` exists
2. Its mtime is newer than `docs/testing.md`

The digest is out of sync with its authoritative source — re-digest it.

### Output

For the doc under review, return either:

```
current
```

…or:

```
stale
  - file path: src/api/old-handler.ts (removed)
  - endpoint:  POST /api/legacy (no handler)
  - symbol:    LegacyService (no definition)
```

The list of broken references becomes the input to Part 2.

---

## Part 2: Section Rewrite

Given a stale doc and its list of broken references, rewrite **only the affected sections** — never the whole file.

### Procedure

1. **Read the doc in full.** Identify its heading hierarchy.
2. **Read the corresponding source.** For each module the doc covers, load the current routes/handlers/models/scripts.
3. **Map each broken reference to a section.** Use the heading immediately above the reference. If a reference appears in multiple sections, treat them as separate edit targets.
4. **For each affected section, decide the operation:**
   - **Update** — the section is still relevant but contains stale facts. Replace the broken parts with current ones; keep the surrounding structure intact.
   - **Remove row** — for table entries (endpoint, file table) where the underlying thing is gone with no replacement. Delete the row, keep the table.
   - **Replace** — the section described a removed component that's been wholly replaced. Rewrite the section to cover the new component.
   - **Delete section** — the section described something removed with no replacement and the section's heading would otherwise be orphaned. Delete the heading and body.
5. **Preserve everywhere:**
   - Heading hierarchy and order (don't re-shuffle sections)
   - Manually-written context, explanations, design rationale
   - Diagrams and examples that don't reference removed code
   - The doc's existing tone, terminology, and formatting conventions
6. **Use the `Edit` tool** with focused old/new strings — one edit per affected section. Avoid `Write` (whole-file overwrite) unless the doc is being recreated from scratch.

### Special case: `docs/testing.md` re-digest

If the only staleness signal was the test-system.md mtime check, treat this as a full re-digest rather than line edits:

1. Read `docs/test-readiness/test-system.md` in full
2. Read `docs/test-readiness/test-readiness-plan.md` if present
3. Regenerate `docs/testing.md` via the Path A flow in `commands/research-docs.md` Step 5 (digest, ~150 lines)
4. Keep the existing `## References` block

### After editing

Report what was changed per doc:

```
docs/api-billing.md
  - Removed row: DELETE /api/billing/legacy-export (handler gone)
  - Updated section "Data Models": LegacyInvoice → Invoice
  - Updated section "Key Files": src/billing/v1.ts → src/billing/index.ts
```

This per-doc report rolls up into the dev-task metrics block (`auto_docs.files_changed`, `auto_docs.lines_changed`).

---

## Scoping the work

The two callers differ only in **which docs are checked**:

| Caller | Doc set | Diff context |
|--------|---------|--------------|
| `/research-docs` (full audit) | Every `.md` under `docs/` | No diff — check against current codebase as a whole |
| `docs-refresher` agent (targeted) | Only docs that contain a reference to anything in `git diff main...HEAD` | Has a diff — pre-filter the doc set before running Part 1 |

For the targeted path, before running Part 1 on each doc:

1. List changed files: `git diff --name-only main...HEAD`
2. For each `docs/*.md`, `grep` for any changed filename, changed symbol, or changed endpoint
3. Only docs with at least one match enter Part 1

This avoids re-auditing the whole `docs/` tree on every dev-task — most docs are untouched by most tasks.

---

## What this recipe does NOT cover

- **Generating brand-new docs** — see `commands/research-docs.md` Steps 4–5 (Style Detection, Generate Missing Docs). The recipe is for keeping existing docs current.
- **The full audit summary UI** — the `DOCS AUDIT` block with user confirmation is research-docs-specific (manual flow only).
- **Updating CLAUDE.md references** — research-docs Step 7 owns that; the auto-refresher does not touch CLAUDE.md.
- **`docs/test-readiness/` files** — read-only; never edited by either caller.
