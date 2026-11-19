# Plan: account-members (SWI-9)

Source: task-store initiative SWI-9 "Task store: accounts and users" (no PRODUCT-SPEC; the design below was settled in the planning conversation with Dan, 2026-11-19).

## Pass 1 - 2026-11-19 - SWI-9

### Design
Build on the existing platform models (`@app-vitals/agent-admin`, source in `app-vitals/agent/admin`): `Account`, `AccountMember`, `AgentMember`, `Agent.accountId`. No `User` table.

- **User principal:** `AccountMember.id` is the stable user id. Email stays the lookup, never the key; email is the only display value (no name field).
- **Agent principal:** `Agent.id`. Agents are already in an account through the nullable `Agent.accountId`; no agent row in `AccountMember` (its `email` is required and unique).
- **Ownership:** `ownerId` + `ownerType` (`user|agent`) on Task, Session and PlanDocument. Scanner and cron-filed tasks are owned by the filing agent.
- **One account per user:** kept as the existing DB unique on `AccountMember.email`. Dropping it is the multi-account step.
- **Roles:** `owner | member` kept as is; owner = admin.
- **Task-store `accountId`:** stays a string stamped from the token's agent via the scope resolver; no cross-DB foreign key (separate schemas).
- **Backfill:** each email-to-id backfill has a `--dry-run` reporting unmapped values, an overrides file for hand matches, and sets unmapped to null. Old email columns are dropped only after zero unexplained nulls.
- **Sequencing:** expand (agent) then release gate then migrate (shipwright) then contract. Tasks that touch list-endpoint filters, admin tables or reconcilers depend on TPG-3.1 (task-store-pagination).
- **Out of scope:** SWI-10 (server-allocated ids, builds on this) and SWI-11 (team ownership, depends on SWI-9).

### Decision Log
- Keep `AccountMember.email` unique: Dan, existing constraint already gives one-account-per-user and nothing in the request needs it changed.
- Keep roles `owner|member`: renaming costs a data migration for no gain.
- Agent membership via `Agent.accountId`, not `AccountMember`: no email on agents; the link already exists. `Agent.accountId` stays nullable.
- No design-doc task: settled in conversation.
- Full migration to ids with backfill (not the lighter email-keyed option): Dan wants data cleaned up and email resolved by lookup.
- Always render email for display: consistency.
- owner left empty on tasks: no owner resolved for this session.

### Tasks
| Task | Repo | Title | Depends on | HITL |
|---|---|---|---|---|
| ACM-1.1 | agent | feat: principal lookup API and nullable memberId columns | - |  |
| ACM-1.2 | agent | feat: memberId backfill script with dry-run | 1.1 |  |
| ACM-1.3 | agent | chore: run memberId backfill on prod (dry-run, hand-match, apply) | 1.2 | HITL |
| ACM-2.1 | shipwright | chore: wait for @app-vitals/agent-admin with principal lookup in shipwright | 1.1 |  |
| ACM-3.1 | shipwright | feat: ownerId and ownerType on Task, Session and documents, with backfill script | 2.1 |  |
| ACM-3.2 | shipwright | chore: run owner backfill on prod (dry-run, hand-match, apply) | 3.1 | HITL |
| ACM-3.3 | shipwright | refactor: admin UI and owner filters read ownerId, display email via lookup | 3.2, TPG-3.1 |  |
| ACM-3.4 | shipwright | feat: scanner and cron-filed tasks owned by the filing agent principal | 3.1, TPG-3.1 |  |
| ACM-4.1 | agent | refactor: per-user tables read memberId, email via lookup | 1.3, 2.1 |  |
| ACM-5.1 | agent | refactor: drop email key columns from per-user tables | 4.1, 3.3 |  |
| ACM-5.2 | shipwright | refactor: drop Task.owner and the other email owner columns | 3.3, 3.4 |  |

### Dependency Map
```
ACM-1.1 (agent: lookup API + memberId cols)
  ├─ ACM-1.2 backfill script ── ACM-1.3 HITL run ──┐
  └─ ACM-2.1 release gate (shipwright)              │
        ├─ ACM-3.1 owner cols + script ── ACM-3.2 HITL run
        │     ├─ ACM-3.3 UI/filters (also TPG-3.1) ──┐
        │     └─ ACM-3.4 agent-owned tasks (also TPG-3.1) ──┐
        └─ ACM-4.1 per-user tables on memberId (also needs 1.3)
ACM-5.1 drop email keys (agent): 4.1, 3.3
ACM-5.2 drop email owner (shipwright): 3.3, 3.4
```
Breaking-change safety: every removal (5.1, 5.2) comes after its consumers migrate (4.1, 3.3, 3.4) and is gated on a zero-unexplained-null check. 1.1, 3.1 are additive.

## Pass 2 - 2026-11-19 - consumer compat unblock for ACM-1.1

**Problem.** app-vitals/agent PR #266 (ACM-1.1) adds nullable `memberId` to AgentMember. Its `shipwright consumer compat` check typechecks shipwright against the PR build and fails: shipwright test mocks return AgentMember rows without `memberId`. ACM-1.1 was blocked on this.

**Design.** Add `memberId: null` to the mock return shapes in five shipwright smoke test files. The change is additive and must typecheck against both the pinned 1.73.0 and the #266 build. No production code changes.

| Task | Repo | Title | Depends on |
|------|------|-------|-----------|
| ACM-6.1 | app-vitals/shipwright | test: add nullable memberId to AgentMember mocks for consumer compat | none |

ACM-1.1 now depends on ACM-6.1. Once ACM-6.1 merges, re-run the check on #266 and unblock ACM-1.1 (POST /tasks/ACM-1.1/unblock).

Breaking Change Safety: safe to deploy standalone (test fixtures only).

### Decision Log
- Milestone number: defaulted to 6 (highest existing is 5) per the append rule, even though it gates milestone 1.
- Single task, haiku tier: five fixture files, no logic.
