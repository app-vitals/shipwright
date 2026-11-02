/**
 * agent/src/index.ts
 * Shipwright agent startup entrypoint (spawned by the platform runtime's entrypoint-main.ts).
 *
 * The coding agent's composition root: the only file that imports both the
 * generic runtime (boot.ts) and the coding extension. The boot sequence itself
 * lives in startAgent().
 *
 * syncWorkspaceTemplates() runs first on every boot (Docker and bare-metal
 * alike) — see its own doc comment for why a bare-metal install needs this
 * and Docker doesn't (it's a harmless no-op there, overwriting the same file
 * its own Dockerfile COPY already patched in at build time).
 */

import { startAgent } from "@app-vitals/agent-runtime/boot";
import { createCodingExtension } from "./coding/extension.ts";
import { syncWorkspaceTemplates } from "../scripts/sync-workspace-templates.ts";

syncWorkspaceTemplates();
await startAgent([createCodingExtension]);
