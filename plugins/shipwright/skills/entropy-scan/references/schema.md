# Principles Schema Reference

This document describes the markdown format for Shipwright principles entries
(`references/principles.md`, and its project-level override at
`.claude/shipwright/principles.md`).

## File structure

Each principle is one `###` entry with a fixed field order:

```
### `<id>`

**Domain:** <architecture | testing | security | dead_code | todo_debt | docs>
**Severity:** <low | medium | high>

<statement prose — what to do and why>

**Detection:** <instruction for the scanning agent>
**PR-worthy:** <true | false>
**HITL:** <always | never | per-finding>
```

`**Detection:**`, `**PR-worthy:**`, and `**HITL:**` are only present together, on entries
that are entropy-scannable. Entries without a `**Detection:**` field are judgment-only —
read by `review`/`plan-session`/`dev-task` but never mechanically scanned by
`entropy-scan`/`entropy-fix`.

`##` headings group entries by domain for human readability, but the `**Domain:**` field
on each entry is what consumers key off — not the heading it's nested under.

---

## Field reference

### `id` (required)

Unique string identifier for the entry, given as the `###` heading text in backticks.
Use `snake_case`. Must be unique across all entries in the file.

```
### `dead_exports`
```

---

### `**Domain:**` (required)

Machine-authoritative grouping for the entry. `entropy-scan` maps each scannable entry's
domain to a report category:

| Domain | Report category |
|--------|-----------------|
| `security` | `security` |
| `dead_code` | `dead_code` |
| `todo_debt` | `todo_debt` |
| `architecture` | `inconsistent_patterns` |
| `docs` | `documentation_gaps` |

`testing` entries are judgment-only (no `**Detection:**` field) and do not map to a
report category — they're read by `plan-session`/`dev-task`/`review` for test-design
guidance, not scanned.

---

### `**Severity:**` (required)

How urgently the issue should be addressed.

| Value | When to use |
|-------|------------|
| `high` | Correctness or security risk; fix before next release |
| `medium` | Technical debt that will compound; fix this sprint |
| `low` | Cosmetic or low-impact; fix when convenient |

---

### Statement prose (required)

Human-readable description of what the entry covers and why it matters, written as
prose immediately after the `**Severity:**` field. Appears in the entropy report summary
and is read directly by judgment-only consumers (`review`, `plan-session`, `dev-task`).

---

### `**Detection:**` (present only on entropy-scannable entries)

Natural language instruction for the scanning Claude agent. This is the most important
field on a scannable entry — it determines scan quality. Write it like a task brief:

- Be specific enough that the agent can execute it without guessing
- Name the exact patterns, file paths, or AST constructs to look for
- Include what to exclude (test files, index.ts re-exports, etc.)
- Describe what to report (file path, line number, symbol name)
- Don't be so prescriptive that it breaks on minor project variations

**Example — good:**
```
**Detection:** For each .ts file under src/ (excluding *.test.ts and index.ts), check if
a corresponding .test.ts file exists in the same directory. Flag every source file with
no test coverage. Report: file path and line count.
```

**Example — too vague:**
```
**Detection:** Check if tests exist.
```

**Example — too prescriptive:**
```
**Detection:** Run `jest --coverage` and parse the JSON output for files with 0% coverage.
```

Omitting this field entirely marks the entry as judgment-only — it will not be scanned.

---

### `**PR-worthy:**` (present only alongside `**Detection:**`)

Whether `/entropy-fix` should queue a task-store task to address issues found by this entry.

```
**PR-worthy:** true    <!-- /entropy-fix will queue a task-store task -->
**PR-worthy:** false   <!-- /entropy-scan reports it; /entropy-fix skips it -->
```

Use `false` for entries where:
- The fix requires human judgment (e.g., whether a dead file should be deleted or revived)
- The fix is high-risk (e.g., deleting a file)
- The entry surfaces information rather than an actionable change

---

### `**HITL:**` (present only alongside `**Detection:**`, on `**PR-worthy:** true` entries)

Documents routing intent for how a PR-worthy finding should be classified:

| Value | Meaning |
|-------|---------|
| `always` | Every finding from this entry always routes to human-in-the-loop review |
| `never` | Findings route to an autonomous fix without human review |
| `per-finding` | Routing is decided per finding, at fix time |

This field is the authoritative routing source for entropy-fix. The skill reads it directly
(never → false, always → true, per-finding → agent judgment at runtime) to set the `hitl`
boolean on each queued task.

---

## Removing an entry

There is no `disabled` flag in this format. Omit an entry entirely from your project's
`.claude/shipwright/principles.md` override to stop it from running — it will not appear
anywhere in the entropy report ("No Violations" included).

---

## Complete example entry

```
### `missing_test_file`

**Domain:** testing
**Severity:** high

Source files in src/ that have no corresponding .test.ts file. Missing test coverage
compounds silently until a regression surfaces it the hard way.

**Detection:** For each .ts file under src/ (excluding *.test.ts, *.spec.ts, index.ts, and
type-only files that export only interfaces/types), check if a corresponding .test.ts
file exists in the same directory or a __tests__/ subdirectory. Flag every source file
with no test coverage file. Report: file path, file size (lines), approximate complexity
(does it export functions?).
**PR-worthy:** false
**HITL:** never
```

---

## Global config

**Age threshold** for the `stale_todo` / `todo_fixme_hack` entries defaults to 90 days
(`todo_max_age_days`). There is no per-project config field for this in the current
format — adjust the relevant entry's own `**Detection:**` text in a project override if
a different threshold is needed.
