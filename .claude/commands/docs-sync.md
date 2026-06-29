# docs-sync: Regenerate MDX documentation from source

Regenerate the marketing site's MDX documentation from the canonical `docs/` source files. This command syncs `site/src/content/docs/*.mdx` with the corresponding markdown and code in `docs/`, deriving human-friendly content (not verbatim copies) for a public audience.

## Usage

```bash
/docs-sync [FLAGS]
```

## Flags

- `--section <name>` — Regenerate only one section (e.g., `/docs-sync --section getting-started`). Does not touch other section files.
- `--rebuild` — Regenerate all sections from their source docs.

If neither flag is given, `/docs-sync --rebuild` is assumed.

## Section registry

Map each section to its source docs and the target MDX file:

| Section | Source Docs | Target MDX | Section Name | Description |
|---------|-------------|-----------|--------------|-------------|
| `getting-started` | `docs/quickstart.md` | `site/src/content/docs/getting-started.mdx` | `Getting Started` | One-prompt onboarding, prerequisites, and copy-paste quickstart |
| `introduction` | `docs/architecture.md`, `docs/README.md` | `site/src/content/docs/introduction.mdx` | `Getting Started` | Four-artifact design (plugin → metrics → agent → task-store), workspace layout, and architectural overview |
| `reference` | `docs/configuration.md` | `site/src/content/docs/reference.mdx` | `Reference` | All configuration options: plugin env vars, `.shipwright.json` keys, agent env vars, and policy fields |
| `task-store` | `docs/task-store.md` | `site/src/content/docs/task-store.mdx` | `Task Store` | Task store API, data model, ephemeral document store, and scoped tokens |
| `testing` | `docs/testing.md`, `docs/test-readiness/test-system.md` | `site/src/content/docs/testing.mdx` | `Testing` | Four-layer test model (unit / integration / smoke / e2e), run commands, speed budgets, and isolation contract |
| `deploy` | `docs/deploy-kubernetes.md`, `docs/helm-repo.md` | `site/src/content/docs/deploying-to-cloud.mdx` | `Operations` | Kubernetes deployment: Minikube, GKE (Gateway API + cert-manager), EKS (ALB), agent provisioning RBAC, and auth modes |
| `metrics` | `docs/metrics.md` | `site/src/content/docs/metrics.mdx` | `Metrics` | Metrics service (provider-agnostic JSON endpoints, dashboard, dual auth, environment) |
| `agent` | `docs/agent.md` | `site/src/content/docs/agent.mdx` | `Agent` | Shipwright agent runtime: admin CRUD API, admin UI, Prisma store, encryption, and environment configuration |
| `migration` | `docs/migration.md` | `site/src/content/docs/migration.mdx` | `Migration` | Breaking changes and migration steps across versions |

## Procedure

### Step 1: Parse arguments

Extract `--section` and `--rebuild` flags from the invocation. Set the operation mode:
- If `--rebuild` is present: regenerate all sections listed in the Section Registry.
- If `--section <name>` is present: regenerate only that section.
- If neither: default to `--rebuild` (regenerate all).

### Step 2: For each section to regenerate

#### 2a. Read source docs

For the section's "Source Docs" list, read all referenced files from `docs/` (e.g., `docs/quickstart.md`, `docs/architecture.md`). If any source file is missing, flag the section for human review (see Step 4).

#### 2b. Derive human-friendly content

**Do NOT copy-paste the source docs verbatim.** Instead:

1. Extract the key concepts, headings, and code blocks from the source.
2. Rephrase in clear, conversational prose written for a public audience (no internal jargon, assume the reader is new to Shipwright).
3. Organize into a logical narrative structure with headings and subheadings.
4. Preserve code examples and command snippets exactly as they appear in the source.
5. Remove internal asides, warnings, and caveats that are only relevant to contributors (e.g., "this is going public" warnings, local development notes).
6. If the section touches on deployment or cloud infrastructure, verify that no internal hostnames, project IDs, or client names appear in the output.

**Example transformation:**

Source (from `docs/quickstart.md`):
```
Run it from **inside** the cloned repo (the prompt's step 1 clones and `cd`s for you first).
It is **idempotent** — safe to re-run: ...
```

Derived content (for MDX):
```
Run the quickstart script from inside the cloned repository. It is idempotent and safe to re-run.
```

#### 2c. Generate MDX with frontmatter

Create or update `site/src/content/docs/<section>.mdx` with:

**Frontmatter** (YAML block at top, delimited by `---`):
```yaml
---
title: <Section Title>
description: <1-sentence description of what the reader will learn>
section: <Section Name>
order: <numerical order in the nav chain>
prev: <optional previous section name>
next: <optional next section name>
---
```

**Frontmatter field rules:**
- `title` (required): Human-readable section title (capitalize each major word). E.g., "Getting Started", "Task Store API", "Deployment Guide".
- `description` (optional): A single sentence describing the section's purpose, written for someone new to Shipwright. E.g., "Clone the repo, install dependencies, and run the metrics dashboard locally in one prompt."
- `section` (required): The exact value from the "Section Name" column in the registry table above — use it verbatim. Do not derive this from the section key or title. E.g., "Getting Started" (not "getting-started" or "Introduction").
- `order` (required): A number indicating the section's position in the navigation chain. Use increments of 1 (1, 2, 3, ...) or 10 (10, 20, 30, ...) for flexibility. Earlier sections should have lower order numbers.
- `prev` (optional): The name of the previous section in the navigation chain (use the `section` value, not the filename). E.g., `prev: Getting Started`.
- `next` (optional): The name of the next section in the navigation chain (use the `section` value, not the filename). E.g., `next: Reference`.

**Navigation chain**: Using the section registry order, set `prev` and `next` to create a continuous chain through the docs. Use the `section` value (from the Section Name column) for prev/next references. For example:
- introduction (order 0): `next: Getting Started`
- getting-started (order 1): `prev: Getting Started`, `next: Reference`
- reference (order 3): `prev: Getting Started`, `next: Task Store`

If a section has no predecessor or successor, omit the `prev` or `next` field.

**Content body** (after frontmatter):

1. Start with an `# <title>` heading matching the frontmatter title.
2. Write the human-friendly content derived in step 2b.
3. Use Markdown headings (`##`, `###`, etc.) to organize subsections.
4. Preserve code blocks and command examples exactly from the source.
5. Ensure all internal links (e.g., "see Configuration") are written in plain text (not clickable links, as the site's router will handle nav).

### Step 3: Validate generated MDX

For each regenerated section:

1. **Schema check**: Verify that the frontmatter contains all required fields (`title`, `section`, `order`) and that optional fields are strings (if present).
2. **Content check**: Verify that the body is well-formed Markdown with no syntax errors.
3. **Link check**: Ensure no links point to internal file paths (e.g., no `[see this](../docs/foo.md)`); use plain text references instead.
4. **Public-repo scrub**: Scan the entire file for:
   - Client names (e.g., "app-vitals", "customer X")
   - Internal hostnames or infrastructure IDs (e.g., "internal-gke-cluster.example.com", project IDs)
   - Internal Slack/GitHub/Jira links (e.g., "https://github.com/app-vitals/...", "#internal-channel")
   - Local filesystem paths with usernames (e.g., "/Users/dave/...")
   - Internal warnings or contributor-only notes
   
   If found, rewrite to remove these references before writing the file.

### Step 4: Flag sections for human review

If a section **cannot be fully sourced** from `docs/` + code (e.g., the source file is missing, or the section needs content that doesn't exist in the source material), print a review flag and do **NOT** generate or overwrite the MDX file:

```
[HUMAN-REVIEW] <section>: Cannot fully source from docs/. Details:
- Missing: docs/xxx.md
- Needs external reference: [describe what's missing]

Skipping regeneration for <section>; please add source material or update manually.
```

**Examples of sections that might need human review:**
- Slack Integration — not documented in `docs/`, requires custom content about Slack event handlers
- Video tutorials — requires production of video content, not sourced from markdown

### Step 5: Build validation

After all sections are regenerated:

1. Run `npm run build:check` from the `site/` directory to validate the Astro content collection against the schema.
2. If validation passes, report success for each regenerated section.
3. If validation fails, print the error and halt with a non-zero exit code (do not silently ignore schema violations).

## Public-repo scrubbing rules

Before committing any generated MDX, apply these scrub rules. If found, the section is flagged for human review:

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

## Example execution

### Running `/docs-sync --section getting-started`

1. Parse `--section getting-started` flag.
2. Read `docs/quickstart.md`.
3. Derive human-friendly content from the quickstart: prerequisites, step-by-step setup, and the copy-paste session prompt.
4. Generate `site/src/content/docs/getting-started.mdx` with frontmatter (title: "Getting Started", section: "Getting Started", order: 1, prev: "Introduction", next: "Reference").
5. Validate the frontmatter and content.
6. Run `npm run build:check` from `site/` to confirm the MDX is valid.
7. Report: "✓ getting-started regenerated; site build passes."

### Running `/docs-sync --rebuild`

1. Iterate through all sections in the registry.
2. For each section, read the source docs, derive content, generate the MDX file with frontmatter and navigation chain.
3. Validate each section's frontmatter and content.
4. Run `npm run build:check` from `site/` to validate all sections together.
5. Report: "✓ All sections regenerated; site build passes." or if validation fails, halt with details.

## Error handling

- **Missing source file**: Flag the section for human review; do not attempt to regenerate it.
- **Build validation failure**: Print the Astro error; do not write the MDX file.
- **Ambiguous content**: If a section's source material is unclear or contradictory, flag for human review with details of the conflict.

## Notes

- **Human-first**: Never invent content. If the source doesn't cover a topic, flag it for human review rather than hallucinating.
- **Iterative**: Run `/docs-sync --section <name>` for single sections during authoring; use `/docs-sync --rebuild` when all source docs are ready.
- **Mirrors plugin conventions**: This command follows the same instruction-file style as `.claude/skills/*/SKILL.md`, but without YAML frontmatter (commands are flat markdown).
