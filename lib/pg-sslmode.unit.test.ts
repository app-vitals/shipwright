import { describe, expect, test } from "bun:test";
import { pinPgSslMode } from "./pg-sslmode.ts";

const BASE = "postgresql://user:pass@db.example.test:5432/app";

describe("pinPgSslMode — legacy aliases are pinned to verify-full", () => {
  for (const mode of ["prefer", "require", "verify-ca"]) {
    test(`rewrites sslmode=${mode} to sslmode=verify-full`, () => {
      const pinned = new URL(pinPgSslMode(`${BASE}?sslmode=${mode}`));
      expect(pinned.searchParams.get("sslmode")).toBe("verify-full");
    });
  }

  test("preserves credentials, host, database, and other params", () => {
    const pinned = new URL(
      pinPgSslMode(`${BASE}?connection_limit=5&sslmode=require&schema=public`),
    );
    expect(pinned.username).toBe("user");
    expect(pinned.password).toBe("pass");
    expect(pinned.host).toBe("db.example.test:5432");
    expect(pinned.pathname).toBe("/app");
    expect(pinned.searchParams.get("connection_limit")).toBe("5");
    expect(pinned.searchParams.get("schema")).toBe("public");
  });

  test("keeps a URL-encoded password byte-for-byte when rewriting", () => {
    const pinned = pinPgSslMode(
      "postgresql://user:p%40ss%2Fw@localhost:5432/app?sslmode=require",
    );
    expect(pinned).toBe(
      "postgresql://user:p%40ss%2Fw@localhost:5432/app?sslmode=verify-full",
    );
  });

  test("a duplicate sslmode resolves to the LAST occurrence, like pg-connection-string", () => {
    // pg-connection-string's parse() iterates every query param and lets
    // later entries overwrite earlier ones, so `pg` itself connects using
    // the second `sslmode` here ("require"), not the first ("verify-full").
    // Using URLSearchParams#get() (first-match) would wrongly see
    // "verify-full" and skip the rewrite, leaving the string's final
    // sslmode as the unrewritten legacy "require".
    const pinned = new URL(
      pinPgSslMode(`${BASE}?sslmode=verify-full&sslmode=require`),
    );
    expect(pinned.searchParams.getAll("sslmode")).toEqual(["verify-full"]);
  });
});

describe("pinPgSslMode — inputs left untouched", () => {
  test("a URL with no sslmode", () => {
    expect(pinPgSslMode(BASE)).toBe(BASE);
  });

  for (const mode of ["disable", "verify-full", "no-verify"]) {
    test(`sslmode=${mode}`, () => {
      const input = `${BASE}?sslmode=${mode}`;
      expect(pinPgSslMode(input)).toBe(input);
    });
  }

  test("an explicit uselibpqcompat=true opt-in", () => {
    const input = `${BASE}?uselibpqcompat=true&sslmode=require`;
    expect(pinPgSslMode(input)).toBe(input);
  });

  test("a string that is not a URL", () => {
    expect(pinPgSslMode("not a url")).toBe("not a url");
  });

  test("a URL-encoded password survives unchanged when no rewrite applies", () => {
    const input = "postgresql://user:p%40ss%2Fw@localhost:5432/app";
    expect(pinPgSslMode(input)).toBe(input);
  });
});
