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
 *   GET    /prs               list (?repo, ?org, ?prNumber, ?state, ?reviewState, ?staged, ?ready, ?blocked, ?sort)
 *                              — ?repo and ?org accept repeated query params (e.g. ?repo=a&repo=b)
 *   POST   /prs/claim         atomic claim (201 new, 200 update, 409 conflict)
 *   POST   /prs/claim-next    atomic find-and-claim oldest eligible PR (200+{pr,phase} or 204)
 *   GET    /prs/:id           fetch one (404 when missing)
 *   PATCH  /prs/:id           update fields
 *   POST   /prs/:id/heartbeat touch heartbeatAt
 *   POST   /prs/:id/complete  reviewState=posted
 *   POST   /prs/:id/patch     patchCycles++, reviewState=pending (conditionally on commitSha); optional ciFailureSignature tracks a CI-failure streak, auto-blocking at threshold
 *   POST   /prs/:id/release   unclaim → reviewState=pending
 *   POST   /prs/:id/skip      increment skipCount, auto-block at threshold
 *   POST   /prs/:id/skip/reset  reset skipCount back to 0; also clears blocked/blockedReason
 *                                but only when blockedReason matches the skip-auto-block pattern
 *   POST   /prs/:id/findings  append a PrFinding row {ref, disposition, source, evidence, at?}
 *                              — source:"patch" may only submit disposition:"rejected" (400
 *                              otherwise); source:"review" may submit any disposition
 *   GET    /prs/:id/events    fetch a PR's PullRequestEvent audit trail (?limit, ?offset),
 *                              ordered by `at` ascending (oldest first)
 */

import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { readJson } from "@shipwright/lib/http";
import type { TaskStoreAuthEnv } from "../auth.ts";
import { BadRequestError, ForbiddenError, NotFoundError } from "../errors.ts";
import { PrOrigin } from "../index.ts";
import type {
  PrFindingDisposition,
  PrFindingSource,
  PrState,
  PullRequest,
} from "../index.ts";
import {
  CensusBodySchema,
  CensusCursorQuerySchema,
  CensusCursorResponseSchema,
  CensusResponseSchema,
  ClaimNextBodySchema,
  ClaimNextResponseSchema,
  ClaimPrBodySchema,
  CreateFindingBodySchema,
  ErrorSchema,
  PatchPrBodySchema,
  PrEventsQuerySchema,
  PrEventsResponseSchema,
  PrFindingSchema,
  PrIdParamSchema,
  PrListQuerySchema,
  PrListResponseSchema,
  PullRequestSchema,
  UpdatePrBodySchema,
} from "../openapi-schemas.ts";
import {
  type CensusEntryInput,
  MAX_CENSUS_ENTRIES,
  type PullRequestServiceLike,
} from "../pull-request-service.ts";
import { isOrgRepo } from "../validate.ts";

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

// Census-specific repo scope check (POM-1.1): format violations are still
// 400 (matches validateRepo() above), but an out-of-scope repo is 403 —
// deliberately NOT reusing validateRepo()'s own 400-for-everything shape,
// per POM-1.1's acceptance criteria for POST /prs/census and
// GET /prs/census/cursor.
function validateCensusRepoScope(repo: string, repos: string[] | null): void {
  if (!isOrgRepo(repo)) {
    throw new BadRequestError(`repo '${repo}' must be in org/repo format`);
  }
  if (repos !== null && !repos.includes(repo)) {
    throw new ForbiddenError(`repo '${repo}' is not in this agent's scope`);
  }
}

// Derived from the runtime PrOrigin enum rather than hand-listed, so this
// stays in sync with the Prisma schema without a second literal to update.
const PR_ORIGIN_VALUES = new Set<string>(Object.values(PrOrigin));

/** Parse a raw census-entry value into a nullable-or-undefined string field:
 * a real string or explicit null are passed through; anything else
 * (undefined, wrong type) becomes undefined ("leave untouched"). */
function stringOrNull(value: unknown): string | null | undefined {
  if (typeof value === "string" || value === null) return value;
  return undefined;
}

/** Parse a raw census-entry value into a nullable-or-undefined integer field:
 * a real integer or explicit null are passed through; anything else
 * (undefined, wrong type, non-integer) becomes undefined ("leave untouched"). */
function numberOrNull(value: unknown): number | null | undefined {
  if (value === null) return null;
  if (typeof value === "number" && Number.isInteger(value)) return value;
  return undefined;
}

// ─── Route definitions ────────────────────────────────────────────────────────

const listRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["PRs"],
  summary: "List pull requests",
  description:
    "Returns `{ prs, total, limit, offset }`. `?ready=true` returns only unclaimed PRs (`claimedBy IS NULL`); `?blocked=true` returns PRs where `pr.blocked===true` OR a linked task has `status='blocked'` (resolved live via `(Task.repo, Task.pr)`, so a PR shared by several bundled tasks is blocked if any one of them is). `repo`/`org` are repeatable query params combined via AND; `sort` orders by `createdAt` (`asc` default).",
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
  description:
    "Atomic via Postgres row locking, keyed on `(repo, prNumber)`. No existing record creates and returns `201` (a concurrent INSERT loser hits the `@@unique([repo, prNumber])` constraint and gets `409`). Against an existing record, the conflict conditions are re-checked inside the UPDATE's own WHERE clause so only one writer can win: same `commitSha` + same `phase` + already claimed by another agent returns `409` (phase locked); already claimed + same `commitSha` + `reviewState !== pending` (review phase only) returns `409` (already reviewed at this commit); otherwise the row is updated and `200` returned (new cycle). Agent tokens pin `claimedBy` to their own ID; admin tokens supply it in the body. Optional `phase` (default `review`) sets the pipeline phase — `patch`/`deploy` phases preserve `reviewState` as-is rather than resetting it. Optional `authorLogin`/`headRef`/`title` (POM-1.2) are forwarded server-side into an atomic origin-stamping write: a linked Task row (matching `repo`+`pr`) always derives `origin='shipwright'`; otherwise `authorLogin`/`headRef` are pattern-matched against known CI/dependency-bot signals, falling back to `human`/`unknown`. Origin is first-write-wins (never overwritten once set); `authorLogin`/`headRef`/`title` are refreshed to the latest value on every claim.",
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
  description:
    "Atomically finds and claims the oldest eligible PR not yet claimed by the calling agent, in one round-trip — useful for agents implementing a pull-based queue instead of manually claiming a specific PR. Optional `maxConcurrent` (default `1`) caps how many PRs the agent may hold at once; if the agent already has that many claimed, returns `204`. Agent tokens see only PRs in their configured repo scope; admin tokens see all. Returns `200` with `{ pr, phase }`, or `204` if nothing eligible.",
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
  description:
    "Fetches a single PR record by its ID. Returns `404` if not found.",
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
  description:
    "Writable fields: `staged`, `commitSha`, `reviewedCommitSha`, `agentId`, `state`, `mergedAt`, `reviewState`, `reviewedAt`, `phase`, `readyForReviewAt`, `readyForPatchAt`, `readyForDeployAt`, `blocked`, `blockedReason` — every other field is managed by a lifecycle endpoint instead. Returns `400` if no writable field is provided. Unlike the lifecycle endpoints, PATCH does not record a PullRequestEvent audit row; it's meant for late-stage corrections (e.g. force-setting `state=merged` after GitHub confirms it) that don't need transactional field-diff auditing. Setting `state` to `merged`/`closed`, or `reviewState` to `posted`/`approved`, clears the claim fields (`claimedBy`, `claimedAt`, `heartbeatAt`, `phase`) as a side effect so a completed PR isn't left held by a stale claim. Setting `reviewState=posted` together with `reviewedCommitSha` records the commit-level dedup marker the review phase's staged-review guard reads to decide whether re-review is needed.",
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
  description:
    "Updates `heartbeatAt` to now to signal the claiming agent is still working. Deliberately excluded from the PullRequestEvent audit trail — a bare liveness ping recording would be a guaranteed no-op, and keeping this a single cheap UPDATE avoids dominating write volume.",
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
  description:
    "Sets `reviewState=posted`, increments `reviewCycles`, sets `reviewedAt`, and clears `claimedBy`/`claimedAt`/`heartbeatAt`/`phase` so the review claim is released as soon as the review is done. Records field-level transitions as PullRequestEvent rows.",
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
  summary:
    "Increment patchCycles and conditionally reset reviewState=pending; optionally track a CI-failure streak via ciFailureSignature",
  description:
    "Increments `patchCycles`, sets `patchedAt`, and clears `claimedBy`/`claimedAt`/`heartbeatAt`/`phase`. `reviewState` is reset conditionally based on the optional `commitSha` field: omitted resets unconditionally to `pending`; provided and differing from the stored `commitSha` also resets to `pending` and updates `commitSha`; provided and matching leaves `reviewState` untouched (a no-op patch cycle). The optional `ciFailureSignature` field tracks consecutive patch cycles hitting the same CI failure — a matching signature increments `consecutiveCiFailureCount`, a differing or absent one resets it to 1; crossing the threshold (3, `SPIN_DETECTION_THRESHOLD`) auto-sets `blocked=true` with a descriptive `blockedReason`. Records field-level transitions as PullRequestEvent rows.",
  request: {
    params: PrIdParamSchema,
    body: {
      content: { "application/json": { schema: PatchPrBodySchema } },
      required: false,
    },
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
  description:
    "Clears `claimedBy`, `claimedAt`, and `heartbeatAt`. Resets `reviewState=pending` unless it's already a terminal value (`posted`/`approved`), in which case `reviewState` is left untouched. Records field-level transitions as PullRequestEvent rows.",
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

const skipRoute = createRoute({
  method: "post",
  path: "/:id/skip",
  tags: ["PRs"],
  summary: "Record a skip — increments skipCount, auto-blocks at threshold",
  description:
    'Increments `skipCount` and updates `lastSkippedAt` to now. When `skipCount` crosses the threshold (3), auto-sets `blocked=true` and `blockedReason="Auto-blocked after {skipCount} consecutive skips (dispatched but found nothing to do)"`. Mirrors `POST /tasks/:id/skip`. Records field-level transitions as PullRequestEvent rows.',
  request: {
    params: PrIdParamSchema,
  },
  responses: {
    200: {
      content: { "application/json": { schema: PullRequestSchema } },
      description: "Updated PR",
    },
    404: {
      content: { "application/json": { schema: ErrorSchema } },
      description: "Not found",
    },
  },
});

const skipResetRoute = createRoute({
  method: "post",
  path: "/:id/skip/reset",
  tags: ["PRs"],
  summary:
    "Reset skip tracking — skipCount back to 0; also clears blocked/blockedReason if the PR was blocked by the skip mechanism",
  description:
    'Resets `skipCount` to 0 and clears `lastSkippedAt`. If the PR is currently blocked with a `blockedReason` matching the skip-auto-block message (contains "consecutive skips"), also clears `blocked=false` and `blockedReason=null` in the same update — a block set by a different mechanism (e.g. the CI-failure-streak auto-block from `POST /:id/patch`) is left untouched. Records field-level transitions as PullRequestEvent rows.',
  request: {
    params: PrIdParamSchema,
  },
  responses: {
    200: {
      content: { "application/json": { schema: PullRequestSchema } },
      description: "Updated PR",
    },
    404: {
      content: { "application/json": { schema: ErrorSchema } },
      description: "Not found",
    },
  },
});

const findingsRoute = createRoute({
  method: "post",
  path: "/:id/findings",
  tags: ["PRs"],
  summary:
    "Append a review/patch finding to a PR — source:'patch' may only submit disposition:'rejected'",
  description:
    'Appends a `PrFinding` row: `{ ref, disposition, source, evidence, at?, agentId? }`, where `disposition` is one of `resolved`, `superseded`, `rejected`, and `source` is one of `review`, `patch`. Server-enforced authority rule: `source:"patch"` may only submit `disposition:"rejected"` (patch cannot unilaterally resolve or supersede a finding it didn\'t originate) — any other combination returns `400`. `source:"review"` may submit any disposition. Returns `201` with the created finding.',
  request: {
    params: PrIdParamSchema,
    body: {
      content: { "application/json": { schema: CreateFindingBodySchema } },
      required: true,
    },
  },
  responses: {
    201: {
      content: { "application/json": { schema: PrFindingSchema } },
      description: "Finding recorded",
    },
    400: {
      content: { "application/json": { schema: ErrorSchema } },
      description:
        "Bad request — including the authority violation of source:'patch' submitting a disposition other than 'rejected'",
    },
    404: {
      content: { "application/json": { schema: ErrorSchema } },
      description: "Not found",
    },
  },
});

const eventsRoute = createRoute({
  method: "get",
  path: "/:id/events",
  tags: ["PRs"],
  summary:
    "Fetch a PR's PullRequestEvent audit trail, ordered by `at` ascending (oldest first)",
  description:
    "Returns `{ events, total, limit, offset }` — the PR's append-only `PullRequestEvent` rows recording field-level state transitions, oldest first. `total` counts all events regardless of `limit`/`offset` (default `limit=50`, `offset=0`). Returns `404` if the PR doesn't exist.",
  request: {
    params: PrIdParamSchema,
    query: PrEventsQuerySchema,
  },
  responses: {
    200: {
      content: { "application/json": { schema: PrEventsResponseSchema } },
      description: "PR's event history",
    },
    404: {
      content: { "application/json": { schema: ErrorSchema } },
      description: "Not found",
    },
  },
});

const censusRoute = createRoute({
  method: "post",
  path: "/census",
  tags: ["PRs"],
  summary: "Batch upsert PR origin/author/branch/title/state metadata",
  description: `Upserts a PullRequest row for each (repo, prNumber) entry — at most ${MAX_CENSUS_ENTRIES} entries per call, all in one transaction. Writes \`authorLogin\`/\`headRef\`/\`title\`/\`state\`/\`mergedAt\`/\`prCreatedAt\`/\`commitCount\`/\`commitsDocsRefresh\`/\`commitsReviewPatch\`/\`commitsCiFix\`/\`commitsImplementation\` unconditionally; \`origin\` follows first-write-wins (only applied when the row's existing origin is currently null). Never touches claim/phase/review/patch/blocked fields — safe to run alongside review/patch/deploy's separate POST /prs/claim lock. New rows get \`phase=null\`, \`reviewState='pending'\`, \`staged=false\`. Not part of the public MCP tool surface.`,
  request: {
    body: {
      content: { "application/json": { schema: CensusBodySchema } },
      required: true,
    },
  },
  responses: {
    200: {
      content: { "application/json": { schema: CensusResponseSchema } },
      description: "Upserted PR rows, one per input entry",
    },
    400: {
      content: { "application/json": { schema: ErrorSchema } },
      description: `Bad request — malformed entry, or more than ${MAX_CENSUS_ENTRIES} entries in one batch`,
    },
    403: {
      content: { "application/json": { schema: ErrorSchema } },
      description:
        "Forbidden — an entry's repo is outside the agent token's scope",
    },
  },
});

const censusCursorRoute = createRoute({
  method: "get",
  path: "/census/cursor",
  tags: ["PRs"],
  summary: "Get the census incremental-search-window cursor for a repo",
  description:
    "Returns `{ cursor }`: the max `mergedAt` (ISO string) among rows scoped to `repo` whose `origin` is not null, or `null` when no such row exists. Used by POM-4.1's census sweep to derive its incremental search window.",
  request: {
    query: CensusCursorQuerySchema,
  },
  responses: {
    200: {
      content: { "application/json": { schema: CensusCursorResponseSchema } },
      description: "Census cursor",
    },
    400: {
      content: { "application/json": { schema: ErrorSchema } },
      description: "Bad request — missing or malformed repo",
    },
    403: {
      content: { "application/json": { schema: ErrorSchema } },
      description: "Forbidden — repo is outside the agent token's scope",
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
    const ready = c.req.query("ready") === "true" ? true : undefined;
    const blocked = c.req.query("blocked") === "true" ? true : undefined;
    const sort = c.req.query("sort") === "desc" ? "desc" : undefined;
    const originRaw = c.req.query("origin");
    const origin = originRaw
      ? (originRaw
          .split(",")
          .map((v) => v.trim())
          .filter((v) => PR_ORIGIN_VALUES.has(v)) as PrOrigin[])
      : undefined;

    const result = await prService.list({
      repo: c.req.queries("repo"),
      org: c.req.queries("org"),
      prNumber:
        prNumberRaw !== undefined
          ? Number.parseInt(prNumberRaw, 10)
          : undefined,
      state: c.req.query("state"),
      reviewState: c.req.query("reviewState"),
      staged,
      ready,
      blocked,
      sort,
      origin,
      limit:
        limitRaw !== undefined
          ? Number.parseInt(limitRaw, 10) || undefined
          : undefined,
      offset:
        offsetRaw !== undefined
          ? Number.parseInt(offsetRaw, 10) || undefined
          : undefined,
      updatedSince: c.req.query("updatedSince"),
    });
    return c.json(result, 200);
  });

  // ─── Claim (atomic) — must be before /:id to avoid param capture ───────────
  // biome-ignore lint/suspicious/noExplicitAny: service returns Prisma types; JSON serialization handles Date→string correctly at runtime
  app.openapi(claimRoute, async (c): Promise<any> => {
    const agentId = c.get("agentId");
    const repos = c.get("repos");
    const body = await readJson(c);

    const {
      repo,
      prNumber,
      commitSha,
      claimedBy,
      phase,
      prCreatedAt,
      authorLogin,
      headRef,
      title,
    } = body;

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

    // Only pass an explicit phase when the caller supplied one — leaving it
    // undefined lets the service's own `= "review"` default parameter apply,
    // matching callers (like review.md) that don't send phase at all.
    // readJson reads the raw body, not the Zod-validated payload — this guard
    // narrows phase to the allowed enum values before forwarding to the service.
    const resolvedPhase =
      phase === "review" || phase === "patch" || phase === "deploy"
        ? phase
        : undefined;

    const resolvedPrCreatedAt =
      typeof prCreatedAt === "string" && prCreatedAt ? prCreatedAt : undefined;

    const { status, record } = await prService.claim(
      repo,
      prNumber,
      commitSha,
      resolvedClaimedBy,
      resolvedPhase,
      resolvedPrCreatedAt,
      stringOrNull(authorLogin),
      stringOrNull(headRef),
      stringOrNull(title),
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
      agentId !== null ? (repos ?? undefined) : undefined,
    );

    if (result === null) {
      return c.body(null, 204);
    }

    return c.json(result, 200);
  });

  // ─── Census (batch upsert) — must be before /:id to avoid param capture ───
  // biome-ignore lint/suspicious/noExplicitAny: service returns Prisma types; JSON serialization handles Date→string correctly at runtime
  app.openapi(censusRoute, async (c): Promise<any> => {
    const agentId = c.get("agentId");
    const repos = c.get("repos");
    // readJson() deliberately collapses an array body to {} (it's built for
    // object-shaped PATCH bodies) — read the raw JSON directly here, mirroring
    // routes/tasks.ts's bulkRoute handler for the same array-body shape.
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      throw new BadRequestError("body must be a JSON array of census entries");
    }
    if (!Array.isArray(body)) {
      throw new BadRequestError("body must be a JSON array of census entries");
    }
    if (body.length > MAX_CENSUS_ENTRIES) {
      throw new BadRequestError(
        `census accepts at most ${MAX_CENSUS_ENTRIES} entries per call (received ${body.length}) — split the batch`,
      );
    }

    const entries: CensusEntryInput[] = (body as Record<string, unknown>[]).map(
      (raw, i) => {
        const { repo, prNumber } = raw;
        if (typeof repo !== "string" || !repo) {
          throw new BadRequestError(`entry ${i}: repo is required`);
        }
        if (typeof prNumber !== "number" || !Number.isInteger(prNumber)) {
          throw new BadRequestError(`entry ${i}: prNumber must be an integer`);
        }
        validateCensusRepoScope(repo, agentId !== null ? repos : null);

        const origin =
          typeof raw.origin === "string" && PR_ORIGIN_VALUES.has(raw.origin)
            ? (raw.origin as PrOrigin)
            : undefined;
        const state =
          raw.state === "open" ||
          raw.state === "merged" ||
          raw.state === "closed"
            ? (raw.state as PrState)
            : undefined;

        return {
          repo,
          prNumber,
          origin,
          authorLogin: stringOrNull(raw.authorLogin),
          headRef: stringOrNull(raw.headRef),
          title: stringOrNull(raw.title),
          state,
          mergedAt: stringOrNull(raw.mergedAt),
          prCreatedAt: stringOrNull(raw.prCreatedAt),
          commitCount: numberOrNull(raw.commitCount),
          commitsDocsRefresh: numberOrNull(raw.commitsDocsRefresh),
          commitsReviewPatch: numberOrNull(raw.commitsReviewPatch),
          commitsCiFix: numberOrNull(raw.commitsCiFix),
          commitsImplementation: numberOrNull(raw.commitsImplementation),
        };
      },
    );

    const prs = await prService.census(entries);
    return c.json({ prs }, 200);
  });

  // ─── Census cursor — must be before /:id to avoid param capture ───────────
  // biome-ignore lint/suspicious/noExplicitAny: service returns Prisma types; JSON serialization handles Date→string correctly at runtime
  app.openapi(censusCursorRoute, async (c): Promise<any> => {
    const agentId = c.get("agentId");
    const repos = c.get("repos");
    const repo = c.req.query("repo");
    if (typeof repo !== "string" || !repo) {
      throw new BadRequestError("repo is required");
    }
    validateCensusRepoScope(repo, agentId !== null ? repos : null);

    const cursor = await prService.getCensusCursor(repo);
    return c.json({ cursor }, 200);
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
  //
  // PR-level block (blocks automation on a PR with no linked Task):
  //   blocked, blockedReason
  const PATCH_ALLOWED_FIELDS: Array<keyof PullRequest> = [
    "staged",
    "commitSha",
    "reviewedCommitSha",
    "agentId",
    "state",
    "mergedAt",
    "reviewState",
    // reviewedAt is normally set by POST /:id/complete, but review.md's terminal-skip
    // write-back paths (Step 5, Step 14.3, Live-Review Pre-Check) need to advance it
    // directly via PATCH too — it's the watermark hasFreshNonAgentComment
    // (agent/src/check-review.ts) uses to decide whether PR activity is "fresh"; without
    // this, a PR skipped via those paths keeps a frozen reviewedAt and gets re-selected
    // for review on every subsequent tick (RWA-1.2).
    "reviewedAt",
    "phase",
    "readyForReviewAt",
    "readyForPatchAt",
    "readyForDeployAt",
    "blocked",
    "blockedReason",
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
    const body = await readJson(c);
    const commitSha =
      typeof body.commitSha === "string" && body.commitSha
        ? body.commitSha
        : undefined;
    const ciFailureSignature =
      typeof body.ciFailureSignature === "string" && body.ciFailureSignature
        ? body.ciFailureSignature
        : undefined;
    const pr = await prService.patch(
      c.req.param("id"),
      commitSha,
      ciFailureSignature,
    );
    return c.json(pr, 200);
  });

  // ─── Release ───────────────────────────────────────────────────────────────
  // biome-ignore lint/suspicious/noExplicitAny: service returns Prisma types; JSON serialization handles Date→string correctly at runtime
  app.openapi(releaseRoute, async (c): Promise<any> => {
    const pr = await prService.release(c.req.param("id"));
    return c.json(pr, 200);
  });

  // ─── Skip ──────────────────────────────────────────────────────────────────
  // biome-ignore lint/suspicious/noExplicitAny: service returns Prisma types; JSON serialization handles Date→string correctly at runtime
  app.openapi(skipRoute, async (c): Promise<any> => {
    const pr = await prService.recordSkip(c.req.param("id"));
    return c.json(pr, 200);
  });

  // ─── Skip reset ────────────────────────────────────────────────────────────
  // biome-ignore lint/suspicious/noExplicitAny: service returns Prisma types; JSON serialization handles Date→string correctly at runtime
  app.openapi(skipResetRoute, async (c): Promise<any> => {
    const pr = await prService.resetSkip(c.req.param("id"));
    return c.json(pr, 200);
  });

  // ─── Findings ──────────────────────────────────────────────────────────────
  // Server-side source/disposition authority enforcement — mirrors the
  // PATCH_ALLOWED_FIELDS allowlist pattern above: the API layer, not command
  // prose, is the sole arbiter. source:"patch" cannot unilaterally resolve or
  // supersede a finding it didn't originate (only "rejected" is permitted);
  // source:"review" may write any disposition.
  // biome-ignore lint/suspicious/noExplicitAny: service returns Prisma types; JSON serialization handles Date→string correctly at runtime
  app.openapi(findingsRoute, async (c): Promise<any> => {
    const body = await readJson(c);
    const { ref, evidence, at, agentId } = body;

    // disposition/source are already constrained to their valid enum values
    // by CreateFindingBodySchema's z.enum() — the OpenAPIHono request
    // validator rejects any other value with its own 400 before this handler
    // ever runs, so re-checking them here would be dead code; the cast below
    // just recovers the type narrowing the validator already enforced at
    // runtime. ref/evidence are schema-typed as z.string() (no .min(1)), so
    // an empty string still reaches the handler — these two checks are the
    // only ones that matter.
    const disposition = body.disposition as PrFindingDisposition;
    const source = body.source as PrFindingSource;

    if (typeof ref !== "string" || !ref) {
      throw new BadRequestError("ref is required");
    }
    if (typeof evidence !== "string" || !evidence) {
      throw new BadRequestError("evidence is required");
    }
    if (source === "patch" && disposition !== "rejected") {
      throw new BadRequestError(
        "source:'patch' may only submit disposition:'rejected' — only source:'review' may resolve or supersede a finding",
      );
    }

    const resolvedAt = typeof at === "string" && at ? at : undefined;
    const resolvedAgentId =
      typeof agentId === "string" && agentId ? agentId : undefined;

    const finding = await prService.appendFinding(c.req.param("id"), {
      ref,
      disposition,
      source,
      evidence,
      at: resolvedAt,
      agentId: resolvedAgentId,
    });
    return c.json(finding, 201);
  });

  // ─── Events ────────────────────────────────────────────────────────────────
  // biome-ignore lint/suspicious/noExplicitAny: service returns Prisma types; JSON serialization handles Date→string correctly at runtime
  app.openapi(eventsRoute, async (c): Promise<any> => {
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

    const result = await prService.getEvents(c.req.param("id"), {
      limit,
      offset,
    });

    return c.json(
      {
        events: result.events,
        total: result.total,
        limit: limit ?? 50,
        offset: offset ?? 0,
      },
      200,
    );
  });

  return app;
}
