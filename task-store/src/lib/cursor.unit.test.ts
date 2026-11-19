import { describe, expect, it } from "bun:test";
import { BadRequestError } from "../errors.ts";
import { decodeCursor, encodeCursor } from "./cursor.ts";

describe("cursor codec", () => {
  it("round-trips (createdAt, id)", () => {
    const createdAt = new Date("2026-11-01T12:34:56.789Z");
    const decoded = decodeCursor(encodeCursor({ createdAt, id: "TPG-1.1" }));
    expect(decoded.id).toBe("TPG-1.1");
    expect(decoded.createdAt.toISOString()).toBe(createdAt.toISOString());
  });

  it("round-trips ids with unusual characters", () => {
    const createdAt = new Date("2026-01-01T00:00:00.000Z");
    const id = 'a/b c+d"é|,[]';
    expect(decodeCursor(encodeCursor({ createdAt, id })).id).toBe(id);
  });

  it("is URL-safe and opaque", () => {
    const c = encodeCursor({ createdAt: new Date(0), id: "x?y&z=1/+" });
    expect(c).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it.each([
    ["empty", ""],
    ["not base64 json", "!!!not-a-cursor!!!"],
    ["json but wrong shape", Buffer.from('{"a":1}').toString("base64url")],
    ["bad date", Buffer.from('["nope","id"]').toString("base64url")],
    [
      "empty id",
      Buffer.from('["2026-01-01T00:00:00.000Z",""]').toString("base64url"),
    ],
    [
      "non-string id",
      Buffer.from('["2026-01-01T00:00:00.000Z",5]').toString("base64url"),
    ],
    [
      "extra element",
      Buffer.from('["2026-01-01T00:00:00.000Z","a","b"]').toString("base64url"),
    ],
  ])("rejects malformed cursor: %s", (_name, raw) => {
    expect(() => decodeCursor(raw)).toThrow(BadRequestError);
  });
});
