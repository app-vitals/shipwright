/**
 * scripts/platform-docs-snapshot.unit.test.ts
 *
 * The platform docs snapshot (PLD-2.1): generated header with a source link at
 * the release tag, wholesale rewrite of docs/platform/ (stale files removed,
 * unchanged files left alone), and the CLI's exit codes.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HEADER_MARKER,
  header,
  listSourceDocs,
  renderSnapshot,
  SNAPSHOT_DIR,
  snapshotDocs,
  sourceUrl,
} from "./platform-docs-snapshot.ts";

const SCRIPT = join(import.meta.dir, "platform-docs-snapshot.ts");

let root: string;
let platform: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pds-root-"));
  platform = mkdtempSync(join(tmpdir(), "pds-platform-"));
  mkdirSync(join(platform, "docs"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(platform, { recursive: true, force: true });
});

const writeSource = (file: string, body: string) =>
  writeFileSync(join(platform, "docs", file), body);
const readSnap = (file: string) =>
  readFileSync(join(root, SNAPSHOT_DIR, file), "utf8");

describe("header", () => {
  test("links the source doc at the release tag", () => {
    expect(sourceUrl("0.2.0", "agent.md")).toBe(
      "https://github.com/app-vitals/agent/blob/v0.2.0/docs/agent.md",
    );
    const h = header("0.2.0", "agent.md");
    expect(h.startsWith(HEADER_MARKER)).toBe(true);
    expect(h).toContain(sourceUrl("0.2.0", "agent.md"));
  });

  test("renderSnapshot keeps the body verbatim after the header", () => {
    const body = "# Title\n\ntext\n";
    expect(renderSnapshot("1.0.0", "a.md", body)).toBe(
      header("1.0.0", "a.md") + body,
    );
  });
});

describe("listSourceDocs", () => {
  test("returns sorted top-level markdown only", () => {
    writeSource("b.md", "b");
    writeSource("a.md", "a");
    writeSource("x.content.test.ts", "t");
    mkdirSync(join(platform, "docs", "sub"));
    writeFileSync(join(platform, "docs", "sub", "c.md"), "c");
    expect(listSourceDocs(platform)).toEqual(["a.md", "b.md"]);
  });

  test("is empty when the checkout has no docs dir", () => {
    expect(listSourceDocs(join(platform, "nope"))).toEqual([]);
  });
});

describe("snapshotDocs", () => {
  test("writes every doc with the generated header", () => {
    writeSource("agent.md", "# Agent\n");
    writeSource("specialties.md", "# Specialties\n");
    const r = snapshotDocs(root, platform, "0.2.0");
    expect(r.written).toEqual(["agent.md", "specialties.md"]);
    expect(readSnap("agent.md")).toBe(
      renderSnapshot("0.2.0", "agent.md", "# Agent\n"),
    );
  });

  test("is idempotent: a second run leaves everything unchanged", () => {
    writeSource("agent.md", "# Agent\n");
    snapshotDocs(root, platform, "0.2.0");
    const r = snapshotDocs(root, platform, "0.2.0");
    expect(r).toEqual({ written: [], removed: [], unchanged: ["agent.md"] });
  });

  test("a new release rewrites headers and bodies and removes dropped docs", () => {
    writeSource("agent.md", "v1\n");
    writeSource("old.md", "old\n");
    snapshotDocs(root, platform, "0.2.0");
    rmSync(join(platform, "docs", "old.md"));
    writeSource("agent.md", "v2\n");
    const r = snapshotDocs(root, platform, "0.3.0");
    expect(r.written).toEqual(["agent.md"]);
    expect(r.removed).toEqual(["old.md"]);
    expect(readSnap("agent.md")).toContain("/blob/v0.3.0/docs/agent.md");
    expect(existsSync(join(root, SNAPSHOT_DIR, "old.md"))).toBe(false);
  });

  test("reverts a hand edit to a snapshot file", () => {
    writeSource("agent.md", "real\n");
    snapshotDocs(root, platform, "0.2.0");
    writeFileSync(join(root, SNAPSHOT_DIR, "agent.md"), "hacked\n");
    expect(snapshotDocs(root, platform, "0.2.0").written).toEqual(["agent.md"]);
    expect(readSnap("agent.md")).toContain("real");
  });

  test("rejects a non-strict version and an empty docs dir", () => {
    writeSource("agent.md", "x");
    expect(() => snapshotDocs(root, platform, "v0.2.0")).toThrow(/strict/);
    rmSync(join(platform, "docs", "agent.md"));
    expect(() => snapshotDocs(root, platform, "0.2.0")).toThrow(/no docs/);
  });
});

describe("CLI", () => {
  const run = (...args: string[]) =>
    Bun.spawnSync(["bun", SCRIPT, ...args], { stdout: "pipe", stderr: "pipe" });

  test("exit 2 on missing arguments", () => {
    expect(run("0.2.0").exitCode).toBe(2);
  });

  test("exit 1 on an invalid version", () => {
    expect(run("1.2.3; rm -rf /", platform, "--root", root).exitCode).toBe(1);
  });

  test("exit 1 when the checkout has no docs", () => {
    rmSync(join(platform, "docs"), { recursive: true });
    expect(run("0.2.0", platform, "--root", root).exitCode).toBe(1);
  });
});
