# Chief of Staff, Phase 10: Ask Primitive + Narrower Admin Scopes — Product Specification

**Date**: 2026-10-24
**Session**: cos-p10-ask-scopes
**Repo**: app-vitals/shipwright (public; no client names, org internals or hostnames in any file)
**Status**: Draft, awaiting approval
**Parent plan**: `planning/chief-of-staff/PLAN.md` in `app-vitals/specialists` — phase 10 of thirteen; design from B2 (agent-to-agent and the chat-token mint gap), B5 (admin API gaps) and B7 (security posture for every shipwright change). This phase depends on nothing in the plugin track and runs in parallel with it.

## Overview

Add five platform capabilities to the Shipwright admin API, **every one off by default or granting nothing a `*` key could not already do**, so a deployment that upgrades and changes no flags behaves exactly as today:

1. `POST /agents/{id}/ask` — one agent asks another a question through a server-created chat thread, with a server-side allowlist of permitted pairs, depth capped at 1, and an audit row per ask (flag `SHIPWRIGHT_AGENT_ASK_ENABLED`).
2. Narrower admin key scopes `platform.read` and `platform.ops` beside the existing `*` and `<agentId>` scopes.
3. `repos` add and remove routes instead of replace-the-array.
4. Chat-token minting and revocation through the admin API (flag `SHIPWRIGHT_CHAT_TOKEN_MINT_ENABLED`).
5. A live OpenAPI endpoint `GET /doc` (flag `SHIPWRIGHT_ADMIN_DOC_ENABLED`).

Plus the chart values, schema and docs that expose them. The specialist that motivates this (a chief-of-staff agent in one deployment) is a consumer, not a reason for any default to change.

## Problem Statement

A specialist agent that operates a fleet today needs a `*` admin key, because the registry knows only "everything" or "one agent". It cannot ask another agent anything without a chat token that only an admin can mint from inside the cluster (`POST /tokens` on the chat service is admin-token-only and cluster-internal). Fixing an agent's repo scope means rewriting the whole `repos` array, which races with any concurrent change. And there is no live spec endpoint, so a tool that wants to discover routes reads a committed JSON file. Shipwright runs in at least one PCI deployment, so none of this can change existing behaviour by default; each capability ships behind a flag or is a strict subset of what the admin key can already do.

## Users & Context

- **Deployment operators** (including PCI deployments): upgrade the chart, see a diff of new flags that all default off, change nothing, get nothing new. Operators who want a capability turn its flag on in their values.
- **A platform-ops agent** (the chief of staff in the app-vitals deployment): holds a `platform.ops` key instead of `*`, asks other agents questions, fixes repo scopes additively, mints scoped chat tokens for the services it owns.
- **Coding agents warchild (author) and doc (reviewer)**: build the tasks under this repo's `CLAUDE.md` (scrub before commit, `task ci`, `task helm:check`, OpenAPI drift test).

---

## Features

Task ids continue the chief-of-staff sequence: this phase reserves `COS-28.x` to `COS-35.x`. Feature 28 → `COS-28.x`, and so on.

### Feature 28: Scope model — `platform.read` and `platform.ops`

**Priority**: High
**Description**: Extend `admin/src/api-auth.ts` so an admin key can carry a platform scope narrower than `*`, enforced by method and route, with existing `*` and `<agentId>` behaviour byte-for-byte unchanged.

**Requirements**:
- **Spelling**: scopes are `platform.read` and `platform.ops` (dot, not colon). `parseAdminApiKeys` splits entries on `:` and takes the last segment as the scope, so a colon inside a scope name would be mis-parsed as part of the token. Document this in the registry format comment.
- **Semantics**:
  - `platform.read`: every `GET`/`HEAD` on the admin API (`/agents…`, accounts API, `/doc` when enabled) succeeds as a non-admin reader; every mutating method is 403. `isAdmin` stays `false`.
  - `platform.ops`: `platform.read` plus a **named allowlist** of mutating routes: `PATCH /agents/{id}` (fields other than `accountId`), `POST`/`DELETE /agents/{id}/repos…` (Feature 30), `PATCH /agents/{id}/crons/{cronId}` (enable/disable/schedule), `POST /agents/{id}/ask` (Feature 31), `POST`/`DELETE /agents/{id}/chat-credentials…` (Feature 32). Everything else mutating — envs writes, agent create/delete/provision, tokens, federation, accounts — is 403. `isAdmin` stays `false`.
  - `*` and `<agentId>` scopes: unchanged. Session cookies: unchanged.
- **Mechanism**: the middleware sets a new context variable `scope: {kind: "admin"|"agent"|"platform-read"|"platform-ops", agentId?: string}` beside the existing `isAdmin`/`caller`. A helper `requireScope(c, "ops")` (or a route-table entry) is called from each allowlisted handler; the allowlist is a single exported constant `PLATFORM_OPS_ROUTES: {method, pathPattern}[]` so the test and the docs read the same list. Handlers not on the list keep their current `isAdmin` checks, which already deny these scopes.
- `callerLabel()` includes the scope kind for logs.

**Acceptance Criteria**:
- [ ] `api-auth.unit.test.ts`: `svc:tok:platform.read` parses with scope `platform.read` and token `tok`; a `platform.read` key gets 200 on `GET /agents`, 403 on `PATCH /agents/{id}`; a `platform.ops` key gets 200 on `PATCH /agents/{id} {repos}`, 403 on `PATCH /agents/{id} {accountId}`, 403 on `PATCH /agents/{id}/envs`, 403 on `DELETE /agents/{id}`; every pre-existing test in the file passes unmodified.
- [ ] A smoke test iterates `PLATFORM_OPS_ROUTES` and proves each is reachable with `platform.ops` and unreachable with `platform.read`; a second test proves a route **not** on the list (envs POST) is 403 for both.
- [ ] The accounts API and the runtime app (`api.ts`) that share the middleware behave identically for `*` and agent keys (their existing tests pass unmodified).
- [ ] `docs/agent-api.md` auth section documents the four scope kinds and the colon rule; the stale "session cookie sets `isAdmin=true`" sentence found during research is corrected while in there.

**Source Map**:
- `admin/src/api-auth.ts` (`parseAdminApiKeys` 87-108, bearer branch 177-198), `lib/request-context.ts` (`Caller`, `callerLabel`)
- `admin/src/agents-api.ts` (`isAdminOrSessionMember` ~1361; handler `isAdmin` checks)
- `admin/src/api-auth.unit.test.ts`, `admin/src/agents-api.smoke.test.ts`

**Testing Strategy**: Layer: unit (parser, middleware) + smoke (route table over in-process `app.request()` with signed cookies and bearer keys).

---

### Feature 29: Chat thread `kind` for server-set ask authority

**Priority**: High
**Description**: Additive nullable fields on the chat service's `Thread` so an "ask" thread is marked by the server, never by a title prefix (B7: "ask authority is server-set, never text").

**Requirements**:
- Prisma (chat): `Thread.kind String?` (`"ask"` only value today), `Thread.askFromAgentId String?`, `Thread.askDepth Int?`. Migration is additive, nullable, no backfill.
- `POST /threads` accepts `kind`, `askFromAgentId`, `askDepth` **only from an admin token** (chat admin token, `agentId === null`); an agent token sending any of them gets 403 `{error: "kind is admin-only"}`. `GET /threads…` returns them. `PATCH /threads/{id}` cannot change them (400).
- `chat/openapi.json` regenerated (`bun run generate:chat-spec`); the admin's `HttpChatClient.createThread` gains the optional fields.
- The agent runtime does **not** change in this phase; the convention that a `kind: "ask"` thread carries the asker's authority within the spine is phase 6's `SPECIALTY.md` text and reads the field via the existing `GET /threads/{id}`.

**Acceptance Criteria**:
- [ ] `chat/src/routes/threads.smoke.test.ts`: admin token creates a thread with `kind: "ask"`, `askDepth: 1` and reads it back; agent token sending `kind` → 403; PATCH with `kind` → 400; existing thread tests pass unmodified.
- [ ] `thread-service.integration.test.ts` (real Postgres, skipped without `DATABASE_URL_SHIPWRIGHT_CHAT`): round-trips the three fields and reads `null` on a thread created without them.
- [ ] `generate-spec.unit.test.ts` passes with the regenerated spec; `admin/src/http-chat-client.unit.test.ts` covers the new optional body fields with a cassette entry.

**Source Map**:
- `chat/prisma/schema.prisma`, `chat/src/routes/threads.ts` (CreateThreadBody 45-51, handler 261-287), `chat/src/openapi-schemas.ts` (Thread 54-77), `chat/openapi.json`
- `admin/src/http-chat-client.ts` (`createThread` 259-275)

**Testing Strategy**: Layer: smoke (routes) + integration (Prisma round-trip) + unit (spec drift, client).

---

### Feature 30: `repos` add and remove routes

**Priority**: High
**Description**: `POST /agents/{id}/repos` and `DELETE /agents/{id}/repos/{owner}/{name}` as additive alternatives to replacing the array in `PATCH /agents/{id}`.

**Requirements**:
- `POST /agents/{id}/repos {repos: string[]}`: each `org/repo` validated with `isOrgRepo`; union with the current list; `describeRepoNameCollision` applied to the **resulting** list (400 on a basename collision, same message as PATCH); idempotent (adding an existing repo is a no-op, 200). Returns the full updated agent as PATCH does.
- `DELETE /agents/{id}/repos/{owner}/{name}`: removes one; 404 if the agent lacks it; returns the updated agent.
- Both routes: admin `*`, the agent's own key (same as PATCH today), or `platform.ops`. Not flagged (they grant nothing PATCH could not).
- Registered before `/agents/{id}/*` wildcard ordering issues are checked (static-path-first comment at ~1392); `repos` is not a literal agent id so ordinary ordering suffices, but the test asserts `GET /agents/repos` is not shadowed.
- `PATCH /agents/{id} {repos}` keeps replace semantics; its doc comment now points at the new routes for incremental changes.

**Acceptance Criteria**:
- [ ] Smoke tests: add two repos to an agent with one → three; add a duplicate → unchanged, 200; add `a/x` when `b/x` exists → 400 with the collision message; delete one → removed; delete a missing one → 404; `platform.read` → 403, `platform.ops` → 200.
- [ ] Integration test (real Postgres) proves the stored array after add then remove equals the expected set and preserves order of untouched entries.
- [ ] `admin/openapi.json`, `admin/openapi.platform.json` and `lib/admin-types.ts` regenerated; `scripts/generate-admin-spec.unit.test.ts` passes.

**Source Map**:
- `admin/src/agents-api.ts` (PATCH route 541-562, handler 1461-1545), `admin/src/agents.ts` (`updateSelfHosted` 457-471, `describeRepoNameCollision` 742), `admin/src/openapi-schemas.ts` (`PatchAgentBodySchema` 41-62)

**Testing Strategy**: Layer: smoke + integration + spec-drift unit.

---

### Feature 31: `POST /agents/{id}/ask` behind `SHIPWRIGHT_AGENT_ASK_ENABLED`

**Priority**: High
**Description**: The ask primitive from plan B2: the admin creates a `kind: "ask"` thread on the target agent, posts the question, optionally waits for the reply, and records an audit row.

**Requirements**:
- Flag: `SHIPWRIGHT_AGENT_ASK_ENABLED` is on only when the value is the literal `"enabled"` (same convention as `SHIPWRIGHT_SELF_SERVE_ENABLED`); when off, the route returns 404 `{error: "Not found"}` exactly like self-serve does, so a probe cannot tell the route exists.
- Allowlist: `SHIPWRIGHT_AGENT_ASK_ALLOWLIST` is a comma-separated list of `fromAgentId>toAgentId` pairs; **empty means no agent may ask any agent** (403 `{error: "ask not allowed for this pair"}`). Parsed in a pure module (`admin/src/agent-ask-config.ts`) with unit tests, injected env.
- Route: `POST /agents/{id}/ask` body `{from: string, question: string (1–8000 chars), waitMs?: 0–60000 (default 0), depth?: 1 (default 1), ttlSeconds?: 60–3600 (default 600)}` → `201 {askId, threadId, status: "replied"|"pending", reply?: string}`. Caller must be `*`, `platform.ops`, or the agent key whose id equals `from` (an agent may ask on its own behalf, never impersonate). `depth` other than 1 → 400 `{error: "depth is capped at 1"}`; the server never trusts a client-supplied depth above 1 and the thread is created with `askDepth: 1`.
- Flow: `chatClient.createThread(id, {kind: "ask", askFromAgentId: from, askDepth: 1, title: "ask from <from label> · <ISO time>"})` → `createMessage(threadId, {role: "user", body: question})` → if `waitMs > 0`, poll `listMessages` every 1 s (clock-injected) until the user message has `repliedAt` or the budget ends → `status`. The thread persists for the target agent to finish even when `pending`; `ttlSeconds` is stored on the audit row for a later sweeper (not built here).
- Audit: new admin Prisma model `AgentAsk {id, fromAgentId, toAgentId, threadId, depth, waitMs, ttlSeconds, status, callerLabel, createdAt, repliedAt?}`; one row per call, written before the chat call and updated after. Listed by `GET /agents/{id}/asks?limit&offset` (`platform.read` or above) — the only read surface, for the fleet digest. No question text is stored in admin (it lives in the chat thread).
- Dependency injection: `createAdminApp` gains an optional `chatClient?: ChatClient`; absent (chat not configured) → 503 `{error: "chat service not configured"}` even when the flag is on. Code lives in `admin/src/agent-ask.ts` + `admin/src/agent-ask-config.ts` (platform side; imports only platform `admin/src` files, `@app-vitals/agent-lib/*` and npm — never `./coding/*`, never relative paths into `chat/`).
- Logging: one structured line per ask with `askId`, `from`, `to`, `status`, `callerLabel`; never the question.

**Acceptance Criteria**:
- [ ] `agent-ask-config.unit.test.ts`: `"enabled"` on, `"true"`/`""`/absent off; allowlist parsing incl. whitespace and a malformed pair (throws naming it); empty allowlist denies.
- [ ] `agent-ask.smoke.test.ts` with an in-memory `ChatClient` fake and fixed clock: flag off → 404; pair not allowlisted → 403 and no chat call; `depth: 2` → 400; happy path with `waitMs: 3000` and a fake that replies on the second poll → `status: "replied"`, `reply` body, thread created with `kind: "ask"`, `askDepth: 1`; `waitMs: 0` → `pending` immediately; agent key with `from ≠ its id` → 403; `platform.read` → 403; `platform.ops` → 201; chat client absent → 503.
- [ ] Integration test (real Postgres) writes and reads the `AgentAsk` row through `GET /agents/{id}/asks`.
- [ ] `admin/src/import-boundary.unit.test.ts` and `platform-manifest.unit.test.ts` pass with the new files (manifest `lib` table updated if a lib module is used).
- [ ] Specs and types regenerated; drift test passes.

**Source Map**:
- `admin/src/admin-boot.ts` (chat client construction 453-461; `createAdminApp` deps), `admin/src/self-serve-config.ts` (flag convention), `admin/src/accounts-api.ts:213` (404-when-off pattern), `admin/src/http-chat-client.ts`, `admin/prisma/schema/schema.prisma`
- `admin/src/agent-ask.ts`, `admin/src/agent-ask-config.ts` + tests — new

**Testing Strategy**: Layer: unit (config) + smoke (route with fakes) + integration (audit row).

---

### Feature 32: Chat-credential minting through the admin API, behind `SHIPWRIGHT_CHAT_TOKEN_MINT_ENABLED`

**Priority**: Medium
**Description**: Closes plan B2's gap: mint and revoke chat tokens scoped to one agent without a cluster round-trip.

**Requirements**:
- Routes: `POST /agents/{id}/chat-credentials {label: string}` → `201 {tokenId, rawToken, label, agentId}` (raw token returned once, never logged, never stored by admin); `DELETE /agents/{id}/chat-credentials/{tokenId}` → 204; `GET /agents/{id}/chat-credentials` → list without raw values (via `listTokensForAgent`). Named `chat-credentials`, not `chat-tokens`, because `/agents/{id}/chat-tokens/daily` is the existing **usage** rollup and must not be confused with credentials.
- Flag `SHIPWRIGHT_CHAT_TOKEN_MINT_ENABLED` = `"enabled"`; off → 404 as in Feature 31. Callers: `*` or `platform.ops` only (never an agent's own key — an agent must not mint tokens for itself).
- Implementation reuses `HttpChatServiceProvisioningClient.mintToken(label, agentId)` / `revokeToken` / `listTokensForAgent` already built in `admin-boot-config.ts`; the client is injected into `createAdminApp` (optional; absent → 503). The minted token is always scoped to `{id}`; the route never accepts an `agentId` in the body, so an unrestricted chat admin token cannot be minted through it.
- Every mint and revoke writes one structured log line `{event: "chat-credential.mint"|"chat-credential.revoke", agentId, tokenId, label, callerLabel}` — never the token.

**Acceptance Criteria**:
- [ ] Smoke tests with a fake provisioning client: flag off → 404; `platform.read` → 403; agent's own key → 403; `*` → 201 with `rawToken` present once and `agentId === {id}`; DELETE → 204 and the fake saw `revokeToken(tokenId)`; client absent → 503; a body containing `agentId` is rejected by the schema (400).
- [ ] A log-capture test asserts the raw token never appears in captured log lines.
- [ ] Specs/types regenerated; drift test passes; `docs/agent-api-resources.md` tokens section updated.

**Source Map**:
- `admin/src/chat-service-provisioning-client.ts` (`mintToken` 74-93, `revokeToken`, `listTokensForAgent`), `admin/src/admin-boot-config.ts:187-195`, `admin/src/agents-api.ts` (static-path-first registration ~1392)

**Testing Strategy**: Layer: smoke (routes over fakes) + unit (log capture).

---

### Feature 33: Live OpenAPI endpoint `GET /doc` behind `SHIPWRIGHT_ADMIN_DOC_ENABLED`

**Priority**: Low
**Description**: Mount the platform OpenAPI 3.1 document the spec test already builds, behind a flag, requiring any valid admin credential.

**Requirements**:
- `SHIPWRIGHT_ADMIN_DOC_ENABLED` = `"enabled"` mounts `root.doc("/doc", …)` (or serves `buildPlatformAdminSpec()` JSON) in `admin/src/main.ts` / `admin-boot.ts`; off → the route is not mounted at all (404 from Hono, identical to today).
- Requires the admin auth middleware: `*`, `platform.read`, `platform.ops` succeed; an agent key succeeds (it can already read the committed file); no credential → 401.
- Serves the **platform** spec only (`admin/openapi.platform.json` equivalent), never coding paths, so the AEP boundary holds; the response is byte-identical to the regenerated committed platform spec (one test).
- `Cache-Control: no-store`; size is a few hundred KB, acceptable.

**Acceptance Criteria**:
- [ ] Smoke test: flag off → 404; flag on without auth → 401; with `platform.read` → 200 JSON whose `openapi` field is `3.1.x` and whose paths contain no `/coding` entries; the body equals `buildPlatformAdminSpec()` output.
- [ ] `admin-spec.smoke.test.ts`'s header comment ("wiring /doc in the factory is a planned follow-up") is updated to describe the flag.

**Source Map**:
- `admin/src/admin-spec.ts` (`buildPlatformAdminSpec` ~136), `admin/src/admin-spec.smoke.test.ts` (header 3-8, `/doc` at 456), `admin/src/admin-boot.ts` (route mounting ~387-437)

**Testing Strategy**: Layer: smoke.

---

### Feature 34: Chart values, schema and Helm tests for the three flags

**Priority**: High
**Description**: Expose the new env flags as Helm values on the `shipwright` chart, all default off, with schema entries and unit tests; bump the chart version.

**Requirements**:
- `charts/shipwright/values.yaml` under `admin:`: `ask: {enabled: false, allowlist: []}` (rendered as `SHIPWRIGHT_AGENT_ASK_ENABLED: "enabled"` and `SHIPWRIGHT_AGENT_ASK_ALLOWLIST: "<a>b,c>d>"` only when `enabled`), `chatCredentialMint: {enabled: false}`, `doc: {enabled: false}`. Rendering follows the `selfServe` block in `admin-deployment.yaml:428-439` (`{{- with }}{{- if .enabled }}`), placed before `admin.extraEnv` so an operator override still wins.
- `values.schema.json`: entries for the three objects with `additionalProperties: false`; `allowlist` items match `^[^,>]+>[^,>]+$`.
- Helm unit tests in `charts/shipwright/tests/`: `admin_ask_test.yaml` (off → no env; on → both env vars, allowlist joined by comma), `admin_chat_credential_mint_test.yaml`, `admin_doc_test.yaml`; `admin_workload_test.yaml` still passes.
- `Chart.yaml` version bump (minor); `charts/shipwright/README.md` values table rows; `docs/deploy-kubernetes-*.md` mention under admin configuration.
- Explicitly **not** in scope: the downstream umbrella chart that pins this chart in another repo; turning any flag on anywhere is an operator values change after the chart release.

**Acceptance Criteria**:
- [ ] `task helm:check` passes (lint, unittest, validate).
- [ ] Rendering with default values produces an admin Deployment env list identical to today's (golden comparison in `admin_workload_test.yaml` or a new test).
- [ ] `check-version-sync` (part of `task ci`) passes with the chart bump.

**Source Map**:
- `charts/shipwright/values.yaml` (`admin:` 221, `selfServe:` 679), `charts/shipwright/templates/admin-deployment.yaml` (400-444), `charts/shipwright/values.schema.json`, `charts/shipwright/tests/*.yaml`, `charts/shipwright/README.md`

**Testing Strategy**: Layer: content — helm unittest + lint.

---

### Feature 35: Docs, configuration reference and agent-admin skill examples

**Priority**: Medium
**Description**: Make the five capabilities discoverable where operators and the plugin look.

**Requirements**:
- `docs/configuration.md`: the three flags and the allowlist var with defaults and the literal `"enabled"` convention (note `check-config-docs` does not scan `admin/src`, so this is manual and the task says so in the doc).
- `docs/agent-api.md`: scope kinds table (`*`, `<agentId>`, `platform.read`, `platform.ops`, session) with the colon rule; `PLATFORM_OPS_ROUTES` reproduced from the constant (a content test keeps them equal); the ask and chat-credential routes with their flags; the corrected session-cookie sentence from Feature 28.
- `docs/agent-api-resources.md` (tokens vs chat-credentials vs chat-token usage), `docs/chat.md` (`kind`/`askFromAgentId`/`askDepth`, admin-only), `docs/agent-key-files.md` (`agent-ask.ts`, `agent-ask-config.ts`).
- `plugins/shipwright/skills/agent-admin/SKILL.md`: curl examples for repos add/remove, ask, chat-credentials, `/doc`, each noting the flag and scope needed. Plugin version bump per this repo's rule.
- A short "Security posture" paragraph in `docs/agent-api.md`: off by default, 404 when off, server-set ask authority, depth 1, audit row, raw tokens returned once.

**Acceptance Criteria**:
- [ ] `task ci` passes (`check-strings`, `check-config-docs`, `check-version-sync` included).
- [ ] A content test asserts `docs/agent-api.md` lists every entry of `PLATFORM_OPS_ROUTES` (method + path) and every flag name used in `admin/src/*-config.ts`.
- [ ] No hostnames, client names or deployment-specific ids appear in any changed file (banned-string scan).

**Source Map**:
- `docs/{configuration,agent-api,agent-api-resources,chat,agent-key-files}.md`, `plugins/shipwright/skills/agent-admin/SKILL.md`

**Testing Strategy**: Layer: content.

---

## Technical Constraints

- **Security posture (plan B7), carried into every task's acceptance criteria**: new routes return 404 when their flag is off (indistinguishable from absent); flags are on only for the literal `"enabled"`; `askAllowlist` empty denies all; depth capped at 1 server-side; ask authority is the server-set `kind` field, never a title; every ask, mint and revoke is recorded (audit row or structured log) without question text or token values; raw tokens are returned exactly once. A deployment that upgrades and changes no values gains zero new capability — Feature 34's golden env test is the proof.
- **AEP boundary**: new admin code is platform-side (`admin/src/agent-ask*.ts`), imports no `./coding/*`, and the platform spec carries no coding path; `import-boundary.unit.test.ts` and `platform-manifest.unit.test.ts` are merge gates.
- **Spec drift**: every route change regenerates `admin/openapi.json`, `admin/openapi.platform.json`, `lib/admin-types.ts` (`bun run generate:admin-spec && bun run generate:admin-types`) and, for Feature 29, `chat/openapi.json` (`bun run generate:chat-spec`); the byte-identical tests are merge gates.
- **Tests**: suffix layers; integration tests need real Postgres (`DATABASE_URL_ADMIN_TEST`, `DATABASE_URL_SHIPWRIGHT_CHAT`) and skip without it; smoke via in-process `app.request()`; injected `Clock`; no `mock.module`, no `global.fetch`.
- **Public repo**: scrub before commit; stage specific files; no client names, hostnames, secret values or deployment ids. The consuming deployment is referred to generically.
- **Breaking changes**: none. Every change is an added column (nullable), an added route, an added scope value, or a flag-gated mount. `PATCH /agents/{id}` semantics unchanged. Safe to deploy standalone: all tasks.
- **Task ids** `COS-28.x`–`COS-35.x`; `COS-28.1` confirmed free (404) on 2026-10-24.
- **HITL**: zero.

## Scope

**In Scope**: Features 28–35.

**Out of Scope** (later phases of the parent plan or separate work):
- Turning any flag on in a real deployment (operator values change; phase 11 for the app-vitals deployment).
- Agent runtime changes to *consume* `kind: "ask"` threads (phase 6 convention text) or to refuse nested asks at runtime (depth is enforced at creation).
- Cron run-now, transcript route, GitHub-access health (phase 13); `/sessions` and `/verification-checks` publication (deployment HTTPRoute, not this repo).
- An admin-key registry reload route (B5 last row) — a separate spec.
- A TTL sweeper for stale ask threads (`ttlSeconds` is recorded for it).

## Priorities & Sequence

Feature 28 first (every other route's authorization depends on the scope helper). Feature 29 is independent of 28 and can run in parallel (chat repo area). Feature 30 after 28. Feature 31 after 28 and 29 (needs `kind` on `createThread`). Feature 32 after 28. Feature 33 after 28. Feature 34 after 31, 32 and 33 (it names their env vars). Feature 35 last. Eight tasks, one per feature, zero HITL.

## Testing Strategy

| Feature | Layer | Rationale |
|---|---|---|
| Scope model | unit + smoke | parser and middleware; route table proof |
| Chat `kind` fields | smoke + integration + unit | route rules; Prisma round-trip; spec drift |
| repos add/remove | smoke + integration | semantics incl. collision; stored array |
| ask route | unit + smoke + integration | config; flag/allowlist/depth paths over a chat fake; audit row |
| chat-credentials | smoke + unit | routes over a provisioning fake; log capture for the raw token |
| `/doc` | smoke | flag, auth, platform-only body |
| Chart values | content | helm unittest incl. default-env golden |
| Docs + skill | content | parity tests against constants |

## Resolved Decisions

- **Scopes are spelled `platform.read` / `platform.ops`.** — Rationale: the registry parser treats the last colon-separated segment as the scope, so `platform:read` would corrupt the token. Changing the parser would be a behaviour change for existing keys; a dot costs nothing.
- **Flags use the literal `"enabled"` and return 404 when off.** — Rationale: matches `SHIPWRIGHT_SELF_SERVE_ENABLED` and the accounts API's existing pattern; a PCI reviewer sees one convention.
- **Ask authority is a chat `Thread.kind` column set only by the admin token.** — Rationale: B7 requires a server-set field, not a title prefix; the column is additive and nullable; agent tokens cannot set it, so no agent can forge an ask.
- **Audit is an admin Prisma table (`AgentAsk`) plus structured logs; mint/revoke are logs only.** — Rationale: asks need a read surface for the fleet digest and a TTL later; credentials need an event trail but must never persist raw values. Admin has no audit pattern today, so this is the first; it is kept to one model.
- **`chat-credentials`, not `chat-tokens`.** — Rationale: `/agents/{id}/chat-tokens/daily` already means token *usage*; a credential route under the same noun would be read wrong by humans and tools.
- **`platform.ops` allowlist is a constant, not a wildcard on methods.** — Rationale: the chief of staff needs five specific writes; everything else stays admin-only, and the docs/test read the same list so it cannot drift.
- **No parser or behaviour change for `*` and `<agentId>` keys.** — Rationale: PCI deployments; the existing auth tests must pass unmodified as the proof.
- **Task ids reserved by phase**: 9–18 phase 2, 19–27 phase 8, 28–35 this phase.

## Success Criteria

`task ci` and `task helm:check` pass; the regenerated admin and chat specs are byte-identical to the committed ones; rendering the chart with default values yields today's admin env exactly; a `platform.read` key can read everything and write nothing, a `platform.ops` key can perform exactly the listed five writes; with the flags on in a test deployment, `POST /agents/{id}/ask` for an allowlisted pair returns a `kind: "ask"` thread and a reply within `waitMs`, a non-allowlisted pair is 403, and `POST /agents/{id}/chat-credentials` returns a token scoped to that agent once. HITL budget for the phase: 0 of 8.
