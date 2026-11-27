/**
 * task-store/src/routes/cron-runs.ts
 * Per-repo system-cron run routes (PCR-1.1).
 *
 * Returns an OpenAPIHono sub-app mounted at /cron-runs by app.ts. Auth is
 * applied by the parent app.
 *
 * Routes:
 *   POST /cron-runs         append one run record (never upserts). 201
 *   GET  /cron-runs         ?cronId=&repo=&includeDetail=&limit=&cursor=,
 *                           newest `finishedAt` first; `machineState` omitted
 *                           unless includeDetail=true
 *   GET  /cron-runs/latest  ?cronId=&repo= — newest ok/no_op run incl.
 *                           machineState, else 404
 *
 * Account/scope rules mirror /coverage-snapshots: agent tokens write to and
 * read from their own account only, and may write only repos in their scope
 * (403 otherwise); admin tokens are unrestricted and may pass `accountId`.
 */

import { readJson } from "@app-vitals/agent-lib/http";
import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import type { Context } from "hono";
import { resolveAccountScope } from "../account-scope.ts";
import type { TaskStoreAuthEnv } from "../auth.ts";
import { DEFAULT_ACCOUNT_ID } from "../default-account.ts";
import { BadRequestError, NotFoundError } from "../errors.ts";
import {
  CreateRepoCronRunBodySchema,
  ErrorSchema,
  RepoCronRunLatestQuerySchema,
  RepoCronRunListQuerySchema,
  RepoCronRunListResponseSchema,
  RepoCronRunSchema,
} from "../openapi-schemas.ts";
import type {
  RepoCronRunScope,
  RepoCronRunServiceLike,
} from "../repo-cron-run-service.ts";

// ─── Route definitions ────────────────────────────────────────────────────────

const recordRoute = createRoute({
  method: "post",
  path: "/",
  tags: ["Cron Runs"],
  summary: "Append a per-repo cron run record",
  description:
    "Appends one record of a system-cron run for a repo. Append-only: every POST creates a new row (`201`), even for the same `cronId` + `repo`. `400` when `repo` is not `owner/repo`, `outcome` is not `ok | no_op | failed`, a timestamp is not valid ISO, `cronId`/`commitSha` is empty, `metrics` is not an object of finite numbers, or the `auto`/`review`/`plan` routing counts in `metrics` are not non-negative integers. Agent tokens may write only repos in their scope (`403` otherwise) and always write to their own account; admin tokens are unrestricted and may pass `accountId` (default `default`).",
  request: {
    body: {
      content: {
        "application/json": { schema: CreateRepoCronRunBodySchema },
      },
      required: true,
    },
  },
  responses: {
    201: {
      content: { "application/json": { schema: RepoCronRunSchema } },
      description: "Created run record",
    },
    400: {
      content: { "application/json": { schema: ErrorSchema } },
      description: "Bad request — missing/invalid fields or metrics",
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
  tags: ["Cron Runs"],
  summary: "List cron runs, newest first",
  description:
    "Returns `{ runs, total, limit, nextCursor }` ordered by `finishedAt` descending (default `limit=50`). Optional `?cronId=` and `?repo=` filters. `machineState` is omitted from each run unless `?includeDetail=true`. Agent tokens only see their own account's rows (and only in-scope repos); admin tokens are unrestricted and may narrow with `?accountId=`. `nextCursor` is an opaque cursor — pass it back as `?cursor=`; it is `null` on the last page. A malformed cursor is a 400.",
  request: { query: RepoCronRunListQuerySchema },
  responses: {
    200: {
      content: {
        "application/json": { schema: RepoCronRunListResponseSchema },
      },
      description: "Cron run history",
    },
    400: {
      content: { "application/json": { schema: ErrorSchema } },
      description: "Bad request — malformed cursor",
    },
  },
});

const latestRoute = createRoute({
  method: "get",
  path: "/latest",
  tags: ["Cron Runs"],
  summary: "Latest successful run for a cron + repo",
  description:
    "Returns the newest run (by `finishedAt`) for `?cronId=` + `?repo=` whose `outcome` is `ok` or `no_op`, including `machineState`. `failed` runs are skipped. `404` when there is no such run (or the repo is outside the caller's scope). Any in-scope token may read it, not only the one that wrote the run.",
  request: { query: RepoCronRunLatestQuerySchema },
  responses: {
    200: {
      content: { "application/json": { schema: RepoCronRunSchema } },
      description: "Newest ok/no_op run",
    },
    400: {
      content: { "application/json": { schema: ErrorSchema } },
      description: "Bad request — `cronId` or `repo` missing",
    },
    404: {
      content: { "application/json": { schema: ErrorSchema } },
      description: "No ok/no_op run for this cron + repo",
    },
  },
});

// ─── Factory ──────────────────────────────────────────────────────────────────

/** Caller scope: repos null = admin; accountId null = admin without ?accountId=. */
function callerScope(c: Context<TaskStoreAuthEnv>): RepoCronRunScope {
  return { repos: c.get("repos"), accountId: resolveAccountScope(c) };
}

function parseIntParam(raw: string | undefined): number | undefined {
  return raw !== undefined ? Number.parseInt(raw, 10) || undefined : undefined;
}

export function createCronRunsRoutes(
  service: RepoCronRunServiceLike,
): OpenAPIHono<TaskStoreAuthEnv> {
  const app = new OpenAPIHono<TaskStoreAuthEnv>();

  // ─── Record ────────────────────────────────────────────────────────────────
  // biome-ignore lint/suspicious/noExplicitAny: service returns Prisma types; JSON serialization handles Date→string correctly at runtime
  app.openapi(recordRoute, async (c): Promise<any> => {
    const body = await readJson(c);
    const str = (v: unknown): string => (typeof v === "string" ? v : "");

    const callerAccount = c.get("accountId");
    const accountId =
      callerAccount !== null
        ? callerAccount
        : str(body.accountId) || c.req.query("accountId") || DEFAULT_ACCOUNT_ID;

    // metrics / machineState pass through untouched so the service's
    // validation, not a silent coercion, rejects bad shapes with a 400.
    const run = await service.record(
      {
        accountId,
        cronId: str(body.cronId),
        repo: str(body.repo),
        taskId: str(body.taskId) || undefined,
        scheduledFor: str(body.scheduledFor) || undefined,
        startedAt: str(body.startedAt),
        finishedAt: str(body.finishedAt),
        commitSha: str(body.commitSha),
        outcome: str(body.outcome),
        metrics: body.metrics,
        machineState: body.machineState,
      },
      callerScope(c),
    );
    return c.json(run, 201);
  });

  // ─── List ──────────────────────────────────────────────────────────────────
  // biome-ignore lint/suspicious/noExplicitAny: service returns Prisma types; JSON serialization handles Date→string correctly at runtime
  app.openapi(listRoute, async (c): Promise<any> => {
    const limit = parseIntParam(c.req.query("limit"));
    const result = await service.list(
      {
        cronId: c.req.query("cronId") || undefined,
        repo: c.req.query("repo") || undefined,
        includeDetail: c.req.query("includeDetail") === "true",
        limit,
        cursor: c.req.query("cursor"),
      },
      callerScope(c),
    );
    return c.json(
      {
        runs: result.runs,
        total: result.total,
        limit: limit ?? 50,
        nextCursor: result.nextCursor ?? null,
      },
      200,
    );
  });

  // ─── Latest ────────────────────────────────────────────────────────────────
  // biome-ignore lint/suspicious/noExplicitAny: service returns Prisma types; JSON serialization handles Date→string correctly at runtime
  app.openapi(latestRoute, async (c): Promise<any> => {
    const cronId = c.req.query("cronId");
    const repo = c.req.query("repo");
    if (!cronId || !repo) {
      throw new BadRequestError("cronId and repo are required");
    }
    const run = await service.latest(cronId, repo, callerScope(c));
    if (!run) throw new NotFoundError("no ok/no_op run for this cron and repo");
    return c.json(run, 200);
  });

  return app;
}
