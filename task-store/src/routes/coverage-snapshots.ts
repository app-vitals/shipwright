/**
 * task-store/src/routes/coverage-snapshots.ts
 * Coverage snapshot write/read routes (CVT-2.1).
 *
 * Returns an OpenAPIHono sub-app mounted at /coverage-snapshots by app.ts.
 * Auth is applied by the parent app.
 *
 * Routes:
 *   POST /coverage-snapshots         upsert one snapshot on
 *                                    (accountId, repo, commitSha); the server
 *                                    computes every pct from the counts.
 *                                    201 created / 200 updated
 *   GET  /coverage-snapshots         ?repo=&since=&limit=&offset=, newest first
 *   GET  /coverage-snapshots/latest  newest snapshot per repo
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
  CoverageSnapshotScope,
  CoverageSnapshotServiceLike,
} from "../coverage-snapshot-service.ts";
import { DEFAULT_ACCOUNT_ID } from "../default-account.ts";
import { BadRequestError } from "../errors.ts";
import {
  CoverageSnapshotLatestQuerySchema,
  CoverageSnapshotLatestResponseSchema,
  CoverageSnapshotListQuerySchema,
  CoverageSnapshotListResponseSchema,
  CoverageSnapshotSchema,
  CreateCoverageSnapshotBodySchema,
  ErrorSchema,
} from "../openapi-schemas.ts";

// ─── Route definitions ────────────────────────────────────────────────────────

const recordRoute = createRoute({
  method: "post",
  path: "/",
  tags: ["Coverage Snapshots"],
  summary: "Record (upsert) a coverage snapshot for a commit",
  description:
    "Records the measured coverage for one commit. The body carries covered/total counts; the server computes `linesPct` (and `branchesPct`/`functionsPct` when those pairs are supplied). The row is unique on (account, `repo`, `commitSha`): the first POST returns `201`, a repeat POST for the same commit replaces the measurements and returns `200`. `400` when `linesTotal` is not > 0, any covered exceeds its total, `commitSha` is empty, or `repo` is not `owner/repo`. Agent tokens may write only repos in their scope (`403` otherwise) and always write to their own account; admin tokens are unrestricted and may pass `accountId` (default `default`).",
  request: {
    body: {
      content: {
        "application/json": { schema: CreateCoverageSnapshotBodySchema },
      },
      required: true,
    },
  },
  responses: {
    201: {
      content: { "application/json": { schema: CoverageSnapshotSchema } },
      description: "Created coverage snapshot",
    },
    200: {
      content: { "application/json": { schema: CoverageSnapshotSchema } },
      description: "Existing snapshot for this commit, updated",
    },
    400: {
      content: { "application/json": { schema: ErrorSchema } },
      description: "Bad request — missing/invalid fields or counts",
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
  tags: ["Coverage Snapshots"],
  summary: "List coverage snapshots, newest first",
  description:
    "Returns `{ snapshots, total, limit, offset }` ordered by `measuredAt` descending (default `limit=50`, `offset=0`). Optional `?repo=` filters to one repo and `?since=` (ISO timestamp, else `400`) keeps only snapshots measured at or after it. Agent tokens only see their own account's rows; admin tokens are unrestricted and may narrow with `?accountId=`.",
  request: { query: CoverageSnapshotListQuerySchema },
  responses: {
    200: {
      content: {
        "application/json": { schema: CoverageSnapshotListResponseSchema },
      },
      description: "Coverage snapshot history",
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
  tags: ["Coverage Snapshots"],
  summary: "Latest coverage snapshot per repo",
  description:
    "Returns `{ snapshots }` with exactly one row per repo — the newest by `measuredAt` — across the repos visible to the caller. Agent tokens only see their own account's rows; admin tokens are unrestricted and may narrow with `?accountId=`.",
  request: { query: CoverageSnapshotLatestQuerySchema },
  responses: {
    200: {
      content: {
        "application/json": { schema: CoverageSnapshotLatestResponseSchema },
      },
      description: "Newest snapshot per repo",
    },
  },
});

// ─── Factory ──────────────────────────────────────────────────────────────────

/** Caller scope: repos null = admin; accountId null = admin without ?accountId=. */
function callerScope(c: Context<TaskStoreAuthEnv>): CoverageSnapshotScope {
  return { repos: c.get("repos"), accountId: resolveAccountScope(c) };
}

function parseIntParam(raw: string | undefined): number | undefined {
  return raw !== undefined ? Number.parseInt(raw, 10) || undefined : undefined;
}

export function createCoverageSnapshotsRoutes(
  service: CoverageSnapshotServiceLike,
): OpenAPIHono<TaskStoreAuthEnv> {
  const app = new OpenAPIHono<TaskStoreAuthEnv>();

  // ─── Record ────────────────────────────────────────────────────────────────
  // biome-ignore lint/suspicious/noExplicitAny: service returns Prisma types; JSON serialization handles Date→string correctly at runtime
  app.openapi(recordRoute, async (c): Promise<any> => {
    const body = await readJson(c);
    const str = (v: unknown): string => (typeof v === "string" ? v : "");
    // Counts are passed through untouched (even if mistyped) so the service's
    // validation, not a silent coercion, rejects them with a 400.
    const num = (v: unknown) => (v === undefined || v === null ? undefined : v);

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
        branch: str(body.branch),
        commitSha: str(body.commitSha),
        linesCovered: num(body.linesCovered) as number,
        linesTotal: num(body.linesTotal) as number,
        branchesCovered: num(body.branchesCovered) as number | undefined,
        branchesTotal: num(body.branchesTotal) as number | undefined,
        functionsCovered: num(body.functionsCovered) as number | undefined,
        functionsTotal: num(body.functionsTotal) as number | undefined,
        tool: str(body.tool),
        runUrl: str(body.runUrl) || undefined,
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
    const offset = parseIntParam(c.req.query("offset"));

    const result = await service.list(
      {
        repo: c.req.query("repo") || undefined,
        since: since || undefined,
        limit,
        offset,
      },
      callerScope(c),
    );

    return c.json(
      {
        snapshots: result.snapshots,
        total: result.total,
        limit: limit ?? 50,
        offset: offset ?? 0,
      },
      200,
    );
  });

  // ─── Latest per repo ───────────────────────────────────────────────────────
  // biome-ignore lint/suspicious/noExplicitAny: service returns Prisma types; JSON serialization handles Date→string correctly at runtime
  app.openapi(latestRoute, async (c): Promise<any> => {
    const snapshots = await service.latest(callerScope(c));
    return c.json({ snapshots }, 200);
  });

  return app;
}
