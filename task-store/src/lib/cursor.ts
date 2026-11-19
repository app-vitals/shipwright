/**
 * task-store/src/lib/cursor.ts
 *
 * Opaque keyset-pagination cursor codec. A cursor encodes the last row's
 * (createdAt, id) — a *position*, not a row lookup — so a cursor whose row has
 * since been deleted (or no longer matches the filter) still pages correctly.
 *
 * Wire format: base64url(JSON.stringify([createdAtISO, id])). Clients must
 * treat it as opaque.
 */

import { BadRequestError } from "../errors.ts";

export interface CursorPosition {
  createdAt: Date;
  id: string;
}

export function encodeCursor(pos: CursorPosition): string {
  return Buffer.from(
    JSON.stringify([pos.createdAt.toISOString(), pos.id]),
  ).toString("base64url");
}

/** Decode a cursor; throws BadRequestError (400) when malformed. */
export function decodeCursor(raw: string): CursorPosition {
  const bad = () => new BadRequestError("invalid cursor");
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    throw bad();
  }
  if (!Array.isArray(parsed) || parsed.length !== 2) throw bad();
  const [ts, id] = parsed;
  if (typeof ts !== "string" || typeof id !== "string" || id === "") {
    throw bad();
  }
  const createdAt = new Date(ts);
  if (Number.isNaN(createdAt.getTime())) throw bad();
  return { createdAt, id };
}

/**
 * Prisma where fragment selecting rows strictly after `pos` in
 * (createdAt, id) order — flipped for descending order.
 */
export function cursorWhere(
  pos: CursorPosition,
  sort: "asc" | "desc",
  field = "createdAt",
): {
  OR: Array<Record<string, unknown>>;
} {
  const op = sort === "desc" ? "lt" : "gt";
  return {
    OR: [
      { [field]: { [op]: pos.createdAt } },
      { [field]: pos.createdAt, id: { [op]: pos.id } },
    ],
  };
}

export interface KeyCursorPosition {
  key: string;
  id: string;
}

/**
 * Cursor over a string sort column (e.g. TaskEvent.at / VerificationCheck.at,
 * which are caller-controlled strings and must round-trip verbatim — never
 * re-serialised through Date). Same wire shape as encodeCursor: [key, id].
 */
export function encodeKeyCursor(pos: KeyCursorPosition): string {
  return Buffer.from(JSON.stringify([pos.key, pos.id])).toString("base64url");
}

/** Decode a string-key cursor; throws BadRequestError (400) when malformed. */
export function decodeKeyCursor(raw: string): KeyCursorPosition {
  const bad = () => new BadRequestError("invalid cursor");
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    throw bad();
  }
  if (!Array.isArray(parsed) || parsed.length !== 2) throw bad();
  const [key, id] = parsed;
  if (typeof key !== "string" || typeof id !== "string" || id === "") {
    throw bad();
  }
  return { key, id };
}

/** Like cursorWhere, for a string sort column named `field`. */
export function keyCursorWhere(
  pos: KeyCursorPosition,
  sort: "asc" | "desc",
  field: string,
): { OR: Array<Record<string, unknown>> } {
  const op = sort === "desc" ? "lt" : "gt";
  return {
    OR: [
      { [field]: { [op]: pos.key } },
      { [field]: pos.key, id: { [op]: pos.id } },
    ],
  };
}

/**
 * Offset-backed cursor for lists whose order is derived in memory (session
 * rollups, blocked-PR filtering) and so has no keyset position. The offset is
 * wrapped in an opaque token so clients still just follow nextCursor.
 */
export function encodeOffsetCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ o: offset })).toString("base64url");
}

/** Decode an offset cursor; throws BadRequestError (400) when malformed. */
export function decodeOffsetCursor(raw: string): number {
  const bad = () => new BadRequestError("invalid cursor");
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    throw bad();
  }
  const o = (parsed as { o?: unknown } | null)?.o;
  if (typeof o !== "number" || !Number.isInteger(o) || o < 0) throw bad();
  return o;
}
