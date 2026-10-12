---
name: prompt-scan
description: "Audit the plugin's prompts (CLAUDE.md, skills, commands, agents) for token cost, staleness, structure and instruction-density problems, and track findings across runs. Report only — no prompt edits. Flags: --summary, --dry-run, --model <id> (repeatable), --scope <path>, --with-doctor, --since-days <n>."
---

# /prompt-scan

Run the deterministic prompt-audit rules (`scripts/prompt-audit/cli.ts scan`), add a
judgment pass for class (e) `move-to-path-rule` and class (d) dated-model patterns,
suppress findings the decisions registry already accepted, and track everything in
`state/prompt-audit-ledger.json`. Report only — no prompt edits.

**Flags:**
- `--summary` — print counts to stdout without writing `prompt-audit-report.md` (ledger still updates)
- `--dry-run` — run the full scan but skip writing both `prompt-audit-report.md` and `state/prompt-audit-ledger.json`; print what would have been written instead
- `--model <id>` — model to count tokens for; repeatable. Default: `[ANTHROPIC_MODEL, claude-sonnet-5-5, claude-sonnet-4-6]`
- `--scope <path>` — limit the report to findings under this path
- `--with-doctor` — run class (d) detection through `/doctor prompt-audit` first, falling back to the inline checklist
- `--since-days <n>` — usage window for the invocation-cost rules (default 28)

Invoke the prompt-scan skill.
