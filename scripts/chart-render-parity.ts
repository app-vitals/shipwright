// Render-parity gate for Helm chart moves/renames (CHM-1.2).
//
// Renders a chart at two refs (git ref or directory) with the same values file,
// normalizes only the `helm.sh/chart` label (it embeds the chart name/version) —
// both as an object key and as text inside embedded-manifest string values, e.g.
// the Issuer carried by the cert-manager bootstrap ConfigMap — and diffs the resulting object sets and fields. Exits non-zero on any name,
// namespace, or field change; zero when only the chart label differs.
//
// CLI:
//   bun run scripts/chart-render-parity.ts --base <ref|dir> --head <ref|dir> \
//     --values <file> [--values <file> ...] [--chart charts/shipwright] \
//     [--names-file <path>] [--release shipwright] [--namespace shipwright]
//
// --base/--head: an existing directory is used as the chart dir itself; anything
// else is a git ref, from which `--chart` is extracted with `git archive`.
// --values paths are resolved once and applied to both renders.
// --names-file: one `Kind/namespace/name` per line (# comments allowed); every
// entry must still render at --head. The prod golden list is private — pass its
// path here; repo fixtures use synthetic data.
//
// Fields that differ between two renders of the same base (randomly generated
// secrets/certs) are treated as nondeterministic and ignored; any other value
// change is reported.

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

type Json = unknown;
type Doc = Record<string, Json>;

const CHART_LABEL = "helm.sh/chart";

// Embedded manifests (e.g. a ConfigMap carrying a rendered Issuer) hold the label
// as text inside a string value; blank only its value so the rest still diffs.
const EMBEDDED_CHART_LABEL = /^(\s*helm\.sh\/chart:).*$/gm;

/** Drop every `helm.sh/chart` key, at any depth, and blank it inside embedded YAML strings. */
export function normalize(value: Json): Json {
  if (typeof value === "string")
    return value.replace(EMBEDDED_CHART_LABEL, "$1");
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object") {
    const out: Doc = {};
    for (const [k, v] of Object.entries(value as Doc)) {
      if (k !== CHART_LABEL) out[k] = normalize(v);
    }
    return out;
  }
  return value;
}

export function objectKey(doc: Doc): string {
  const meta = (doc.metadata ?? {}) as Doc;
  return `${doc.kind}/${meta.namespace ?? ""}/${meta.name}`;
}

/** Parse `helm template` output into normalized objects keyed by kind/namespace/name. */
export function parseRendered(text: string): Map<string, Json> {
  const objects = new Map<string, Json>();
  // Bun.YAML.parse returns an array for multi-document input, a bare value for one.
  const parsed = Bun.YAML.parse(text);
  for (const doc of Array.isArray(parsed) ? parsed : [parsed]) {
    if (!doc || typeof doc !== "object") continue;
    const key = objectKey(doc as Doc);
    if (objects.has(key)) throw new Error(`duplicate object in render: ${key}`);
    objects.set(key, normalize(doc));
  }
  return objects;
}

export type DiffEntry = {
  kind: "removed" | "added" | "changed";
  /** Object key (kind/namespace/name); empty for pure value diffs. */
  object: string;
  path: string;
  text: string;
};

/** Field-level diff of two JSON values; one entry per differing path. */
export function diffValues(
  a: Json,
  b: Json,
  path = "",
  object = "",
): DiffEntry[] {
  const entry = (
    kind: DiffEntry["kind"],
    p: string,
    text: string,
  ): DiffEntry => ({ kind, object, path: p, text });
  if (Array.isArray(a) && Array.isArray(b)) {
    const out: DiffEntry[] = [];
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      const p = `${path}[${i}]`;
      if (i >= a.length)
        out.push(entry("added", p, `${p}: added ${JSON.stringify(b[i])}`));
      else if (i >= b.length)
        out.push(entry("removed", p, `${p}: removed ${JSON.stringify(a[i])}`));
      else out.push(...diffValues(a[i], b[i], p, object));
    }
    return out;
  }
  if (
    a &&
    b &&
    typeof a === "object" &&
    typeof b === "object" &&
    !Array.isArray(a) &&
    !Array.isArray(b)
  ) {
    const ao = a as Doc;
    const bo = b as Doc;
    const out: DiffEntry[] = [];
    for (const k of [
      ...new Set([...Object.keys(ao), ...Object.keys(bo)]),
    ].sort()) {
      const p = path ? `${path}.${k}` : k;
      if (!(k in bo))
        out.push(entry("removed", p, `${p}: removed ${JSON.stringify(ao[k])}`));
      else if (!(k in ao))
        out.push(entry("added", p, `${p}: added ${JSON.stringify(bo[k])}`));
      else out.push(...diffValues(ao[k], bo[k], p, object));
    }
    return out;
  }
  return JSON.stringify(a) === JSON.stringify(b)
    ? []
    : [
        entry(
          "changed",
          path,
          `${path}: ${JSON.stringify(a)} -> ${JSON.stringify(b)}`,
        ),
      ];
}

/** Diff two rendered object sets: missing/extra objects, then per-object field diffs. */
export function diffObjectSets(
  base: Map<string, Json>,
  head: Map<string, Json>,
): DiffEntry[] {
  const out: DiffEntry[] = [];
  for (const key of [...base.keys()].sort()) {
    if (!head.has(key))
      out.push({
        kind: "removed",
        object: key,
        path: "",
        text: `- ${key}: no longer renders`,
      });
  }
  for (const key of [...head.keys()].sort()) {
    if (!base.has(key))
      out.push({
        kind: "added",
        object: key,
        path: "",
        text: `+ ${key}: newly rendered`,
      });
  }
  for (const key of [...base.keys()].sort()) {
    if (!head.has(key)) continue;
    for (const e of diffValues(base.get(key), head.get(key), "", key))
      out.push({ ...e, text: `~ ${key}: ${e.text}` });
  }
  return out;
}

/**
 * Fields whose value changes between two renders of the same chart (randomly
 * generated secrets, certs): `object|path` of every `changed` entry. Masking
 * only these keeps real value changes visible while ignoring nondeterminism.
 */
export function nondeterministicFields(
  renderA: Map<string, Json>,
  renderB: Map<string, Json>,
): Set<string> {
  return new Set(
    diffObjectSets(renderA, renderB)
      .filter((e) => e.kind === "changed")
      .map((e) => `${e.object}|${e.path}`),
  );
}

export function dropNoise(
  entries: DiffEntry[],
  noise: Set<string>,
): DiffEntry[] {
  return entries.filter(
    (e) => !(e.kind === "changed" && noise.has(`${e.object}|${e.path}`)),
  );
}

export function parseNamesFile(text: string): string[] {
  return text
    .split("\n")
    .map((l) => l.replace(/#.*/, "").trim())
    .filter(Boolean);
}

export function missingNames(
  names: string[],
  rendered: Map<string, Json>,
): string[] {
  return names.filter((n) => !rendered.has(n));
}

function run(cmd: string, args: string[], opts: { cwd?: string } = {}): Buffer {
  const r = spawnSync(cmd, args, { ...opts, maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0) {
    throw new Error(
      `${cmd} ${args.join(" ")} failed:\n${r.stderr?.toString() ?? r.error}`,
    );
  }
  return r.stdout;
}

/** Resolve a ref-or-dir to a chart directory; refs are extracted under `tmp`. */
function resolveChart(
  refOrDir: string,
  chart: string,
  tmp: string,
  label: string,
): string {
  if (existsSync(refOrDir) && statSync(refOrDir).isDirectory())
    return resolve(refOrDir);
  const dest = join(tmp, label);
  run("mkdir", ["-p", dest]);
  const tar = run("git", ["archive", refOrDir, chart]);
  const r = spawnSync("tar", ["-x", "-C", dest], { input: tar });
  if (r.status !== 0) throw new Error(`tar extract failed: ${r.stderr}`);
  return join(dest, chart);
}

export function render(
  chartDir: string,
  valuesFile: string,
  release: string,
  namespace: string,
): Map<string, Json> {
  const out = run("helm", [
    "template",
    release,
    chartDir,
    "--namespace",
    namespace,
    "-f",
    valuesFile,
  ]);
  return parseRendered(out.toString());
}

function parseArgs(argv: string[]) {
  const a = {
    values: [] as string[],
    chart: "charts/shipwright",
    release: "shipwright",
    namespace: "shipwright",
  } as {
    base?: string;
    head?: string;
    values: string[];
    chart: string;
    namesFile?: string;
    release: string;
    namespace: string;
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const val = argv[++i];
    if (val === undefined) throw new Error(`missing value for ${flag}`);
    if (flag === "--base") a.base = val;
    else if (flag === "--head") a.head = val;
    else if (flag === "--values") a.values.push(resolve(val));
    else if (flag === "--chart") a.chart = val;
    else if (flag === "--names-file") a.namesFile = resolve(val);
    else if (flag === "--release") a.release = val;
    else if (flag === "--namespace") a.namespace = val;
    else throw new Error(`unknown flag ${flag}`);
  }
  if (!a.base || !a.head || a.values.length === 0) {
    throw new Error(
      "usage: --base <ref|dir> --head <ref|dir> --values <file> [--values ...] [--chart p] [--names-file f]",
    );
  }
  return a;
}

function main(): number {
  const args = parseArgs(process.argv.slice(2));
  const tmp = mkdtempSync(join(tmpdir(), "chart-parity-"));
  let failed = false;
  try {
    const baseDir = resolveChart(args.base as string, args.chart, tmp, "base");
    const headDir = resolveChart(args.head as string, args.chart, tmp, "head");
    const names = args.namesFile
      ? parseNamesFile(readFileSync(args.namesFile, "utf8"))
      : [];
    for (const values of args.values) {
      const base = render(baseDir, values, args.release, args.namespace);
      const head = render(headDir, values, args.release, args.namespace);
      const noise = nondeterministicFields(
        base,
        render(baseDir, values, args.release, args.namespace),
      );
      const problems = dropNoise(diffObjectSets(base, head), noise).map(
        (e) => e.text,
      );
      const missing = missingNames(names, head);
      if (problems.length === 0 && missing.length === 0) {
        console.log(`✓ ${values}: ${head.size} objects identical`);
        continue;
      }
      failed = true;
      console.error(`✗ ${values}`);
      for (const p of problems) console.error(`  ${p}`);
      for (const m of missing)
        console.error(`  ! ${m}: listed in names-file but does not render`);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  return failed ? 1 : 0;
}

if (import.meta.main) {
  try {
    process.exit(main());
  } catch (e) {
    console.error((e as Error).message);
    process.exit(2);
  }
}
