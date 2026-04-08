---
name: Test Setup
description: How tests are run and what to expect in this NestJS project
type: project
---

Test command: `npm test -- --forceExit` (plain `npm test` works too; `--forceExit` suppresses the open handles warning).

**Why:** NestJS bootstraps async infrastructure (e.g., ConfigModule, providers) that can keep Jest open; `--forceExit` avoids the hang.

**How to apply:** Always pass `--forceExit` when running the full suite to get a clean exit. If the open-handles warning appears without it, note it but don't treat it as a failure.

As of 2026-04-08 (post-Phase-1-tool-use): 5 test suites, 38 tests total. New suites added for SaveUserFactTool and ToolRegistryService. ERROR-level log output in test runs is expected — tests for SaveUserFactTool and ToolRegistryService intentionally exercise error paths (DynamoDB failure, unexpected tool crash) and the NestJS Logger emits them to stderr. These are not test failures. All 38 tests pass cleanly.
