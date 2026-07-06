import { describe, expect, it } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "./mcp-server.ts";

describe("MCP server tools/list", () => {
  it("lists the generated tools over a JSON-RPC connection", async () => {
    // Pass a stub config so configFromEnv() is not called in CI where
    // SHIPWRIGHT_TASK_STORE_URL / SHIPWRIGHT_TASK_STORE_TOKEN are unset.
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

    expect(tools.length).toBe(25);
    expect(names).toContain("tasks_list");
    expect(names).toContain("tasks_claim");
    expect(names).toContain("prs_claim");

    const tasksList = tools.find((t) => t.name === "tasks_list");
    expect(tasksList?.description).toBe("List tasks");
    expect(tasksList?.inputSchema.type).toBe("object");

    await client.close();
    await server.close();
  });
});
