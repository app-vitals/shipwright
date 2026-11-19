# Plan: plan-write-endpoint

Source: design settled in conversation with Dan, 2026-11-19 (no PRODUCT-SPEC). Follow-on to the account-members session, where plan-session's three-call write flow and its always-403 session PATCH showed up.

## Pass 1 - 2026-11-19 - design settled in conversation

### Design
- **Session writes follow task-store scope.** `PATCH /sessions/:slug` is hard-coded admin-only (SESH-3.1) and records the actor as the literal `admin`. An agent token may write when every repo in the session (task repos plus document repos) is in its scope; admin is unrestricted; a session with no repos is admin-only; an invisible session is a 404 and a partly-in-scope one a 403. Reads keep the existing any-repo visibility. This matches plan-session's Step 0.5 preflight, which already requires all target repos covered. The admin UI's rename/archive stay admin-gated.
- **Remove `declaredRepos`.** Session `repos` is derived from tasks and documents. The column is only read in `session-service.ts` and only written by the `repos` patch that plan-session Step 6b.2 always sends (a 403 for agents). The patch body schema is non-strict, so a stale caller sending `repos` is ignored, not rejected; no staged removal is needed. Live data: 1 of 339 sessions (`brand-scoping`) has a value.
- **One plan endpoint.** `POST /sessions/{slug}/plan` ensures the session, registers the plan document, creates the stamped tasks and marks specs planned, atomically. It requires all repos in scope, respects the planning lock, and returns 409 on an id collision with the whole batch rolled back. `POST /tasks/bulk` stays: entropy-fix, error-fix, security-fix, consolidation-fix, prompt-fix and research-docs use it.
- **plan-session** switches to the new endpoint in Steps 6a.2/6b/6b.2 and drops the session `repos` PATCH.

### Decision Log
- All-repos rule for session writes; zero-repo sessions admin-only.
- Reads keep the any-repo visibility rule.
- Admin UI rename/archive stay admin-gated.
- `declaredRepos` dropped outright, no expand/contract, because the patch body is non-strict.
- `POST /tasks/bulk` stays.
- Dependency edges only between tasks, no deploy or pin steps.
- PWE-2.1 depends on TPG-3.1 because it touches the session list rollup.
- owner left empty: no owner resolved for this session.

### Tasks
| Task | Title | Depends on |
|---|---|---|
| PWE-1.1 | feat: session writes follow task-store scope instead of admin-only | - |
| PWE-2.1 | refactor: drop Session.declaredRepos and derive session repos from tasks and documents | 1.1, TPG-3.1 |
| PWE-3.1 | feat: POST /sessions/{slug}/plan creates the plan, tasks and session state in one transaction | 1.1 |
| PWE-3.2 | feat: plan-session and the task-store skill use POST /sessions/{slug}/plan | 3.1 |

### Dependency Map
```
PWE-1.1 session writes follow scope
  ├─ PWE-2.1 drop declaredRepos (also TPG-3.1)
  └─ PWE-3.1 POST /sessions/{slug}/plan
        └─ PWE-3.2 plan-session + skill use it
```
Breaking-change safety: the only removals are the declaredRepos column and the patch `repos` field, whose sole caller (plan-session Step 6b.2) already fails for agents; a stale `repos` key is ignored. The new endpoint and the loosened session authorization are additive.
