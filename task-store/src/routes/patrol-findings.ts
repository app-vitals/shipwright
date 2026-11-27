/**
 * task-store/src/routes/patrol-findings.ts
 * Cross-run patrol finding ledger routes (PCR-1.2).
 *
 * Returns an OpenAPIHono sub-app mounted at /patrol-findings by app.ts. Auth
 * is applied by the parent app.
 *
 * Routes:
 *   POST /patrol-findings/batch  batch upsert for one (cronId, repo): creates
 *                                new findings, bumps occurrenceCount/lastSeen
 *                                and appends history for continued ones. 200
 *   GET  /patrol-findings        ?cronId=&repo=&status=&limit=&cursor=,
 *                                newest `lastSeen` first
 *
 * Account/scope rules mirror /cron-runs: agent tokens read and write their own
 * account only (so any in-scope agent sees another agent's findings), and an
 * out-of-scope repo is a 403 on both read and write; admin tokens are
 * unrestricted and may pass `accountId`.
 */

import { readJson } from "@app-vitals/agent-lib/http";
import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import type { Context } from "hono";
import { resolveAccountScope } from "../account-scope.ts";
import type { TaskStoreAuthEnv } from "../auth.ts";
import { DEFAULT_ACCOUNT_ID } from "../default-account.ts";
import {
  ErrorSchema,
  PatrolFindingListQuerySchema,
  PatrolFindingListResponseSchema,
  UpsertPatrolFindingsBodySchema,
  UpsertPatrolFindingsResponseSchema,
} from "../openapi-schemas.ts";
import type {
  PatrolFindingInput,
  PatrolFindingScope,
  PatrolFindingServiceLike,
} from "../patrol-finding-service.ts";

// ─── Route definitions ────────────────────────────────────────────────────────

const upsertRoute = createRoute({
  method: "post",
  path: "/batch",
  tags: ["Patrol Findings"],
  summary: "Batch-upsert patrol findings for one cron + repo",
  description:
    "Upserts findings keyed by `(account, cronId, repo, fingerprint)`. New fingerprints are created (`occurrenceCount` 1, `firstSeen = lastSeen = observedAt`). Continued ones get `occurrenceCount + 1`, `lastSeen = observedAt`, the new `status`, and a new `history` entry appended — earlier history entries are never rewritten. A finding whose `lastSeen` is already >= `observedAt` is a replay and is returned unchanged, so retrying an identical request does not corrupt history. `detail` / `taskId`, when omitted, keep their existing values. `400` when `repo` is not `owner/repo`, `cronId`/`fingerprint` is empty, `status` is not one of `tracking | ready_to_propose | open | resolved | suppressed`, `observedAt` is not ISO, fingerprints repeat, or more than 500 findings are sent. Agent tokens may write only repos in their scope (`403` otherwise) and always write to their own account; admin tokens are unrestricted and may pass `accountId` (default `default`).",
  request: {
    body: {
      content: {
        "application/json": { schema: UpsertPatrolFindingsBodySchema },
      },
      required: true,
    },
  },
  responses: {
    200: {
      content: {
        "application/json": { schema: UpsertPatrolFindingsResponseSchema },
      },
      description: "The upserted findings, in request order",
    },
    400: {
      content: { "application/json": { schema: ErrorSchema } },
      description: "Bad request — missing/invalid fields",
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
  tags: ["Patrol Findings"],
  summary: "List patrol findings, most recently seen first",
  description:
    "Returns `{ findings, total, limit, nextCursor }` ordered by `lastSeen` descending (default `limit=50`). Optional `?cronId=`, `?repo=` and `?status=` filters. Agent tokens see their own account's findings regardless of which agent wrote them, only for in-scope repos; a `?repo=` outside the token's scope is `403`. Admin tokens are unrestricted and may narrow with `?accountId=`. `nextCursor` is an opaque cursor — pass it back as `?cursor=`; it is `null` on the last page. A malformed cursor is a 400.",
  request: { query: PatrolFindingListQuerySchema },
  responses: {
    200: {
      content: {
        "application/json": { schema: PatrolFindingListResponseSchema },
      },
      description: "Patrol findings",
    },
    400: {
      content: { "application/json": { schema: ErrorSchema } },
      description: "Bad request — malformed cursor",
    },
    403: {
      content: { "application/json": { schema: ErrorSchema } },
      description: "Forbidden — `repo` is not in the agent token's scope",
    },
  },
});

// ─── Factory ──────────────────────────────────────────────────────────────────

/** Caller scope: repos null = admin; accountId null = admin without ?accountId=. */
function callerScope(c: Context<TaskStoreAuthEnv>): PatrolFindingScope {
  return { repos: c.get("repos"), accountId: resolveAccountScope(c) };
}

function parseIntParam(raw: string | undefined): number | undefined {
  return raw !== undefined ? Number.parseInt(raw, 10) || undefined : undefined;
}

export function createPatrolFindingsRoutes(
  service: PatrolFindingServiceLike,
): OpenAPIHono<TaskStoreAuthEnv> {
  const app = new OpenAPIHono<TaskStoreAuthEnv>();

  // biome-ignore lint/suspicious/noExplicitAny: service returns Prisma types; JSON serialization handles Date→string correctly at runtime
  app.openapi(upsertRoute, async (c): Promise<any> => {
    const body = await readJson(c);
    const str = (v: unknown): string => (typeof v === "string" ? v : "");

    const callerAccount = c.get("accountId");
    const accountId =
      callerAccount !== null
        ? callerAccount
        : str(body.accountId) || c.req.query("accountId") || DEFAULT_ACCOUNT_ID;

    // findings pass through untouched so the service's validation, not a
    // silent coercion, rejects bad shapes with a 400.
    const findings = await service.upsertBatch(
      {
        accountId,
        cronId: str(body.cronId),
        repo: str(body.repo),
        observedAt: str(body.observedAt) || undefined,
        findings: body.findings as PatrolFindingInput[],
      },
      callerScope(c),
    );
    return c.json({ findings }, 200);
  });

  // biome-ignore lint/suspicious/noExplicitAny: service returns Prisma types; JSON serialization handles Date→string correctly at runtime
  app.openapi(listRoute, async (c): Promise<any> => {
    const limit = parseIntParam(c.req.query("limit"));
    const result = await service.list(
      {
        cronId: c.req.query("cronId") || undefined,
        repo: c.req.query("repo") || undefined,
        status: c.req.query("status") || undefined,
        limit,
        cursor: c.req.query("cursor"),
      },
      callerScope(c),
    );
    return c.json(
      {
        findings: result.findings,
        total: result.total,
        limit: limit ?? 50,
        nextCursor: result.nextCursor ?? null,
      },
      200,
    );
  });

  return app;
}
