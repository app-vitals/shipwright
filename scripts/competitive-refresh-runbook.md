# Competitive refresh runbook

Operational runbook for refreshing this repo's competitor-facing content
(`site/src/pages/vs/*.astro` and `site/src/pages/compare.astro`) once
`scripts/check-competitive-freshness.ts` flags it as stale.

This is a plain, repo-local doc — **not** a `/shipwright:*` slash command. The
content it governs (competitor names, brand-policy claims, App-Vitals'
competitive positioning) is specific to this repo and has no business
shipping to every other install of the `shipwright` plugin. It lives under
`scripts/`, not `plugins/shipwright/commands/`, and carries no command
frontmatter, no `$ARGUMENTS` parsing, and no auto/interactive mode split —
it only ever runs one way: dispatched verbatim by a custom cron's
plain-string `prompt` (see `docs/extending.md`'s "Custom cron jobs for
scheduled automation" section) that names this file. Wiring up that cron via
`POST /agents/:id/crons` is a separate follow-up step, done after this file
merges and deploys — it is not part of writing this runbook and this runbook
does not configure it.

## 1. Trigger

This runbook runs when `scripts/check-competitive-freshness.ts`'s cron fires
its precheck and finds at least one stale page/row (exit 0). The precheck's
output block names every qualifying page/row (a `vs/*.astro` page, or a
single `compare.astro` landscape entry) along with its days-since-verified,
or flags it as `missing`/`unparseable` when its `verifiedDate` couldn't be
read at all — and points here. Treat every named item as a work item for
this run; do not stop at the first one.

Do not run this runbook speculatively — it only executes what the precheck's
own findings list names.

## 2. Read the competitor-naming policy first

Before touching any competitor claim — reading it for context is fine,
editing or re-verifying it is not — read `brand/MESSAGING.md` section
**"2. Competitor-naming policy (D10)"** in full. It is the binding policy for
everything this runbook touches:

- Competitor names are permitted only on the designated surfaces (`/vs/*`,
  `/self-hosted`, `/compare`, the homepage H1/meta phrase, nav/footer) —
  exactly the surfaces this runbook operates on.
- Every competitor fact must be cited and date-stamped with a visible
  "facts verified as of {date}" marker — this is the `verifiedDate` field
  the precheck is enforcing.
- Claims are restricted to the safe-to-print register in
  `goals/drafts/devin-alternative-positioning-research.md` §6 — anything not
  explicitly marked safe-to-print there needs fresh verification before it
  ships, and attribution-required claims must stay framed as "vendor
  claims/reports," never stated as fact.
- The **Never-print list** in that same section is binding on every
  surface — check any updated claim against it before writing it (e.g. no
  pricing figures at all, per the price-free rule in D5; no SWE-bench
  Verified numbers; no unverified valuation/funding figures until confirmed
  from primary coverage).

If a re-verification pass would produce a claim that lands on the
never-print list, do not write it — leave the existing (safe) framing and
fall back to the "unreachable or ambiguous" branch in step 5 instead, filing
a task so a human can decide how to phrase it.

## 3. Re-fetch every cited source, per flagged page/row

For each page/row the precheck flagged, find its citations and re-fetch
every one of them, then re-check the specific claim each source is cited
for. Citations live in two different shapes depending on the content
source:

- **`site/src/pages/vs/*.astro`** (e.g. `vs/devin.astro`): each page defines
  a top-level `src = { ... }` object of named source URLs (e.g.
  `src.deployment`, `src.pricing`, `src.releaseNotes`). Each entry in the
  page's `comparisonRows` array carries a `citation` field pointing back
  into that object — it is either a single URL string, an array of URL
  strings, or `null` (rows with no external citation, e.g. a straightforward
  license-name comparison, don't need one). Resolve `citation` back to the
  actual URL(s) via `src` before fetching.
- **`site/src/pages/compare.astro`**: each entry in the `landscape` array
  carries its own `citations: [{ label, url }, ...]` array directly — no
  indirection through a shared `src` object. Fetch every `url` in that row's
  array.

For every URL you fetch, re-check the **specific claim it was cited to
support** — not just "does the page still load." Concretely: pricing
figures, certification/compliance status, deployment model (self-hosted vs.
vendor-hosted, control-plane location), license type, and any other factual
claim the row/entry makes about that competitor. Compare what the source
says today against what the page currently claims.

## 4. Run a general recent-news search per flagged competitor

In addition to re-fetching each cited URL, run one general web search per
flagged competitor along the lines of:

```
"{competitor} acquisition funding news {current year}"
```

**Why this step exists, explicitly:** a per-citation re-fetch in step 3 can
only ever confirm or refute the claim the existing citation was already
scoped to. It cannot surface a **structural change** — an acquisition, a
shutdown, a rebrand, a pivot — that no single previously-cited URL would
ever mention, because that URL was never about that. This general search is
the mechanism that catches that class of gap. It is the same mechanism that
would have caught the SpaceX/Cursor acquisition gap identified during the
CF session that produced this runbook: a competitor's cited pricing/docs
pages stayed internally consistent and re-verified clean, while the
competitor itself had been acquired — something only a general news search,
not a citation re-fetch, would have surfaced.

Do this search for every flagged competitor, even ones whose per-citation
re-fetch in step 3 turned up no change — a citation staying accurate is not
evidence that the competitor itself hasn't undergone a structural change
that makes the surrounding claim (e.g. "independent company," ownership,
deployment offering) stale.

## 5. Decide: commit, PR, or file a task

Evaluate the combined result of steps 3 and 4 for each flagged page/row and
take exactly one of the following three actions. Do not mix branches within
a single page/row's outcome — if any part of it needs a PR, the whole
page/row's edit goes through a PR, not a direct commit.

### 5a. No material change found → bump `verifiedDate`, commit directly

If every cited source still supports its claim, and the general search
turned up nothing structural, the page/row's content is unchanged — only
its "as of" staleness is being cleared. Bump the page's (or landscape
entry's) `verifiedDate` field to today's date and commit that change
directly to main. No PR is needed for a pure date bump with no content
change.

### 5b. Material change found → update content + citations, open a PR

A change counts as material if it touches any of:

- a pricing figure or framing (even qualitative pricing language)
- certification/compliance status
- ownership or acquisition (the competitor was acquired, acquired someone,
  merged, rebranded, or shut down)
- deployment model (self-hosted vs. vendor-hosted, control-plane location,
  new on-prem/VPC/Outposts-style offering)
- any other claim on the page that is now simply false

When this happens: update the claim's text, update or add the citation(s)
it needs (per step 3's two citation shapes), bump `verifiedDate` to today,
and re-check the new wording against `brand/MESSAGING.md` D10 (designated
surfaces, cited + date-stamped, safe-to-print register, never-print list)
before finalizing it. **Do not commit this directly to main** — open a PR so
a human reviews the content change before it ships, same as any other
competitor-claim edit.

### 5c. Source unreachable or ambiguous → leave the claim, file a task

If a cited URL 404s, times out, redirects somewhere unrelated, or the
source's current content is genuinely ambiguous about whether the claim
still holds (not simply "still true" or "clearly false," but unclear either
way): **leave the existing claim exactly as it is.** Do not fabricate a
replacement claim, do not guess, and do not silently skip the item and move
on as if it were resolved. Instead file a task-store task describing the
gap, via `POST /tasks/bulk` (mirroring the pattern used by
`plugins/shipwright/skills/error-fix/SKILL.md`'s "8.2 Write and Append"
step):

```bash
cat > /tmp/competitive-refresh-tasks-$(date +%s).json <<'EOF'
[
  {
    "id": "competitive-refresh-vs-devin-pricing-20260925",
    "title": "Competitive refresh: unreachable/ambiguous source on vs/devin.astro",
    "source": "competitive-refresh",
    "repo": "app-vitals/shipwright",
    "layer": "Background",
    "status": "pending",
    "hitl": false,
    "description": "The `src.pricing` citation on site/src/pages/vs/devin.astro (comparisonRows 'Economics' row) is unreachable/ambiguous as of 2026-09-25: https://devin.ai/pricing returned <error/ambiguous result>. Left the existing claim in place per brand/MESSAGING.md D10 (never fabricate an unverified competitor claim). Re-verify this citation and refresh verifiedDate once resolved."
  }
]
EOF

curl -sf -X POST \
  -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
  -H "Content-Type: application/json" \
  "$SHIPWRIGHT_TASK_STORE_URL/tasks/bulk" \
  --data-binary @/tmp/competitive-refresh-tasks-$(date +%s).json | jq .

rm -f /tmp/competitive-refresh-tasks-*.json
```

Give the task's `id` a unique, descriptive slug (page/row + date, as above)
so a duplicate ID from a prior run's task doesn't collide (`/tasks/bulk` is
atomic and 409s the whole batch on any duplicate `id`). Set `hitl: true`
instead of `false` only when the ambiguity itself needs human judgment to
resolve (e.g. the source changed in a way that's genuinely unclear how to
frame, not just unreachable). `repo` must be the `org/repo` form
(`app-vitals/shipwright`), not a bare directory name.

The page/row's `verifiedDate` is **not** bumped in this branch — leaving it
stale is deliberate, so the next precheck run flags it again until the
underlying source issue is actually resolved.

## 6. What this runbook does not do

This runbook does not create or configure the cron that dispatches it.
Wiring a custom, non-system cron via `POST /agents/:id/crons` (per
`docs/extending.md`) with a `prompt` that references
`scripts/competitive-refresh-runbook.md` is a separate follow-up step, done
after this file has merged and deployed. Do not add that cron as part of
landing this file.
