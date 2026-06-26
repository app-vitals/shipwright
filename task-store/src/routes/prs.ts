/**
 * task-store/src/routes/prs.ts
 * PR tracking routes — review claim/heartbeat/complete/patch/release lifecycle.
 *
 * Returns a Hono sub-app mounted at /prs by app.ts. Auth is applied by the
 * parent app, so these handlers assume the caller is already authenticated.
 *
 * Agent tokens (agentId set) are repo-scoped:
 *   - writes validate that the PR's repo is in c.get('repos')
 * Admin tokens (agentId null) have no restrictions.
 *
 * Routes:
 *   GET    /prs               list (?repo, ?prNumber, ?taskId, ?state, ?reviewState, ?staged)
 *   POST   /prs/claim         atomic claim (201 new, 200 update, 409 conflict)
 *   GET    /prs/:id           fetch one (404 when missing)
 *   PATCH  /prs/:id           update fields
 *   POST   /prs/:id/heartbeat touch heartbeatAt
 *   POST   /prs/:id/complete  reviewState=posted
 *   POST   /prs/:id/patch     patchCycles++, reviewState=pending
 *   POST   /prs/:id/release   unclaim → reviewState=pending
 */

import { Hono } from "hono";
import type { TaskStoreAuthEnv } from "../auth.ts";
import { BadRequestError, NotFoundError } from "../errors.ts";
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

export function createPrsRoutes(
  prService: PullRequestServiceLike,
): Hono<TaskStoreAuthEnv> {
  const app = new Hono<TaskStoreAuthEnv>();

  // ─── List ──────────────────────────────────────────────────────────────────
  app.get("/", async (c) => {
    const limitRaw = c.req.query("limit");
    const offsetRaw = c.req.query("offset");
    const prNumberRaw = c.req.query("prNumber");

    const result = await prService.list({
      repo: c.req.query("repo"),
      prNumber:
        prNumberRaw !== undefined
          ? Number.parseInt(prNumberRaw, 10)
          : undefined,
      taskId: c.req.query("taskId"),
      state: c.req.query("state"),
      reviewState: c.req.query("reviewState"),
      staged:
        c.req.query("staged") !== undefined
          ? c.req.query("staged") === "true"
          : undefined,
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
  app.post("/claim", async (c) => {
    const agentId = c.get("agentId");
    const repos = c.get("repos");
    const body = await readJson(c);

    const { repo, prNumber, commitSha, claimedBy, taskId } = body;

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

    const { status, record } = await prService.claim(
      repo,
      prNumber,
      commitSha,
      resolvedClaimedBy,
      resolvedTaskId,
    );

    return c.json(record, status);
  });

  // ─── Get one ───────────────────────────────────────────────────────────────
  app.get("/:id", async (c) => {
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
  const PATCH_ALLOWED_FIELDS: Array<keyof PullRequest> = [
    "staged",
    "commitSha",
    "taskId",
    "agentId",
    "state",
    "mergedAt",
    "reviewState",
  ];

  app.patch("/:id", async (c) => {
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
  app.post("/:id/heartbeat", async (c) => {
    const pr = await prService.heartbeat(c.req.param("id"));
    return c.json(pr, 200);
  });

  // ─── Complete ──────────────────────────────────────────────────────────────
  app.post("/:id/complete", async (c) => {
    const pr = await prService.complete(c.req.param("id"));
    return c.json(pr, 200);
  });

  // ─── Patch ─────────────────────────────────────────────────────────────────
  app.post("/:id/patch", async (c) => {
    const pr = await prService.patch(c.req.param("id"));
    return c.json(pr, 200);
  });

  // ─── Release ───────────────────────────────────────────────────────────────
  app.post("/:id/release", async (c) => {
    const pr = await prService.release(c.req.param("id"));
    return c.json(pr, 200);
  });

  return app;
}
