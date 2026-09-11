/**
 * admin/src/push-content.unit.test.ts
 * Unit tests for the notification-content policy: detail-level resolution
 * (server ceiling vs. per-subscription opt-in) and the payload builder.
 *
 * The security-critical assertion (acceptance criterion 1) is that NO payload
 * at ANY detail level ever leaks an agentId, threadId, repo name, or file path.
 */

import { describe, expect, it } from "bun:test";
import {
  type PushDetailLevel,
  type SessionNotificationKind,
  buildNotificationPayload,
  buildSessionNotificationPayload,
  resolveDetailLevel,
} from "./push-content.ts";

describe("resolveDetailLevel", () => {
  it("returns the min of the operator ceiling and the user opt-in", () => {
    expect(resolveDetailLevel("preview", "preview")).toBe("preview");
    expect(resolveDetailLevel("title", "preview")).toBe("title");
    expect(resolveDetailLevel("preview", "title")).toBe("title");
    expect(resolveDetailLevel("generic", "preview")).toBe("generic");
    expect(resolveDetailLevel("preview", "generic")).toBe("generic");
    expect(resolveDetailLevel("title", "title")).toBe("title");
    expect(resolveDetailLevel("generic", "generic")).toBe("generic");
  });

  it("defaults an unknown/undefined ceiling to the operator default (title)", () => {
    expect(resolveDetailLevel(undefined, "preview")).toBe("title");
    expect(resolveDetailLevel("bogus" as PushDetailLevel, "preview")).toBe(
      "title",
    );
  });

  it("defaults an unknown/undefined opt-in to the safest level (generic)", () => {
    expect(resolveDetailLevel("preview", undefined)).toBe("generic");
    expect(resolveDetailLevel("preview", "bogus" as PushDetailLevel)).toBe(
      "generic",
    );
  });
});

describe("buildNotificationPayload — content per level", () => {
  const thread = {
    threadId: "thr_abc123",
    agentId: "agt_secret",
    title: "Refactor the billing exporter",
    preview:
      "The billing exporter needs to page through acme-corp/finance-svc and rewrite src/export/ledger.ts before the deploy.",
  };

  it("generic: no body, generic title, no thread title", () => {
    const p = buildNotificationPayload("generic", thread);
    expect(p.title).toBe("Your agent replied");
    expect(p.body).toBe("");
  });

  it("title: adds the thread title, still no preview body", () => {
    const p = buildNotificationPayload("title", thread);
    expect(p.body).toContain("Refactor the billing exporter");
  });

  it("preview: adds up to 120 chars of preview", () => {
    const p = buildNotificationPayload("preview", thread);
    expect(p.body.length).toBeLessThanOrEqual(120);
    expect(p.body.length).toBeGreaterThan(0);
  });

  it("carries a url that deep-links the thread (the ONLY place ids may live)", () => {
    const p = buildNotificationPayload("title", thread);
    expect(p.url).toContain(thread.threadId);
  });
});

describe("buildNotificationPayload — NEVER leaks sensitive tokens (AC 1)", () => {
  // A notification renders on a locked phone, possibly in public. The visible
  // fields (title, body) must never contain an agentId, threadId, repo name,
  // or file path — at ANY detail level.
  const thread = {
    threadId: "thr_LEAKING_THREAD_ID",
    agentId: "agt_LEAKING_AGENT_ID",
    title: "Ship agt_LEAKING_AGENT_ID for acme-corp/finance-svc",
    preview:
      "Working thr_LEAKING_THREAD_ID on acme-corp/finance-svc touching src/export/ledger.ts costs $4.20",
  };

  const forbidden = [
    thread.agentId,
    thread.threadId,
    "acme-corp/finance-svc",
    "src/export/ledger.ts",
  ];

  const levels: PushDetailLevel[] = ["generic", "title", "preview"];

  for (const level of levels) {
    it(`level "${level}": visible fields contain no id/repo/path token`, () => {
      const p = buildNotificationPayload(level, thread);
      const visible = `${p.title}\n${p.body}`;
      for (const token of forbidden) {
        expect(visible).not.toContain(token);
      }
    });
  }
});

describe("buildSessionNotificationPayload — kind x level matrix", () => {
  const session = {
    slug: "refactor-billing-exporter",
    title: "Refactor the billing exporter",
    reason:
      "The billing exporter needs to page through several upstream services and rewrite the ledger export logic before the deploy window closes tonight.",
  };

  const kinds: SessionNotificationKind[] = [
    "immediate",
    "reminder",
    "completed",
  ];
  const levels: PushDetailLevel[] = ["generic", "title", "preview"];

  const expectedTitle: Record<SessionNotificationKind, string> = {
    immediate: "A session needs you",
    reminder: "Still waiting on you",
    completed: "Session completed",
  };

  for (const kind of kinds) {
    for (const level of levels) {
      it(`kind "${kind}" level "${level}": correct title/body/url/tag/kind`, () => {
        const p = buildSessionNotificationPayload(level, kind, session);

        expect(p.title).toBe(expectedTitle[kind]);
        expect(p.kind).toBe(kind);
        expect(p.url).toBe(
          `/admin/sessions/${encodeURIComponent(session.slug)}`,
        );
        expect(p.tag).toBe(`shipwright-session-${session.slug}`);

        if (level === "generic") {
          expect(p.body).toBe("");
        } else if (level === "title") {
          expect(p.body).toBe(session.title);
        } else {
          expect(p.body.length).toBeLessThanOrEqual(120);
          expect(p.body.length).toBeGreaterThan(0);
          expect(session.reason.startsWith(p.body)).toBe(true);
        }
      });
    }
  }

  it("falls back to title when reason is missing at preview level", () => {
    const p = buildSessionNotificationPayload("preview", "immediate", {
      slug: "no-reason",
      title: "Fallback title",
    });
    expect(p.body).toBe("Fallback title");
  });

  it("falls back to empty body when both title and reason are missing", () => {
    const p = buildSessionNotificationPayload("title", "reminder", {
      slug: "bare-session",
    });
    expect(p.body).toBe("");

    const preview = buildSessionNotificationPayload("preview", "reminder", {
      slug: "bare-session",
      title: null,
      reason: null,
    });
    expect(preview.body).toBe("");
  });

  it("truncates a reason longer than 120 chars at preview level", () => {
    const longReason = "x".repeat(200);
    const p = buildSessionNotificationPayload("preview", "completed", {
      slug: "long-reason",
      reason: longReason,
    });
    expect(p.body.length).toBe(120);
  });
});

describe("buildSessionNotificationPayload — NEVER leaks sensitive tokens (AC 2)", () => {
  const session = {
    slug: "leaky-session",
    title: "Ship agt_LEAKING_AGENT_ID for acme-corp/finance-svc",
    reason:
      "Working thr_LEAKING_THREAD_ID on acme-corp/finance-svc touching src/export/ledger.ts costs $4.20",
  };

  const forbidden = [
    "agt_LEAKING_AGENT_ID",
    "thr_LEAKING_THREAD_ID",
    "acme-corp/finance-svc",
    "src/export/ledger.ts",
  ];

  const levels: PushDetailLevel[] = ["generic", "title", "preview"];

  for (const level of levels) {
    it(`level "${level}": visible fields contain no id/repo/path token`, () => {
      const p = buildSessionNotificationPayload(level, "immediate", session);
      const visible = `${p.title}\n${p.body}`;
      for (const token of forbidden) {
        expect(visible).not.toContain(token);
      }
    });
  }
});
