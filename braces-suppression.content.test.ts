/**
 * Coupling guard for the time-boxed braces GHSA-vfj7-8cjw-p6xm suppression (BRS-1.1).
 *
 * The osv-scanner `ignoreUntil` date and the `.grype.yaml` re-check comment must
 * carry the same date so the two scanners' suppressions expire together.
 *
 * Content-assertion only: readFileSync, no I/O beyond local file reads.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, ".");
const read = (p: string) => readFileSync(join(repoRoot, p), "utf8");
const GHSA = "GHSA-vfj7-8cjw-p6xm";

const ignoreUntil = (p: string) => read(p).match(/^ignoreUntil\s*=\s*(\d{4}-\d{2}-\d{2})/m)?.[1];

describe("braces suppression", () => {
  it("root and site osv-scanner.toml ignore the GHSA with the same date", () => {
    for (const p of ["osv-scanner.toml", "site/osv-scanner.toml"]) {
      expect(read(p)).toContain(`id = "${GHSA}"`);
    }
    expect(ignoreUntil("osv-scanner.toml")).toBeDefined();
    expect(ignoreUntil("site/osv-scanner.toml")).toBe(ignoreUntil("osv-scanner.toml"));
  });

  it(".grype.yaml is scoped to braces@3.0.3 and its re-check date equals osv ignoreUntil", () => {
    const grype = read(".grype.yaml");
    expect(grype).toContain(`vulnerability: ${GHSA}`);
    expect(grype).toMatch(/name: braces\n\s+version: 3\.0\.3/);
    expect(grype.match(/re-check by (\d{4}-\d{2}-\d{2})/)?.[1]).toBe(ignoreUntil("osv-scanner.toml"));
  });
});
