/**
 * admin/src/platform-row-mocks.fixtures.ts
 * Row factories for the platform Prisma models the admin smoke tests mock.
 *
 * Prisma row types make every column a required key, even ones with a DB
 * default, so an inline row literal breaks typecheck whenever @app-vitals/agent-admin
 * adds a column. Each factory spreads the columns this repo cares about plus
 * caller overrides, then casts to the platform row type: new platform columns
 * don't force a lockstep change here, and the code under test still sees the
 * same fields and values.
 */

import type {
  AgentCronJob,
  AgentPlugin,
  AgentTool,
} from "@app-vitals/agent-admin/prisma/client/client.ts";

/** Overrides may name columns the pinned platform row type doesn't have yet. */
type RowOverrides<T> = Partial<T> & Record<string, unknown>;

export function agentCronJobRow(
  overrides: RowOverrides<AgentCronJob> = {},
): AgentCronJob {
  return {
    id: "c1",
    agentId: "a1",
    schedule: "",
    prompt: "",
    channel: null,
    user: null,
    silent: false,
    enabled: true,
    preCheck: null,
    name: null,
    system: false,
    parentCronId: null,
    lockdownDisabledAt: null,
    runRequestedAt: null,
    runRequestedBy: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as AgentCronJob;
}

export function agentToolRow(
  overrides: RowOverrides<AgentTool> = {},
): AgentTool {
  return {
    id: "t1",
    agentId: "a1",
    pattern: "Read",
    enabled: true,
    createdAt: new Date(),
    ...overrides,
  } as AgentTool;
}

export function agentPluginRow(
  overrides: RowOverrides<AgentPlugin> = {},
): AgentPlugin {
  return {
    id: "p1",
    agentId: "a1",
    name: "plugin",
    version: null,
    enabled: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as AgentPlugin;
}
