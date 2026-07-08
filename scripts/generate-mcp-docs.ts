/**
 * scripts/generate-mcp-docs.ts
 * Generate human-readable MCP tool reference docs from the already-generated
 * task-store-derived tool set (TSM-2.2) filtered through the public allowlist
 * (TSM-2.3).
 *
 * Reads `mcp-server/src/generated-tools.ts`'s `generatedTools` array (itself
 * produced by `scripts/generate-mcp-tools.ts` from `task-store/openapi.json`),
 * filters it through `allowedTools()` from `mcp-server/src/tool-allowlist.ts`,
 * and renders one Markdown section per public tool: name, description,
 * HTTP method + path template, parameters, and whether it has a body.
 *
 * Output: `docs/mcp-tools.md` — a committed Markdown file. Regenerate with:
 *   bun run generate:mcp-docs
 */

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { GeneratedTool } from "../mcp-server/src/generated-tools.ts";
import { generatedTools } from "../mcp-server/src/generated-tools.ts";
import { allowedTools } from "../mcp-server/src/tool-allowlist.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");
const outPath = join(repoRoot, "docs", "mcp-tools.md");

/** Render a single tool's parameter list as an inline comma-separated string, or "None". */
function renderParams(tool: GeneratedTool): string {
  const params = [
    ...tool.pathParams.map((name) => `\`${name}\` (path)`),
    ...tool.queryParams.map((name) => `\`${name}\` (query)`),
  ];
  if (params.length === 0) return "None";
  return params.join(", ");
}

/** Render whether a tool accepts a request body, distinguishing array bodies. */
function renderBody(tool: GeneratedTool): string {
  if (!tool.hasBody) return "No";
  if (tool.hasArrayBody) return "Yes (JSON array body via `items`)";
  return "Yes";
}

/**
 * Render the full MCP tools reference doc as Markdown.
 *
 * Pure function — no file I/O — so it can be unit-tested directly. Tools are
 * sorted alphabetically by name so regeneration is diff-stable.
 */
export function renderMcpToolsDoc(tools: GeneratedTool[]): string {
  const sorted = [...tools].sort((a, b) => a.name.localeCompare(b.name));

  const header = `<!-- GENERATED FILE — do not edit by hand. -->
<!-- Produced by scripts/generate-mcp-docs.ts from mcp-server/src/generated-tools.ts -->
<!-- (itself generated from task-store/openapi.json) filtered through -->
<!-- mcp-server/src/tool-allowlist.ts. Regenerate with: bun run generate:mcp-docs -->

# MCP Server Tool Reference

This is the public tool surface exposed by the MCP server (\`@shipwright/mcp-server\`)
after allowlist filtering. See [architecture.md](./architecture.md#mcp-server) for
how the server is generated, wired, and executed.

`;

  if (sorted.length === 0) {
    return `${header}_No tools available._\n`;
  }

  const sections = sorted.map((tool) => {
    return `## \`${tool.name}\`

${tool.description}

- **Method:** ${tool.method}
- **Path:** \`${tool.pathTemplate}\`
- **Has body:** ${renderBody(tool)}
- **Parameters:** ${renderParams(tool)}
`;
  });

  return `${header}${sections.join("\n")}`;
}

export function generateMcpDocs(): GeneratedTool[] {
  const tools = allowedTools(generatedTools);
  writeFileSync(outPath, renderMcpToolsDoc(tools));
  return tools;
}

if (import.meta.main) {
  const tools = generateMcpDocs();
  console.log(`Wrote ${tools.length} MCP tools to ${outPath}`);
}
