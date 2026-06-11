/**
 * admin/src/server.ts
 * Shipwright admin service — Hono entrypoint.
 *
 * Mounts:
 *   - Admin UI routes at /admin/* (server-rendered)
 *   - Admin CRUD API at /agents/:id/* (JSON)
 *   - Agent runtime API at /agents/* (JSON, internal)
 */

export { createAdminUIApp } from "./admin-ui.ts";
export type { AdminUIDeps } from "./admin-ui.ts";
export { createAdminApp } from "./agents-api.ts";
export type { AdminDeps } from "./agents-api.ts";
export { createAgentRuntimeApp } from "./api.ts";
export type {
  AgentRuntimeDeps,
  AgentConfigResponse,
  AgentPlugin,
  AdminApiPaths,
  RuntimeApiPaths,
} from "./api.ts";
export { AgentEnvService } from "./agent-envs.ts";
export type { AgentEnvBundle, AgentEnvEntry } from "./agent-envs.ts";
export { AgentCronJobService } from "./agent-cron-jobs.ts";
export type {
  AgentCronJob,
  CreateAgentCronJobInput,
} from "./agent-cron-jobs.ts";
export { AgentToolService } from "./agent-tools.ts";
export type { AgentTool } from "./agent-tools.ts";
export { AgentTokenService } from "./agent-tokens.ts";
export type { AgentToken, AgentTokenValidated } from "./agent-tokens.ts";
export { AgentPluginService } from "./agent-plugins.ts";
export type { AgentPlugin as AgentPluginRecord } from "./agent-plugins.ts";
export { makeTokenCrypto, identityCrypto } from "./token-crypto.ts";
export type { TokenCrypto } from "./token-crypto.ts";
export {
  ApiError,
  NotFoundError,
  ConflictError,
  BadRequestError,
  ForbiddenError,
  UnprocessableEntityError,
  BadGatewayError,
} from "./errors.ts";
export { HttpSlackProvisioningClient } from "./slack-provisioning-client.ts";
export type { SlackProvisioningClient } from "./slack-provisioning-client.ts";
export { HttpGoogleAuthClient } from "./google-auth-client.ts";
export type { GoogleAuthClient } from "./google-auth-client.ts";
export { PrismaClient } from "../prisma/client/index.js";
