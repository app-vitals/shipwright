/**
 * admin/src/coding/admin-ui-agent-cards.unit.test.ts
 * Pure unit tests for the coding extension's agent detail cards
 * (relocated from admin-ui-pages.unit.test.ts, AEP-3.2).
 */

import { describe, expect, test } from "bun:test";
import { renderGitHubInstallationsCard } from "./admin-ui-agent-cards.ts";

// ─── renderGitHubInstallationsCard (MGI-4.3) ─────────────────────────────────

describe("renderGitHubInstallationsCard", () => {
  const NOW = new Date("2026-01-15T12:00:00.000Z");
  const FRESH = new Date("2026-01-15T11:30:00.000Z");

  test("omitted when there is no snapshot", () => {
    expect(renderGitHubInstallationsCard(null, NOW, "UTC")).toBe("");
    expect(renderGitHubInstallationsCard(undefined, NOW, "UTC")).toBe("");
  });

  test("renders in-scope, not-in-scope, pinned and broken states with last error", () => {
    const html = renderGitHubInstallationsCard(
      {
        reportedAt: FRESH,
        installations: [
          { owner: "in-org", installationId: 1, state: "ok" },
          { owner: "other-org", installationId: 2, state: "not_in_scope" },
          { owner: "pin-org", installationId: 3, state: "pinned" },
          {
            owner: "bad-org",
            installationId: 4,
            state: "broken",
            lastError: "installation token mint rejected",
          },
        ],
      },
      NOW,
      "UTC",
    );
    expect(html).toContain("in scope");
    expect(html).toContain("discovered, not in scope");
    expect(html).toContain("pinned");
    expect(html).toContain("broken");
    expect(html).toContain("installation token mint rejected");
    expect(html).not.toContain("Stale");
  });

  test("renders an empty state when the snapshot has no installations", () => {
    const html = renderGitHubInstallationsCard(
      { reportedAt: FRESH, installations: [] },
      NOW,
      "UTC",
    );
    expect(html).toContain("No installations reported");
  });

  test("warns when reportedAt is older than 90 minutes, not at exactly 90", () => {
    const stale = renderGitHubInstallationsCard(
      {
        reportedAt: new Date(NOW.getTime() - 91 * 60 * 1000),
        installations: [],
      },
      NOW,
      "UTC",
    );
    expect(stale).toContain("Stale");
    const edge = renderGitHubInstallationsCard(
      {
        reportedAt: new Date(NOW.getTime() - 90 * 60 * 1000),
        installations: [],
      },
      NOW,
      "UTC",
    );
    expect(edge).not.toContain("Stale");
  });

  test("escapes owner and error text", () => {
    const html = renderGitHubInstallationsCard(
      {
        reportedAt: FRESH,
        installations: [
          {
            owner: "<script>x</script>",
            installationId: 1,
            state: "broken",
            lastError: "<b>boom</b>",
          },
        ],
      },
      NOW,
      "UTC",
    );
    expect(html).not.toContain("<script>x");
    expect(html).not.toContain("<b>boom");
  });
});
