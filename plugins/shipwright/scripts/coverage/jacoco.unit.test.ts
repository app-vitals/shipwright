import { expect, test } from "bun:test";
import { parseJacoco } from "./jacoco.ts";

const XML = `<?xml version="1.0"?>
<report name="x">
  <package name="p">
    <class name="p/A"><counter type="LINE" missed="100" covered="100"/></class>
    <counter type="LINE" missed="50" covered="50"/>
  </package>
  <counter type="INSTRUCTION" missed="9" covered="9"/>
  <counter type="BRANCH" missed="1" covered="3"/>
  <counter type="LINE" missed="2" covered="8"/>
  <counter type="METHOD" missed="0" covered="4"/>
</report>`;

test("parseJacoco uses only the report-level counters", () => {
  const r = parseJacoco(XML);
  expect(r?.tool).toBe("jacoco");
  expect(r?.lines).toEqual({ covered: 8, total: 10 });
  expect(r?.branches).toEqual({ covered: 3, total: 4 });
  expect(r?.functions).toEqual({ covered: 4, total: 4 });
});

test("parseJacoco ignores nested group counters and attribute order", () => {
  const xml = `<report><group name="g"><package><counter type="LINE" covered="1" missed="1"/></package><counter type="LINE" covered="7" missed="7"/></group><counter type="LINE" covered="6" missed="4"/></report>`;
  expect(parseJacoco(xml)?.lines).toEqual({ covered: 6, total: 10 });
});

test("parseJacoco returns null without a report-level LINE counter", () => {
  expect(
    parseJacoco(
      `<report><package><counter type="LINE" missed="1" covered="1"/></package></report>`,
    ),
  ).toBeNull();
  expect(parseJacoco("<coverage/>")).toBeNull();
});
