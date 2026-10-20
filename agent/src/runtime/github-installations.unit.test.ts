import { describe, expect, it } from "bun:test";
import {
  type DiscoveredInstallation,
  discoverInstallations,
  selectInstallations,
} from "./github-installations.ts";

const inst = (
  id: number,
  owner: string,
  suspendedAt: string | null = null,
): DiscoveredInstallation => ({ id, owner, suspendedAt });

describe("selectInstallations", () => {
  const discovered = [inst(30, "Acme"), inst(10, "beta"), inst(20, "stranger")];

  it("ignores installations whose owner is neither in scope nor pinned (case-insensitive)", () => {
    const r = selectInstallations({
      discovered,
      scopedRepos: ["acme/web", "BETA/api"],
      scopeSynced: true,
    });
    expect(r.installations.map((i) => i.id)).toEqual([10, 30]);
  });

  it("defaults to the lowest id when unpinned", () => {
    const r = selectInstallations({
      discovered,
      scopedRepos: ["acme/web", "beta/api"],
      scopeSynced: true,
    });
    expect(r.defaultId).toBe(10);
  });

  it("defaults to the pin and includes it even when out of scope", () => {
    const r = selectInstallations({
      discovered,
      scopedRepos: ["beta/api"],
      scopeSynced: true,
      pinnedId: 20,
    });
    expect(r.defaultId).toBe(20);
    expect(r.installations.map((i) => i.id)).toEqual([10, 20]);
  });

  it("pinned id wins over a discovered id for the same owner", () => {
    const r = selectInstallations({
      discovered: [inst(5, "acme"), inst(9, "Acme")],
      scopedRepos: ["acme/web"],
      scopeSynced: true,
      pinnedId: 9,
    });
    expect(r.installations).toHaveLength(1);
    expect(r.installations[0]).toMatchObject({ id: 9, pinned: true });
  });

  it("unsynced scope yields pinned-only, never empty", () => {
    const r = selectInstallations({
      discovered,
      scopedRepos: [],
      scopeSynced: false,
      pinnedId: 20,
    });
    expect(r.installations.map((i) => i.id)).toEqual([20]);
  });

  it("keeps a pinned id that discovery did not return", () => {
    const r = selectInstallations({
      discovered: [],
      scopedRepos: [],
      scopeSynced: false,
      pinnedId: 77,
    });
    expect(r.installations).toEqual([
      { id: 77, owner: null, suspended: false, pinned: true },
    ]);
    expect(r.defaultId).toBe(77);
  });

  it("flags suspended installations", () => {
    const r = selectInstallations({
      discovered: [inst(1, "acme", "2026-03-01T00:00:00Z")],
      scopedRepos: ["acme/web"],
      scopeSynced: true,
    });
    expect(r.installations[0].suspended).toBe(true);
  });
});

describe("discoverInstallations", () => {
  it("returns an error result instead of throwing when fetch rejects", async () => {
    const fetchFn = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const r = await discoverInstallations("jwt", fetchFn);
    expect(r).toEqual({ ok: false, error: "network down" });
  });
});
