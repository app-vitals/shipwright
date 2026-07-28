---
name: test-inventory
description: >
  Phase 1 of the test-readiness pipeline. Crawls a target repo, classifies every meaningful unit of code (business logic, service boundary, HTTP route, error path, external integration, user journey), prescribes the appropriate test layer (unit / integration / smoke / E2E) using the rubrics, ranks each by criticality (critical / high / medium), and tags canary eligibility. Outputs a deduplicated inventory — each functional unit appears exactly once at its canonical layer per the no-duplicate-coverage rule. Writes `docs/test-readiness/test-inventory.md`. Invoke when the `/test-inventory` command runs.
---

# test-inventory skill

## Purpose

Build the **inventory** — the source-of-truth ledger of what should be tested in this repo, at which layer, with what priority.

## When invoked

By the `/test-inventory` command. The repo path arrives as `$ARGUMENTS` (defaults to `.`).

## Process

### Step 0 — load the decisions registry

1. Check for `.claude/shipwright/test-readiness-decisions.md` in the target repo root.
2. **If it does not exist**, treat this as "no decisions configured" — the same graceful
   no-op `consolidation-scan` uses for a missing `.claude/shipwright/consolidation-decisions.md`
   (see `consolidation-scan/SKILL.md`'s Step 1). Print: "No test-readiness-decisions.md found —
   no decisions configured." and continue to Step 1 with an empty decisions list. This is
   expected on a repo that hasn't recorded any resolved ambiguous items yet — it is not an
   error.
3. **If it exists**, load it and parse its entries the same generic, defensive way
   `consolidation-scan`'s Step 1 parses `consolidation-decisions.md`: read each `###` entry for
   its **Item**, **Decision**, **Rationale**, and **Revisit** fields where present, but do not
   hardcode assumptions about the registry's exact heading/field layout beyond those four
   fields — skip any entry you can't confidently interpret rather than failing the whole load.
4. Build an in-memory decisions list: one entry per parsed record, holding at least its item
   description, decision, and revisit condition (if any).
5. Print the count of loaded entries, e.g. "Loaded 1 decision from test-readiness-decisions.md."

This decisions list is consulted during classification (Step 3) — a file whose ambiguous-item
fingerprint matches a registry entry recorded as "coverage satisfied indirectly" (or any
similarly-worded acceptance of non-canonical coverage) is classified at the layer the registry
entry actually resolved to, instead of falling through to the rubric's mechanical default,
unless the entry's revisit condition has been met (in which case treat it as if no matching
entry exists and classify normally).

### Step 1 — detect the stack

Read these signals to determine language and frameworks:
- `package.json`, `tsconfig.json`, `bun.lock`, `pnpm-lock.yaml` → JS/TS
- `pyproject.toml`, `requirements.txt`, `setup.py` → Python
- `go.mod` → Go
- `Gemfile` → Ruby
- `Cargo.toml` → Rust
- `pom.xml`, `build.gradle` → JVM

Record stack profile (language, package manager, primary framework if obvious — e.g., Hono, Express, FastAPI, Rails).

**CLAUDE.md layer-declaration convention:** also check the target repo's root `CLAUDE.md` for a section declaring its concrete layer structure (e.g. "handler → service → data", or whatever naming that repo uses — `architecture_layering` in `references/principles.md` is explicit that the layering principle concerns the *relationship* between layers, not literal names, and each repo's own `CLAUDE.md` should declare its concrete layer names). This mirrors the existing "## Testing" section pattern: `commands/review.md` extracts a repo's CLAUDE.md Testing section into `testReadinessContext` for `code-reviewer.md`'s test-readiness rule to consume, falling back to the universal baseline in `references/principles.md` when no such section exists. Apply the same fallback here — if the repo's CLAUDE.md declares a layer structure, use its concrete names when classifying and reporting; if it doesn't, fall back to the generic handler/service/data naming from `code-classifier.md`/`layer-criteria.md`. Like the Testing section, a CLAUDE.md layer-structure declaration is kept accurate as the repo evolves via the existing docs-refresher (`agents/docs-refresher.md`, invoked from `/shipwright:dev-task` Step 8.5) and `research-docs` mechanisms — no new tooling is required; it is simply another doc surface those mechanisms already watch.

**CLAUDE.md deploy-model declaration:** also check the target repo's root `CLAUDE.md` for a section declaring its deploy model with `## Deploy model` and one of three allowed values: `staged` (the repo has a deploy-staging environment and follows the canary-execution contract), `direct` (the repo deploys directly to production with no staging environment), or `none` (the repo has no automation deploy model yet, or canary eligibility is not applicable). If the repo's CLAUDE.md declares a deploy model, use that value when evaluating canary eligibility in Step 5; if it doesn't, treat it as NOT staged (default). Like the layer-structure declaration, this uses the same read-with-fallback mechanism — check the target repo's root CLAUDE.md first, and when the section is absent, fall back to a safe default (treat as not staged, i.e., `direct` or `none`).

### Step 2 — discover code surfaces

Use Glob + Grep to enumerate code areas. Source dirs vary; default to common conventions (`src/`, `app/`, `lib/`, `internal/`, language-specific). Exclude vendored deps, generated code, and existing test files.

For each meaningful file (or group of related files):
1. Read enough to understand purpose. **Do not read every file in full** — sample for classification signal. A function name + its first 20 lines is usually enough.
2. Apply the classifier rubric in `${CLAUDE_PLUGIN_ROOT}/assets/rubrics/code-classifier.md`.
3. Assign a category and a prescribed layer using `${CLAUDE_PLUGIN_ROOT}/assets/rubrics/layer-criteria.md`.

### Step 3 — deduplicate against the canonical-layer rule

A functional unit appears **exactly once** in the inventory at its canonical (lowest sufficient) layer. The hierarchy:

1. **Unit** — pure logic. Default canonical layer for any deterministic, side-effect-free function.
2. **Integration** — only when a boundary cannot be simulated by a unit test (real DB query, real file I/O, real internal RPC).
3. **Smoke** — only the HTTP/wire contract for a route. Never business logic re-assertion.
4. **E2E** — only multi-step state across services. Never a single boundary or single rule.

If a functional unit could be tested at multiple layers, list it once at the lowest-sufficient layer. Higher-layer test responsibilities are **delta-only** (what the lower layer cannot prove).

**Registry check before applying the mechanical default.** Before assigning a file the
hierarchy's mechanical default layer (e.g. "pure logic -> unit"), check the file against the
decisions list loaded in Step 0. If a registry entry's **Item** matches this file (same
judgment-based comparison used for any other fingerprint match in this pipeline — read both
descriptions and decide whether they describe the same file/ambiguous item) and its
**Decision** records that coverage is satisfied indirectly at a different layer (e.g. "accept
indirect e2e coverage" instead of adding a unit file), classify the file at that
registry-recorded layer instead of the rubric's mechanical default. Annotate the row's entry
in the generated inventory with `(per test-readiness-decisions.md - see '<entry>')`, where
`<entry>` is the matching entry's short `###` heading, so a reader can trace the classification
back to its source decision instead of it looking like a hand-edited row a future full
re-inventory could silently revert. If multiple registry entries could plausibly match the same
file, use the first/most specific match (the entry whose **Item** field most precisely names
this file, not a broad category it happens to fall under) and note in the annotation only the
one entry actually applied. If a matching entry's **Revisit** condition has been met, or the
entry points at a layer/convention that no longer applies to the current codebase (e.g. the
call sites it names have since diverged, or the test layer it names has been removed from the
repo's conventions), do not apply it — classify the file normally per the mechanical default
and note in the row why the registry entry was not applied (its revisit condition was met, or
its recorded layer no longer applies) rather than silently ignoring the stale entry.

### Step 4 — rank by criticality

Three tiers:
- **`critical`** — revenue path, data-loss risk, security boundary, top-5 user journey
- **`high`** — user-visible feature, internal API used by multiple services
- **`medium`** — internal-only utilities, low-traffic admin paths

The agent-readiness-checklist's "top 5–10 user flows" framing seeds the `critical` tier.

**Note:** criticality drives *prioritization* (write critical tests first in the roadmap) — not separate CI enforcement thresholds. Phase 2 prescribes a single coverage floor that applies to all tiers; the CI gate does not need to be tier-aware. Maintaining a criticality inventory just for CI enforcement creates mapping decay as the codebase evolves.

### Step 4b — living classification process

The inventory decays as soon as new code ships. Prescribe a lightweight process to keep it current:

- **New files at PR time:** the Closing Checklist in each published issue (see `repo-config/SKILL.md`) should include a step: "classify any new files added in this PR against the inventory rubric and update the criticality map." This is the hook point, not a separate bot.
- **Tier promotion signals:** a feature is promoted to a higher tier when one or more of these signals fires: feature flag removed, traffic ramp to ≥10% of users, milestone marked "general availability," explicitly flagged by an engineer. Include this trigger list in the `test-readiness-plan.md` open risks section so it's visible after publish.
- **Out-of-band re-inventory:** if major architectural change occurs (new service boundary, new top-level user journey), re-run `/test-inventory` from scratch. Minor changes (new helper, new admin route) are handled by the PR-time classification hook.

### Step 5 — tag canary eligibility

Canary-eligibility tagging only applies when `deploy_model == 'staged'` (read from Step 1). If the repo's CLAUDE.md declares `deploy_model` as `direct` or `none`, or if the declaration is entirely absent, skip all canary-eligibility tagging for every item in the inventory (no items get `canary-eligible: true`) and emit a visible note into the generated inventory doc's **Notes** section with one of these messages:
- If `deploy_model` is undeclared: "deploy_model undeclared — canary eligibility skipped; declare ## Deploy model in CLAUDE.md to enable."
- If declared as `direct`: "deploy_model: direct — canary eligibility not applicable (no staging environment)."
- If declared as `none`: "deploy_model: none — canary eligibility not applicable (no deploy automation)."

When `deploy_model == 'staged'`, proceed with the existing canary-eligibility rules: a test is canary-eligible iff **all** of:
- Layer ∈ {smoke, E2E}
- Criticality ∈ {critical, high}
- Read-only OR self-cleaning (per `canary-execution` skill)

### Step 6 — write the artifact

Load the template at `${CLAUDE_PLUGIN_ROOT}/assets/templates/test-inventory.md.tmpl` and fill it in. Write to `docs/test-readiness/test-inventory.md` in the target repo. Create the directory if missing.

## Sampling tips for large repos

- Cap reads at ~150 files. For repos larger than that, sample by directory and report the sampling strategy in the artifact.
- Prefer breadth over depth — better to classify 100 modules approximately than 10 modules precisely.
- Surface uncertainty explicitly: classifications you weren't sure about belong in an "Ambiguous" section so a human can correct them.

## Failure modes to avoid

- **Don't list "module X needs tests" without specifying layer.** Layer is the whole point of the inventory.
- **Don't duplicate functionality across layers.** If you'd test the same property at unit and integration, the unit layer wins. Note the integration layer's responsibility as the *delta only* (the boundary itself).
- **Don't promise canary eligibility for destructive tests.** Anything that creates state without explicit teardown is not canary-eligible.
- **Don't read test files for inventory.** This phase is about what the code *needs*, not what tests exist. Phase 3 reads the tests.
