# Consolidation Ledger Schema

`consolidation-scan` persists candidate patterns to `state/consolidation-ledger.json`
between runs — agent workspace state, git-ignored, the same tier as
`state/entropy-patrol-last-run.json` and `state/error-patrol-ledger.json`. Unlike
`entropy-scan`'s append-only `.entropy-patrol/quality-log.jsonl`, this ledger is a
**current-state snapshot**: fully overwritten each run (same convention as
`state/error-patrol-ledger.json`), except each entry's own `history` array, which is
append-only within that entry.

---

## Top-level shape

```json
{
  "lastRun": "2026-07-18T09:00:00.000Z",
  "candidates": {
    "<fingerprint>": { }
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `lastRun` | ISO-8601 string \| `null` | UTC timestamp of the most recent run. `null` if the ledger has never been written (fresh/empty). |
| `candidates` | object | Map of fingerprint → candidate entry (see below). One entry per distinct duplication pattern ever observed, across all runs. |

---

## Candidate entry shape

```json
{
  "description": "Retry a flaky network call with exponential backoff",
  "files": [
    "src/services/payments/retry.ts",
    "src/services/notifications/sendWithRetry.ts",
    "src/lib/http/fetchWithBackoff.ts"
  ],
  "occurrence_count": 3,
  "consecutive_stable_runs": 2,
  "status": "ready_to_propose",
  "firstSeen": "2026-06-27T09:00:00.000Z",
  "lastSeen": "2026-07-18T09:00:00.000Z",
  "history": [
    {
      "run": "2026-06-27T09:00:00.000Z",
      "description": "Retry a flaky network call with exponential backoff",
      "files": ["src/services/payments/retry.ts", "src/lib/http/fetchWithBackoff.ts"]
    },
    {
      "run": "2026-07-04T09:00:00.000Z",
      "description": "Retry a flaky network call with exponential backoff",
      "files": ["src/services/payments/retry.ts", "src/services/notifications/sendWithRetry.ts", "src/lib/http/fetchWithBackoff.ts"]
    },
    {
      "run": "2026-07-18T09:00:00.000Z",
      "description": "Retry a flaky network call with exponential backoff",
      "files": ["src/services/payments/retry.ts", "src/services/notifications/sendWithRetry.ts", "src/lib/http/fetchWithBackoff.ts"]
    }
  ]
}
```

| Field | Type | Description |
|-------|------|-------------|
| `description` | string | Most recently recorded pattern description (human-readable, generic enough to describe the responsibility even as new occurrences appear). |
| `files` | string[] | Most recently observed involved files/line ranges. `history` retains prior observations; this field is the current snapshot used for report display. |
| `occurrence_count` | number | Total number of runs in which this fingerprint was observed (matched or newly created). Incremented on every fingerprint match — never decremented. |
| `consecutive_stable_runs` | number | Number of consecutive runs (most recent streak) in which the observed shape was judged consistent with the prior recorded shape. Reset to `0` on any judged divergence. |
| `status` | `"tracking"` \| `"ready_to_propose"` | `"tracking"` until promotion criteria are met (see below); `"ready_to_propose"` once promoted. Can move back to `"tracking"` if a suppression is added after promotion. |
| `firstSeen` | ISO-8601 string | Timestamp of the run that first created this entry. |
| `lastSeen` | ISO-8601 string | Timestamp of the most recent run that observed this fingerprint. |
| `history` | array | Append-only trail of every observation of this fingerprint: `{ run, description, files }` per run. Never truncated or rewritten — this is the evidence trail for stability judgments in future runs. |

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

- A missing ledger file is a normal first run — treat as `{"lastRun": null, "candidates": {}}`.
- Entries not observed in a given run's survey are preserved unchanged — a single
  miss is not evidence of resolution.
- `--dry-run` never writes this file. `--summary` still updates it (only the report
  file is skipped under `--summary`).
