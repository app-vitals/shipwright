/**
 * agent/src/index.ts
 * Shipwright agent startup entrypoint (spawned by the platform runtime's entrypoint-main.ts).
 *
 * The coding agent's composition root: the only file that imports both the
 * generic runtime (boot.ts) and the coding extension. The boot sequence itself
 * lives in startAgent().
 */

import { startAgent } from "@app-vitals/agent-runtime/boot";
import { createCodingExtension } from "./coding/extension.ts";

await startAgent([createCodingExtension]);
