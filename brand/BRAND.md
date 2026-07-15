# Shipwright Harness — Brand & Design System

> **This document is the lock.** Every marketing artifact — website, README, docs, decks, PDFs, one-pagers, video slides, social cards — inherits the rules here. The canonical machine-readable values live in [`tokens.json`](./tokens.json); this file is the human-facing narrative that mirrors them. When the two disagree, `tokens.json` wins (and should be fixed).
>
> The `shipwright-brand` skill reads `tokens.json` and applies this system so artifacts are on-brand **by construction**, not by memory.

---

## 1. Identity

**Shipwright Harness** is an open-source **autonomous coding agent + system** for Claude Code — a **deployable cloud agent** plus the autonomous coding system (built on the Shipwright plugin) that powers it. Use it interactively inside Claude Code, or deploy the agent to your cloud to run autonomously on your own codebase. It is built by [App Vitals](https://app-vitals.com) and shares that family's dark, premium, engineer-first aesthetic — but it is its own product, with its own signature color.

**Two faces, one product:**
- **The agent** — deploy it to your cloud; autonomous coding on your codebase, with the same review/test bar as human code. This is the hero. **You interact with it in Slack** (DMs, @mentions, voice notes, reactions) and it **ships on a schedule via cron jobs** — these are sanctioned, first-class public messages for the agent face, not buried config details.
- **The system** — the autonomous coding system (built on the Claude Code Shipwright plugin): plan · build · review · metrics.

> **One system, two ways to run it** — a **Claude Code plugin** you drive at your prompt, and a **Slack-native cloud agent** you deploy and let ship on a schedule. Both run the same system; lead with the surface that fits the audience.

> **Do not market "the loop."** The `/dev-loop` (autonomous queue-drain) is an internal/power-user workflow, not a public message. Outward materials lead with the **agent** and the **system** — never "the delivery loop." (Marketing **Slack** as the interaction surface and **cron** as the autonomy mechanism is fine and encouraged; "the loop" as a named concept is what stays internal.)

**Category & competitive frame:** Shipwright is the **free, open-source, own-it** alternative to closed, hosted autonomous coding agents. The wedge is price, ownership, and control: the closed agents are rented and run on someone else's infrastructure; Shipwright is **free and MIT**, runs in *your* environment, on *your* codebase, deployed to *your* cloud — and the people who built it can operate it alongside you. Lead with **free · open-source · you own it · your cloud · same quality bar as human code** when contrasting. **Competitor naming is surface-scoped, not blanket-banned** — see `planning/shipwright-marketing/MESSAGING.md`'s competitor-naming policy (D10) for which surfaces may name a competitor and under what conditions.

**Claude Code is the platform — feature it proudly (it is NOT a competitor).** Shipwright is built **on** and **for** Claude Code; "for Claude Code" anchors the tagline and every hero. Lean into it: it's a large, directly-relevant audience and a real discovery/SEO driver, and we're genuinely proud Claude Code users. "Built on Claude Code" / "for Claude Code" should appear prominently and positively across materials.

**Brand vs. package — the naming rule (do not blur these):**

| Context | Use |
|---|---|
| Marketing brand, website, headlines, decks, social | **Shipwright Harness** |
| Repo, plugin, install string, npm/package, CLI, code | **`shipwright`** |
| Install command (verbatim) | `/plugin install shipwright@app-vitals/shipwright` |
| Domains | `shipwrightharness.com` (canonical), `shipwright-harness.com` → 301 redirect |

This is the Astro/Bun pattern: the marketed name and the install string differ on purpose. Never write "install Shipwright Harness" as a command, and never headline a marketing page with "shipwright" lowercase.

**Taglines (canonical — don't paraphrase in primary placements):**
- Primary: **"The open-source autonomous delivery agent for Claude Code."**
- Supporting: **"A deployable cloud agent and the autonomous coding system that powers it — built on the Shipwright plugin, running on your own codebase."**

**The metaphor:** a shipwright builds ships; this one ships software. "Ship" is the through-line — it's why the signature color is a shipped/merged green.

---

## 2. Color

Navy base, **ship-green hero**, App Vitals blues as support. Green carries brand + CTA + success/merged; blue/cyan/violet carry links, diagrams, and gradients. Hex values are canonical in [`tokens.json`](./tokens.json).

### Backgrounds & borders (navy)
| Token | Hex | Use |
|---|---|---|
| `bg.base` | `#080E1E` | Page background, darkest surface |
| `bg.raised` | `#0F172A` | Cards, raised panels |
| `bg.overlay` | `#1E293B` | Popovers, code blocks, hover surfaces |
| `border.subtle` | `#1E293B` | Hairline dividers on base |
| `border.muted` | `#334155` | Card borders |
| `border.strong` | `#475569` | Emphasis borders, inputs |

### Brand (ship green) — the hero
| Token | Hex | Use |
|---|---|---|
| `brand.default` | `#34C77B` | Brand, primary CTA fill, links of emphasis, success/merged state |
| `brand.strong` | `#2BAE6E` | CTA hover/active, pressed states |
| `brand.soft` | `#0F2D1E` | Green-tinted surfaces: badges, callouts, "shipped" panels |
| `brand.onBrandText` | `#080E1E` | Text/icon ON a green fill — always dark navy, never white (contrast) |

> **CTA rule:** primary buttons are `brand.default` fill with `brand.onBrandText` (navy) label; hover → `brand.strong`. Dark text on bright green is the high-contrast, on-brand pairing — never white-on-green.

### Support (Patriot / nautical blue family) — never the hero
**Patriot Blue = PMS 289 C, `#002244`** — a deep maritime navy (fitting for a shipwright). It's a *surface* color, not a text color: too dark to read on the near-black base. Its contrast-safe sibling `support.patriotBright` carries anything that must read on dark.

| Token | Hex | Use |
|---|---|---|
| `support.patriot` | `#002244` | Deep-blue surfaces & panels, diagram/node backgrounds (e.g. "planning"/in-progress fills), gradient anchor. **Not for text on the dark base.** |
| `support.patriotBright` | `#4F8EF7` | The readable member: standard links, in-progress / PR-open state, primary diagram **strokes** on dark |
| `support.cyan` | `#22D3EE` | Secondary accent, brand-gradient endpoint |
| `support.violet` | `#8B5CF6` | Tertiary accent, support-gradient endpoint |

Support colors stay supporting. If a layout reads as "blue," it's wrong — green should be the thing the eye lands on. Use deep `support.patriot` as a fill/background (it pairs with green like a hull against water); use `support.patriotBright` only where blue must read as text/stroke.

### Text ramp (white on dark)
| Token | Value | Use |
|---|---|---|
| `text.heading` | `#FFFFFF` | Headings, key numbers |
| `text.body` | `white / 80%` | **Docs & README body** — long-form, must stay readable (WCAG) |
| `text.editorial` | `white / 50%` | **Marketing** hero subtext / big-type editorial only |
| `text.muted` | `white / 25%` | Captions, hints, disabled |

> Use `text.body` (80%) for anything someone actually reads at length. Reserve `text.editorial` (50%) for large marketing type, where low contrast reads as premium rather than illegible. Don't set paragraph docs at 50%.

### State palette (delivery pipeline + diagrams)
Mirrors the pipeline the agent runs. Use these for status pills, CI/PR/review indicators, and flow diagrams (incl. the README mermaid):
| State | Token | Hex |
|---|---|---|
| Success / merged / passing | `state.success` | `#34C77B` (= brand) |
| In progress / PR open | `state.progress` | `#4F8EF7` (bright patriot) |
| Pending / idle | `state.pending` | `#475569` |
| Warning / blocked | `state.warning` | `#F5B544` |
| Failing / error | `state.danger` | `#F87171` |

### Gradients & glow
- **Brand gradient** (`#34C77B → #22D3EE`): green→cyan, for brand moments — hero accents, the standalone mark's glow, OG art.
- **Support gradient** (`#4F8EF7 → #8B5CF6`): bright-patriot→violet, for supporting/decorative fills only.
- **Deep gradient** (`#002244 → #080E1E`): Patriot navy fading into the base — for deep-blue panels and section backdrops that need a touch more color than flat navy.
- **Glow orbs:** `glow.brand` `rgba(52,199,123,0.25)` as the dominant ambient orb; `glow.support` bright-patriot `rgba(79,142,247,0.22)` as a secondary, smaller orb. Animate slowly (drift), behind content, never over text.

---

## 3. Typography

Three families, unchanged from the App Vitals family so artifacts feel related:
- **Display — Space Grotesk** (Google Fonts): headings, brand, big statements. Weights 500/700.
- **Body — General Sans** (Fontshare): paragraphs, UI. Weights 400/500/600.
- **Mono — JetBrains Mono** (Google Fonts): labels, tags, code, metadata. Weights 400/500.

### Scale (canonical in `tokens.json → type`)
| Token | Size | Line | Weight | Tracking | Font |
|---|---|---|---|---|---|
| `displayXl` | 4.5rem / 72px | 1.05 | 700 | −0.02em | Space Grotesk |
| `displayL` | 3rem / 48px | 1.08 | 700 | −0.02em | Space Grotesk |
| `h1` | 2.25rem / 36px | 1.15 | 700 | −0.01em | Space Grotesk |
| `h2` | 1.75rem / 28px | 1.2 | 600 | −0.01em | Space Grotesk |
| `h3` | 1.375rem / 22px | 1.25 | 600 | 0 | Space Grotesk |
| `bodyL` | 1.125rem / 18px | 1.6 | 400 | 0 | General Sans |
| `body` | 1rem / 16px | 1.6 | 400 | 0 | General Sans |
| `small` | 0.875rem / 14px | 1.5 | 400 | 0 | General Sans |
| `label` | 0.8125rem / 13px | 1.4 | 500 | 0.08em | JetBrains Mono, UPPERCASE |

**Rules:** headings always Space Grotesk; never set body copy in the display or mono face; `label` (mono, uppercase, tracked) is the signature eyebrow/tag treatment — use it for section kickers, status pills, and code-adjacent metadata.

---

## 4. Logo & mark

> This section defines the **rules**. Producing the final vector asset is a separate task; nothing here should block on a finished logo.

**Wordmark — primary lockup:** "Shipwright" set in Space Grotesk Bold (`text.heading` white) followed by "Harness" in Space Grotesk Medium at `text.body`/`brand.default`. Optional compact lockup: "Shipwright" bold white + `HARNESS` as a JetBrains-Mono uppercase tag in `brand.default`.

**Standalone mark — concept direction:** a single-weight stroke reading as a ship's **keel/hull that resolves into a checkmark or upward arrow** — "idea → shipped." Drawn at one stroke weight so it survives monochrome and small sizes. Rendered in `brand.default` on navy by default.

**Required variants:**
- Full color — ship green on `bg.base` navy
- Reverse — navy on ship green
- Mono white — `#FFFFFF` (for photos, dark UI, terminals)
- Mono black — `#080E1E` (for light/print)

**Min sizes:** mark 16px (favicon) / 24px (UI); wordmark min height 20px.
**Clear space:** ≥ the cap-height of the mark on all four sides; never crowd.
**Don'ts:** don't recolor the mark into support blue; don't add gradients to the mark itself (gradient lives in glow/art, not the logo); don't stretch, rotate, or outline; don't place full-color mark on mid-tone backgrounds (use mono).

**Social / OG image — `1280×640`:** `bg.base` navy field, mark + wordmark (left or centered), primary tagline in `h2`, a single soft green→cyan glow orb behind, subtle grain. Safe margin 80px; text never inside the outer 80px.

---

## 5. Voice & tone

Honest, direct, engineer-to-engineer, metric-first. No hype, no client names, no pricing on public surfaces (App Vitals content rules, inherited). Show the work; let it speak.

| Do | Don't |
|---|---|
| "Deploy the agent to your cloud — it ships on your codebase, reviewed and tested." | "Revolutionize your engineering with AI! 🚀" |
| "Free and open-source — the own-it alternative to closed, hosted agents." | "10× better than the closed tools!!!" (and never name a competitor) |
| "Built on Claude Code — we use it every day and love it." | "The #1 AI coding tool, powered by the best model ever!!!" |
| "Runs on any repo — Node, Rust, Go, Python, Ruby, Make." | "Works with everything." |
| "Tests land with the code, at the correct layer." | "Best-in-class quality, guaranteed." |
| "Open source, MIT. Install in two minutes." | Any pricing, tier, or "request a quote" language. |
| "First-time-quality rate, estimation accuracy, review verdicts." | "Blazingly fast. World-class. Game-changing." |

**Hard content rules (every public artifact):**
- **No client / customer / partner names.** Anonymize by role or industry if a story is needed.
- **Competitor names are surface-scoped, not blanket-banned.** Default to positioning generically as the free, open-source, own-it alternative to closed, hosted agents. Where a competitor name is used, follow `planning/shipwright-marketing/MESSAGING.md`'s competitor-naming policy (D10) — it governs which surfaces may name a competitor, citation/date-stamping requirements, and the never-print list. **Exception: Claude Code** is the *platform* Shipwright is built on and for, **not** a competitor — feature it prominently and proudly (it's also a major discovery/SEO driver).
- **No pricing, rates, or tiers.** The tool is free/MIT; services are discussed in conversation, not published.
- **No email-capture forms.** The only CTA off the page is the discovery call: `https://cal.com/team/app-vitals/discovery-call`.
- **No secrets, internal infra identifiers, or local file paths** in anything committed (the repo is public).
- Co-founders, when named: **Dan McAulay** and **Dave O'Dell**.
- The COSS posture is the quiet bridge: give the tool away; "work with the people who built it" is a soft, no-pressure path — never a hard upsell.

---

## 6. Component patterns

The shared visual vocabulary (reused from the App Vitals one-pager / discovery-report family, re-tokened to Shipwright). Every component pulls from `tokens.json`.

- **Stat card** — `bg.raised`, `border.muted`, `radius.lg`. Big number in `text.heading` (display weight), label in `label` (mono, uppercase, muted). Optional `brand.default` top accent rule.
- **Callout** — left border 3px + soft tinted fill: success → `brand.soft` bg / `brand.default` border; info → blue tint; warning → amber. Body in `text.body`.
- **Code block** — `bg.overlay`, `radius.md`, JetBrains Mono, `text.body`. Inline code: mono, `brand.default` on `brand.soft`.
- **Before / After card** — two-up; "before" muted/neutral, "after" carries a `brand.default` accent (the shipped side is green).
- **Pipeline / flow diagram** — the plan→build→review→ship stages; node **fills** use deep `support.patriot` (planning/in-progress) shading to `brand.soft` green for shipped/merged; **strokes** use `support.patriotBright` (in progress) and `brand.default` (shipped); labels in the state palette. Keep the README mermaid colors consistent with these.
- **Status pill** — `radius.pill`, `label` type, colored by state token (success green / progress blue / pending slate / warning amber / danger red).
- **Primary CTA button** — `brand.default` fill, `brand.onBrandText` (navy) label, `radius.md`; hover `brand.strong`. Secondary CTA — transparent, `border.strong`, white label.
- **Ambient background** — navy field + slow-drifting `glow.brand` orb (dominant) and a smaller `glow.support` orb; optional grain overlay. Always behind content, never reducing text contrast.

---

## 7. Assets & conventions

Brand-system assets live under `brand/assets/` (colocated with this doc):
```
brand/
  BRAND.md            ← this file (human narrative)
  tokens.json         ← canonical machine-readable tokens (skill reads this)
  assets/
    logo/             ← wordmark + mark, all four variants (SVG)
    og/               ← social/OG images (1280×640 PNG)
```

**Naming:**
- `shipwright-harness-wordmark.svg`, `shipwright-harness-mark.svg`
- variant suffixes: `-reverse`, `-mono-white`, `-mono-black`
- `og-default-1280x640.png` (and named variants, e.g. `og-docs-1280x640.png`)

**Fonts:** Space Grotesk + JetBrains Mono via Google Fonts; General Sans via Fontshare. Self-host or link per surface; keep the stack order in `tokens.json → font`.

> The repo already has a root `assets/` directory; brand-system source-of-truth assets belong under `brand/assets/` so they sit next to the system that governs them.

---

## 8. How to use this system

- **Generating any artifact?** Go through the `shipwright-brand` skill — it reads `tokens.json` and applies sections 2–6 automatically. Don't hand-pick colors.
- **Building the website / docs?** Map `tokens.json` straight into the Tailwind config (the App Vitals marketing-site config is the structural reference; swap in these tokens — green hero, blue support).
- **Changing a token?** Edit `tokens.json` only; this doc and every downstream artifact follow. Never hardcode a hex that exists as a token.
- **Reviewing an artifact for "on-brand"?** Green is the hero (not blue); CTAs are green-fill/navy-text; body copy is `text.body` 80% (not 50%); no pricing, no client names, no email capture; brand name "Shipwright Harness" vs. package `shipwright` used correctly.
