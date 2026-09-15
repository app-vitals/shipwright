# docs-sync: Flag, diff, and propose targeted updates to the marketing site's docs

Keep the marketing site's MDX documentation (`site/src/content/docs/*.mdx`) in sync with the canonical source it's derived from — `docs/*.md`, `plugins/shipwright/commands/*.md`, `plugins/shipwright/skills/*/SKILL.md`, etc. — without ever regenerating a page from scratch. This command consumes the page-scoped freshness signal from SDR-2 (`plugins/shipwright/scripts/check-site-docs-freshness.ts`) and, for each **flagged** page, shows the diff in its mapped source(s) since the page's own last-synced anchor and proposes a **targeted, section-scoped edit** that preserves the page's existing structure and voice. It never rewrites a page wholesale.

Interactive invocation waits for explicit human confirmation before editing anything. Auto/cron invocation never edits — it files a `hitl: true` proposal task in the task store instead, for a human to review and apply.

## Usage

```bash
/docs-sync [--auto]
```

- No flag — **interactive mode** (the default). Run by a human. Presents each flagged page's diff and a proposed edit, and waits for Apply/Skip before touching any file.
- `--auto` — **cron/unattended mode**, mirroring the `--auto` convention already used by `research-docs.md`. Never edits a file directly; files one `hitl: true` proposal task per flagged page instead.

## The source-of-truth mapping

`site/docs-source-map.json` (built by SDR-1) replaces any hardcoded section table as the mapping from site page to source:

```json
{ "<page>.mdx": ["<source path>", ...] }
```

Keys are bare `.mdx` filenames under `site/src/content/docs/`; values are repo-root-relative source paths (a file or a whole directory). See [`docs/site-docs-freshness.md`](../../docs/site-docs-freshness.md) for the full contract, including the empty-array `_notes` case (a page with no repo-doc source).

Per-page sync anchors live at `state/site-docs-last-synced.json` — `{ "<page>.mdx": { "sha": "...", "timestamp": "..." } }`, one entry per page, each updated independently. This file does not exist until the first page has ever completed a sync.

## Procedure

### Step 1: Resolve the list of flagged pages

**`--auto` mode:** This command is dispatched as the response to a `site-docs-freshness` cron whose `preCheck` is `plugins/shipwright/scripts/check-site-docs-freshness.ts` — per the agent type manifest's cron `preCheck` contract, the script's stdout becomes this prompt. Parse the flagged page names directly out of the invoking prompt (mirrors `research-docs.md` Step A0's "preCheck output becomes the prompt" pattern). Each qualifying page appears either with its changed-file summary, or — when it qualified with no changed-file detail (first run, or a permissive git-failure fallback) — the line `"{page}: no sync anchor found — run full docs check"`. Treat both forms as "this page is flagged"; don't require a changed-file list to proceed.

**Interactive mode with no preCheck context (manual invocation):** Run the precheck directly and capture its output:

```bash
bun plugins/shipwright/scripts/check-site-docs-freshness.ts
```

Exit 0 + stdout lists the flagged pages (same two line-shapes as above). Exit 1 + no output means nothing is flagged — report that and stop; there is nothing to propose.

### Step 2: Per flagged page — diff its mapped source(s)

For each flagged page:

1. Look up its source paths in `site/docs-source-map.json`.
2. Read that page's anchor from `state/site-docs-last-synced.json`, if present.
3. Diff:
   - **Anchor exists:** `git diff {anchor-sha}...HEAD -- {mapped source paths}`
   - **No anchor yet (first run):** treat the full current content of the mapped source(s) as the change scope — there's nothing to diff against, so read the source(s) in full instead of a diff.
4. Collect the diff (or full source content, for the no-anchor case) for use in Step 3.

If a page's mapped source array is empty, skip it — an empty mapping (paired with a `_notes` entry) means the page has no repo-doc source and can never be meaningfully diffed; `check-site-docs-freshness.ts` never flags such a page in the first place, so this is a defensive no-op.

### Step 3: Propose a targeted update

**Never regenerate the page.** Apply the section-rewrite procedure from [`plugins/shipwright/references/doc-refresh-recipe.md`](../../plugins/shipwright/references/doc-refresh-recipe.md) Part 2, adapted from `docs/*.md` to an MDX page (frontmatter + body):

1. Read the page's current heading hierarchy (its body, below the frontmatter block).
2. Map what changed in the diff (Step 2) to the section(s) it affects — the heading immediately above the affected content.
3. For each affected section, decide the operation using the recipe's vocabulary: **Update** (stale facts, keep structure), **Remove row** (a table entry for something now gone), **Replace** (the section's underlying source concept was wholly replaced), or **Delete section** (covered something removed with no replacement).
4. If the diff touches frontmatter-relevant facts (e.g. the section moved in the nav chain, or its one-sentence purpose changed), propose the frontmatter field edit too — see the frontmatter and navigation-chain rules below, which still apply unchanged.
5. Preserve everywhere: heading hierarchy and order, the page's existing tone and terminology, and any manually-written context that the diff doesn't touch.
6. Draft the edit as focused old/new strings for the `Edit` tool — one edit per affected section — never a whole-page `Write`.

#### Step 3, interactive mode

Present, per flagged page:

- The page name and its mapped source(s).
- The diff (or, for a first-run page, a summary of what the full source contains).
- The proposed targeted edit(s) from the procedure above, shown as a diff-style preview (old → new) before touching anything.

Then **wait for explicit human confirmation** — Apply or Skip — before editing. Do not proceed to an edit on an assumed or implied yes.

- **Apply:** Make the edit(s) with `Edit` (focused old/new strings). Then update just that page's entry in `state/site-docs-last-synced.json` to the current HEAD SHA and timestamp — every other page's entry is left untouched. Run the build validation (below).
- **Skip:** Make no changes to the page and do not touch its anchor entry. Move to the next flagged page.

#### Step 3, auto mode

Never edit a page directly, and never touch the anchor file — the anchor only advances on an actually-applied edit, and auto mode never applies one. For each flagged page, file **one** task-store proposal task via the same `/tasks/bulk` mechanism `research-docs.md` already uses (the same endpoint, same auth header — do not invent a second one):

```bash
curl -sf -X POST \
  -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
  -H "Content-Type: application/json" \
  "$SHIPWRIGHT_TASK_STORE_URL/tasks/bulk" \
  --data-binary @/tmp/docs-sync-proposal-tasks.json | jq .
```

Each task:

- `title: "Sync site page {page} with updated source"`
- `description`: the diff summary from Step 2, the affected section(s) identified in Step 3's procedure, and the proposed Update/Remove-row/Replace/Delete-section operation per section — enough for a human to review the proposal without re-deriving it.
- `"hitl": true` — this is a proposal, not an auto-appliable change. Site-facing published content is higher-stakes than an internal `docs/*.md` edit, so unlike `research-docs.md`'s existing bulk-filed tasks (which don't set `hitl`), docs-sync's proposals always do.
- `layer: "CLI"`
- `session: "docs-sync-cron"` — distinct from `docs-freshness-cron` so these are queryable separately.
- `branch: "docs/site-{page-slug}-{YYYYMMDD}"` — `{page-slug}` is the page's `.mdx` basename minus extension (e.g. a page file named `configuration.mdx` yields a page-slug of just "configuration", no extension), and `{YYYYMMDD}` is the run's UTC date (`date -u +%Y%m%d`). **The `branch` field is required** — `/shipwright:dev-task` blocks a task with no `branch` (it can't create a worktree) rather than silently proceeding, so an unbranched task here would stall until a human notices and backfills it by hand.

Never auto-edit in auto mode, regardless of how confident the proposed edit looks.

### Step 4: Build validation

Run after any edit actually applied (interactive mode's Apply path only — auto mode never edits, so it has nothing to validate):

1. Run `npm run build:check` from the `site/` directory to validate the Astro content collection against the schema.
2. If validation passes, report success for each regenerated section.
3. If validation fails, print the error and halt with a non-zero exit code (do not silently ignore schema violations).

## Frontmatter and navigation-chain conventions

These conventions govern any edit this command proposes to a page's frontmatter — unchanged from before, since a targeted update to an existing page still has to keep its frontmatter internally consistent.

**Frontmatter field rules:**
- `title` (required): Human-readable section title (capitalize each major word). E.g., "Getting Started", "Task Store API", "Deployment Guide".
- `description` (optional): A single sentence describing the section's purpose, written for someone new to Shipwright. E.g., "Clone the repo, install dependencies, and run the metrics dashboard locally in one prompt."
- `section` (required): The exact section-name value already used elsewhere in the site's nav — do not invent a new one for an existing page's targeted update. E.g., "Getting Started" (not "getting-started" or "Introduction").
- `order` (required): A number indicating the section's position in the navigation chain. Use increments of 1 (1, 2, 3, ...) or 10 (10, 20, 30, ...) for flexibility. Earlier sections should have lower order numbers.
- `prev` (optional): The name of the previous section in the navigation chain (use the `section` value, not the filename). E.g., `prev: Getting Started`.
- `next` (optional): The name of the next section in the navigation chain (use the `section` value, not the filename). E.g., `next: Configuration`.

**Navigation chain**: There is no global section registry to consult — derive the chain from the target page's neighbors. Read the neighboring pages' current frontmatter in `site/src/content/docs/`, order them by `order`, and set `prev` to the `section` value of the page immediately before the target and `next` to the `section` value of the page immediately after it. If a neighbor's own frontmatter looks inconsistent, flag it for human review rather than editing it as a side effect of this page's update.

If a section has no predecessor or successor, omit the `prev` or `next` field.

## Public-repo scrubbing rules

Before applying any edit, apply these scrub rules. If found, flag the page for human review instead of applying the edit:

**Do NOT include:**
- Client/customer/partner names: "app-vitals", "Vitals", internal code names, customer accounts
- Internal infrastructure: Cloud project IDs, internal hostnames, internal Kubernetes cluster names, internal CDN URLs
- Internal URLs: GitHub links to private issues/PRs, Slack channel links, Jira issue links, internal wiki URLs
- Local filesystem paths with usernames: `/Users/<name>/`, `/home/<name>/`
- Internal compensation, financials, or PII

**Do include:**
- Public GitHub URLs (e.g., the official shipwright-harness repo)
- Open-source project names and public documentation links
- Cloud provider names (AWS, GCP, Azure, etc.) and public documentation

**If unsure:** Flag it for human review. It's better to ask than to commit proprietary content to a public repo.

## Error handling

- **No pages flagged:** Report that the precheck found nothing to sync and stop; there is nothing to propose.
- **Missing mapped source file:** Flag the page for human review — the source map itself is enforced elsewhere (`scripts/docs-source-map.unit.test.ts`), but if a mapped path genuinely doesn't resolve at diff time, don't attempt to diff or propose against it.
- **Build validation failure (interactive Apply path):** Print the Astro error; do not update the page's anchor entry, since the applied edit hasn't been confirmed safe.
- **Ambiguous diff:** If the diff doesn't clearly map to an existing section, flag the page for human review with details of the ambiguity rather than guessing at a Replace or Delete-section operation.

## Notes

- **Never a full regenerate:** every edit this command proposes or applies is section-scoped, using `Edit` with focused old/new strings — never a whole-page `Write`. See `plugins/shipwright/references/doc-refresh-recipe.md` Part 2 for the shared procedure this adapts.
- **Human-first in both modes:** interactive mode never edits without an explicit Apply; auto mode never edits at all — it only proposes, via a `hitl: true` task-store task.
- **Mirrors plugin conventions:** This command follows the same instruction-file style as `.claude/skills/*/SKILL.md` and `plugins/shipwright/commands/research-docs.md`, but without YAML frontmatter (commands are flat markdown) and scoped to this repo's own marketing-site sync rather than the distributable plugin.
