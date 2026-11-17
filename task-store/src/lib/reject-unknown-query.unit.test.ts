import { describe, expect, it } from "bun:test";
import { z } from "@hono/zod-openapi";
import { BadRequestError } from "../errors.ts";
import {
  allowedQueryParams,
  rejectUnknownQuery,
  unknownQueryParams,
} from "./reject-unknown-query.ts";

const schema = z.object({
  a: z.string().optional(),
  b: z.array(z.string()).optional(),
});

function ctx(queries: Record<string, string[]>) {
  return { req: { queries: () => queries } };
}

describe("allowedQueryParams", () => {
  it("lists the schema's keys", () => {
    expect(allowedQueryParams(schema)).toEqual(["a", "b"]);
  });
});

describe("unknownQueryParams", () => {
  it("returns only names outside the schema, deduplicated and sorted", () => {
    expect(
      unknownQueryParams(
        ctx({ a: ["1"], zed: ["1", "2"], bogus: ["x"] }).req.queries(),
        schema,
      ),
    ).toEqual(["bogus", "zed"]);
  });
});

describe("rejectUnknownQuery", () => {
  it("passes when every param is known", () => {
    expect(() =>
      rejectUnknownQuery(ctx({ a: ["1"], b: ["x", "y"] }), schema),
    ).not.toThrow();
  });

  it("passes with no params", () => {
    expect(() => rejectUnknownQuery(ctx({}), schema)).not.toThrow();
  });

  it("throws a BadRequestError naming each unknown param and the allowed ones", () => {
    let err: unknown;
    try {
      rejectUnknownQuery(ctx({ bogus: ["1"], a: ["1"] }), schema);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(BadRequestError);
    const msg = (err as BadRequestError).message;
    expect(msg).toContain("bogus");
    expect(msg).toContain("a, b");
  });
});
