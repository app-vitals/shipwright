/**
 * admin/src/agent-type-manifest-loader.ts
 *
 * AgentTypeRegistry — resolves an agent's stored `typeName` to its parsed
 * AgentType manifest by loading `agent-types/{typeName}/manifest.yaml` from
 * disk (relative to the repo root) and validating it via
 * parseAgentTypeManifest().
 *
 * This is the runtime source of truth for an agent's default system crons
 * (and, in time, its default plugins/tools/env contract). It replaces the
 * former hardcoded SYSTEM_CRONS array in admin/src/system-crons.ts.
 *
 * Fallback contract: an unknown `typeName` (a value with no matching
 * directory under agent-types/) resolves to the "coding" manifest with a
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

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  type AgentTypeManifest,
  parseAgentTypeManifest,
} from "./agent-type-registry.ts";

/** The universal fallback type — every agent degrades to this manifest. */
export const DEFAULT_AGENT_TYPE_NAME = "coding";

/** Reads a manifest's raw YAML text for a type; throws if it does not exist. */
export type ManifestReader = (typeName: string) => string;

/** Sink for the unknown-typeName warning (defaults to console.warn). */
export type WarnFn = (message: string) => void;

/**
 * Lists the typeName of every discoverable agent type directory (e.g. the
 * names of the subdirectories under agent-types/). Used by listTypes() to
 * discover candidates before resolving each one's manifest via `read`.
 */
export type TypeDirLister = () => string[];

/** A discovered agent type, as surfaced to the new-agent type picker. */
export interface AgentTypeOption {
  name: string;
  displayName: string;
}

/**
 * Repo root resolved relative to this module (admin/src/ → ../../). The
 * agent-types/ directory lives at the repo root alongside admin/.
 */
const REPO_ROOT = join(import.meta.dir, "..", "..");
const AGENT_TYPES_DIR = join(REPO_ROOT, "agent-types");

/** Default reader: loads agent-types/{typeName}/manifest.yaml from disk. */
export function defaultManifestReader(typeName: string): string {
  const path = join(REPO_ROOT, "agent-types", typeName, "manifest.yaml");
  return readFileSync(path, "utf-8");
}

/** Default lister: the directory names under agent-types/ on disk. */
export function defaultTypeDirLister(): string[] {
  return readdirSync(AGENT_TYPES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

/**
 * Interface the reconcile path depends on — kept narrow so tests can supply a
 * trivial double without constructing the real disk-backed registry.
 */
export interface AgentTypeManifestResolver {
  /**
   * Resolve `typeName` to its parsed manifest. Falls back to the "coding"
   * manifest (with a warning) when the type is unknown. Never throws for an
   * unknown type — only if the "coding" fallback itself fails to load.
   */
  getManifest(typeName: string): AgentTypeManifest;
  /**
   * Resolve `typeName` to its parsed manifest WITHOUT falling back to
   * "coding" — returns undefined for an unknown type instead. No warning is
   * logged (an unknown type here is an expected, callers-handle-it outcome,
   * not a degraded-boot condition). Used by POST /agents to reject an
   * unknown requested `type` with 400 rather than silently seeding a
   * "coding" agent under a different label.
   */
  tryGetManifest(typeName: string): AgentTypeManifest | undefined;
  /**
   * Discover every agent type directory (via the injected `list` fn) and
   * resolve each to its {name, displayName} for populating the new-agent
   * type picker. A directory whose manifest fails to load or parse is
   * skipped (not thrown) — the picker still renders every other valid type
   * rather than 500ing the whole /admin/agents/new page over one bad
   * manifest. Order matches the underlying `list` fn's order.
   */
  listTypes(): AgentTypeOption[];
}

export class AgentTypeRegistry implements AgentTypeManifestResolver {
  private readonly read: ManifestReader;
  private readonly warn: WarnFn;
  private readonly list: TypeDirLister;
  private readonly cache = new Map<string, AgentTypeManifest>();

  constructor(
    opts: { read?: ManifestReader; warn?: WarnFn; list?: TypeDirLister } = {},
  ) {
    this.read = opts.read ?? defaultManifestReader;
    this.warn = opts.warn ?? ((m) => console.warn(m));
    this.list = opts.list ?? defaultTypeDirLister;
  }

  getManifest(typeName: string): AgentTypeManifest {
    const resolved = this.tryLoad(typeName);
    if (resolved) return resolved;

    // Unknown type — warn once and fall back to "coding". The fallback load is
    // deliberately NOT wrapped in tryLoad: if "coding" can't load, that's a
    // hard startup bug and must surface, not silently become a no-op.
    this.warn(
      `AgentTypeRegistry: unknown agent typeName "${typeName}" — ` +
        `falling back to "${DEFAULT_AGENT_TYPE_NAME}" manifest`,
    );
    if (typeName === DEFAULT_AGENT_TYPE_NAME) {
      // Guard against infinite intent: the default itself failed to load.
      throw new Error(
        `AgentTypeRegistry: the default "${DEFAULT_AGENT_TYPE_NAME}" manifest failed to load — this is a startup-time bug`,
      );
    }
    return this.loadOrThrow(DEFAULT_AGENT_TYPE_NAME);
  }

  /**
   * Resolve `typeName` without falling back to "coding" — see the interface
   * doc comment. Thin public wrapper around the existing tryLoad() used
   * internally by getManifest().
   */
  tryGetManifest(typeName: string): AgentTypeManifest | undefined {
    return this.tryLoad(typeName);
  }

  listTypes(): AgentTypeOption[] {
    const typeNames = this.list();
    const options: AgentTypeOption[] = [];
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
  private tryLoad(typeName: string): AgentTypeManifest | undefined {
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
  private loadOrThrow(typeName: string): AgentTypeManifest {
    const cached = this.cache.get(typeName);
    if (cached) return cached;
    return this.parseAndCache(typeName, this.read(typeName));
  }

  private parseAndCache(typeName: string, raw: string): AgentTypeManifest {
    const manifest = parseAgentTypeManifest(raw);
    this.cache.set(typeName, manifest);
    return manifest;
  }
}
