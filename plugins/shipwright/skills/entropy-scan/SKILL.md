---
name: entropy-scan
description: Scan codebase for principle deviations. Report only — no code changes.
---

# Entropy Scan

Scan the codebase for principle violations and write a structured report. This skill makes **no code changes** — it reads and reports only. Use `/entropy-fix` to act on the findings.

---

## Setup: Parse Arguments

Before starting, check if any flags were passed:

- `--init` — copy the default principles file to the project and exit (no scan)
- `--summary` — print category counts to stdout; skip writing `entropy-report.md` or `quality-log.jsonl`
- `--trend` — read `.entropy-patrol/quality-log.jsonl` and print a trend summary; skip the scan entirely

---

## Step 0: Handle `--trend` Flag

If the `--trend` flag was passed:

1. Look for `.entropy-patrol/quality-log.jsonl` in the project root.
2. If it does not exist, print:
   ```
   No scan history found. Run /entropy-scan a few times to build trend data.
   ```
   Then stop.
3. Read the file. Parse each line as JSON; skip malformed lines silently.
4. If fewer than 2 valid entries, print:
   ```
   Not enough scan history for trends (need at least 2 runs).
   Current entry count: {N}. Run /entropy-scan again to build history.
   ```
   Then stop.
5. Load the most recent `--window N` entries (default: 30). If `--window` is not specified, use 30.
6. Print a trend summary:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
ENTROPY TREND ({first_date} → {last_date}, {N} scans)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

OVERALL
  {first_scan_total} violations → {last_scan_total} violations  ({delta, e.g. "▼ 10" or "▲ 3" or "— no change"})

BY SEVERITY
  High    {first} → {last}  ({direction})
  Medium  {first} → {last}  ({direction})
  Low     {first} → {last}  ({direction})

BY RULE (most changed first)
  {rule_id}       {first} → {last}  ({direction})  {most improved label if applicable}
  ...

MOST IMPROVED:   {rule_id} (▼ {N} violations)
MOST WORSENING:  {rule_id} (▲ {N} violations)   {or "none — all rules stable or improving"}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

7. Stop — do not run a scan.

---

## Step 1: Handle `--init` Flag

If the `--init` flag was passed:

1. Check if `.claude/shipwright/principles.md` already exists in the project root.
   - If it exists, print: "Config already exists at `.claude/shipwright/principles.md`. Edit it to customize principles for this project." and stop.
2. If it does not exist, create the directory and copy the default principles file:
   - Source: `references/principles.md` (relative to the plugin root — the plugin's own shared principles file)
   - Destination: `.claude/shipwright/principles.md` in the project root
3. Print: "Created `.claude/shipwright/principles.md`. Edit it to customize principles for this project. Re-run `/entropy-scan` to start scanning."
4. Stop — do not run the scan.

---

## Step 2: Load Principles

1. Check for a project-level override: `.claude/shipwright/principles.md` in the project root.
2. If it exists, load it. Print: "Using project config: `.claude/shipwright/principles.md`"
3. If it does not exist, load the plugin default: `references/principles.md` (relative to the plugin root). Print: "No project config found. Using default principles. Run `/entropy-scan --init` to customize."
4. If neither file exists, print: "No principles found. Run `/entropy-scan --init` to get started." and stop.
5. Parse the markdown. Each `###` heading starting a rule entry; read its `**Domain:**`, `**Severity:**`, prose statement, and (if present) `**Detection:**`, `**PR-worthy:**`, and `**HITL:**` fields. `todo_max_age_days` defaults to 90 (no per-project override in this format — a project's `.claude/shipwright/principles.md` override can adjust the `stale_todo` entry's own Detection text if a different threshold is needed).
6. **Filter to only entries containing a `**Detection:**` field** — these are the entropy-scannable rules; everything else is judgment-only (read by `review`/`plan-session`/`dev-task`, never mechanically scanned). Map each scannable entry's `**Domain:**` to a report category: `security` → `security`, `dead_code` → `dead_code`, `todo_debt` → `todo_debt`, `architecture` → `inconsistent_patterns`, `docs` → `documentation_gaps`. Print the count of scannable entries.

---

## Step 3: Run the Scan

For each active rule (in order: security first, then high → medium → low severity within each category), run the detection described in the rule's `detection_hint`. Use Read, Grep, and Glob tools to gather evidence.

**Important:**
- Work category by category, not rule by rule — this reduces redundant file reads
- For each finding, record: `file_path`, `line_number` (if applicable), `rule_id`, `severity`, `description` (one line describing the specific issue), `estimated_fix_effort` (trivial / small / medium)
- Stick to the `detection_hint` — do not expand scope or make judgment calls beyond what the hint describes
- If a rule scan turns up nothing, that is a valid result ("no violations")
- Cap the scan: if any single category scan takes more than 20 sequential tool calls, record a note: "Scan capped — partial results for this category" and move on

**Order of categories:**
1. `security` (highest stakes — always first)
2. `dead_code`
3. `todo_debt`
4. `inconsistent_patterns`
5. `documentation_gaps`

Within each category, process high-severity rules before medium before low.

---

## Step 4: Write the Report

If `--summary` flag was passed, skip to Step 5.

Write `entropy-report.md` to the project root (overwrite if it exists). Format:

```markdown
# Entropy Report

**Generated:** {YYYY-MM-DD HH:MM} {timezone}
**Config:** {project override path | "plugin default"}
**Rules scanned:** {count scannable entries} / {count total entries}

## Summary

| Category | High | Medium | Low | Total |
|----------|------|--------|-----|-------|
| security | N | N | N | N |
| dead_code | N | N | N | N |
| todo_debt | N | N | N | N |
| inconsistent_patterns | N | N | N | N |
| documentation_gaps | N | N | N | N |
| **Total** | **N** | **N** | **N** | **N** |

---

## Findings

### {category name}

#### {rule.id} — {rule.description} `{severity}`

{If no findings: "No violations found."}

{If findings exist, list as checkboxes:}
- [ ] `{file_path}:{line_number}` — {one-line description of the specific issue} _{estimated_fix_effort}_

{Repeat for each finding in this rule}

---

{Repeat section for each category that has findings}

## No Violations

{List any categories or rules with zero findings here, as a quick confirmation they were checked.}

---
_Run `/entropy-fix` to open PRs for `PR-worthy: true` violations._
_Run `/entropy-scan --init` to create a project-level config for rule customization._
```

Rules:
- Findings are sorted high → medium → low within each category section
- Each finding is a checkbox (`- [ ]`) so `/entropy-fix` can track which ones have been addressed
- Include line numbers when available: `- [ ] \`{file_path}:{line_number}\` — {description} _{effort}_`
- For file-level findings (no line number): `- [ ] \`{file_path}\` — {description} _{effort}_`
- The "No Violations" section at the bottom lists all scannable entries where nothing was found — this confirms the entry ran and passed. Entries omitted from a project's `.claude/shipwright/principles.md` override do not appear anywhere in the report.

---

## Step 5: Print Summary

Whether or not `--summary` was passed, always print a summary to stdout after the scan (or instead of writing the report, if `--summary` was passed):

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
ENTROPY SCAN COMPLETE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  HIGH     {N} findings
  MEDIUM   {N} findings
  LOW      {N} findings
  ─────────────────────
  TOTAL    {N} findings across {N} rules

TOP ISSUES
──────────
{List up to 3 highest-severity findings, one line each:}
  {severity} · {rule_id} · {file_path} — {description}

{If any high-severity findings exist:}
  ⚠️  Run /entropy-fix to open PRs for PR-worthy violations.

{If zero findings:}
  ✓ No violations found. Codebase is clean against active rules.

{If --summary flag: no report written.}
{Otherwise:}
  Report written to: entropy-report.md

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

---

## Step 6: Append to Quality Log

If `--summary` flag was NOT passed (i.e., a full scan with report write):

1. Build the log entry:
   ```json
   {
     "timestamp": "<current UTC ISO-8601>",
     "commitSha": "<short git sha from `git rev-parse --short HEAD`; omit field if git unavailable>",
     "totalViolations": <total findings count>,
     "bySeverity": {
       "high": <count>,
       "medium": <count>,
       "low": <count>
     },
     "byRule": {
       "<rule_id>": <count>
       // Only include rules with at least 1 finding
     },
     "reportPath": "entropy-report.md"
   }
   ```
2. Create `.entropy-patrol/` directory in the project root if it doesn't exist.
3. Append the JSON entry (as a single line) to `.entropy-patrol/quality-log.jsonl`.
   - Append only — never overwrite or truncate existing entries.
4. Print: `Quality log updated: .entropy-patrol/quality-log.jsonl`

Schema reference: `skills/entropy-scan/references/quality-log-schema.md`

---

## Constraints (Do Not Violate)

- **No code changes.** This skill reads and reports only. The only files written are `entropy-report.md` and `.entropy-patrol/quality-log.jsonl`.
- **No git operations.** Do not commit, branch, or stage anything.
- **No PR creation.** That belongs to `/entropy-fix`.
- **No network calls.** All detection is local file inspection.
- **Respect the project override.** If a project's `.claude/shipwright/principles.md` omits an entry present in the plugin default, treat it as not scanned — not even "just to check."
- **One scan, one report.** Each run fully overwrites `entropy-report.md`. Previous results are not preserved.
- **Quality log is append-only.** Never overwrite or truncate `.entropy-patrol/quality-log.jsonl`. Appends only.
- **`--summary` skips log.** When `--summary` is passed, no log entry is written (no report = no log entry).
