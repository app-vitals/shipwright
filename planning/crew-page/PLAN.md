# Plan: crew-page

Home repo: app-vitals/shipwright. Spec: PRODUCT-SPEC.md (spec 1).

## Pass 1 — 2026-11-27 — specs 1

### Design
Pure static marketing work in `site/`, no API/DB layers.
- `site/src/consts.ts`: add `CREW_APPLY_URL` beside `BOOKING_URL`, with `utm_source=shipwrightharness&utm_content=crew_page`. Placeholder value until the Kit URL exists.
- `site/src/pages/crew.astro`: BaseLayout + brand.css tokens, modelled on `story.astro`. Copy verbatim from the spec. Apply CTA is a plain `<a>`; no `<form>`, no email input (MESSAGING.md §4). Members list from a frontmatter array, empty state at launch.
- `site/src/components/SiteFooter.astro`: add `Crew` -> `/crew/` next to GitHub Discussions (both variants). Header nav untouched.
- `README.md`: one bullet after "Have us run it on your pipeline" in "See it in the wild".
- `site/tests/crew.spec.ts`: Playwright, same pattern as `story.spec.ts` (h1, three level headings in order, CTA href + utm_content, no form/email input, `expectNoRuntimeJsBeyondAnalytics`, footer link).
- Sitemap: automatic via `@astrojs/sitemap`; verified with a build check.

Test layers: e2e (Playwright) only; no unit/integration change.

### Tasks
| Task | Title | Depends on | HITL | Model |
|---|---|---|---|---|
| CRW-1.1 | feat: add /crew/ page, CREW_APPLY_URL const, footer link and Playwright spec | none | | sonnet |
| CRW-1.2 | docs: add Join the crew bullet to README | none (bundled on same branch) | | sonnet (bundle) |
| CRW-2.1 | chore: create Kit crew-applicant form and set CREW_APPLY_URL | CRW-1.1 | HITL | sonnet |

```
[START]
  ├─ CRW-1.1
  │     └─ CRW-2.1 (HITL)
  └─ CRW-1.2 (same branch as 1.1)
```

### Breaking Change Safety
All additive. Safe to deploy standalone: yes. The PR must stay draft until CRW-2.1 supplies the real Kit URL; CRW-2.1 pushes to the same branch (bundle), so the bundle gate holds the merge until it reaches pr_open.

### Not carried
- Newsletter exclusion segment (`crew-applicant` and not a subscriber) and GA4/Kit measurement: owned by Saul on the newsletter draft cron, not code.
- First 3-5 invites, swag, members list content: out of scope per spec.

## Decision Log
- Spec's "policy conflict" with MESSAGING.md: already resolved in the spec (link out, no embedded form); defaulted to adopting it as written.
- Task split: defaulted to one bundled branch `feat/crew-page` for page+README, and a separate HITL task for the Kit UI step — it needs a human and the spec says to keep the PR draft until then.
- Placeholder URL: defaulted to a clearly-marked Kit placeholder with the required UTMs so the spec's href assertion passes before the real URL lands.
- Owner: dan@app-vitals.com (from the originating PRD task).
