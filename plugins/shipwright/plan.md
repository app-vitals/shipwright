# Shipwright — Implementation Plan

Enhancements to shipwright grounded in Anthropic + OpenAI harness engineering research (March 2026). See `app-vitals/strategy/harness-architecture.md` for the full research synthesis.

Implement when the need arises — don't build speculatively. Each item here has a clear source pattern and expected impact.

---

## Enhancements

### 1. Explicit Handoff Artifacts

**What:** At the end of each `/dev-task`, write a structured handoff artifact to the planning doc capturing: what was accomplished, key decisions made, open questions, and any gotchas for the next task. Currently, context resets happen implicitly (new invocation = new session); this makes the state transfer explicit and inspectable.

**Why:** Anthropic's research found that structured handoffs outperform summarization — they preserve fidelity across sessions and eliminate context anxiety. Right now if `/dev-loop` is interrupted mid-run, the next task starts cold. Explicit handoffs make the pipeline resumable and auditable.

**Where:** Add to `/dev-task` step 11 (currently "Update planning doc status") — extend to write a `## Handoff` section per task with structured state. `/dev-loop` reads this before launching each subagent.

**Scope:** Small. Planning doc schema change + update to dev-task.md and dev-loop.md.

---

### 2. Quality Scoring

**What:** A `/quality-score` command (or phase in `/plan-session`) that grades the codebase across key dimensions: test coverage, documentation quality, type safety, dependency direction, dead code, and known debt. Produces a scored report that agents can reason against when planning work.

**Why:** OpenAI's team maintains a quality document that grades each product domain and architectural layer — agents use it to know where the codebase is strong and where it needs investment. Without this, `/plan-session` has no signal about technical debt or quality risk. Tasks get planned without knowing which areas are fragile.

**Where:** New command `/quality-score` in `commands/`. Optionally integrated into `/plan-session` Phase 1 (codebase analysis) as a pre-flight quality snapshot stored in the planning doc's Project Metadata section.

**Output:** Scored report per domain/layer (A–F or 0–100), written to planning doc and optionally committed as `planning/quality-snapshot.md`.

**Scope:** Medium. New command + planning doc schema extension.

---

### 3. Custom Linter Remediation Injection

**What:** Extend pre-ship checks to support a project-local `linter-rules.md` (or `.shipwright/rules.yaml`) that maps lint violations to agent-readable remediation instructions. When a custom lint check fails, the error message includes the fix — not just the violation.

**Why:** OpenAI's team writes custom linter error messages specifically to inject remediation instructions into agent context. Standard linters (eslint, clippy, ruff) tell you what's wrong; they don't tell the agent how to fix it in _this project's_ conventions. The gap is most painful for project-specific rules (naming conventions, import structure, forbidden patterns).

**Where:** Add to `references/toolchain-patterns.md` (detection) and `commands/dev-task.md` (pre-ship check phase). When a lint failure occurs and a local rules file exists, append the matching remediation hint to the error before the agent sees it.

**Scope:** Small–medium. Linter output post-processing + local rules file convention.

---

## Application Legibility (Reference Only)

The research describes a third category of harness investment: making the _application_ legible to the agent (worktree-per-change, observability stack, Chrome DevTools integration). This is infrastructure, not a plugin — it requires project-level setup that Shipwright can't do for you.

See `references/` for a guide on what to set up. Shipwright's `/plan-session` can check for and flag missing legibility infrastructure as part of its pre-flight — but the actual setup is on the team.

---

_Last updated: March 2026_
