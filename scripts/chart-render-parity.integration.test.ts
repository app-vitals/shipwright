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
  readdirSync,
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
let bootstrapValues: string;

const parity = (
  head: string,
  extra: string[] = [],
  values: string[] = [VALUES],
) =>
  Bun.spawnSync(
    [
      "bun",
      "run",
      SCRIPT,
      "--base",
      CHART,
      "--head",
      head,
      ...values.flatMap((v) => ["--values", v]),
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
  // The cert-manager Issuer body now lives in the agent-platform library chart
  // (CHM-3.4). Unpack the vendored tarball in the copy so tests can edit its
  // templates; helm renders an unpacked charts/<name>/ dir identically.
  const charts = join(copy, "charts");
  const lib = readdirSync(charts).find((f) => /^agent-platform-.*\.tgz$/.test(f));
  if (!lib) throw new Error("agent-platform library tarball missing from charts/");
  const untar = Bun.spawnSync(["tar", "-xzf", join(charts, lib), "-C", charts]);
  if (untar.exitCode !== 0) throw new Error(untar.stderr.toString());
  rmSync(join(charts, lib));
  names = join(tmp, "names.txt");
  writeFileSync(names, "ServiceAccount//shipwright-admin\n");
  // Enables the cert-manager bootstrap ConfigMap, which embeds a rendered Issuer
  // (with its own helm.sh/chart label) as a string in data.10-issuer.yaml. Values
  // files render independently, so this is minikube's values (ingress networking, which cert-manager requires) plus the overrides.
  bootstrapValues = join(tmp, "bootstrap-values.yaml");
  writeFileSync(
    bootstrapValues,
    `${readFileSync(VALUES, "utf8").replace(/^ {2}type: ClusterIP/m, "  type: ingress")}
tls:
  certManager:
    enabled: true
    issuer:
      create: true
      kind: Issuer
      type: selfsigned
cert-manager:
  enabled: true
`,
  );
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

  describe("embedded-manifest chart label", () => {
    const withChartEdit = (edit: (orig: string) => string, run: () => void) => {
      const chartYaml = join(copy, "Chart.yaml");
      const helpers = join(
        copy,
        "charts/agent-platform/templates/_certmanager.tpl",
      );
      const origChart = readFileSync(chartYaml, "utf8");
      const origHelpers = readFileSync(helpers, "utf8");
      writeFileSync(
        chartYaml,
        origChart.replace(/^version: .*/m, "version: 99.0.0"),
      );
      writeFileSync(helpers, edit(origHelpers));
      try {
        run();
      } finally {
        writeFileSync(chartYaml, origChart);
        writeFileSync(helpers, origHelpers);
      }
    };

    test("version bump alone passes when the label is embedded in a ConfigMap string", () => {
      withChartEdit(
        (o) => o,
        () => {
          expect(parity(copy, [], [bootstrapValues]).exitCode).toBe(0);
        },
      );
    });

    test("a real change in the same embedded string still fails", () => {
      withChartEdit(
        (o) =>
          o.replace(
            "\n  selfSigned: {}",
            "\n  selfSigned:\n    crlDistributionPoints:\n      - http://crl.example/ca.crl",
          ),
        () => {
          const r = parity(copy, [], [bootstrapValues]);
          expect(r.exitCode).toBe(1);
          expect(r.stderr.toString()).toContain("10-issuer.yaml");
        },
      );
    });
  });
});
