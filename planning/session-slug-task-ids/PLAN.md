# Plan: session-slug-task-ids

Fulfils initiative SWI-10 (Task store: server-allocated task ids). Task prefix `STI` (the scheme itself is not built yet, so this session uses the legacy form).

## Pass 1

### Design

Replace the hand-picked 2-3 letter task prefix with the full session slug: new task ids are `{session-slug}-{N}.{M}`. No friendly-name alias and no db-canonical id; the slug is the prefix. Sessions already support adding tasks across planning passes, so a slug stays the stable namespace.

- **Slug rule (new sessions only):** `^[a-z][a-z0-9-]{0,63}$` (lowercase kebab-case, starts with a letter, max 64). A bad slug is rejected with a message asking for a different name; it is never truncated. Existing slugs (665 sessions, longest 43, one with an uppercase letter, a few containing `/`) are grandfathered.
- **Legacy sessions:** adding tasks to a session whose tasks use a legacy prefix keeps that prefix. Only new sessions get slug ids.
- **Uniqueness and querying are case-insensitive** for session slugs and task ids: unique indexes on `(accountId, lower(slug))` and `lower(id)` (raw SQL migration; Prisma cannot declare functional uniques), `session=` filter and `GET /sessions/:slug` and `GET/PATCH /tasks/:id` match case-insensitively, bulk/plan collisions return 409. Live check 2026-11-28: zero case collisions among sessions and task ids, so the constraint migration is safe.
- **Enforcement points:** plan-session validates the slug before taking the planning lock; `POST /sessions/:slug/plan` rejects an invalid slug for a new session; the task store never parsed id prefixes, so no other server change is needed.
- **Plugin docs:** plan-session.md, the plan-session methodology contract, planning-doc-template.md, refresh-plan.md and the docs move to `{session-slug}-{N}.{M}`; schema-validation check 1 accepts either form.

### Tasks

| Task | Title | Layer | Deps | Hours |
|------|-------|-------|------|-------|
| STI-1.1 | feat: add case-insensitive unique indexes on session slug and task id | Database | — | 3 |
| STI-1.2 | feat: validate new session slugs and make session lookup case-insensitive | API | 1.1 | 4 |
| STI-1.3 | feat: make task id lookup and collision checks case-insensitive | API | 1.1 | 3 |
| STI-2.1 | docs: use session slug as task id stem in plan-session, contract and docs | Shared | 1.2 | 4 |
| STI-2.2 | fix: handle long task ids in admin task and PR lists | Frontend | — | 2 |

### Dependency Map

```
[START]
  ├─ STI-1.1: case-insensitive unique indexes (no deps)
  │     ├─ STI-1.2: slug validation + case-insensitive sessions
  │     │     └─ STI-2.1: plugin docs/contract/tests to slug ids
  │     └─ STI-1.3: case-insensitive task id lookup/collisions
  └─ STI-2.2: admin long-id display (no deps)
```

| Task | Depends on | Blocks | HITL |
|------|-----------|--------|------|
| STI-1.1 | — | 1.2, 1.3 | |
| STI-1.2 | 1.1 | 2.1 | |
| STI-1.3 | 1.1 | — | |
| STI-2.1 | 1.2 | — | |
| STI-2.2 | — | — | |

### Breaking Change Safety

- STI-1.1 adds unique constraints to tables with rows. Live distinct-values check done at planning time (zero collisions); the migration must also fail loudly with the colliding values if any appear before it runs. Safe to deploy standalone once that holds.
- STI-1.2, 1.3, 2.1, 2.2 are additive or relax validation. Safe to deploy standalone: yes.

### Decision Log

- Slug cap: 64 (Dan), enforced by rejection, never truncation.
- Charset: lowercase kebab-case for new slugs; legacy slugs grandfathered (Dan confirmed).
- Case-insensitive uniqueness/querying for sessions and task ids (Dan).
- Legacy-prefix sessions keep their prefix when adding tasks.
- This session uses the `STI` prefix because the new scheme is not implemented yet.
