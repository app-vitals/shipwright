/**
 * agent/src/agent-plugins.unit.test.ts
 * Unit tests for AgentPluginService.listEnabled — pure logic over an injected
 * Prisma double, no real DB.
 */

import { describe, expect, it, mock } from "bun:test";
import type { PrismaClient } from "../prisma/client/index.js";
import { AgentPluginService } from "./agent-plugins.ts";

describe("AgentPluginService.listEnabled", () => {
  it("filters by enabled: true server-side", async () => {
    const findMany = mock(async () => []);
    const prisma = { agentPlugin: { findMany } } as unknown as PrismaClient;
    const service = new AgentPluginService(prisma);

    await service.listEnabled("agent-1");

    expect(findMany).toHaveBeenCalledWith({
      where: { agentId: "agent-1", enabled: true },
      orderBy: { createdAt: "asc" },
    });
  });

  it("returns only the enabled plugins the query resolves", async () => {
    const enabledPlugin = {
      id: "p1",
      agentId: "agent-1",
      name: "shipwright@shipwright",
      version: null,
      enabled: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const findMany = mock(async () => [enabledPlugin]);
    const prisma = { agentPlugin: { findMany } } as unknown as PrismaClient;
    const service = new AgentPluginService(prisma);

    const result = await service.listEnabled("agent-1");

    expect(result).toEqual([enabledPlugin]);
  });
});
