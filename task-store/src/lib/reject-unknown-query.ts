/**
 * Shared unknown-query-parameter guard for list endpoints (PLU-1.1).
 *
 * A list filter the server does not recognise is silently ignored by a plain
 * handler, so a typo'd filter widens to the whole store. Handlers call
 * `rejectUnknownQuery(c, QuerySchema)` first; the allow-list is the keys of
 * the same zod query schema that generates the OpenAPI document, so the
 * accepted set and the documented set cannot drift. Reused by GET /documents
 * (PLU-2.2).
 */

import type { z } from "@hono/zod-openapi";
import { BadRequestError } from "../errors.ts";

/** Anything exposing Hono's `req.queries()` (a Hono `Context` qualifies). */
interface QueryContext {
  req: { queries(): Record<string, string[]> };
}

/** The parameter names a zod object query schema declares. */
export function allowedQueryParams(
  schema: z.ZodObject<z.ZodRawShape>,
): string[] {
  return Object.keys(schema.shape);
}

/** Request parameter names not declared by `schema`, deduplicated and sorted. */
export function unknownQueryParams(
  queries: Record<string, string[]>,
  schema: z.ZodObject<z.ZodRawShape>,
): string[] {
  const allowed = new Set(allowedQueryParams(schema));
  return Object.keys(queries)
    .filter((name) => !allowed.has(name))
    .sort();
}

/** Throws a 400 `BadRequestError` naming every query parameter `schema` lacks. */
export function rejectUnknownQuery(
  c: QueryContext,
  schema: z.ZodObject<z.ZodRawShape>,
): void {
  const unknown = unknownQueryParams(c.req.queries(), schema);
  if (unknown.length === 0) return;
  throw new BadRequestError(
    `unknown query parameter${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")} (accepted: ${allowedQueryParams(schema).join(", ")})`,
  );
}
