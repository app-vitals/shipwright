# Plan: plugin-install-integrity

## Pass 1 — 2026-11-18 — specs 1

### Design
Root cause: `.dockerignore` `**/coverage` (no negation) drops `plugins/shipwright/scripts/coverage/`
from the build context, so `agent/Dockerfile`'s `COPY plugins/ ./plugins/` ships a plugin whose
`coverage-summary.ts` imports files that don't exist. The marketplace sync installs from the same
image, so one fix covers both install paths.

Audit results (done before queueing):
- shipwright `.dockerignore`: only `plugins/shipwright/scripts/coverage` (14 tracked files) collides; other matches are intentional `e2e/` dirs.
- agent `.dockerignore`: no collision under `plugins/`; relative-import check of its `plugins/` = 0 unresolved. Guard only.
- Installed `/app/plugins`: 3 unresolved imports, all in `coverage-summary.ts` (`exclusions`, `normalize`, `types`).
- `~/.claude/plugins/cache/shipwright/shipwright/1.500.0` also lacks `scripts/coverage/`.
- baked `vitals-os` marketplace: 0 unresolved.

### Tasks
| Task | Repo | Title | Deps | HITL |
|---|---|---|---|---|
| PII-1.1 | app-vitals/shipwright | fix: keep plugin scripts/coverage in docker build context | — | |
| PII-1.2 | app-vitals/shipwright | test: verify plugin script imports resolve in the built image | 1.1 (same branch) | |
| PII-1.3 | app-vitals/agent | test: guard baked plugins/ against dockerignore exclusion | — | |
| PII-2.1 | app-vitals/shipwright | chore: roll out fixed image and retry blocked test-readiness tasks | 1.1, 1.2 | ⚠ HITL |

1.1 and 1.2 share branch `fix/pii-docker-coverage-context` (bundle, model sonnet).

### Dependency Map
```
[START]
  ├─ PII-1.1 (no deps) ── PII-1.2 (bundle-mate) ── PII-2.1
  └─ PII-1.3 (no deps)
```

### Breaking Change Safety
All additive; only widens the build context. Safe to deploy standalone: yes (all tasks).

### Not carried
- "Success: phase 4 completes" is verified by PII-2.1's retry, not by a code test.

### Decision Log
- owner: left empty — not resolved for this session.
