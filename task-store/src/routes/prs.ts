/**
 * task-store/src/routes/prs.ts
 * PR tracking routes — review claim/heartbeat/complete/patch/release lifecycle.
 *
 * Returns an OpenAPIHono sub-app mounted at /prs by app.ts. Auth is applied by
 * the parent app, so these handlers assume the caller is already authenticated.
 *
 * Agent tokens (agentId set) are repo-scoped:
 *   - writes validate that the PR's repo is in c.get('repos')
 * Admin tokens (agentId null) have no restrictions.
 *
 * Routes:
 *   GET    /prs               list (?repo, ?prNumber, ?taskId, ?state, ?reviewState, ?staged)
 *   POST   /prs/claim         atomic claim (201 new, 200 update, 409 conflict)
 *   POST   /prs/claim-next    atomic find-and-claim oldest eligible PR (200+{pr,phase} or 204)
 *   GET    /prs/:id           fetch one (404 when missing)
 *   PATCH  /prs/:id           update fields
 *   POST   /prs/:id/heartbeat touch heartbeatAt
 *   POST   /prs/:id/complete  reviewState=posted
 *   POST   /prs/:id/patch     patchCycles++, reviewState=pending
 *   POST   /prs/:id/release   unclaim → reviewState=pending
 */

import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import type { TaskStoreAuthEnv } from "../auth.ts";
import { BadRequestError, NotFoundError } from "../errors.ts";
import {
  ClaimNextBodySchema,
  ClaimNextResponseSchema,
  ClaimPrBodySchema,
  ErrorSchema,
  PrIdParamSchema,
  PrListQuerySchema,
  PrListResponseSchema,
  PullRequestSchema,
  UpdatePrBodySchema,
} from "../openapi-schemas.ts";
import type { PullRequest } from "../index.ts";
import type { PullRequestServiceLike } from "../pull-request-service.ts";
import { isOrgRepo } from "../validate.ts";

async function readJson(c: {
  req: { json: () => Promise<unknown> };
}): Promise<Record<string, unknown>> {
  try {
    const body = await c.req.json();
    if (body && typeof body === "object" && !Array.isArray(body)) {
      return body as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
}

// repos === null means admin token — bypass scope check; still enforce format.
function validateRepo(repo: unknown, repos: string[] | null): void {
  if (repo === undefined || repo === null) return;
  if (typeof repo !== "string" || !isOrgRepo(repo)) {
    throw new BadRequestError(`repo '${repo}' must be in org/repo format`);
  }
  if (repos !== null && !repos.includes(repo)) {
    throw new BadRequestError(`repo '${repo}' is not in this agent's scope`);
  }
}

// ─── Route definitions ────────────────────────────────────────────────────────

const listRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["PRs"],
  summary: "List pull requests",
  request: {
    query: PrListQuerySchema,
  },
  responses: {
    200: {
      content: { "application/json": { schema: PrListResponseSchema } },
      description: "List of pull requests",
    },
  },
});

const claimRoute = createRoute({
  method: "post",
  path: "/claim",
  tags: ["PRs"],
  summary: "Claim a pull request (atomic)",
  request: {
    body: {
      content: { "application/json": { schema: ClaimPrBodySchema } },
      required: true,
    },
  },
  responses: {
    200: {
      content: { "application/json": { schema: PullRequestSchema } },
      description: "Updated existing claim",
    },
    201: {
      content: { "application/json": { schema: PullRequestSchema } },
      description: "New claim created",
    },
    400: {
      content: { "application/json": { schema: ErrorSchema } },
      description: "Bad request",
    },
    409: {
      content: { "application/json": { schema: ErrorSchema } },
      description: "Conflict — already claimed with same commitSha",
    },
  },
});

const claimNextRoute = createRoute({
  method: "post",
  path: "/claim-next",
  tags: ["PRs"],
  summary: "Atomic find-and-claim of oldest eligible PR",
  request: {
    body: {
      content: { "application/json": { schema: ClaimNextBodySchema } },
      required: false,
    },
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: ClaimNextResponseSchema,
        },
      },
      description: "PR claimed — returns {pr, phase}",
    },
    204: {
      description: "No eligible PR found",
    },
    400: {
      content: { "application/json": { schema: ErrorSchema } },
      description: "Bad request",
    },
  },
});

const getOneRoute = createRoute({
  method: "get",
  path: "/:id",
  tags: ["PRs"],
  summary: "Fetch a single pull request",
  request: {
    params: PrIdParamSchema,
  },
  responses: {
    200: {
      content: { "application/json": { schema: PullRequestSchema } },
      description: "Pull request record",
    },
    404: {
      content: { "application/json": { schema: ErrorSchema } },
      description: "Not found",
    },
  },
});

const updateRoute = createRoute({
  method: "patch",
  path: "/:id",
  tags: ["PRs"],
  summary: "Update pull request fields",
  request: {
    params: PrIdParamSchema,
    body: {
      content: { "application/json": { schema: UpdatePrBodySchema } },
      required: true,
    },
  },
  responses: {
    200: {
      content: { "application/json": { schema: PullRequestSchema } },
      description: "Updated pull request",
    },
    400: {
      content: { "application/json": { schema: ErrorSchema } },
      description: "Bad request",
    },
    404: {
      content: { "application/json": { schema: ErrorSchema } },
      description: "Not found",
    },
  },
});

const heartbeatRoute = createRoute({
  method: "post",
  path: "/:id/heartbeat",
  tags: ["PRs"],
  summary: "Touch heartbeatAt for a claimed PR",
  request: {
    params: PrIdParamSchema,
  },
  responses: {
    200: {
      content: { "application/json": { schema: PullRequestSchema } },
      description: "PR with updated heartbeatAt",
    },
  },
});

const completeRoute = createRoute({
  method: "post",
  path: "/:id/complete",
  tags: ["PRs"],
  summary: "Mark PR review as complete (reviewState=posted)",
  request: {
    params: PrIdParamSchema,
  },
  responses: {
    200: {
      content: { "application/json": { schema: PullRequestSchema } },
      description: "Completed PR",
    },
    404: {
      content: { "application/json": { schema: ErrorSchema } },
      description: "Not found",
    },
  },
});

const patchRoute = createRoute({
  method: "post",
  path: "/:id/patch",
  tags: ["PRs"],
  summary: "Increment patchCycles and reset reviewState=pending",
  request: {
    params: PrIdParamSchema,
  },
  responses: {
    200: {
      content: { "application/json": { schema: PullRequestSchema } },
      description: "Patched PR",
    },
    404: {
      content: { "application/json": { schema: ErrorSchema } },
      description: "Not found",
    },
  },
});

const releaseRoute = createRoute({
  method: "post",
  path: "/:id/release",
  tags: ["PRs"],
  summary: "Release a claim (reviewState=pending, claimedBy cleared)",
  request: {
    params: PrIdParamSchema,
  },
  responses: {
    200: {
      content: { "application/json": { schema: PullRequestSchema } },
      description: "Released PR",
    },
    404: {
      content: { "application/json": { schema: ErrorSchema } },
      description: "Not found",
    },
  },
});

// ─── Factory ──────────────────────────────────────────────────────────────────

export function createPrsRoutes(
  prService: PullRequestServiceLike,
): OpenAPIHono<TaskStoreAuthEnv> {
  const app = new OpenAPIHono<TaskStoreAuthEnv>();

  // ─── List ──────────────────────────────────────────────────────────────────
  // biome-ignore lint/suspicious/noExplicitAny: service returns Prisma types; JSON serialization handles Date→string correctly at runtime
  app.openapi(listRoute, async (c): Promise<any> => {
    const limitRaw = c.req.query("limit");
    const offsetRaw = c.req.query("offset");
    const prNumberRaw = c.req.query("prNumber");

    const stagedRaw = c.req.query("staged");
    const staged =
      stagedRaw === "true" ? true : stagedRaw === "false" ? false : undefined;

    const result = await prService.list({
      repo: c.req.query("repo"),
      prNumber:
        prNumberRaw !== undefined
          ? Number.parseInt(prNumberRaw, 10)
          : undefined,
      taskId: c.req.query("taskId"),
      state: c.req.query("state"),
      reviewState: c.req.query("reviewState"),
      staged,
      limit:
        limitRaw !== undefined
          ? Number.parseInt(limitRaw, 10) || undefined
          : undefined,
      offset:
        offsetRaw !== undefined
          ? Number.parseInt(offsetRaw, 10) || undefined
          : undefined,
    });
    return c.json(result, 200);
  });

  // ─── Claim (atomic) — must be before /:id to avoid param capture ───────────
  // biome-ignore lint/suspicious/noExplicitAny: service returns Prisma types; JSON serialization handles Date→string correctly at runtime
  app.openapi(claimRoute, async (c): Promise<any> => {
    const agentId = c.get("agentId");
    const repos = c.get("repos");
    const body = await readJson(c);

    const { repo, prNumber, commitSha, claimedBy, taskId, phase } = body;

    // Validate required fields
    if (typeof repo !== "string" || !repo) {
      throw new BadRequestError("repo is required");
    }
    if (!isOrgRepo(repo)) {
      throw new BadRequestError(`repo '${repo}' must be in org/repo format`);
    }
    if (typeof prNumber !== "number" || !Number.isInteger(prNumber)) {
      throw new BadRequestError("prNumber must be an integer");
    }
    if (typeof commitSha !== "string" || !commitSha) {
      throw new BadRequestError("commitSha is required");
    }

    // Validate repo scope for agent tokens
    validateRepo(repo, agentId !== null ? repos : null);

    // Agent tokens: pin claimedBy to the token's agentId.
    // Admin tokens: read claimedBy from the request body.
    let resolvedClaimedBy: string;
    if (agentId !== null) {
      resolvedClaimedBy = agentId;
    } else {
      if (typeof claimedBy !== "string" || !claimedBy) {
        throw new BadRequestError("claimedBy is required");
      }
      resolvedClaimedBy = claimedBy;
    }

    const resolvedTaskId =
      typeof taskId === "string" && taskId ? taskId : undefined;

    // Only pass an explicit phase when the caller supplied one — leaving it
    // undefined lets the service's own `= "review"` default parameter apply,
    // matching callers (like review.md) that don't send phase at all.
    // readJson reads the raw body, not the Zod-validated payload — this guard
    // narrows phase to the allowed enum values before forwarding to the service.
    const resolvedPhase =
      phase === "review" || phase === "patch" || phase === "deploy"
        ? phase
        : undefined;

    const { status, record } = await prService.claim(
      repo,
      prNumber,
      commitSha,
      resolvedClaimedBy,
      resolvedTaskId,
      resolvedPhase,
    );

    return c.json(record, status);
  });

  // ─── Claim-next (atomic find-and-claim) ───────────────────────────────────
  // Must be before /:id to avoid param capture.
  // biome-ignore lint/suspicious/noExplicitAny: service returns Prisma types; JSON serialization handles Date→string correctly at runtime
  app.openapi(claimNextRoute, async (c): Promise<any> => {
    const agentId = c.get("agentId");
    const repos = c.get("repos");
    const body = await readJson(c);

    const { maxConcurrent } = body;

    // Agent tokens: pin agentId from the token.
    // Admin tokens: read agentId from the request body.
    let resolvedAgentId: string;
    if (agentId !== null) {
      resolvedAgentId = agentId;
    } else {
      if (typeof body.agentId !== "string" || !body.agentId) {
        throw new BadRequestError("agentId is required");
      }
      resolvedAgentId = body.agentId as string;
    }

    const resolvedMaxConcurrent =
      typeof maxConcurrent === "number" && maxConcurrent > 0
        ? maxConcurrent
        : 1;

    // Pass repo scope for agent tokens so claimNext only returns in-scope PRs
    const result = await prService.claimNext(
      resolvedAgentId,
      resolvedMaxConcurrent,
      agentId !== null ? repos ?? undefined : undefined,
    );

    if (result === null) {
      return c.body(null, 204);
    }

    return c.json(result, 200);
  });

  // ─── Get one ───────────────────────────────────────────────────────────────
  // biome-ignore lint/suspicious/noExplicitAny: service returns Prisma types; JSON serialization handles Date→string correctly at runtime
  app.openapi(getOneRoute, async (c): Promise<any> => {
    const pr = await prService.get(c.req.param("id"));
    if (!pr) throw new NotFoundError("pr not found");
    return c.json(pr, 200);
  });

  // ─── Update ────────────────────────────────────────────────────────────────
  // Only these fields are writable via PATCH. All other fields are managed by
  // dedicated lifecycle endpoints (claim, complete, patch, release) that enforce
  // valid state transitions atomically.
  //
  // Extensions for deploy.md upsert flow:
  //   state, mergedAt, reviewState — set when marking a PR as merged
  //
  // Pipeline phase tracking:
  //   phase, readyForReviewAt, readyForPatchAt, readyForDeployAt — set by
  //   the review/patch/deploy skills to record when a PR enters each phase
  const PATCH_ALLOWED_FIELDS: Array<keyof PullRequest> = [
    "staged",
    "commitSha",
    "taskId",
    "agentId",
    "state",
    "mergedAt",
    "reviewState",
    "phase",
    "readyForReviewAt",
    "readyForPatchAt",
    "readyForDeployAt",
  ];

  // biome-ignore lint/suspicious/noExplicitAny: service returns Prisma types; JSON serialization handles Date→string correctly at runtime
  app.openapi(updateRoute, async (c): Promise<any> => {
    const agentId = c.get("agentId");
    const repos = c.get("repos");
    const body = await readJson(c);

    // For agent tokens, validate the existing PR's repo is in scope
    if (agentId !== null) {
      const pr = await prService.get(c.req.param("id"));
      if (!pr) throw new NotFoundError("pr not found");
      validateRepo(pr.repo, repos);
    }

    // Apply field allowlist — silently drop any fields not in the list
    const filtered: Partial<PullRequest> = {};
    for (const key of PATCH_ALLOWED_FIELDS) {
      if (key in body) {
        (filtered as Record<string, unknown>)[key] = body[key];
      }
    }
    if (Object.keys(filtered).length === 0) {
      throw new BadRequestError("no updatable fields provided");
    }

    const updated = await prService.update(c.req.param("id"), filtered);
    return c.json(updated, 200);
  });

  // ─── Heartbeat ─────────────────────────────────────────────────────────────
  // biome-ignore lint/suspicious/noExplicitAny: service returns Prisma types; JSON serialization handles Date→string correctly at runtime
  app.openapi(heartbeatRoute, async (c): Promise<any> => {
    const pr = await prService.heartbeat(c.req.param("id"));
    return c.json(pr, 200);
  });

  // ─── Complete ──────────────────────────────────────────────────────────────
  // biome-ignore lint/suspicious/noExplicitAny: service returns Prisma types; JSON serialization handles Date→string correctly at runtime
  app.openapi(completeRoute, async (c): Promise<any> => {
    const pr = await prService.complete(c.req.param("id"));
    return c.json(pr, 200);
  });

  // ─── Patch ─────────────────────────────────────────────────────────────────
  // biome-ignore lint/suspicious/noExplicitAny: service returns Prisma types; JSON serialization handles Date→string correctly at runtime
  app.openapi(patchRoute, async (c): Promise<any> => {
    const pr = await prService.patch(c.req.param("id"));
    return c.json(pr, 200);
  });

  // ─── Release ───────────────────────────────────────────────────────────────
  // biome-ignore lint/suspicious/noExplicitAny: service returns Prisma types; JSON serialization handles Date→string correctly at runtime
  app.openapi(releaseRoute, async (c): Promise<any> => {
    const pr = await prService.release(c.req.param("id"));
    return c.json(pr, 200);
  });

  return app;
}
