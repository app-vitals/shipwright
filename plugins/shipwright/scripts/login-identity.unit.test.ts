/**
 * plugins/shipwright/scripts/login-identity.unit.test.ts
 *
 * Unit tests for canonicalLogin() and getOwnCanonicalLogin().
 */

import { describe, expect, test } from "bun:test";
import { canonicalLogin, getOwnCanonicalLogin } from "./login-identity.ts";

describe("canonicalLogin", () => {
  test("maps the three observed bot forms to the same value", () => {
    expect(canonicalLogin("my-bot[bot]")).toBe("my-bot");
    expect(canonicalLogin("app/my-bot")).toBe("my-bot");
    expect(canonicalLogin("my-bot")).toBe("my-bot");
  });

  test("passes PAT logins through, lowercased", () => {
    expect(canonicalLogin("DaveDev")).toBe("davedev");
  });
});

describe("getOwnCanonicalLogin", () => {
  test("resolves via GraphQL viewer and canonicalizes", () => {
    const calls: string[][] = [];
    const login = getOwnCanonicalLogin((args) => {
      calls.push(args);
      return JSON.stringify({ data: { viewer: { login: "My-Bot[bot]" } } });
    });
    expect(login).toBe("my-bot");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("graphql");
    expect(calls.flat().join(" ")).not.toContain("/user");
  });

  test("throws when viewer has no login", () => {
    expect(() => getOwnCanonicalLogin(() => JSON.stringify({ data: {} }))).toThrow(
      "no login",
    );
  });
});
