# Plan Session: onboarding-two-systems

**Repo:** shipwright
**No PRODUCT-SPEC.md** — verbal description, see history below.

## Problem

Shipwright has two categorically different systems wearing one name: (1) the delivery
lifecycle — plan/task/PR/review-patch/deploy, a five-beat story any engineer already
recognizes — and (2) the fleet-operations layer — crons, the shipwright-loop, agent
config, agent provisioning, task/PR filtering, cron run logs, work queue viewing — the
machinery needed to run (1) unattended across many autonomous agents. Neither of the two
front-door documentation pages says so.

## Investigation

- **Repo contributor docs** (`docs/*.md`): `docs/README.md` (landing/TOC) and
  `docs/quickstart.md` (setup) never state the two-systems split. `docs/architecture.md`
  organizes everything by deployment artifact (A→B→C→D), a "which service" view, not a
  "which kind of concept" view.
- **Public site docs** (`site/src/content/docs/*.mdx`, published to shipwrightharness.com):
  sidebar sections (Getting Started, Plugin, Agent, Operations, Reference — hardcoded
  `SECTION_ORDER` in `site/src/layouts/DocsLayout.astro`) already roughly split along these
  lines (Plugin ≈ lifecycle; Agent + Operations ≈ fleet-ops), but nothing says so.
  `introduction.mdx`, the actual front door, frames everything via the flat A→B→C→D table
  with no two-systems callout.
- **Investigated and rejected:** splitting `agent-skills.mdx` / `commands-reference.mdx`
  into lifecycle/fleet-ops halves. Both already have a real, more granular taxonomy (Core/
  Delivery Loop, Test Readiness Pipeline, Maintenance Patrols, Planning & Research, Other)
  that predates this work and doesn't map cleanly onto a two-way split — test-readiness and
  maintenance-patrol skills feed the same review/patch/deploy pipeline (closer to lifecycle
  than fleet-ops), and a couple of entries (`agent-admin`, `investigate-cron`) are
  fleet-ops-flavored but live inside a lifecycle-clustered page by design. Forcing a binary
  here would repeat the exact category-imposed-for-tidiness mistake this whole investigation
  was trying to avoid.
- **Investigated and deferred:** a sidebar cluster-grouping layer (`DocsLayout.astro` +
  static section→cluster map, no schema change needed — only 5 known sections) and
  restructuring `getting-started.mdx`/`running-locally.mdx`/`quickstart.md` around two
  explicit setup phases. Both are plausible improvements but unconfirmed — nobody has
  evidence the sidebar's flat section list, specifically, is what confuses newcomers. The
  front-door pages' missing framing is a *confirmed* gap (read both pages, it's not there).
  Building the more invasive, more-permanent-to-maintain nav restructure ahead of evidence
  it's needed repeats the over-building this project set out to check for. Deferred as a
  documented follow-up, not built speculatively.

## Design

Two independent, standalone tasks — fix the two confirmed front-door gaps only:

1. Rewrite `docs/README.md`'s opening to lead with the two-systems framing before the
   Contents list.
2. Rewrite `site/src/content/docs/introduction.mdx` to lead with the two-systems framing
   before the existing A→B→C→D table (which stays, demoted to "how it's deployed" detail).

No shared branch — the two files are independent audiences (contributors vs. public site
users) on independent toolchains (plain markdown vs. Astro build). Neither renames or
removes anything; both are additive framing changes.

## Tasks

| Task | Title | Depends on | Layer | Complexity/Model | HITL | Safe standalone |
|---|---|---|---|---|---|---|
| OTS-1.1 | Rewrite docs/README.md to lead with the two-systems framing | — | Shared | 1 / haiku | — | yes |
| OTS-1.2 | Rewrite introduction.mdx to lead with the two-systems framing | — | Shared | 2 / haiku | — | yes |

### Dependency Map

```
[START]
  ├─ OTS-1.1: Rewrite docs/README.md (no deps)
  └─ OTS-1.2: Rewrite introduction.mdx (no deps)
```

No dependency between the two tasks — independent files, independent audiences.

## Deferred (not queued — documented for later, pending evidence)

- Sidebar cluster grouping in `DocsLayout.astro` (static section→cluster map: Getting
  Started → orientation, Plugin → lifecycle, Agent + Operations → fleet-ops, Reference →
  reference; no schema change needed).
- Restructuring `getting-started.mdx` + `running-locally.mdx` (site) and `quickstart.md`
  (repo) around two explicit setup phases instead of lettered options.
- Revisit only if the front-door rewrites alone don't resolve the "onboarding feels
  overwhelming" reaction — build against confirmed evidence, not inference.

## HITL Scan

No tasks require human steps — pure documentation/prose changes, no infra, secrets, or
credentials involved.
