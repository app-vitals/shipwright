/**
 * admin/src/coding/cursor-paging.unit.test.ts (TPG-2.2)
 * Unit tests for the stateless Prev/Next cursor-stack helpers.
 */

import { describe, expect, test } from "bun:test";
import {
  applyCursorState,
  type CursorState,
  nextCursorState,
  parseCursorState,
  prevCursorState,
  renderCursorPager,
} from "./cursor-paging.ts";

const href = (s: CursorState) => {
  const p = new URLSearchParams();
  applyCursorState(p, s);
  const qs = p.toString();
  return `/x${qs ? `?${qs}` : ""}`;
};

describe("parseCursorState", () => {
  test("no cursor is the first page", () => {
    expect(parseCursorState(undefined, undefined)).toEqual({ prev: [] });
    expect(parseCursorState(undefined, "a.b")).toEqual({ prev: [] });
  });
  test("parses cursor and prev stack", () => {
    expect(parseCursorState("c3", "c1.c2")).toEqual({
      cursor: "c3",
      prev: ["c1", "c2"],
    });
  });
  test("malformed cursor degrades to the first page; malformed stack is dropped", () => {
    expect(parseCursorState("bad cursor!", "c1")).toEqual({ prev: [] });
    expect(parseCursorState("c2", "ok.bad!")).toEqual({
      cursor: "c2",
      prev: [],
    });
  });
});

describe("cursor stack navigation", () => {
  test("Next then Prev round-trips through the whole stack back to page 1", () => {
    const p1: CursorState = { prev: [] };
    const p2 = nextCursorState(p1, "c2");
    const p3 = nextCursorState(p2, "c3");
    const p4 = nextCursorState(p3, "c4");
    expect(p2).toEqual({ cursor: "c2", prev: [] });
    expect(p3).toEqual({ cursor: "c3", prev: ["c2"] });
    expect(p4).toEqual({ cursor: "c4", prev: ["c2", "c3"] });
    expect(prevCursorState(p4)).toEqual(p3);
    expect(prevCursorState(p3)).toEqual(p2);
    expect(prevCursorState(p2)).toEqual(p1);
    expect(prevCursorState(p1)).toBeNull();
  });
  test("applyCursorState writes nothing for the first page", () => {
    expect(href({ prev: [] })).toBe("/x");
    expect(href({ cursor: "c3", prev: ["c1", "c2"] })).toBe(
      "/x?cursor=c3&prev=c1.c2",
    );
  });
});

describe("renderCursorPager", () => {
  const pager = (state: CursorState, nextCursor: string | null) =>
    renderCursorPager(
      { count: 50, total: 120, limit: 50, state, nextCursor },
      href,
    );
  test("first page: Next only", () => {
    const html = pager({ prev: [] }, "c2");
    expect(html).not.toContain("Prev");
    expect(html).toContain('href="/x?cursor=c2"');
    expect(html).toContain("Next →");
  });
  test("middle page: Prev goes to the previous cursor, Next extends the stack", () => {
    const html = pager({ cursor: "c2", prev: [] }, "c3");
    expect(html).toContain('href="/x" rel="prev"');
    expect(html).toContain('href="/x?cursor=c3&prev=c2"');
  });
  test("last page: Prev only", () => {
    const html = pager({ cursor: "c3", prev: ["c2"] }, null);
    expect(html).toContain('href="/x?cursor=c2"');
    expect(html).not.toContain("Next");
  });
  test("single page: no controls links", () => {
    const html = pager({ prev: [] }, null);
    expect(html).not.toContain("Prev");
    expect(html).not.toContain("Next");
  });
  test("renders nothing for an empty first page", () => {
    expect(
      renderCursorPager({ count: 0, limit: 50, state: { prev: [] } }, href),
    ).toBe("");
  });
});
