# Planning Document Template

This template is used by `/plan-session` Phase 4 to generate the task breakdown document. Placeholders are filled in by the command based on project analysis.

---

```markdown
# {Project Name} — {Scope Period} Task Breakdown

**Prepared:** {YYYY-MM-DD}
**Based On:** {list of input doc filenames from the planning folder}

### Project Metadata
| Field | Value |
|-------|-------|
| **Project Type** | {detected project type — e.g., "Node.js web app", "Rust CLI", "Python API"} |
| **Toolchain** | {detected package manager + key tools — e.g., "pnpm, TypeScript, Vitest"} |
| **Layers** | {auto-detected layers — e.g., "API, Frontend, Database, Shared"} |
| **Coverage Target** | {coverage_threshold}% |

---

## Executive Summary

| Feature | Hours | % of Total |
|---------|-------|------------|
{one row per feature}
| **Total** | **{total_hours}** | 100% |

## Timeline Overview

| Phase | Features | Start | End |
|-------|----------|-------|-----|
{phase rows — group features into logical phases}

---

{For each feature, generate this structure:}

## {Feature N}: {Feature Name}

### Overview
{Problem statement: what user need or business goal does this address}
{Solution approach: high-level technical approach}

### {N.M} {Sub-feature Name}

#### Task {PREFIX-N.M}: {Task Title}
| Field | Value |
|-------|-------|
| **ID** | {PREFIX-N.M} |
| **Hours** | {hours} |
| **Layer** | {auto-detected layer for this task} |
| **Dependencies** | {None or comma-separated task IDs} |
| **Branch** | `feat/{task-id-lowered-dots-to-dashes}-{first-3-4-words-kebab}` |
| **Context** | {2-3 sentences of feature-level context — enough to understand the task in isolation} |
| **Design Skill** | {skill name if applicable, otherwise omit this row} |
| **Test Type** | {`unit` / `integration` / `e2e` — only for test tasks, otherwise omit this row} |
| **Architecture** | {`minimal` / `clean` / `pragmatic` — see guidelines below} |
| **Expected Tests** | - `test: {behavior under test}` (one bullet per key scenario) |

**Description**: {One-line summary}

**Technical Details**:
- Location: `{file_paths where work happens}`
- {Implementation notes — what specifically changes}

**Acceptance Criteria**:
- [ ] {Testable criterion}

**Risk**: {Low/Medium/High} — {brief justification if Medium or High}

**Expected Tests** (RED phase — implementer writes these first):
- `test: {key scenario from acceptance criteria}`
- `test: {edge case from Implementation Decisions}`
- `test: {error/failure path that must be handled}`
(Provide at least 2–3 test descriptions per task; more for complex tasks. These become the TDD red phase starting point.)

**Implementation Decisions** (pre-answers for autonomous development):
- **Edge Cases**: {List specific edge cases to handle}
- **Error Handling**: {Strategy — e.g., "toast user on failure, log to console, never silently swallow"}
- **Scope Boundaries**: {What's explicitly NOT included}
- **Backward Compatibility**:
  - Breaking changes: {none / list any renames or removals of DB tables/columns, API endpoints/fields, client methods}
  - Safe to deploy standalone: {yes — no removals or renames / no — explain what breaks and how task sequencing prevents a broken intermediate state}
- **Performance**: {Constraints or "no special requirements"}

---

### {Feature Name} Test Strategy

**Coverage Target:** >{coverage_threshold}% for unit tests. All new code must maintain or improve coverage.

{Prose: what needs unit tests, what needs integration tests, edge cases. Specifically call out:}
- {Which modules/functions need unit test coverage and why}
- {Which user flows need integration/e2e coverage and why}
- {Edge cases that must be covered to maintain >{coverage_threshold}%}

{Then dedicated test tasks using the same task structure above, with Test Type field and T-suffix IDs: PREFIX-N.T1, PREFIX-N.T2, etc. Each test task's AC must include a coverage criterion, e.g.:}
- [ ] Unit test coverage for {package/module} remains >{coverage_threshold}%
- [ ] Integration test coverage for {flow} remains >{coverage_threshold}%

---

### {Feature Name} Summary
| Status | ID | Task | Hours | Layer | Dependencies |
|--------|-----|------|-------|-------|--------------|
| [ ] | {PREFIX-N.M} | {task title} | {hours} | {layer} | {deps} |
| | | **Subtotal** | **{subtotal}** | | |

---

{After all features:}

## Assumptions & Risks

| Risk | Impact | Mitigation |
|------|--------|------------|
{project-level risks}

## Out of Scope
{Items explicitly excluded from this scope — bullet list}

## Appendix: Complete Task List

| Status | ID | Task | Hours | Layer | Dependencies |
|--------|-----|------|-------|-------|--------------|
| [ ] | {PREFIX-N.M} | {task title} | {hours} | {layer} | {deps} |
| | | **Total** | **{total_hours}** | | |
```

---

## Layer Auto-Detection

The `Layer` field is populated by scanning the project's directory structure:

| Directory Pattern | Layer Name |
|-------------------|------------|
| `src/api/`, `routes/`, `server/`, `app/api/` | API |
| `src/components/`, `pages/`, `frontend/`, `app/`, `src/views/` | Frontend |
| `src/db/`, `prisma/`, `migrations/`, `src/models/` | Database |
| `src/lib/`, `packages/shared/`, `src/utils/`, `src/common/` | Shared |
| `src/workers/`, `src/jobs/`, `src/tasks/`, `src/queue/` | Background |
| `src/cli/`, `bin/`, `cmd/` | CLI |
| Monorepo packages (from workspace config) | One layer per package |

If auto-detection finds fewer than 2 layers, ask the user to describe their project's layers.

## Placeholder Reference

| Placeholder | Source |
|-------------|--------|
| `{coverage_threshold}` | Default: 90. Override via user input during planning. |
| `{auto-detected layer}` | From directory scanning (see table above) |
| `{detected project type}` | From toolchain detection |
| `{detected package manager + key tools}` | From toolchain detection |
