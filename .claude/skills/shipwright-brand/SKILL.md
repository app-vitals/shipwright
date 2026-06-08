---
name: shipwright-brand
description: >-
  This skill MUST activate whenever creating, editing, or reviewing ANY Shipwright Harness
  marketing or brand artifact — e.g. "make a Shipwright one-pager", "create a Shipwright
  Harness slide deck", "design the OG / social image", "build an on-brand landing-page section",
  "Shipwright marketing material", "is this on-brand?", "generate a Shipwright PDF/deck", or when
  editing anything under `brand/`, the marketing website, or `brand/templates/`. It enforces the
  locked design system in `brand/BRAND.md` + `brand/tokens.json` so every artifact (website,
  one-pager, deck, video slides, social card, PDF) is on-brand by construction, not by memory.
---

# shipwright-brand skill

## Purpose

Produce **on-brand Shipwright Harness marketing artifacts** by deriving everything from the locked
brand system — never by hand-picking colors, fonts, or copy. The system lives in:

- **`brand/tokens.json`** — canonical machine-readable tokens (colors, type scale, radii, gradients). The single source of truth.
- **`brand/BRAND.md`** — the human narrative: voice, logo rules, component patterns, content rules.
- **`brand/brand.css`** — generated stylesheet (CSS custom properties + utility classes) derived from `tokens.json`.
- **`brand/templates/`** — starting points: `one-pager.html`, `deck.html`, `social-card.html`.

## The lock (non-negotiable)

1. **Never write a raw hex, font name, or radius into an artifact.** Use `brand.css` variables (`var(--sw-color-brand-default)`) and utility classes (`.sw-btn`, `.sw-card`, `.sw-callout`, `.sw-pill`, `.sw-container`, `.sw-display`, `.sw-label`, `.sw-gradient-text`).
2. **If you need a value, read it from `tokens.json`** — don't recall it from memory.
3. **Green `#34C77B` is the hero; Patriot navy `#002244` is a support surface (never link text); `#4F8EF7` is the readable blue.** CTAs are green-fill / navy-text. Body copy uses `--sw-color-text-body` (80%), not the 50% editorial tone.

## Workflow (every artifact)

1. **Refresh the stylesheet** so it matches current tokens:
   `bun brand/build-brand-css.ts`  → writes `brand/brand.css`.
2. **Start from the matching template** in `brand/templates/` (copy it; don't author from scratch).
3. **Fill content** following the voice + hard content rules below. Keep the brand-vs-package naming rule.
4. **Lint the result** — fails on any off-palette color:
   `bun brand/brand-lint.ts <your-file.html>`  → fix every flagged hex (replace with a token/variable).
5. **For a single-file deliverable** (PDF, email, embedded): inline `brand/brand.css` into a `<style>` block so the artifact is self-contained. **For a PDF:** open the HTML and print to PDF (or `bunx playwright` screenshot). **For an OG/social PNG:** screenshot the `.og` element at exactly 1280×640.

> **Rendering note:** Playwright is **not** installed at the repo root — it lives in `site/node_modules` (Chromium already cached). Run any render/screenshot script with `site/` as the module-resolution root (`cd site` first, or place the `.mjs` there). `ffmpeg` is available system-wide for GIF/MP4 assembly (e.g. frame capture → looping GIF + MP4 for a terminal demo).

## Modes

| Mode | Template | Output |
|---|---|---|
| One-pager | `brand/templates/one-pager.html` | Self-contained HTML → PDF (dev- or leader-facing) |
| Slide deck | `brand/templates/deck.html` | Full-viewport slides; also the source for video slides |
| Social / OG | `brand/templates/social-card.html` | 1280×640 PNG (link previews, announcements) |
| Web component | `brand.css` variables + utility classes | On-brand section/snippet for the marketing site (map tokens into the site's Tailwind config) |

## Hard content rules (from BRAND.md §5 — every public artifact)

- **No client / customer / partner names.** Anonymize by role or industry.
- **No pricing, rates, or tiers.** The tool is free/MIT; services are discussed in conversation, never published.
- **No email-capture forms.** The only off-page CTA is the discovery call: `https://cal.com/app-vitals/discovery`.
- **No secrets, internal infra identifiers, or local file paths** — this repo is public.
- **Naming:** brand = **Shipwright Harness**; package/install = **`shipwright`** (`/plugin install shipwright@app-vitals/shipwright`). Never headline "shipwright" lowercase; never write the brand name as a command.
- **Voice:** honest, direct, engineer-to-engineer, metric-first. No hype, no emoji-laden superlatives.

## Reference

Read `brand/BRAND.md` for the full system (color roles, type scale, logo/mark rules, component patterns, OG spec). Change a token in `brand/tokens.json` → re-run step 1 → every artifact follows. Never hardcode a value that exists as a token.
