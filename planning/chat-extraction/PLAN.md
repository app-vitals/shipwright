# Plan: move the chat service into app-vitals/agent

Session: `chat-extraction` (task prefix `CHX`). Part of the wider agent extraction (sessions `agent-runtime-extraction-prep` and `agent-repo-extraction`).

## Goal

Move the chat service (`chat/`, `@shipwright/chat`) out of `app-vitals/shipwright` and into `app-vitals/agent`, so the platform repo owns the whole agent-facing stack: runtime, admin, shared lib and chat. Shipwright keeps consuming chat as a published image.

## Findings

- `chat/` is self-contained: 46 TypeScript files, no imports from `task-store`, `admin` or `agent/`. Its only workspace dependency is `@app-vitals/agent-lib`, pinned from the registry in shipwright. In the agent repo that becomes a workspace link.
- The platform already talks to chat over HTTP (runtime chat client, chat poller, chat token reporter; admin provisioning client, credential config, chat client), wired by `SHIPWRIGHT_CHAT_*` env vars.
- Shipwright-side touchpoints: root workspaces, `chat/Dockerfile` and every Dockerfile that copies `chat/package.json`, `build-chat.yml`, the chart (chat deployment, service, secret, PDB, service account, values), chart tag auto-bump and drift checks, the chat test database in `ci.yml`, `seed-chat-tokens`, `dev-tmux`, `generate-chat-spec`, `check-coverage`, the Taskfile minikube task, docs.
- Downstream deployments inherit the chat image from the shipwright chart default rather than pinning it themselves, so the chart is the only image pin that has to change.
- Other services reach chat at the in-cluster name `shipwright-chat:3000` and read its OpenAPI document by path. Those names are a contract and must not change in this session.

## Design

1. **Import, don't rewrite.** Copy `chat/` into the agent repo as `chat/` (package `@app-vitals/agent-chat`). Prisma schema and migration history carry over byte-identical. Database name, env var names, port and service name are unchanged, so there is no migration re-run and existing threads and tokens survive the cutover.
2. **Publish an image from the platform release.** `ghcr.io/app-vitals/agent-chat` with plain semver tags, built by the same release workflow as `agent` and `agent-admin`. It takes the platform version and is rebuilt on every release even if chat did not change. Accepted for simplicity.
3. **Keep the platform admin's chat integration optional.** The AEP-2.2 seam stays env-driven; no change.
4. **Cut over in three steps: add, migrate, remove.** Add the new image and CI in the agent repo. Repoint the chart, dev flow and CI in shipwright. Remove `chat/` from shipwright last, after a verified rollout. The old build keeps running until removal so rollback stays possible.
5. **Chart stays in shipwright for this session.** Only the chat image reference moves. Moving the chart (and where shared charts live) is a separate, sooner-rather-than-later session.

## Decisions and assumptions

- History is **copy-only**: the agent repo requires PR review with no direct-push bypass, so a merge of unrelated histories would be flattened by the pipeline's merge strategy. The source commit is recorded in the import PR; history stays in shipwright. Reverse this by editing CHX-1.1 before it runs.
- Version coupling: chat versions with the platform (confirmed).
- Service name, database name, secret names and env var names are frozen.

## Tasks

| Task | Repo | Depends on | Notes |
|---|---|---|---|
| CHX-1.1 | agent | none | Import chat as a workspace (bundled with 1.2) |
| CHX-1.2 | agent | none (same branch as 1.1) | Chat tests, test DB, boundary gate in CI |
| CHX-1.3 | agent | 1.1 | HITL: migrations apply additively to a copy of the live chat schema |
| CHX-1.4 | shipwright | 1.1, AGR-4.4 | Extend the freeze guard to `chat/**` (moot if the guard is already gone) |
| CHX-2.1 | agent | 1.1 | Build and publish `agent-chat` on release; smoke test; dispatch |
| CHX-2.2 | agent | 1.1 | Docs and the published OpenAPI document |
| CHX-3.1 | shipwright | 2.1, AGR-4.4 | Repoint the chart image; rewire bump and drift checks |
| CHX-3.2 | shipwright | 3.1, 1.3 | HITL: roll out per environment and verify |
| CHX-3.3 | shipwright | 2.1, AGR-4.4 | Rewire the dev flow |
| CHX-4.1 | shipwright | 3.2, 3.3, AGR-4.4 | Remove `chat/` from shipwright |

```
[AGR-4.4 in progress]
CHX-1.1 + CHX-1.2 (one PR, agent repo)
  ├─ CHX-1.3 (HITL schema check) ──────────────┐
  ├─ CHX-1.4 (freeze guard; needs AGR-4.4)     │
  ├─ CHX-2.2 (docs, OpenAPI)                   │
  └─ CHX-2.1 (publish image)                   │
        ├─ CHX-3.1 (chart; needs AGR-4.4) ─────┴─ CHX-3.2 (HITL rollout) ─┐
        └─ CHX-3.3 (dev flow; needs AGR-4.4) ──────────────────────────────┴─ CHX-4.1 (remove; needs AGR-4.4)
```

Only the tasks that edit files AGR-4.4 is already changing (CI path filters, chart drift and bump checks, Taskfile, dev docs) are blocked on it. The agent-repo work can start immediately.

## Breaking change safety

The image rename is add, migrate, remove: CHX-2.1 adds the new image, CHX-3.1/3.2 move consumers, CHX-4.1 removes the old build. No task drops the old image while a consumer still uses it. No schema change: migrations are copied verbatim, so there is no constraint addition and no backfill.

## Out of scope / follow-ups

- Moving the chart out of shipwright (next session).
- Specialists' references to the old OpenAPI path: its chat client is typed on the shipwright path. CHX-2.2 publishes the new location; the specialists repo needs a small follow-up owned by its maintainers.
- The specialists image rebase and vitals-os per-specialty images (see the agent-extraction plan).
