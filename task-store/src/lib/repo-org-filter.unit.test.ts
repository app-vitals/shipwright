import { describe, expect, it } from "bun:test";
import { buildRepoOrgWhere } from "./repo-org-filter.ts";

describe("buildRepoOrgWhere", () => {
  it("returns a repo `in` clause when only repos is given", () => {
    const where = buildRepoOrgWhere({ repos: ["acme/foo", "acme/bar"] });
    expect(where).toEqual({ repo: { in: ["acme/foo", "acme/bar"] } });
  });

  it("returns an OR of repo `startsWith` clauses when only orgs is given", () => {
    const where = buildRepoOrgWhere({ orgs: ["acme", "other"] });
    expect(where).toEqual({
      OR: [
        { repo: { startsWith: "acme/" } },
        { repo: { startsWith: "other/" } },
      ],
    });
  });

  it("returns an AND combining both clauses when both orgs and repos are given", () => {
    const where = buildRepoOrgWhere({
      orgs: ["acme"],
      repos: ["acme/foo", "other/bar"],
    });
    expect(where).toEqual({
      AND: [
        { repo: { in: ["acme/foo", "other/bar"] } },
        { OR: [{ repo: { startsWith: "acme/" } }] },
      ],
    });
  });

  it("returns an empty object when neither orgs nor repos is given", () => {
    expect(buildRepoOrgWhere({})).toEqual({});
    expect(buildRepoOrgWhere({ orgs: [], repos: [] })).toEqual({});
    expect(buildRepoOrgWhere()).toEqual({});
  });
});
