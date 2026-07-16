# Test Naming Convention & Runner-Exclusion Config

> **Mandatory M1 gating doc.** This is the authoritative reference for "file suffix →
> layer" naming and for which suffixes the default `bun test` runner must **not**
> discover. It must land before any test-readiness rename task (T-002 onward) to
> prevent file-discovery collisions — a file that matches two suffix rules, or a
> reserved suffix that collides with an existing one, breaks the whole
> classify-by-filename scheme this repo relies on.
>
> For layer *boundary rules* (what belongs in each layer) and *speed budgets*, see
> [`test-system.md`](./test-system.md) (the full blueprint) and
> [`docs/testing.md`](../testing.md) (the digest). This doc does not repeat that
> content — it is scoped to naming and runner exclusion only.

## Suffix → layer table

Every test file's layer is encoded entirely in its filename suffix. A file must match
**exactly one** suffix below.

| Suffix | Layer | Discovered by `bun test`? |
|---|---|---|
| `*.unit.test.ts` | unit | Yes |
| `*.integration.test.ts` | integration | Yes |
| `*.smoke.test.ts` | smoke | Yes |
| `*.content.test.ts` | content | Yes |
| `*.spec.ts` (in `site/`) | e2e | **No** — excluded via `bunfig.toml` |
| `*.e2e.ts` (in `metrics/e2e/`, `admin/e2e/`) | e2e | **No** — excluded via `bunfig.toml` |
| `*.canary.test.ts` | canary (**reserved**) | **No** — excluded via `bunfig.toml` |

See `test-system.md`'s [layer definitions](./test-system.md#layer-definitions) for the
boundary rule each layer enforces, and `testing.md`'s [speed budgets](../testing.md#speed-budgets)
for per-layer timing targets.

## The reserved `.canary.` suffix

No `*.canary.test.ts` files exist in the repo yet — the suffix is **reserved**, not yet
in use. It is defined here now, ahead of any concrete canary test, so that when the
test-readiness pipeline's canary suite is introduced (see the `canary-execution` skill —
[`plugins/shipwright/skills/canary-execution/SKILL.md`](../../plugins/shipwright/skills/canary-execution/SKILL.md)),
there is no ambiguity about what filename pattern it uses and no risk of an existing
file accidentally colliding with it.

Per the canary-execution contract, canary-eligible tests are smoke or E2E tests that also
run against a deployed environment via a **dedicated entry point** — never through
`bun test` or the local smoke runner. They read `TEST_TARGET_URL` at process start:
unset means local mode (boot dependencies inline), set means canary mode (hit the
deployed URL directly, using canary-scoped auth). Eligibility is restricted to
read-only-or-self-cleaning, critical/high-criticality, DB-free tests, with a 60-second
suite wall-time budget. See the skill doc for the full eligibility rules, the canary
safety lint, and the gating contract — this doc only concerns itself with the naming
and exclusion mechanics.

Because the canary suite has its own dedicated entry point (a distinct npm script or
Playwright project) and must never reuse `test:smoke`, `*.canary.test.ts` files must
also stay out of the default `bun test` scan — identical rationale to the existing
`*.spec.ts` / `*.e2e.ts` exclusions.

## Runner-exclusion config (`bunfig.toml`)

`bunfig.toml`'s `[test]` section lists `pathIgnorePatterns` — globs the root `bun test`
scan skips entirely. Each entry corresponds to a suffix in the table above that is
handled by a different runner (Playwright) or reserved for a not-yet-built dedicated
entry point (canary):

| Pattern | Excludes | Why |
|---|---|---|
| `**/site/**` | `site/**/*.spec.ts` | Astro marketing site's Playwright suite; run via `cd site && npm test`, not `bun test`. Bun would otherwise try to execute Playwright specs and crash. |
| `**/metrics/e2e/**` | `metrics/e2e/*.e2e.ts` | Metrics dashboard's Playwright E2E suite; run via `task e2e` / `bunx playwright test`, not `bun test`. |
| `**/admin/e2e/**` | `admin/e2e/*.e2e.ts` | Admin UI's Playwright E2E suite; run via `cd admin && bunx playwright test`, not `bun test`. |
| `**/*.canary.test.ts` | any `*.canary.test.ts` file, anywhere | Reserved for the future canary suite's dedicated entry point (`canary-execution` skill contract). Canary tests must never run via the default `bun test` scan — same rationale as the e2e exclusions, added proactively even though no file currently matches this glob. |

Unit, integration, smoke, and content suffixes have **no** `pathIgnorePatterns` entry —
they are exactly the suffixes the root `bun test` scan is meant to discover and run.

## Collision rules

1. **One suffix per file.** A test file must match exactly one row in the suffix table.
   A filename like `foo.unit.integration.test.ts` is invalid — pick one layer.
2. **Reserved suffixes must not collide with layer suffixes.** `.canary.` is reserved
   specifically because it does not overlap with any existing `.unit.`/`.integration.`/
   `.smoke.`/`.content.` infix, and `*.canary.test.ts` does not match any existing
   `*.spec.ts`/`*.e2e.ts` glob.
3. **Exclusion config must stay in sync with this doc.** Any new reserved or runner-owned
   suffix added here must have a matching `pathIgnorePatterns` entry in `bunfig.toml` in
   the same change — and vice versa. This doc and `bunfig.toml` are verified together by
   `plugins/shipwright/test/test-naming-convention.content.test.ts`.
4. **Bare `*.test.ts` files (no layer suffix) are a known pre-M1 gap.** A small number of
   existing files predate this convention and have not yet been renamed to a layer
   suffix: `brand/brand-lint.test.ts`, `brand/build-brand-css.test.ts`,
   `scripts/sync-version.test.ts`. Renaming them is out of scope for this doc — it is a
   later test-readiness rename task's job (T-002+). They are not currently excluded from
   `bun test` and continue to run; they are noted here only so a future rename task has a
   starting inventory.

## References

- [`test-system.md`](./test-system.md) — the authoritative blueprint: layer boundary
  rules, per-component speed budgets, CI pipeline shape, and the full isolation contract.
- [`docs/testing.md`](../testing.md) — the digest doc: layer table, run commands, and
  CI gates.
- [`plugins/shipwright/skills/canary-execution/SKILL.md`](../../plugins/shipwright/skills/canary-execution/SKILL.md) —
  the canary-execution contract: dedicated entry point, `TEST_TARGET_URL` mode
  selection, eligibility rules, the canary safety lint, and the 60-second suite budget.
