// Unit tests for register-planning-documents.ts — filename/numbering rules (pure).
import { describe, expect, it } from "bun:test";
import {
  chainContentSources,
  classifyPlanningFile,
  type ContentSource,
  extractTitle,
} from "./register-planning-documents";

describe("classifyPlanningFile", () => {
  it("PLAN.md is plan 1", () => {
    expect(classifyPlanningFile("PLAN.md")).toEqual({ kind: "plan", number: 1 });
  });
  it("PRODUCT-SPEC.md is spec 1", () => {
    expect(classifyPlanningFile("PRODUCT-SPEC.md")).toEqual({ kind: "spec", number: 1 });
  });
  it("SPEC-NNNN.md is spec NNNN", () => {
    expect(classifyPlanningFile("SPEC-0002.md")).toEqual({ kind: "spec", number: 2 });
    expect(classifyPlanningFile("SPEC-0123.md")).toEqual({ kind: "spec", number: 123 });
  });
  it.each(["SPEC-0000.md", "SPEC-2.md", "spec-0002.md", "AUDIT.md", "plan.md", "SPEC-0002.md.bak", "notes.log"])(
    "%s is non-standard",
    (name) => {
      expect(classifyPlanningFile(name)).toBeNull();
    },
  );
});

describe("extractTitle", () => {
  it("returns the first H1", () => {
    expect(extractTitle("intro\n# Hello  \n# Other")).toBe("Hello");
  });
  it("returns null without a heading or content", () => {
    expect(extractTitle("## sub only")).toBeNull();
    expect(extractTitle(null)).toBeNull();
  });
});

describe("chainContentSources", () => {
  const src = (files: Record<string, string>): ContentSource => ({
    listSessions: async () => ["s"],
    listFiles: async () => Object.keys(files),
    read: async (p) => files[p] ?? null,
  });
  it("reads from the first source that has the file; lists the union", async () => {
    const chain = chainContentSources([src({ a: "docs" }), src({ a: "main", b: "main" })]);
    expect(await chain.read("a")).toBe("docs");
    expect(await chain.read("b")).toBe("main");
    expect(await chain.read("c")).toBeNull();
    expect(await chain.listFiles("s")).toEqual(["a", "b"]);
  });
});
