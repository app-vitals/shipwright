# Plan: agent-extraction-gaps

Session: `agent-extraction-gaps`. Step 1 of the agent extraction plan: a verification pass over the migration into `app-vitals/agent`. Audited shipwright `c70af2d` and agent `6f63bfc` (platform pin `0.13.1`).

## Findings

| # | Item | Result |
|---|---|---|
| G1 | Main CI | **Red since the `0.13.1` bump merged (#4639).** The last three `ci.yml` runs on main failed (#4639, #4626, #4640); the run before passed. The `0.13.1` platform package includes AGR-6.3, which removed `Agent.typeName`. Shipwright's coding-side code still uses it, so `@shipwright/admin:typecheck` fails with 16 errors. No open PR, task or failure issue tracked it |
| G2 | Bump merged on a red check | #4639 merged with a failed `lint / typecheck / test` check although `platform-release.yml` states it waits for required checks. Cause not yet known |
| G3 | Duplicated docs | Largely solved: `docs/platform/` is a generated snapshot of the agent docs at the pinned tag, guarded by `platform-docs-guard`; top-level docs are the coding half. The only leftover is `typeName` wording in the coding half (covered by AXG-1.1) |
| G4 | Dispatch, bump and rebuild chain | Working. Last two runs succeeded; three failures on 10-27 recovered and the failure issue closed itself. The Renovate fallback was not exercised. No lane for the specialists image yet (extraction plan step 6) |
| G5 | Package pins | Consistent: root, `agent/` and `admin/` `package.json` and `ARG PLATFORM_VERSION` in `agent/Dockerfile` all `0.13.1`; a content test guards it |
| G6 | `bun link` local dev | Documented in `docs/local-platform-development.md`; not exercised in this audit |
| G7 | Stuck task records | CHM-3.3 is `blocked` because its post-merge CI hit the G1 failures, not because of its own change. CHX-1.1 and CHX-1.2 sit in `deploying` although their PR merged on 10-26; left as they are by decision |

## Design

Two independent fixes, both in this repo:

- **AXG-1.1** removes the `typeName` usage left in Shipwright's coding extension, tests, e2e server, dev scripts, generated spec and docs, so main is green at the `0.13.1` pin. It is safe to land now, because the pin already lacks the field.
- **AXG-1.2** closes the process gap: find out how a bump PR merged with a failed required check and make the merge step refuse.

Nothing here touches the platform repo.

## Tasks

| Task | Title | Layer | Hrs | Cx / model | Branch | Deps | HITL |
|---|---|---|---|---|---|---|---|
| AXG-1.1 | fix: move Shipwright's remaining Agent.typeName usage to specialty | Shared | 3 | 3 / sonnet | `fix/axg-1-1-agent-typename-to-specialty` | — | |
| AXG-1.2 | ci: stop the platform-release bump from merging on a red required check | Shared | 3 | 3 / sonnet | `ci/axg-1-2-bump-refuse-red-checks` | — | |

### AXG-1.1: fix: move Shipwright's remaining Agent.typeName usage to specialty

Replace `typeName` with `specialty` everywhere Shipwright still uses it: the coding admin tests and fixtures (`admin/src/coding/*.smoke.test.ts`, `admin-ui-verification-cards.unit.test.ts`), `admin/src/admin-spec.smoke.test.ts`, the coding integration tests that create agents, `admin/e2e/test-server.ts`, `scripts/wait-for-agent.ts` and its unit test, the committed `admin/openapi.json`, the `agent-admin` skill and `plugins/shipwright/CLAUDE.md`, and the coding-half docs (`docs/agent-key-files.md`, `docs/agent-ops.md`). Leave `docs/migration.md` and the historical migration test as they are.

Acceptance criteria:
- `task typecheck` passes with no `typeName` errors, and `task ci` is green at the `0.13.1` pin. Grep shows no remaining `typeName` outside the migration doc and the migration test.
- `scripts/wait-for-agent.ts` reads `specialty` from the admin API and logs it; its unit test asserts that.
- `admin/openapi.json` is regenerated with the project's generator, not hand-edited, and the spec drift check passes.
- `plugins/shipwright/` changes bump the plugin version per the marketplace conventions.
- Test decision: unit and smoke layers. Existing fixtures are updated to the `specialty` field, and the coding integration tests create agents with `specialty`. No test is retired; each is migrated, because they all still cover live coding behavior.

Breaking Change Scan: no removal in Shipwright; consumers of the field are all listed above. Safe to deploy standalone: yes.

### AXG-1.2: ci: stop the platform-release bump from merging on a red required check

PR #4639 merged with a failed `lint / typecheck / test` check even though `platform-release.yml` is documented to wait for required checks. Find out why (the workflow's merge step, branch protection, or an admin override) and make the merge refuse unless every required check is green.

Acceptance criteria:
- The PR records the root cause, citing the run and the merge step involved.
- The merge step does not merge when any required check is not `success`, and leaves the PR open with the existing failure-issue path.
- Test decision: content layer. Add a test that asserts the workflow's merge step is gated on required-check success, following the existing `platform-release` content tests. Retire none.
- If the cause is a repository setting rather than workflow code, the PR says so and this task's human steps are listed in the PR instead of changed in code.

Safe to deploy standalone: yes.

## Dependency map

```
[PRIOR SESSIONS]
  ├─ CHM-3.3: refactor: replace the chat and whisper templates with library stubs [blocked] (chart-move)
  └─ CHM-3.4: refactor: drive the shared networking and database templates ... [pr_open] (chart-move)

[START]
  ├─ AXG-1.1: fix: move Shipwright's remaining Agent.typeName usage to specialty (no deps)
  └─ AXG-1.2: ci: stop the platform-release bump from merging on a red required check (no deps)
```

| Task | Depends on | Blocks | HITL |
|---|---|---|---|
| AXG-1.1 | — | unblocks main CI, and with it CHM-3.3, CHM-3.4 and the rest of the chart move | |
| AXG-1.2 | — | — | |

No task-level dependency is recorded for the chart move: it waits on green CI, not on these task ids. HITL scan: no tasks require human steps.

## Not tasks

- CHM-3.3 should be unblocked once AXG-1.1 has merged and main is green (its own note asks for human triage). That is a record change, not a code change.
- CHX-1.1 and CHX-1.2 stay in `deploying`: no status repair, by decision.
