# The Principles-File Pattern

This is the canonical, skill-agnostic description of Shipwright's principles-file
customization pattern: the markdown schema principles entries follow, the
default/override semantics that let a project customize them without touching the
plugin, and the `--init` flow that seeds a project's override file. Any
principles-consuming skill's own docs should cite this file rather than
re-describing the pattern inline.

## Consumers today

| Consumer(s) | Override file | What it's used for |
|---|---|---|
| `entropy-scan`/`entropy-fix`, `review`, `plan-session`, `dev-task` | `.claude/shipwright/principles.md` | architecture/testing/security-domain judgment + entropy-scannable detection rules |
| `security-scan` | `.claude/shipwright/security-principles.md` | project-specific security-check customization |

Both override files, when a project creates one, are seeded from the same plugin
default: `references/principles.md` (relative to the plugin root) — the single
shared source-of-truth content file. Different consumers keep separate override
*paths* so a project can customize entropy-scan's judgment/detection entries
independently of security-scan's checks; the override *format* (below) is identical
for both.

---

## Schema

Each principle is one `###` entry with a fixed field order:

```
### `<id>`

**Domain:** <architecture | testing | security | dead_code | todo_debt | docs>
**Severity:** <low | medium | high>

<statement prose — what to do and why>

**Detection:** <instruction for a scanning agent>
**PR-worthy:** <true | false>
**HITL:** <always | never | per-finding>
```

- **`id`** — unique `snake_case` identifier, given as the `###` heading text in
  backticks (e.g. `` ### `dead_exports` ``). Must be unique across the file.
- **`**Domain:**`** (required) — machine-authoritative grouping. The `##` headings
  in a principles file are a presentation grouping for human readers only; a
  consumer keys off each entry's own `**Domain:**` field, not the heading it's
  nested under.
- **`**Severity:**`** (required) — `high` (correctness/security risk, fix before
  next release), `medium` (compounding tech debt, fix this cycle), or `low`
  (cosmetic, fix when convenient).
- **Statement prose** (required) — human-readable description of what the entry
  covers and why, written immediately after `**Severity:**`. Read directly by
  judgment-only consumers (e.g. `review`, `plan-session`, `dev-task`).
- **`**Detection:**`** (present only on scannable entries) — natural-language
  instruction for a scanning agent: specific enough to execute without guessing,
  naming exact patterns/paths/constructs to look for and what to report. Omitting
  this field marks the entry judgment-only — read by consumers for context, never
  mechanically scanned.
- **`**PR-worthy:**`** (present only alongside `**Detection:**`) — whether a fix
  skill should queue a task-store task for findings from this entry. `false` when
  the fix needs human judgment, is high-risk, or the entry is informational only.
- **`**HITL:**`** (present only alongside `**Detection:**`, on `**PR-worthy:** true`
  entries) — the authoritative routing source for a fix skill: `always` (every
  finding routes to human review), `never` (routes to an autonomous fix), or
  `per-finding` (decided per finding at fix time).

**Removing an entry:** there is no `disabled` flag in this format. Omit the entry
entirely from a project's override file to stop it from running/applying — it
simply won't appear anywhere in that consumer's output.

---

## Override semantics

- **Default:** `<plugin-dir>/references/principles.md` — the plugin's shipped
  content, read whenever a project has not created its own override.
- **Override:** `.claude/shipwright/<name>.md` in the target project's repo — the
  exact filename is consumer-specific (see the Consumers table above).
- **Priority order** (highest to lowest):
  1. `.claude/shipwright/<name>.md` — project-local override
  2. `<plugin-dir>/references/principles.md` — plugin default
- **No merging.** When a local override file exists, it is used **in its
  entirety** — individual entries from the default are not merged in. An entry
  omitted from the local file does not run, even if it exists in the plugin
  default. Projects that want to customize one entry typically start by copying
  the default file in full and editing from there.

---

## Init flow

Every principles-consuming skill that supports a `--init` flag follows the same
three-step shape:

1. **Check for an existing override.** If the skill's own override path already
   exists in the project root, print a message telling the user config already
   exists and to edit it directly — never overwrite a project's customized file —
   then stop.
2. **Seed from the default.** If it does not exist, create `.claude/shipwright/`
   (if needed) and copy the plugin's `references/principles.md` default to the
   skill's own override path.
3. **Confirm and stop.** Print a message confirming the file was created and
   pointing at how to edit it and re-run the skill. `--init` never runs the scan
   itself in the same invocation.

---

## Adding a new principles-consuming skill

1. Pick an override filename under `.claude/shipwright/` — reuse
   `principles.md` to share the existing architecture/testing/security judgment
   entries with `entropy-scan`/`dev-task`/`plan-session`/`review`, or pick a
   distinct name (as `security-scan` does with `security-principles.md`) when the
   new skill's customization needs diverge from those consumers'.
2. Implement the three-step `--init` flow above.
3. Implement a load step: check for the override path first, fall back to the
   plugin default, and treat a missing default as the "nothing configured yet"
   case.
4. Cite this document as the canonical description of the pattern in the new
   skill's own docs, rather than re-describing the schema/override/init
   mechanics inline.
