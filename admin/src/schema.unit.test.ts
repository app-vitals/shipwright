import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

// Reads the schema file and asserts it uses the postgresql provider and DATABASE_URL env var.
// This test is intentionally narrow — it guards against accidental provider regression.

const schemaPath = join(import.meta.dir, "../prisma/schema.prisma");
const schema = readFileSync(schemaPath, "utf-8");

describe("admin/prisma/schema.prisma", () => {
  test('datasource provider is "postgresql"', () => {
    expect(schema).toContain('provider = "postgresql"');
  });

  test("datasource url uses DATABASE_URL env var", () => {
    expect(schema).toContain('url      = env("DATABASE_URL")');
  });
});
