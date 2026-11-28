import { describe, expect, it } from "bun:test";
import {
  invalidSessionSlugMessage,
  isValidSessionSlug,
  sessionSlugCaseConflictMessage,
} from "./session-slug.ts";

describe("isValidSessionSlug", () => {
  it.each(["a", "sti", "my-session-2", "a".repeat(64)])(
    "accepts %p",
    (slug) => {
      expect(isValidSessionSlug(slug)).toBe(true);
    },
  );

  it.each([
    ["uppercase", "Sti"],
    ["slash", "a/b"],
    ["too long", "a".repeat(65)],
    ["leading digit", "1abc"],
    ["leading hyphen", "-abc"],
    ["underscore", "a_b"],
    ["space", "a b"],
    ["empty", ""],
    ["trailing newline", "abc\n"],
  ])("rejects %s", (_name, slug) => {
    expect(isValidSessionSlug(slug)).toBe(false);
  });
});

describe("messages", () => {
  it("rename-me message names the slug and the pattern", () => {
    const m = invalidSessionSlugMessage("Bad/Slug");
    expect(m).toContain("Invalid session slug 'Bad/Slug'");
    expect(m).toContain("^[a-z][a-z0-9-]{0,63}$");
    expect(m).toContain("please choose a different name");
  });

  it("truncates only the echoed value of an overlong slug, not the rule", () => {
    const m = invalidSessionSlugMessage("a".repeat(500));
    expect(m.length).toBeLessThan(250);
  });

  it("conflict message names the existing slug", () => {
    expect(sessionSlugCaseConflictMessage("Foo", "foo")).toContain("'foo'");
  });
});
