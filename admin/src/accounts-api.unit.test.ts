/**
 * admin/src/accounts-api.unit.test.ts
 * Parse/reject tests for the /accounts OpenAPI schemas (SSP-5.1).
 */

import { describe, expect, test } from "bun:test";
import {
  AccountResponseSchema,
  CreateAccountBodySchema,
  PatchAccountBodySchema,
} from "./openapi-schemas.ts";

describe("CreateAccountBodySchema", () => {
  test("accepts the minimal body", () => {
    const r = CreateAccountBodySchema.safeParse({
      name: "Acme",
      ownerEmail: "Owner@Acme.com",
      maxAgents: 3,
    });
    expect(r.success).toBe(true);
  });

  test("accepts plan and trialExpiresAt", () => {
    const r = CreateAccountBodySchema.safeParse({
      name: "Acme",
      ownerEmail: "o@acme.com",
      maxAgents: 0,
      plan: "pro",
      trialExpiresAt: "2030-01-01T00:00:00.000Z",
    });
    expect(r.success).toBe(true);
  });

  test.each([
    ["empty name", { name: "", ownerEmail: "o@a.com", maxAgents: 1 }],
    ["bad email", { name: "A", ownerEmail: "nope", maxAgents: 1 }],
    ["negative maxAgents", { name: "A", ownerEmail: "o@a.com", maxAgents: -1 }],
    [
      "fractional maxAgents",
      { name: "A", ownerEmail: "o@a.com", maxAgents: 1.5 },
    ],
    ["missing maxAgents", { name: "A", ownerEmail: "o@a.com" }],
    [
      "bad trialExpiresAt",
      { name: "A", ownerEmail: "o@a.com", maxAgents: 1, trialExpiresAt: "x" },
    ],
  ])("rejects %s", (_label, body) => {
    expect(CreateAccountBodySchema.safeParse(body).success).toBe(false);
  });
});

describe("PatchAccountBodySchema", () => {
  test("accepts partial bodies and nullable plan/trial", () => {
    expect(PatchAccountBodySchema.safeParse({ maxAgents: 3 }).success).toBe(
      true,
    );
    expect(
      PatchAccountBodySchema.safeParse({ plan: null, trialExpiresAt: null })
        .success,
    ).toBe(true);
    expect(
      PatchAccountBodySchema.safeParse({ status: "suspended" }).success,
    ).toBe(true);
  });

  test("rejects unknown status and negative maxAgents", () => {
    expect(PatchAccountBodySchema.safeParse({ status: "bogus" }).success).toBe(
      false,
    );
    expect(PatchAccountBodySchema.safeParse({ maxAgents: -2 }).success).toBe(
      false,
    );
  });
});

describe("AccountResponseSchema", () => {
  test("parses a full account with counts", () => {
    const now = new Date().toISOString();
    const r = AccountResponseSchema.safeParse({
      id: "a1",
      name: "Acme",
      status: "active",
      maxAgents: 3,
      plan: null,
      trialExpiresAt: null,
      createdAt: now,
      updatedAt: now,
      agentCount: 1,
      memberCount: 2,
    });
    expect(r.success).toBe(true);
  });
});
