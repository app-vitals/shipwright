---
name: entropy-scan
description: "Scan one repo for principle deviations and write docs/patrols/entropy.md. Requires --repo org/repo. Report only — no code changes."
argument-hint: "--repo org/repo [--init] [--summary] [--trend] [--dry-run]"
---

# Entropy Scan

Scan **one repo** for principle violations, write the open items to
`docs/patrols/entropy.md`, and hand the structured findings to `/entropy-fix`. This skill
makes **no code changes** to the scanned code — it reads and reports only. Use `/entropy-fix`
to act on the findings.

Run by the admin's `entropy-patrol` system cron, one task per repo, as
`/shipwright:entropy-scan --repo {repo}` then `/shipwright:entropy-fix --repo {repo}`
(the system-cron contract: [docs/task-store.md](../../../../docs/task-store.md), "System-cron contract").

---

## Setup: Parse Arguments

`--repo org/repo` is **required**. If it is missing, print the following and stop without
scanning `repos/`, resolving a repo from the current directory, or doing any other work:

```
Usage: /shipwright:entropy-scan --repo org/repo [--init] [--summary] [--trend] [--dry-run]
```

Other flags:

- `--init` — copy the default principles file to the repo and exit (no scan)
- `--summary` — print category counts to stdout; skip writing `docs/patrols/entropy.md` and the handoff file
- `--trend` — print a trend summary from this repo's recorded `entropy-patrol` runs (`GET /cron-runs`); skip the scan entirely
- `--dry-run` — run the full scan and print the summary, but write no docs PR, no commit and no run record: no run is recorded and no PR is opened (the handoff file for `/entropy-fix --dry-run` is still written, locally only)

---

## Step 0: Resolve the repo and worktree

Find the repo's clone by matching each `repos/*/`'s `origin` remote URL against
`org/repo`; if none matches, clone it (`git clone https://github.com/{org}/{repo}.git repos/{repo}`).
The local directory is `repos/{dirname}`, which need not equal the `org/repo` string. The skill
never scans `repos/` as a list and never falls back to another repo or to the current directory.

Run everything below in a worktree, never in `repos/{dirname}` itself, so nothing is written to
the clone root. Follow the same docs-PR flow as `/shipwright:test-readiness` (its Step 1 and
Step 3.5), with the branch prefix `docs/entropy-patrol-`:

**Open-PR supersession check (first).** An earlier day's entropy docs PR may still be open;
a second PR on the same file would conflict with it once one merges.

```bash
gh pr list --repo {org}/{repo} --state open --json number,headRefName,createdAt
```

Filter client-side to `headRefName` starting with `docs/entropy-patrol-`.

- **None open:** fresh-branch flow:
  ```bash
  git -C repos/{dirname} pull
  git -C {absolute-path-to}/repos/{dirname} worktree add \
    $SHIPWRIGHT_WORKTREE_DIR/{dirname}-docs-entropy-patrol-{YYYYMMDD} \
    origin/main -b docs/entropy-patrol-{YYYYMMDD}
  ```
  If that worktree or branch already exists (same-day rerun), reuse it.
- **One earlier-day PR open:** check out its branch into a worktree (or reuse the existing one),
  `git merge origin/main`, and continue there so this run's update lands on that PR. On a merge
  conflict, `git merge --abort`, skip the scan, and report "skipped — reuse-merge conflict,
  needs manual resolution" in the summary.

All paths below are relative to that worktree. Note the HEAD commit: `git rev-parse HEAD`.

---

## Step 0.5: Handle `--trend` Flag

If the `--trend` flag was passed, read the history from the task store, not from any local
file. Every `/entropy-fix` run records one `entropy-patrol` run for the repo (Step 7 there),
so the run records are the durable, per-repo trend record; a fresh worktree each run means
nothing local survives between runs. No worktree is needed for this step.

1. Fetch the most recent `--window N` runs (default: 30):
   ```bash
   curl -sf -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
     "$SHIPWRIGHT_TASK_STORE_URL/cron-runs?cronId=entropy-patrol&repo={url-encoded-repo}&limit={N}" | jq .runs
   ```
   If the call fails, print the error and stop.
2. Keep only runs with `outcome` `ok` or `no_op` (failed runs carry no scan numbers). The
   list is newest first; reverse it so the trend reads oldest → newest.
3. If no runs remain, print:
   ```
   No scan history found. Run the entropy patrol (/entropy-scan then /entropy-fix) a few times to build trend data.
   ```
   Then stop.
4. If fewer than 2 runs remain, print:
   ```
   Not enough scan history for trends (need at least 2 runs).
   Current run count: {N}. Run the entropy patrol again to build history.
   ```
   Then stop.
5. Read each run's `metrics` (`findings`, `high`, `medium`, `low`, `suppressed`; a missing
   key counts as 0) and `finishedAt`, and print a trend summary:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
ENTROPY TREND — {org/repo} ({first_date} → {last_date}, {N} runs)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

OVERALL
  {first findings} findings → {last findings} findings  ({delta, e.g. "▼ 10" or "▲ 3" or "— no change"})

BY SEVERITY
  High    {first} → {last}  ({direction})
  Medium  {first} → {last}  ({direction})
  Low     {first} → {last}  ({direction})

SUPPRESSED  {first} → {last}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

6. Stop — do not run a scan.

---

## Step 1: Handle `--init` Flag

If the `--init` flag was passed:

1. Check if `.claude/shipwright/principles.md` already exists in the repo worktree.
   - If it exists, print: "Config already exists at `.claude/shipwright/principles.md`. Edit it to customize principles for this project." and stop.
2. If it does not exist, create the directory and copy the default principles file:
   - Source: `references/principles.md` (relative to the plugin root — the plugin's own shared principles file)
   - Destination: `.claude/shipwright/principles.md` in the repo worktree
3. Print: "Created `.claude/shipwright/principles.md`. Edit it to customize principles for this project. Re-run `/entropy-scan` to start scanning."
4. Stop — do not run the scan.

---

## Step 1.5: Read the prior run (and one-time legacy import)

The prior run lives in the task store (`GET /cron-runs/latest`), never in a local file. Read it
through the recorder:

```bash
bun run "${CLAUDE_PLUGIN_ROOT}/scripts/cron-run-recorder.ts" prior \
  --cron entropy-patrol --repo {org}/{repo} \
  --legacy-shape entropy-patrol-last-run
```

It prints `{latest, findings, imported}`. `latest` is the newest `ok`/`no_op` run
(`commitSha`, `metrics`, `machineState`) or `null` on a first run; use it only to word the
summary ("changed since last run", prior totals), never to skip the scan.

**One-time import.** Only when `/cron-runs/latest` is 404 and the agent-local
`state/entropy-patrol-last-run.json` holds an entry for this repo does `imported` come back
non-null; the recorder then carries that entry into the first run it records and deletes the
legacy file after a successful post. This is the only place this skill touches that file, and
only through the recorder's `--legacy-shape` flag — never read, write or delete it directly.
If the recorder errors, log it and continue with no prior state.

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

## Step 3.5: Apply Suppressions

Runs once, after Step 3 has produced its raw findings and before Step 4. Suppressions
are human-reviewed entries in `.shipwright/suppressions.yml` in the **scanned repo** (schema:
`references/suppressions-schema.md`; per-principle match keys: `references/suppressions.md`).

1. **Build the candidate list.** For each finding emit one object
   `{rule: "entropy", file, symbol, rule_id, line}`. `file` and `symbol` are the match key —
   `symbol` follows the per-principle convention in `references/suppressions.md` (never a line
   number; matching is exact, no wildcards).
2. **Filter.** Write the candidates to a temp JSON array and run the shared script from the
   repo being scanned:
   ```bash
   bun "$CLAUDE_PLUGIN_ROOT/scripts/suppressions.ts" --filter .shipwright/suppressions.yml candidates.json
   ```
   It prints `{kept, suppressed, expired}`. A missing suppressions file is valid (nothing
   suppressed). A non-zero exit means the file is invalid — print the error, treat it as "no
   suppressions applied", and note it in the summary; never abort the scan.
3. **Drop suppressed findings here.** Every finding in `suppressed` is removed before Step 4:
   it never appears in `docs/patrols/entropy.md` or the handoff file and is not counted in the summary or the run
   record's `findings`, `high`, `medium` or `low` metrics.
4. **Track the counts** for Steps 4-5: `suppressed_count` = `suppressed.length`, and the
   `expired` entries (rule, match key, `expires`) — keep only those with `rule == "entropy"`;
   the file is shared with osv/grype/posture, whose expired entries are not this scan's to report. Expired entries stop suppressing, so their
   findings stay in `kept` and surface normally.

---

## Step 4: Write docs/patrols/entropy.md and the handoff

If `--summary` flag was passed, skip to Step 5.

**4.1 Handoff file.** Write the structured findings (after Step 3.5) to
`.entropy-patrol/findings.json` in the worktree. It is local scratch for `/entropy-fix` and is
never committed:

```json
{
  "repo": "org/repo",
  "commitSha": "<git rev-parse HEAD>",
  "generatedAt": "<UTC ISO-8601>",
  "suppressed": 0,
  "expired": [{"file": "...", "symbol": "...", "expires": "YYYY-MM-DD"}],
  "findings": [
    {"ruleId": "dead_exports", "severity": "high|medium|low", "category": "dead_code",
     "file": "src/x.ts", "line": 12, "symbol": "foo",
     "description": "one line", "effort": "trivial|small|medium"}
  ]
}
```

**4.2 The docs file.** The run writes **exactly one file under `docs/patrols/`**:
`docs/patrols/entropy.md`. It is readable detail for anyone working in the repo: current open
items only, highest priority (severity, then PR-worthy) first, one bullet per item with a short
why and the affected paths. Never write a `*-report.md` file to the clone
root. Format:

```markdown
# Entropy patrol

Open items, highest priority first.

- **{rule.id}: {rule.description}** — {why it matters, one line} (`{path}`, `{path}`)
```

Group a rule's findings into one bullet listing up to 5 paths. Hard rules, enforced by the
checker: at most 150 lines; no count or summary-number tables; no run-history section; no
resolved-items section; no timestamp or "generated" lines. All numbers go in the run record,
not here. If more items exist than fit, finish with one line saying the remaining open items
are tracked in the fix tasks. With no open items, write the header and `No open items.`

**4.3 Validate and decide.** Write the candidate to a temp file and run the checker against the
current repo file:

```bash
bun "${CLAUDE_PLUGIN_ROOT}/scripts/check-patrol-docs.ts" /tmp/entropy-candidate.md docs/patrols/entropy.md
```

It prints `{violations, materiallyChanged}` and exits 1 when there are violations. Fix the
candidate and re-run until `violations` is empty. A timestamp-only change or a pure reorder
is not `materiallyChanged`.

- **Not `materiallyChanged`:** leave `docs/patrols/entropy.md` untouched, commit nothing, open
  no PR.
- **`materiallyChanged`, and not `--dry-run`:** copy the candidate over `docs/patrols/entropy.md`
  and open (or update) the docs PR, exactly as `/shipwright:test-readiness` Step 3.5 does:
  ```bash
  git add docs/patrols/entropy.md
  git commit -m "docs: entropy patrol ({YYYYMMDD})"
  git push --set-upstream origin {branch-name}
  gh pr list --repo {org}/{repo} --head {branch-name} --state open --json number
  ```
  If an open PR already exists the push updated it; stop there. Otherwise:
  ```bash
  gh label create shipwright --description "Opened autonomously by Shipwright" --color 1D76DB --force
  gh pr create --title "docs: entropy patrol ({YYYYMMDD})" \
    --body "Automated entropy patrol update: docs/patrols/entropy.md" --label shipwright
  ```
- **`--dry-run`:** print whether a PR would be opened; write nothing to the repo.

If scanning or this step fails, record the failure (see Step 6.5) before stopping.

---

## Step 5: Print Summary

Whether or not `--summary` was passed, always print a summary after the scan. Cron runs post
this to a channel where nobody can reply in the moment, so **cap the final response at
3-5 lines**: a status line, the counts, and a link. The full detail (findings, expired
suppressions) stays in `docs/patrols/entropy.md` and the handoff file — never repeat it here.

```
ENTROPY SCAN COMPLETE — {org/repo}: {N} findings across {N} rules (suppressed: {N})
HIGH {N} · MEDIUM {N} · LOW {N}
{If high-severity findings: "Next: /entropy-fix --repo {org/repo} to queue tasks."}  {If zero: "✓ No violations."}
{If expired suppressions: "Expired suppressions: {N} — see handoff."}
{--summary: "Summary only — nothing written."} {--dry-run: "Dry run — no PR, no run recorded."} {else: "Docs: docs/patrols/entropy.md ({PR url | unchanged})"}
```

---

## Step 6.5: Run recording

`/entropy-fix` records the single run for the whole `entropy-patrol` task, with the scan
numbers (read from the handoff) plus its auto/review/plan counts, so this skill records the
success run nowhere. It records only a **failed** run, when the scan or the docs step errors
(never under `--dry-run`):

```bash
echo '{"outcome": "failed", "metrics": {"error": 1}}' > /tmp/entropy-result.json
bun run "${CLAUDE_PLUGIN_ROOT}/scripts/cron-run-recorder.ts" record --cron entropy-patrol --repo {org}/{repo} \
  --commit {sha} --result /tmp/entropy-result.json
```

---

## Constraints (Do Not Violate)

- **`--repo` is required.** Missing it is a usage error. Never scan `repos/` as a list, never infer the repo from the current directory, never read a precheck prompt.
- **No code changes** to the scanned code. The only repo file this skill writes is `docs/patrols/entropy.md`, in a worktree, and only the docs PR commits it. Local scratch under `.entropy-patrol/` (the handoff) is never committed.
- **Exactly one file under `docs/patrols/`** (`entropy.md`), validated by `check-patrol-docs.ts`. No report file at the clone root or anywhere else.
- **PR only on material change.** No change, or only a timestamp/reorder change, means no commit and no PR. `--dry-run` opens no PR and records no run.
- **No local state.** Prior state comes from `/cron-runs/latest`; the legacy `state/` ledger is touched only by the Step 1.5 one-time import, through the recorder.
- **No task creation.** `entropy-scan` never creates tasks — routing findings into task-store tasks belongs to `/entropy-fix`.
- **No network calls for detection.** All detection is local file inspection (the recorder and `gh` calls above are bookkeeping only).
- **Respect the project override.** If a project's `.claude/shipwright/principles.md` omits an entry present in the plugin default, treat it as not scanned — not even "just to check."
- **Never report a finding suppressed in `.shipwright/suppressions.yml`.** Step 3.5 drops matching findings before the docs file, handoff and summary — they must not appear in `docs/patrols/entropy.md` or the run record's counts (`findings`, `high`, `medium`, `low`). Expired entries are not suppressions: list them in the handoff and let their findings through.
- **One scan, one picture.** Each run fully rewrites the docs file's content; resolved items drop out and previous results are not preserved in the repo (run history is in the task store).
- **Trend comes from the run records.** `--trend` reads `GET /cron-runs` for this repo; there is no local quality log, under `.entropy-patrol/` or `state/`.
