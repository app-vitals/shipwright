/**
 * scripts/generate-specialty-schema.ts
 * Generate the JSON Schema artifact for the Specialty manifest from its Zod
 * source of truth (admin/src/specialty-registry.ts).
 *
 * Output: `docs/schemas/specialty.schema.json` — a committed JSON file.
 * Regenerate with:
 *   bun run scripts/generate-specialty-schema.ts
 */

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSpecialtyJsonSchema } from "../admin/src/specialty-registry.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");
const outPath = join(repoRoot, "docs", "schemas", "specialty.schema.json");

if (import.meta.main) {
  const schema = buildSpecialtyJsonSchema();
  writeFileSync(outPath, `${JSON.stringify(schema, null, 2)}\n`);
  console.log(`Wrote Specialty JSON Schema to ${outPath}`);
}
