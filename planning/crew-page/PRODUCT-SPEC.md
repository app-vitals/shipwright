# Shipwright Crew page

## Problem

People who build real things with Shipwright have nowhere to show it and no way into the team's orbit. Dan (10-20 reframe): "the community is the tutorials", and we want to "geek out with our community". Builders' work is also our best content: tutorials bring in about 150x the subscribers per video that shorts do. Factory runs a ranked ambassador program (factory.com/ambassador, the "Factory Guild"). We're building a more casual version that still puts craft first: show us real work, and we curate for quality.

Goals served: #4 tutorials published (crew builds become episodes), #2 design partners (builders turn into partners), #1 star momentum (public builds link back to the repo).

## Decisions already made (Dan 11-27, Dave OK'd)

- Three levels: **Deckhand → First Mate → Master Builder**
- A **monthly crew call for everyone**, plus a **monthly 1:1 for Master Builders**
- The program gets **its own page**, with a **link from the README**
- People apply with a **form** (not GitHub Discussions)

## Scope

### 1. New page: `site/src/pages/crew.astro` → `/crew/`

- Uses `BaseLayout`, existing `brand.css` tokens only, and zero runtime JS beyond analytics (same pattern as `story.astro`; the test helper `expectNoRuntimeJsBeyondAnalytics` must pass).
- `<title>`: `Join the Crew | Shipwright Harness`
- Meta description: `Build something real with Shipwright, show us, and join the crew. Three levels, a monthly crew call, and your work featured in our tutorials.`
- No emoji in the rendered copy. No em dashes in the copy.

**Copy (verbatim, page order):**

> **Eyebrow:** Built on Claude Code
>
> **H1:** Join the Crew.
>
> **Subhead:** Build something that lasts with Shipwright, show us, and come build the next thing with us.
>
> **Section: What we're looking for**
> Show us what you've built. A real repo, a real workflow, a real result. A demo you can rerun beats a big claim. We read every submission and curate for quality.
>
> Anything public counts: a repo, a write-up, a video, a talk. Vague hype, private work, and reposted marketing copy don't.
>
> **Section: The levels** (three cards, side by side on desktop, stacked on mobile)
>
> **Deckhand**
> *How you get in:* Build something real with Shipwright, make it public, and send us the link.
> - A private crew Slack channel with Dave and Dan
> - A monthly crew call with the whole crew
> - Early access to new features
> - A shout-out for your build on our channels
> - Real input on the roadmap
>
> **First Mate**
> *How you get in:* Keep shipping public work and help other builders along the way. We'll invite you.
> - Everything Deckhands get
> - Your build featured in a how-to-factory episode, a short, or a co-written post
> - Your name on this page and in the README
>
> **Master Builder**
> *How you get in:* Invite only, reviewed once a year. Long-term builders who shape Shipwright itself.
> - Everything First Mates get
> - A monthly 1:1 with Dave or Dan
> - Roadmap previews
> - Co-create launch content with us
>
> **Section: How it works**
> 1. Build something real with Shipwright.
> 2. Make it public.
> 3. Apply with the link. We read every one and reply either way.
>
> **CTA button:** Apply to the Crew → `{CREW_APPLY_URL}`
>
> **Section: The Crew**
> Empty state at launch: "The first crew is forming now. Your name could be here."
> (Later: a list of member name + build link, from a frontmatter array in the page.)

### 2. Apply form: external, linked rather than embedded

**Policy conflict found:** `site/brand/MESSAGING.md` §4 says **"No email capture on marketing surfaces."** An embedded form would break that rule. So:

- The page **links out** to a hosted form. It does **not** embed one. The site keeps zero email capture.
- Put the URL in one constant, `CREW_APPLY_URL`, in `site/src/consts.ts` next to `BOOKING_URL`, with a UTM `utm_source=shipwrightharness&utm_content=crew_page`.
- **Form host:** a Kit-hosted landing page (we already run Kit, so no new spend). **HUMAN STEP (Dan, Kit UI):** create the form with these fields: name, email, link to public build (required), "What did you build and what happened?" (required, long text), GitHub/socials (optional). Set it to tag `crew-applicant`, then paste the hosted URL into the PR. Until then, leave the button pointing at a placeholder and keep the PR in draft.
- **Applicants are not newsletter subscribers.** Kit adds every form signup to the account. Before the first broadcast after launch, add an exclusion segment (`crew-applicant` and not a newsletter subscriber), or add a newsletter opt-in checkbox to the form. Saul owns this check on the newsletter draft cron.

### 3. README link: root `README.md`, "See it in the wild" section

Add one bullet after "Have us run it on your pipeline":

```
- **Join the crew**: built something real with Shipwright? [Show us](https://shipwrightharness.com/crew/). Three levels, a monthly crew call, and your build featured in our tutorials.
```

### 4. Footer link

Add `Crew` → `/crew/` to `SiteFooter.astro` next to `GitHub Discussions`. Leave the header nav alone; it's tight already.

## Tests: `site/tests/crew.spec.ts` (Playwright, same pattern as `story.spec.ts`)

- `/crew/` returns 200 and has a visible h1 "Join the Crew."
- All three level headings render, in order: Deckhand, First Mate, Master Builder
- The Apply CTA is an `<a>` whose href starts with the `CREW_APPLY_URL` value and carries `utm_content=crew_page`
- **No `<form>` and no `input[type=email]` on the page** (locks in the MESSAGING.md rule)
- No runtime JS beyond analytics
- Footer has a Crew link to `/crew/`
- `npm run build:check` passes (brand-lint)

## Acceptance criteria

1. `/crew/` is live with the copy above, verbatim
2. The README "See it in the wild" section has the Join the crew bullet
3. The footer links to `/crew/`
4. The page contains no embedded form and no email field
5. `crew.spec.ts` passes in CI
6. Sitemap includes `/crew/` (automatic via `@astrojs/sitemap`, so just verify)

## Out of scope / later

- Swag (costs money, needs Dan/Dave approval and a budget)
- Members list content (fills in once people are accepted)
- Crew Slack channel and call logistics (Dan/Dave)
- Mentioning Shipwright Managed early access (left off the public copy until the Managed name and capacity are decided)
- First 3 to 5 invites (Saul drafts them, Dan sends)

## Measurement (Saul)

- GA4: `/crew/` sessions and outbound clicks on Apply, from the `crew_page` UTM
- Kit: count of `crew-applicant` tags
- 30-day check (around 2027-01-01): applications ≥ 3, and at least 1 build turned into a tutorial or short. If applications are under 3, the page isn't the problem; the problem is how we get it in front of people, so lean on direct invites

