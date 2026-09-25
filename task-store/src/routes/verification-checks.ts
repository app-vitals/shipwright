/**
 * task-store/src/routes/verification-checks.ts
 * Verification check write/read routes — structured per-check verification
 * outcomes (LVB-5.1: the queryable successor to the printed-only "PRE-SHIP
 * CHECKS" table dev-task.md Step 8 / patch.md emit today).
 *
 * Returns an OpenAPIHono sub-app mounted at /verification-checks by app.ts.
 * Auth is applied by the parent app, so these handlers assume the caller is
 * already authenticated — mirrors POST /prs/:id/findings, which likewise
 * performs no additional agent-token repo-scope check beyond the blanket
 * bearer auth (see routes/prs.ts's file-header comment).
 *
 * A VerificationCheck belongs to exactly one parent (a Task or a PullRequest),
 * so this is a dedicated top-level route rather than nested under /tasks/:id
 * or /prs/:id (which would mean duplicating the same handler in both sibling
 * route files for a shape neither parent owns exclusively) — POST takes
 * taskId/prId in the body, GET takes them as alternative query params.
 *
 * Routes:
 *   POST /verification-checks  record one outcome
 *                              {taskId? | prId?, repo, checkName, status,
 *                               reasonCategory?, learnedFromCategory?,
 *                               durationMs?, at?}
 *   GET  /verification-checks  list outcomes for a task, a PR, or a
 *                              repo+checkName pair (LVB-4.4)
 *                              (?taskId= XOR ?prId= XOR (?repo=+?checkName=),
 *                               ?limit, ?offset)
 *
 * The third mode — ?repo=+?checkName= — answers "the last few outcomes for
 * check X on repo Y, across ALL tasks/PRs" rather than scoping to one parent.
 * It exists for LVB-4.4's skip-locally learning trigger: after N consecutive
 * skipped/timed_out outcomes for the same check+repo, dev-task writes a
 * skip-locally classification back to the project's own docs (LVB-4.2's
 * append mechanism). Detecting that streak requires walking history backward
 * from the most recent outcome, which is why this mode orders `at`
 * DESCENDING — the opposite of the taskId/prId modes' ascending order, which
 * is unchanged for backward compatibility.
 */

import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { readJson } from "@shipwright/lib/http";
import type { TaskStoreAuthEnv } from "../auth.ts";
import { BadRequestError } from "../errors.ts";
import type {
  VerificationCheckReasonCategory,
  VerificationCheckStatus,
} from "../index.ts";
import {
  CreateVerificationCheckBodySchema,
  ErrorSchema,
  VerificationCheckListQuerySchema,
  VerificationCheckListResponseSchema,
  VerificationCheckSchema,
} from "../openapi-schemas.ts";
import type { VerificationCheckServiceLike } from "../verification-check-service.ts";

// ─── Route definitions ────────────────────────────────────────────────────────

const recordRoute = createRoute({
  method: "post",
  path: "/",
  tags: ["Verification Checks"],
  summary: "Record a single per-check verification outcome",
  description:
    "Records one VerificationCheck row against exactly one parent — `taskId` (a task still in progress, before a PR exists) or `prId` (an already-open PR); supplying neither or both is `400`. `status` is `ran_passed | ran_failed | skipped | timed_out`. `reasonCategory` is a closed set of ENVIRONMENTAL causes and is only valid alongside `status: skipped | timed_out` — a `ran_failed` row (the check ran and produced a genuine failure) must never carry one; supplying it anyway is `400`, enforced server-side (not just by convention). `learnedFromCategory` is only valid alongside `reasonCategory: learned_skip`, and must not itself be `learned_skip`. `at` defaults to the current time when omitted.",
  request: {
    body: {
      content: {
        "application/json": { schema: CreateVerificationCheckBodySchema },
      },
      required: true,
    },
  },
  responses: {
    201: {
      content: { "application/json": { schema: VerificationCheckSchema } },
      description: "Recorded verification check",
    },
    400: {
      content: { "application/json": { schema: ErrorSchema } },
      description:
        "Bad request — missing/invalid fields, taskId/prId neither-or-both, or a status/reasonCategory combination that violates the ran_failed-never-carries-a-reasonCategory rule",
    },
    404: {
      content: { "application/json": { schema: ErrorSchema } },
      description: "Not found — the referenced task/pr does not exist",
    },
  },
});

const listRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Verification Checks"],
  summary:
    "List verification checks for a task, a PR, or a repo+checkName pair",
  description:
    "Returns `{ checks, total, limit, offset }` for exactly one of three mutually-exclusive modes: `?taskId=`, `?prId=`, or `?repo=`+`?checkName=` together (supplying none, or more than one mode, or only half of the repo+checkName pair, is `400`). The `?taskId=`/`?prId=` modes are ordered by `at` ascending (oldest first, default `limit=50`, `offset=0`) and `404` if the referenced task/pr doesn't exist. The `?repo=`+`?checkName=` mode (LVB-4.4) spans every task/PR that recorded that repo+check — there's no single parent to `404` on, so an unmatched pair returns `200` with an empty list — and is ordered by `at` DESCENDING (most recent first) so a caller can walk backward from the latest outcome to detect a consecutive skipped/timed_out streak.",
  request: {
    query: VerificationCheckListQuerySchema,
  },
  responses: {
    200: {
      content: {
        "application/json": { schema: VerificationCheckListResponseSchema },
      },
      description: "Verification check history",
    },
    400: {
      content: { "application/json": { schema: ErrorSchema } },
      description:
        "Bad request — none, or more than one, of ?taskId=/?prId=/(?repo=+?checkName=) supplied, or only one half of the ?repo=/?checkName= pair given",
    },
    404: {
      content: { "application/json": { schema: ErrorSchema } },
      description:
        "Not found (?taskId=/?prId= modes only — the referenced task/pr doesn't exist)",
    },
  },
});

// ─── Factory ──────────────────────────────────────────────────────────────────

export function createVerificationChecksRoutes(
  service: VerificationCheckServiceLike,
): OpenAPIHono<TaskStoreAuthEnv> {
  const app = new OpenAPIHono<TaskStoreAuthEnv>();

  // ─── Record ────────────────────────────────────────────────────────────────
  // biome-ignore lint/suspicious/noExplicitAny: service returns Prisma types; JSON serialization handles Date→string correctly at runtime
  app.openapi(recordRoute, async (c): Promise<any> => {
    const body = await readJson(c);
    const { taskId, prId, repo, checkName, status, at } = body;

    const check = await service.record({
      taskId: typeof taskId === "string" && taskId ? taskId : undefined,
      prId: typeof prId === "string" && prId ? prId : undefined,
      repo: typeof repo === "string" ? repo : "",
      checkName: typeof checkName === "string" ? checkName : "",
      status: status as VerificationCheckStatus,
      reasonCategory:
        typeof body.reasonCategory === "string"
          ? (body.reasonCategory as VerificationCheckReasonCategory)
          : undefined,
      learnedFromCategory:
        typeof body.learnedFromCategory === "string"
          ? (body.learnedFromCategory as VerificationCheckReasonCategory)
          : undefined,
      durationMs:
        typeof body.durationMs === "number" ? body.durationMs : undefined,
      at: typeof at === "string" && at ? at : undefined,
    });

    return c.json(check, 201);
  });

  // ─── List ──────────────────────────────────────────────────────────────────
  // biome-ignore lint/suspicious/noExplicitAny: service returns Prisma types; JSON serialization handles Date→string correctly at runtime
  app.openapi(listRoute, async (c): Promise<any> => {
    const taskId = c.req.query("taskId");
    const prId = c.req.query("prId");
    const repo = c.req.query("repo");
    const checkName = c.req.query("checkName");

    const hasTask = Boolean(taskId);
    const hasPr = Boolean(prId);
    const hasRepoCheck = Boolean(repo) && Boolean(checkName);
    const hasPartialRepoCheck =
      (Boolean(repo) || Boolean(checkName)) && !hasRepoCheck;

    if (hasPartialRepoCheck) {
      throw new BadRequestError(
        "?repo= and ?checkName= must both be supplied together",
      );
    }

    const modeCount = [hasTask, hasPr, hasRepoCheck].filter(Boolean).length;
    if (modeCount === 0) {
      throw new BadRequestError(
        "exactly one of ?taskId=, ?prId=, or (?repo=+?checkName=) is required — none was provided",
      );
    }
    if (modeCount > 1) {
      throw new BadRequestError(
        "exactly one of ?taskId=, ?prId=, or (?repo=+?checkName=) is required — more than one was provided",
      );
    }

    const limitRaw = c.req.query("limit");
    const offsetRaw = c.req.query("offset");
    const limit =
      limitRaw !== undefined
        ? Number.parseInt(limitRaw, 10) || undefined
        : undefined;
    const offset =
      offsetRaw !== undefined
        ? Number.parseInt(offsetRaw, 10) || undefined
        : undefined;

    const result = hasTask
      ? await service.listForTask(taskId as string, { limit, offset })
      : hasPr
        ? await service.listForPr(prId as string, { limit, offset })
        : await service.listByRepoAndCheck(
            repo as string,
            checkName as string,
            {
              limit,
              offset,
            },
          );

    return c.json(
      {
        checks: result.checks,
        total: result.total,
        limit: limit ?? 50,
        offset: offset ?? 0,
      },
      200,
    );
  });

  return app;
}
