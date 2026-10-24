# Plan: gh-graphql-owner-hint

Fix: `gh api graphql` uses the default installation token in a multi-org GitHub App setup.

## Problem
With per-owner tokens in `gh-token.d/`, the `gh` wrapper picks a token via `gh-owner-resolver.ts`. The resolver finds an owner only from `-R/--repo`, a `repos/<owner>/...` API path, or a `gh repo clone` argument, and skips the cwd-remote lookup for `gh api`. A GraphQL call (`gh api graphql -f query=...`) carries the repo inside the query text, so no owner is found and the default token is used. Queries for repos under another installation fail with "Could not resolve to a Repository".

## Design
- **Hint env var:** `SHIPWRIGHT_GH_OWNER`, highest-priority resolver source (`ownerHint` option). Validated with `OWNER_RE`; an invalid hint falls back to the default owner, never a different owner.
- **CLI/wrapper:** `resolve-gh-owner.ts` reads the env var and passes it as `ownerHint`; `bin/gh` is otherwise unchanged. An owner with no token file still fails naming the org.
- **Runtime helper:** `ghGraphql(query, { owner?, baseDelayMs? })` sets the hint in the spawned env when `owner` is given; otherwise behaviour is unchanged. The injected `ghGraphql` signature becomes `<T>(query, opts?: { owner?: string })`; callers that build `repository(owner:, name:)` queries pass that owner.
- **Plugin helper:** same `owner` param. It runs behind the same wrapper; outside the agent, with no `gh-token.d/`, the env var is inert.
- `getCurrentUser()` (`viewer`) deliberately uses the default token.
- **Not doing:** pinning `GH_APP_INSTALLATION_ID` (moves the failure); parsing query text for owners (brittle).

## Tasks
| Task | Depends on | Blocks |
|---|---|---|
| GQH-1.1 | - | 1.2, 1.3 |
| GQH-1.2 | 1.1 | 1.4 |
| GQH-1.3 | 1.1 | 1.4 |
| GQH-1.4 | 1.2, 1.3 | - |

All four share branch `feat/gqh-graphql-owner-hint` (one PR). Every task is additive (optional param, inert env var): safe to deploy standalone.

Rollout (image release, deployment roll, log verification) is out of scope for this effort.

## Decision Log
- Hint env var name: defaulted to `SHIPWRIGHT_GH_OWNER`, confirmed by requester.
- Plugin helper: relies on the same wrapper behaviour; env var is inert without `gh-token.d/`.
- Callers without a known repo: only `getCurrentUser`, which intentionally uses the default token.
