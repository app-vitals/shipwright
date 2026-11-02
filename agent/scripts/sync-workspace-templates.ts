#!/usr/bin/env bun
/**
 * agent/scripts/sync-workspace-templates.ts
 *
 * Bare-metal equivalent of agent/Dockerfile's workspace-template COPY lines.
 *
 * The coding agent image builds `@app-vitals/agent-runtime` from source at a
 * fixed path (/app/runtime), so the Dockerfile can patch its workspace/
 * directory directly:
 *
 *   COPY agent/workspace/CLAUDE.md.template ./runtime/workspace/CLAUDE.md.template
 *   COPY agent/workspace/CLAUDE-HITL.md.template ./runtime/workspace/CLAUDE-HITL.md.template
 *
 * A bare-metal install (no Docker build step) instead pulls agent-runtime as
 * a published package into a content-hashed node_modules path that moves on
 * every version bump, and the published package never shipped a
 * CLAUDE.md.template of its own (see app-vitals/agent's agent-types/ — a
 * monorepo-only directory, never part of the published package). Without
 * this sync, runtime/setup.ts's resolveTemplatesDir() falls through to that
 * now-incomplete built-in workspace/ dir and throws on missing
 * CLAUDE.md.template, failing boot every time (incident: 2026-11-02, Bodhi).
 *
 * Resolves the installed package by specifier rather than hardcoding its
 * node_modules path, so it keeps working across version bumps.
 */

import { copyFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const COPIED_TEMPLATES = ["CLAUDE.md.template", "CLAUDE-HITL.md.template"];

export function syncWorkspaceTemplates(
  resolve: (specifier: string, fromDir: string) => string = Bun.resolveSync,
  fromDir: string = import.meta.dir,
  sourceDir: string = join(import.meta.dir, "..", "workspace"),
): string[] {
  const runtimePkgJson = resolve("@app-vitals/agent-runtime/package.json", fromDir);
  const destDir = join(dirname(runtimePkgJson), "workspace");
  const copied: string[] = [];
  for (const name of COPIED_TEMPLATES) {
    copyFileSync(join(sourceDir, name), join(destDir, name));
    copied.push(join(destDir, name));
  }
  return copied;
}

if (import.meta.main) {
  try {
    const copied = syncWorkspaceTemplates();
    for (const path of copied) console.log(`[sync-workspace-templates] wrote ${path}`);
  } catch (err) {
    console.error(`[sync-workspace-templates] failed: ${(err as Error).message}`);
    process.exit(1);
  }
}
