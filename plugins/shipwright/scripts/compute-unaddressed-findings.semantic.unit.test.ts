// Unit tests for the DTA-11.1 semantic-classification seam in
// compute-unaddressed-findings.ts — pure logic, no I/O.
//
// Investigation (2026-11-16, gh against this repo and
// a sibling repo; last 400-500 PRs of each plus reviewThreads of the last 100):
// every COMMENTED/CHANGES_REQUESTED review body and unresolved thread still
// visible in that window carried a real concern (fixtures REAL_* below are
// trimmed verbatim from them) — the descriptive-only review that pinned a PR at
// COMMENT in production is no longer retrievable (PR since merged/closed or in a
// repo outside that window), so DESCRIPTIVE_* are modeled on that report and are
// synthetic. Scope decision: the unresolved-thread path has the identical
// structural gap (no body-level signal, no ledger exclusion for review-source
// resolved entries), so the classification covers both reviews and threads.
import { describe, expect, test } from "bun:test";
import {
  hasUnaddressedFindings,
  type PrFinding,
  type PrReviewData,
  type ReviewNode,
  type ReviewThread,
  reviewRef,
  threadRef,
  unclassifiedFindingCandidates,
} from "./compute-unaddressed-findings.ts";

const HEAD = "head-sha-1";

const review = (o: Partial<ReviewNode> & { body: string }): ReviewNode => ({
  author: { login: "human-reviewer" },
  state: "COMMENTED",
  submittedAt: "2026-11-16T10:00:00Z",
  commit: { oid: HEAD },
  ...o,
});

const thread = (
  id: string,
  body: string,
  o: Partial<ReviewThread> = {},
): ReviewThread => ({
  id,
  isResolved: false,
  comments: {
    totalCount: 1,
    nodes: [
      {
        author: { login: "human-reviewer" },
        body,
        createdAt: "2026-11-16T10:00:00Z",
      },
    ],
  },
  ...o,
});

const data = (o: Partial<PrReviewData>): PrReviewData => ({
  headRefOid: HEAD,
  reviews: { nodes: [] },
  reviewThreads: { nodes: [] },
  comments: { nodes: [] },
  prAuthor: "pr-author",
  ...o,
});

const noFinding = (ref: string): PrFinding => ({
  id: "f1",
  prRecordId: "p1",
  ref,
  disposition: "resolved",
  source: "review",
  evidence: "no finding: purely descriptive review body",
  at: "2026-11-16T11:00:00Z",
  createdAt: "2026-11-16T11:00:00Z",
});

// Real examples (trimmed verbatim).
const REAL_REVIEW_5233 = review({
  submittedAt: "2026-11-16T22:40:47Z",
  author: { login: "human-reviewer" },
  body: 'Verdict: COMMENT — The plan calls "Promote to PRD" redundant with `/shipwright:prd` and `/shipwright:plan-session --initiative`, but that button is the only admin-UI path into autonomous planning.',
});
const REAL_REVIEW_5215 = review({
  submittedAt: "2026-11-16T23:18:40Z",
  author: { login: "human-reviewer" },
  body: "Verdict: COMMENT — Both bugs this plan describes have already shipped to main (BKH-1.1/1.2 in #5232, BKH-2.1 in #5242), and the rewritten plan now contradicts that code.",
});
const REAL_REVIEW_VOS_7870 = review({
  submittedAt: "2026-11-15T20:00:00Z",
  author: { login: "human-reviewer" },
  body: "Verdict: COMMENT — the fix this plan describes already landed on main in #7879, so the plan is stale on arrival.",
});
const REAL_THREAD_5208 = thread(
  "PRRT_real_5208_a",
  "Run count does not add up: six runs, the first two failed, so four completed — but P1 lists five timings. Fix the count or the list.",
);
const REAL_THREAD_5233 = thread(
  "PRRT_real_5233",
  'This removes more than a redundant button. Promoting an initiative sets `kind: "prd"`, which is the queue check-plan.ts reads.',
);

// Synthetic, modeled on the production report.
const DESCRIPTIVE_REVIEW = review({
  submittedAt: "2026-11-16T12:00:00Z",
  body: "This PR adds the preview hold loop and a PR comment builder. It wires the loop into the preview workflow and adds unit tests for the builder.",
});
const DESCRIPTIVE_THREAD = thread(
  "PRRT_descriptive",
  "FYI this helper mirrors the one in the admin package; it is only used here.",
);

describe("unclassifiedFindingCandidates (DTA-11.1)", () => {
  test("lists a qualified review body as a candidate carrying its ref, author and body", () => {
    const c = unclassifiedFindingCandidates(
      data({ reviews: { nodes: [DESCRIPTIVE_REVIEW] } }),
      "the-agent",
    );
    expect(c).toEqual([
      {
        kind: "review",
        ref: reviewRef(DESCRIPTIVE_REVIEW),
        author: "human-reviewer",
        body: DESCRIPTIVE_REVIEW.body,
      },
    ]);
  });

  test("lists a qualified unresolved thread as a candidate keyed by threadRef", () => {
    const t = DESCRIPTIVE_THREAD;
    const c = unclassifiedFindingCandidates(
      data({
        reviews: {
          nodes: [review({ body: "" })],
        },
        reviewThreads: { nodes: [t] },
      }),
      "the-agent",
    );
    expect(c).toEqual([
      {
        kind: "thread",
        ref: threadRef(t) as string,
        author: "human-reviewer",
        body: t.comments.nodes[0].body,
      },
    ]);
  });

  test("never lists what a structural exclusion already settled", () => {
    const reply = {
      author: { login: "pr-author" },
      body: "fixed",
      createdAt: "2026-11-16T13:00:00Z",
    };
    const c = unclassifiedFindingCandidates(
      data({
        reviews: { nodes: [DESCRIPTIVE_REVIEW] },
        comments: { nodes: [reply] },
      }),
      "the-agent",
    );
    expect(c).toEqual([]);

    const old = review({ body: "stale", commit: { oid: "older" } });
    expect(
      unclassifiedFindingCandidates(
        data({ reviews: { nodes: [old] } }),
        "the-agent",
      ),
    ).toEqual([]);
  });

  test("a thread without a node id cannot be ledgered and is not offered", () => {
    const t = thread("x", "FYI");
    const { id: _id, ...noId } = t;
    expect(
      unclassifiedFindingCandidates(
        data({
          reviews: { nodes: [review({ body: "" })] },
          reviewThreads: { nodes: [noId as ReviewThread] },
        }),
        "the-agent",
      ),
    ).toEqual([]);
  });
});

describe("no-finding ledger determination (DTA-11.1)", () => {
  test("descriptive-only review body no longer counts once ledgered no-finding", () => {
    const base = data({ reviews: { nodes: [DESCRIPTIVE_REVIEW] } });
    expect(hasUnaddressedFindings(base, "the-agent")).toBe(true);
    const classified = {
      ...base,
      findings: [noFinding(reviewRef(DESCRIPTIVE_REVIEW))],
    };
    expect(hasUnaddressedFindings(classified, "the-agent")).toBe(false);
    expect(unclassifiedFindingCandidates(classified, "the-agent")).toEqual([]);
  });

  test("non-substantive thread no longer counts once ledgered no-finding", () => {
    const base = data({
      reviews: { nodes: [review({ body: "" })] },
      reviewThreads: { nodes: [DESCRIPTIVE_THREAD] },
    });
    expect(hasUnaddressedFindings(base, "the-agent")).toBe(true);
    const classified = {
      ...base,
      findings: [noFinding(threadRef(DESCRIPTIVE_THREAD) as string)],
    };
    expect(hasUnaddressedFindings(classified, "the-agent")).toBe(false);
  });

  test("a new comment on a ledgered thread changes its ref and re-opens it", () => {
    const t = DESCRIPTIVE_THREAD;
    const ledger = [noFinding(threadRef(t) as string)];
    const reopened: ReviewThread = {
      ...t,
      comments: {
        totalCount: 2,
        nodes: [
          ...t.comments.nodes,
          {
            author: { login: "human-reviewer" },
            body: "actually this is wrong",
            createdAt: "2026-11-16T14:00:00Z",
          },
        ],
      },
    };
    expect(
      hasUnaddressedFindings(
        data({
          reviews: { nodes: [review({ body: "" })] },
          reviewThreads: { nodes: [reopened] },
          findings: ledger,
        }),
        "the-agent",
      ),
    ).toBe(true);
  });

  test("a patch-source resolved entry at a thread ref does not settle it", () => {
    const t = DESCRIPTIVE_THREAD;
    expect(
      hasUnaddressedFindings(
        data({
          reviews: { nodes: [review({ body: "" })] },
          reviewThreads: { nodes: [t] },
          findings: [{ ...noFinding(threadRef(t) as string), source: "patch" }],
        }),
        "the-agent",
      ),
    ).toBe(true);
  });

  test("real-finding fixtures still count as unaddressed and stay candidates", () => {
    for (const r of [
      REAL_REVIEW_5233,
      REAL_REVIEW_5215,
      REAL_REVIEW_VOS_7870,
    ]) {
      const d = data({ reviews: { nodes: [r] } });
      expect(hasUnaddressedFindings(d, "the-agent")).toBe(true);
      // Still offered for classification (the LLM, not the script, rules them
      // as real findings) and never auto-settled.
      expect(unclassifiedFindingCandidates(d, "the-agent")).toHaveLength(1);
    }
    for (const t of [REAL_THREAD_5208, REAL_THREAD_5233]) {
      const d = data({
        reviews: { nodes: [review({ body: "" })] },
        reviewThreads: { nodes: [t] },
      });
      expect(hasUnaddressedFindings(d, "the-agent")).toBe(true);
    }
  });

  test("ledgering one review does not settle a different review's real finding", () => {
    const d = data({
      reviews: { nodes: [DESCRIPTIVE_REVIEW, REAL_REVIEW_5233] },
      findings: [noFinding(reviewRef(DESCRIPTIVE_REVIEW))],
    });
    expect(hasUnaddressedFindings(d, "the-agent")).toBe(true);
    expect(
      unclassifiedFindingCandidates(d, "the-agent").map((c) => c.ref),
    ).toEqual([reviewRef(REAL_REVIEW_5233)]);
  });
});

describe("CLI --candidates (DTA-11.1)", () => {
  const SCRIPT = `${import.meta.dir}/compute-unaddressed-findings.ts`;
  const input = JSON.stringify({
    currentUser: "the-agent",
    headRefOid: HEAD,
    reviews: { nodes: [DESCRIPTIVE_REVIEW] },
    reviewThreads: { nodes: [] },
    comments: { nodes: [] },
  });

  test("adds unclassifiedCandidates to the output only when asked", async () => {
    const run = async (...args: string[]) => {
      const p = Bun.spawn(["bun", "run", SCRIPT, ...args], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const out = await new Response(p.stdout).text();
      await p.exited;
      return JSON.parse(out.trim());
    };
    expect(await run(input)).toEqual({ unaddressedFindings: true });
    const withCandidates = await run(input, "--candidates");
    expect(withCandidates.unaddressedFindings).toBe(true);
    expect(withCandidates.unclassifiedCandidates).toEqual([
      {
        kind: "review",
        ref: reviewRef(DESCRIPTIVE_REVIEW),
        author: "human-reviewer",
        body: DESCRIPTIVE_REVIEW.body,
      },
    ]);
    // flag position is irrelevant
    expect(
      (await run("--candidates", input)).unclassifiedCandidates,
    ).toHaveLength(1);
  });
});
