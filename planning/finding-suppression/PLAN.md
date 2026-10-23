# Plan: finding-suppression

Durable, finding-level false-positive / accepted-risk suppression for the security and entropy patrols.

## Problem
- `security-scan` has suppression only for gitleaks (`.gitleaksignore`) and zizmor (`.github/zizmor.yml`). CVE (osv/grype), posture and authz findings have none.
- `entropy-scan` has none; the only lever is dropping a whole principle from `principles.md`.
- `security-fix` dedup is rule-level with a 14-day closed-task window, so triaged findings resurface.
- Ledger (`state/security-patrol-ledger.json`) is agent-local and overwritten each run.

## Design (approved: option A)
Committed per-repo file `.shipwright/suppressions.yml` in the scanned repo; PR review is the approval step.

Entry fields: `rule`, a stable `match` key (no line numbers: CVE id + package for osv/grype; file + symbol for entropy; path for posture), `status` (`false_positive` | `accepted_risk`), required `reason`, `addedBy`, `date`, and `expires`.

- `accepted_risk` requires `expires`; default 90 days.
- `false_positive` does not expire (scanner error, not tolerated risk).
- Scans drop matching findings before report and ledger, and print `Suppressed: N`. Expired entries stop suppressing and are reported.
- `security-fix` / `entropy-fix` re-check the file as defense in depth.
- Matching/expiry logic lives in a tested bun script shared by the skills, not in prose.

Rejected: B (task-store resource: schema, migration, endpoints, invisible to repo review), C (extend agent-local ledger: not reviewable, lost with workspace).

## Tasks
| ID | Title | Depends on | Model |
|---|---|---|---|
| FPS-1.1 | feat: suppressions schema doc and parse/match/expiry script | - | sonnet |
| FPS-1.2 | feat: security-scan applies suppressions | 1.1 | sonnet |
| FPS-1.3 | feat: entropy-scan applies suppressions | 1.1 | sonnet |
| FPS-1.4 | feat: security-fix and entropy-fix honor suppressions | 1.2, 1.3 | haiku |
| FPS-2.1 | feat: hitl false-positive close-out proposes suppression PR | 1.1 | sonnet |

All tasks are on separate branches; none touch `.claude/**`; all safe to deploy standalone (additions only).
