---
name: Test Setup
description: How tests are run and what to expect in this NestJS project
type: project
---

Test command: `npm test -- --forceExit` (plain `npm test` works too; `--forceExit` suppresses the open handles warning).

**Why:** NestJS bootstraps async infrastructure (e.g., ConfigModule, providers) that can keep Jest open; `--forceExit` avoids the hang.

**How to apply:** Always pass `--forceExit` when running the full suite to get a clean exit. If the open-handles warning appears without it, note it but don't treat it as a failure.

As of 2026-04-27 (post-Phase-8c InternalApiKeyGuard + style-refactor): 29 suites, 459 tests total, 459 passed, 0 failed. Build clean (nest build, no errors, no output). ERROR-level log output in test runs is expected — tests for SaveUserFactTool, ToolRegistryService, OriginAllowlistService, CreateGuestCartTool, KnowledgeBaseIngestionService, KnowledgeBaseController, LookupKnowledgeBaseTool, and others intentionally exercise error paths and the NestJS Logger emits them to stderr. These are not test failures.

Prior baselines:
- M1: 11 suites, 114 tests passing.
- M2 (post-create-guest-cart): 12 suites, 139 tests (138 passed, 1 failed — create-guest-cart ULID index bug).
- KB Phase 4 Step 2: 288 tests passing (21 suites).
- KB Phase 4 Step 3 (style-refactor): 288 tests passing (21 suites), 0 failures, build clean.
- Phase 8a Steps 1-3 (Sentry integration + style-refactor): 409 tests passing (25 suites), 0 failures, build clean.
- Phase 8c (InternalApiKeyGuard + style-refactor, commit 8bf3fb01 + uncommitted style edits): 459 tests passing (29 suites), 0 failures, build clean. Time: ~1.85 s.
- Phase 8c SHOULD-FIX close-out (uncommitted edits: internal-api-key.guard.ts ternary + comment restore, instrument.ts PII_KEYS addition, sentry.service.spec.ts breadcrumb scrub test): 460 tests passing (29 suites), 0 failures, build clean. Time: ~1.887 s.
