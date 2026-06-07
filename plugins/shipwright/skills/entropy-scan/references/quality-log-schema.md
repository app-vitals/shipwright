# Quality Log Schema

entropy-patrol appends a log entry to `.entropy-patrol/quality-log.jsonl` after each scan. This file is the trend record — commit it to your repo so drift history is preserved in git.

---

## Format

JSONL — one JSON object per line, append-only. Never rewrite or truncate the file.

## Entry Schema

```json
{
  "timestamp": "2026-03-28T21:15:00.000Z",
  "commitSha": "abc1234",
  "totalViolations": 12,
  "bySeverity": {
    "high": 2,
    "medium": 6,
    "low": 4
  },
  "byRule": {
    "dead_exports": 3,
    "todo_fixme_hack": 5,
    "missing_test_file": 4
  },
  "reportPath": "entropy-report.md"
}
```

### Fields

| Field | Type | Description |
|-------|------|-------------|
| `timestamp` | ISO-8601 string | UTC timestamp when the scan completed |
| `commitSha` | string | Short git SHA at time of scan. Omit if git is not available. |
| `totalViolations` | number | Total findings across all rules |
| `bySeverity` | object | Violation counts grouped by severity level (`high`, `medium`, `low`) |
| `byRule` | object | Violation counts grouped by rule ID. Only includes rules with at least 1 finding. |
| `reportPath` | string | Path to the report file written by this scan run (relative to project root) |

---

## Example: Three consecutive scans

```jsonl
{"timestamp":"2026-03-26T08:00:00.000Z","commitSha":"a1b2c3d","totalViolations":18,"bySeverity":{"high":3,"medium":9,"low":6},"byRule":{"dead_exports":5,"todo_fixme_hack":8,"missing_test_file":5},"reportPath":"entropy-report.md"}
{"timestamp":"2026-03-27T08:00:00.000Z","commitSha":"e4f5a6b","totalViolations":12,"bySeverity":{"high":1,"medium":7,"low":4},"byRule":{"dead_exports":2,"todo_fixme_hack":6,"missing_test_file":4},"reportPath":"entropy-report.md"}
{"timestamp":"2026-03-28T08:00:00.000Z","commitSha":"c7d8e9f","totalViolations":8,"bySeverity":{"high":0,"medium":5,"low":3},"byRule":{"todo_fixme_hack":4,"missing_test_file":4},"reportPath":"entropy-report.md"}
```

Reading this log: violations dropped from 18 → 12 → 8 across three days. `dead_exports` was cleaned up entirely. `todo_fixme_hack` improved but still has 4 open. No high-severity findings remain.

---

## Storage

- **Location:** `.entropy-patrol/quality-log.jsonl` in the project root
- **Commit it:** The log should be checked into your repo so trend history is preserved across environments
- **Don't gitignore it:** Treat it like a changelog — it's part of the project record
- **Skip it in one-off scans:** If you're doing a temporary scan and don't want to pollute the log, use `/entropy-scan --summary` (no report or log written)

---

## Trend Queries

The log is designed for lightweight querying:

- **Last N entries:** `tail -n N .entropy-patrol/quality-log.jsonl | jq`
- **Total violations over time:** `jq .totalViolations .entropy-patrol/quality-log.jsonl`
- **High-severity trend:** `jq '.bySeverity.high' .entropy-patrol/quality-log.jsonl`

Or use `/entropy-scan --trend` to get a formatted summary (see SKILL.md Step 0).

---

## Resilience

- One malformed line does not break the log — trend reads skip lines that fail to parse
- Appends are atomic (append to file, no rewrite) — safe to run concurrently
- Missing `commitSha` is valid — occurs in non-git directories
