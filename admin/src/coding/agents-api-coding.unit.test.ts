/**
 * admin/src/coding/agents-api-coding.unit.test.ts
 * Unit tests for the coding admin API's OpenAPI contribution
 * (codingAdminOpenApi): documented operations and placements that resolve.
 */

import { describe, expect, test } from "bun:test";
import { codingAdminOpenApi } from "./agents-api-coding.ts";

describe("codingAdminOpenApi", () => {
  const contribution = codingAdminOpenApi();

  // The coding routes' share of openapi-schemas.unit.test.ts's "every admin +
  // runtime route has a non-empty summary and description" check.
  test("every coding route has a non-empty summary and description", () => {
    const issues: string[] = [];
    let operations = 0;
    for (const [path, methods] of Object.entries(contribution.paths ?? {})) {
      for (const [method, operation] of Object.entries(methods)) {
        operations++;
        const op = operation as { summary?: unknown; description?: unknown };
        const summary = typeof op.summary === "string" ? op.summary.trim() : "";
        const description =
          typeof op.description === "string" ? op.description.trim() : "";
        if (!summary || !description) {
          issues.push(`${method.toUpperCase()} ${path}`);
        }
      }
    }
    expect(operations).toBe(7);
    expect(issues).toEqual([]);
  });

  test("places every contributed path and coding schema", () => {
    const placedPaths = Object.keys(contribution.placeAfter?.paths ?? {});
    expect(placedPaths.sort()).toEqual(
      Object.keys(contribution.paths ?? {}).sort(),
    );
    // Every placed schema is one the contribution actually carries.
    for (const name of Object.keys(contribution.placeAfter?.schemas ?? {})) {
      expect(contribution.schemas).toHaveProperty(name);
    }
  });
});
