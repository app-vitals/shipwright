/**
 * scripts/generate-chat-spec.ts
 * Generate the OpenAPI 3.1 spec for the Shipwright chat service.
 *
 * Delegates to chat/src/generate-spec.ts for the actual spec assembly.
 * This thin wrapper keeps the CLI entry point separate from the reusable
 * generator function used by unit tests.
 *
 * Usage:
 *   bun run generate:chat-spec
 */

import { generateChatSpec } from "../chat/src/generate-spec.ts";

generateChatSpec();
