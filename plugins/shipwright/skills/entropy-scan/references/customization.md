# Customizing Principles

Shipwright ships a default principles file (`references/principles.md`, relative to the
plugin root). You can customize it per project without modifying the plugin.

---

## Override path

Create a file at:

```
.claude/shipwright/principles.md
```

**Priority order** (highest to lowest):
1. `.claude/shipwright/principles.md` — project-local overrides
2. `<plugin-dir>/references/principles.md` — plugin defaults

When a local file exists, it is used **in its entirety** — individual entries from the
default file are not merged in. Start by copying the default and editing from there.

Only entries containing a `**Detection:**` field are entropy-scannable — everything else
is judgment-only (read by `review`/`plan-session`/`dev-task`, never mechanically scanned).
See `references/schema.md` for the full field reference.

---

## Common customizations

### Disable an entry you don't need

Omit it entirely from your local `principles.md` — entries not present in your local
file don't run.

> **Note:** Local config replaces the default entirely — there is no merging. Any entry
> you omit from your local copy will not run, even if it exists in the plugin defaults.

### Change severity

Edit the entry's `**Severity:**` field directly:

```
### `missing_test_file`

**Domain:** testing
**Severity:** medium   <!-- downgraded from high if your team is actively adding tests -->

...

**Detection:** ...
**PR-worthy:** false
```

### Add a project-specific entry

```
### `no_console_log_in_prod`

**Domain:** architecture
**Severity:** medium

console.log calls in non-test source files (use the logger module instead).

**Detection:** Search all .ts files under src/ (excluding *.test.ts) for console.log(),
console.warn(), console.error() calls. Flag any that are not inside a conditional block
gated on NODE_ENV === 'development' or process.env.DEBUG. Report: file, line number, call
text. The project uses a shared logger module at lib/logger.ts — all logging should go
through it.
**PR-worthy:** true
**HITL:** never
```

### Adjust the TODO age threshold

There is no per-project config field for this — adjust the `stale_todo` entry's own
`**Detection:**` text in your local `principles.md` to reference a different threshold
(default 90 days) if your project needs one.

---

## When to use local config vs. plugin defaults

**Use local config when:**
- Your project has language-specific patterns (Python, Go, etc.)
- You want stricter enforcement on specific domains
- A default entry generates too much noise for your codebase
- You have project-specific conventions (e.g., a required license header)

**Use plugin defaults when:**
- You're onboarding a new project and want a starting point
- The defaults match your team's norms

---

## Initializing local config

Run `/entropy-scan --init` to copy the default principles file to
`.claude/shipwright/principles.md`.

Then edit the file to match your project's norms.
