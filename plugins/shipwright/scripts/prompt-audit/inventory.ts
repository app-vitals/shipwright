/**
 * plugins/shipwright/scripts/prompt-audit/inventory.ts
 *
 * Walks a repo and inventories every prompt-bearing file (CLAUDE.md, rules,
 * skills, commands, agents, references, templates, docs), classifying when
 * each one enters the model's context — separately for a local-dev Claude
 * Code session and for the agent runtime.
 *
 * Pure core: all filesystem access goes through the injected `InventoryDeps`.
 */

import { type Frontmatter, parseFrontmatter } from "./frontmatter.ts";

export { parseFrontmatter };

export type ItemKind =
  | "claude-md"
  | "rule"
  | "import"
  | "skill"
  | "command"
  | "agent"
  | "reference"
  | "template"
  | "doc";

export type LoadClass =
  | "always"
  | "on-demand-path"
  | "on-invoke"
  | "on-reference"
  | "listing";

export type AuditContext = "local-dev" | "agent-runtime";

export const MAX_IMPORT_HOPS = 4;
export const AGENT_RUNTIME_ALWAYS_FILE = "agent/workspace/CLAUDE.md.template";

export interface InventoryDeps {
  /** Every file under root, as root-relative posix paths. */
  listFiles(root: string): string[];
  /** Contents of a root-relative path. */
  readFile(root: string, relPath: string): string;
}

export interface InventoryItem {
  path: string;
  kind: ItemKind;
  loadClass: Record<AuditContext, LoadClass>;
  name?: string;
  description?: string;
  descriptionChars: number;
  bodyLines: number;
  paths: string[];
  /** Resolved root-relative import targets (direct @ imports only). */
  imports: string[];
  /** Hops from an always-loaded root; 0 for non-imports. */
  importDepth: number;
}

const PROMOTABLE_KINDS = new Set<ItemKind>(["import", "template", "doc", "reference"]);
const SKIP_SEGMENTS = new Set(["node_modules", ".git"]);

function dirname(p: string): string {
  const i = p.lastIndexOf("/");
  return i < 0 ? "" : p.slice(0, i);
}

function basename(p: string): string {
  return p.slice(p.lastIndexOf("/") + 1);
}

function joinNormalized(dir: string, rel: string): string {
  const parts = (dir ? dir.split("/") : []).concat(rel.split("/"));
  const out: string[] = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return out.join("/");
}

/** Direct `@path` imports in a prompt file, ignoring fenced code and inline code. */
export function extractImports(body: string): string[] {
  const found: string[] = [];
  let fenced = false;
  for (const line of body.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const stripped = line.replace(/`[^`]*`/g, "");
    for (const m of stripped.matchAll(/(?:^|\s)@([\w./-]+\.[\w-]+)/g)) {
      found.push(m[1]);
    }
  }
  return found;
}

function classify(
  path: string,
  fm: Frontmatter,
): { kind: ItemKind; loadClass: Record<AuditContext, LoadClass> } | null {
  const file = basename(path);
  const lc = (local: LoadClass, runtime: LoadClass) => ({
    "local-dev": local,
    "agent-runtime": runtime,
  });
  if (path === AGENT_RUNTIME_ALWAYS_FILE) {
    return { kind: "claude-md", loadClass: lc("on-reference", "always") };
  }
  if (file === "CLAUDE.md") {
    // The agent's own context is its workspace template; a repo's CLAUDE.md is
    // only read when the agent works inside that repo.
    return {
      kind: "claude-md",
      loadClass: lc(
        dirname(path) === "" ? "always" : "on-demand-path",
        "on-reference",
      ),
    };
  }
  if (/(^|\/)\.claude\/rules\/.+\.md$/.test(path)) {
    const l = fm.paths.length > 0 ? "on-demand-path" : "always";
    return { kind: "rule", loadClass: lc(l, l) };
  }
  if (/\.test\.[cm]?[jt]sx?$/.test(file)) return null;
  if (/(^|\/)skills\/(?:[^/]+\/)?SKILL\.md$/.test(path)) {
    return { kind: "skill", loadClass: lc("listing", "listing") };
  }
  if (/(^|\/)commands\/[^/]+\.md$/.test(path)) {
    return { kind: "command", loadClass: lc("on-invoke", "on-invoke") };
  }
  if (/(^|\/)agents\/[^/]+\.md$/.test(path)) {
    return { kind: "agent", loadClass: lc("listing", "listing") };
  }
  if (/(^|\/)references\/.+\.md$/.test(path) || /(^|\/)skills\/.+\.md$/.test(path)) {
    return { kind: "reference", loadClass: lc("on-reference", "on-reference") };
  }
  if (file.endsWith(".template")) {
    return { kind: "template", loadClass: lc("on-reference", "on-reference") };
  }
  if (/(^|\/)docs\/.+\.md$/.test(path)) {
    return { kind: "doc", loadClass: lc("on-reference", "on-reference") };
  }
  return null;
}

export function walkInventory(root: string, deps: InventoryDeps): InventoryItem[] {
  const files = deps
    .listFiles(root)
    .filter((p) => !p.split("/").some((seg) => SKIP_SEGMENTS.has(seg)))
    .sort();
  const fileSet = new Set(files);
  const items = new Map<string, InventoryItem>();

  for (const path of files) {
    if (!/\.(md|template)$/.test(path)) continue;
    const fm = parseFrontmatter(deps.readFile(root, path));
    const cls = classify(path, fm);
    if (!cls) continue;
    const description = fm.description;
    items.set(path, {
      path,
      kind: cls.kind,
      loadClass: cls.loadClass,
      name: fm.name,
      description,
      descriptionChars: description?.length ?? 0,
      bodyLines: fm.body.replace(/\n+$/, "").split("\n").length,
      paths: fm.paths,
      imports: resolveImports(path, fm.body, fileSet),
      importDepth: 0,
    });
  }

  for (const context of ["local-dev", "agent-runtime"] as const) {
    const roots = [...items.values()].filter((i) => i.loadClass[context] === "always");
    followImports(roots, context, items, deps, root, fileSet);
  }
  return [...items.values()];
}

function resolveImports(from: string, body: string, fileSet: Set<string>): string[] {
  const out: string[] = [];
  for (const target of extractImports(body)) {
    const resolved = joinNormalized(dirname(from), target);
    // Workspace templates import the rendered name (@SOUL.md -> SOUL.md.template).
    const hit = [resolved, `${resolved}.template`].find((c) => fileSet.has(c));
    if (hit) out.push(hit);
  }
  return out;
}

function followImports(
  roots: InventoryItem[],
  context: AuditContext,
  items: Map<string, InventoryItem>,
  deps: InventoryDeps,
  root: string,
  fileSet: Set<string>,
): void {
  const seen = new Set(roots.map((r) => r.path));
  let frontier = roots;
  for (let hop = 1; hop <= MAX_IMPORT_HOPS; hop++) {
    const next: InventoryItem[] = [];
    for (const parent of frontier) {
      for (const target of parent.imports) {
        if (seen.has(target)) continue;
        seen.add(target);
        let item = items.get(target);
        if (!item) {
          const fm = parseFrontmatter(deps.readFile(root, target));
          item = {
            path: target,
            kind: "import",
            loadClass: { "local-dev": "on-reference", "agent-runtime": "on-reference" },
            name: fm.name,
            description: fm.description,
            descriptionChars: fm.description?.length ?? 0,
            bodyLines: fm.body.replace(/\n+$/, "").split("\n").length,
            paths: fm.paths,
            imports: resolveImports(target, fm.body, fileSet),
            importDepth: 0,
          };
          items.set(target, item);
        }
        if (PROMOTABLE_KINDS.has(item.kind)) {
          item.kind = "import";
          item.loadClass[context] = "always";
          item.importDepth = Math.max(item.importDepth, hop);
        }
        next.push(item);
      }
    }
    frontier = next;
  }
}
