# Customizing Golden Principles

entropy-patrol ships with a default ruleset (`skills/entropy-scan/golden-principles.yaml`). You can customize it per project without modifying the plugin.

---

## Override path

Create a file at:

```
.claude/entropy-patrol/golden-principles.yaml
```

**Priority order** (highest to lowest):
1. `.claude/entropy-patrol/golden-principles.yaml` — project-local overrides
2. `<plugin-dir>/skills/entropy-scan/golden-principles.yaml` — plugin defaults

When a local config exists, it is used **in its entirety** — individual rules from the default config are not merged in. Start by copying the default and editing from there.

---

## Common customizations

### Disable a rule you don't need

```yaml
rules:
  - id: commented_out_blocks
    disabled: true
    # ... rest of fields recommended so the rule is ready to re-enable
```

Or omit it entirely — rules not present in your local config don't run.

> **Note:** Local config replaces the default entirely — there is no merging. Any rule you omit from your local copy will not run, even if it exists in the plugin defaults.

### Change severity

```yaml
rules:
  - id: missing_test_file
    category: missing_tests
    severity: medium   # downgrade from high if your team is actively adding tests
    description: Source files in src/ that have no corresponding .test.ts file
    detection_hint: |
      ...
    pr_worthy: false
```

### Add a project-specific rule

```yaml
rules:
  - id: no_console_log_in_prod
    category: inconsistent_patterns
    severity: medium
    description: console.log calls in non-test source files (use the logger module instead)
    detection_hint: |
      Search all .ts files under src/ (excluding *.test.ts) for console.log(), console.warn(),
      console.error() calls. Flag any that are not inside a conditional block gated on
      NODE_ENV === 'development' or process.env.DEBUG. Report: file, line number, call text.
      The project uses a shared logger module at lib/logger.ts — all logging should go through it.
    pr_worthy: true
```

### Adjust the TODO age threshold

```yaml
todo_max_age_days: 60   # flag TODOs older than 60 days instead of the default 90
```

---

## When to use local config vs. plugin defaults

**Use local config when:**
- Your project has language-specific patterns (Python, Go, etc.)
- You want stricter enforcement on specific categories
- A default rule generates too much noise for your codebase
- You have project-specific conventions (e.g., a required license header)

**Use plugin defaults when:**
- You're onboarding a new project and want a starting point
- The defaults match your team's norms

---

## Initializing local config

Run `/entropy-scan --init` to copy the default ruleset to `.claude/entropy-patrol/golden-principles.yaml`.

Then edit the file to match your project's norms.
