# Plan: gh-graphql-owner-hint

Fix: `gh api graphql` uses the default installation token in a multi-org GitHub App setup.

## Problem
With per-owner tokens in `gh-token.d/`, the `gh` wrapper picks a token via `gh-owner-resolver.ts`. The resolver finds an owner only from `-R/--repo`, a `repos/<owner>/...` API path, or a `gh repo clone` argument, and skips the cwd-remote lookup for `gh api`. A GraphQL call (`gh api graphql -f query=...`) carries the repo inside the query text, so no owner is found and the default token is used. Queries for repos under another installation fail with "Could not resolve to a Repository".

## Design
- **Hint env var:** `SHIPWRIGHT_GH_OWNER`, highest-priority resolver source (`ownerHint` option). Validated with `OWNER_RE`; an invalid hint falls back to the default owner, never a different owner.
- **CLI/wrapper:** `resolve-gh-owner.ts` reads the env var and passes it as `ownerHint`; `bin/gh` is otherwise unchanged. An owner with no token file still fails naming the org.
- **Runtime helper:** `ghGraphql(query, { owner?, baseDelayMs? })` sets the hint in the spawned env when `owner` is given; otherwise behaviour is unchanged. The injected `ghGraphql` signature becomes `<T>(query, opts?: { owner?: string })`; callers that build `repository(owner:, name:)` queries pass that owner.
- **Plugin helper:** same `owner` param. It runs behind the same wrapper; outside the agent, with no `gh-token.d/`, the env var is inert.
- **Inline prompt calls (GQH-1.5):** the 7 plain-bash `gh api graphql` calls in `review.md` (2) and `patch.md` (5) get an env-var prefix `SHIPWRIGHT_GH_OWNER={org}`. The four `resolveReviewThread` mutations carry only a thread id, so the hint is the only way they route correctly.
- **Token-file hardening (GQH-1.6):** a transient mint failure for one installation must not delete `gh-token.d/`, which would silently send every call to the default token (the hint is ignored when the directory is absent). Failed owners keep their last good file and still count toward the 2-owner threshold; the directory is dropped only when fewer than 2 installations are tracked. A failed default mint leaves `gh-token` as is instead of substituting another installation's token.
- **Visibility (GQH-1.7):** the wrapper warns on stderr when a hint is set but `gh-token.d/` is absent; directory removal is logged (owner logins only, never tokens). The preserved-owner log line ships with GQH-1.6.
- `getCurrentUser()` (`viewer`) deliberately uses the default token.
- **Not doing:** pinning `GH_APP_INSTALLATION_ID` (moves the failure); parsing query text for owners (brittle).

## Tasks
| Task | Depends on | Blocks |
|---|---|---|
| GQH-1.1 | - | 1.2, 1.3, 1.5, 1.6, 1.7 |
| GQH-1.2 | 1.1 | 1.4 |
| GQH-1.3 | 1.1 | 1.5, 1.4 |
| GQH-1.5 | 1.1, 1.3 | 1.4 |
| GQH-1.6 | 1.1 | 1.7, 1.4 |
| GQH-1.7 | 1.1, 1.6 | 1.4 |
| GQH-1.4 | 1.2, 1.3, 1.5, 1.6, 1.7 | - |

All seven share branch `feat/gqh-graphql-owner-hint` (one PR). Every task is additive or a pure robustness fix (optional param, inert env var, preserved files): safe to deploy standalone.

Rollout (image release, deployment roll, log verification) is out of scope for this effort.

## Decision Log
- Hint env var name: defaulted to `SHIPWRIGHT_GH_OWNER`, confirmed by requester.
- Plugin helper: relies on the same wrapper behaviour; env var is inert without `gh-token.d/`.
- Callers without a known repo: only `getCurrentUser`, which intentionally uses the default token.
- Diagnosis: requester's cluster-side findings are taken as given; the logs were not reviewed. GQH-1.6/1.7 cover the second path found in code review (mint failure deleting `gh-token.d/`), which the hint alone cannot fix.
- Scope kept simple: env-var prefix and plain log lines only; no query parsing, no new regexes.
- Dependencies serialize the shared branch: 1.6 after 1.1 (no two tasks in flight on one branch), 1.5 after 1.3 (both edit plugin files and the version bump lives in 1.3).
