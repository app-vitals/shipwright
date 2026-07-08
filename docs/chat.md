# Chat Service

The Shipwright chat service (`@shipwright/chat`) is a standalone Hono service that stores conversation threads between agents and their human members — the backing store for the admin console's Chat tab and the agent's chat poll loop.

Base path: none (all routes are mounted at the service root, e.g. `http://localhost:3003`).

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

---

## Tokens

Admin-only endpoints for managing chat service tokens. Mounted at `/tokens`.

#### List tokens

```
GET /tokens
```

Returns token metadata (hash + label + `agentId`) ordered by `createdAt`. Never returns raw token values.

#### Create token

```
POST /tokens
```

Body (optional JSON): `{ label?: string, agentId?: string }`. Omitting `agentId` creates an admin token. Returns `201` with the token record plus `rawToken` — the raw value is returned **once** and not stored.

#### Update token

```
PATCH /tokens/:id
```

Body: `{ label?: string, agentId?: string }`. Returns `404` if the token doesn't exist, or `400` if the token is already revoked. Returns the updated token record.

#### Revoke token

```
DELETE /tokens/:id
```

Soft-deletes the token (sets `revokedAt`). Returns `404` if not found, otherwise the revoked token record with `200`.

---

## Threads

CRUD for conversation threads. Mounted at `/threads`. Agent tokens are scoped to threads where `thread.agentId === callerAgentId` — any operation against a thread owned by a different agent returns `403`.

#### List threads

```
GET /threads
```

Query params: `agentId` (admin only — agent tokens are forced to their own ID), `memberId`, `limit` (default `50`, capped at `200`), `offset` (default `0`).

Returns `{ threads: Thread[], total: number, limit: number, offset: number }`, ordered by `updatedAt` descending.

#### Create thread

```
POST /threads
```

Body: `{ agentId: string, memberId?: string, title?: string }`. `agentId` is required — returns `400` if missing. Agent tokens may only create threads for their own `agentId` — mismatched `agentId` returns `403`. Returns `201` with the created thread.

#### Get thread

```
GET /threads/:id
```

Returns `404` if not found, `403` if an agent token doesn't own the thread. Returns the thread with `200`.

#### Thread stats

```
GET /threads/:id/stats
```

Returns aggregate usage for the thread:

```json
{
  "messageCount": 12,
  "totalInputTokens": 4200,
  "totalOutputTokens": 1830,
  "totalCostUsd": 0.42
}
```

`messageCount` and `totalCostUsd` are computed via a SQL aggregate over `Message`. Token totals are summed in application code from each message's `tokens` JSON blob (`input_tokens` / `output_tokens` keys) — Postgres can't aggregate inside a JSON column, so every message in the thread is loaded to compute this. Acceptable for admin-only usage; threads with very large message counts incur proportional memory overhead.

#### Update thread

```
PATCH /threads/:id
```

Body: `{ title?: string | null, memberId?: string | null }`. Returns `404` if not found, `403` if scope-mismatched. Returns the updated thread with `200`.

#### Delete thread

```
DELETE /threads/:id
```

Cascades to all messages in the thread (`onDelete: Cascade` in the schema). Returns `404` if not found, `403` if scope-mismatched, otherwise the deleted thread with `200`.

---

## Messages

CRUD plus the claim/reply queue API. Mounted at `/threads/:threadId/messages`. Every route first resolves the parent thread and applies the same agent-scope check as the thread routes — `404` if the thread doesn't exist, `403` if an agent token doesn't own it.

#### List messages

```
GET /threads/:threadId/messages
```

Query params: `limit` (default `50`, capped at `200`), `offset` (default `0`). Returns `{ messages: Message[], total: number, limit: number, offset: number }`, ordered by `createdAt` ascending.

#### Create message

```
POST /threads/:threadId/messages
```

Body: `{ role: "user" | "assistant", body: string, tokens?: JsonValue, costUsd?: number, attachmentFilename?: string, attachmentSize?: number, attachmentBytes?: string (base64) | Uint8Array }`. `role` and `body` are required — returns `400` if missing or if `role` is not `"user"`/`"assistant"`. Returns `201` with the created message.

**Attachment size guard:** `attachmentBytes` is capped at `MAX_ATTACHMENT_BYTES` (10 MB) — oversized payloads return `413`. The cap exists because `attachmentBytes` is a Postgres `bytea` column loaded in full on every `Message` read; removing the cap risks WAL bloat.

#### Claim (queue API)

```
POST /threads/:threadId/messages/claim
```

Atomically claims the oldest unclaimed `role: "user"` message in the thread — the mechanism the agent's chat poll loop uses to pick up new member messages without double-processing. `claimedBy` is set to the caller's `agentId` (or `"admin"` for admin tokens). Returns `404` if no unclaimed messages exist, otherwise the claimed message with `200`. Concurrent claims on the same message are resolved by a conditional update (`WHERE claimed = false`); the loser gets `404`, not an error.

#### Get attachment

```
GET /threads/:threadId/messages/:id/attachment
```

Streams the stored `attachmentBytes` once with `Content-Type: application/octet-stream` and a `Content-Disposition` header set to the message's `attachmentFilename`. Returns `404` if the message has no attachment. **Ephemeral retention** — after the bytes are served, they are dropped from the row (`clearAttachmentBytes`) so the content is not retained once the agent has pulled it into its workspace.

#### Get message

```
GET /threads/:threadId/messages/:id
```

Returns `404` if not found or if the message doesn't belong to `:threadId`.

#### Update message

```
PATCH /threads/:threadId/messages/:id
```

Body: `{ body?: string, tokens?: JsonValue, costUsd?: number | null, errorKind?: string | null }`. Returns `404` if not found. Returns the updated message with `200`.

#### Delete message

```
DELETE /threads/:threadId/messages/:id
```

Returns `404` if not found, otherwise the deleted message with `200`.

#### Reply (queue API)

```
POST /threads/:threadId/messages/:id/reply
```

Posts an agent's reply to a claimed user message — the second half of the claim/reply queue cycle. Body: `{ body: string, tokens?: JsonValue, costUsd?: number }`. `body` is required.

Preconditions, checked in order:
1. The target message must exist and belong to `:threadId` — `404`
2. `role` must be `"user"` — replying to an assistant message returns `400`
3. `repliedAt` must be `null` — replying twice returns `409`

On success, sets `repliedAt` on the user message and creates a new `role: "assistant"` message in the same thread. Returns `201` with `{ userMessage: Message, assistantMessage: Message }`.

---

## Data model

Three Prisma models, defined in `chat/prisma/schema.prisma` and owned exclusively by this service. Request and response shapes are validated and documented via Zod schemas with OpenAPI metadata in `chat/src/openapi-schemas.ts` — mirrors the pattern in `admin/src/openapi-schemas.ts`.

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
| `attachmentFilename` | `String?` | |
| `attachmentSize` | `Int?` | |
| `attachmentBytes` | `Bytes?` | App-layer capped at 10 MB (`MAX_ATTACHMENT_BYTES`); cleared after being served once |
| `claimed` | `Boolean` | Default `false`; set by the claim queue endpoint |
| `claimedAt` | `DateTime?` | |
| `claimedBy` | `String?` | Caller `agentId`, or `"admin"` |
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
| `CHAT_SEED_ADMIN_TOKEN` | no | Bootstrap admin token seeded into the chat service on startup (idempotent upsert). Local-dev convenience only — not a real secret. |

On boot, `main.ts` runs `prisma migrate deploy` against `DATABASE_URL_SHIPWRIGHT_CHAT` as an idempotent preflight, throwing if migrations fail, before serving traffic.

See [configuration.md](configuration.md) for the full env var reference across all services, including the agent-side `SHIPWRIGHT_CHAT_SERVICE_URL` / `SHIPWRIGHT_CHAT_SERVICE_TOKEN` / `SHIPWRIGHT_CHAT_POLL_INTERVAL_MS` vars that drive the chat poll loop consuming this API.
