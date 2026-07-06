---
name: canary-execution
description: >
  Cross-cutting contract for the test-readiness pipeline. Defines how canary-eligible test code runs in two modes — `local` (boot dependencies inline, hit localhost) and `canary` (skip the boot, hit a deployed `TEST_TARGET_URL`) — via a dedicated entry point separate from the local smoke runner. Specifies eligibility rules (read-only or self-cleaning, smoke/E2E only, critical/high tier only, zero DB-dependent tests) and the deploy-gate budget (<60s wall time). Referenced by the inventory, system-design, migration, and roadmap skills.
---

# canary-execution skill

## Purpose

Make "tests run locally" and "tests validate canary deploys" compatible — same code, separate entry point.

## The contract

### Entry point

The canary suite runs from a **dedicated entry point** — a separate npm script (`test:canary`) or a dedicated Playwright project (e.g., `playwright.canary.config.ts`). It must never reuse `test:smoke` or the local smoke runner.

The separation is mechanical: CI wires two distinct jobs — `smoke` (pre-merge, boots local deps, runs `test:smoke`) and `canary` (post-deploy, sets `TEST_TARGET_URL`, runs `test:canary`). These jobs must not share a script.

### Mode selection

Every canary-eligible smoke/E2E test reads `TEST_TARGET_URL` at process start:

- **Unset** → `local` mode. Test boots its dependencies inline (docker-compose / testcontainers / in-memory) and makes HTTP calls to `http://localhost:<port>`.
- **Set to a URL** → `canary` mode. Test skips local boot. Makes HTTP calls directly to `$TEST_TARGET_URL`. Uses canary-only auth credentials supplied via separate env vars (e.g., `TEST_AUTH_TOKEN`).

The test code is identical. Only the setup-fixture layer branches.

### Eligibility rules

A test is canary-eligible iff **all** of the following hold:

1. **Layer** ∈ {smoke, E2E}. Never canary unit or integration tests — they require boundaries that don't exist in a deployed environment.
2. **Criticality** ∈ {critical, high}. Don't waste canary budget on medium-tier flows.
3. **Read-only OR self-cleaning.** Either:
   - The test makes no writes to persistent state, OR
   - The test creates state in setup AND deletes it in teardown — and the teardown runs even if the assertion fails (try/finally semantics).
4. **No destructive side effects.** No deleting other users' data. No sending real emails. No charging real cards. Canary auth must be scoped so even an attempt to do these things is rejected by the deployed service.
5. **Tolerates eventual consistency.** Deployed envs may have queues, CDN caches, etc. that local-mode does not. Use retry-with-backoff in the assertion if applicable, with a hard time cap.
6. **Zero DB-dependent local tests.** A test that boots a local database in `local` mode is not canary-eligible. In canary mode there is no local database to boot — the test will fail at the setup step, not at the assertion. If a test currently boots a DB, it must be refactored to use the deployed service's API for any state setup before it can be promoted to the canary suite.

Rules 3 and the cleanup discipline below are derived from `t7_canary_safety` in `references/principles.md` — canary-eligible tests must be wrapped with the canary-mode helper and must clean up after themselves. Treat `references/principles.md` as the canonical source for these safety principles.

### Budget

- **Per-test 95p target**: <5 s smoke, <30 s E2E (same as local mode)
- **Suite wall-time hard cap**: **60 seconds total** for the entire canary suite. This is a deploy-gate budget — anything slower is not run on every deploy and therefore not actually a gate.

If the canary suite exceeds 60s, one of:
- The suite is too large (drop tests to critical-only)
- Tests are not parallelized (parallelize them)
- Tests are inherently slow (rebuild them — they're doing too much for a canary)

### Gating

- A test marked canary-eligible but **failing in local mode** is rejected at PR time. The local mode is the primary contract.
- A canary-eligible test **failing in canary mode** blocks promotion from staging to production (or whatever the next environment is).
- Canary failure paths must surface the deployed URL, the failing assertion, and a recent log/trace link.

## Canary safety lint

The eligibility rules require canary tests to be read-only or self-cleaning, but stating the rule doesn't enforce it. Before a test file is promoted to the canary suite, run this verifiable check:

### Step 1 — scan for write patterns

```bash
grep -En \
  "(\.create|\.update|\.delete|\.insert|\.upsert|\.patch|\.save|\.destroy|\.truncate|\bPOST\b|\bPUT\b|\bPATCH\b|\bDELETE\b)" \
  <canary-spec-files>
```

Every match is a candidate prod-write path.

### Step 2 — classify each match

For each match, classify as one of:
- **Safe: setup-only** — write is in `beforeEach` / `beforeAll` / `setup()` and a matching delete exists in `afterEach` / `afterAll` / teardown. Verify the teardown runs inside a `try/finally` so it fires even on assertion failure.
- **Safe: canary-scoped** — write targets a canary-only resource (e.g., a test user created with a `canary-` prefix that the deployed service scopes to the `TEST_AUTH_TOKEN` holder).
- **Unsafe: prod-write path** — write targets shared state, another user's data, or a resource that is not cleaned up unconditionally.

### Step 3 — verdict

| Result | Action |
|---|---|
| Zero matches | File is clear. Proceed. |
| All matches are Safe | File is clear. Document the teardown evidence in the PR description. |
| Any Unsafe match | File is not canary-eligible. Mark it `rebuild` in the migration bucket. |

### Where this runs

- **test-migration (Phase 3)** runs the lint against every test the inventory marked `canary-eligible` to validate or override the tag.
- **test-publish (Phase 5)** includes the lint result as an acceptance criterion in the issue body for any task that promotes a test to the canary suite (see `issue.md.tmpl`).
- **CI** should run the grep as a canary-suite pre-check job. A match that is not classified Safe fails the job.

## How other skills reference this

- **`test-inventory`** uses eligibility rule (1)+(2)+(3) to tag the canary column.
- **`test-design`** copies the mode-selection contract into the `test-system.md` artifact and prescribes the local-substitute setup that lets local-mode boot without external network.
- **`test-migration`** uses this contract to identify tests that *claim* canary eligibility but actually mutate persistent state — those are promote/rebuild, not reuse.
- **`test-roadmap`** Milestone 3 ("Canary suite live") gates on this contract being honored end-to-end.

## Anti-patterns

- **"Just point E2E tests at staging."** No — most E2E tests are not idempotent. They mutate state, leave residue, and break each other. Canary requires explicit cleanup discipline.
- **"Skip auth in canary mode."** No — canary auth proves the deployment's auth wiring works. Use canary-only tokens, not auth-bypass.
- **"Run canary as part of the PR gate."** No — canary needs a deployed env. It's a post-deploy gate, not a pre-merge gate.
- **"Make the canary suite huge for safety."** No — a 10-minute canary suite is not run on every deploy. A 30-second suite is.
- **"Reuse `test:smoke` as the canary entry point."** No — `test:smoke` boots local dependencies. When `TEST_TARGET_URL` is set in that same job, the boot step will either succeed (wasting time on setup that isn't used) or fail (if the boot requires network). The canary entry point must skip all local setup unconditionally.
- **"Any test that passes locally is canary-eligible."** No — a test that boots a database in local mode fails in canary mode because there's no database to boot. Canary eligibility requires the test to be DB-free in its setup path.
