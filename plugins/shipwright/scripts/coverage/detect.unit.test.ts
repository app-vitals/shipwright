import { expect, test } from "bun:test";
import { detectFormat } from "./detect.ts";

test("detects formats from content regardless of file name", () => {
  expect(detectFormat("x.txt", "TN:\nSF:a\nend_of_record\n")).toBe("lcov");
  expect(
    detectFormat(
      "x.dat",
      `<?xml version="1.0"?>\n<coverage lines-valid="1"></coverage>`,
    ),
  ).toBe("cobertura");
  expect(
    detectFormat(
      "x.xml",
      `<report name="r"><counter type="LINE" missed="0" covered="1"/></report>`,
    ),
  ).toBe("jacoco");
  expect(detectFormat("cover.out", "mode: set\na.go:1.1,2.2 1 1\n")).toBe(
    "go-cover",
  );
});

test("detects JaCoCo behind a DOCTYPE", () => {
  const xml = `<?xml version="1.0"?><!DOCTYPE report PUBLIC "-//JACOCO//DTD Report 1.1//EN" "report.dtd"><report name="r"></report>`;
  expect(detectFormat("jacoco.xml", xml)).toBe("jacoco");
});

test("shipwright-coverage.json is recognised by file name", () => {
  expect(detectFormat("out/shipwright-coverage.json", "{}")).toBe("shipwright");
  expect(detectFormat("other.json", "{}")).toBeNull();
});

test("returns null for unrecognised content", () => {
  expect(detectFormat("README.md", "# hello")).toBeNull();
  expect(detectFormat("empty", "")).toBeNull();
});
