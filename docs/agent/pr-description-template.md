# PR Description Templates

Use these templates for consistent, reviewer-friendly PR descriptions.

## Standard Template

## Summary
- <what changed and why, 2-5 bullets>

## Files Touched
- <path> (<short why>)

## Testing
- <command(s) run or "not run (reason)">

## Notes (optional)
- <risk, migration, or follow-up>

## Pact Provider Template

## Summary
- <what changed and why>

## Contracts Verified
- <interaction(s) currently verified from broker>

## Provider Readiness (when new contracts are published)
- <endpoint 1>
- <endpoint 2>

## Why This Is Sufficient For Contract Verification
- <why the provider wiring/mocks/state handlers are enough>

## Files Touched
- <path> (<short why>)

## Testing
- npm run test:pact
