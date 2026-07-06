/**
 * tool-caller.ts
 * Proxy an MCP tool call to the task-store HTTP API.
 *
 * Given a generated tool definition and the caller's arguments, build the HTTP
 * request (path-param substitution, query string, JSON body), attach a bearer
 * token, and return the response shaped as an MCP tool result. `fetchImpl` is
 * injected so tests can supply a double — no `global.fetch` override.
 */

import type { GeneratedTool } from "./generated-tools.ts";

export interface ToolCallerConfig {
  /** Base URL of the task-store API (SHIPWRIGHT_TASK_STORE_URL). */
  baseUrl: string;
  /** Bearer token for the task-store API (SHIPWRIGHT_TASK_STORE_TOKEN). */
  token: string;
  /** Injected fetch (defaults to the global). */
  fetchImpl?: typeof fetch;
}

export interface ToolResult {
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

/** Resolve caller config from the standard task-store env vars.
 * Throws a clear error at startup if either required var is missing,
 * rather than failing deep inside the first `callTool` invocation. */
export function configFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): ToolCallerConfig {
  const baseUrl = env.SHIPWRIGHT_TASK_STORE_URL;
  const token = env.SHIPWRIGHT_TASK_STORE_TOKEN;
  if (!baseUrl) {
    throw new Error(
      "SHIPWRIGHT_TASK_STORE_URL is not set. Set it to the task-store base URL before starting the MCP server.",
    );
  }
  if (!token) {
    throw new Error(
      "SHIPWRIGHT_TASK_STORE_TOKEN is not set. Set it to a valid task-store bearer token before starting the MCP server.",
    );
  }
  return { baseUrl, token };
}

export async function callTool(
  tool: GeneratedTool,
  args: Record<string, unknown>,
  config: ToolCallerConfig,
): Promise<ToolResult> {
  const fetchImpl = config.fetchImpl ?? fetch;

  // Substitute path params into the template.
  let path = tool.pathTemplate;
  for (const name of tool.pathParams) {
    const value = args[name];
    if (value === undefined || value === null) {
      return errorResult(`Missing required path parameter: ${name}`);
    }
    path = path.replace(`{${name}}`, encodeURIComponent(String(value)));
  }

  // Concatenate rather than resolve so a base URL with its own path prefix
  // (e.g. ".../api") is preserved instead of being discarded by URL resolution.
  const url = new URL(
    stripTrailingSlash(config.baseUrl) + ensureLeadingSlash(path),
  );
  for (const name of tool.queryParams) {
    const value = args[name];
    if (value !== undefined && value !== null) {
      url.searchParams.set(name, String(value));
    }
  }

  const headers: Record<string, string> = {
    authorization: `Bearer ${config.token}`,
    accept: "application/json",
  };

  const init: RequestInit = { method: tool.method, headers };

  if (tool.hasBody) {
    if (tool.hasArrayBody) {
      // Array-typed body: the caller passes `args.items`; send the array directly.
      const items = args.items;
      if (!Array.isArray(items)) {
        return errorResult(
          `${tool.name} expects an array body — pass items as an array in the "items" argument.`,
        );
      }
      headers["content-type"] = "application/json";
      init.body = JSON.stringify(items);
    } else {
      // Object body fields are everything that isn't a path or query param.
      const consumed = new Set([...tool.pathParams, ...tool.queryParams]);
      const body: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(args)) {
        if (!consumed.has(key)) body[key] = value;
      }
      if (Object.keys(body).length > 0) {
        headers["content-type"] = "application/json";
        init.body = JSON.stringify(body);
      }
    }
  }

  let response: Response;
  try {
    response = await fetchImpl(url.toString(), init);
  } catch (err) {
    return errorResult(
      `Request to ${tool.name} failed: ${(err as Error).message}`,
    );
  }

  const text = await response.text();
  if (!response.ok) {
    return errorResult(`${tool.name} returned ${response.status}: ${text}`);
  }

  return { content: [{ type: "text", text: text || "" }] };
}

function errorResult(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

function stripTrailingSlash(base: string): string {
  return base.endsWith("/") ? base.slice(0, -1) : base;
}

function ensureLeadingSlash(path: string): string {
  return path.startsWith("/") ? path : `/${path}`;
}
