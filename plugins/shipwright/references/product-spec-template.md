# PRODUCT-SPEC.md Template

This template is used by `/brainstorm` to generate the `planning/{folder}/PRODUCT-SPEC.md` file. It is also the format that `/plan-session` expects when it reads planning documents.

The `/brainstorm` command fills each placeholder from interactive discovery and codebase research. The resulting document is placed at `planning/{folder}/PRODUCT-SPEC.md` for direct consumption by `/plan-session`.

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

## Open Questions

{Uncertainties, unresolved decisions, or dependencies on external teams that plan-session
should account for when generating tasks. If none, write "None." Examples:}
- {Question — e.g., "Should the audit log be synchronous or async? Affects error handling strategy."}
- {Dependency — e.g., "Requires sign-off from the security team on the token storage approach."}

## Success Criteria

{How we'll know the entire feature is complete and working — from both the user's perspective
and technically. This is the overall completion condition, not per-feature acceptance criteria.}
```

---

## Field Reference

| Field | Purpose | Source in `/brainstorm` |
|-------|---------|------------------------|
| **Overview** | Quick project summary | Synthesized from Q2 + Q3 |
| **Problem Statement** | Specific problem being solved | Q2 |
| **Users & Context** | Who uses this and why | Q3 |
| **Features** | Per-feature requirements and ACs | Q4 + depth probes (Q4a) |
| **Technical Constraints** | Implementation constraints | Q5 |
| **Out of Scope** | Explicit exclusions | Q6 |
| **Priorities & Sequence** | Build order, if applicable | Q7 |
| **Open Questions** | Unknowns and unresolved decisions | Q8 + Phase 2 research findings |
| **Success Criteria** | Overall completion condition | Q9 |
| **Technical Considerations** | Codebase patterns and APIs to use | Phase 2 researcher output |

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
