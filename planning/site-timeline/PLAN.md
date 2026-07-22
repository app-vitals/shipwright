# Plan Session: site-timeline

Repo: shipwright

## What we're building

A new page on the public marketing site (`site/` — Astro) telling Shipwright's
origin story as a vertical timeline, from Dan running Claude Code in the cloud
(Nov 2025) through today's dogfooded, public, 50+-PRs-a-day loop. Content is
finalized — presentation-only, no backend/data-model/API surface.

## Codebase findings

- `site/` is Astro + Tailwind, zero runtime JS beyond the GA4 analytics tag.
  Pages define content arrays in frontmatter (`pillars`, `differentiators`,
  `stages` in `index.astro`) and map them into markup; custom interactivity
  is CSS-only (radio-input tabs), styled with page-scoped `<style>` blocks.
- No existing timeline/about/story page, and no timeline CSS pattern in
  `brand.css` — introduces one small scoped block reusing existing tokens
  (`--sw-color-brand-default` for the rail/dot, `--sw-color-border-muted`
  for the line).
- Every page ships a Playwright `*.spec.ts` smoke test (route → 200, heading
  visible, key content present) — see `tests/architecture.spec.ts`.
- Nav/footer links live in `BaseLayout.astro`, shared across all pages —
  adding the new page requires one addition there (desktop nav, mobile nav,
  footer).
- No complexity risks: no DB, no API, no business logic touched. Purely
  additive — new route, new nav links. Safe to deploy standalone: yes.

## Design

- New page: `site/src/pages/story.astro`, route `/story`, using
  `BaseLayout`, matching the visual language of `self-hosted.astro` /
  `compare.astro`.
- Timeline content as a frontmatter array (`timelineEntries: {date, body}[]`)
  mapped into a vertical list: left rail line + dot per entry, date in
  `sw-mono`/`sw-label` style, body in standard body text. Pure CSS, no JS.
- Add `Story` to `BaseLayout.astro`'s primary nav, mobile nav, and footer nav
  (between Architecture and GitHub).
- Optional light touch: link to `/story` from the homepage's existing
  "Proof" panel (`index.astro`) — that panel already gestures at dogfooding
  history, so it's a natural anchor.

### Approved timeline copy (verbatim — do not regenerate)

- **November 2025** — Dan starts running Claude Code in the cloud. Dave starts building the first autonomous workflow plugin.
- **January 2026** — The first real autonomous-loop plugin lands in the App Vitals marketplace, inspired by the open-source Ralph pattern. Auto-approve hooks, task types, plugin discovery — the pieces of a self-driving loop start coming together.
- **March 2026** — We start building Vitals OS — and from day one, we run the build through our own emerging Shipwright workflow. First real product built by the thing we were building.
- **April 2026** — The automation backbone goes in: a dev-task runner, agent cron infrastructure, scheduled review/patch/deploy cycles. This is where "autonomous" stops being aspirational.
- **May 2026** — Metrics wired in end to end. We can finally see what the agents are doing, not just trust that they're doing it.
- **June 2026** — Shipwright graduates out of the marketplace into its own repo. We scrub every internal reference and open it up.
- **Late June 2026** — Public launch.
- **Today** — Two of us, shipping 50+ PRs a day, running production infrastructure for clients almost entirely through the loop we built for ourselves.

### Test reasoning

New `tests/story.spec.ts`: route responds 200, `<h1>` visible, all 8 timeline
dates present in rendered page text, nav link to `/story` present. No
existing tests retired — net-new page.

## Task breakdown

Single task — small, self-contained, no natural split point (presentation-only,
one new page + one shared-layout touch).

| Task | Depends on | Blocks | HITL |
|---|---|---|---|
| STY-1.1 | — | — | — |

### STY-1.1 — Add origin-story timeline page to marketing site

- **Layer:** Frontend
- **Branch:** `feat/sty-1-1-story-timeline-page`
- **Hours:** 3
- **Complexity:** 2 (bumped to sonnet-tier: new page + shared-layout touch)
- **Model:** sonnet
- **HITL:** none
- **Safe to deploy standalone:** yes

**Acceptance criteria:**
- `site/src/pages/story.astro` renders the 8-entry timeline (Nov 2025 →
  today) using the approved copy verbatim, styled per `BaseLayout`/existing
  page conventions, zero runtime JS
- `BaseLayout.astro` nav (desktop + mobile) and footer link to `/story`
- `tests/story.spec.ts` added: route 200, heading visible, all 8 dates
  present in rendered text, nav link present — no existing tests removed
  (net-new page, nothing to retire)
- `task lint && task typecheck` clean for changed files

## HITL scan

No tasks require human steps.
