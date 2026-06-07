# Golden Principles Schema Reference

This document describes the YAML format for entropy-patrol rule definitions.

## File structure

```yaml
version: "1.0"

rules:
  - id: <rule_id>
    category: <category>
    severity: <severity>
    description: <one-line description>
    detection_hint: |
      <multi-line instruction for the scanning agent>
    pr_worthy: <true|false>
    disabled: <true|false>   # optional; omit to enable

todo_max_age_days: 90        # global config for stale_todo threshold
```

---

## Field reference

### `id` (required)

Unique string identifier for the rule. Use `snake_case`. Must be unique across all rules in the file.

```yaml
id: dead_exports
```

---

### `category` (required)

Logical grouping for the rule. Used to organize the entropy report and filter rules by type.

| Category | What it covers |
|----------|---------------|
| `dead_code` | Unused exports, unreferenced files, commented-out blocks |
| `missing_tests` | Source files without test coverage |
| `inconsistent_patterns` | Duplicated utilities, inconsistent error handling |
| `todo_debt` | TODO/FIXME/HACK comments |
| `documentation_gaps` | Missing JSDoc, missing README sections |
| `security` | Ungated outbound calls, hardcoded secrets |

You may define custom category strings for project-specific rules (e.g., `performance`, `accessibility`).

---

### `severity` (required)

How urgently the issue should be addressed.

| Value | When to use |
|-------|------------|
| `high` | Correctness or security risk; fix before next release |
| `medium` | Technical debt that will compound; fix this sprint |
| `low` | Cosmetic or low-impact; fix when convenient |

---

### `description` (required)

One-line human-readable description of what the rule detects. Appears in the entropy report summary.

```yaml
description: Exported functions that are never imported anywhere in the codebase
```

---

### `detection_hint` (required)

Natural language instruction for the scanning Claude agent. This is the most important field — it determines scan quality. Write it like a task brief:

- Be specific enough that the agent can execute it without guessing
- Name the exact patterns, file paths, or AST constructs to look for
- Include what to exclude (test files, index.ts re-exports, etc.)
- Describe what to report (file path, line number, symbol name)
- Don't be so prescriptive that it breaks on minor project variations

**Example — good:**
```yaml
detection_hint: |
  For each .ts file under src/ (excluding *.test.ts and index.ts), check if a
  corresponding .test.ts file exists in the same directory. Flag every source
  file with no test coverage. Report: file path and line count.
```

**Example — too vague:**
```yaml
detection_hint: Check if tests exist.
```

**Example — too prescriptive:**
```yaml
detection_hint: Run `jest --coverage` and parse the JSON output for files with 0% coverage.
```

---

### `pr_worthy` (required)

Whether `/entropy-fix` should open a pull request to address issues found by this rule.

```yaml
pr_worthy: true   # /entropy-fix will open a PR (max 3 files per PR)
pr_worthy: false  # /entropy-scan reports it; /entropy-fix skips it
```

Use `false` for rules where:
- The fix requires human judgment (e.g., whether a dead file should be deleted or revived)
- The fix is high-risk (e.g., deleting a file)
- The rule surfaces information rather than an actionable change

---

### `disabled` (optional)

Set to `true` to skip a rule without deleting it. Useful for disabling a default rule that doesn't apply to your project.

```yaml
disabled: true
```

Omit this field (or set to `false`) to enable the rule.

---

## Complete example rule

```yaml
- id: missing_test_file
  category: missing_tests
  severity: high
  description: Source files in src/ that have no corresponding .test.ts file
  detection_hint: |
    For each .ts file under src/ (excluding *.test.ts, *.spec.ts, index.ts, and
    type-only files that export only interfaces/types), check if a corresponding
    .test.ts file exists in the same directory or a __tests__/ subdirectory.
    Flag every source file with no test coverage file.
    Report: file path, file size (lines), approximate complexity (does it export functions?).
  pr_worthy: false
```

---

## Global config fields

These appear at the top level of the YAML file (not inside `rules`).

| Field | Default | Description |
|-------|---------|-------------|
| `todo_max_age_days` | `90` | Age threshold for `stale_todo` rule (in days) |
| `version` | `"1.0"` | Schema version — used for future migration |
