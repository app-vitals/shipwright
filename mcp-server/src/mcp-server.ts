/**
 * mcp-server.ts
 * Build an MCP server that exposes the task-store API as MCP tools.
 *
 * Tools are generated from task-store/openapi.json (see generated-tools.ts).
 * `tools/list` returns the generated definitions verbatim; `tools/call` proxies
 * to the task-store HTTP API with bearer auth resolved from the standard
 * SHIPWRIGHT_TASK_STORE_URL / SHIPWRIGHT_TASK_STORE_TOKEN env vars.
 *
 * The factory uses the low-level `Server` so JSON-Schema inputSchemas from the
 * OpenAPI spec pass through unchanged (no Zod round-trip). The returned server
 * is transport-agnostic — callers connect it to stdio, Streamable HTTP, or an
 * in-memory transport (used by the smoke test).
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  type CallToolResult,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { generatedTools } from "./generated-tools.ts";
import { allowedTools } from "./tool-allowlist.ts";
import {
  type ToolCallerConfig,
  callTool,
  configFromEnv,
} from "./tool-caller.ts";

export interface CreateMcpServerOptions {
  /** Override the tool-caller config (defaults to the task-store env vars). */
  config?: ToolCallerConfig;
}

export function createMcpServer(options: CreateMcpServerOptions = {}): Server {
  const config = options.config ?? configFromEnv();
  const tools = allowedTools(generatedTools);

  const server = new Server(
    { name: "shipwright-task-store", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    })),
  }));

  server.setRequestHandler(
    CallToolRequestSchema,
    async (request): Promise<CallToolResult> => {
      const tool = tools.find((t) => t.name === request.params.name);
      if (!tool) {
        return {
          content: [
            { type: "text", text: `Unknown tool: ${request.params.name}` },
          ],
          isError: true,
        };
      }
      const args = (request.params.arguments ?? {}) as Record<string, unknown>;
      // ToolResult is a structural subset of the SDK's passthrough result type
      // (which carries an open index signature); the cast bridges that gap.
      return (await callTool(tool, args, config)) as CallToolResult;
    },
  );

  return server;
}
