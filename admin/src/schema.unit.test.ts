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

  describe("AgentCronRun model", () => {
    test("model AgentCronRun exists in schema", () => {
      expect(schema).toContain("model AgentCronRun");
    });

    test("id field is String @id @default(cuid())", () => {
      expect(schema).toMatch(
        /model AgentCronRun \{[\s\S]*?id\s+String\s+@id\s+@default\(cuid\(\)\)/,
      );
    });

    test("cronId field with @relation to AgentCronJob and onDelete: Cascade", () => {
      expect(schema).toMatch(/model AgentCronRun \{[\s\S]*?cronId\s+String/);
      expect(schema).toMatch(
        /model AgentCronRun \{[\s\S]*?@relation\(fields: \[cronId\], references: \[id\], onDelete: Cascade\)/,
      );
    });

    test("agentId field is String (denormalized)", () => {
      expect(schema).toMatch(/model AgentCronRun \{[\s\S]*?agentId\s+String/);
    });

    test("startedAt field is DateTime", () => {
      expect(schema).toMatch(
        /model AgentCronRun \{[\s\S]*?startedAt\s+DateTime/,
      );
    });

    test("completedAt field is DateTime? (nullable)", () => {
      expect(schema).toMatch(
        /model AgentCronRun \{[\s\S]*?completedAt\s+DateTime\?/,
      );
    });

    test("skipped field is Boolean @default(false)", () => {
      expect(schema).toMatch(
        /model AgentCronRun \{[\s\S]*?skipped\s+Boolean\s+@default\(false\)/,
      );
    });

    test("skipReason field is String? (nullable)", () => {
      expect(schema).toMatch(
        /model AgentCronRun \{[\s\S]*?skipReason\s+String\?/,
      );
    });

    test("outcome field is String? (nullable)", () => {
      expect(schema).toMatch(/model AgentCronRun \{[\s\S]*?outcome\s+String\?/);
    });

    test("error field is String? (nullable)", () => {
      expect(schema).toMatch(/model AgentCronRun \{[\s\S]*?error\s+String\?/);
    });

    test("createdAt field is DateTime @default(now())", () => {
      expect(schema).toMatch(
        /model AgentCronRun \{[\s\S]*?createdAt\s+DateTime\s+@default\(now\(\)\)/,
      );
    });

    test("@@index([cronId]) present", () => {
      expect(schema).toMatch(
        /model AgentCronRun \{[\s\S]*?@@index\(\[cronId\]\)/,
      );
    });

    test("@@index([agentId, startedAt]) present", () => {
      expect(schema).toMatch(
        /model AgentCronRun \{[\s\S]*?@@index\(\[agentId, startedAt\]\)/,
      );
    });
  });

  describe("AgentCronJob back-relation", () => {
    test("AgentCronJob has runs AgentCronRun[] back-relation", () => {
      expect(schema).toMatch(
        /model AgentCronJob \{[\s\S]*?runs\s+AgentCronRun\[\]/,
      );
    });
  });
});
