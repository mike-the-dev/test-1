# Global Engineering Standards (Instapaytient)

These standards apply across Instapaytient repositories unless a repo explicitly documents an exception.

## Function Style
- Use arrow functions for all new functions (including helpers and callbacks).
- Avoid function declarations and `function` expressions unless required by a framework or API.

## Semicolons
- Semicolons are mandatory wherever optional.

## Single-Line If Statements
- If an `if` block has only one statement, it must be a single line with no braces.
- Example: `if (ok) return;`

## Async Flow
- Use `async/await` with `try/catch/finally` for async control flow.
- Do not use Promise chaining (`.then`, `.catch`, `.finally`).

## Change Scope
- Follow existing patterns and naming; avoid unrelated refactors.
- Do not add new dependencies unless explicitly requested or approved.
- When uncertain about scope or patterns, ask first and mirror existing implementations.

## Function Responsibility
- Keep functions single-purpose. If a function does more than one distinct job, split it.

## Parameter Naming
- All function, arrow function, callback, and method parameters must use full descriptive names.
- Never use single letters (`a`, `b`, `x`) or vague abbreviations (`res`, `val`, `obj`).
- The name must make the parameter's purpose immediately obvious without needing to trace context.
- Examples: `(a, b) => a + b` → `(subtotal, taxAmount) => subtotal + taxAmount` | `(res) => res.data` → `(response) => response.data`

## Defensive Programming
- Validate and normalize at system boundaries (controllers, handlers, external APIs, DB adapters).
- In core/domain logic, prefer explicit guards and early throws over silent type coercion.
- Avoid defensive `Array()`/fallback coercion inside core logic unless explicitly needed for an adapter.

## Framework Exceptions
- Framework-required classes or patterns may use class syntax where required.

## Function Signatures (Docblocks)
- Public or route-handling functions must include a standardized JSDoc block.
- Required tags: `@author`, `@editor`, `@lastUpdated` (YYYY-MM-DD), `@name`, `@description`, `@param`, `@returns`.
- Use the fixed signature for both `@author` and `@editor`: `mike-the-dev (Michael Camacho)`.
- For HTTP endpoints, also include: `@endpoint` with the route path and a brief request summary in the description.

## Testing Expectations
- New logic or branches require a unit test unless explicitly out of scope.
- Unit tests must be colocated with the code under test (same folder), using the repo's naming convention.
- Keep integration/e2e tests in `test/` only when the repo uses that layout.
- Contract (Pact) tests must write contracts to the repo's configured Pact output and follow its Pact/Jest config.

## Unit Test Structure (Jest)
- Use `describe` blocks for the unit under test and for each method or behavior.
- Use `it` blocks for single expectations/behaviors; do not use `test` (use `it` consistently).
- Prefer `beforeEach`/`afterEach` for test isolation; use `beforeAll`/`afterAll` only for expensive shared setup/teardown.
- Use Arrange -> Act -> Assert structure within each `it` block.
- Use `jest.fn()` for local fakes, `jest.spyOn()` for method spies, and `jest.mock()` for module mocks.
- Reset/restore mocks in `afterEach` (`jest.clearAllMocks()` or `jest.restoreAllMocks()` as appropriate).
- Avoid shared mutable state between tests.
- Keep assertions explicit with `expect(...)` (avoid implicit truthy checks when precise matchers exist).
- Limit nesting to at most two `describe` levels (unit -> method/behavior). No deep nesting.
- Name `describe` blocks after the unit/method and `it` blocks as plain-English behaviors (e.g., "returns 404 when ...").
- Keep each `it` focused on a single behavior; avoid multi-scenario `it` blocks.
- Avoid `expect.anything()` unless there is no more precise matcher available.
- For async tests, use `expect.assertions(<count>)` to ensure assertions run.

## Contract Test Standards (Pact)
- Use shared Pact helpers/config when present (for example, `jest.pact.config.js`).
- Use `beforeAll` to set up Pact and `afterAll` to tear it down; avoid per-test Pact setup.
