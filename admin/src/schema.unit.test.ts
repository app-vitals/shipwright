import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Reads the schema file and asserts it uses the postgresql provider and the namespaced env var.
// This test is intentionally narrow — it guards against accidental provider regression.

const schemaPath = join(import.meta.dir, "../prisma/schema.prisma");
const schema = readFileSync(schemaPath, "utf-8");

describe("admin/prisma/schema.prisma", () => {
  test('datasource provider is "postgresql"', () => {
    expect(schema).toContain('provider = "postgresql"');
  });

  test("datasource url uses DATABASE_URL_SHIPWRIGHT_ADMIN env var", () => {
    expect(schema).toContain('url      = env("DATABASE_URL_SHIPWRIGHT_ADMIN")');
  });
});
