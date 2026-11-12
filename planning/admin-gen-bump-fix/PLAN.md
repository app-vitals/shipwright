# Plan: admin-gen-bump-fix

Fix the platform release bump failure (run 40538666233, issue #4549). `bun run generate:admin-types`
crashes on clean main (`Cannot read properties of undefined (reading 'merge')` in @redocly/openapi-core)
because redocly's js-yaml link resolves to the root js-yaml 5.5.0 (added in #4308); bun.lock has no
nested js-yaml 4.x entry. First hit by the regenerate step added in #4605 (PBH-1.3).
A minimal project (js-yaml ^5 + openapi-typescript ^7) does NOT reproduce, so the cause is specific to
this repo's workspace layout / lockfile — AFB-1.1 diagnoses it.

| Task | Depends on |
|---|---|
| AFB-1.1 fix: make generate:admin-types work on a clean install | — |
| AFB-1.2 ci: guard admin spec/types generation on every PR | AFB-1.1 |

Operational follow-ups (not tasks): re-run the 0.9.1 bump after merge; close #4549; reconcile PBH-2.1 record.

Breaking change safety: both tasks safe to deploy standalone.

## Decision Log
- Guard scope: every PR, per Dan's approval — the failure came from an unexpected lockfile change.
