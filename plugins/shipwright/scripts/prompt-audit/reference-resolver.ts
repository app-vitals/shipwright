/**
 * plugins/shipwright/scripts/prompt-audit/reference-resolver.ts
 *
 * Stale-fact detection for prompt files. Extracts the concrete things a prompt
 * names (file paths, task/script commands, slash-command flags, model ids, env
 * vars), resolves each against the repo, and reports the ones that no longer
 * exist. Also finds "auto-maintained" sections whose writer has been removed.
 *
 * Pure core: all filesystem access goes through the injected `ResolverDeps`.
 */

import { type InventoryDeps, walkInventory } from "./inventory.ts";

export type RefKind = "path" | "command" | "flag" | "model-id" | "env-var";

export type ResolverRule =
  | "unresolvable-path"
  | "unresolvable-command"
  | "unknown-flag"
  | "retired-model-id"
  | "unresolvable-env-var";

const RULE_BY_KIND: Record<RefKind, ResolverRule> = {
  path: "unresolvable-path",
  command: "unresolvable-command",
  flag: "unknown-flag",
  "model-id": "retired-model-id",
  "env-var": "unresolvable-env-var",
};

export interface ResolverDeps extends InventoryDeps {
  /** Keys of `RATES` in lib/pricing.ts — the model ids that still price. */
  rateKeys: string[];
}

export interface Reference {
  kind: RefKind;
  value: string;
  /** 1-based line in the source file. */
  line: number;
  /** Slash-command stub name, for `flag` references. */
  command?: string;
}

export interface UnresolvedReference extends Reference {
  rule: ResolverRule;
  file: string;
  reason: string;
}

export interface OrphanedAutoSection {
  file: string;
  line: number;
  /** Nearest preceding heading, when there is one. */
  heading?: string;
  banner: string;
}

const PATH_EXTENSIONS =
  "md|ts|tsx|js|jsx|json|ya?ml|sh|toml|prisma|template|sql";
const PATH_RE = new RegExp(
  `^[A-Za-z0-9_.-][\\w./-]*/[\\w./-]*\\.(?:${PATH_EXTENSIONS})$`,
);
const DIR_RE = /^[A-Za-z0-9_.-][\w./-]*\/$/;
const MODEL_RE =
  /\bclaude-(?:opus|sonnet|haiku|fable)-\d+(?:-\d+)?(?:-\d{8})?\b/g;
const ENV_RE =
  /\$\{?([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)\}?|`([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)`/g;
const SCRIPT_CMD_RE =
  /^(?:\$\s+)?(task|(?:bun|npm|pnpm|yarn) run)\s+([\w:.-]+)/;
const SLASH_CMD_RE = /\/shipwright:([a-z][\w-]*)((?:\s+--[\w-]+)*)/g;
const SCRIPT_FILE_RE = /\.(?:ts|js|sh|mjs)$/;
const WRITER_IGNORE = [/\.test\./, /^planning\//];
const BANNER_RE = /auto-maintained/i;
const SOURCE_EXT_RE =
  /\.(?:ts|tsx|js|jsx|mjs|ya?ml|json|sh|toml|template|example|env)$/;
/** Env vars set by the platform or CI rather than by anything in this repo. */
const EXTERNAL_ENV = new Set([
  "GITHUB_TOKEN",
  "GITHUB_OUTPUT",
  "GITHUB_SHA",
  "GITHUB_REPOSITORY",
]);

const MD_FILE_RE = /\.(?:md|template)$/;

function stripAt(token: string): string {
  return token.startsWith("@") ? token.slice(1) : token;
}

function trimPunctuation(token: string): string {
  return token.replace(/^[("'`[]+/, "").replace(/[)"'`\],.;:!?]+$/, "");
}

/** Lines with their fence/inline-code context, so command refs can be anchored. */
function scanLines(
  body: string,
): { text: string; line: number; spans: string[]; fenced: boolean }[] {
  const out: {
    text: string;
    line: number;
    spans: string[];
    fenced: boolean;
  }[] = [];
  let fenced = false;
  const lines = body.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i];
    if (/^\s*(```|~~~)/.test(text)) {
      fenced = !fenced;
      continue;
    }
    const spans = fenced
      ? [text.trim()]
      : [...text.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
    out.push({ text, line: i + 1, spans, fenced });
  }
  return out;
}

export function extractReferences(body: string): Reference[] {
  const refs: Reference[] = [];
  const seen = new Set<string>();
  const add = (ref: Reference) => {
    const key = `${ref.kind}|${ref.value}|${ref.command ?? ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    refs.push(ref);
  };

  for (const { text, line, spans } of scanLines(body)) {
    for (const raw of text.split(/\s+/)) {
      const token = stripAt(trimPunctuation(raw));
      if (/[*{}<>$:]|^~|^\//.test(token)) continue;
      if (PATH_RE.test(token) || DIR_RE.test(token)) {
        add({ kind: "path", value: token, line });
      }
    }
    for (const span of spans) {
      const cmd = SCRIPT_CMD_RE.exec(span);
      if (cmd && !SCRIPT_FILE_RE.test(cmd[2]) && !/[/{<$]/.test(cmd[2])) {
        add({ kind: "command", value: `${cmd[1]} ${cmd[2]}`, line });
      }
    }
    for (const m of text.matchAll(MODEL_RE))
      add({ kind: "model-id", value: m[0], line });
    for (const m of text.matchAll(ENV_RE))
      add({ kind: "env-var", value: m[1] ?? m[2], line });
    for (const m of text.matchAll(SLASH_CMD_RE)) {
      const name = m[1];
      add({ kind: "command", value: `/shipwright:${name}`, line });
      for (const flag of m[2].match(/--[\w-]+/g) ?? []) {
        add({ kind: "flag", value: flag, line, command: name });
      }
    }
  }
  return refs;
}

/** Top-level task names from a Taskfile.yml (`tasks:` map, two-space keys). */
export function parseTaskNames(taskfile: string): Set<string> {
  const names = new Set<string>();
  let inTasks = false;
  for (const line of taskfile.split("\n")) {
    if (/^tasks:\s*$/.test(line)) {
      inTasks = true;
      continue;
    }
    if (inTasks && /^\S/.test(line)) inTasks = false;
    const m = inTasks ? /^ {2}["']?([\w:.-]+)["']?:\s*$/.exec(line) : null;
    if (m) names.add(m[1]);
  }
  return names;
}

function packageScripts(json: string): Set<string> {
  try {
    const parsed = JSON.parse(json) as { scripts?: Record<string, string> };
    return new Set(Object.keys(parsed.scripts ?? {}));
  } catch {
    return new Set();
  }
}

function normalizeModelId(id: string): string {
  return id.replace(/-\d{8}$/, "");
}

interface RepoIndex {
  files: string[];
  fileSet: Set<string>;
  tasks: Set<string> | null;
  scripts: Set<string> | null;
  /** Slash-command name -> declared flags (frontmatter hint + body). */
  commandFlags: Map<string, Set<string>>;
  skillNames: Set<string>;
  rateKeys: Set<string>;
  envVars: Set<string> | null;
}

function buildIndex(root: string, deps: ResolverDeps): RepoIndex {
  const files = deps
    .listFiles(root)
    .filter(
      (p) => !p.split("/").some((s) => s === "node_modules" || s === ".git"),
    );
  const fileSet = new Set(files);
  const commandFlags = new Map<string, Set<string>>();
  const skillNames = new Set<string>();
  for (const path of files) {
    const cmd = /(?:^|\/)commands\/([^/]+)\.md$/.exec(path);
    if (cmd) {
      const flags = new Set(deps.readFile(root, path).match(/--[\w-]+/g) ?? []);
      commandFlags.set(cmd[1], flags);
    }
    const skill = /(?:^|\/)skills\/([^/]+)\/SKILL\.md$/.exec(path);
    if (skill) skillNames.add(skill[1]);
  }
  return {
    files,
    fileSet,
    tasks: fileSet.has("Taskfile.yml")
      ? parseTaskNames(deps.readFile(root, "Taskfile.yml"))
      : null,
    scripts: fileSet.has("package.json")
      ? packageScripts(deps.readFile(root, "package.json"))
      : null,
    commandFlags,
    skillNames,
    rateKeys: new Set(deps.rateKeys),
    envVars: null,
  };
}

function envVarsInSource(
  root: string,
  deps: ResolverDeps,
  index: RepoIndex,
): Set<string> {
  if (index.envVars) return index.envVars;
  const found = new Set<string>();
  for (const path of index.files) {
    if (!SOURCE_EXT_RE.test(path) || WRITER_IGNORE.some((re) => re.test(path)))
      continue;
    for (const m of deps
      .readFile(root, path)
      .matchAll(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g)) {
      found.add(m[0]);
    }
  }
  index.envVars = found;
  return found;
}

function pathExists(index: RepoIndex, from: string, value: string): boolean {
  const dir = from.includes("/") ? from.slice(0, from.lastIndexOf("/")) : "";
  const candidates = [value, dir ? `${dir}/${value}` : value];
  return candidates.some((c) => {
    const norm = c.replace(/\/$/, "");
    return (
      index.fileSet.has(norm) ||
      index.files.some((f) => f.startsWith(`${norm}/`))
    );
  });
}

function resolveOne(
  ref: Reference,
  file: string,
  root: string,
  deps: ResolverDeps,
  index: RepoIndex,
): string | null {
  switch (ref.kind) {
    case "path":
      return pathExists(index, file, ref.value)
        ? null
        : "no such file or directory";
    case "model-id":
      return index.rateKeys.has(normalizeModelId(ref.value))
        ? null
        : "model id has no entry in RATES (retired or unknown)";
    case "env-var":
      if (EXTERNAL_ENV.has(ref.value)) return null;
      return envVarsInSource(root, deps, index).has(ref.value)
        ? null
        : "env var not referenced by any source file";
    case "flag": {
      const flags = ref.command
        ? index.commandFlags.get(ref.command)
        : undefined;
      // An unknown command is reported on its own reference; don't double-report.
      if (!flags) return null;
      return flags.has(ref.value)
        ? null
        : `flag not declared in the ${ref.command} command stub`;
    }
    case "command": {
      if (ref.value.startsWith("/shipwright:")) {
        const name = ref.value.slice("/shipwright:".length);
        return index.commandFlags.has(name) || index.skillNames.has(name)
          ? null
          : "no command or skill with this name";
      }
      const [runner, name] = ref.value.split(/\s+(?=[^\s]+$)/);
      if (runner === "task") {
        if (!index.tasks) return null;
        return index.tasks.has(name) ? null : "no such task in Taskfile.yml";
      }
      if (!index.scripts) return null;
      return index.scripts.has(name) ? null : "no such script in package.json";
    }
  }
}

/** Resolve every reference in `paths` (default: all inventoried prompt files). */
export function resolveReferences(
  root: string,
  deps: ResolverDeps,
  paths?: string[],
): UnresolvedReference[] {
  const targets = paths ?? walkInventory(root, deps).map((i) => i.path);
  const index = buildIndex(root, deps);
  const out: UnresolvedReference[] = [];
  for (const file of targets) {
    for (const ref of extractReferences(deps.readFile(root, file))) {
      const reason = resolveOne(ref, file, root, deps, index);
      if (reason)
        out.push({ ...ref, rule: RULE_BY_KIND[ref.kind], file, reason });
    }
  }
  return out;
}

/**
 * Markdown sections that claim to be auto-maintained but whose writer is gone:
 * no file other than the section's own (excluding tests and planning docs)
 * mentions its heading, or its banner when there is no heading.
 */
export function findOrphanedAutoSections(
  root: string,
  deps: InventoryDeps,
): OrphanedAutoSection[] {
  const files = deps
    .listFiles(root)
    .filter(
      (p) => !p.split("/").some((s) => s === "node_modules" || s === ".git"),
    )
    .sort();
  const contents = new Map(files.map((p) => [p, deps.readFile(root, p)]));
  const out: OrphanedAutoSection[] = [];

  for (const file of files) {
    if (!MD_FILE_RE.test(file) || WRITER_IGNORE.some((re) => re.test(file)))
      continue;
    let heading: string | undefined;
    const lines = (contents.get(file) ?? "").split("\n");
    for (let i = 0; i < lines.length; i++) {
      const h = /^#{1,6}\s+(.+?)\s*$/.exec(lines[i]);
      if (h) {
        heading = h[1];
        continue;
      }
      if (!BANNER_RE.test(lines[i])) continue;
      const banner = lines[i].trim();
      const needle = heading ?? banner;
      const hasWriter = files.some(
        (other) =>
          other !== file &&
          !WRITER_IGNORE.some((re) => re.test(other)) &&
          (contents.get(other) ?? "").includes(needle),
      );
      if (!hasWriter) out.push({ file, line: i + 1, heading, banner });
    }
  }
  return out;
}
