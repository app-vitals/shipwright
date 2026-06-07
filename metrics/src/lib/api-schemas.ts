/**
 * metrics/src/lib/api-schemas.ts
 * Shared OpenAPI schemas.
 */

import { z } from "@hono/zod-openapi";

export const ErrorSchema = z.object({ error: z.string() }).openapi("Error");
