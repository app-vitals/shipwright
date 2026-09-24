# Chat Service

The Shipwright chat service (`@shipwright/chat`) is a standalone Hono service that stores conversation threads between agents and their human members — the backing store for the admin console's Chat tab and the agent's chat poll loop. All routes are mounted at the service root (no base path), e.g. `http://localhost:3003`.

**Full endpoint reference** — every route, parameter, request/response shape, and status code, including behavioral nuance like the claim/reply queue's precondition ordering and transactional atomicity — lives in the generated [`chat/openapi.json`](../chat/openapi.json) spec. Request/response shapes are validated and documented via Zod schemas with OpenAPI metadata in `chat/src/openapi-schemas.ts` (mirrors the pattern in `admin/src/openapi-schemas.ts`); the spec is generated from those schemas via `chat/src/generate-spec.ts` and can be regenerated any time with `bun run generate:chat-spec` (or `npm run generate:chat-spec`).

This page covers the conceptual auth model, the storage schema, environment config, and cross-cutting queue behavior that don't belong to any single endpoint.

---

## Authentication

All endpoints except `GET /health` require a `Bearer` token:

```
Authorization: Bearer <token>
```

Two token types:

| Type | `agentId` | Access |
|------|-----------|--------|
| **Admin** | `null` | Unrestricted — all threads, all messages, token management |
| **Agent** | set | Scoped — only threads owned by that `agentId` |

Tokens are validated via `ChatTokenService.validate()` (`chat/src/token-service.ts`). The raw token (64-char hex) is returned once at creation; only its SHA-256 hash is persisted. A missing `Authorization` header, a non-`Bearer` header, or an unknown/revoked token all return `401` with a `WWW-Authenticate` header.

### Scope resolver

When the chat service is configured with `SHIPWRIGHT_CHAT_AGENTS_URL` + `SHIPWRIGHT_CHAT_AGENTS_API_KEY`, agent tokens trigger a lookup of the agent's `repos` from the agents (admin) service on every request, stored on the request context as `repos`:

| `repos` value | Meaning |
|----------------|---------|
| `null` | Admin token — unrestricted, no scoping applied |
| `[]` | Agent token with no repos resolved (scope resolver not configured, or the lookup failed) — fail-safe restrictive |
| `[...]` | Agent token with a known repo scope from the agents service |

The resolver calls `GET {SHIPWRIGHT_CHAT_AGENTS_URL}/agents/{agentId}` with the admin API key and reads the `repos` array from the response. Any error (network failure, non-200, malformed body) falls back to `[]` silently.

### Outbound reply notifier (optional)

When configured with `SHIPWRIGHT_CHAT_PUSH_WEBHOOK_URL` + `SHIPWRIGHT_CHAT_PUSH_WEBHOOK_TOKEN`, the chat service fires a fire-and-forget webhook after every agent reply persists — the mechanism that triggers a "your agent replied" push notification on the admin side (`POST /admin/push/notify`). It mirrors the scope resolver's env-gated factory pattern (`chat/src/reply-notifier.ts`, `createReplyNotifier()`) but uses its own dedicated credential — never the agents-service API key — since notifying someone's phone is a different trust level than reading agent metadata. The outbound payload is `{ threadId, agentId, title }`: `agentId` is the **thread's** owning agent, not the caller's identity, and `title` can be `null`. No message body or preview text ever crosses this wire — that stays admin's job, via its own separate fetch of the message when a subscription's preview level allows it. The call has a 5s timeout and never throws: a push failure (timeout, network error, non-2xx) is logged and swallowed so it can never fail the reply. When the env vars are unset, the notifier is disabled and `main.ts` logs it, mirroring the scope resolver's on/off log line.

---

## Data model

Three Prisma models, defined in `chat/prisma/schema.prisma` and owned exclusively by this service — these describe the stored data, which is distinct from the API request/response shapes in `chat/openapi.json`.

### ChatToken

| Field | Type | Notes |
|-------|------|-------|
| `id` | `String` | `cuid()` primary key |
| `token` | `String` | SHA-256 hash of the raw token (hex), unique |
| `label` | `String?` | Optional human-readable label |
| `agentId` | `String?` | `null` = admin token; set = agent token scoped to this agent |
| `createdAt` | `DateTime` | |
| `revokedAt` | `DateTime?` | Soft-delete marker |

### Thread

| Field | Type | Notes |
|-------|------|-------|
| `id` | `String` | `cuid()` primary key |
| `agentId` | `String` | Owning agent |
| `memberId` | `String?` | Human member ID, if known |
| `title` | `String?` | |
| `createdAt` | `DateTime` | |
| `updatedAt` | `DateTime` | Bumped on `PATCH /threads/:id` |

Indexes: `[agentId, updatedAt desc]` (list-by-agent ordering), `[memberId]`.

### Message

| Field | Type | Notes |
|-------|------|-------|
| `id` | `String` | `cuid()` primary key |
| `threadId` | `String` | FK to `Thread`, cascade-delete |
| `role` | `String` | `"user"` \| `"assistant"` |
| `body` | `String` | |
| `tokens` | `Json?` | e.g. `{ input_tokens, output_tokens }` — used by thread stats |
| `costUsd` | `Float?` | |
| `attachmentFilename` | `String?` | Set via `POST / (create)` or `POST /:id/reply`; optional |
| `attachmentSize` | `Int?` | Set via `POST / (create)` or `POST /:id/reply`; optional |
| `attachmentBytes` | `Bytes?` | Set via `POST / (create)` or `POST /:id/reply`; app-layer capped at 10 MB (`MAX_ATTACHMENT_BYTES`); cleared after being served once |
| `claimed` | `Boolean` | Default `false`; set by the claim queue endpoint |
| `claimedAt` | `DateTime?` | |
| `claimedBy` | `String?` | Caller `agentId`, or `"admin"` |
| `heartbeatAt` | `DateTime?` | Bumped by the heartbeat queue endpoint while a claimed message is being worked |
| `progressPhase` | `String?` | Latest milestone + elapsed during claim processing; last-write-wins, not append-only; updated by heartbeat endpoint when `phase` is provided |
| `progressSeq` | `Int` | Default `0`; incremented with each heartbeat to track change events across same-timestamp updates |
| `cancelRequestedAt` | `DateTime?` | Cancellation request timestamp, if set |
| `repliedAt` | `DateTime?` | Set by the reply queue endpoint; guards against double-reply |
| `errorKind` | `String?` | |
| `createdAt` | `DateTime` | |

Indexes: `[threadId, createdAt]` (message list ordering), `[claimed, threadId]` (claim queue lookups).

---

## Environment

| Variable | Required | Description |
|----------|----------|--------------|
| `DATABASE_URL_SHIPWRIGHT_CHAT` | yes | Postgres connection string for the chat service schema. **Must be a separate database** from the admin and task-store services — the schema forbids sharing. |
| `PORT` | no | HTTP port (default `3000`). |
| `SHIPWRIGHT_CHAT_AGENTS_URL` | no | Base URL of the Shipwright agents (admin) service, used to resolve agent token repo scopes. Requires `SHIPWRIGHT_CHAT_AGENTS_API_KEY` to be set alongside it. When unset, agent tokens default to an empty repo list and scope resolution is disabled. |
| `SHIPWRIGHT_CHAT_AGENTS_API_KEY` | no | Bearer token the chat service uses to call the agents service. Required alongside `SHIPWRIGHT_CHAT_AGENTS_URL`. Env-var-only (secret). |
| `SHIPWRIGHT_CHAT_PUSH_WEBHOOK_URL` | no | Full endpoint URL of the admin service's inbound push webhook (not a base URL). Requires `SHIPWRIGHT_CHAT_PUSH_WEBHOOK_TOKEN` to be set alongside it. When unset, the outbound reply notifier is disabled. |
| `SHIPWRIGHT_CHAT_PUSH_WEBHOOK_TOKEN` | no | Bearer token the chat service presents to the admin push webhook. Required alongside `SHIPWRIGHT_CHAT_PUSH_WEBHOOK_URL`. Env-var-only (secret); a distinct credential from `SHIPWRIGHT_CHAT_AGENTS_API_KEY`. |
| `CHAT_SEED_ADMIN_TOKEN` | no | Bootstrap admin token seeded into the chat service on startup (idempotent upsert). Local-dev convenience only — not a real secret. |
| `CHAT_STALLED_AFTER_MS` | no | Stall threshold (ms) for the background stall reaper (`stall-reaper.ts`), which terminalizes a claimed, unreplied user message with `errorKind: "stalled"` once its `heartbeatAt` (or `claimedAt`, if the agent died before its first beat) is older than this cutoff. Defaults to `300000` (5 min) — deliberately 2.5x the admin UI's 120s stall-warning threshold, since a warning is free but reaping is destructive (it marks the message stalled; it never unclaims it for retry). The sweep runs every 60s from `main.ts` and reuses `MessageService.reply()`, which is naturally idempotent (returns `null` if already replied), so the sweep is race-safe against an agent that resumes and safe across multiple replicas. |

On boot, `main.ts` runs `prisma migrate deploy` against `DATABASE_URL_SHIPWRIGHT_CHAT` as an idempotent preflight, throwing if migrations fail, before serving traffic.

See [configuration.md](configuration.md) for the full env var reference across all services, and [configuration-agent.md](configuration-agent.md#metrics--admin--chat--task-store-services) for the agent-side `SHIPWRIGHT_CHAT_SERVICE_URL` / `SHIPWRIGHT_CHAT_SERVICE_TOKEN` / `SHIPWRIGHT_CHAT_POLL_INTERVAL_MS` vars that drive the chat poll loop consuming this API.

---

## Claim/reply queue behavior

The agent's chat poll loop claims a message via `POST /threads/:threadId/messages/claim`, then heartbeats via `POST .../:id/heartbeat` on a fixed interval (`heartbeatIntervalMs`, default 3s) for the whole duration of the reply — interval-driven rather than tied to Claude's turn cadence, since a single long-running tool call can go quiet for minutes between stream events. Because the heartbeat response carries `cancelRequestedAt`, the same tick that proves liveness doubles as the agent's only cancellation signal (see `POST .../:id/cancel`) — there is no separate inbound HTTP surface on the agent, preserving its pull-only architecture. The admin chat UI uses `heartbeatAt` (alongside `claimedAt`) to extend its own timeout instead of tripping a flat cutoff.
