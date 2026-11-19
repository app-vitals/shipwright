import { describe, expect, it } from "bun:test";
import { BadRequestError } from "../errors.ts";
import {
  cursorWhere,
  decodeCursor,
  decodeKeyCursor,
  decodeOffsetCursor,
  encodeCursor,
  encodeKeyCursor,
  encodeOffsetCursor,
  keyCursorWhere,
} from "./cursor.ts";

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

describe("string-key cursor codec (TPG-1.2)", () => {
  it("round-trips a verbatim, non-ISO key", () => {
    const key = "2026-01-01T00:00:00Z"; // no millis: must not be re-serialised
    expect(decodeKeyCursor(encodeKeyCursor({ key, id: "e-1" }))).toEqual({
      key,
      id: "e-1",
    });
  });

  it.each([
    ["empty", ""],
    ["wrong shape", Buffer.from('{"a":1}').toString("base64url")],
    ["non-string key", Buffer.from('[1,"id"]').toString("base64url")],
    ["empty id", Buffer.from('["k",""]').toString("base64url")],
  ])("rejects a malformed cursor: %s", (_n, raw) => {
    expect(() => decodeKeyCursor(raw)).toThrow(BadRequestError);
  });

  it("keyCursorWhere builds a strict-after clause on the named field, flipped for desc", () => {
    expect(keyCursorWhere({ key: "k", id: "i" }, "asc", "at")).toEqual({
      OR: [{ at: { gt: "k" } }, { at: "k", id: { gt: "i" } }],
    });
    expect(keyCursorWhere({ key: "k", id: "i" }, "desc", "at")).toEqual({
      OR: [{ at: { lt: "k" } }, { at: "k", id: { lt: "i" } }],
    });
  });

  it("cursorWhere accepts a custom date field", () => {
    const createdAt = new Date("2026-01-01T00:00:00.000Z");
    expect(cursorWhere({ createdAt, id: "i" }, "desc", "measuredAt")).toEqual({
      OR: [
        { measuredAt: { lt: createdAt } },
        { measuredAt: createdAt, id: { lt: "i" } },
      ],
    });
  });
});

describe("offset cursor codec (TPG-1.2)", () => {
  it("round-trips an offset, including 0", () => {
    expect(decodeOffsetCursor(encodeOffsetCursor(0))).toBe(0);
    expect(decodeOffsetCursor(encodeOffsetCursor(150))).toBe(150);
  });

  it.each([
    ["empty", ""],
    ["not json", "!!!"],
    ["wrong shape", Buffer.from("[1]").toString("base64url")],
    ["negative", Buffer.from('{"o":-1}').toString("base64url")],
    ["non-integer", Buffer.from('{"o":1.5}').toString("base64url")],
    ["string", Buffer.from('{"o":"3"}').toString("base64url")],
    ["null", Buffer.from("null").toString("base64url")],
  ])("rejects a malformed cursor: %s", (_n, raw) => {
    expect(() => decodeOffsetCursor(raw)).toThrow(BadRequestError);
  });

  it("is not accepted by the keyset decoder (and vice versa)", () => {
    expect(() => decodeCursor(encodeOffsetCursor(3))).toThrow(BadRequestError);
    expect(() =>
      decodeOffsetCursor(encodeCursor({ createdAt: new Date(0), id: "x" })),
    ).toThrow(BadRequestError);
  });
});
