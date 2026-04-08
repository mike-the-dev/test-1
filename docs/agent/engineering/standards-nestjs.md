# NestJS Engineering Addendum

These standards extend the global engineering standards for NestJS repositories.

## Style Exceptions
- Single-line `if` statements may omit braces (example: `if (ok) return;`).

## Framework Exceptions
- NestJS framework-required classes (controllers, providers, guards, interceptors, pipes, filters) may use class syntax where required by the framework.

## Function Signatures (Docblocks)
- For HTTP endpoints, include `@endpoint` with the route path and a brief request summary in the description.

## Architecture
- Keep controllers limited to HTTP concerns (routing, guards, pipes, interceptors) and delegate to services.
- Keep business logic and multi-step orchestration in services, using guard clauses to fail fast on missing identifiers.
- Use shared data-access utilities in `src/utils/**` when present; avoid introducing a separate repository layer.
- For DynamoDB access, use shared utilities and avoid direct AWS SDK calls in controllers.

## Naming and Structure
- When the repo uses `src/controllers` and `src/services`, keep controller/service naming paired (`<Feature>Controller` with `<Feature>Service`).
- Prefer explicit `/api/...` route namespaces when the service exposes HTTP endpoints.
- Use decorators/guards to inject account or domain context instead of manual extraction inside services.

## Validation Patterns
- Use Zod schemas for request validation in new pipes.
- Prefer `safeParse` and map issues into a field error map, keeping the first error per field.
- Keep validation schemas in `src/validation/` and name them `<feature>.schema.ts`.
- Apply guards/pipes/interceptors at the controller boundary for auth/domain checks and input validation; keep services free of HTTP concerns.

## Error Handling
- In services, catch errors to log context and report to Sentry when configured, then rethrow.
- Use Nest HTTP exceptions for expected error states (for example, `NotFoundException`, `BadRequestException`).

## Logging Style
- Log messages should be inline (no temp variables) and follow the `[key: value]` bracket pattern.
- Error logs should follow the same bracket pattern: `Failed to <action> [key: value]`, passing `error.stack` as the second argument.
- Log start/success/failure with key identifiers in services.
- Use `warn` or `debug` for non-fatal branches.
- Avoid logging sensitive payloads.

## Webhooks
- For Stripe webhooks, accept `RawBodyRequest<Request>` to preserve the raw payload for signature verification and delegate processing to services.

## File Uploads
- Handle multipart uploads with Nest interceptors and validate files/payloads at the controller boundary before delegating.

## Types Organization
- When adding request/response or domain types, extend the existing domain type file (e.g., `src/types/Order.ts`, `src/types/Scheduler.ts`) instead of creating new type modules unless none exist yet.
- Define storage shapes and DTOs in `src/types/**` and convert via dedicated mappers instead of mapping in controllers.

## Testing Expectations
- Unit tests must be colocated with the code under test (same folder), using `*.spec.ts`.
- Keep integration/e2e tests in `test/` only.
- Contract (Pact) tests must follow the repo's Pact structure.
- Use `Test.createTestingModule` with `supertest` for HTTP/e2e coverage.

## Contract Test Standards (Pact)
- Provider tests live in `test/pact/providers/` and are named `*.provider.pact.spec.ts`.
- State handlers live in `test/pact/state-handlers/`.
- Shared helpers live in `test/pact/helpers/`.
- Mocks and fixtures live in `test/pact/mocks/` and `test/pact/fixtures/`.
- Use `startPactApp` to boot the Nest app and `createPactVerifier` to verify contracts.
- Provider state handlers must be wired into the verifier.
- Use stable mocks/fixtures from `test/pact/mocks/` and `test/pact/fixtures/` instead of inline constants when possible.
- Use `beforeAll` to boot the app and `afterAll` to close it; avoid per-test app startups.
- If contracts require auth, generate tokens using the shared helper in `test/pact/helpers/`.
