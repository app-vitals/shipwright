/**
 * task-store/src/routes/readiness-snapshots.ts
 * Readiness snapshot write/read routes (RDY-1.2).
 *
 * Returns an OpenAPIHono sub-app mounted at /readiness-snapshots by app.ts.
 * Auth is applied by the parent app.
 *
 * Routes:
 *   POST /readiness-snapshots         upsert one snapshot on
 *                                    (accountId, repo, commitSha).
 *                                    201 created / 200 updated
 *   GET  /readiness-snapshots         ?repo=&since=&limit=&cursor=, newest first
 *   GET  /readiness-snapshots/latest  ?repo=; newest snapshot per repo (or just
 *                                    that repo's); out-of-scope repo → 403
 *
 * A snapshot has no parent task/PR, so its account comes from the caller:
 * agent tokens write to (and read from) their own account only, and may write
 * only repos in their scope (403 otherwise); admin tokens are unrestricted and
 * may pass `accountId` (body for POST, query for GET).
 */

import { readJson } from "@app-vitals/agent-lib/http";
import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import type { Context } from "hono";
import { resolveAccountScope } from "../account-scope.ts";
import type { TaskStoreAuthEnv } from "../auth.ts";
import type {
  ReadinessSnapshotScope,
  ReadinessSnapshotServiceLike,
} from "../readiness-snapshot-service.ts";
import { DEFAULT_ACCOUNT_ID } from "../default-account.ts";
import { BadRequestError } from "../errors.ts";
import {
  ReadinessSnapshotLatestQuerySchema,
  ReadinessSnapshotLatestResponseSchema,
  ReadinessSnapshotListQuerySchema,
  ReadinessSnapshotListResponseSchema,
  ReadinessSnapshotSchema,
  CreateReadinessSnapshotBodySchema,
  ErrorSchema,
} from "../openapi-schemas.ts";

// ─── Route definitions ────────────────────────────────────────────────────────

const recordRoute = createRoute({
  method: "post",
  path: "/",
  tags: ["Readiness Snapshots"],
  summary: "Record (upsert) a readiness snapshot for a commit",
  description:
    "Records the agent-readiness score for one commit: `level` (integer 0-5), `passing`/`failing` counts, the per-check `checks` array (`{id, level 1-5, result pass|fail|n/a, owner}`) and `catalogueVersion`. The row is unique on (account, `repo`, `commitSha`): the first POST returns `201`, a repeat POST for the same commit replaces the measurements and returns `200`. `400` when `level` is not an integer 0-5, a count is negative, a `checks` entry is malformed, `commitSha` is empty, or `repo` is not `owner/repo`. Agent tokens may write only repos in their scope (`403` otherwise) and always write to their own account; admin tokens are unrestricted and may pass `accountId` (default `default`).",
  request: {
    body: {
      content: {
        "application/json": { schema: CreateReadinessSnapshotBodySchema },
      },
      required: true,
    },
  },
  responses: {
    201: {
      content: { "application/json": { schema: ReadinessSnapshotSchema } },
      description: "Created readiness snapshot",
    },
    200: {
      content: { "application/json": { schema: ReadinessSnapshotSchema } },
      description: "Existing snapshot for this commit, updated",
    },
    400: {
      content: { "application/json": { schema: ErrorSchema } },
      description:
        "Bad request — missing/invalid fields, level, counts or checks",
    },
    403: {
      content: { "application/json": { schema: ErrorSchema } },
      description: "Forbidden — `repo` is not in the agent token's scope",
    },
  },
});

const listRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Readiness Snapshots"],
  summary: "List readiness snapshots, newest first",
  description:
    "Returns `{ snapshots, total, limit, nextCursor }` ordered by `measuredAt` descending (default `limit=50`). Optional `?repo=` filters to one repo and `?since=` (ISO timestamp, else `400`) keeps only snapshots measured at or after it. Agent tokens only see their own account's rows; admin tokens are unrestricted and may narrow with `?accountId=`. `nextCursor` is an opaque cursor — pass it back as `?cursor=` to fetch the next page; it is `null` on the last page. A malformed cursor is a 400.",
  request: { query: ReadinessSnapshotListQuerySchema },
  responses: {
    200: {
      content: {
        "application/json": { schema: ReadinessSnapshotListResponseSchema },
      },
      description: "Readiness snapshot history",
    },
    400: {
      content: { "application/json": { schema: ErrorSchema } },
      description: "Bad request — `since` is not a valid ISO timestamp",
    },
  },
});

const latestRoute = createRoute({
  method: "get",
  path: "/latest",
  tags: ["Readiness Snapshots"],
  summary: "Latest readiness snapshot per repo",
  description:
    "Returns `{ snapshots }` with exactly one row per repo — the newest by `measuredAt` — across the repos visible to the caller. With `?repo=` it returns just that repo's newest snapshot (an empty array when none exists); an agent token asking for a repo outside its scope gets `403`. Agent tokens only see their own account's rows; admin tokens are unrestricted and may narrow with `?accountId=`.",
  request: { query: ReadinessSnapshotLatestQuerySchema },
  responses: {
    200: {
      content: {
        "application/json": { schema: ReadinessSnapshotLatestResponseSchema },
      },
      description: "Newest snapshot per repo",
    },
    403: {
      content: { "application/json": { schema: ErrorSchema } },
      description: "Forbidden — `repo` is not in the agent token's scope",
    },
  },
});

// ─── Factory ──────────────────────────────────────────────────────────────────

/** Caller scope: repos null = admin; accountId null = admin without ?accountId=. */
function callerScope(c: Context<TaskStoreAuthEnv>): ReadinessSnapshotScope {
  return { repos: c.get("repos"), accountId: resolveAccountScope(c) };
}

function parseIntParam(raw: string | undefined): number | undefined {
  return raw !== undefined ? Number.parseInt(raw, 10) || undefined : undefined;
}

export function createReadinessSnapshotsRoutes(
  service: ReadinessSnapshotServiceLike,
): OpenAPIHono<TaskStoreAuthEnv> {
  const app = new OpenAPIHono<TaskStoreAuthEnv>();

  // ─── Record ────────────────────────────────────────────────────────────────
  // biome-ignore lint/suspicious/noExplicitAny: service returns Prisma types; JSON serialization handles Date→string correctly at runtime
  app.openapi(recordRoute, async (c): Promise<any> => {
    const body = await readJson(c);
    const str = (v: unknown): string => (typeof v === "string" ? v : "");
    // Numbers and checks are passed through untouched (even if mistyped) so the
    // service's validation, not a silent coercion, rejects them with a 400.

    // Agent tokens are pinned to their account; admins pick one (body, then
    // ?accountId=), defaulting to the default account.
    const callerAccount = c.get("accountId");
    const accountId =
      callerAccount !== null
        ? callerAccount
        : str(body.accountId) || c.req.query("accountId") || DEFAULT_ACCOUNT_ID;

    const { snapshot, created } = await service.record(
      {
        accountId,
        repo: str(body.repo),
        commitSha: str(body.commitSha),
        level: body.level as number,
        passing: body.passing as number,
        failing: body.failing as number,
        checks: body.checks,
        catalogueVersion: str(body.catalogueVersion),
        measuredAt: str(body.measuredAt) || undefined,
      },
      callerScope(c),
    );

    return c.json(snapshot, created ? 201 : 200);
  });

  // ─── List ──────────────────────────────────────────────────────────────────
  // biome-ignore lint/suspicious/noExplicitAny: service returns Prisma types; JSON serialization handles Date→string correctly at runtime
  app.openapi(listRoute, async (c): Promise<any> => {
    const since = c.req.query("since");
    if (since && Number.isNaN(new Date(since).getTime())) {
      throw new BadRequestError("since must be a valid ISO timestamp");
    }
    const limit = parseIntParam(c.req.query("limit"));
    const cursor = c.req.query("cursor");

    const result = await service.list(
      {
        repo: c.req.query("repo") || undefined,
        since: since || undefined,
        limit,
        cursor,
      },
      callerScope(c),
    );

    return c.json(
      {
        snapshots: result.snapshots,
        total: result.total,
        limit: limit ?? 50,
        nextCursor: result.nextCursor ?? null,
      },
      200,
    );
  });

  // ─── Latest per repo ───────────────────────────────────────────────────────
  // biome-ignore lint/suspicious/noExplicitAny: service returns Prisma types; JSON serialization handles Date→string correctly at runtime
  app.openapi(latestRoute, async (c): Promise<any> => {
    const snapshots = await service.latest(
      callerScope(c),
      c.req.query("repo") || undefined,
    );
    return c.json({ snapshots }, 200);
  });

  return app;
}
