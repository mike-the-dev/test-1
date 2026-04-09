---
name: Test Setup
description: How tests are run and what to expect in this NestJS project
type: project
---

Test command: `npm test -- --forceExit` (plain `npm test` works too; `--forceExit` suppresses the open handles warning).

**Why:** NestJS bootstraps async infrastructure (e.g., ConfigModule, providers) that can keep Jest open; `--forceExit` avoids the hang.

**How to apply:** Always pass `--forceExit` when running the full suite to get a clean exit. If the open-handles warning appears without it, note it but don't treat it as a failure.

As of 2026-04-08 (post-Phase-3-AgentRegistry): 5 test suites, 40 tests total. Phase 3 added AgentRegistryService and LeadCaptureAgent. The ChatSessionService spec was updated to include an AgentRegistryService mock and a GetCommand stub for session metadata resolution. The IdentityService spec was updated with a third `defaultAgentName` parameter on all `lookupOrCreateSession` calls. ERROR-level log output in test runs is expected — tests for SaveUserFactTool and ToolRegistryService intentionally exercise error paths (DynamoDB failure, unexpected tool crash) and the NestJS Logger emits them to stderr. These are not test failures. All 40 tests pass cleanly.
