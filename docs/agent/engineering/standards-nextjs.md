# Next.js Engineering Addendum

These standards extend the global engineering standards for Next.js repositories.

## Architecture References
- Feature folder architecture: `docs/agent/architecture/feature-folder-architecture.md`

## Defensive Programming
- Validate and normalize at system boundaries (API routes, server actions, external APIs, data loaders).

## Testing Expectations
- Unit tests must be colocated with the code under test (same folder), using `*.test.ts` or `*.test.tsx`.
- Keep integration/e2e tests in `test/` only.
- Contract (Pact) tests must write contracts to `pact/` and follow the repo's Pact/Jest configuration.

## Contract Test Standards (Pact)
- Consumer tests live alongside the feature/module under test.
- Store pact artifacts in `pact/`.
