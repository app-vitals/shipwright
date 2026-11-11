# Plan: gh-owner-required

Replace the multi-org GitHub owner heuristics with one explicit input: `SHIPWRIGHT_GH_OWNER`. Every process Shipwright spawns carries it; the `gh` wrapper and the git credential helper refuse to guess.

## Problem
The `gh` wrapper guesses the target org from `-R`, a `repos/<owner>` API path, the `gh repo clone` argument, the cwd `origin` remote, or the default installation. GraphQL queries name the org inside the query text, which the wrapper cannot see, so it falls back to the default token and GitHub answers "Could not resolve to a Repository". GQH (PR #4469) adds the hint as the top-priority source; this effort makes it the only source.

## Design
- **One input:** `SHIPWRIGHT_GH_OWNER` -> `gh-token.d/<owner>`. Unset: hard fail. Set but no token file: hard fail naming the org. No fallback to another org's token.
- **App auth, any installation count:** per-owner token files are always written, including with a single installation (the default token file stays for compatibility). Under a PAT (no `GH_TOKEN_FILE`) the wrapper passes through and ignores the hint.
- **Agent process (loop, checks, reconcilers, hitl, backfills):** no ambient org, so `owner` is a required parameter on `ghJson`/`ghRun`/`ghGraphql` and each caller passes the org of the task or PR it is working on. Enforced by the compiler.
- **Claude spawn:** the hint is injected through `extraEnv` from the dispatched task/PR org. Crons without a repo use the default org (default installation: the pin, else the lowest id). Per-cron repos come later.
- **Plugin commands, skills and plugin scripts:** unchanged. They run under Claude and inherit the env var; outside Shipwright there is no wrapper or `gh-token.d/`.
- **DMs:** spawn with no hint. The wrapper error is the teacher: it states what the variable is, why it is required, the exact retry (`SHIPWRIGHT_GH_OWNER=<org> gh ...`), and to prefix each command since shell state does not persist. `RUNTIME.md.template` carries the same one-line rule.
- **git:** the credential helper uses the same hint and the same error; the path-based owner and the default-token fallback are removed. Both copies change (`agent/scripts/bin` and `scripts/extract-platform/template`).
- **Deleted:** `gh-owner-resolver.ts` logic, `agent/scripts/resolve-gh-owner.ts`, the per-call `bun` spawn in `bin/gh`.

## Tasks
| Task | Depends on | Blocks | Safe standalone |
|---|---|---|---|
| GOR-1.1 | GQH-1.1, 1.2, 1.3, 1.5 | 1.2, 1.3 | yes (additive) |
| GOR-1.2 | 1.1 | 1.4 | yes (callers and signature change together) |
| GOR-1.3 | 1.1 | 1.4 | yes (additive env) |
| GOR-1.4 | 1.2, 1.3 | 1.5 | yes, only after every spawn site passes the hint |
| GOR-1.5 | 1.4 | - | yes |

Enforcement (1.4) is last on purpose: requiring the hint before all spawners set it would break every gh call in between (add -> migrate -> remove).

## Reconciling GQH
- GQH-1.1/1.2/1.3/1.5 (PR #4469) are the foundation; GOR-1.1 waits on them.
- GQH-1.1's "invalid hint falls back to default" and "no hint changes nothing" are reversed by GOR-1.4.
- GQH-1.6 (keep last good token files when a mint fails) is unaffected and stays.
- GQH-1.7 (visible degraded routing) is subsumed by the loud failure; cancelled.
- GQH-1.4 (graphql owner-hint docs) is subsumed by GOR-1.5; cancelled.

## Decision Log
- Single-org agents: defaulted to requiring the hint everywhere (confirmed by requester).
- PAT: hint accepted and ignored, never fails (confirmed by requester).
- Crons without a repo: default org for now (confirmed by requester).
- DMs: no hint; error message plus RUNTIME.md teach per-command override (requester's design).
- git: same hint and error as gh, path-based owner dropped. Trade-off accepted: a single git command that spans two orgs needs two invocations.
- Duplicate plugin `check-helpers.ts`: left alone; it runs under Claude and inherits the env var. Removal is a separate follow-up.
