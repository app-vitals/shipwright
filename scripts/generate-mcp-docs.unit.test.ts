/**
 * scripts/generate-mcp-docs.unit.test.ts
 *
 * Unit tests for the pure rendering logic in generate-mcp-docs.ts.
 * No I/O — all inputs are inline GeneratedTool fixtures.
 */

import { describe, expect, test } from "bun:test";
import type { GeneratedTool } from "../mcp-server/src/generated-tools.ts";
import { renderMcpToolsDoc } from "./generate-mcp-docs.ts";

function tool(overrides: Partial<GeneratedTool>): GeneratedTool {
  return {
    name: "tasks_list",
    description: "List tasks",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    },
    method: "GET",
    pathTemplate: "/tasks",
    queryParams: [],
    pathParams: [],
    hasBody: false,
    ...overrides,
  };
}

describe("renderMcpToolsDoc", () => {
  test("includes a GENERATED FILE header comment", () => {
    const doc = renderMcpToolsDoc([tool({})]);
    expect(doc).toMatch(/GENERATED FILE/);
  });

  test("renders every tool's name and description", () => {
    const tools = [
      tool({ name: "tasks_list", description: "List tasks" }),
      tool({
        name: "prs_get",
        description: "Get a pull request",
        method: "GET",
        pathTemplate: "/prs/{id}",
      }),
    ];
    const doc = renderMcpToolsDoc(tools);
    expect(doc).toContain("tasks_list");
    expect(doc).toContain("List tasks");
    expect(doc).toContain("prs_get");
    expect(doc).toContain("Get a pull request");
  });

  test("renders the HTTP method and path template for each tool", () => {
    const tools = [
      tool({
        name: "tasks_claim",
        method: "POST",
        pathTemplate: "/tasks/{id}/claim",
      }),
    ];
    const doc = renderMcpToolsDoc(tools);
    expect(doc).toContain("POST");
    expect(doc).toContain("/tasks/{id}/claim");
  });

  test("renders query and path parameters", () => {
    const tools = [
      tool({
        name: "tasks_list",
        queryParams: ["status", "state"],
        pathParams: [],
      }),
      tool({
        name: "tasks_get",
        method: "GET",
        pathTemplate: "/tasks/{id}",
        pathParams: ["id"],
      }),
    ];
    const doc = renderMcpToolsDoc(tools);
    expect(doc).toContain("status");
    expect(doc).toContain("state");
    expect(doc).toContain("id");
  });

  test("indicates whether a tool has a request body", () => {
    const tools = [
      tool({ name: "tasks_list", hasBody: false }),
      tool({
        name: "tasks_create",
        method: "POST",
        pathTemplate: "/tasks",
        hasBody: true,
      }),
    ];
    const doc = renderMcpToolsDoc(tools);
    // Body presence must be distinguishable per-tool in the rendered doc.
    expect(doc).toMatch(/tasks_create[\s\S]*Yes/);
    expect(doc).toMatch(/tasks_list[\s\S]*No/);
  });

  test("indicates array-bodied tools distinctly (hasArrayBody)", () => {
    const tools = [
      tool({
        name: "tasks_bulk",
        method: "POST",
        pathTemplate: "/tasks/bulk",
        hasBody: true,
        hasArrayBody: true,
      }),
    ];
    const doc = renderMcpToolsDoc(tools);
    expect(doc).toMatch(/tasks_bulk[\s\S]*array/i);
  });

  test("renders tools sorted alphabetically by name regardless of input order", () => {
    const tools = [
      tool({
        name: "tasks_update",
        method: "PATCH",
        pathTemplate: "/tasks/{id}",
      }),
      tool({ name: "prs_get", method: "GET", pathTemplate: "/prs/{id}" }),
      tool({ name: "tasks_list" }),
    ];
    const doc = renderMcpToolsDoc(tools);
    const iPrsGet = doc.indexOf("prs_get");
    const iTasksList = doc.indexOf("tasks_list");
    const iTasksUpdate = doc.indexOf("tasks_update");
    expect(iPrsGet).toBeGreaterThan(-1);
    expect(iTasksList).toBeGreaterThan(-1);
    expect(iTasksUpdate).toBeGreaterThan(-1);
    expect(iPrsGet).toBeLessThan(iTasksList);
    expect(iTasksList).toBeLessThan(iTasksUpdate);
  });

  test("handles an empty tool list without throwing", () => {
    expect(() => renderMcpToolsDoc([])).not.toThrow();
    const doc = renderMcpToolsDoc([]);
    expect(doc).toMatch(/GENERATED FILE/);
  });

  test("never renders any excluded/pipeline-internal tool names", () => {
    // Simulates the allowlist already having filtered the input — the
    // renderer itself must not reintroduce or reference excluded tools.
    const tools = [
      tool({ name: "tasks_list" }),
      tool({ name: "tasks_create", method: "POST", hasBody: true }),
    ];
    const doc = renderMcpToolsDoc(tools);
    for (const excluded of [
      "tasks_claim",
      "tasks_heartbeat",
      "tasks_delete",
      "tokens_list",
    ]) {
      expect(doc).not.toContain(excluded);
    }
  });

  test("does not include Helm or deployment content", () => {
    const doc = renderMcpToolsDoc([tool({})]);
    expect(doc.toLowerCase()).not.toContain("helm");
    expect(doc.toLowerCase()).not.toContain("kubernetes");
    expect(doc.toLowerCase()).not.toContain("deployment");
  });
});
