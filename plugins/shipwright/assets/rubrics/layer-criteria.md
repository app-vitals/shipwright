# Layer Criteria Rubric

Maps the six code categories from `code-classifier.md` to the four test layers. Enforces the canonical-layer rule — each functional unit is tested at exactly one layer, the lowest layer that can prove the property.

## The four layers

### Unit

**Proves:** Logic correctness for deterministic inputs/outputs. Branch coverage of pure functions.

**Boundaries:** No process boundaries. No real I/O. Test runs entirely in-process. Mocking external dependencies is acceptable here — the unit *is* the code under test in isolation.

**Default for:** Category 1 (pure business logic).

### Integration

**Proves:** A real boundary works — the DB returns what we expect, the file write actually persists, the internal RPC actually completes. Schema compatibility. Transaction semantics. Idempotency at the boundary.

**Boundaries:** One or more real boundaries. Tests boot the dependency locally (testcontainers, docker-compose, in-memory adapter — never a hosted service). The test asserts behavior *only at the boundary itself* — never re-asserts business rules that are already proved at unit.

**Default for:** Categories 2 (service-boundary code), 4 (error paths involving real failures), 5 (external integrations via recorded fixtures).

### Smoke

**Proves:** The wire contract works. URL + method → status code + response shape. Happy path of each public route. The "is the app booted and routing correctly" check.

**Boundaries:** Full app boot, HTTP entry point hit. Real DB / services running locally. Single-request scope — no multi-step flows.

**Default for:** Category 3 (HTTP routes), happy path only.

### E2E

**Proves:** A multi-step user journey works end-to-end. State persists correctly across steps. The system as a whole delivers the user-visible outcome.

**Boundaries:** Full system booted. Multiple HTTP calls. Often browser-driven (Playwright/Cypress). Always slowest.

**Default for:** Category 6 (user journeys), top-5 only.

## The canonical-layer rule

Every functional unit has **exactly one canonical layer** — the lowest sufficient layer that can prove its key property.

Hierarchy (lowest wins):
```
unit > integration > smoke > E2E
```

**Higher-layer tests are kept ONLY when they prove something a lower layer cannot.** Examples of legitimate higher-layer work:

| Lower layer cannot prove | Belongs at |
|---|---|
| Real DB constraint behavior under concurrent writes | Integration |
| HTTP status codes for the public route | Smoke |
| Multi-step state spanning HTTP requests | E2E |
| Real third-party API response shape | Integration (recorded fixture) |
| Auth/session middleware actually attaches user | Smoke |

**Illegitimate higher-layer assertions (= trim in Phase 3):**

| If a unit test already proves | Then this assertion in the higher test is redundant |
|---|---|
| Refund calculation for edge cases | The specific assertion in an E2E that checks the refund *amount* (keep the E2E — it still proves the user journey) |
| Email format validation | The format re-check in an integration test after a DB round-trip (keep the integration — it still proves the boundary) |
| Pricing rule decisions | The pricing body check in a smoke test (keep the smoke — it still proves the route) |

The redundant assertion still passes — that's the problem. Assertions at the wrong layer create false confidence. But the *test* is not redundant — trim the assertion, not the test. Check git history first: if the assertion was added after a production outage, it documents a seam failure and should be kept.

## Layer prescription matrix

| Category | Canonical layer | Higher-layer responsibility (if any) |
|---|---|---|
| 1. Pure business logic | **Unit** | None — never re-asserted at higher layers |
| 2. Service-boundary code | **Integration** | None — unit tests cannot prove real-boundary behavior |
| 3. HTTP route | **Smoke** (contract) | E2E only if the route is part of a top-5 journey |
| 4. Error path (logic-only) | **Unit** | None |
| 4. Error path (involving real boundary) | **Integration** | None |
| 5. External integration | **Integration (recorded fixture)** | None |
| 6. User journey | **E2E** | A subset of these journeys are canary-eligible |

## Canary eligibility (additive flag)

A test is canary-eligible iff:
- Layer ∈ {smoke, E2E}
- Criticality ∈ {critical, high}
- Read-only OR self-cleaning per `canary-execution` skill

Canary is not a layer — it's a tag on smoke/E2E tests that also run against a deployed env.

## Speed budget alignment

The canonical layer for a piece of code is also chosen with speed in mind. Per the `speed-budgets` skill:

- A test that requires <50ms execution → must be unit
- A test that requires <2s and a real boundary → must be integration
- A test that requires <5s and the wire contract → smoke
- A test up to <30s for a multi-step journey → E2E

If a "unit" test cannot meet the unit hard cap (200ms), it is at the wrong layer. Reassign to integration in the inventory.
