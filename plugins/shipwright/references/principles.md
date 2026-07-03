# Shipwright Principles

The single source of truth for Shipwright's code-design and testing principles.
Every consumer — `plan-session`, `dev-task`, `review`, `entropy-scan`/`entropy-fix`,
and the test-readiness rubrics — reads its principles from this file.

> **Status note:** This file is net-new and additive. Consumers are repointed at it
> in later tasks (PRN-2.x / PRN-3.1). Until then nothing reads it — it is pure content.

## How to read this file

Each principle is one `###` entry with a fixed field order:

```
### `<id>`

**Domain:** <architecture | testing | security | dead_code | todo_debt | docs>
**Severity:** <low | medium | high>

<statement prose — what to do and why>

**Detection:** <instruction for a scanning agent — only on entropy-scannable entries>
**PR-worthy:** <true | false>              (only present alongside Detection)
**HITL:** <always | never | per-finding>   (only present alongside Detection, on pr_worthy:true entries)
```

- **`**Domain:**` is machine-authoritative.** The `##` domain headings below are a
  presentation grouping for human readers; the `**Domain:**` field on each entry is
  what a consumer keys off.
- **Only entries with a `**Detection:**` field are entropy-scannable.** `entropy-scan`
  and `entropy-fix` filter to entries containing a `**Detection:**` field; everything
  else is judgment-only — readable by `review`/`plan-session`/`dev-task` but never
  mechanically scanned.
- **The `**HITL:**` field documents routing intent only.** It records how a
  `pr_worthy` finding should be classified (`always` HITL / `never` HITL /
  `per-finding` judgment). `entropy-fix`'s actual queue/HITL routing logic is wired in
  a separate task; this file only declares the classification.

**Age threshold** for the `stale_todo` / `todo_fixme_hack` rules is configured per repo
via `todo_max_age_days` (default 90).

---

## Dead Code

### `dead_exports`

**Domain:** dead_code
**Severity:** medium

Exported functions, types, or constants that are never imported anywhere in the
codebase. Dead exports inflate the public surface, mislead readers about what is in
use, and make refactors harder. Classification is always obvious (by construction,
nothing imports it), so it routes to an autonomous fix.

**Detection:** For each TypeScript/JavaScript source file, list all exported symbols
(`export function`, `export const`, `export type`, `export class`, `export interface`).
Then search the entire codebase for import statements that reference each symbol. Flag
any export that has zero import sites. Skip `index.ts` re-export files and test files.
Report: file path, export name, export type.
**PR-worthy:** true
**HITL:** never

### `commented_out_blocks`

**Domain:** dead_code
**Severity:** low

Large blocks of commented-out code (5+ consecutive commented lines) that should be
deleted or restored. Once reviewed, deletion or restoration is unambiguous, so this
routes to an autonomous fix (subject to the task-store cross-check for planned work).

**Detection:** Scan source files for runs of 5 or more consecutive commented-out lines
(`//` or `#`). Exclude JSDoc/TSDoc blocks (`/** ... */`), license headers, and section
dividers (`---` or `===`). Flag the file, start line, and approximate line count. Blocks
in test files are lower priority.
**PR-worthy:** false
**HITL:** never

### `unreferenced_files`

**Domain:** dead_code
**Severity:** medium

Source files that are never imported or required by any other file and have no
entry-point marker. Classification is always obvious (by construction, nothing imports
it) and routes to an autonomous deletion task — subject to the task-store cross-check so
a file another pending task is about to depend on is not deleted out from under it.

**Detection:** List all `.ts`/`.js` source files (excluding `*.test.ts`, `*.spec.ts`,
`index.ts` files, and CLI entry points listed in `package.json` bin/scripts). For each
file, check if it appears in any import statement in the codebase. Flag files with zero
import sites. These are candidates for deletion.
**PR-worthy:** true
**HITL:** never

---

## TODO Debt

### `todo_fixme_hack`

**Domain:** todo_debt
**Severity:** medium

`TODO`, `FIXME`, or `HACK` comments in source code. These are deferred work made
visible; report-only so a human decides whether each is still worth doing.

**Detection:** Search all source files for comments containing `TODO`, `FIXME`, `HACK`,
or `XXX` (case-insensitive). For each match, report: file, line number, comment text, and
whether git blame shows the comment is older than `todo_max_age_days`. Prioritize comments
in frequently-modified files. Exclude test files (lower signal there). `HACK` comments are
higher severity than `TODO`s.
**PR-worthy:** false
**HITL:** never

### `stale_todo`

**Domain:** todo_debt
**Severity:** high

`TODO`/`FIXME` comments that have been in the codebase longer than the configured age
threshold — tech debt consciously deferred past any reasonable window. Report-only.

**Detection:** For each `TODO`/`FIXME`/`HACK` found, use `git log -S"<comment text>"
--follow -- <file>` to find when that line was introduced. Flag comments older than
`todo_max_age_days` as stale. Report: file, line, comment, age in days, original author.
**PR-worthy:** false
**HITL:** never

---

## Documentation Gaps

### `undocumented_exports`

**Domain:** docs
**Severity:** low

Exported functions and classes with no JSDoc comment. Report-only — a human decides
which exported symbols genuinely warrant documentation.

**Detection:** For each exported function, class, or interface in TypeScript source
files, check if there is a JSDoc comment (`/** ... */`) immediately preceding it. Flag
exports with no JSDoc. Skip very short utility functions (< 5 lines body) and test files.
Prioritize: public API modules, functions with complex signatures (3+ params), and
functions that have caused bugs before (check CLAUDE.md or commit messages for hints).
**PR-worthy:** false
**HITL:** never

### `missing_readme_section`

**Domain:** docs
**Severity:** low

Module directories (packages, services) that have no README.md or have a README missing
key sections. Report-only.

**Detection:** For each top-level directory under `src/` that contains TypeScript source
files, check if a README.md exists. Also check the README has at minimum: a title line
(`# ...`) and at least one of: a "What it does" section, a "Usage" section, or a CLI
usage example. Flag missing README files and READMEs with only a title. Report: directory,
what's missing.
**PR-worthy:** false
**HITL:** never

---

## Security

### `hardcoded_secrets`

**Domain:** security
**Severity:** high

Hardcoded API keys, tokens, passwords, or credentials in source files. This **always
routes to HITL** — a secret that has ever been committed is compromised and needs
rotation, an infra/access action outside the codebase that a code edit alone cannot
resolve. `entropy-fix` never autonomously "fixes" a hardcoded secret.

**Detection:** Search source files for string literals that look like secrets: patterns
matching `sk-[a-zA-Z0-9]{20,}`, `Bearer [a-zA-Z0-9+/]{20,}`,
`password\s*=\s*["'][^"']{8,}`, `api_key\s*=\s*["'][^"']{10,}`,
`token\s*=\s*["'][^"']{10,}`. Also flag any direct assignment of a credential value as a
string literal (e.g. `const token = "ghp_..."`). Skip test files that use obviously fake
values (e.g. `"test-token"`, `"fake-key"`).
**PR-worthy:** true
**HITL:** always

---

## Inconsistent Patterns

### `duplicated_utility`

**Domain:** architecture
**Severity:** medium

Hand-rolled utility functions that duplicate functionality already in a shared lib.
Classification is **per-finding**: obvious when there is a clear drop-in replacement with
matching behavior (→ autonomous); non-obvious when behavior differs or the right
consolidation approach is unclear (→ HITL). No default lean either way.

**Detection:** Look for local implementations of: argument parsing (`parseArgs`, `getArg`,
`required`), Prisma client instantiation (`new PrismaClient()`), JSON read/write helpers,
logger/log wrapper, environment variable loading, MCP JSON-RPC send/ok/err helpers, date
formatting. For each local copy found, check if a canonical implementation exists in
`lib/` or a shared module. Flag any local copy that duplicates a shared lib function.
Report: file, function name, shared lib path.
**PR-worthy:** true
**HITL:** per-finding

---

## Architecture

The architecture domain covers layer relationships and error handling. Only the layering
principle carries a Detection field and is entropy-scannable; the data-layer and
error-handling principles are judgment-only, read by `review`/`plan-session`/`dev-task`
but never mechanically scanned.

> **T4 note:** the legacy testing tenet T4 (real-boundary integration tests) has been
> elevated into this architecture domain — its content lives in the two `data_layer_*`
> entries below. There is intentionally no `t4_*` testing-domain entry.

### `architecture_layering`

**Domain:** architecture
**Severity:** high

Code should flow through three layers: **handler** (transport — HTTP route, CLI command,
message handler) → **service** (business logic) → **data** (a database or an external
client/integration). Each layer may only call the layer directly beneath it: a handler
calls a service, a service calls the data layer; a handler must not reach past the service
into the data layer directly. The principle concerns the *relationship* between layers,
not literal naming — it applies whether a repo calls them handler/service/data or
controller/service/repository, and each repo's own `CLAUDE.md` should declare its concrete
layer names.

Classification is **per-finding** with no default lean: a violation whose fix is a trivial
mechanical move (e.g. pulling a one-line DB call up into an existing service method) routes
autonomously; a violation where no service boundary exists yet, or there are multiple
reasonable ways to restructure, routes to HITL. Entropy exists partly to catch layering
violations in legacy code that predate this principle, not only what `review` catches on
new PRs.

**Detection:** Identify each handler/transport file (an HTTP route handler, a CLI command
entry point, a message/event handler). For each, check whether it directly imports and
calls a database client or ORM (e.g. `new PrismaClient()`, `prisma.<model>.<query>`, a raw
SQL client) or an external-service SDK, without going through a service-layer function
first. Flag any handler that reaches the data layer directly, skipping the service layer.
Match on the layer *relationship* (transport calling data directly), not on specific
directory or file names — a repo may name its layers differently. Report: handler file,
the direct data-layer call, and the service boundary it should route through.
**PR-worthy:** true
**HITL:** per-finding

### `data_layer_own_database`

**Domain:** architecture
**Severity:** high

The data sub-layer that owns your **own** database is tested against a **real test
database** (an integration test) — never mocked. Mocking DB queries is fragile and
low-value; the DB itself is the boundary, not the ORM. This matches existing practice
(`admin`/`task-store` integration tests hit a real Postgres via
`DATABASE_URL_ADMIN_TEST` / `DATABASE_URL_SHIPWRIGHT_TASK_STORE_TEST`, and `ci.yml`
provisions a real `postgres:16` service container). A repo onboarding via test-readiness
must add a real test-DB service container to CI to make this principle enforceable.

Judgment-only — this entry carries no Detection field and is never entropy-scanned.

### `data_layer_external_client`

**Domain:** architecture
**Severity:** high

The data sub-layer that wraps an **external** client or API (a third-party HTTP service,
a payment provider, a calendar API) is tested via **recorded fixture doubles** — a test
double that replays hand-authored fixture JSON — injected through the same
client-interface pattern the production client implements. Keeping the double behind the
client interface means swapping in real recording tooling later is a low-friction change,
not a rewrite. There is no automatic recording tooling; fixtures are hand-authored JSON.

Judgment-only — this entry carries no Detection field and is never entropy-scanned.

### `error_handling`

**Domain:** architecture
**Severity:** medium

Error handling should be typed, layered, and logged once. This is a generic,
cross-language principle:

- **Typed errors for known cases.** Known/expected error conditions get custom/typed
  error classes, not generic exceptions thrown with a bare string.
- **Default to a server error.** Unhandled errors default to a generic server error
  (e.g. HTTP 500) that leaks no internal detail — no stack traces or internal messages in
  the response body.
- **No global catch-all.** Do not wrap everything in a single generic catch that swallows
  every error indiscriminately; catch narrowly, at the layer that can meaningfully handle
  the failure.
- **Swallowed errors are logged.** Any error caught and *not* rethrown is logged at
  minimum `warn` — a silently swallowed error is a silent failure.
- **Typed errors may drive status.** Custom error types may map to an HTTP status code via
  a dedicated middleware/handler mapping layer, keeping status decisions out of business
  logic.
- **Log once, at the top.** Errors are logged once at the top-level global error boundary,
  not re-logged at every layer that rethrows — duplicate log lines for one failure are
  noise.
- **Preserve the cause chain.** When wrapping and rethrowing, attach the original error as
  the cause (e.g. `cause:` / error chaining) so the root failure is not lost.
- **Operational vs. programmer errors.** Distinguish operational errors (expected — a
  network timeout, a bad input — handle them gracefully) from programmer errors (bugs — a
  null dereference, a broken invariant — surface them loudly; do not silently normalize a
  bug into a "handled" state).

Judgment-only — this entry carries no Detection field and is never entropy-scanned.

---

## Testing

The testing domain migrates the legacy T1-T10 tenets. All testing-domain entries are
**judgment-only** (no Detection field): test-readiness's own review mechanism
(`code-reviewer.md` Rule 6, repointed in a later task) consumes them as prose, they are
not entropy-scanned. T4 is intentionally absent — it was elevated into the architecture
domain (see the `data_layer_*` entries above). IDs preserve the original tenet numbering
for readers who know the old scheme.

### `t1_no_global_mocking`

**Domain:** testing
**Severity:** high

Do not use global mocking: `mock.module()`, or overriding `global.fetch`,
`global.console`, or any other global. Bun runs test files in the same process, so leaked
globals break sibling test suites. **Exception:** `global.fetch` mocking is acceptable in
a client *implementation* test that directly wraps `fetch()` (e.g. an
`HttpGoogleAuthClient`). Signals of a violation: `mock.module(`, `global.fetch =`,
`global.console =`, `jest.mock(`.

### `t2_clock_injection`

**Domain:** testing
**Severity:** high

Any code path that references the current time must accept a `Clock` interface rather than
calling `new Date()` or `Date.now()` directly in production code under test. Tests inject a
`FixedClock` to make time deterministic; raw calls make snapshots and time-sensitive
assertions flaky. Signal of a violation: `new Date()` in service/handler code added by a
diff, with no `Clock` parameter.

### `t3_recorded_fixture_pattern`

**Domain:** testing
**Severity:** medium

External service clients (calendar client, Slack client, banking client, etc.) are tested
via **recorded fixture doubles** — test doubles that replay hand-authored fixture JSON from
`tests/fixtures/<service>/*.json` through the client interface — not via `global.fetch`
mocking. Signals of a violation: `global.fetch =` in a client test; a new external client
with no `tests/fixtures/` entry.

### `t5_no_duplicate_coverage`

**Domain:** testing
**Severity:** medium

Each layer tests only what that layer can verify. **Unit tests own business-logic
correctness** — all edge cases, with the layer below mocked. **Integration tests own
wiring/dependency correctness** — does the real DB or client actually behave the way the
unit-test mocks assumed? An integration test should not re-assert business rules already
covered by unit tests. The same code path being touched by both a unit test and an
integration test is *expected*, not a violation, as long as each layer tests a different
concern. The violation is duplicated *assertions* — identical business-rule assertion sets
appearing in both a `*.unit.test.ts` and a `*.integration.test.ts` for the same module.

### `t6_layer_speed_mismatch`

**Domain:** testing
**Severity:** medium

Tests must sit in the correct speed tier. Unit tests must not spawn real DBs or external
processes; integration tests must not mock the DB; canary tests must not exceed the
suite's wall-time budget. Signals of a violation: `DATABASE_URL` access in a
`*.unit.test.ts` file; `mock.module(` in a `*.integration.test.ts` file.

### `t7_canary_safety`

**Domain:** testing
**Severity:** high

A canary-eligible smoke or end-to-end test must be wrapped with the canary-mode helper
(e.g. `runCanaryMode` from `tests/helpers/canary.ts`) and must clean up after itself: any
write operation needs a `try { ... } finally { /* delete */ }` teardown so a canary run
against a live target leaves no residue. Signals of a violation: missing `runCanaryMode`
in a test near `TEST_TARGET_URL`; a write operation with no `finally` cleanup block.

### `t8_file_naming_convention`

**Domain:** testing
**Severity:** medium

Test files must follow the layer-encoding naming convention: `*.unit.test.ts`,
`*.integration.test.ts`, or `*.smoke.test.ts`. Misnamed files may be excluded from the
test run or the coverage report. Signals of a violation: a `*.test.ts` file with no layer
qualifier in a project that uses the three-tier convention; a `*.spec.ts` file in a
project that has standardized on `.test.ts`.

### `t9_new_service_canary_wiring`

**Domain:** testing
**Severity:** high

When a new service with a Prisma schema is added, its `prisma generate` step must be added
to the canary workflow (`.github/workflows/canary.yml`). Omitting it breaks every canary
run because the generated client is not available in CI. Signal of a violation: a new
`prisma/schema.prisma` in a service directory with no corresponding
`bunx prisma generate --schema=<service>/prisma/schema.prisma` in `canary.yml`.

### `t10_untested_critical_logic`

**Domain:** testing
**Severity:** high

Production logic added on a critical path (auth, payment, data mutation, error handling)
must land with a corresponding test in the same PR — no "add tests later." Signals of a
violation: a new handler, service method, or error path added with no `*.test.*` file
touched in the diff; an `onError`/error handler modified with no test coverage added.
