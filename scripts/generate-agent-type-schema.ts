/**
 * scripts/generate-agent-type-schema.ts
 * Generate the JSON Schema artifact for the AgentType manifest from its Zod
 * source of truth (admin/src/agent-type-registry.ts).
 *
 * Output: `docs/schemas/agent-type.schema.json` — a committed JSON file.
 * Regenerate with:
 *   bun run scripts/generate-agent-type-schema.ts
 */

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildAgentTypeJsonSchema } from "../admin/src/agent-type-registry.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");
const outPath = join(repoRoot, "docs", "schemas", "agent-type.schema.json");

if (import.meta.main) {
  const schema = buildAgentTypeJsonSchema();
  writeFileSync(outPath, `${JSON.stringify(schema, null, 2)}\n`);
  console.log(`Wrote AgentType JSON Schema to ${outPath}`);
}
