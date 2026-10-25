# Plan: cos-p10-ask-scopes — Chief of Staff, Phase 10: Ask Primitive + Narrower Admin Scopes

**Repo**: app-vitals/shipwright · **Session**: cos-p10-ask-scopes · **Spec**: [PRODUCT-SPEC.md](./PRODUCT-SPEC.md) · **Parent plan**: `planning/chief-of-staff/PLAN.md` in app-vitals/specialists (phase 10 of 13; B2, B5, B7) · **Planned**: 2026-10-24 · **Approved**: 2026-10-24

## Technical design

Five additive admin-API capabilities, each off by default or a strict subset of what a `*` key can already do. A deployment that upgrades and changes no values gains nothing; Feature 34's golden env test proves it.

**Scopes (`admin/src/api-auth.ts`).** New scope values `platform.read` and `platform.ops`, dot-spelled because `parseAdminApiKeys` takes the last colon-separated segment as the scope (a colon in the name would corrupt the token). The middleware sets `scope: {kind: "admin"|"agent"|"platform-read"|"platform-ops", agentId?}` beside `isAdmin`/`caller`; `platform.read` passes every GET/HEAD as a non-admin and 403s all mutations; `platform.ops` adds the exported constant `PLATFORM_OPS_ROUTES` (PATCH `/agents/{id}` except `accountId`; repos add/remove; PATCH `/agents/{id}/crons/{cronId}`; `/agents/{id}/ask`; `/agents/{id}/chat-credentials…`) via a `requireScope` helper in those handlers. `*`, `<agentId>` and session behaviour unchanged; existing auth tests pass unmodified. `callerLabel()` carries the scope kind.

**Chat thread `kind` (chat service).** Nullable `Thread.kind`, `askFromAgentId`, `askDepth`; settable on `POST /threads` only by an admin token (agent token → 403), immutable via PATCH (400), returned on reads. Additive Prisma migration, `chat/openapi.json` regenerated, `HttpChatClient.createThread` gains the optional fields. Server-set authority, never a title prefix (B7).

**repos add/remove.** `POST /agents/{id}/repos {repos[]}` (union, idempotent, `describeRepoNameCollision` on the result) and `DELETE /agents/{id}/repos/{owner}/{name}` (404 if absent); same callers as PATCH plus `platform.ops`; unflagged because PATCH could already do this. PATCH keeps replace semantics.

**Ask (`admin/src/agent-ask.ts`, `agent-ask-config.ts`).** `SHIPWRIGHT_AGENT_ASK_ENABLED="enabled"` or the route is 404 (the accounts-API self-serve pattern). `SHIPWRIGHT_AGENT_ASK_ALLOWLIST="from>to,…"`, empty denies all. `POST /agents/{id}/ask {from, question, waitMs ≤ 60000, depth (1 only), ttlSeconds}` → `201 {askId, threadId, status, reply?}`; callers `*`, `platform.ops`, or the agent key equal to `from`. Flow: admin `ChatClient.createThread(id, {kind:"ask", askFromAgentId, askDepth:1, title})` → `createMessage` → poll `listMessages` every 1 s (injected clock) until `repliedAt` or budget. Audit: new admin Prisma model `AgentAsk` (no question text), read via `GET /agents/{id}/asks`. `createAdminApp` gains optional `chatClient` (absent → 503). Platform side only: no `./coding/*` imports, no relative imports into `chat/`; `import-boundary` and `platform-manifest` tests are gates.

**Chat credentials.** `POST /agents/{id}/chat-credentials {label}` → `201 {tokenId, rawToken…}` once; `DELETE …/{tokenId}` → 204; `GET` lists without raw values; behind `SHIPWRIGHT_CHAT_TOKEN_MINT_ENABLED`; callers `*` or `platform.ops` only; reuses `HttpChatServiceProvisioningClient.mintToken/revokeToken/listTokensForAgent`; token always scoped to `{id}` (no `agentId` in the body). Named `chat-credentials` because `/agents/{id}/chat-tokens/daily` is usage. Structured log per mint/revoke, never the token.

**`/doc`.** `SHIPWRIGHT_ADMIN_DOC_ENABLED="enabled"` mounts the platform OpenAPI 3.1 document (`buildPlatformAdminSpec()`), behind the admin auth middleware (any valid credential), `Cache-Control: no-store`, byte-identical to the committed platform spec. Research found production exposes no `/doc` today; `admin-spec.smoke.test.ts`'s "planned follow-up" comment is updated.

**Chart.** `admin.ask {enabled, allowlist[]}`, `admin.chatCredentialMint.enabled`, `admin.doc.enabled`, rendered like the `selfServe` block before `admin.extraEnv`; schema entries; helm unit tests; chart minor bump; README rows. The downstream umbrella pin and any prod flag flip are out of scope.

**Docs.** `docs/configuration.md` (flags; note `check-config-docs` skips `admin/src`), `docs/agent-api.md` (scope table, `PLATFORM_OPS_ROUTES` parity test, security-posture paragraph, corrected session-cookie sentence), `agent-api-resources.md`, `chat.md`, `agent-key-files.md`, agent-admin skill curl examples with a plugin version bump.

**Complexity notes.** COS-31.1 is the one architectural task: first audit table in admin, a new platform module, cross-service calls. Spec drift tests force regeneration in every route task. Public repo: scrub before commit, stage specific files.

**Testing strategy (from the spec).** Scopes: unit + smoke route table. Chat kind: smoke + integration (real Postgres, skipped without `DATABASE_URL_SHIPWRIGHT_CHAT`) + spec-drift unit. repos: smoke + integration. Ask: unit (config) + smoke (fakes, fixed clock) + integration (audit row). Credentials: smoke + log-capture unit. `/doc`: smoke. Chart/docs: content.

## Tasks

| ID | Title | Layer | Deps | Branch | Hrs | Cx | Model | HITL |
|---|---|---|---|---|---|---|---|---|
| COS-28.1 | feat: add platform.read and platform.ops admin key scopes | API | — | feat/cos-28-1-platform-scopes | 6 | 4 | sonnet | |
| COS-29.1 | feat: add admin-only kind, askFromAgentId and askDepth fields to chat threads | Database | — | feat/cos-29-1-chat-thread-kind | 4 | 3 | sonnet | |
| COS-30.1 | feat: add repos add and remove routes for agents | API | COS-28.1 | feat/cos-30-1-repos-add-remove | 4 | 3 | sonnet | |
| COS-31.1 | feat: add the flagged agent ask route with allowlist, depth cap and audit | API | COS-28.1, COS-29.1 | feat/cos-31-1-agent-ask | 8 | 5 | opus | |
| COS-32.1 | feat: add flagged chat-credential mint and revoke routes | API | COS-28.1 | feat/cos-32-1-chat-credentials | 4 | 3 | sonnet | |
| COS-33.1 | feat: serve the platform OpenAPI document at /doc behind a flag | API | COS-28.1 | feat/cos-33-1-doc-endpoint | 2 | 2 | haiku | |
| COS-34.1 | feat: expose the ask, chat-credential and doc flags as chart values | Shared | COS-31.1, COS-32.1, COS-33.1 | feat/cos-34-1-chart-flags | 3 | 2 | haiku | |
| COS-35.1 | docs: document scopes, ask, chat credentials and the flags | Shared | COS-30.1, COS-34.1 | docs/cos-35-1-ask-scopes-docs | 3 | 2 | haiku | |

Eight tasks, 34 hours. HITL budget: 0 of 8. Kept: none. Converted: none. Gap tasks filed: none.

## Dependency map

```
[START]
  ├─ COS-28.1 scopes
  │     ├─ COS-30.1 repos add/remove ─────────────────────────┐
  │     ├─ COS-31.1 ask route (also needs 29.1) ─┐            │
  │     ├─ COS-32.1 chat-credentials ────────────┼─ COS-34.1 chart flags ─┴─ COS-35.1 docs
  │     └─ COS-33.1 /doc ────────────────────────┘
  └─ COS-29.1 chat thread kind ─┘
```

| Task | Depends on | Blocks | HITL |
|---|---|---|---|
| COS-28.1 | — | 30.1, 31.1, 32.1, 33.1 | |
| COS-29.1 | — | 31.1 | |
| COS-30.1 | 28.1 | 35.1 | |
| COS-31.1 | 28.1, 29.1 | 34.1 | |
| COS-32.1 | 28.1 | 34.1 | |
| COS-33.1 | 28.1 | 34.1 | |
| COS-34.1 | 31.1, 32.1, 33.1 | 35.1 | |
| COS-35.1 | 30.1, 34.1 | — | |

## Breaking change safety

No renames, removals or constraint additions: nullable columns, new routes, new scope values, flag-gated mounts. `PATCH /agents/{id}` semantics unchanged. Safe to deploy standalone: yes, for all eight. No bundles.

## HITL scan

HITL scan: no tasks require human steps. No `.claude/**` paths; no new CI secrets; turning flags on in any deployment is an operator values change outside this phase.
