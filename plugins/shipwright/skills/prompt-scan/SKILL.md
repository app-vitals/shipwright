---
name: prompt-scan
description: Audit the plugin's prompts for token cost, stale references, structure and instruction-density problems, suppress findings the decisions registry accepted, and track the rest in a ledger. Report only — no prompt edits.
---

# Prompt Scan

Survey every prompt surface the agent loads (CLAUDE.md files and imports, `.claude/rules`,
skills, commands, agents, templates) for cost and quality problems, and track findings
across runs in `state/prompt-audit-ledger.json`. The mechanical rules run in
`plugins/shipwright/scripts/prompt-audit/cli.ts`; this skill adds the judgment passes the
rules cannot make, applies the decisions registry, and owns the ledger and report writes.
This skill makes **no prompt edits** — it reads and reports only. Turning findings into
changes is the job of a later `prompt-fix` run.

**Scope note — how this differs from `consolidation-scan`:** same shape (parse args, load
registry, load ledger, scan, judge, fingerprint and merge, suppress, write, summarize), but
the candidates come from deterministic rules with stable fingerprints rather than from
open-ended survey. Judgment is confined to two classes: (e) `move-to-path-rule` and (d)
dated-model patterns. Rule thresholds are in `references/thresholds.md`; the ledger shape
is in `references/ledger-schema.md`.

---

## Setup: Parse Arguments

- `--summary` — print counts to stdout; skip writing `prompt-audit-report.md`
- `--dry-run` — run everything but skip writing `prompt-audit-report.md` **and**
  `state/prompt-audit-ledger.json`; print what would have been written instead
- `--model <id>` — repeatable. Models to count tokens for. Default:
  `[ANTHROPIC_MODEL, claude-sonnet-5-5, claude-sonnet-4-6]` (drop `ANTHROPIC_MODEL` if unset,
  de-duplicate)
- `--scope <path>` — limit report and summary to findings whose file starts with this path
  (the ledger merge still sees every finding; see Step 6)
- `--with-doctor` — try `/doctor prompt-audit` for class (d) detection (Step 5)
- `--since-days <n>` — usage window for the invocation-cost rules; default 28

---

## Step 1: Load the Decisions Registry (Suppressions)

See `references/decisions-registry.md` for the shared decisions-registry pattern this
mirrors — the generic entry schema, ownership, and consumption contract that
`.claude/shipwright/prompt-audit-decisions.md` is the third concrete instance of.

1. Check for `.claude/shipwright/prompt-audit-decisions.md` in the project root.
2. **If it does not exist**, print "No prompt-audit-decisions.md found — no suppressions configured."
   and continue with an empty list. This is not an error.
3. **If it exists**, parse it defensively: each `###` entry carries a **Finding** (rule id
   and file), **Decision**, **Rationale** and **Revisit**. Skip any entry you cannot
   confidently interpret rather than failing the whole load. An optional **Autonomy**
   field belongs to `prompt-fix`; ignore it here.
4. Print the count, e.g. "Loaded 1 accepted-cost entry from prompt-audit-decisions.md."

The registry is human-edited and never written by this skill. It is re-read live every
run; never reuse a suppression decision from a prior run.

---

## Step 2: Load the Ledger

1. Read `state/prompt-audit-ledger.json` (agent workspace state, git-ignored).
2. If it does not exist, use the empty ledger from `references/ledger-schema.md`. This is a
   normal first run.
3. If it exists but cannot be parsed, or has no `findings` object, stop and report the
   error. Do not overwrite a ledger you could not read.
4. Keep the full ledger in memory; every existing entry is written back in Step 7.

---

## Step 3: Run the Deterministic Scan

Always run the CLI with `--dry-run` so it writes nothing: this skill owns the ledger and
report writes, because suppression must be applied before either is written.

```bash
bun run plugins/shipwright/scripts/prompt-audit/cli.ts scan --json --dry-run \
  [--model <id>]... [--since-days <n>]
```

Do not pass `--scope` here; scoping is applied to output only (Step 8).

Parse the JSON: `scannedAt` (commit sha), `models`, `baselines` and `findings`. Each finding
has `fingerprint`, `class`, `rule`, `file`, `evidence`, `metrics`, `measurement`, `claim`
and `blastRadius`. If the CLI exits non-zero, stop and report its output.

---

## Step 4: Judgment Pass — Class (e) `move-to-path-rule`

The rule fires on a `##` section of an always-loaded CLAUDE.md or import that is
path-specific. A rule hit is a candidate; this pass decides whether to keep it.

For each `move-to-path-rule` finding, read the section and confirm:

1. The section's guidance genuinely applies only when files under the named directory are
   being read or edited. Guidance that is also needed elsewhere (shared conventions, an
   incident-derived warning, anything the directory's neighbours rely on) is **not** a move
   candidate. Drop the finding.
2. A `.claude/rules/<name>.md` with a `paths:` glob covering that directory would load the
   section when it matters, and nothing outside it. Record the proposed glob in the finding's
   `evidence`.

Keep only the confirmed findings. These are quality-claimed: the move changes when the text
loads, so the report must say an eval is required and unchanged quality is unmeasured.
Stay conservative; when in doubt, drop the finding. The rule fires again next run if it
was real.

---

## Step 5: Judgment Pass — Class (d) Dated-Model Patterns

Class (d) has no rule function. Look for prompt text that encodes a belief about an older
model and may no longer be needed: retired or pinned model ids in prose, shouting or
repeated-reminder workarounds written for a weaker model, compensating scaffolding such as
forced step-by-step restatement, and stale capability or limit claims.

1. **Detect.** With `--with-doctor`, invoke `/doctor prompt-audit` first and take its
   findings. If `/doctor` is unavailable, or `--with-doctor` was not passed, use the inline
   checklist from the `claude-api` skill instead: its guidance on current model ids,
   deprecated parameters and prompting patterns that newer models no longer need. Read the
   checklist, then scan the prompt surface from the Step 3 inventory against it.
2. **Record** each hit as a class `d` finding with a rule name, file, and short evidence
   sentence free of counts and line numbers. Fingerprint it with the same formula as the
   CLI: `sha256(class|rule|file|normalizedEvidence)[:12]`.
3. **Promote only after two consecutive runs.** A class (d) finding is judgment-only, so one
   observation is not evidence. In Step 6, `consecutiveRuns` increments when a class (d)
   fingerprint is seen again and resets to `0` when a previously tracked one is missed. It
   moves from `tracking` to `proposed` at `consecutiveRuns >= 2`. Class (d) findings are
   never reported before then.

---

## Step 6: Fingerprint, Suppress and Merge

1. Combine the CLI findings (minus any dropped in Step 4) with the class (d) findings.
2. **Suppress via the registry.** For each finding, compare it to each registry entry's
   **Finding** by reading both and deciding whether they describe the same rule on the same
   file. This is a judgment match, not exact-string equality, as in
   `references/decisions-registry.md`. A match suppresses the finding unless the entry's
   **Revisit** condition is now met (a stated threshold exceeded, a stated event occurred, a
   date passed), in which case the entry no longer applies. Check the condition live against
   current baselines and files.
3. **Merge into the ledger** with the semantics in `references/ledger-schema.md` (they mirror
   `mergeScan`):
   - New fingerprint: `tracking`, or `suppressed` when the registry matches. Set
     `firstSeen`/`lastSeen` to this run, `runsSeen: 1`, and a `first-seen` history event.
   - Matched fingerprint: refresh the finding fields, `lastSeen`, `runsSeen` + 1. A registry
     match on a non-`suppressed` entry sets `suppressed` (history event `suppressed`). A
     `suppressed` entry the registry no longer matches, or a `resolved` entry that
     reproduces, returns to `tracking` (history event `reappeared`).
   - Absent fingerprint: leave unchanged, except `queued` and `measured` entries, which
     become `resolved` (`stopped-reproducing`).
   - Never truncate `history`.
4. Merge the **full** finding set. `--scope` must not shrink it, or every out-of-scope
   `queued`/`measured` entry would be falsely resolved.
5. Replace `models` and `baselines` with this run's values and set `lastRun` to the current
   UTC ISO-8601 timestamp.

---

## Step 7: Write the Ledger

Skip this step if `--dry-run` was passed; print the ledger that would have been written.

Overwrite `state/prompt-audit-ledger.json` with the full merged ledger (two-space indent,
trailing newline). Print: `Ledger updated: state/prompt-audit-ledger.json`

---

## Step 8: Write the Report

Skip this step if `--summary` or `--dry-run` was passed.

Write `prompt-audit-report.md` to the project root, overwriting any existing file, using the
layout `scripts/prompt-audit/report.ts` renders: header, always-loaded baseline table,
skill-listing budget table, then one section per finding class sorted by projected weekly
token saving. Rules:

- List only findings that are not `suppressed`, `resolved` or class (d) still in `tracking`.
  Suppressed findings appear as a count in the header, not as entries.
- Label every finding **cost-only** or **quality-claimed**. A cost-only entry states that
  tokens fall for certain and quality is unmeasured. A quality-claimed entry states the eval
  it needs.
- Apply `--scope` here: drop findings whose file is outside the path.

---

## Step 9: Print Summary

Always print a summary, whatever the flags:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
PROMPT SCAN COMPLETE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  Models:                           {list}
  Findings this run:                {N}   (class a/b/c/d/e/f: {n}/{n}/{n}/{n}/{n}/{n})
  New findings tracked:             {N}
  Suppressed by decisions registry: {N}
  Class (d) awaiting 2nd run:       {N}

{If --dry-run: "Dry run — no files written."}
{Else if --summary: "Summary only — prompt-audit-report.md not written; ledger still updated."}
{Else: "Report written to: prompt-audit-report.md"}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

---

## Constraints (Do Not Violate)

- **No prompt edits.** The only files written are `state/prompt-audit-ledger.json` and
  `prompt-audit-report.md`, and neither is written under `--dry-run`.
- **No git operations and no task-store writes.** `git` is used read-only by the CLI for
  blame age. Filing `prompt-fix` tasks belongs to a later skill.
- **Never let the CLI write.** Step 3 always passes `--dry-run`; otherwise it would write
  the ledger before suppression is applied.
- **The decisions registry is authoritative and always re-checked live.** Never reuse a
  suppression from a prior run. A missing file is not an error.
- **Never run evals.** Quality-claimed findings carry an eval estimate; running it is a human
  decision, never part of a scan.
- **Class (d) needs two consecutive runs** before it is `proposed` or reported.
- **Never silently drop a ledger entry.** A single miss is not evidence of resolution.
- **`--summary` skips only the report**, not the ledger update. `--dry-run` mutates nothing.
- **Labels are honest.** Cost-only findings never claim quality is unchanged; they say it is
  unmeasured.
