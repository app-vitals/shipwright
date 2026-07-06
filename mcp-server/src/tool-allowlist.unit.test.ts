import { describe, expect, it } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { generatedTools } from "./generated-tools.ts";
import { createMcpServer } from "./mcp-server.ts";
import { EXCLUDED_TOOLS, allowedTools } from "./tool-allowlist.ts";

const ALLOWED_TOOL_NAMES = [
  "tasks_list",
  "tasks_create",
  "tasks_bulk",
  "tasks_distinct",
  "tasks_get",
  "tasks_update",
  "prs_list",
  "prs_get",
  "prs_update",
] as const;

describe("allowedTools", () => {
  it("returns only the 9 agreed tools", () => {
    const result = allowedTools(generatedTools);
    expect(result).toHaveLength(9);
  });

  it("excludes all EXCLUDED_TOOLS names", () => {
    const result = allowedTools(generatedTools);
    const resultNames = result.map((t) => t.name);
    for (const excluded of EXCLUDED_TOOLS) {
      expect(resultNames).not.toContain(excluded);
    }
  });

  it("stays stable across regeneration — given all 25 generatedTools, only 9 come back", () => {
    // This is the "across regeneration" invariant:
    // even if generate:mcp-tools emits all 25 ops, only the 9 allowed ones are exposed.
    expect(generatedTools).toHaveLength(25);
    const result = allowedTools(generatedTools);
    expect(result).toHaveLength(9);
    const resultNames = result.map((t) => t.name);
    for (const name of ALLOWED_TOOL_NAMES) {
      expect(resultNames).toContain(name);
    }
  });

  it("returns tools with the exact agreed names", () => {
    const result = allowedTools(generatedTools);
    const resultNames = result.map((t) => t.name).sort();
    expect(resultNames).toEqual([...ALLOWED_TOOL_NAMES].sort());
  });
});

describe("createMcpServer lists only allowed tools", () => {
  it("tools/list returns exactly 9 names and none are in EXCLUDED_TOOLS", async () => {
    const server = createMcpServer({
      config: { baseUrl: "http://localhost:3002", token: "test-token" },
    });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();

    const client = new Client({ name: "test-client", version: "0.0.0" });
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);

    expect(tools.length).toBe(9);
    for (const excluded of EXCLUDED_TOOLS) {
      expect(names).not.toContain(excluded);
    }

    await client.close();
    await server.close();
  });
});
