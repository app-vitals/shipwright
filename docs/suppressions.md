# Finding suppressions

How a human tells Shipwright's scanners "stop reporting this finding" — and how that decision stays reviewable and, for tolerated risks, temporary.

Suppressions live in the **scanned repo**, in `.shipwright/suppressions.yml`. They are reviewed like any other change: an entry only takes effect once its PR merges. The full field-by-field schema is the plugin reference, [`suppressions-schema.md`](../plugins/shipwright/references/suppressions-schema.md); this page covers the workflow around it and does not duplicate it.

## File and entry shape

```yaml
suppressions:
  - rule: osv
    match: { cve: CVE-2024-1234, package: lodash }
    status: accepted_risk
    reason: Not reachable from our code paths
    addedBy: dave
    date: 2026-01-01
    expires: 2026-04-01
```

A missing file, an empty file and an empty `suppressions` list are all valid and mean "nothing suppressed".

## Rules and match keys

An entry matches a finding when the `rule` is equal and every match-key field is equal. Match keys are stable identifiers and never contain line numbers (`line`/`column` under `match` is rejected), so entries survive unrelated edits.

| Rule | Match key | Comparison | Produced from scanner rule |
|---|---|---|---|
| `osv` | `cve` + `package` | CVE id case-insensitive, package exact | `osv-cve` |
| `grype` | `cve` + `package` | CVE id case-insensitive, package exact | `grype-cve` |
| `posture` | `path` | exact | `posture-*` |
| `entropy` | `file` + `symbol` | exact, no wildcards | every entropy principle |

Entropy findings that report no named symbol use a fixed per-principle `symbol` convention, documented in [`entropy-scan/references/suppressions.md`](../plugins/shipwright/skills/entropy-scan/references/suppressions.md). `rule_id` is not part of the key, so one entry suppresses every principle that reports the same `file` + `symbol`.

Findings from rules with no suppression schema (gitleaks, zizmor, authn/authz, `hardcoded-credential`) are not candidates and pass through unchanged. gitleaks keeps its native `.gitleaksignore` and zizmor its `.github/zizmor.yml`; suppressions are in addition to those, not a replacement.

## `false_positive` vs `accepted_risk`

| | `false_positive` | `accepted_risk` |
|---|---|---|
| Meaning | The scanner is wrong | The finding is real but tolerated |
| `expires` | Forbidden | Required |
| Expiry | Never | Default **90 days** from `date` (`defaultExpiry`, `DEFAULT_ACCEPTED_RISK_DAYS`); a human may choose another date, not before `date` |

The parser does not fill in a missing `expires`; it rejects the entry and suggests the 90-day date in the error. An `accepted_risk` entry is active through the whole `expires` day (UTC) and expired from `00:00:00Z` the next day.

## Which skills honor it

| Skill | Step | Behavior |
|---|---|---|
| `security-scan` | 5.5 | Drops suppressed `osv`/`grype`/`posture` findings before they become records: they never reach `security-report.md` or the ledger. |
| `entropy-scan` | 3.5 | Drops suppressed findings before the report, summary and quality log; they are excluded from `totalViolations`, `bySeverity` and `byRule`. The report shows a `Suppressed:` count. |
| `security-fix` | 3.5 | Re-checks surviving findings before dedup, so a stale `security-report.md` written before a suppression landed cannot refile a task. Prints `Skipping {rule} — suppressed in .shipwright/suppressions.yml ({status}: {reason})`. |
| `entropy-fix` | 3.5 | Same re-check for `entropy-report.md`. |

All four call the shared script from the repo being scanned or fixed:

```bash
bun "$CLAUDE_PLUGIN_ROOT/scripts/suppressions.ts" --filter .shipwright/suppressions.yml candidates.json
```

It prints `{kept, suppressed, expired}`. If the file is invalid the script exits non-zero; the skill prints the error, treats it as "no suppressions applied" and carries on. A bad suppressions file never aborts a scan or fix run.

`consolidation-scan` and `prompt-scan` do **not** use this file. They have their own decisions registries (see [Consolidation](./consolidation.md) and [Prompt audit](./prompt-audit.md)).

## Expired entries resurface

Expired entries stop suppressing. Their findings stay in `kept` and are reported again like any new finding, and the scan lists the expired entries so a human can renew or drop them:

- `security-scan` summary: `Expired suppressions (no longer suppressing — their findings are reported again)`, listing rule, match key and `expires`.
- `entropy-scan` report and summary: an `Expired Suppressions` section. It lists only `entropy` entries, since the file is shared and expired `osv`/`grype`/`posture` entries are not that scan's to report.

To renew a risk, edit the entry's `expires` (and `reason` if it changed) in a PR. To retire it, delete the entry.

## How entries get added: the hitl proposal flow

`/shipwright:hitl` (Step 6b) proposes entries when a human closes a scanner-generated HITL task as a false positive or accepted risk. Nothing is written without confirmation.

1. **Gate.** hitl parses the `Rule:` trailer that `security-fix` or `entropy-fix` wrote into the task description and maps it to a suppression rule (`osv-cve` → `osv`, `grype-cve` → `grype`, `posture-*` → `posture`, an entropy trailer carrying `Domain:` → `entropy`). With no trailer, an unmapped rule, or a close-out that is not a false positive or accepted risk (fixed, rotated, deferred, still deciding), the step is skipped.
2. **Ask** which disposition applies and for which findings; the close-out note supplies `reason`.
3. **Draft** the entry with a no-line-number match key, and for `accepted_risk` a default `expires` of `date` + 90 days.
4. **Confirm.** hitl prints the draft and waits for an explicit yes. On decline it revises or skips; it never opens a PR unconfirmed.
5. **Land it.** hitl creates a worktree on `chore/suppress-{TASK_ID}`, appends the entry (creating the file if absent), validates it with `bun plugins/shipwright/scripts/suppressions.ts .shipwright/suppressions.yml` until it exits 0, then opens a small `chore: suppress {false positive|accepted risk} finding ({TASK_ID})` PR. PR review is the approval step.

`gitleaks-secret` and `hardcoded-credential` findings are handled separately (Step 6a, `.gitleaksignore`), and suppression is never offered for credentials closed by rotation.

## Validating by hand

```bash
bun plugins/shipwright/scripts/suppressions.ts .shipwright/suppressions.yml
```

Prints `{file, entries, expired}`, or every problem (each prefixed with its entry index, e.g. `suppressions[0]: expires is required for accepted_risk`) and exits non-zero. Parsing, matching and expiry live in `plugins/shipwright/scripts/suppressions.ts` (`parseSuppressions`, `findSuppression`, `evaluateExpiry`, `filterFindings`).
