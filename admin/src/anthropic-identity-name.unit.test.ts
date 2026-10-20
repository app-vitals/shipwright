/**
 * admin/src/anthropic-identity-name.unit.test.ts
 * Unit tests for the pure Anthropic identity name functions and the
 * allocator logic (PAI-1.3) against an injected prisma test double.
 */

import { describe, expect, it } from "bun:test";
import {
  AnthropicIdentityNameAllocator,
  identityBaseName,
  identityName,
  MAX_IDENTITY_NAME_LENGTH,
} from "./anthropic-identity-name.ts";
import { BadRequestError, ConflictError, NotFoundError } from "./errors.ts";

const VALID = /^[a-z0-9-]+$/;

describe("identityBaseName", () => {
  it("maps dots to dashes", () => {
    expect(identityBaseName("jane.doe@example.com")).toBe("jane-doe");
  });

  it("drops a +tag", () => {
    expect(identityBaseName("jane.doe+agents@example.com")).toBe("jane-doe");
  });

  it("lowercases", () => {
    expect(identityBaseName("Jane.DOE@Example.COM")).toBe("jane-doe");
  });

  it("replaces invalid chars, collapses and trims dashes", () => {
    expect(identityBaseName("_a..b__c_@x.io")).toBe("a-b-c");
  });

  it("uses the part before the last @", () => {
    expect(identityBaseName('"a@b"@x.io')).toBe("a-b");
  });

  it("truncates a very long local part so the final name fits", () => {
    const email = `${"a".repeat(400)}@x.io`;
    const base = identityBaseName(email);
    expect(base.length).toBeLessThan(MAX_IDENTITY_NAME_LENGTH);
    const name = identityName(base, 9_999_999_999);
    expect(name.length).toBeLessThanOrEqual(MAX_IDENTITY_NAME_LENGTH);
    expect(name).toMatch(VALID);
  });

  it("truncation leaves room for the suffix and re-trims dashes", () => {
    const email = `${"a".repeat(300)}.${"b".repeat(300)}@x.io`;
    const suffix = "s".repeat(30);
    const base = identityBaseName(email, suffix);
    expect(base.endsWith("-")).toBe(false);
    const name = identityName(base, 9_999_999_999, suffix);
    expect(name.length).toBeLessThanOrEqual(MAX_IDENTITY_NAME_LENGTH);
    expect(name.endsWith(`-a9999999999-${suffix}`)).toBe(true);
  });

  it("re-trims a dash exposed by truncation", () => {
    const email = `${"a".repeat(230)}.bbb@x.io`;
    for (let i = 0; i < 40; i++) {
      const base = identityBaseName(`${"a".repeat(i)}.${email}`);
      expect(base.endsWith("-")).toBe(false);
    }
  });

  it.each([
    "",
    "nope",
    "@example.com",
    "jane@",
    "+tag@example.com",
    "...@example.com",
    "___@example.com",
  ])("rejects malformed or empty-result email %p", (email) => {
    expect(() => identityBaseName(email)).toThrow(BadRequestError);
  });

  it("rejects an invalid suffix", () => {
    expect(() => identityBaseName("a@x.io", "Bad_Suffix")).toThrow(
      BadRequestError,
    );
  });

  it("rejects a suffix too long to leave room for a base", () => {
    expect(() => identityBaseName("a@x.io", "s".repeat(300))).toThrow(
      BadRequestError,
    );
  });
});

describe("identityName", () => {
  it("builds base-a{n}", () => {
    expect(identityName("jane-doe", 3)).toBe("jane-doe-a3");
  });

  it("appends the suffix", () => {
    expect(identityName("jane-doe", 1, "prod")).toBe("jane-doe-a1-prod");
  });

  it("treats an empty suffix as none", () => {
    expect(identityName("jane", 2, "")).toBe("jane-a2");
  });

  it.each([0, -1, 1.5, Number.NaN, 1e10])("rejects n=%p", (n) => {
    expect(() => identityName("jane", n)).toThrow(BadRequestError);
  });

  it("rejects an invalid suffix", () => {
    expect(() => identityName("jane", 1, "UP")).toThrow(BadRequestError);
  });

  it("rejects an invalid base", () => {
    expect(() => identityName("Jane!", 1)).toThrow(BadRequestError);
  });

  it("rejects a name over the length limit", () => {
    expect(() => identityName("a".repeat(255), 1)).toThrow(BadRequestError);
  });
});

type Row = { id: string; anthropicIdentityName: string | null };

/** Minimal in-memory prisma double; update enforces the unique index. */
function makeFakePrisma(
  rows: Row[],
  opts: { conflictsBeforeSuccess?: number } = {},
) {
  let conflicts = opts.conflictsBeforeSuccess ?? 0;
  const calls = { findMany: 0, update: 0 };
  const agent = {
    async findUnique({ where }: { where: { id: string } }) {
      return rows.find((r) => r.id === where.id) ?? null;
    },
    async findMany({
      where,
    }: {
      where: { anthropicIdentityName: { startsWith: string } };
    }) {
      calls.findMany++;
      const prefix = where.anthropicIdentityName.startsWith;
      return rows
        .filter((r) => r.anthropicIdentityName?.startsWith(prefix))
        .map((r) => ({ anthropicIdentityName: r.anthropicIdentityName }));
    },
    async updateMany({
      where,
      data,
    }: {
      where: { id: string; anthropicIdentityName: null };
      data: { anthropicIdentityName: string };
    }) {
      calls.update++;
      if (conflicts > 0) {
        conflicts--;
        // Simulate a concurrent writer grabbing the name we computed.
        rows.push({ id: `other${calls.update}`, ...data });
        throw { code: "P2002" };
      }
      if (
        rows.some((r) => r.anthropicIdentityName === data.anthropicIdentityName)
      )
        throw { code: "P2002" };
      const row = rows.find(
        (r) => r.id === where.id && r.anthropicIdentityName === null,
      );
      if (!row) return { count: 0 };
      row.anthropicIdentityName = data.anthropicIdentityName;
      return { count: 1 };
    },
  };
  // biome-ignore lint/suspicious/noExplicitAny: minimal prisma double
  return { prisma: { agent } as any, calls, rows };
}

describe("AnthropicIdentityNameAllocator", () => {
  const email = "jane.doe@example.com";

  it("starts at a1", async () => {
    const { prisma } = makeFakePrisma([
      { id: "x", anthropicIdentityName: null },
    ]);
    const name = await new AnthropicIdentityNameAllocator(prisma).allocate(
      "x",
      email,
    );
    expect(name).toBe("jane-doe-a1");
  });

  it("picks max+1, ignoring gaps", async () => {
    const { prisma } = makeFakePrisma([
      { id: "x", anthropicIdentityName: null },
      { id: "p", anthropicIdentityName: "jane-doe-a1" },
      { id: "q", anthropicIdentityName: "jane-doe-a7" },
    ]);
    expect(
      await new AnthropicIdentityNameAllocator(prisma).allocate("x", email),
    ).toBe("jane-doe-a8");
  });

  it("does not count other owners sharing a prefix", async () => {
    const { prisma } = makeFakePrisma([
      { id: "x", anthropicIdentityName: null },
      { id: "p", anthropicIdentityName: "jane-doe-a3" },
      { id: "q", anthropicIdentityName: "jane-doe-a3-prod" },
      { id: "r", anthropicIdentityName: "jane-doe-alpha" },
    ]);
    expect(
      await new AnthropicIdentityNameAllocator(prisma).allocate(
        "x",
        "jane@example.com",
      ),
    ).toBe("jane-a1");
    const second = makeFakePrisma([
      { id: "x", anthropicIdentityName: null },
      { id: "p", anthropicIdentityName: "jane-doe-a3-prod" },
      { id: "q", anthropicIdentityName: "jane-doe-a9" },
    ]);
    expect(
      await new AnthropicIdentityNameAllocator(second.prisma).allocate(
        "x",
        email,
      ),
    ).toBe("jane-doe-a10");
  });

  it("applies the suffix and only counts same-suffix names", async () => {
    const { prisma } = makeFakePrisma([
      { id: "x", anthropicIdentityName: null },
      { id: "p", anthropicIdentityName: "jane-doe-a5" },
      { id: "q", anthropicIdentityName: "jane-doe-a2-prod" },
      { id: "r", anthropicIdentityName: "jane-doe-a4-dev" },
    ]);
    expect(
      await new AnthropicIdentityNameAllocator(prisma, {
        suffix: "prod",
      }).allocate("x", email),
    ).toBe("jane-doe-a3-prod");
  });

  it("persists the name on the agent row", async () => {
    const f = makeFakePrisma([{ id: "x", anthropicIdentityName: null }]);
    await new AnthropicIdentityNameAllocator(f.prisma).allocate("x", email);
    expect(f.rows[0]?.anthropicIdentityName).toBe("jane-doe-a1");
  });

  it("is idempotent: returns an existing name unchanged", async () => {
    const f = makeFakePrisma([{ id: "x", anthropicIdentityName: "custom-a1" }]);
    const name = await new AnthropicIdentityNameAllocator(f.prisma).allocate(
      "x",
      email,
    );
    expect(name).toBe("custom-a1");
    expect(f.calls.update).toBe(0);
  });

  it("throws NotFoundError for an unknown agent", async () => {
    const { prisma } = makeFakePrisma([]);
    await expect(
      new AnthropicIdentityNameAllocator(prisma).allocate("nope", email),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("rejects a malformed email before touching the db", async () => {
    const f = makeFakePrisma([{ id: "x", anthropicIdentityName: null }]);
    await expect(
      new AnthropicIdentityNameAllocator(f.prisma).allocate("x", "bad"),
    ).rejects.toBeInstanceOf(BadRequestError);
    expect(f.calls.findMany).toBe(0);
  });

  it("rejects an invalid suffix at construction", () => {
    const { prisma } = makeFakePrisma([]);
    expect(
      () => new AnthropicIdentityNameAllocator(prisma, { suffix: "No!" }),
    ).toThrow(BadRequestError);
  });

  it("retries with a fresh scan after a unique conflict", async () => {
    const f = makeFakePrisma([{ id: "x", anthropicIdentityName: null }], {
      conflictsBeforeSuccess: 2,
    });
    const name = await new AnthropicIdentityNameAllocator(f.prisma).allocate(
      "x",
      email,
    );
    expect(name).toBe("jane-doe-a3");
    expect(f.calls.findMany).toBe(3);
  });

  it("throws ConflictError once retries are exhausted", async () => {
    const f = makeFakePrisma([{ id: "x", anthropicIdentityName: null }], {
      conflictsBeforeSuccess: 100,
    });
    await expect(
      new AnthropicIdentityNameAllocator(f.prisma).allocate("x", email),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("throws NotFoundError if the agent is deleted mid-allocation", async () => {
    const f = makeFakePrisma([{ id: "x", anthropicIdentityName: null }]);
    const findUnique = f.prisma.agent.findUnique;
    f.prisma.agent.findUnique = async (args: { where: { id: string } }) => {
      const row = await findUnique(args);
      f.rows.splice(0, f.rows.length);
      return row;
    };
    await expect(
      new AnthropicIdentityNameAllocator(f.prisma).allocate("x", email),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("keeps a name written concurrently for the same agent", async () => {
    const f = makeFakePrisma([{ id: "x", anthropicIdentityName: null }]);
    const findUnique = f.prisma.agent.findUnique;
    let first = true;
    f.prisma.agent.findUnique = async (args: { where: { id: string } }) => {
      const row = await findUnique(args);
      const snapshot = row && { ...row };
      if (first && f.rows[0]) {
        // Another allocate for this agent wins the race after our read.
        f.rows[0].anthropicIdentityName = "jane-doe-a1";
        first = false;
      }
      return snapshot;
    };
    const name = await new AnthropicIdentityNameAllocator(f.prisma).allocate(
      "x",
      email,
    );
    expect(name).toBe("jane-doe-a1");
    expect(f.rows[0]?.anthropicIdentityName).toBe("jane-doe-a1");
  });

  it("rethrows unexpected db errors", async () => {
    const { prisma } = makeFakePrisma([
      { id: "x", anthropicIdentityName: null },
    ]);
    prisma.agent.updateMany = async () => {
      throw new Error("boom");
    };
    await expect(
      new AnthropicIdentityNameAllocator(prisma).allocate("x", email),
    ).rejects.toThrow("boom");
  });
});
