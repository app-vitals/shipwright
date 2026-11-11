# Suppressions Schema (`.shipwright/suppressions.yml`)

Shared reference for recording scanner findings a human has judged to be false positives
or accepted risks, so scans stop re-reporting them. The file lives in the **scanned
repo** at `.shipwright/suppressions.yml`. Parsing, matching and expiry are implemented in
`scripts/suppressions.ts` (`parseSuppressions`, `findSuppression`, `evaluateExpiry`).

## File shape

```yaml
suppressions:
  - rule: osv                      # osv | grype | entropy | posture
    match: { cve: CVE-2024-1234, package: lodash }
    status: accepted_risk          # false_positive | accepted_risk
    reason: Not reachable from our code paths
    addedBy: dave
    date: 2026-01-01               # YYYY-MM-DD, when the entry was added
    expires: 2026-04-01            # required for accepted_risk
  - rule: entropy
    match: { file: src/billing/invoice.ts, symbol: buildInvoice }
    status: false_positive
    reason: Intentional duplication, covered by ADR-12
    addedBy: dan
    date: 2026-01-03
```

An empty file or an empty `suppressions` list is valid.

## Fields

| Field | Required | Notes |
|---|---|---|
| `rule` | yes | One of `osv`, `grype`, `entropy`, `posture`. |
| `match` | yes | Stable match key; fields depend on `rule` (below). |
| `status` | yes | `false_positive` or `accepted_risk`. |
| `reason` | yes | Non-blank justification. |
| `addedBy` | yes | Who added the entry. |
| `date` | yes | `YYYY-MM-DD`. |
| `expires` | accepted_risk only | `YYYY-MM-DD`, not before `date`. Forbidden on `false_positive`. |

## Match keys per rule

Match keys are **stable identifiers and never contain line numbers** (`line` or `column`
under `match` is rejected), so entries survive unrelated edits to the file.

| Rule | Match key fields | Comparison |
|---|---|---|
| `osv` | `cve` + `package` | CVE id case-insensitive, package exact |
| `grype` | `cve` + `package` | CVE id case-insensitive, package exact |
| `entropy` | `file` + `symbol` | exact |
| `posture` | `path` | exact |

A finding matches an entry when the `rule` is equal and every key field is equal. Any
other finding fields (including `line`) are ignored.

## Expiry semantics

- `false_positive` **never expires**.
- `accepted_risk` **requires `expires`**. The default window is **90 days** from `date`
  (`defaultExpiry(date)`); the parser does not fill it in, it rejects a missing value and
  suggests the default date in the error.
- An entry is active through the **entire `expires` day (UTC)** and expired from
  `00:00:00Z` on the next day. Expired entries no longer suppress findings (they resurface
  in scans) unless `includeExpired` is passed.
- Time comes from the injectable `Clock` in `scripts/clock.ts`.

## Validation

`parseSuppressions` throws `SuppressionsError` listing every problem, each prefixed with
its entry index, e.g. `suppressions[0]: expires is required for accepted_risk`. Rejected:
unknown `rule`/`status`, missing or blank `reason`/`addedBy`, bad dates, incomplete or
line-number match keys, `accepted_risk` without `expires`, `false_positive` with `expires`,
and `expires` before `date`. Validate a file with `bun scripts/suppressions.ts <path>`.
