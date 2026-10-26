# Plan: platform-release-bump

Repo: app-vitals/shipwright. Hardens `.github/workflows/platform-release.yml`, the receiver for the `platform-release` dispatch from app-vitals/agent.

## Findings (2026-10-26)

- **npm race (recurring).** The agent repo's "Notify Shipwright" step dispatches ~50s after publish; the npm packument lists the new version ~3 min after publish. The workflow runs `bun install` immediately, so it fails with `No version matching "X" found for specifier "@app-vitals/agent-admin"`. Failed for 0.6.0, 0.6.1 and 0.7.0. A later release (0.7.1) succeeded only because its dispatch landed after propagation.
- **Conflict window (one-off).** A re-run checked out main 9s before #4578 merged, so the generated bump PR was `CONFLICTING`. Required checks never ran (they run on the merge ref), and "Wait for checks and merge" reported a generic "Required check(s) failed".
- **Failure issue.** #4549 dedups correctly (one issue, one comment per failure) but is never closed after a later bump succeeds.

## Design (all in `.github/workflows/platform-release.yml`)

1. Wait for `@app-vitals/agent-*@$VERSION` on npm before `bun install`. Package list from a new `--list-packages` mode in `scripts/platform-release-bump.ts`. Poll `npm view` every 15s, up to ~10 min, fail with a clear message.
2. Before waiting on checks, poll `gh pr view --json mergeable` past `UNKNOWN`. On `CONFLICTING`, log a distinct `::error::` and self-re-dispatch once via `workflow_dispatch` with a new `attempt` input (cap 2); that regenerates the branch from fresh main. Second conflict fails loudly.
3. Close the open "platform release bump failed" issue (comment + close) after a successful bump.

## Tasks

| ID | Title | Depends on | Layer | Model |
|---|---|---|---|---|
| PBP-1.1 | fix: wait for @app-vitals/agent-* on npm before the platform bump installs | none | CLI | sonnet (3, 2h) |
| PBP-1.2 | fix: rebuild the platform bump branch when the PR conflicts with main | PBP-1.1 | CLI | sonnet (3, 3h) |
| PBP-1.3 | ci: close the platform bump failure issue after a successful bump | PBP-1.2 | CLI | haiku (2, 1h) |

```
[START]
  └─ PBP-1.1
        └─ PBP-1.2
              └─ PBP-1.3
```

The chain is sequential only because all three edit the same workflow file.

## Breaking Change Safety

All three are additive (new step, new optional workflow input, new success step). The agent repo only sends the `platform-release` event and its payload is unchanged. Safe to deploy standalone: yes (all three). No HITL tasks; no new secrets (reuses `DISPATCH_TOKEN`).

## Decision Log

- Session slug: defaulted to `platform-release-bump`.
- Task prefix: PBP (PRB, PRN, PRL, PRC already used in the task store).
- Conflict handling: self-re-dispatch with an attempt cap, chosen over extracting a rebuild script because it reuses the existing generation path unchanged.
- Fix lives in the receiver, not the agent repo's notify step, so it also covers manual runs and Renovate-fallback timing.
