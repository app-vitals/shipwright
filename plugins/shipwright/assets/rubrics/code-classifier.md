# Code Classifier Rubric

Used by the `test-inventory` skill to classify every meaningful unit of code into one of six categories. The category drives the layer prescription (see `layer-criteria.md`).

## The six categories

### 1. Pure business logic

**Signal:** Deterministic. No I/O. No global state mutation. Inputs → outputs.

**Examples:**
- Calculators, validators, parsers, formatters
- Domain rules (e.g., "is this booking refundable?")
- Pure transformations (`map`, `reduce`, format conversions)
- Type guards, schema validators

**How to recognize:**
- No `await` on a network/DB call inside the function
- No `import { db } from ...` or equivalent
- Function signature: `(input) => output` with no side-effect parameters

### 2. Service-boundary code

**Signal:** Crosses a process boundary. Talks to a DB, file system, queue, internal HTTP service, or similar.

**Examples:**
- Repository / DAO methods
- Service clients that wrap internal HTTP calls
- Message queue producers/consumers
- File I/O wrappers

**How to recognize:**
- Imports the DB client / ORM / file system / HTTP client
- Uses `await` for I/O
- Has a "side effect" by design

### 3. HTTP route / public API surface

**Signal:** Maps a URL + method to a handler. Owns the wire contract (status codes, response shape, error format).

**Examples:**
- Express / Hono / FastAPI / Rails routes
- gRPC handlers
- Webhook receivers
- Public-facing API endpoints

**How to recognize:**
- Registered in a router
- Returns/sends an HTTP response
- Often thin — orchestrates calls to business logic + service code

### 4. Error / failure-path code

**Signal:** Handles the unhappy path — retries, timeouts, fallbacks, error normalization.

**Examples:**
- Retry wrappers
- Circuit breakers
- Error-to-HTTP-status mappers
- Compensating actions / rollbacks

**How to recognize:**
- Catches exceptions
- Tries multiple strategies
- Often has subtle state (retry counts, backoff timers)

### 5. External integration

**Signal:** Talks to a third-party service we do not control.

**Examples:**
- Payment processor clients (Stripe, etc.)
- OAuth / SSO providers
- Email/SMS senders (Sendgrid, Twilio)
- LLM / AI provider clients

**How to recognize:**
- Imports a third-party SDK
- Calls a URL outside our infrastructure
- Often has a corresponding webhook receiver in category 3

### 6. User journey

**Signal:** A multi-step flow across the system. Not a single unit — a sequence.

**Examples:**
- "Sign up → verify email → complete profile → first action"
- "Add to cart → checkout → payment → confirmation email"
- "Submit support ticket → assignment → reply → resolution"

**How to recognize:**
- Not a single function or file — a *flow* spanning multiple categories
- Identified at the product level (PM/design specs), not the code level
- Usually 3+ user interactions or 5+ backend calls

## Ambiguity rules

When a piece of code straddles categories:

- **Business logic with one I/O call** → if the I/O is the *primary purpose*, it's category 2; if I/O is incidental (e.g., a log call), it's category 1.
- **Thin route handler doing real work** → split mentally: the route itself is category 3 (test as smoke), the work it does is category 1 or 2 (test at canonical layer).
- **Wrapped third-party call** → category 5 for the wrapper, but the *business decision* using the result is category 1.

When in doubt, list the item in the "Ambiguous" section of the inventory with a question for the reviewer.

## What this rubric is NOT

- It is not a coverage scorecard. Don't compute percentages of categories.
- It is not a file-organization guide. Don't suggest restructuring directories.
- It is not a code-quality assessment. A poorly written category-1 function is still category 1.
