# Consolidation Ledger Schema

`consolidation-scan` persists candidate patterns in the task store as `PatrolFinding`
rows keyed by `(cronId = consolidation-patrol, repo, fingerprint)`. The store owns
`status`, `firstSeen`, `lastSeen`, `occurrenceCount` and the append-only `history`
(one entry per upsert); the scan owns the `detail` object described below. There is
no agent-local ledger file: the retired legacy ledger is only read once, through
`cron-run-recorder.ts ... --legacy-shape consolidation-ledger`, to seed a repo's
first run (its candidates are filtered to that repo).

## Finding `detail`

```json
{
  "description": "Retry a flaky network call with exponential backoff",
  "files": ["src/services/payments/retry.ts", "src/lib/http/fetchWithBackoff.ts"],
  "notes": "Both compute the same exponential-with-jitter delay before retrying a failed call",
  "occurrence_count": 3,
  "consecutive_stable_runs": 2,
  "proposed_shape": "One shared retryWithBackoff(fn, opts) in src/lib/http"
}
```

`occurrence_count` is the effective count (an imported legacy entry carries its count
here); the store's own `occurrenceCount` starts at 1 for an imported row, so use
`max(occurrenceCount, detail.occurrence_count)` as the prior count.

## Legacy shape (read by the one-time import only)

The retired local file was `{ "lastRun": ISO, "candidates": { "<fingerprint>": { description, files, occurrence_count, consecutive_stable_runs, status, firstSeen, lastSeen, history[] } } }`. The import maps each candidate to a finding with the entry as its `detail`.

---

## Fingerprint

The map key is a stable hash of the candidate's **normalized description** joined
with its **sorted involved file list**:

```
fingerprint = sha256(normalize(description) + "|" + sorted(files).join(","))
```

Where `normalize()` lowercases, collapses whitespace, and strips trailing
punctuation. Truncate the hash to a short hex prefix (e.g. 12 chars) for
readability in the report and ledger keys.

**Known limitation:** because the file list is part of the fingerprint input, a
candidate whose involved files change materially between runs (a new occurrence
appears in a different file, or a file is renamed) produces a *different*
fingerprint and is treated as a new candidate rather than a recurrence. This is a
deliberate first-version tradeoff — favoring conservative undercounting over a
looser match that could conflate two unrelated candidates. Revisit this if it
causes real patterns to repeatedly fail to accumulate stability.

---

## Promotion rule

A candidate's `status` becomes `"ready_to_propose"` only when, as of the current
run:

1. `occurrence_count >= 3`
2. `consecutive_stable_runs >= 2`
3. It is not currently suppressed by `.claude/shipwright/consolidation-decisions.md`
   (or a matching suppression's revisit condition has been met)

All three conditions are re-evaluated fresh on every run — a candidate is never
"permanently" promoted or suppressed independent of the current ledger and
decisions-registry state.

---

## Resilience

- No prior findings and no prior run is a normal first run.
- Findings not observed in a given run's survey are left unchanged in the store — a
  single miss is not evidence of resolution.
- `--dry-run` writes nothing. `--summary` still upserts findings and records the run
  (only the docs file is skipped).
