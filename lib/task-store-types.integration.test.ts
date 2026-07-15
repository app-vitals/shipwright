import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("task-store-types", () => {
	it("should have generated the task-store-types.ts file", () => {
		const filePath = resolve(__dirname, "./task-store-types.ts");
		const content = readFileSync(filePath, "utf-8");
		expect(content).toBeDefined();
		expect(content.length).toBeGreaterThan(0);
	});

	it("should export the paths interface", () => {
		const filePath = resolve(__dirname, "./task-store-types.ts");
		const content = readFileSync(filePath, "utf-8");
		expect(content).toContain("export interface paths");
	});

	it("should include task endpoints from the OpenAPI spec", () => {
		const filePath = resolve(__dirname, "./task-store-types.ts");
		const content = readFileSync(filePath, "utf-8");
		expect(content).toContain('"/tasks"');
	});
});
