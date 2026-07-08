import { describe, it, expect } from "bun:test";
import { app } from "./index.js";
import { EXCLUDED_TOOLS } from "./tool-allowlist.js";

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

describe("mcp-server", () => {
  it("exports an app", () => {
    expect(app).toBeDefined();
    expect(typeof app).toBe("object");
  });

  it("responds to a health check", async () => {
    const res = await app.request("/health");
    expect(res.status).toBe(200);
  });

  it("GET /mcp/tools returns only the 9 allowed tools", async () => {
    const res = await app.request("/mcp/tools");
    expect(res.status).toBe(200);

    const body = (await res.json()) as { tools: Array<{ name: string; description: string }> };
    const toolNames = body.tools.map((t) => t.name);

    // Verify we have exactly 9 tools
    expect(toolNames).toHaveLength(9);

    // Verify all allowed tools are present
    for (const name of ALLOWED_TOOL_NAMES) {
      expect(toolNames).toContain(name);
    }

    // Verify no excluded tools are present
    for (const excluded of EXCLUDED_TOOLS) {
      expect(toolNames).not.toContain(excluded);
    }
  });
});
