import { describe, expect, test } from "bun:test";
import {
  diffObjectSets as diffEntries,
  diffValues,
  dropNoise,
  missingNames,
  nondeterministicFields,
  normalize,
  parseNamesFile,
  parseRendered,
} from "./chart-render-parity.ts";

const render = (chartLabel: string, name = "web") => `
apiVersion: v1
kind: Service
metadata:
  name: ${name}
  namespace: ns
  labels:
    helm.sh/chart: ${chartLabel}
    app: x
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${name}
  labels:
    helm.sh/chart: ${chartLabel}
spec:
  template:
    metadata:
      labels:
        helm.sh/chart: ${chartLabel}
    spec:
      containers:
        - name: c
          image: img:1
`;

describe("normalize", () => {
  test("strips helm.sh/chart at any depth and nothing else", () => {
    expect(
      normalize({
        a: { "helm.sh/chart": "x-1", b: [{ "helm.sh/chart": "y", c: 1 }] },
        "app.kubernetes.io/name": "n",
      }),
    ).toEqual({
      a: { b: [{ c: 1 }] },
      "app.kubernetes.io/name": "n",
    });
  });
});

describe("normalize embedded manifests", () => {
  test("blanks the chart label inside a YAML string value, keeping other lines", () => {
    const doc = (v: string) => ({
      data: { "i.yaml": `kind: Issuer\n  labels:\n    helm.sh/chart: ${v}\n    app: x\n` },
    });
    expect(normalize(doc("shipwright-1.29.12"))).toEqual(
      normalize(doc("shipwright-1.30.0")),
    );
    expect(normalize(doc("a-1"))).not.toEqual(
      normalize({ data: { "i.yaml": "kind: Issuer\n  labels:\n    app: y\n" } }),
    );
  });
});

describe("parseRendered", () => {
  test("keys objects by kind/namespace/name, empty namespace when unset", () => {
    expect([...parseRendered(render("a-1")).keys()]).toEqual([
      "Service/ns/web",
      "Deployment//web",
    ]);
  });
  test("rejects duplicate objects", () => {
    expect(() => parseRendered(`${render("a")}---\n${render("a")}`)).toThrow(
      /duplicate/,
    );
  });
});

const diffObjectSets = (a: Map<string, unknown>, b: Map<string, unknown>) =>
  diffEntries(a, b).map((e) => e.text);

describe("diffObjectSets", () => {
  test("pure chart-label change is no diff", () => {
    expect(
      diffObjectSets(
        parseRendered(render("a-1")),
        parseRendered(render("b-2")),
      ),
    ).toEqual([]);
  });
  test("rename reports removed and added objects", () => {
    const d = diffObjectSets(
      parseRendered(render("a")),
      parseRendered(render("a", "api")),
    );
    expect(d).toContain("- Service/ns/web: no longer renders");
    expect(d).toContain("+ Service/ns/api: newly rendered");
  });
  test("field change reports the path", () => {
    const changed = render("a").replace("img:1", "img:2");
    const d = diffObjectSets(
      parseRendered(render("a")),
      parseRendered(changed),
    );
    expect(d).toEqual([
      '~ Deployment//web: spec.template.spec.containers[0].image: "img:1" -> "img:2"',
    ]);
  });
});

describe("diffValues", () => {
  test("array length changes", () => {
    expect(diffValues([1], [1, 2]).map((e) => e.text)).toEqual([
      "[1]: added 2",
    ]);
    expect(diffValues([1, 2], [1]).map((e) => e.text)).toEqual([
      "[1]: removed 2",
    ]);
  });
});

describe("nondeterministic fields", () => {
  const secret = (v: string, extra = "") =>
    parseRendered(
      `kind: Secret\nmetadata:\n  name: s\ndata:\n  pw: ${v}\n${extra}`,
    );
  test("masks fields that vary between same-ref renders, still flags other changes", () => {
    const noise = nondeterministicFields(secret("a"), secret("b"));
    expect(dropNoise(diffEntries(secret("a"), secret("c")), noise)).toEqual([]);
    const other = parseRendered(
      "kind: Secret\nmetadata:\n  name: s\ndata:\n  pw: c\n  extra: x\n",
    );
    expect(
      dropNoise(diffEntries(secret("a"), other), noise).map((e) => e.path),
    ).toEqual(["data.extra"]);
  });
  test("does not mask a removed object", () => {
    const noise = nondeterministicFields(secret("a"), secret("b"));
    expect(dropNoise(diffEntries(secret("a"), new Map()), noise)).toHaveLength(
      1,
    );
  });
});

describe("names file", () => {
  test("parses comments and blanks", () => {
    expect(
      parseNamesFile("# hi\nService/ns/web  # trailing\n\nDeployment//web\n"),
    ).toEqual(["Service/ns/web", "Deployment//web"]);
  });
  test("reports names that no longer render", () => {
    const r = parseRendered(render("a"));
    expect(missingNames(["Service/ns/web", "Service/ns/gone"], r)).toEqual([
      "Service/ns/gone",
    ]);
  });
});
