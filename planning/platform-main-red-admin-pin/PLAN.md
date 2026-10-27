# Plan: platform-main-red-admin-pin

Repo: app-vitals/shipwright. Main CI has been red since the 0.7.1 platform bump (#4580).

## Root cause (two stacked failures)

1. **Stale reviewed gates.** The committed admin spec (`admin/openapi.json`, `admin/src/coding/admin-types.ts`), the composed-surface baseline and pinned diff (`admin/src/composed-surface.*`), and `admin/src/platform-migrations.unit.test.ts` (hardcoded `@app-vitals/agent-admin 0.5.0` plus a `PLATFORM_ADDITIONS` hash list) are deliberate review gates. 0.7.1 adds `podServiceAccountName` and changes `PATCH /agents/{id}`, so 5 tests fail: committed-spec byte-identity, three composed-surface diffs (operations, schemas, pages) and the 0.5.0 pin.
2. **Bump self-merge raced its own checks.** `platform-release.yml` polls for any required check to register, then runs `gh pr checks --watch --required`. "Conventional-Commit PR title" registers in seconds; the main CI workflow's checks register later. The loop saw only the title check, logged "Checks passed" and ran `gh pr merge --admin` about 1 minute after the PR opened, over a required `lint / typecheck / test` that then failed.

## Design

1. Update the reviewed pins to 0.7.1 after reviewing the real diff: regenerate the committed spec and types, update `PLATFORM_ADDITIONS` and the pinned diff in the composed-surface test, and read the version assertion from the declared dependency. Hash pins stay hand-reviewed (they are the gate by design); the task must confirm any new migrations are additive.
2. The bump's self-merge waits for every required check on the PR head (the CI workflow run, not just the first registered check) and does not `--admin` over a failing required check.
3. The bump regenerates the committed admin spec and types, so a bump fails only on the reviewed pins, not on mechanical drift.

## Tasks

| ID | Title | Depends on | Layer | Model |
|---|---|---|---|---|
| PMR-1.1 | fix: update admin spec, baselines and platform pins for agent-admin 0.7.1 | none | API | sonnet (3, 3h) |
| PMR-1.2 | fix: make the platform bump wait for all required checks before merging | PBP-1.2 | CLI | sonnet (3, 3h) |
| PMR-1.3 | ci: regenerate the committed admin spec and types in the platform bump | PMR-1.2 | CLI | sonnet (3, 2h) |

```
[PRIOR SESSION: platform-release-bump]
  └─ PBP-1.2 (same workflow step as PMR-1.2)
[START]
  ├─ PMR-1.1 (no deps; unblocks every red PR)
  └─ PMR-1.2 (needs PBP-1.2)
        └─ PMR-1.3
```

## Breaking Change Safety

All three are additive or fix-only (fixtures/generated files, and workflow steps). Safe to deploy standalone: yes. No HITL tasks; no new secrets.

## Notes

- PMR-1.1 is blocking: main and every open PR (including #4585) are red until it merges.
- The 0.8.0 bump will hit the same gates; after PMR-1.1 and PBP-1.1 it should fail its own CI and stay open (correct) until its pins are reviewed.

## Decision Log

- Session slug: defaulted to `platform-main-red-admin-pin`.
- Task prefix: PMR (free in the task store).
- Hash pins stay hand-reviewed: they are the AGR-4.2 review gate, so only the version assertion is derived.
- PMR-1.2 depends on PBP-1.2, not PBP-1.3, because both edit the same wait-for-checks step.
