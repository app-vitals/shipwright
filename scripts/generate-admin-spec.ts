/**
 * scripts/generate-admin-spec.ts
 * Generate the OpenAPI 3.1 spec for the Shipwright admin service.
 *
 * Instantiates both the admin CRUD app and the agent runtime app in-process
 * using minimal stubs (no real DB, no real services), then:
 *   1. Calls getOpenAPI31Document() on each sub-app independently.
 *   2. Rewrites the runtime app's Hono-style path params (`:id`) to OpenAPI
 *      style (`{id}`) and prefixes them with `/agents`.
 *   3. Merges both specs' paths and component schemas into a single document.
 *   4. Writes the result to admin/openapi.json.
 *
 * Usage:
 *   bun run generate:admin-spec
 */

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { NoopAgentProvisioner } from "../admin/src/agent-provisioner.ts";
import { createAdminApp, parseAdminApiKeys } from "../admin/src/agents-api.ts";
import { createAgentRuntimeApp } from "../admin/src/api.ts";

// ─── Stub deps — only route definitions matter for spec generation ────────────

const SESSION_SECRET = "dummy-secret-32chars-for-spec-gen";
const adminApiKeys = parseAdminApiKeys("codegen:codegen-key:*");

const runtimeApp = createAgentRuntimeApp({
  agentEnvService: {
    async getConfigBundle() {
      return null;
    },
  },
  agentCronJobService: {
    async list() {
      return [];
    },
  },
  prisma: {
    agent: {
      async findUnique() {
        return null;
      },
    },
    agentPlugin: {
      async findMany() {
        return [];
      },
    },
  } as never,
  adminApiKeys,
  agentTokenService: { validate: async () => null },
  sessionSecret: SESSION_SECRET,
});

const adminApp = createAdminApp({
  agentEnvService: {
    upsert: async () => {},
    patch: async () => {},
    getByAgentId: async () => ({}),
    deleteKey: async () => {},
  },
  agentCronJobService: {
    list: async () => [],
    create: async () => ({}) as never,
    update: async () => ({}) as never,
    delete: async () => {},
    get: async () => ({}) as never,
    setEnabled: async () => ({}) as never,
    updatePreCheck: async () => ({}) as never,
    reconcileSystemCrons: async () => ({ created: 0, updated: 0, deleted: 0 }),
  },
  agentToolService: {
    list: async () => [],
    add: async () => ({}) as never,
    remove: async () => {},
    toggle: async () => ({}) as never,
  },
  agentTokenService: {
    create: async () => ({}) as never,
    listForAgent: async () => [],
    revoke: async () => ({}) as never,
    validate: async () => null,
  },
  agentPluginService: {
    list: async () => [],
    add: async () => ({}) as never,
    remove: async () => {},
    removeByName: async () => {},
  },
  prisma: {
    agent: {
      create: async () => ({}) as never,
      findUnique: async () => null,
      findMany: async () => [],
      delete: async () => ({}) as never,
    },
  } as never,
  provisioner: new NoopAgentProvisioner(),
  sessionSecret: SESSION_SECRET,
  adminApiKeys,
});

// ─── Generate specs ───────────────────────────────────────────────────────────

const docInfo = {
  openapi: "3.1.0" as const,
  info: {
    title: "Shipwright Admin API",
    version: "0.1.0",
    description:
      "REST API for the Shipwright admin service — CRUD for agents, env vars, cron jobs, tokens, tools, and plugins, plus the agent runtime polling endpoints.",
  },
  servers: [{ url: "http://localhost:3457", description: "Local dev" }],
} as const;

// Admin app spec (uses OpenAPI {id} path notation)
const adminSpec = adminApp.getOpenAPI31Document(docInfo);

// Runtime app spec (uses Hono :id notation — paths are relative to sub-app root)
const runtimeSpec = runtimeApp.getOpenAPI31Document({
  openapi: "3.1.0",
  info: { title: "runtime (internal)", version: "0.1.0" },
});

// ─── Merge specs ─────────────────────────────────────────────────────────────
//
// The runtime app's routes are defined as `/:id/config` and `/:id/crons`.
// When the spec is generated standalone, these appear as `/:id/config` etc.
// We rewrite Hono colon params to OpenAPI curly brace params, then prefix
// with `/agents` to match the root-mounted path.

// Build runtime paths with OpenAPI notation and /agents prefix.
// Merge at the method level so paths shared between admin and runtime
// (e.g. /agents/{id}/crons has both POST from admin and GET from runtime)
// keep all their HTTP methods.
const adminPaths = (adminSpec.paths ?? {}) as Record<
  string,
  Record<string, unknown>
>;
const mergedPaths: Record<string, Record<string, unknown>> = {
  ...adminPaths,
};

for (const [path, def] of Object.entries(runtimeSpec.paths ?? {})) {
  const openApiPath = `/agents${path.replace(/:(\w+)/g, "{$1}")}`;
  if (mergedPaths[openApiPath]) {
    // Merge methods — runtime GET on /agents/{id}/crons must coexist with
    // admin POST on the same path.
    mergedPaths[openApiPath] = {
      ...mergedPaths[openApiPath],
      ...(def as Record<string, unknown>),
    };
  } else {
    mergedPaths[openApiPath] = def as Record<string, unknown>;
  }
}

const mergedSpec = {
  ...adminSpec,
  paths: mergedPaths,
  components: {
    ...(adminSpec.components ?? {}),
    schemas: {
      ...(adminSpec.components?.schemas ?? {}),
      ...(runtimeSpec.components?.schemas ?? {}),
    },
  },
};

// ─── Write output ─────────────────────────────────────────────────────────────

const outPath = resolve(import.meta.dir, "../admin/openapi.json");
writeFileSync(outPath, `${JSON.stringify(mergedSpec, null, 2)}\n`);
console.log(`Written to ${outPath}`);
