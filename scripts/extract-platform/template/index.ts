/**
 * index.ts
 * Agent server entrypoint, spawned by runtime/entrypoint.ts (../index.ts).
 *
 * The composition root of the plain platform: no extensions. Downstream
 * images that add behavior replace this file with one that passes their
 * extension factories to startAgent().
 */

import { startAgent } from "@app-vitals/agent-runtime/boot";

await startAgent([]);
