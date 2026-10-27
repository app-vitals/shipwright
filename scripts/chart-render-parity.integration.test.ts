import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

setDefaultTimeout(120_000);

const ROOT = join(import.meta.dir, "..");
const SCRIPT = join(import.meta.dir, "chart-render-parity.ts");
const CHART = join(ROOT, "charts/shipwright");
const VALUES = join(CHART, "ci/minikube-values.yaml");

let tmp: string;
let copy: string;
let names: string;

const parity = (head: string, extra: string[] = []) =>
  Bun.spawnSync(
    [
      "bun",
      "run",
      SCRIPT,
      "--base",
      CHART,
      "--head",
      head,
      "--values",
      VALUES,
      ...extra,
    ],
    {
      cwd: ROOT,
    },
  );

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "parity-it-"));
  copy = join(tmp, "chart");
  cpSync(CHART, copy, { recursive: true });
  names = join(tmp, "names.txt");
  writeFileSync(names, "ServiceAccount//shipwright-admin\n");
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("chart-render-parity (real chart)", () => {
  test("identical charts pass", () => {
    expect(parity(copy).exitCode).toBe(0);
  });

  test("chart name/version label change alone passes", () => {
    const chartYaml = join(copy, "Chart.yaml");
    const orig = readFileSync(chartYaml, "utf8");
    writeFileSync(chartYaml, orig.replace(/^version: .*/m, "version: 99.0.0"));
    try {
      expect(parity(copy).exitCode).toBe(0);
    } finally {
      writeFileSync(chartYaml, orig);
    }
  });

  test("renamed fixture fails and names-file catches the lost object", () => {
    const chartYaml = join(copy, "Chart.yaml");
    const orig = readFileSync(chartYaml, "utf8");
    // fullname = <release>-<chart name> unless the release already contains it.
    writeFileSync(chartYaml, orig.replace(/^name: .*/m, "name: renamed"));
    try {
      const r = parity(copy, ["--names-file", names]);
      expect(r.exitCode).toBe(1);
      expect(r.stderr.toString()).toContain("ServiceAccount//shipwright-admin");
    } finally {
      writeFileSync(chartYaml, orig);
    }
  });

  test("names-file entry that renders passes", () => {
    expect(parity(copy, ["--names-file", names]).exitCode).toBe(0);
  });
});
