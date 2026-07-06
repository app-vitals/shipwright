/**
 * scripts/generate-mcp-tools.ts
 * Generate MCP tool definitions from the task-store OpenAPI spec (TSM-2.2).
 *
 * Reads `task-store/openapi.json` and, for every operation, emits an MCP tool
 * definition (name, description, JSON-Schema inputSchema) plus the metadata the
 * MCP server needs to proxy the call to the task-store HTTP API (method,
 * pathTemplate, query/path params, hasBody).
 *
 * Output: `mcp-server/src/generated-tools.ts` — a committed TypeScript module
 * exporting the tools as a static `const` array. Regenerate with:
 *   bun run generate:mcp-tools
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");
const specPath = join(repoRoot, "task-store", "openapi.json");
const outPath = join(repoRoot, "mcp-server", "src", "generated-tools.ts");

type JsonSchema = Record<string, unknown>;

interface OpenApiParam {
  name: string;
  in: "query" | "path" | "header" | "cookie";
  required?: boolean;
  schema?: JsonSchema;
  description?: string;
}

interface OpenApiOperation {
  summary?: string;
  parameters?: OpenApiParam[];
  requestBody?: {
    required?: boolean;
    content?: Record<string, { schema?: JsonSchema }>;
  };
}

interface OpenApiSpec {
  paths: Record<string, Record<string, OpenApiOperation>>;
  components?: { schemas?: Record<string, JsonSchema> };
}

const HTTP_METHODS = ["get", "post", "put", "patch", "delete"] as const;

/**
 * Derive a stable snake_case tool name from an HTTP method + path.
 *
 * Rules (see TSM-2.2 brief):
 *   - Resource collection is the first path segment ("tasks", "prs", "tokens").
 *   - A trailing action segment (e.g. "claim", "heartbeat") names the tool.
 *   - Otherwise the verb depends on method + whether the path targets an id:
 *       GET collection      -> <resource>_list
 *       POST collection     -> <resource>_create
 *       GET   /{id}         -> <resource>_get
 *       PATCH /{id}         -> <resource>_update
 *       DELETE /{id}        -> <resource>_delete
 *   - Static sub-collections ("/tasks/bulk", "/tasks/distinct",
 *     "/prs/claim", "/prs/claim-next") use the segment as the action.
 */
export function deriveToolName(method: string, path: string): string {
  const segments = path.split("/").filter(Boolean);
  const resource = segments[0];
  const rest = segments.slice(1);
  const slug = (s: string) => s.replace(/-/g, "_");

  // Trailing non-param action segment: /tasks/{id}/claim -> tasks_claim
  const last = rest[rest.length - 1];
  if (last && !isParam(last)) {
    // Distinguish a static sub-collection (/prs/claim) from an id action
    // (/tasks/{id}/claim). Either way the last segment is the verb.
    return `${resource}_${slug(last)}`;
  }

  const targetsId = rest.some(isParam);
  const m = method.toLowerCase();
  if (!targetsId) {
    if (m === "get") return `${resource}_list`;
    if (m === "post") return `${resource}_create`;
    return `${resource}_${m}`;
  }
  if (m === "get") return `${resource}_get`;
  if (m === "patch" || m === "put") return `${resource}_update`;
  if (m === "delete") return `${resource}_delete`;
  return `${resource}_${m}`;
}

function isParam(segment: string): boolean {
  return segment.startsWith("{") && segment.endsWith("}");
}

/** Resolve a `$ref` like "#/components/schemas/Foo" against the spec. */
function resolveRef(ref: string, spec: OpenApiSpec): JsonSchema | undefined {
  const match = ref.match(/^#\/components\/schemas\/(.+)$/);
  if (!match) return undefined;
  return spec.components?.schemas?.[match[1]];
}

/** Inline an object schema's own `properties`/`required`, following one `$ref`
 * and flattening a single level of `allOf`. Intentionally shallow — the
 * task-store spec is flat. */
function inlineObjectSchema(
  schema: JsonSchema | undefined,
  spec: OpenApiSpec,
): { properties: Record<string, JsonSchema>; required: string[] } {
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  if (!schema) return { properties, required };

  let resolved: JsonSchema | undefined = schema;
  if (typeof schema.$ref === "string") {
    resolved = resolveRef(schema.$ref, spec);
  }
  if (!resolved) return { properties, required };

  if (Array.isArray(resolved.allOf)) {
    for (const part of resolved.allOf as JsonSchema[]) {
      const inner = inlineObjectSchema(part, spec);
      Object.assign(properties, inner.properties);
      required.push(...inner.required);
    }
    return { properties, required };
  }

  if (resolved.properties && typeof resolved.properties === "object") {
    Object.assign(
      properties,
      resolved.properties as Record<string, JsonSchema>,
    );
  }
  if (Array.isArray(resolved.required)) {
    required.push(...(resolved.required as string[]));
  }
  return { properties, required };
}

export interface GeneratedTool {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, JsonSchema>;
    required: string[];
    additionalProperties?: boolean;
  };
  method: string;
  pathTemplate: string;
  queryParams: string[];
  pathParams: string[];
  hasBody: boolean;
}

export function generateTools(spec: OpenApiSpec): GeneratedTool[] {
  const tools: GeneratedTool[] = [];

  for (const [path, pathItem] of Object.entries(spec.paths)) {
    for (const method of HTTP_METHODS) {
      const op = pathItem[method];
      if (!op) continue;

      const properties: Record<string, JsonSchema> = {};
      const required: string[] = [];
      const queryParams: string[] = [];
      const pathParams: string[] = [];

      for (const param of op.parameters ?? []) {
        const paramSchema: JsonSchema = param.schema
          ? { ...param.schema }
          : { type: "string" };
        if (param.description) paramSchema.description = param.description;
        properties[param.name] = paramSchema;
        if (param.in === "path") {
          pathParams.push(param.name);
          required.push(param.name);
        } else if (param.in === "query") {
          queryParams.push(param.name);
          if (param.required) required.push(param.name);
        }
      }

      const bodySchema = op.requestBody?.content?.["application/json"]?.schema;
      const hasBody = Boolean(bodySchema);
      if (bodySchema) {
        const inlined = inlineObjectSchema(bodySchema, spec);
        for (const [key, value] of Object.entries(inlined.properties)) {
          if (!(key in properties)) properties[key] = value;
        }
        if (op.requestBody?.required) {
          for (const key of inlined.required) {
            if (!required.includes(key)) required.push(key);
          }
        }
      }

      tools.push({
        name: deriveToolName(method, path),
        description: op.summary ?? "",
        inputSchema: {
          type: "object",
          properties,
          required,
          additionalProperties: false,
        },
        method: method.toUpperCase(),
        pathTemplate: path,
        queryParams,
        pathParams,
        hasBody,
      });
    }
  }

  return tools;
}

function renderModule(tools: GeneratedTool[]): string {
  const header = `// GENERATED FILE — do not edit by hand.
// Produced by scripts/generate-mcp-tools.ts from task-store/openapi.json.
// Regenerate with: bun run generate:mcp-tools

/** An MCP tool derived from a single task-store OpenAPI operation. */
export interface GeneratedTool {
  /** snake_case tool name, e.g. "tasks_list". */
  name: string;
  /** Human-readable description (from the OpenAPI operation summary). */
  description: string;
  /** JSON Schema for the tool's arguments. */
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required: string[];
    additionalProperties?: boolean;
  };
  /** HTTP method to call on the task-store API. */
  method: string;
  /** Original OpenAPI path template, e.g. "/tasks/{id}/claim". */
  pathTemplate: string;
  /** Names of query-string parameters. */
  queryParams: string[];
  /** Names of path parameters (substituted into pathTemplate). */
  pathParams: string[];
  /** True if the operation accepts a JSON request body. */
  hasBody: boolean;
}

export const generatedTools: GeneratedTool[] = ${JSON.stringify(tools, null, 2)};
`;
  return header;
}

export function generateMcpTools(): GeneratedTool[] {
  const spec: OpenApiSpec = JSON.parse(readFileSync(specPath, "utf8"));
  const tools = generateTools(spec);
  writeFileSync(outPath, renderModule(tools));
  // Normalize with biome so the committed output is reproducible and lint-clean.
  Bun.spawnSync(["bunx", "biome", "format", "--write", outPath], {
    cwd: repoRoot,
    stdout: "ignore",
    stderr: "ignore",
  });
  return tools;
}

if (import.meta.main) {
  const tools = generateMcpTools();
  console.log(`Wrote ${tools.length} MCP tools to ${outPath}`);
}
