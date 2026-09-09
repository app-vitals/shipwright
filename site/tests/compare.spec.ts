import { expect, test } from "@playwright/test";
import { BOOKING_URL } from "../src/consts";
import {
  expectBannedPhrasesAbsent,
  expectNoDollarFigures,
  expectNoRuntimeJsBeyondAnalytics,
} from "./helpers";

// Fulfill external font CDN requests immediately so the page's 'load' event
// fires even when CI can't reach external networks.
test.beforeEach(async ({ page }) => {
  await page.route(
    /fonts\.googleapis\.com|fonts\.gstatic\.com|api\.fontshare\.com|googletagmanager\.com/,
    (route) =>
      route.fulfill({ status: 200, contentType: "text/css", body: "" }),
  );
});

// /compare smoke tests — the one page that names other tools (the homepage
// #differentiators stays competitor-free; this page is the deliberate exception).

test("compare route responds 200", async ({ page }) => {
  const response = await page.goto("/compare");
  expect(response?.status()).toBe(200);
});

test("compare page leads with the comparison heading", async ({ page }) => {
  await page.goto("/compare");
  await expect(
    page.getByRole("heading", { name: /How Shipwright compares/i }).first(),
  ).toBeVisible();
});

test("compare page ships no runtime JS beyond the analytics tag", async ({
  page,
}) => {
  await page.goto("/compare");
  await expectNoRuntimeJsBeyondAnalytics(page);
});

test("landscape table names the commercial tier", async ({ page }) => {
  await page.goto("/compare");
  // New commercial-tier competitors must appear
  for (const tool of [
    "Devin",
    "Cursor",
    "GitHub Copilot Agent",
    "OpenHands",
    "Augment Code",
    "Factory",
    "Shipwright Harness",
  ]) {
    await expect(page.getByText(tool, { exact: false }).first()).toBeVisible();
  }
  const tableText =
    (await page.locator("table").first().textContent()) ?? "";
  expect(tableText).not.toContain("Cline");
  expect(tableText).not.toContain("Aider");
  expect(tableText).not.toContain("Goose");
  expect(tableText).not.toContain("Continue");
  expect(tableText).not.toContain("Kilo Code");
});

test("market structure section is present with 3 poles", async ({ page }) => {
  await page.goto("/compare");
  // Section heading
  await expect(
    page
      .getByRole("heading", { name: /market structure|where tools sit/i })
      .first(),
  ).toBeVisible();
  const text = (await page.locator("main").textContent())?.toLowerCase() ?? "";
  // Three poles
  expect(text).toContain("individual copilot");
  expect(text).toContain("team ai workflow");
  expect(text).toContain("autonomous agent");
  // Shipwright positioned in the middle
  expect(text).toContain("shipwright");
});

test("table includes team-relevant capability columns", async ({ page }) => {
  await page.goto("/compare");
  const tableText =
    (await page.locator("table").first().textContent())?.toLowerCase() ?? "";
  // At least 5 new team-relevant dimensions beyond License/Models
  expect(tableText).toContain("task queue");
  expect(tableText).toContain("team visibility");
  expect(tableText).toContain("policy controls");
  expect(tableText).toContain("human review");
  expect(tableText).toContain("cron");
});

test("Devin head-to-head is present and fair", async ({ page }) => {
  await page.goto("/compare");
  await expect(
    page.getByRole("heading", { name: /Shipwright vs Devin/i }),
  ).toBeVisible();
  const text = (await page.locator("main").textContent())?.toLowerCase() ?? "";
  // Must have choose-Devin-when framing (honest, not dismissive)
  expect(text).toContain("choose devin");
  // Must have choose-shipwright-when framing
  expect(text).toContain("choose shipwright");
});

test("customizability section is present", async ({ page }) => {
  await page.goto("/compare");
  await expect(
    page
      .getByRole("heading", { name: /customiz/i })
      .first(),
  ).toBeVisible();
  const text = (await page.locator("main").textContent())?.toLowerCase() ?? "";
  // Should mention that defaults are swappable / customizable
  expect(text).toContain("opinionated");
  expect(text).toContain("customiz");
});

test("page is honest — it does NOT claim an empty category and does NOT overstate lock-in", async ({
  page,
}) => {
  await page.goto("/compare");
  const text = (await page.locator("main").textContent())?.toLowerCase() ?? "";
  // Honesty guardrails from the competitive research.
  expect(text).toContain("table-stakes");
  expect(text).toContain("contested");
  // The Claude-native trade-off is stated plainly, not hidden.
  expect(text).toContain("claude code only");
});

test("self-host section covers Kubernetes / Helm and the open-source own-it angle", async ({
  page,
}) => {
  await page.goto("/compare");
  await expect(
    page.getByRole("heading", { name: /Self-host it/i }),
  ).toBeVisible();
  const text = (await page.locator("main").textContent())?.toLowerCase() ?? "";
  expect(text).toContain("kubernetes");
  expect(text).toContain("helm");
  expect(text).toContain("mit-licensed");
  // The actual Helm install command is shown.
  await expect(
    page.getByText("helm install shipwright shipwright/shipwright", {
      exact: false,
    }),
  ).toBeVisible();
});

test("focused OpenHands head-to-head is present and fair", async ({ page }) => {
  await page.goto("/compare");
  await expect(
    page.getByRole("heading", { name: /Shipwright vs OpenHands/i }),
  ).toBeVisible();
  // It credits OpenHands as the category leader (fair framing).
  await expect(page.getByText(/category leader/i).first()).toBeVisible();
});

test("/compare links to the full /vs/openhands comparison", async ({
  page,
}) => {
  await page.goto("/compare");
  await expect(
    page.getByRole("link", { name: /full.*Shipwright vs OpenHands comparison/i }),
  ).toHaveAttribute("href", "/vs/openhands");
});

// Re-verified 2026-09-05: OpenHands' Agent Canvas ships Slack/GitHub/GitLab
// integration across tiers (not Slack-absent), a dashboard for managing
// automations (not "Limited" visibility), and RBAC as a commercial-only
// capability (not mere "Config-level" controls). The landscape row must
// reflect these corrected, sourced values — see site/src/pages/vs/openhands.astro
// for the cited detail.
test("landscape table reflects corrected OpenHands values (re-verified 2026-09-05)", async ({
  page,
}) => {
  await page.goto("/compare");
  const row = page.locator("table tr").filter({
    has: page.locator("td").first().getByText("OpenHands", { exact: true }),
  });
  const rowText = (await row.textContent()) ?? "";
  expect(rowText).toContain("Dashboard (Agent Canvas)");
  expect(rowText).toContain("RBAC (commercial)");
  expect(rowText).not.toContain("Limited");
  expect(rowText).not.toContain("Config-level");
  // Slack workflow cell (10th column) must now read "Yes", not "No".
  const cells = row.locator("td");
  await expect(cells.nth(8)).toHaveText("Yes");
});

test("focused Augment Code head-to-head is present and fair", async ({
  page,
}) => {
  await page.goto("/compare");
  await expect(
    page.getByRole("heading", { name: /Shipwright vs Augment Code/i }),
  ).toBeVisible();
  const text = (await page.locator("main").textContent())?.toLowerCase() ?? "";
  expect(text).toContain("choose augment code");
  expect(text).toContain("choose shipwright");
});

test("CTA repeats the install command and links GitHub + discovery call", async ({
  page,
}) => {
  await page.goto("/compare");
  await expect(
    page.getByText("/plugin install shipwright@app-vitals/shipwright", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: /github/i }).first(),
  ).toHaveAttribute("href", /github\.com\/app-vitals\/shipwright/);
  await expect(
    page.locator("#cta").getByRole("link", { name: /discovery call/i }),
  ).toHaveAttribute("href", BOOKING_URL);
});

// Re-verified 2026-09-05: 12 stale/wrong competitor cells corrected across
// Cursor, GitHub Copilot Agent, Augment Code, and Devin (see MESSAGING.md
// D10 verification pass). This test asserts one corrected cell per the
// same row-locator pattern as the OpenHands correction test above.
test("landscape table reflects corrected Cursor values (re-verified 2026-09-05)", async ({
  page,
}) => {
  await page.goto("/compare");
  const row = page.locator("table tr").filter({
    has: page.locator("td").first().getByText("Cursor", { exact: true }),
  });
  const rowText = (await row.textContent()) ?? "";
  expect(rowText).toContain("Team dashboard");
  expect(rowText).toContain("Model/MCP/repo allowlists");
  expect(rowText).toContain("No shared backlog");
  expect(rowText).toContain("PR review, no plan gate");
  // Slack workflow cell (9th column, 0-indexed 8) must now read the
  // corrected value, not "No".
  const cells = row.locator("td");
  await expect(cells.nth(8)).toContainText("Yes — @cursor launches cloud agents");
  // Cron scheduling cell (8th column, 0-indexed 7): Cursor shipped cron and
  // event automations for cloud agents (Aug 19 2026 changelog), so this cell
  // must no longer read "No".
  await expect(cells.nth(7)).toContainText("Yes — cron and event automations");
  await expect(
    row.locator("td").first().locator('a[href*="cloud-agent/automations"]'),
  ).toHaveCount(1);
});

// Typographic consistency: every value cell in the landscape table that
// qualifies a Yes/No uses an em dash, matching the pre-existing rows. An
// ASCII hyphen in a cell value means a new/edited cell drifted from the
// house style.
test("landscape table cell values use em dashes, never ASCII hyphens", async ({
  page,
}) => {
  await page.goto("/compare");
  const cells = await page.locator("table tbody tr td").allTextContents();
  // Guard against a vacuous pass if the locator ever stops matching.
  expect(cells.length).toBeGreaterThan(50);
  for (const cell of cells) {
    expect(cell).not.toMatch(/\b(Yes|No|Partial) - /);
  }
});

// AC #8: the head-to-head prose must stay consistent with the corrected,
// cited table row — no uncited fast-moving figures (MESSAGING.md D10), and
// it must reflect the Agent Canvas / ACP capabilities the row now cites.
test("OpenHands head-to-head prose is current and cited", async ({ page }) => {
  await page.goto("/compare");
  const section = page
    .locator("section")
    .filter({ has: page.getByRole("heading", { name: /Shipwright vs OpenHands/i }) });
  const text = (await section.textContent()) ?? "";
  // Stale, uncited star count is gone; the re-verified figure is cited.
  expect(text).not.toContain("78K");
  expect(text).toContain("~86.3k");
  await expect(
    section.getByRole("link", { name: /86\.3k GitHub stars/i }),
  ).toHaveAttribute("href", "https://github.com/OpenHands/OpenHands");
  // Decision-relevant context the corrected row already substantiates.
  expect(text).toContain("Agent Canvas");
  expect(text).toContain("ACP");
  // Both projects occupy the same architectural layer — say so plainly.
  expect(text).toMatch(/same architectural layer/i);
});

// The page must carry a visible "facts verified as of" marker (MESSAGING.md
// D10) — mirrors the wording pattern on vs/devin.astro and vs/factory.astro.
test("compare page shows a verified-date marker", async ({ page }) => {
  await page.goto("/compare");
  const text = (await page.locator("main").textContent()) ?? "";
  expect(text).toContain("September 5, 2026");
  expect(text.toLowerCase()).toContain("facts verified as of");
});

// Every competitor row must link at least one primary source (MESSAGING.md
// D10); the Shipwright Harness self-row is not a competitor and carries no
// citation.
test("every competitor row in the landscape table links a primary source", async ({
  page,
}) => {
  await page.goto("/compare");
  for (const tool of [
    "Devin",
    "Cursor",
    "GitHub Copilot Agent",
    "OpenHands",
    "Augment Code",
    "Factory",
  ]) {
    const row = page.locator("table tr").filter({
      has: page.locator("td").first().getByText(tool, { exact: true }),
    });
    const links = row.locator("td").first().locator("a");
    expect(await links.count()).toBeGreaterThan(0);
  }
});

// MESSAGING.md D5 bans tier-name framing (e.g. "Enterprise (...)" as a
// stand-in for a feature list, "premium mode", "enterprise upsell").
test("compare page contains no tier-name framing", async ({ page }) => {
  await page.goto("/compare");
  const text = (await page.locator("main").textContent()) ?? "";
  expect(text).not.toContain("Enterprise (");
  expect(text).not.toContain("premium mode");
  expect(text).not.toContain("enterprise upsell");
});

test("compare page markets no pricing", async ({ page }) => {
  await page.goto("/compare");
  await expectBannedPhrasesAbsent(page, [
    "pricing",
    "per month",
    "per seat",
    "/month",
    "/mo",
    "subscription",
    "free trial",
  ]);
  await expectNoDollarFigures(page);
});

test("footer nav links to /compare", async ({ page }) => {
  await page.goto("/");
  const footer = page.locator("footer");
  await expect(
    footer.getByRole("link", { name: /^Compare$/i }),
  ).toHaveAttribute("href", "/compare");
});

test("header nav links to /compare on every page", async ({ page }) => {
  for (const route of ["/", "/compare"]) {
    await page.goto(route);
    const header = page.locator("header");
    await expect(
      header.getByRole("link", { name: /^Compare$/i }),
    ).toHaveAttribute("href", "/compare");
  }
});

// MKT-LADDER-NARRATIVE-1: the pillars section is retired from the old
// "Plan-approval / Tests land / Claude-native" framing to a direct-comparison
// narrative, with citations on the two pillars that reference OpenHands/Factory.
test("pillars section presents the retired-narrative titles and intro", async ({
  page,
}) => {
  await page.goto("/compare");
  const text = (await page.locator("main").textContent()) ?? "";
  expect(text).toContain(
    "Three things hold up under a direct comparison. We have retired the ones that did not.",
  );
  for (const title of [
    "Tests are enforced, not offered",
    "An opinionated loop you can take apart",
    "Open throughout, not open core",
  ]) {
    expect(text).toContain(title);
  }
});

// MESSAGING.md D10: every competitor fact must be cited, and the citation
// must sit on the pillar that actually states the fact. Assert per-card, not
// per-section — a section-wide link count passes even when a citation is
// attached to the wrong pillar (which is exactly how the QA-is-CI's-job link
// ended up on the architecture pillar).
test("each pillar cites the competitors its own body names", async ({
  page,
}) => {
  await page.goto("/compare");
  const heading = page.getByRole("heading", {
    name: /What actually makes Shipwright different/i,
  });
  const section = page.locator("section").filter({ has: heading });
  const card = (title: string) =>
    section.locator(".sw-card").filter({
      has: page.getByRole("heading", { name: title }),
    });

  // Pillar 1 names OpenHands, Factory, Augment and Cursor — all four need a
  // primary source on this card.
  const testsPillar = card("Tests are enforced, not offered");
  for (const url of [
    "https://docs.openhands.dev/openhands/usage/use-cases/qa-changes",
    "https://docs.factory.ai/features/missions/overview",
    "https://docs.augmentcode.com/using-augment/agent",
    "https://cursor.com/for/test-generation",
  ]) {
    await expect(testsPillar.locator(`a[href="${url}"]`)).toHaveCount(1);
  }

  // Pillar 2 names OpenHands' trigger-to-PR flow (Plan Mode included) and its
  // ephemeral, run-scoped tracking — both need a primary source on this card.
  // Factory is no longer named in this pillar's body (MKT-PILLAR2-PRECISION-1),
  // so its citation must not appear here. This pillar is about
  // architecture/extensibility, not testing, so the QA-is-CI's-job link
  // belongs on pillar 1 and must not appear here either.
  const loopPillar = card("An opinionated loop you can take apart");
  for (const url of [
    "https://docs.openhands.dev/openhands/usage/use-cases/qa-changes",
    "https://docs.factory.ai/features/missions/overview",
  ]) {
    await expect(loopPillar.locator(`a[href="${url}"]`)).toHaveCount(0);
  }
  for (const url of [
    "https://www.openhands.dev/blog/ai-agent-workflow-automation",
    "https://docs.openhands.dev/sdk/guides/github-workflows/todo-management",
  ]) {
    await expect(loopPillar.locator(`a[href="${url}"]`)).toHaveCount(1);
  }

  await expect(
    card("Open throughout, not open core").locator(
      'a[href="https://docs.openhands.dev/enterprise/enterprise-vs-oss"]',
    ),
  ).toHaveCount(1);
});

// Factory's Missions overview documents QA testing running automatically as a
// mission works — so the pillar must not frame Factory's testing as opt-in.
test("pillar 1 does not claim Factory's test generation is opt-in", async ({
  page,
}) => {
  await page.goto("/compare");
  const text = (await page.locator("main").textContent()) ?? "";
  expect(text).not.toContain("Factory, Augment and Cursor all offer test");
  expect(text).toMatch(/Factory's Missions do run QA/);
});

test("retired pillar copy no longer appears anywhere on /compare", async ({
  page,
}) => {
  await page.goto("/compare");
  const text = (await page.locator("main").textContent()) ?? "";
  expect(text).not.toContain("Plan-approval by default");
  expect(text).not.toContain("Claude-native by design");
});

// MKT-PILLAR2-PRECISION-1: OpenHands ships an opinionated per-run flow
// (Plan Mode, trigger -> sandbox -> PR) — the old "primitives and no opinion"
// claim understated them. This phrase must not appear anywhere on the site.
test("the retired 'primitives and no opinion' claim no longer appears anywhere on /compare", async ({
  page,
}) => {
  await page.goto("/compare");
  await expectBannedPhrasesAbsent(page, ["primitives and no opinion"]);
});

// The corrected pillar-2 claim: OpenHands' unit of work is a run, Shipwright's
// is a durable backlog. Humans review gate for OpenHands stays "Optional" in
// the landscape table (Plan Mode is opt-in, not a default gate) — unchanged
// by this correction.
test("pillar 2 states the run-vs-backlog distinction and leaves OpenHands' human review gate unchanged", async ({
  page,
}) => {
  await page.goto("/compare");
  const text = (await page.locator("main").textContent()) ?? "";
  expect(text).toContain("Their unit of work is a run. Ours is a backlog.");
  expect(text).toContain(
    "the plan is a markdown file, not tracked work, and nothing survives the run",
  );
  const row = page.locator("table tr").filter({
    has: page.locator("td").first().getByText("OpenHands", { exact: true }),
  });
  await expect(row).toContainText("Optional");
});

test("homepage differentiators bridge into /compare (competitor-free)", async ({
  page,
}) => {
  await page.goto("/");
  const link = page
    .locator("#differentiators")
    .getByRole("link", { name: /how Shipwright compares/i });
  await expect(link).toHaveAttribute("href", "/compare");
  // The homepage bridge must not name competitors (that rule is page-specific).
  await expect(link).not.toHaveText(/openhands|cline|aider|goose|continue|kilo/i);
});
