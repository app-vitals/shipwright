/**
 * PLU-1.1 repo-wide caller audit.
 *
 * GET /tasks and GET /sessions reject query parameters their zod query schema
 * does not declare. This audit scans every caller in the repo (plugin
 * commands/skills/references/scripts, agent, admin, metrics, MCP server,
 * scripts) and fails on any parameter sent to those two endpoints that the
 * schema does not accept, so a stray caller breaks CI instead of production.
 *
 * Two static signals are checked: `/tasks?a=..&b=..` style URL literals, and
 * `URLSearchParams` builders (`new URLSearchParams({...})`, `.set/.append`)
 * whose variable is interpolated into a `/tasks?${..}` / `/sessions?${..}` URL
 * or handed to a known tasks/sessions fetch helper.
 */

import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { generatedTools } from "./mcp-server/src/generated-tools.ts";
import { allowedQueryParams } from "./task-store/src/lib/reject-unknown-query.ts";
import {
  SessionListQuerySchema,
  TaskListQuerySchema,
} from "./task-store/src/openapi-schemas.ts";

const ROOT = import.meta.dir;
const SCAN_DIRS = [
  "plugins",
  "agent",
  "admin/src",
  "metrics/src",
  "mcp-server/src",
  "scripts",
];
const EXTS = [".ts", ".md", ".sh", ".template", ".yml", ".json"];
const SKIP_DIR = new Set(["node_modules", ".git", "dist"]);
const SKIP_FILE = /\.(test|spec)\.ts$|openapi\.json$|generated-tools\.ts$/;

const ENDPOINTS = {
  tasks: new Set(allowedQueryParams(TaskListQuerySchema)),
  sessions: new Set(allowedQueryParams(SessionListQuerySchema)),
} as const;
type Endpoint = keyof typeof ENDPOINTS;

export interface Stray {
  endpoint: Endpoint;
  param: string;
  via: string;
}

/** Parameter names in a `a=1&b=${x}` style query string. */
function namesInQueryString(qs: string): string[] {
  const out: string[] = [];
  for (const part of qs.split("&")) {
    const m = /^\\?([A-Za-z_][\w-]*)(?:\[\])?=/.exec(part);
    if (m) out.push(m[1] as string);
  }
  return out;
}

/** Keys of `new URLSearchParams({ ... })` object literals + `.set/.append("k"` in a block. */
function namesInBuilder(block: string): string[] {
  const out = new Set<string>();
  const lit = /new URLSearchParams\(\s*\{([^}]*)\}/g;
  for (let m = lit.exec(block); m; m = lit.exec(block)) {
    for (const part of (m[1] as string).split(/,\s*(?![^()]*\))/)) {
      const key = /^\s*(?:\.\.\.\(.*)?["']?([A-Za-z_]\w*)["']?\s*(?::|$)/.exec(
        part,
      );
      if (key && !part.trim().startsWith("...")) out.add(key[1] as string);
    }
    // spread conditionals: ...(x !== undefined ? { updatedSince } : {})
    for (const sp of (m[1] as string).matchAll(/\?\s*\{\s*([A-Za-z_]\w*)/g)) {
      out.add(sp[1] as string);
    }
  }
  for (const m of block.matchAll(/\.(?:set|append)\(\s*["']([\w-]+)["']/g)) {
    out.add(m[1] as string);
  }
  return [...out];
}

const HELPER_CALL =
  /\b(?:fetchTasks|fetchTaskStoreTasks|fetchTaskStoreSessions|fetchSessions)\(\s*(\w+)/g;
const URL_VAR = /\/(tasks|sessions)\?\$\{(\w+)\}/g;
const QUERY_CALL =
  /\bclient\.query\(\s*(?:new URLSearchParams\(\{([^}]*)\}\)|(\w+)(\(\))?)/g;

/** Scan one file's text; exported shape lets the self-test plant strays. */
export function findStrays(text: string, file: string): Stray[] {
  const strays: Stray[] = [];
  const check = (endpoint: Endpoint, names: string[], via: string) => {
    for (const param of names) {
      if (!ENDPOINTS[endpoint].has(param)) {
        strays.push({ endpoint, param, via: `${file}: ${via}` });
      }
    }
  };

  // 1. URL literals: /tasks?a=1&b=2 (not /admin/tasks?..., which is an admin UI page).
  const lit = /\/(tasks|sessions)\?([^\s"'`)>|\\]*)/g;
  for (let m = lit.exec(text); m; m = lit.exec(text)) {
    const before = text.slice(Math.max(0, (m.index ?? 0) - 7), m.index);
    if (before.endsWith("/admin")) continue;
    check(m[1] as Endpoint, namesInQueryString(m[2] as string), m[0]);
  }

  // 2. Builders interpolated into the URL or passed to a fetch helper.
  const builderFor = (varName: string, upTo: number): string => {
    const decl = new RegExp(
      `(?:const|let)\\s+${varName}\\b[^=]*=\\s*new URLSearchParams\\(`,
      "g",
    );
    let start = -1;
    for (let d = decl.exec(text); d && d.index < upTo; d = decl.exec(text)) {
      start = d.index;
    }
    return start === -1 ? "" : text.slice(start, upTo);
  };
  for (let m = URL_VAR.exec(text); m; m = URL_VAR.exec(text)) {
    check(
      m[1] as Endpoint,
      namesInBuilder(builderFor(m[2] as string, m.index)),
      m[0],
    );
  }
  for (let m = HELPER_CALL.exec(text); m; m = HELPER_CALL.exec(text)) {
    const endpoint: Endpoint = /Sessions/.test(m[0]) ? "sessions" : "tasks";
    const block = builderFor(m[1] as string, m.index);
    // accountId is appended by the fetcher wrapper, never by callers.
    check(endpoint, namesInBuilder(block), m[0]);
  }
  for (let m = QUERY_CALL.exec(text); m; m = QUERY_CALL.exec(text)) {
    let names: string[];
    if (m[2] && m[3]) {
      // client.query(buildFoo()) — read the builder function's body.
      const fn = new RegExp(`function\\s+${m[2]}\\b[^{]*\\{`).exec(text);
      names = fn ? namesInBuilder(text.slice(fn.index, fn.index + 400)) : [];
    } else if (m[2]) {
      names = namesInBuilder(builderFor(m[2], m.index));
    } else {
      names = namesInBuilder(`new URLSearchParams({${m[1]}})`);
    }
    check("tasks", names, m[0]);
  }
  return strays;
}

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIR.has(name)) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) yield* walk(p);
    else if (EXTS.some((e) => name.endsWith(e)) && !SKIP_FILE.test(name))
      yield p;
  }
}

describe("findStrays (scanner self-check)", () => {
  it("flags an undocumented parameter in a URL literal", () => {
    const s = findStrays('curl "$U/tasks?status=pending&bogus=1"', "x.md");
    expect(s.map((x) => x.param)).toEqual(["bogus"]);
  });

  it("flags an undocumented key in a builder passed to a tasks URL", () => {
    const s = findStrays(
      [
        "const params = new URLSearchParams({ repo, nope: '1' });",
        "fetch(`$",
        "{b}/tasks?$",
        "{params}`)",
      ].join(""),
      "x.ts",
    );
    expect(s.map((x) => x.param)).toEqual(["nope"]);
  });

  it("flags .set() strays on a sessions fetch helper", () => {
    const s = findStrays(
      'const params = new URLSearchParams();\nparams.set("agent", "a");\nfetchTaskStoreSessions(params)',
      "x.ts",
    );
    expect(s.map((x) => x.param)).toEqual(["agent"]);
  });

  it("accepts documented params and ignores admin UI page URLs", () => {
    expect(
      findStrays("/tasks?repo=a&pr=1&limit=5 and /admin/tasks?view=table", "x"),
    ).toEqual([]);
  });
});

describe("repo-wide GET /tasks and GET /sessions caller audit (PLU-1.1)", () => {
  it("finds no caller sending an undocumented query parameter", () => {
    const strays: string[] = [];
    let scanned = 0;
    for (const d of SCAN_DIRS) {
      for (const file of walk(join(ROOT, d))) {
        scanned++;
        const text = readFileSync(file, "utf8");
        for (const s of findStrays(text, relative(ROOT, file))) {
          strays.push(`${s.endpoint} ?${s.param} (${s.via})`);
        }
      }
    }
    expect(scanned).toBeGreaterThan(100);
    expect(strays).toEqual([]);
  });
});

describe("generated MCP tools (PLU-1.1)", () => {
  it("only send query parameters the list endpoints accept", () => {
    for (const [path, endpoint] of [
      ["/tasks", "tasks"],
      ["/sessions", "sessions"],
    ] as const) {
      const tool = generatedTools.find(
        (t) => t.method === "GET" && t.pathTemplate === path,
      );
      expect(tool).toBeDefined();
      const stray = (tool?.queryParams ?? []).filter(
        (p) => !ENDPOINTS[endpoint].has(p),
      );
      expect(stray).toEqual([]);
    }
  });
});
