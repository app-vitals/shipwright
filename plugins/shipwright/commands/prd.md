---
description: Interactive PRD session — asks qualifying questions, researches context, and produces a PRODUCT-SPEC.md ready for /plan-session
arguments:
  - name: folder-name
    description: Name of the planning session folder under planning/ (e.g., april-2026-workspace-switcher)
    required: true
---

# PRD: $ARGUMENTS

Run an interactive requirements session for `planning/$ARGUMENTS/`. Ask qualifying questions one at a time to fully understand what you're building, then produce a structured `PRODUCT-SPEC.md` that `/plan-session` can consume directly.

Follow all phases in order. Proceed automatically between phases. The only pauses are to receive user answers to questions.

## Phase 0: Project Context Setup

1. **Create the planning folder** if it doesn't exist: `planning/$ARGUMENTS/`

2. **Detect toolchain** by scanning the project root in this order:
   - `package.json` + lockfile → Node.js (identify package manager from lockfile)
   - `Cargo.toml` → Rust
   - `go.mod` → Go
   - `pom.xml` → Java/Maven (use `./mvnw` wrapper if present, else `mvn`)
   - `build.gradle` / `build.gradle.kts` → Java/Gradle (use `./gradlew` wrapper if present, else `gradle`)
   - `pyproject.toml` / `requirements.txt` → Python
   - `Gemfile` → Ruby
   - `Makefile` → Generic Make

2b. **Detect repo name** from git metadata (used in the handoff to `/plan-session` and written to every `state/todos.json` task):
   - `git remote get-url origin` → parse the `owner/repo` segment, strip any trailing `.git`. Use the bare `{repo}` portion.
   - Fallback if no remote: `basename $(git rev-parse --show-toplevel)`
   - Last resort if not in a git repo: `basename $(pwd)` and print a warning.

   Print `Detected repo: {repo}` in the Phase 0 summary so the user can catch a misdetection before investing time in the session.

3. **Read project documentation** (lightweight scan — highlights only, no deep code dive):
   - `CLAUDE.md` — conventions, architecture decisions, and constraints
   - `README.md` — project overview and current capabilities
   - `docs/` directory (if it exists) — scan for markdown files and read the ones most likely to describe existing features, modules, or architecture (e.g., `docs/architecture.md`, `docs/api.md`, `docs/features/`). Skip changelogs, license files, and contributor guides.

   **Goal**: Build a high-level picture of what the project currently does, what modules exist, and what patterns are established. Use this to:
   - Skip questions whose answers are already obvious from the docs
   - Ask informed questions ("your README mentions a notification system — is this extending that or something new?")
   - Surface relevant existing capabilities before the user describes requirements
   - Populate Technical Constraints with known conventions (e.g., "uses repository pattern for data access")

4. **Research existing context**: Spawn the `agents/researcher.md` agent with the task: "Based on the project documentation, summarize: (1) the project's current feature set and key modules, (2) architectural patterns a new feature should follow, (3) any existing utilities or abstractions available for reuse." Use the output to further enrich your understanding before asking questions — don't surface what the docs already made clear.

Store detected toolchain, detected repo name, doc findings, and research output for use in Phase 1 (to inform questions), Phase 2 (to enrich technical considerations), and Phase 5 (the `/plan-session` handoff).

## Phase 1: Interactive Discovery

Ask these questions **one at a time**. Wait for a complete answer before asking the next question. Do not ask multiple questions in the same message.

After each answer, probe if it's vague. Examples:
- "Can you give me a specific example of that?"
- "What would that look like from the user's perspective?"
- "What would you check to confirm that's working?"

**Question sequence:**

### Q1 — Session Name (skip if $ARGUMENTS is already descriptive)
```
What are we building? Give this a short name for the planning folder.
(e.g., "workspace-switcher", "payment-integration", "auth-refactor")
```

### Q2 — Problem Statement
```
What problem are we solving? (1-3 sentences — be specific)
What's broken, missing, or painful today?
```

### Q3 — Users
```
Who will use this? Describe the primary user(s) and what they're trying to accomplish.
```

### Q4 — Core Features (breadth first)
```
What are the key capabilities this needs to have?
List them briefly — we'll go deeper on each one.
```

### Q4a — Feature Depth (repeat for each feature from Q4)
For each feature mentioned, ask these follow-up questions in sequence:

```
Walk me through how [{feature}] works from the user's perspective.
What does the experience look like start to finish?
```

```
What does "done" look like for [{feature}]?
What would you check or test to confirm it's working?
```

```
Any specific technical requirements or constraints for [{feature}]?
(APIs to call, performance requirements, existing code to integrate with)
```

If a feature turns out to contain multiple sub-features, split them and treat each as a separate feature with its own depth probes.

### Q5 — Technical Constraints
```
Are there any technical constraints I should know about?
(frameworks, APIs, performance requirements, integration points, things that must not change)
```

### Q6 — Out of Scope
```
What is explicitly NOT part of this work?
What should we avoid touching or implementing, even if it seems related?
```

### Q7 — Priorities and Sequence
```
Are any features higher priority than others?
Is there a delivery sequence that matters — things that must be built before others can start?
```

### Q8 — Open Questions
```
Any unknowns or open questions we should flag for the planning session?
Things you're unsure about, decisions that aren't made yet, or dependencies on other teams?
```

### Q9 — Success Criteria
```
How will you know this is done?
What does a successful outcome look like — from both the user's perspective and technically?
```

## Phase 2: Research Enrichment

After completing all discovery questions, spawn the `agents/researcher.md` agent with:
- The feature list gathered in Phase 1
- Task: "For each of these features, identify: (1) existing code patterns or utilities in this codebase that should be reused, (2) any relevant external APIs or libraries, (3) architectural constraints or risks the planning session should account for, (4) complexity risks — things that look simple in the spec but may be disproportionately complex in the code, require refactoring tightly coupled areas, or introduce unjustified complexity. For each complexity risk, describe the technical concern and its likely business impact (scope creep, timeline, fragility)."

Store the research output — it feeds both Phase 2b and Phase 3.

## Phase 2b: Complexity Review (PO Decision Gate)

If the researcher identified any complexity risks, present them to the user **in plain language** before drafting the spec. Translate every technical concern into terms a non-technical product owner can act on.

Format each flag as:
```
⚠ {Feature name}
What this means: {Plain-English description of why it's harder than it looks}
Business impact: {What this costs — e.g., "doubles the scope", "higher risk of bugs elsewhere", "needs foundational work before the feature itself"}
Options:
  → Keep as-is (worth the cost)
  → Simplify: {concrete suggestion for a smaller version}
  → Flag for engineering review
```

Example translations:
- "touches shared auth middleware" → "Changing this affects login across the whole app — more things could break, more testing needed"
- "missing abstraction needed first" → "Before we can build this, we'd need to build some underlying plumbing first — that's extra scope you may not have accounted for"
- "no test coverage in billing" → "The billing area has no safety nets right now — changes here carry more risk until we add them"

For each flag, ask the user: **"How do you want to handle this?"** Wait for their answer before moving on. Record their decision — it will be reflected in the spec.

If no complexity risks were found, skip Phase 2b entirely and proceed to Phase 3.

## Phase 3: Draft PRODUCT-SPEC.md

Generate the `PRODUCT-SPEC.md` using the template from `references/product-spec-template.md`.

Fill in each section from your gathered information:
- Map Q2 → Problem Statement
- Map Q3 → Users & Context
- Map Q4 + depth probes → Features (one section per feature)
- Map Q5 → Technical Constraints
- Map Q6 → Out of Scope
- Map Q7 → Priorities & Sequence
- Map Q8 → Open Questions
- Map Q9 → Success Criteria
- Map Phase 2 output → Technical Considerations per feature
- Map Phase 2b decisions → adjust feature scope if simplified, or add to Open Questions if flagged for engineering

**Acceptance criteria format:** Every feature must have at least one acceptance criterion written as a testable checkbox:
- `- [ ] {Specific, observable, testable outcome}` 
- Good: `- [ ] User can switch workspaces without losing unsaved work`
- Bad: `- [ ] Feature works correctly`

**Open questions vs. requirements:** If something is uncertain, put it in Open Questions rather than assuming. Plan-session will flag these during requirements extraction.

Present the complete draft to the user section by section. After presenting each section, ask: "Does this look right, or would you like to adjust anything here?"

## Phase 4: User Review and Finalize

1. Show the complete assembled `PRODUCT-SPEC.md`
2. Ask:
   ```
   Here's the complete Product Specification. Does this capture what you're building?
   Would you like to adjust anything before I save it?
   ```
3. Iterate on feedback until the user approves
4. Write the approved spec to `planning/$ARGUMENTS/PRODUCT-SPEC.md`

## Phase 5: Summary and Next Steps

Print:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
PRD COMPLETE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

PRD: planning/$ARGUMENTS/PRODUCT-SPEC.md

Features: {N}
{  Feature name} — {N} requirements, {N} acceptance criteria
  ...

Complexity Flags: {N reviewed — N simplified, N accepted, N flagged for eng}
Open Questions: {N flagged for plan-session}

NEXT: /plan-session {repo} $ARGUMENTS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

⚠ Do NOT skip /plan-session. It is the ONLY command that writes tasks to
`state/todos.json`, which is the queue `/dev-task` reads from. Bypassing it
leaves the queue empty or stale and breaks the pipeline.

If the work feels trivial, `/plan-session` will produce a single small task —
that is the correct fast path. "Small" is NOT a reason to skip planning.
```

Substitute `{repo}` with the value detected in Phase 0 step 2b. The handoff line must contain two arguments.

---

## Important Notes

- **One question at a time** — never ask multiple questions in the same message
- **Probe vague answers** — ask for examples and specific outcomes before moving on
- **Don't invent requirements** — if you're uncertain, put it in Open Questions
- **Feature depth matters** — a feature with unclear acceptance criteria will produce poor tasks in plan-session; invest time here
- **Research before drafting** — Phase 2 surfaces codebase constraints that change what's feasible
- **The PRD is the contract** — plan-session will use it as-is to generate a full task breakdown; what's missing here will be missing in the plan
