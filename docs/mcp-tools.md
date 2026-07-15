<!-- GENERATED FILE — do not edit by hand. -->
<!-- Produced by scripts/generate-mcp-docs.ts from mcp-server/src/generated-tools.ts -->
<!-- (itself generated from task-store/openapi.json) filtered through -->
<!-- mcp-server/src/tool-allowlist.ts. Regenerate with: bun run generate:mcp-docs -->

# MCP Server Tool Reference

This is the public tool surface exposed by the MCP server (`@shipwright/mcp-server`)
after allowlist filtering. See [architecture.md](./architecture.md#mcp-server) for
how the server is generated, wired, and executed.

## `prs_get`

Fetch a single pull request

- **Method:** GET
- **Path:** `/prs/{id}`
- **Has body:** No
- **Parameters:** `id` (path)

## `prs_list`

List pull requests

- **Method:** GET
- **Path:** `/prs`
- **Has body:** No
- **Parameters:** `repo` (query), `prNumber` (query), `taskId` (query), `state` (query), `reviewState` (query), `staged` (query), `limit` (query), `offset` (query), `ready` (query), `sort` (query)

## `prs_update`

Update pull request fields

- **Method:** PATCH
- **Path:** `/prs/{id}`
- **Has body:** Yes
- **Parameters:** `id` (path)

## `tasks_bulk`

Bulk insert tasks

- **Method:** POST
- **Path:** `/tasks/bulk`
- **Has body:** Yes (JSON array body via `items`)
- **Parameters:** None

## `tasks_create`

Create a task

- **Method:** POST
- **Path:** `/tasks`
- **Has body:** Yes
- **Parameters:** None

## `tasks_distinct`

Get distinct session and repo values

- **Method:** GET
- **Path:** `/tasks/distinct`
- **Has body:** No
- **Parameters:** None

## `tasks_get`

Get a task by ID

- **Method:** GET
- **Path:** `/tasks/{id}`
- **Has body:** No
- **Parameters:** `id` (path)

## `tasks_list`

List tasks

- **Method:** GET
- **Path:** `/tasks`
- **Has body:** No
- **Parameters:** `status` (query), `state` (query), `session` (query), `repo` (query), `assignee` (query), `claimedBy` (query), `branch` (query), `pr` (query), `limit` (query), `offset` (query), `ready` (query)

## `tasks_update`

Update a task

- **Method:** PATCH
- **Path:** `/tasks/{id}`
- **Has body:** Yes
- **Parameters:** `id` (path)
