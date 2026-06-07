/**
 * lib/api-schemas.ts
 * Shared OpenAPI schemas used across all service packages.
 * Kept minimal — service-specific schemas live in each service's schemas.ts.
 */

import { z } from "@hono/zod-openapi";

export const ErrorSchema = z.object({ error: z.string() }).openapi("Error");
