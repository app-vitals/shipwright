/**
 * scripts/generate-task-store-spec.ts
 * Generate the OpenAPI 3.1 spec for the Shipwright task-store service.
 *
 * Delegates to task-store/src/generate-spec.ts for the actual spec assembly.
 * This thin wrapper keeps the CLI entry point separate from the reusable
 * generator function used by unit tests.
 *
 * Usage:
 *   bun run generate:task-store-spec
 */

import { generateTaskStoreSpec } from "../task-store/src/generate-spec.ts";

generateTaskStoreSpec();
