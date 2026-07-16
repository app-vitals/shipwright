# Shipwright Marketing Messaging Policy

**Status:** canonical · **Session:** `devin-alternative-repositioning` · **Last updated:** 2026-07-15
**Source of truth for claims:** `goals/drafts/devin-alternative-positioning-research.md` (2 adversarially-verified deep-research passes, 47 confirmed claims, all fetches dated 2026-07-14). No comparison claim ships without checking this register first.
**Conflict rule:** `brand/BRAND.md` wins on visual/voice conflicts. This document wins on messaging/copy-policy conflicts (tagline, competitor naming, pricing, claims discipline). Where `brand/BRAND.md` still encodes the old blanket "no competitor names" rule, it is superseded by D10 below and must be amended to match.

---

## 1. Tagline hierarchy (D1)

The canonical H1/tagline is now:

> **"The open source alternative to Devin."**

This is the literal homepage H1, and drives `<title>`, meta description, and OG tags across `site/src/layouts/BaseLayout.astro`.

The prior canonical tagline:

> "The open-source autonomous delivery agent for Claude Code."

is **demoted, not deleted** — it remains true and useful, and appears as supporting copy (subhead/body context) rather than the primary headline.

The defensible one-liner, used as hero subhead and general reinforcement copy:

> "The only MIT-throughout, spec-to-deploy autonomous delivery agent that runs entirely in your own cloud."

The eyebrow "Built on Claude Code" is retained above the H1 on all surfaces that carry it today — Claude Code is the platform, not a competitor, and stays featured prominently per `brand/BRAND.md`.

## 2. Competitor-naming policy (D10)

The old blanket rule ("never name a competitor") is **amended, not deleted**. Competitor names are now permitted, but only under all of the following conditions:

- **Designated surfaces only:** competitor names may appear on `/vs/*` pages (e.g. `/vs/devin`), `/self-hosted`, the homepage H1/meta phrase itself (plus one linked, factual sentence), and the global site nav and footer (`BaseLayout.astro`) — limited to a single "vs Devin" link in each, pointing to `/vs/devin`, with no additional claim text. No other surface may name a competitor — this includes the rest of the homepage body, `/compare`'s general landscape framing beyond its teaser link, blog posts, and README.
- **Every competitor fact must be cited and date-stamped.** Link to the primary source and show a visible "facts verified as of {date}" marker on any page that states one.
- **Claims are restricted to the research doc's safe-to-print register.** Anything not explicitly marked safe-to-print in `goals/drafts/devin-alternative-positioning-research.md` §6 needs fresh verification before it ships. Attribution-required claims (e.g. vendor-published customer metrics) must be framed as "Cognition claims/reports," never stated as fact.
- **Re-verify before each ship.** Comparison facts are dated 2026-07-14; fast-moving claims (pricing, star counts) must be re-checked immediately before a comparison page ships, not assumed still current.

**Never-print list (binding on every surface):**

- "Devin has no private deployment" / "no VPC option" (three overreaching versions of this claim were refuted in verification — the safe framing is "Even Devin's dedicated single-tenant VPC tier is Cognition-hosted, never in your environment.")
- Any pricing figure — ours or a competitor's (see §3, price-free rule)
- ACU pricing presented as a self-serve fact (Devin's ACU pricing is Enterprise-only, rates undisclosed)
- Any SWE-bench Verified number (invalidated Feb 2026)
- OpenCode's star count / developer-count claims (directory-attributed, unverified) — do not name OpenCode at all
- Any search-volume or demand figure (none survived verification)
- Unverified valuation/funding figures (e.g. reported raise/valuation numbers) until confirmed from primary coverage

## 3. Pricing policy (D5)

Comparison surfaces are **entirely price-free** — this extends the standing "no pricing" rule to competitors as well as to Shipwright itself. No dollar figure, tier name, or "starting at" framing may appear anywhere on `/vs/*`, `/self-hosted`, `/compare`, or the homepage, for Shipwright or any named competitor. Economics are framed qualitatively instead: "Free, MIT, no tiers or seats" vs. "Commercial subscription (see vendor pricing)."

## 4. Standing rules (unchanged)

These carry forward from prior policy and are not affected by D1/D10/D5:

- No client names or client counts, in any form (including vague framing like "a variety of clients, from startups to a Fortune 200").
- No email capture on marketing surfaces.
- Brand name is **Shipwright Harness**; the installable package is **`shipwright`** — use each correctly per context.
- Claude Code is the platform Shipwright is built on and for, not a competitor — feature it prominently and positively.

## 5. Corrections to prior stale entries

- **Booking URL:** the canonical discovery-call destination is `https://vitals-os.com/cal/book/discovery`, exported as `BOOKING_URL` from `site/src/consts.ts`. Prior copy referencing a `cal.com` link is stale and incorrect — always reuse the `BOOKING_URL` constant rather than hardcoding a URL.
- **Task tracking:** work is tracked in the Shipwright task store (queried via the task-store HTTP API), not GitHub Issues. Any copy or internal doc referencing "tasks tracked as GitHub Issues" is stale and should be corrected to reference the task store.

## 6. Test decision

This file is a markdown policy document with no runtime I/O — there is no direct test layer for it. The policy it defines is exercised indirectly through `site/tests/home.spec.ts`'s rewritten copy-policy assertions (competitor-naming scope, price-free rule, never-print phrases) and equivalent assertions on `/vs/devin` and `/self-hosted` specs. No test change is needed for this file itself.
