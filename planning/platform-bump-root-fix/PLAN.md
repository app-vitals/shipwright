# Plan: platform-bump-root-fix

Repo: app-vitals/shipwright. Fixes the root cause of main going red on platform bumps, rather than re-pinning per release.

## Root cause

1. **Per-release pins built for a one-time proof.** AGR-4.2 moved the platform admin into `@app-vitals/agent-admin`. To prove the swap changed nothing, Shipwright pinned the platform surface: a composed-surface baseline plus a hand-maintained `EXPECTED_DIFF` (`admin/src/composed-surface.*`), a hardcoded agent-admin version and a `PLATFORM_ADDITIONS` migration-hash list (`admin/src/platform-migrations.unit.test.ts`), and a byte-identical committed spec check (`scripts/generate-admin-spec.unit.test.ts`). Platform releases arrive about hourly, so every release touching the admin surface turns main red until someone edits the pins (PMR-1.1 fixed 0.7.1; the 0.9.0 bump broke main again). The pins also tax Shipwright's own features (`GET /session-follows`, SIT-1.1, had to be pinned in).
2. **The bump self-merges over unfinished CI.** `platform-release.yml` polls for any required check, `gh pr checks --watch --required` then sees only the fast PR-title check, and `gh pr merge --admin` merges within about a minute, before lint/typecheck/test register (#4580, #4593).

## Design

| Pin | Verdict |
|---|---|
| PRE_SWAP migration hashes | Keep: version-independent, protects the applied prod DB history |
| Version pin and PLATFORM_ADDITIONS hash list | Replace: additions = shipped minus PRE_SWAP; run the existing additive-only SQL check on them (destructive migrations still go red) |
| Composed-surface baseline and EXPECTED_DIFF | Replace with a coding-extension contract test: every coding-contributed path and schema is present in the composed document, unchanged, not overridden by the platform; no coding path collides with a platform path; rendered pages return 200 with coding markers. No hashes of platform-owned operations or pages |
| Committed spec byte-identity | Keep, regenerate in the bump (PMR-1.3). `admin/openapi.json` is a committed package export; the coding spec's info.version is a constant |

The merge gate is fixed by PMR-1.2 (wait for all required checks on the PR head, never admin-merge over a failing one); PBH-2.1 adds behavioral proof by moving the gate logic into a testable script.

## Tasks

| ID | Title | Depends on | Layer | Model |
|---|---|---|---|---|
| PBH-1.1 | test: derive platform migration additions instead of pinning them per release | none | Database | sonnet (3, 2h) |
| PBH-1.2 | test: replace the pre-swap composed-surface baseline with a coding-extension contract test | none | API | sonnet (4, 4h) |
| PBH-1.3 | fix: regenerate the committed admin spec for the current platform pin | PBH-1.2 | API | sonnet, inherits bundle (1, 1h) |
| PBH-2.1 | test: simulate the bump merge gate against recorded check timelines | PMR-1.2 | CLI | sonnet (3, 3h) |

PBH-1.1 to 1.3 share branch `fix/pbh-platform-pins-rework`, so one PR turns main green.

```
[PRIOR SESSIONS]
  └─ PMR-1.2: wait for all required checks [pending]  (platform-main-red-admin-pin)
[START]
  ├─ PBH-1.1 ─┐
  ├─ PBH-1.2 ─┴─ PBH-1.3   (one bundled PR)
  └─ PBH-2.1 (needs PMR-1.2)
```

## Task wiring changes (task store)

- PMR-1.2: drop dependency on PBP-1.2 so it can run now (accepting a likely merge conflict in `platform-release.yml` with PBP-1.2).
- PMR-1.3: kept; not subsumed, the committed `admin/openapi.json` still needs regenerating in the bump.

## Breaking Change Safety

Test, fixture and generated-file changes plus one extracted script. Nothing renamed or removed that a consumer reads. Safe to deploy standalone: yes (each; the bundle ships as one PR). No HITL tasks; no new secrets.

## End state and verification

- An additive platform release gives a bump PR that is green with no human edits and merges only after all required checks complete.
- A destructive migration, a coding-route collision or failing CI still goes red and leaves the PR open.
- Real proof is the next two platform releases, monitored after merge. Any manual dispatch must first check the version is at or above main's pins (no repeat of dispatching 0.7.0 over 0.7.1).

## Decision Log

- Drop pre-swap composed-surface parity: approved by Dan; platform page/operation drift is the platform repo's responsibility.
- Drop per-migration human review in favor of the additive-only structural check: approved by Dan. Open risk: an additive-but-heavy migration (large index) runs without review; migration application on deploy not examined.
- Prefix PBH (free).
- PMR-1.3 kept rather than superseded.
