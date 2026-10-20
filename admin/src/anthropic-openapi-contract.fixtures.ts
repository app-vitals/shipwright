/**
 * admin/src/anthropic-openapi-contract.fixtures.ts
 * Offline contract checking of recorded Anthropic cassettes against the
 * Anthropic OpenAPI 3.1 spec copied into the repo (test support only).
 *
 * The spec is anthropics/anthropic-sdk-typescript scripts/mock-spec.json.gz at
 * the tag matching the pinned @anthropic-ai/sdk version; see
 * fixtures/anthropic-openapi/SDK_VERSION and
 * scripts/refresh-anthropic-openapi-spec.ts.
 */

import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import type { AnthropicCassette } from "./anthropic-identity-client.fixtures.ts";

const SPEC_DIR = new URL("./fixtures/anthropic-openapi/", import.meta.url)
  .pathname;

export const SPEC_GZ_PATH = `${SPEC_DIR}mock-spec.json.gz`;
export const SPEC_VERSION_PATH = `${SPEC_DIR}SDK_VERSION`;

// biome-ignore lint/suspicious/noExplicitAny: OpenAPI documents are arbitrary JSON
export type OpenApiSpec = any;

export function loadSpec(): OpenApiSpec {
  return JSON.parse(gunzipSync(readFileSync(SPEC_GZ_PATH)).toString("utf-8"));
}

export function readSpecSdkVersion(): string {
  return readFileSync(SPEC_VERSION_PATH, "utf-8").trim();
}

export interface MatchedOperation {
  operationId: string;
  method: string;
  template: string;
}

interface Interaction {
  scenario: string;
  index: number;
  request: AnthropicCassette["scenarios"][string][number]["request"];
  response: AnthropicCassette["scenarios"][string][number]["response"];
}

const SPEC_URI = "https://spec.invalid/anthropic-openapi";

/** Deep-copy a schema, pointing local "#/components/" refs at SPEC_URI. */
function rebaseRefs(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(rebaseRefs);
  if (node && typeof node === "object") {
    return Object.fromEntries(
      Object.entries(node).map(([k, v]) => [
        k,
        k === "$ref" && typeof v === "string" && v.startsWith("#/")
          ? SPEC_URI + v
          : rebaseRefs(v),
      ]),
    );
  }
  return node;
}

function templateToRegExp(template: string): RegExp {
  const pattern = template
    .split(/(\{[^}]+\})/)
    .map((part) =>
      part.startsWith("{")
        ? "[^/]+"
        : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    )
    .join("");
  return new RegExp(`^${pattern}$`);
}

export interface ContractResult {
  problems: string[];
  operations: MatchedOperation[];
}

/**
 * Validate every interaction of every scenario: the method+path must match a
 * spec operation, the request query names/values and JSON body must satisfy
 * the operation's schemas, and the response body must satisfy the schema of the
 * documented response for its status code.
 */
export function validateCassetteAgainstSpec(
  cassette: AnthropicCassette,
  spec: OpenApiSpec = loadSpec(),
): ContractResult {
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  const problems: string[] = [];
  const operations = new Map<string, MatchedOperation>();

  // Beta duplicates carry a "?beta=true" suffix in their key; the SDK's
  // typed resources call the plain paths.
  const templates = Object.keys(spec.paths)
    .filter((p) => !p.includes("?"))
    .map((template) => ({ template, re: templateToRegExp(template) }));

  // Register the components once; operation schemas reference them through
  // an absolute URI so Ajv never re-walks the multi-megabyte document.
  ajv.addSchema({ components: spec.components }, SPEC_URI);
  const validate = (schema: unknown, data: unknown) => {
    const fn = ajv.compile(rebaseRefs(schema) as object);
    return fn(data)
      ? []
      : (fn.errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message}`);
  };

  const interactions: Interaction[] = Object.entries(
    cassette.scenarios,
  ).flatMap(([scenario, list]) =>
    list.map((i, index) => ({ scenario, index, ...i })),
  );

  for (const it of interactions) {
    const where = `${it.scenario}[${it.index}] ${it.request.method} ${it.request.path}`;
    const match = templates.find((t) => t.re.test(it.request.path));
    if (!match) {
      problems.push(`${where}: path is not in the spec`);
      continue;
    }
    const op = spec.paths[match.template][it.request.method.toLowerCase()];
    if (!op || typeof op !== "object") {
      problems.push(`${where}: method not defined for ${match.template}`);
      continue;
    }
    operations.set(op.operationId, {
      operationId: op.operationId,
      method: it.request.method,
      template: match.template,
    });

    // Query parameters
    // biome-ignore lint/suspicious/noExplicitAny: spec parameter objects
    const params: any[] = op.parameters ?? [];
    for (const [name, value] of Object.entries(it.request.query ?? {})) {
      const p = params.find((x) => x.in === "query" && x.name === name);
      if (!p) {
        problems.push(`${where}: query parameter "${name}" is not in the spec`);
        continue;
      }
      const coerced = /integer|number/.test(JSON.stringify(p.schema))
        ? Number(value)
        : value === "true" || value === "false"
          ? value === "true"
          : value;
      for (const e of validate(p.schema, coerced)) {
        problems.push(`${where}: query "${name}" ${e}`);
      }
    }

    // Request body
    const reqSchema = op.requestBody?.content?.["application/json"]?.schema;
    if (it.request.body !== undefined) {
      if (!reqSchema) {
        problems.push(`${where}: spec defines no JSON request body`);
      } else {
        for (const e of validate(reqSchema, it.request.body)) {
          problems.push(`${where}: request ${e}`);
        }
      }
    } else if (op.requestBody?.required) {
      problems.push(`${where}: spec requires a request body`);
    }

    // Response body
    const res = op.responses?.[String(it.response.status)];
    if (!res) {
      problems.push(
        `${where}: status ${it.response.status} is not documented in the spec`,
      );
      continue;
    }
    const resSchema = res.content?.["application/json"]?.schema;
    if (!resSchema) {
      problems.push(
        `${where}: spec defines no JSON body for ${it.response.status}`,
      );
      continue;
    }
    for (const e of validate(resSchema, it.response.body)) {
      problems.push(`${where}: response ${it.response.status} ${e}`);
    }
  }

  return { problems, operations: [...operations.values()] };
}
