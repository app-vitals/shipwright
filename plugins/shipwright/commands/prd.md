---
description: Interactive PRD session — asks qualifying questions, researches context, and produces the session's next numbered spec (SPEC-NNNN.md; a legacy PRODUCT-SPEC.md is spec 1) ready for /plan-session
arguments:
  - name: session
    description: Name of the planning session folder under planning/ (e.g., april-2026-workspace-switcher)
    required: true
  - name: --repos
    description: "Optional `--repos a,b` — comma-separated org/repo list this spec covers (the home repo is always included)"
    required: false
  - name: --owner
    description: "Optional `--owner email` — the requester recorded as the spec's owner in the task store (never written to a file)"
    required: false
  - name: --initiative
    description: "Optional `--initiative {task-id}` — id of an `initiative` or `idea` task to close out (and link via specDocumentId) once the spec is finalized"
    required: false
---

# PRD: $ARGUMENTS

Run an interactive requirements session for `planning/$ARGUMENTS/`. Ask qualifying questions one at a time to fully understand what you're building, then produce a structured numbered spec (`SPEC-{NNNN}.md`, or the legacy `PRODUCT-SPEC.md` as spec 1) that `/plan-session` can consume directly.

**Form:** `/shipwright:prd {session} [--repos a,b] [--owner email] [--initiative id]`

**Argument parsing:** `$ARGUMENTS` is the session token, optionally followed by `--repos a,b`, `--owner email` and `--initiative {task-id}`. The first token is the session (`{session}`); every `$ARGUMENTS` reference below that names the folder (e.g. `planning/$ARGUMENTS/`) means that token only, never a flag. **`--repos a,b`** (optional) lists the `org/repo` values the spec covers; the home repo is always included. **`--owner email`** (optional) overrides the owner (see step 2c). **`--initiative {task-id}`** (optional) is the id of an `initiative` or `idea` task in the task store that this PRD fulfils; it feeds the owner default in step 2c and the Phase 5 initiative close-out step.

Throughout this command, `{SPEC_FILE}` is the spec file chosen in step 2c (`SPEC-{NNNN}.md` or the legacy `PRODUCT-SPEC.md`) and `{SPEC_PATH}` is `planning/$ARGUMENTS/{SPEC_FILE}`.

Follow all phases in order. Proceed automatically between phases. The only pauses are to receive user answers to questions.

## Chat Message Rules (CSM-2.2)

This session often runs in a chat surface (Slack, a phone). Every message you send that needs a reply follows these rules; the spec file and the docs PR keep full detail, so nothing is lost by being brief in chat:

- **Ask last.** The ask is the final line of the message, never buried mid-message. Where the answer is a choice, number the options: `Look right? 1 yes / 2 adjust`.
- **Max 3 bullets.** A headline plus at most 3 bullets (at most 5 in a section-review summary) plus links. Point to the spec file or PR for the rest instead of pasting it.
- **Fits one phone screen** — about 8-10 lines. Cut before you wrap.
- **One question per message** (see Phase 1) — still true.

## Phase 0: Project Context Setup

1. **Create the planning folder** if it doesn't exist: `planning/$ARGUMENTS/`

### Resolve the configured prd subagent (PRM-1.2)

Runs once here, immediately after the planning folder is created and before toolchain
detection below. Fetches the agent's configured phase-methodology override for the prd phase
(PMC-1.1) off the same `GET /agents/{id}/config` endpoint `review.md`'s Step 4, `patch.md`'s
Step 1, and `plan-session.md`'s Step 1 already use — same endpoint, same auth header, just a
different field. Best-effort and fail-soft: any failure here is never a hard stop.

```bash
PRD_SUBAGENT_TYPE=$(curl -sf -H "Authorization: Bearer $SHIPWRIGHT_AGENT_API_KEY" \
  "$SHIPWRIGHT_API_URL/agents/$SHIPWRIGHT_AGENT_ID/config" | jq -r '.phaseMethodology.prd // empty')
```

**Fail-soft to the built-in path, not fail-open to an unvalidated dispatch.** When
`.phaseMethodology.prd` is absent or `null` (the jq `// empty` default), or the curl fails
outright, `PRD_SUBAGENT_TYPE` is empty and **step 2 below through Phase 4 run unchanged,
exactly as they do today** — same toolchain detection, same discovery questions, same
research, same drafting. An empty value never means "dispatch something else"; it means "run
the built-in interactive session."

**There is no built-in `subagent_type` fallback name here.** Unlike `review.md`, whose
built-in default (`shipwright:code-reviewer`) is itself a dispatchable subagent, prd's
built-in process (toolchain detection, discovery questions, research, drafting) is
not itself a dispatchable subagent — it's the main thread's own inline conversation with the
human. So the empty value is the built-in path, not a name to dispatch.

**When `PRD_SUBAGENT_TYPE` is non-empty**, still run step 2b below (repo detection) and step 2c (session
documents, spec number, repos and owner — the dispatch needs `{SPEC_PATH}` regardless of which
path produces the spec), then skip the
rest of step 2, step 3, step 4, and Phases 1 through 4 entirely, and jump straight to the
**Configured Methodology Dispatch (PRM-1.2)** section that follows Phase 4. Continue to Phase
5 from there once that section completes.

2. **Detect toolchain** by scanning the project root in this order:
   - `package.json` + lockfile → Node.js (identify package manager from lockfile)
   - `Cargo.toml` → Rust
   - `go.mod` → Go
   - `pom.xml` → Java/Maven (use `./mvnw` wrapper if present, else `mvn`)
   - `build.gradle` / `build.gradle.kts` → Java/Gradle (use `./gradlew` wrapper if present, else `gradle`)
   - `pyproject.toml` / `requirements.txt` → Python
   - `Gemfile` → Ruby
   - `Makefile` → Generic Make

2b. **Detect repo name** from git metadata (the full `org/repo` value is what gets handed off to `/plan-session` and written to every task in the task store):
   - `git remote get-url origin` → parse the `owner/repo` segment, strip any trailing `.git`. Use the full `owner/repo` value as `{repo}` — do not strip to the bare repo name.
   - Fallback if no remote: `basename $(git rev-parse --show-toplevel)`
   - Last resort if not in a git repo: `basename $(pwd)` and print a warning.

   Include `Detected repo: {repo}` (full `owner/repo` value) in the Phase 0 summary so the user can catch a misdetection before investing time in the session.

2c. **Resolve session documents, spec number, repos and owner (PLU-3.2).** Runs on both paths.

   **Document endpoints.** Probe the store once: `GET $SHIPWRIGHT_TASK_STORE_URL/documents?session=$ARGUMENTS` (header `Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN`). A 404/405 or an unreachable store means the store lacks the document endpoints: print one warning (`⚠ Task store has no document endpoints — continuing without document registration.`), set `DOCS_API=off`, and continue with today's behaviour — the numbering rule below works from files alone, and every registration, `prUrl` and `specDocumentId` step is skipped. Warn once, never per step.

   **What the session already has.** The document rows decide which specs exist; file *content* is read from git. Read order for existing content (spec files, `PLAN.md`, any prior spec you reference): (1) the open docs branch — `origin/docs/plan-$ARGUMENTS` (or the suffixed `docs/plan-$ARGUMENTS-{n}` branch that has an open PR), (2) the default branch (`origin/HEAD`), (3) the local checkout, because `planning/` is commonly gitignored and a pass may run on another machine. First match wins.

   **Lazy registration.** If the session has zero document rows but planning files exist for it in git (any read-order source), register them first, before numbering, using the shared PLU-3.1 module `${CLAUDE_PLUGIN_ROOT}/scripts/register-planning-documents.ts` (`registerPlanningSessions` with `sessions: [$ARGUMENTS]`, `repo: {repo}`, a store client backed by the `/documents` and `/tasks` endpoints, and `chainContentSources` in the read order above). Registration is additive bookkeeping: it never throws, and entries in `result.errors` are printed as warnings and never block the session.

   **Home repo.** The home repo is the repo this command runs in (`{repo}` from step 2b). If the session already has document rows whose `repo` differs from `{repo}`, **stop** and print `Session $ARGUMENTS already lives in {home repo} — its documents are at planning/$ARGUMENTS/ in that repo. Run /shipwright:prd $ARGUMENTS there.` Write nothing.

   **Next spec number.** Take the highest spec number across the document rows and the spec files found in git/local (`PRODUCT-SPEC.md` counts as spec 1 — the legacy file is spec 1 and keeps its name; `SPEC-{NNNN}.md` counts as `NNNN`). The new spec is that number plus one, zero-padded to four digits: `SPEC-{NNNN}.md`. A session with no specs gets spec 1; a session whose only spec is a legacy `PRODUCT-SPEC.md` gets `SPEC-0002.md` — never rename or overwrite the legacy file. `{SPEC_FILE}` is the new file name.

   **Interim spec-1 filename (until PLU-4.2).** `plan-session` today reads only `planning/{session}/PRODUCT-SPEC.md`, so spec 1 of a session that has no specs yet is written as `PRODUCT-SPEC.md` (header `spec=0001`, registered as number 1) rather than `SPEC-0001.md`. Specs 2 and up use `SPEC-{NNNN}.md`. Once `plan-session` reads numbered specs (PLU-4.2), spec 1 becomes `SPEC-0001.md` too.

   **Repos.** `{repos}` = the `--repos` list (trimmed, de-duplicated) plus `{repo}` if absent, home repo first.

   **Owner.** Precedence: `--owner` if given; else, when `--initiative {task-id}` was passed and `GET /tasks/{task-id}` returns an `owner`, that owner; else `git config user.email` (if unset, no owner is recorded). The owner is held only for the task-store registration call. **Never write the owner (or any email) into the spec file, its header line, the PR title or the PR body.**

   **Phase 0 summary (chat).** Condense to a headline plus at most 3 bullets, ask last, per the Chat Message Rules: bullet 1 `Detected repo: {repo}` and `Spec: {SPEC_PATH}`, bullet 2 `Repos: {repos}` and `Owner: {owner}`, bullet 3 (optional) one line on what the docs/research already made clear. Then end with the ask, e.g. `Look right? 1 yes / 2 correct something`, so the user can fix any of them before investing time in the session. Do not paste doc excerpts or research output.

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

Store detected toolchain, detected repo name, `{SPEC_PATH}`, `{repos}`, `{owner}`, doc findings, and research output for use in Phase 1 (to inform questions), Phase 2 (to enrich technical considerations), and Phase 4 (writing, registering and opening the docs PR).

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

### Q8 — Open Questions → Drive to Decisions
```
Are there any decisions we haven't made yet, or things you're unsure about?
```

For each item the user raises, do NOT simply record it as an open question. Instead, drive it to a decision:

1. **If the user has a preference**: record it as a Resolved Decision with their rationale.
2. **If the user is genuinely unsure**: propose a sensible default based on codebase patterns from Phase 0/2 research, and ask: "Shall I go with {default} as the default? You can revisit this before plan-session." Record the accepted default as a Resolved Decision, noting it was chosen as a default and can be changed.
3. **If resolution requires external sign-off** (e.g., security team, legal, another team's API): record the dependency as a Resolved Decision with a note that the blocker must be resolved before plan-session can begin — and flag it explicitly so the user knows the session is blocked on this.

The goal: every uncertainty that enters Q8 exits Q8 as a decision or a named blocker with an owner. **Do not write "TBD" or "defer to plan-session" — those are not decisions.** Plan-session cannot generate tasks from unresolved questions; the PRD session is the place to resolve them.

### Q9 — Success Criteria
```
How will you know this is done?
What does a successful outcome look like — from both the user's perspective and technically?
```

## Phase 2: Research Enrichment

After completing all discovery questions, spawn the `agents/researcher.md` agent with:
- The feature list gathered in Phase 1
- Task: "For each of these features, identify: (1) existing code patterns or utilities in this codebase that should be reused, (2) any relevant external APIs or libraries, (3) architectural constraints or risks the planning session should account for, (4) complexity risks — things that look simple in the spec but may be disproportionately complex in the code, require refactoring tightly coupled areas, or introduce unjustified complexity. For each complexity risk, describe the technical concern and its likely business impact (scope creep, timeline, fragility). (5) the specific existing files this feature will touch or modify (for the Source Map field — list file paths, not just directories). (6) which test layer owns coverage for this feature (unit / integration / smoke / e2e) and a one-sentence justification based on whether the feature has I/O, calls external services, tests HTTP route contracts, or requires browser-driven flows."

Store the research output — it feeds both Phase 2b and Phase 3.

For each feature, extract from the researcher output:
- **Source Map**: the list of existing files the feature touches (used to populate the per-feature Source Map field in the spec)
- **Test layer**: the recommended layer and rationale (used to populate the per-feature Testing Strategy field and the top-level Testing Strategy table)

## Phase 2b: Complexity Review (PO Decision Gate)

If the researcher identified any complexity risks, present them to the user **in plain language** before drafting the spec. Translate every technical concern into terms a non-technical product owner can act on.

Present one flag per message, as a headline plus at most 3 bullets, ask last (Chat Message Rules):
```
⚠ {Feature name} — {one-line plain-English reason it's harder than it looks}
• Impact: {what this costs, e.g. "doubles the scope"}
• Simpler version: {concrete suggestion for a smaller version}
How to handle? 1 keep as-is / 2 simplify / 3 flag for engineering
```

Example translations:
- "touches shared auth middleware" → "Changing this affects login across the whole app — more things could break, more testing needed"
- "missing abstraction needed first" → "Before we can build this, we'd need to build some underlying plumbing first — that's extra scope you may not have accounted for"
- "no test coverage in billing" → "The billing area has no safety nets right now — changes here carry more risk until we add them"

Each flag message ends with the ask ("How to handle?"). Wait for their answer before moving on. Record their decision — it will be reflected in the spec as a Resolved Decision, not as a deferred question.

If no complexity risks were found, skip Phase 2b entirely and proceed to Phase 3.

## Phase 3: Draft the spec

Generate the spec using the template from `references/product-spec-template.md`. A new file starts with the template's header line (`<!-- shipwright: session={session} repos={repos} spec={NNNN} -->`) — session, repos and spec number only, never the owner. Fill the required `**Repos**` line from `{repos}`, and give every Source Map entry the repo its file lives in.

Fill in each section from your gathered information:
- Map Q2 → Problem Statement
- Map Q3 → Users & Context
- Map Q4 + depth probes → Features (one section per feature)
- Map Q5 → Technical Constraints
- Map Q6 → Out of Scope
- Map Q7 → Priorities & Sequence
- Map Q8 decisions (driven to resolution) → Resolved Decisions
- Map Q9 → Success Criteria
- Map Phase 2 output → Technical Considerations per feature
- Map Phase 2 file enumeration → Source Map per feature (list of existing files the feature touches, each tagged with its `org/repo`)
- Map Phase 2 test-layer probe → Testing Strategy per feature + top-level Testing Strategy table
- Map Phase 2b decisions → adjust feature scope if simplified, or add to Resolved Decisions if flagged for engineering (with the decision recorded as "flagged for engineering review before implementation")

**Acceptance criteria format:** Every feature must have at least one acceptance criterion written as a testable checkbox:
- `- [ ] {Specific, observable, testable outcome}` 
- Good: `- [ ] User can switch workspaces without losing unsaved work`
- Bad: `- [ ] Feature works correctly`

At least one criterion per feature must map to automated verification (a test, type check, or lint) — a criterion only a human can confirm does not count toward this.

**Resolved Decisions vs. requirements:** If something was uncertain, it must have been driven to a decision in Q8 and recorded in Resolved Decisions. Do not write "TBD" or leave decisions deferred — plan-session cannot generate tasks from unresolved questions. The only acceptable entry in Resolved Decisions that is not yet resolved is a named external blocker with an explicit owner.

Write the full draft to the spec file in your working copy; it keeps all the detail. In chat, do **not** paste section text. Walk the draft one section at a time, presenting for each section a bullet summary (3-5 bullets, each a short phrase, not the section's prose) with the ask **last**:

```
Goals: {X}, {Y}, {Z}.
Look right? 1 yes / 2 adjust
```

Wait for the answer before the next section. `2 adjust` means ask what to change, apply it to the draft, and re-summarize that section. The complete section text is still written to the spec file.

## Phase 4: User Review and Finalize

1. Do not paste the assembled spec into chat. Give a headline plus at most 3 bullets (feature count, the biggest decision, any external blocker) and the spec file path.
2. Ask last:
   ```
   Full spec is at {SPEC_PATH}. Save it as-is? 1 yes / 2 adjust
   ```
3. Iterate on feedback until the user approves
4. Write the approved spec to `{SPEC_PATH}` (new files start with the header line from Phase 3; the file never contains the owner).
4a. **Register the document** (skip when `DOCS_API=off`): `POST $SHIPWRIGHT_TASK_STORE_URL/documents` with `{"session": "$ARGUMENTS", "kind": "spec", "number": {N}, "repo": "{repo}", "path": "{SPEC_PATH}", "title": "{first H1}", "owner": "{owner}", "repos": [{repos}]}` (omit `owner` when empty). Registration is idempotent on `(session, kind, number)`. Keep the returned `id` as `SPEC_DOC_ID`. A failure prints a warning and continues.
4b. **Open the docs PR** with the shell block below — the same throwaway-worktree pattern as `plan-session.md` Step 6d. It reuses the open `docs/plan-{session}` PR when one exists (adding the spec to that branch); when that PR has already merged (or closed) it opens `docs/plan-{session}-{n}` with the next free `n`, starting at 2. `planning/` is commonly gitignored, so it stages with `git add -f` on the specific file only — never `-A`, and never edit the repo's `.gitignore`. The mechanical secret-pattern scrub gate still runs before any commit; on a match the PR is not opened.

```bash
# prd-docs-pr
SESSION="{session}"
SPEC_FILE="{SPEC_FILE}"
SPEC_PR_URL=""
BRANCH="docs/plan-$SESSION"
REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null)
if [ -z "$REPO_ROOT" ] || ! command -v gh >/dev/null; then
  echo "⏭ Spec PR skipped — not a git checkout or gh unavailable."
else
  git -C "$REPO_ROOT" fetch -q origin
  DEFAULT=$(git -C "$REPO_ROOT" symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null || echo origin/main)
  # Reuse an OPEN docs PR; if the previous PR merged (or closed), move on to
  # docs/plan-$SESSION-2, -3, ... until one is open or unused.
  REUSE=""
  N=1
  while [ "$N" -lt 50 ]; do
    INFO=$(gh pr list --head "$BRANCH" --state all --json url,state -q '.[0] | select(.) | "\(.state) \(.url)"')
    [ -z "$INFO" ] && break
    if [ "${INFO%% *}" = "OPEN" ]; then REUSE=1; SPEC_PR_URL="${INFO#* }"; break; fi
    N=$((N + 1))
    BRANCH="docs/plan-$SESSION-$N"
  done
  WT=$(mktemp -d)/spec-wt
  if [ -n "$REUSE" ]; then
    git -C "$REPO_ROOT" worktree add -q -B "$BRANCH" "$WT" "origin/$BRANCH"
  else
    # -B: a prior run may have pushed this branch and failed before `gh pr create`.
    git -C "$REPO_ROOT" worktree add -q -B "$BRANCH" "$WT" "$DEFAULT"
  fi
  mkdir -p "$WT/planning/$SESSION"
  cp "$REPO_ROOT/planning/$SESSION/$SPEC_FILE" "$WT/planning/$SESSION/$SPEC_FILE"
  # -f: planning/ is commonly gitignored. Stage only this file — never -A.
  git -C "$WT" add -f "planning/$SESSION/$SPEC_FILE"
  # Mechanical scrub gate — private key headers and well-known cloud/vendor token prefixes.
  SECRET_PATTERN='-----BEGIN [A-Z ]*PRIVATE KEY-----|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{36,}|xox[baprs]-[A-Za-z0-9-]+|AIza[0-9A-Za-z_-]{35}'
  if git -C "$WT" diff --cached --quiet; then
    echo "⏭ Spec PR skipped — $SPEC_FILE already on $BRANCH."
  elif git -C "$WT" diff --cached | grep -qE -- "$SECRET_PATTERN"; then
    echo "⚠ Spec PR not opened — staged spec content matched a secret-pattern scan; scrub planning/$SESSION and retry."
    SPEC_PR_URL=""
  else
    git -C "$WT" commit -q -m "docs(planning): add $SESSION ${SPEC_FILE%.md}" \
      && git -C "$WT" push -q -u origin "$BRANCH" \
      && if [ -z "$REUSE" ]; then
           (cd "$WT" && gh label create shipwright --description "Opened autonomously by Shipwright" --color 1D76DB --force) \
           && SPEC_PR_URL=$(cd "$WT" && gh pr create --head "$BRANCH" --base "${DEFAULT#origin/}" \
                --title "docs(planning): add $SESSION ${SPEC_FILE%.md}" \
                --body "Spec \`$SPEC_FILE\` for session \`$SESSION\`." \
                --label shipwright)
         fi
  fi
  git -C "$REPO_ROOT" worktree remove --force "$WT"
fi
echo "SPEC_PR_BRANCH=$BRANCH"
echo "SPEC_PR_URL=$SPEC_PR_URL"
```

   If any check or command fails, print `⚠ Spec PR not opened — {reason}` and continue: the spec is already on disk and the command never fails on this step. If the repo has its own stricter hygiene (banned-string scan, CLAUDE.md rules), apply that too before running the block.
4c. **Record the PR** (skip when `DOCS_API=off` or `SPEC_PR_URL` is empty): `PATCH $SHIPWRIGHT_TASK_STORE_URL/documents/{SPEC_DOC_ID}` with `{"prUrl": "{SPEC_PR_URL}", "state": "pr_open"}`. A failure prints a warning and continues. Surface `Spec PR: {url}` in the Phase 5 summary.
5. **Link to the plan visualization (additive — never blocks the spec).** The
   spec write above is complete and unchanged; this step only
   surfaces a shareable link to the session view for what was just written.
   Skip cleanly when the admin app base URL is not configured.

   ```bash
   if [ -z "$SHIPWRIGHT_ADMIN_APP_BASE_URL" ]; then
     echo "⏭ Plan viz skipped — SHIPWRIGHT_ADMIN_APP_BASE_URL unset."
   else
     PLAN_VIZ_URL="${SHIPWRIGHT_ADMIN_APP_BASE_URL%/}/admin/sessions/$ARGUMENTS"
   fi
   ```

   When `SHIPWRIGHT_ADMIN_APP_BASE_URL` is set, surface the constructed URL in
   the Phase 5 summary as `Plan viz: {url}`. If the step printed a skip notice
   instead, omit that line and proceed — the spec is already written and the
   command must never block on visualization.

   When (and only when) a URL was produced, also emit `[plan:{url}]` on its own
   line — the agent strips this marker and posts a "View plan" link to the
   bound Slack channel/thread. Omit it if the step was skipped.

## Configured Methodology Dispatch (PRM-1.2)

**Skip this entire section when `PRD_SUBAGENT_TYPE` is empty** — the built-in step 2 onward
through Phase 4 already produced the spec; proceed straight to Phase 5. Everything
below runs only when Phase 0's resolution subsection resolved `PRD_SUBAGENT_TYPE` to a
non-empty value, in which case step 2 onward through Phase 4 were skipped and this section
produces the spec in their place.

### Inputs

Per `plugins/shipwright/references/methodology-contracts/prd.md` (PRM-1.1), prd has
no pre-assembled input payload the way review, patch, merge, and plan-session do — the only
inputs are:

- **Session folder name** — `$ARGUMENTS`.
- **`specPath`, `specNumber`, `repos`, `owner`** — resolved in step 2c: `{SPEC_PATH}`, its spec number, the repo list, and the owner (held for registration only — the subagent must never write it into the file).
- **Live human interaction** — the configured subagent conducts its own discovery questions,
  research, complexity review, and drafting directly with the human, one turn at a time,
  exactly as the built-in Phases 1 through 4 do. There is no pre-gathered answer set to hand
  it.

### Dispatch

Dispatch via the Agent tool with `subagent_type: PRD_SUBAGENT_TYPE` and
`run_in_background: false` — this command is always invoked directly by a human in an
interactive session (never by `loop-orchestrator.ts`; prd has no `check-prd.ts` candidate
provider, see `plugins/shipwright/CLAUDE.md`'s Design Constitution), so the foreground
dispatch lets the subagent run its own live, turn-by-turn Q&A directly with that same human
instead of returning a single batch response for this command to relay.

Pass a single prompt block that:

1. Points the subagent at `plugins/shipwright/references/methodology-contracts/prd.md` as the
   contract it must satisfy, and at
   `plugins/shipwright/references/product-spec-template.md` as the required output template.
2. Supplies the session folder name (`$ARGUMENTS`), the target output path
   (`{SPEC_PATH}`), the spec number and the repos, and tells it to start the file with the
   template's header line and fill the required `Repos` line — and never to write the owner.
3. States that it must conduct its own interactive discovery, research, and complexity-review
   process directly with the human (one question at a time, driving every uncertainty to a
   resolved decision or a named blocker — no "TBD" markers), present the assembled spec for
   approval, and write the finished spec to that exact path once the human approves it.

This command does not relay questions or answers on the subagent's behalf — the dispatch is a
single blocking call that returns only once the subagent has finished its own end-to-end
session and written (or failed to write) the file.

### Structural Validation

Once the dispatch returns, check the following before proceeding to Phase 5 — this is a
structural sanity check, not a re-grading of content quality (probing depth, decision
rationale, acceptance-criterion wording, etc. stay the configured subagent's responsibility
per the contract's Scope section):

1. `{SPEC_PATH}` exists and is non-empty.
2. It contains every required top-level section heading from the contract's Required Sections
   list: `Overview`, `Problem Statement`, `Users & Context`, `Features`,
   `Repos` (the required `**Repos**` line), `Technical Constraints`, `Scope`,
   `Priorities & Sequence`, `Testing Strategy`, `Resolved Decisions`, `Success Criteria`.
3. It contains no unresolved `TBD` marker (case-insensitive) — the contract's quality bar
   requires every uncertainty be driven to a decision or a named blocker before the file is
   written.
4. Every `### Feature` section contains at least one checkbox acceptance criterion (a line
   starting `- [ ]`) — the contract's quality bar requires one per feature. This counts
   checkboxes only; whether each criterion is well written stays out of scope here.

### Malformed or Failed Response (PRM-1.2)

If the Agent tool dispatch itself fails (errors, or `PRD_SUBAGENT_TYPE` names an
invalid/nonexistent `subagent_type` from a misconfigured override), or Structural Validation
above fails, retry once with the same `PRD_SUBAGENT_TYPE` and the same prompt.

If the retry also fails Structural Validation (or fails to dispatch at all), **fall back to
running the built-in flow inline**, starting from Phase 0 step 2 (toolchain detection) below,
through Phase 4 — the same steps that were skipped when `PRD_SUBAGENT_TYPE` first resolved
non-empty.

Unlike `plan-session.md`'s PSM-1.2, which abandons the session outright when its configured
methodology fails after retry (its built-in decomposition needs a live codebase-exploration
and design pass this command's main thread doesn't already know how to re-run inline), prd's
built-in path is exactly the same interactive Q&A this main thread already runs
unconditionally today — so falling back here costs the human a restarted conversation, not a
lost session with nowhere to go. Print a one-line note first:

```
⚠ Configured prd methodology {PRD_SUBAGENT_TYPE} failed after retry — falling back to the
built-in PRD flow.
```

Either way — configured subagent success, or fallback to the built-in flow — Phase 5 always
runs against a real, structurally valid spec on disk. Steps 4a-4c (register, docs PR, record
the PR) run after either path, once the file is validated.

## Phase 5: Summary and Next Steps

Phase 5 is path-agnostic (PRM-1.2): it runs identically whether Phase 0 step 2 through Phase
4 ran inline above, or that flow was replaced by the Configured Methodology Dispatch section
— either way, a structurally valid spec is already on disk by the time this
phase runs. On the built-in path the counts below (features, requirements, acceptance
criteria, resolved decisions, external blockers) come from the in-session Phase 1-4 tally;
on the dispatch path no such tally exists in this thread, so
derive every count directly from the written spec (its `### Feature N` headings,
`Requirements`/`Acceptance Criteria` bullets, and `Resolved Decisions` entries) instead.

**Two figures are the exceptions — neither is reconstructable from the artifact, so scope
both out on the dispatch path:**

1. **`Complexity Flags` — omit the line entirely.** Per Phase 3's mapping rule, a Phase 2b
   flag the user accepted as-is ("Keep as-is") is reflected nowhere in the spec file —
   only a "Simplify" (folded into the feature's own scope) or "Flag for engineering review"
   (written to Resolved Decisions) decision leaves any trace. `N reviewed` and `N accepted`
   therefore cannot be reconstructed from the artifact alone on the dispatch path, where no
   in-session tally exists. Omit the `Complexity Flags:` line entirely when printing from the
   dispatch path; keep it, using the live Phase 2b tally, on the built-in path.
2. **`Resolved Decisions` — drop the Q8/Phase-2b parenthetical, keep the total.** Per
   `references/product-spec-template.md`, a Resolved Decisions entry is written as
   `- **{topic}**: {decision} — Rationale: {why}` — no entry is tagged with which phase
   produced it, and on the dispatch path neither Q8 nor Phase 2b ran in this thread. The
   total is countable from the artifact's `Resolved Decisions` bullets; the
   `(N driven from Q8, N from Phase 2b)` split is not. Print just
   `Resolved Decisions: {N decisions recorded}` on the dispatch path; keep the parenthetical,
   using the live Q8/Phase 2b tally, on the built-in path.

The summary is condensed — a headline, at most 3 bullets, and links (Chat Message Rules). Per-feature requirement and criteria counts, and the full lists, live in the spec file and PR, not in chat. The block is a template: drop any line that does not apply, and fold the remaining counts into the 3 bullets.

Print:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
PRD COMPLETE — {N} features, spec at {SPEC_PATH}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
• Resolved Decisions: {N decisions recorded (N driven from Q8, N from Phase 2b)}   ← drop the parenthetical on the dispatch path
• Complexity Flags: {N reviewed — N simplified, N accepted, N flagged for eng}   ← omit this bullet on the dispatch path
• External Blockers: {N items require external resolution before plan-session}
Spec PR: {url}    ← omit if the docs PR was skipped or failed
Plan viz: {url}   ← omit if the render step was skipped

NEXT: /plan-session {repo} $ARGUMENTS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

⚠ Do NOT skip /plan-session. It is the ONLY command that writes tasks to
the task store, which is the queue `/dev-task` reads from. Bypassing it
leaves the queue empty or stale and breaks the pipeline.

If the work feels trivial, `/plan-session` will produce a single small task —
that is the correct fast path. "Small" is NOT a reason to skip planning.
```

Substitute `{repo}` with the value detected in Phase 0 step 2b. The handoff line must contain two arguments, `{repo}` then the session: `plan-session` still requires `repo` as its first argument. It drops to `NEXT: /plan-session {session}` once `plan-session` takes the session alone (PLU-4.2).

When `{SPEC_FILE}` is a `SPEC-{NNNN}.md` file (spec 2 or later), print one more line under the handoff: `⚠ plan-session does not read SPEC-{NNNN}.md files yet (PLU-4.2) — it plans from PRODUCT-SPEC.md only.`

On the dispatch path, drop the `Complexity Flags:` line from the printed summary entirely and
print `Resolved Decisions:` with only its total (see the two exceptions above the template)
rather than printing a partial or guessed count.

**Initiative close-out** (only when `--initiative {task-id}` was passed):

Run this after the spec is finalized, alongside the summary. Phase 5 is path-agnostic, so this step runs identically after the built-in path and after the Configured Methodology Dispatch path.

1. `GET $SHIPWRIGHT_TASK_STORE_URL/tasks/{task-id}` (header `Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN`). On 404 or any other failure, print a warning and continue.
2. If `kind` is not `initiative` or `idea`, print a warning and continue. If `status` is already one of `done`, `merged`, `deployed`, `released`, `cancelled`, print a warning (already closed) and continue.
3. Otherwise PATCH it to done and — unless `DOCS_API=off` or no `SPEC_DOC_ID` exists — set `specDocumentId` to `SPEC_DOC_ID` in the same body (omit that key otherwise):

```bash
curl -sf -X PATCH -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
  -H "Content-Type: application/json" \
  "$SHIPWRIGHT_TASK_STORE_URL/tasks/{task-id}" \
  -d "{\"status\": \"done\", \"source\": \"{SPEC_PATH}\", \"specDocumentId\": \"{SPEC_DOC_ID}\"}" | jq .
```

A failed PATCH also prints a warning and continues. This step never fails the session — the spec is already on disk.

---

## Important Notes

- **One question at a time** — never ask multiple questions in the same message
- **Probe vague answers** — ask for examples and specific outcomes before moving on
- **Don't invent requirements** — if you're uncertain, raise it in Q8 and drive it to a decision or named blocker
- **Feature depth matters** — a feature with unclear acceptance criteria will produce poor tasks in plan-session; invest time here
- **Research before drafting** — Phase 2 surfaces codebase constraints that change what's feasible
- **The PRD is the contract** — plan-session will use it as-is to generate a full task breakdown; what's missing here will be missing in the plan
