---
name: Test Setup
description: How tests are run and what to expect in this NestJS project
type: project
---

Test command: `npm test -- --forceExit` (plain `npm test` works too; `--forceExit` suppresses the open handles warning).

**Why:** NestJS bootstraps async infrastructure (e.g., ConfigModule, providers) that can keep Jest open; `--forceExit` avoids the hang.

**How to apply:** Always pass `--forceExit` when running the full suite to get a clean exit. If the open-handles warning appears without it, note it but don't treat it as a failure.

As of 2026-04-14 (post-Phase-4-M0-WebChat): 9 test suites, 80 tests total. Phase 4 added WebChatController and OriginAllowlistService with specs. ERROR-level log output in test runs is expected — tests for SaveUserFactTool, ToolRegistryService, and OriginAllowlistService intentionally exercise error paths and the NestJS Logger emits them to stderr. These are not test failures.

Known failures at end of M0 step 4 (3 tests, 2 suites — implementation bugs, not environment issues):
1. `src/controllers/web-chat.controller.spec.ts` — 2 failing: "throws BadRequestException for invalid guestUlid shape (pipe)" and "throws BadRequestException for empty message (pipe)". Root cause: `ZodValidationPipe` at `src/pipes/webChatValidation.pipe.ts:11` accesses `result.error.errors[0]` but `result.error` is undefined when Zod returns a flat error shape — `?.` on `.errors[0]` doesn't protect against `result.error` itself being undefined.
2. `src/services/origin-allowlist.service.spec.ts` — 1 failing: "returns false and does NOT write to cache when DynamoDB throws". Root cause: `isAllowed()` makes 2 DynamoDB calls when it should make 1 — the DynamoDB error path does not short-circuit before a second query call fires.
