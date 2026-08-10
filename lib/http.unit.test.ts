import { describe, expect, test } from "bun:test";
import { readJson } from "./http.ts";

describe("readJson — valid bodies", () => {
  test("returns the parsed object when the body is a plain object", async () => {
    const c = { req: { json: async () => ({ foo: "bar" }) } };
    expect(await readJson(c)).toEqual({ foo: "bar" });
  });

  test("returns an empty object when the body is an empty object", async () => {
    const c = { req: { json: async () => ({}) } };
    expect(await readJson(c)).toEqual({});
  });
});

describe("readJson — invalid bodies", () => {
  test("returns {} when the body is an array", async () => {
    const c = { req: { json: async () => [1, 2, 3] } };
    expect(await readJson(c)).toEqual({});
  });

  test("returns {} when the body is a string primitive", async () => {
    const c = { req: { json: async () => "not an object" } };
    expect(await readJson(c)).toEqual({});
  });

  test("returns {} when the body is null", async () => {
    const c = { req: { json: async () => null } };
    expect(await readJson(c)).toEqual({});
  });

  test("returns {} when req.json() throws", async () => {
    const c = {
      req: {
        json: async () => {
          throw new Error("invalid JSON");
        },
      },
    };
    expect(await readJson(c)).toEqual({});
  });
});
