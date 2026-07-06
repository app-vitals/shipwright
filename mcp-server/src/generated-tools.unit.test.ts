import { describe, expect, it } from "bun:test";
import { generatedTools } from "./generated-tools.ts";

describe("generatedTools", () => {
  it("emits one tool per OpenAPI operation (25 total)", () => {
    expect(generatedTools).toHaveLength(25);
  });

  it("has unique tool names", () => {
    const names = generatedTools.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("names every tool in snake_case", () => {
    for (const tool of generatedTools) {
      expect(tool.name).toMatch(/^[a-z]+(_[a-z]+)*$/);
    }
  });

  it("derives tasks_list with the correct description and query params", () => {
    const tool = generatedTools.find((t) => t.name === "tasks_list");
    expect(tool).toBeDefined();
    expect(tool?.description).toBe("List tasks");
    expect(tool?.method).toBe("GET");
    expect(tool?.pathTemplate).toBe("/tasks");
    expect(tool?.hasBody).toBe(false);
    // Query params are surfaced in the input schema but not required.
    expect(tool?.inputSchema.properties).toHaveProperty("status");
    expect(tool?.inputSchema.properties).toHaveProperty("state");
    expect(tool?.inputSchema.required).toHaveLength(0);
    expect(tool?.queryParams).toContain("status");
  });

  it("marks the id path param as required on tasks_claim", () => {
    const tool = generatedTools.find((t) => t.name === "tasks_claim");
    expect(tool).toBeDefined();
    expect(tool?.method).toBe("POST");
    expect(tool?.pathTemplate).toBe("/tasks/{id}/claim");
    expect(tool?.pathParams).toEqual(["id"]);
    expect(tool?.inputSchema.properties).toHaveProperty("id");
    expect(tool?.inputSchema.required).toContain("id");
    // requestBody (ClaimBody) is optional so its fields are surfaced but not required.
    expect(tool?.hasBody).toBe(true);
    expect(tool?.inputSchema.properties).toHaveProperty("claimedBy");
    expect(tool?.inputSchema.required).not.toContain("claimedBy");
  });

  it("inlines a required requestBody's required fields (prs_claim)", () => {
    const tool = generatedTools.find((t) => t.name === "prs_claim");
    expect(tool).toBeDefined();
    expect(tool?.method).toBe("POST");
    expect(tool?.hasBody).toBe(true);
    // ClaimPrBody requires repo, prNumber, commitSha.
    expect(tool?.inputSchema.properties).toHaveProperty("repo");
    expect(tool?.inputSchema.required).toEqual(
      expect.arrayContaining(["repo", "prNumber", "commitSha"]),
    );
  });

  it("derives create/get/update/delete verbs for the tasks resource", () => {
    const names = generatedTools.map((t) => t.name);
    expect(names).toContain("tasks_create");
    expect(names).toContain("tasks_get");
    expect(names).toContain("tasks_update");
    expect(names).toContain("tasks_delete");
  });

  it("gives every tool a valid object input schema", () => {
    for (const tool of generatedTools) {
      expect(tool.inputSchema.type).toBe("object");
      expect(typeof tool.inputSchema.properties).toBe("object");
      expect(Array.isArray(tool.inputSchema.required)).toBe(true);
      expect(typeof tool.description).toBe("string");
      expect(tool.description.length).toBeGreaterThan(0);
    }
  });
});
