# Plan: zod4-upgrade

Evaluation of Renovate PR #3889 (`@hono/zod-openapi` ^0.19 → ^1.0). Approved by Dan: single atomic PR, do it sooner rather than later.

## Finding
`@hono/zod-openapi` 1.x depends on `@asteasolutions/zod-to-openapi` 9.x, which peer-requires `zod ^4`. All four consumers (admin, chat, metrics, task-store) pin `zod ^3`. #3889 only bumps the package; CI `lint / typecheck / test` fails at runtime with `TypeError: undefined is not an object (evaluating 'schema._zod.parent')` (zod 3 schemas passed to the zod 4 library). The bump is therefore a zod 3 → 4 migration.

## Design
- Bump `zod` to `^4` and `@hono/zod-openapi` to `^1` in admin, chat, metrics, task-store; regenerate `bun.lock`.
- `admin/src/agent-type-registry.ts`: replace `zod-to-json-schema` (zod 3 only) with zod 4's `z.toJSONSchema`; diff the generated agent-type JSON Schema artifact before/after.
- Fix zod 4 API changes across ~26 source files (heaviest: `{admin,task-store,chat}/src/openapi-schemas.ts`, `admin/src/agents-api.ts`): `.errors` → `.issues`, `.flatten()/.format()`, string-format helpers, `nativeEnum`, `invalid_type_error`/`required_error` → `error`, single-arg `z.record()`, `.strict()/.merge()`, `ZodTypeAny`.
- Behaviour change (1.6.3): non-matching JSON/form Content-Type now returns 415 instead of validating `{}`. Audit routes and callers; add contract tests.
- Diff generated OpenAPI documents before/after to confirm no unintended contract drift.
- Fold a Renovate grouping rule for `zod` + `@hono/zod-openapi` into the same PR.
- Close #3889 in favour of the migration PR.

## Breaking Change Safety
Atomic: one PR updates every consumer (shared root lockfile pins one zod). Safe to deploy standalone: yes (no DB or API-shape change intended).

## Tasks
| Task | Depends on | HITL |
|------|-----------|------|
| ZOD-1.1 Migrate to zod 4 and @hono/zod-openapi 1.x | — | no |
