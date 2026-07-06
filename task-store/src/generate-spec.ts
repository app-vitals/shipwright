/**
 * task-store/src/generate-spec.ts
 * Core logic for generating the OpenAPI 3.1 spec for the task-store service.
 *
 * Exported as a pure function so it can be called from:
 *   - scripts/generate-task-store-spec.ts (the CLI entry point)
 *   - task-store/src/generate-spec.smoke.test.ts (for automated verification)
 *
 * Instantiates the tasks, tokens, and prs sub-apps with minimal stubs
 * (no real DB, no real services), calls getOpenAPI31Document() on each, and
 * merges the results into a single OpenAPI 3.1 document.
 */

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { PullRequestServiceLike } from "./pull-request-service.ts";
import { createPrsRoutes } from "./routes/prs.ts";
import { createTasksRoutes } from "./routes/tasks.ts";
import { createTokensRoutes } from "./routes/tokens.ts";
import type { TaskServiceLike } from "./task-service.ts";
import type { TokenServiceLike } from "./token-service.ts";

// ─── Stub deps — only route definitions matter for spec generation ────────────

const stubTaskService: TaskServiceLike = {
  async list() {
    return { tasks: [], total: 0, limit: 50, offset: 0 };
  },
  async listReady() {
    return [];
  },
  async listBlocked() {
    return [];
  },
  async distinct() {
    return { sessions: [], repos: [] };
  },
  async get() {
    return null;
  },
  async create() {
    return {} as never;
  },
  async bulk() {
    return { inserted: 0, updated: 0 };
  },
  async update() {
    return {} as never;
  },
  async remove() {},
  async claim() {
    return {} as never;
  },
  async heartbeat() {
    return {} as never;
  },
  async complete() {
    return {} as never;
  },
  async fail() {
    return {} as never;
  },
  async release() {
    return {} as never;
  },
};

const stubTokenService: TokenServiceLike = {
  async create() {
    return { token: {} as never, rawToken: "" };
  },
  async validate() {
    return null;
  },
  async revoke() {
    return null;
  },
  async list() {
    return [];
  },
  async update() {
    return null;
  },
};

const stubPrService: PullRequestServiceLike = {
  async list() {
    return { prs: [], total: 0, limit: 50, offset: 0 };
  },
  async get() {
    return null;
  },
  async update() {
    return {} as never;
  },
  async claim() {
    return { status: 201 as const, record: {} as never };
  },
  async heartbeat() {
    return {} as never;
  },
  async complete() {
    return {} as never;
  },
  async patch() {
    return {} as never;
  },
  async release() {
    return {} as never;
  },
  async claimNext() {
    return null;
  },
};

// ─── Spec assembly ────────────────────────────────────────────────────────────

function prefixPaths(
  paths: Record<string, Record<string, unknown>>,
  prefix: string,
): Record<string, Record<string, unknown>> {
  const result: Record<string, Record<string, unknown>> = {};
  for (const [path, def] of Object.entries(paths)) {
    const prefixed = path === "/" ? prefix : `${prefix}${path}`;
    result[prefixed] = def as Record<string, unknown>;
  }
  return result;
}

/** Build the OpenAPI 3.1 spec document in memory. */
export function buildTaskStoreSpec(): Record<string, unknown> {
  const tasksApp = createTasksRoutes(stubTaskService);
  const tokensApp = createTokensRoutes(stubTokenService);
  const prsApp = createPrsRoutes(stubPrService);

  const innerDocInfo = {
    openapi: "3.1.0" as const,
    info: { title: "internal", version: "0.1.0" },
  } as const;

  const tasksSpec = tasksApp.getOpenAPI31Document(innerDocInfo);
  const tokensSpec = tokensApp.getOpenAPI31Document(innerDocInfo);
  const prsSpec = prsApp.getOpenAPI31Document(innerDocInfo);

  const mergedPaths: Record<string, Record<string, unknown>> = {
    ...prefixPaths(
      (tasksSpec.paths ?? {}) as Record<string, Record<string, unknown>>,
      "/tasks",
    ),
    ...prefixPaths(
      (tokensSpec.paths ?? {}) as Record<string, Record<string, unknown>>,
      "/tokens",
    ),
    ...prefixPaths(
      (prsSpec.paths ?? {}) as Record<string, Record<string, unknown>>,
      "/prs",
    ),
  };

  return {
    openapi: "3.1.0",
    info: {
      title: "Shipwright Task Store API",
      version: "0.1.0",
      description:
        "REST API for the Shipwright task-store service — task queue management, PR tracking, and scoped token administration.",
    },
    servers: [{ url: "http://localhost:3002", description: "Local dev" }],
    paths: mergedPaths,
    components: {
      schemas: {
        ...(tasksSpec.components?.schemas ?? {}),
        ...(tokensSpec.components?.schemas ?? {}),
        ...(prsSpec.components?.schemas ?? {}),
      },
    },
  };
}

/** Write the spec to task-store/openapi.json. */
export function generateTaskStoreSpec(outPath?: string): void {
  const spec = buildTaskStoreSpec();
  const resolvedOutPath =
    outPath ?? resolve(import.meta.dir, "../openapi.json");
  writeFileSync(resolvedOutPath, `${JSON.stringify(spec, null, 2)}\n`);
  console.log(`Written to ${resolvedOutPath}`);
}
