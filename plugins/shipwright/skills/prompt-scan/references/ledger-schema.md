# Prompt-Audit Ledger Schema

`prompt-scan` persists every finding it has seen to `state/prompt-audit-ledger.json` —
agent workspace state, git-ignored, the same tier as `state/consolidation-ledger.json`.
Like that ledger it is a **current-state snapshot**, fully overwritten each run, except
each finding's own `history` array, which is append-only. The merge logic is
`mergeScan` in `plugins/shipwright/scripts/prompt-audit/ledger.ts`; the types there
(`Ledger`, `LedgerEntry`, `FindingStatus`) are authoritative if this doc drifts.

---

## Top-level shape

```json
{
  "lastRun": "2026-10-12T09:00:00.000Z",
  "models": ["claude-sonnet-5-5", "claude-sonnet-4-6"],
  "claudeCodeVersion": "2.1.0",
  "baselines": { "<context>": { "<model>": { "alwaysTokens": 0, "listingChars": 0, "estimated": false } } },
  "findings": { "<fingerprint>": { } }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `lastRun` | ISO-8601 string \| `null` | UTC timestamp of the most recent write. `null` for a never-written ledger. |
| `models` | string[] | Models the scan counted tokens for. |
| `claudeCodeVersion` | string (optional) | Claude Code version the scan ran under, when known. |
| `baselines` | object | context → model → `{ alwaysTokens, listingChars, estimated, measuredContextTokens? }`. |
| `findings` | object | Map of fingerprint → finding entry. One entry per distinct finding ever observed. |

---

## Finding entry shape

A finding entry is the rule output (`Finding` in `finding.ts`: `class`, `rule`, `file`,
`line`, `evidence`, `metrics`, `measurement`, ...) plus `blastRadius` and `scannedAt`
(commit sha), plus the lifecycle fields below.

| Field | Type | Description |
|-------|------|-------------|
| `status` | `tracking` \| `proposed` \| `queued` \| `measured` \| `regressed` \| `resolved` \| `suppressed` | Lifecycle state. See "Status transitions". |
| `firstSeen` / `lastSeen` | ISO-8601 string | First and most recent run that observed the fingerprint. |
| `runsSeen` | number | Runs in which the fingerprint was observed. Incremented on every match, never decremented. |
| `consecutiveRuns` | number | Class (d) only: consecutive runs the dated-model finding reproduced. Reset to `0` on a miss. |
| `taskId` | string (optional) | `prompt-fix` task filed for the finding. |
| `measured` | object (optional) | Before/after measurement recorded by `cli.ts measure --record`. |
| `history` | `{ at, event, status }[]` | Append-only trail of status changes. Never truncated. |

---

## Fingerprint

`sha256(class|rule|file|normalizedEvidence)[:12]` (`fingerprint.ts`). Evidence is kept
free of counts and line numbers, so a finding keeps its fingerprint as numbers drift.
Class (d) findings, which the skill produces by judgment, use the same formula with
class `d`.

---

## Status transitions

- **New finding** → `tracking`, or `suppressed` if the decisions registry matches it.
- **Matched finding** → status unchanged, `runsSeen` + 1. A registry match moves it to
  `suppressed`; a `suppressed` finding the registry no longer matches (entry removed, or
  its **Revisit** condition met) returns to `tracking` with a `reappeared` history event.
  A `resolved` finding that reproduces also returns to `tracking`.
- **Absent finding** → only `queued` and `measured` entries move, to `resolved`
  (`stopped-reproducing`). A vanished `tracking`, `proposed` or `suppressed` entry is
  left alone: a scan is a sample, one miss is not evidence of resolution.
- **Class (d) promotion** → a dated-model finding stays `tracking` until it has been
  observed on two consecutive runs (`consecutiveRuns >= 2`), then moves to `proposed`.
  Class (e) findings, whose rules are deterministic, are `proposed` once the judgment
  pass confirms them.
- `queued`, `measured` and `regressed` are set by `prompt-fix`, `measure` and `watch`,
  never by `prompt-scan`.

---

## Resilience

- A missing ledger is a normal first run: `{ "lastRun": null, "models": [], "baselines": {}, "findings": {} }`.
- A ledger that exists but is unparseable or lacks `findings` is an error: stop and
  report it rather than overwriting history.
- `--dry-run` never writes this file. `--summary` still updates it (only the report
  file is skipped).
