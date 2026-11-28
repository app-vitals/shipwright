/**
 * task-store/src/routes/readiness-summary.ts
 * Fleet readiness roll-up route (RDY-4.1).
 *
 * Returns an OpenAPIHono sub-app mounted at /readiness by app.ts. Auth is
 * applied by the parent app.
 *
 *   GET /readiness/summary   percent of repos at Level 3+, level distribution,
 *                            per-repo failing checks (with ownerRunning) and a
 *                            12-week trend. Agent tokens see only their repos;
 *                            admin sees everything (?accountId= narrows).
 */

import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { resolveAccountScope } from "../account-scope.ts";
import type { TaskStoreAuthEnv } from "../auth.ts";
import {
  ReadinessSummaryQuerySchema,
  ReadinessSummaryResponseSchema,
} from "../openapi-schemas.ts";
import type { ReadinessSummaryServiceLike } from "../readiness-summary-service.ts";

const summaryRoute = createRoute({
  method: "get",
  path: "/summary",
  tags: ["Readiness"],
  summary: "Fleet agent-readiness summary",
  description:
    "Rolls up each repo's latest readiness snapshot: `percentAtOrAboveFloor` (Level 3+) and `repoCount`, `levelDistribution` (count per level 0-5), `repos` (latest level, failing checks with `owner` and server-computed `ownerRunning`, `scoredAt`, `stale`) and a 12-point weekly `trend` (oldest first; each week uses every repo's latest snapshot in that week). Repos whose latest snapshot is more than 7 days old are listed with `stale: true` and excluded from the percentage, `repoCount` and `levelDistribution`. `ownerRunning` is false when the owner system cron is disabled, missing, or not scoped to the repo; the `operator` owner is always true. Agent tokens see only repos in their scope and their own account; admin tokens see everything and may narrow with `?accountId=`.",
  request: { query: ReadinessSummaryQuerySchema },
  responses: {
    200: {
      content: {
        "application/json": { schema: ReadinessSummaryResponseSchema },
      },
      description: "Readiness summary",
    },
  },
});

export function createReadinessSummaryRoutes(
  service: ReadinessSummaryServiceLike,
): OpenAPIHono<TaskStoreAuthEnv> {
  const app = new OpenAPIHono<TaskStoreAuthEnv>();

  // biome-ignore lint/suspicious/noExplicitAny: service result is JSON-serializable; response shape is validated by the OpenAPI schema
  app.openapi(summaryRoute, async (c): Promise<any> => {
    const summary = await service.summary({
      repos: c.get("repos"),
      accountId: resolveAccountScope(c),
    });
    return c.json(summary, 200);
  });

  return app;
}
