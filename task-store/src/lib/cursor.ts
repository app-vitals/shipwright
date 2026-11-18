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
): {
  OR: Array<Record<string, unknown>>;
} {
  const op = sort === "desc" ? "lt" : "gt";
  return {
    OR: [
      { createdAt: { [op]: pos.createdAt } },
      { createdAt: pos.createdAt, id: { [op]: pos.id } },
    ],
  };
}
