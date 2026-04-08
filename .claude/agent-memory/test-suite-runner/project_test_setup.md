---
name: Test Setup
description: How tests are run and what to expect in this NestJS project
type: project
---

Test command: `npm test -- --forceExit` (plain `npm test` works too; `--forceExit` suppresses the open handles warning).

**Why:** NestJS bootstraps async infrastructure (e.g., ConfigModule, providers) that can keep Jest open; `--forceExit` avoids the hang.

**How to apply:** Always pass `--forceExit` when running the full suite to get a clean exit. If the open-handles warning appears without it, note it but don't treat it as a failure.

As of 2026-04-07 (post-refactor): 3 test suites, 14 tests total. Refactor introduced channel-agnostic chat-session.service.ts, identity.service.ts, renamed IdentityRecord → ChatSessionIdentityRecord, and removed `as` casts in favor of variable type annotations. All 14 tests passed cleanly after this refactor.
