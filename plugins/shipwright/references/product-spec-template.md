# PRODUCT-SPEC.md Template

This template is used by `/prd` to generate the `planning/{folder}/PRODUCT-SPEC.md` file. It is also the format that `/plan-session` expects when it reads planning documents.

The `/prd` command fills each placeholder from interactive discovery and codebase research. The resulting document is placed at `planning/{folder}/PRODUCT-SPEC.md` for direct consumption by `/plan-session`.

---

```markdown
# {Feature/Project Name} — Product Specification

**Date**: {YYYY-MM-DD}
**Session**: {folder-name}
**Status**: Draft

## Overview

{2-3 sentences: what this is, why it matters, who it's for. Enough context for a developer
to understand the goal without reading the full document.}

## Problem Statement

{The specific problem being solved. Should be concrete and grounded — not "improve UX"
but "users cannot switch accounts without logging out and back in, causing them to lose
their unsaved work." Directly sourced from the user's answer to Q2.}

## Users & Context

{Who uses this feature, in what workflow context, and what their goal is. Include any
relevant personas or user types. Sourced from Q3.}

---

## Features

{One section per feature. Use ### headings so /plan-session can identify feature boundaries.
Every feature must have acceptance criteria with testable checkboxes.}

### Feature N: {Feature Name}

**Priority**: High / Medium / Low
**Description**: {What this feature does and why it matters to the user.}

**User Stories**:
- As a {user type}, I want to {action} so that {benefit}.

**Requirements**:
- {Specific requirement — what the system must do}
- {Another requirement}

**Acceptance Criteria**:
- [ ] {Testable, observable, specific outcome — written so a developer knows exactly when this is done}
- [ ] {Another testable criterion}

**Technical Considerations**: {Existing patterns or utilities to reuse, external APIs to
integrate with, architectural constraints, performance requirements. Populated from Phase 2
research. Omit if none identified.}

**Source Map**: {Existing files this feature touches, populated from the Phase 2 researcher
pass. One file path per line. Omit if the feature is entirely new with no existing code to
modify. Example:}
- `src/api/notifications/routes.ts` — adds new endpoint
- `src/lib/email.ts` — reuses sendEmail utility
- `src/db/schema.prisma` — adds Notification model

**Testing Strategy**: {Which test layer owns coverage for this feature, and why. Derived from
the test-layer probe in Phase 2. Format: "Layer: {unit|integration|smoke|e2e} — {reason}".
Example: "Layer: integration — feature calls the GitHub API via an injected client double."}

---

{Repeat for each feature}

---

## Technical Constraints

{Things the implementation must comply with or avoid. Examples:}
- {Framework or language constraint — e.g., "Must use the existing Express router pattern"}
- {Performance requirement — e.g., "Page load must remain under 1.5s after this change"}
- {Integration constraint — e.g., "Must use the internal audit logging library for all state changes"}
- {Compatibility requirement — e.g., "Must not break existing API consumers"}

## Scope

**In Scope**:
- {Capability explicitly included in this work}
- {Another included item}

**Out of Scope**:
- {Item explicitly excluded — prevents scope creep during task generation}
- {Another excluded item}

## Priorities & Sequence

{If features have a required build order, describe it here. Example: "Authentication must
be complete before the workspace switcher can be implemented." If there are no ordering
constraints, write: "No ordering constraints — features can be built in parallel."}

## Testing Strategy

{Top-level summary of the intended test layer per feature. Synthesized from per-feature
Testing Strategy fields above and the test-layer probe in Phase 2. Format as a table so
/plan-session can adopt it directly without re-deriving.}

| Feature | Layer | Rationale |
|---------|-------|-----------|
| {Feature N name} | unit / integration / smoke / e2e | {One-sentence justification — e.g., "pure validation logic, no I/O"} |
| {Feature N+1 name} | integration | {e.g., "calls external API via injected client double"} |

## Resolved Decisions

{Decisions reached during the PRD session. Every item must record the decision taken and
its rationale — not a deferred question. If a user deferred something, record the chosen
default and note that it can be revisited. If none arose, write "None." /plan-session
consumes these directly; unresolved blockers must not appear here.}

- **{Decision topic}**: {Decision taken.} — Rationale: {Why this was chosen.}
  - Example: **Audit log delivery**: Asynchronous via queue. — Rationale: Synchronous delivery would add latency to every API write; async matches the existing event bus pattern.
- **{Decision topic}**: {Default chosen because user deferred.} — Rationale: {Basis for the default.} _(Can be revisited before plan-session.)_

## Success Criteria

{How we'll know the entire feature is complete and working — from both the user's perspective
and technically. This is the overall completion condition, not per-feature acceptance criteria.}
```

---

## Field Reference

| Field | Purpose | Source in `/prd` |
|-------|---------|------------------------|
| **Overview** | Quick project summary | Synthesized from Q2 + Q3 |
| **Problem Statement** | Specific problem being solved | Q2 |
| **Users & Context** | Who uses this and why | Q3 |
| **Features** | Per-feature requirements and ACs | Q4 + depth probes (Q4a) |
| **Technical Constraints** | Implementation constraints | Q5 |
| **Out of Scope** | Explicit exclusions | Q6 |
| **Priorities & Sequence** | Build order, if applicable | Q7 |
| **Resolved Decisions** | Decisions taken (or defaults chosen) during the PRD session | Q8 driven to resolution + Phase 2 research findings |
| **Success Criteria** | Overall completion condition | Q9 |
| **Technical Considerations** | Codebase patterns and APIs to use | Phase 2 researcher output |
| **Source Map** | Existing files each feature touches; seeds plan-session exploration | Phase 2 researcher pass — file enumeration |
| **Testing Strategy** | Intended test layer per feature; plan-session adopts directly | Phase 2 test-layer probe |

## Acceptance Criteria Quality Guide

Plan-session uses acceptance criteria directly when generating task acceptance criteria. Quality matters:

| Good | Bad |
|------|-----|
| `- [ ] User can switch workspaces without page reload` | `- [ ] Workspace switching works` |
| `- [ ] API returns 404 with error body when resource not found` | `- [ ] Error handling is correct` |
| `- [ ] Coverage >= 90% for modified files` | `- [ ] Tests pass` |
| `- [ ] Audit log entry created for every state change` | `- [ ] Logging is implemented` |

**Rules:**
- Each criterion must be verifiable by a developer without asking clarifying questions
- Avoid subjective language ("good UX", "fast", "clean")
- Prefer observable outcomes over implementation details
- Include at least one criterion that maps to automated verification (test, type check, lint)
