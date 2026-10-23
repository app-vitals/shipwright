/**
 * admin/src/specialty-manifest-loader.ts
 *
 * SpecialtyRegistry — resolves an agent's stored `typeName` to its parsed
 * Specialty manifest by loading `specialties/{typeName}/manifest.yaml` from
 * disk (relative to the repo root) and validating it via
 * parseSpecialtyManifest().
 *
 * This is the runtime source of truth for an agent's default system crons
 * (and, in time, its default plugins/tools/env contract). It replaces the
 * former hardcoded SYSTEM_CRONS array in admin/src/system-crons.ts.
 *
 * Fallback contract: an unknown `typeName` (a value with no matching
 * directory under specialties/) resolves to the "coding" manifest with a
 * logged warning — never throws. This keeps the boot-path
 * POST /agents/:id/crons/reconcile route from beginning to 5xx for an agent
 * whose type was renamed or removed.
 *
 * Hard-failure contract: if the "coding" manifest itself (the universal
 * fallback) cannot be loaded or fails validation, that is a startup-time bug
 * and the error propagates — we never silently degrade the fallback into a
 * no-op that would strip every agent's system crons.
 *
 * The class takes an injectable reader/warner so unit tests can drive it
 * without touching the filesystem (see agent-cron-jobs.unit.test.ts).
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type SpecialtyManifest,
  parseSpecialtyManifest,
} from "./specialty-registry.ts";

/** The universal fallback type — every agent degrades to this manifest. */
export const DEFAULT_SPECIALTY_NAME = "coding";

/** Reads a manifest's raw YAML text for a type; throws if it does not exist. */
type ManifestReader = (typeName: string) => string;

/** Sink for the unknown-typeName warning (defaults to console.warn). */
type WarnFn = (message: string) => void;

/**
 * Lists the typeName of every discoverable specialty directory (e.g. the
 * names of the subdirectories under specialties/). Used by listTypes() to
 * discover candidates before resolving each one's manifest via `read`.
 */
type TypeDirLister = () => string[];

/** A discovered specialty, as surfaced to the new-specialty picker. */
export interface SpecialtyOption {
  name: string;
  displayName: string;
}

/**
 * Repo root resolved relative to this module (admin/src/ → ../../). The
 * specialties/ directory lives at the repo root alongside admin/.
 */
const REPO_ROOT = join(import.meta.dir, "..", "..");
const BUILT_IN_SPECIALTIES_DIR = join(REPO_ROOT, "specialties");

/**
 * The specialties directory: SHIPWRIGHT_SPECIALTIES_DIR when set, else the
 * repo-root specialties/ (today's location).
 */
export function resolveSpecialtiesDir(
  env: Record<string, string | undefined> = process.env,
): string {
  return env.SHIPWRIGHT_SPECIALTIES_DIR || BUILT_IN_SPECIALTIES_DIR;
}

/**
 * The universal fallback type: SHIPWRIGHT_DEFAULT_AGENT_TYPE when set, else
 * "coding".
 */
export function resolveDefaultSpecialtyName(
  env: Record<string, string | undefined> = process.env,
): string {
  return env.SHIPWRIGHT_DEFAULT_AGENT_TYPE || DEFAULT_SPECIALTY_NAME;
}

/** Default reader: loads {typesDir}/{typeName}/manifest.yaml from disk. */
export function defaultManifestReader(
  typeName: string,
  typesDir: string = resolveSpecialtiesDir(),
): string {
  return readFileSync(join(typesDir, typeName, "manifest.yaml"), "utf-8");
}

/** Default lister: the directory names under the specialties dir on disk. */
export function defaultTypeDirLister(
  typesDir: string = resolveSpecialtiesDir(),
): string[] {
  return readdirSync(typesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

/**
 * Interface the reconcile path depends on — kept narrow so tests can supply a
 * trivial double without constructing the real disk-backed registry.
 */
export interface SpecialtyManifestResolver {
  /**
   * Resolve `typeName` to its parsed manifest. Falls back to the "coding"
   * manifest (with a warning) when the type is unknown. Never throws for an
   * unknown type — only if the "coding" fallback itself fails to load.
   */
  getManifest(typeName: string): SpecialtyManifest;
  /**
   * Resolve `typeName` to its parsed manifest WITHOUT falling back to
   * "coding" — returns undefined for an unknown type instead. No warning is
   * logged (an unknown type here is an expected, callers-handle-it outcome,
   * not a degraded-boot condition). Used by POST /admin/agents to reject an
   * unknown requested `type` with 400 rather than silently seeding a
   * "coding" agent under a different label.
   */
  tryGetManifest(typeName: string): SpecialtyManifest | undefined;
  /**
   * Discover every specialty directory (via the injected `list` fn) and
   * resolve each to its {name, displayName} for populating the new-agent
   * type picker. A directory whose manifest fails to load or parse is
   * skipped (not thrown) — the picker still renders every other valid type
   * rather than 500ing the whole /admin/agents/new page over one bad
   * manifest. Order matches the underlying `list` fn's order.
   */
  listTypes(): SpecialtyOption[];
}

export class SpecialtyRegistry implements SpecialtyManifestResolver {
  private readonly read: ManifestReader;
  private readonly warn: WarnFn;
  private readonly list: TypeDirLister;
  private readonly defaultTypeName: string;
  private readonly cache = new Map<string, SpecialtyManifest>();

  /**
   * `typesDir` and `defaultTypeName` default to SHIPWRIGHT_SPECIALTIES_DIR /
   * SHIPWRIGHT_DEFAULT_AGENT_TYPE, then to today's repo-root specialties/
   * and "coding". An injected `read`/`list` takes precedence over `typesDir`.
   */
  constructor(
    opts: {
      read?: ManifestReader;
      warn?: WarnFn;
      list?: TypeDirLister;
      typesDir?: string;
      defaultTypeName?: string;
    } = {},
  ) {
    const typesDir = opts.typesDir ?? resolveSpecialtiesDir();
    this.read = opts.read ?? ((name) => defaultManifestReader(name, typesDir));
    this.warn = opts.warn ?? ((m) => console.warn(m));
    this.list = opts.list ?? (() => defaultTypeDirLister(typesDir));
    this.defaultTypeName =
      opts.defaultTypeName ?? resolveDefaultSpecialtyName();
  }

  getManifest(typeName: string): SpecialtyManifest {
    const resolved = this.tryLoad(typeName);
    if (resolved) return resolved;

    // Unknown type — warn once and fall back to "coding". The fallback load is
    // deliberately NOT wrapped in tryLoad: if "coding" can't load, that's a
    // hard startup bug and must surface, not silently become a no-op.
    this.warn(
      `SpecialtyRegistry: unknown agent typeName "${typeName}" — ` +
        `falling back to "${this.defaultTypeName}" manifest`,
    );
    if (typeName === this.defaultTypeName) {
      // Guard against infinite intent: the default itself failed to load.
      throw new Error(
        `SpecialtyRegistry: the default "${this.defaultTypeName}" manifest failed to load — this is a startup-time bug`,
      );
    }
    return this.loadOrThrow(this.defaultTypeName);
  }

  /**
   * Resolve `typeName` without falling back to "coding" — see the interface
   * doc comment. Thin public wrapper around the existing tryLoad() used
   * internally by getManifest().
   */
  tryGetManifest(typeName: string): SpecialtyManifest | undefined {
    return this.tryLoad(typeName);
  }

  listTypes(): SpecialtyOption[] {
    const typeNames = this.list();
    const options: SpecialtyOption[] = [];
    for (const typeName of typeNames) {
      const manifest = this.tryLoad(typeName);
      if (!manifest) continue;
      options.push({
        name: manifest.metadata.name,
        displayName: manifest.metadata.displayName,
      });
    }
    return options;
  }

  /** Load + cache a manifest, returning undefined only if the file is missing. */
  private tryLoad(typeName: string): SpecialtyManifest | undefined {
    const cached = this.cache.get(typeName);
    if (cached) return cached;
    let raw: string;
    try {
      raw = this.read(typeName);
    } catch {
      return undefined;
    }
    return this.parseAndCache(typeName, raw);
  }

  /** Load + cache a manifest, propagating any read/parse error. */
  private loadOrThrow(typeName: string): SpecialtyManifest {
    const cached = this.cache.get(typeName);
    if (cached) return cached;
    return this.parseAndCache(typeName, this.read(typeName));
  }

  private parseAndCache(typeName: string, raw: string): SpecialtyManifest {
    const manifest = parseSpecialtyManifest(raw);
    this.cache.set(typeName, manifest);
    return manifest;
  }
}
