---
name: Test Setup
description: How tests are run and what to expect in this NestJS project
type: project
---

Test command: `npm test -- --forceExit` (plain `npm test` works too; `--forceExit` suppresses the open handles warning).

**Why:** NestJS bootstraps async infrastructure (e.g., ConfigModule, providers) that can keep Jest open; `--forceExit` avoids the hang.

**How to apply:** Always pass `--forceExit` when running the full suite to get a clean exit. If the open-handles warning appears without it, note it but don't treat it as a failure.

As of 2026-04-14 (post-M2-create-guest-cart): 12 suites, 139 tests total (138 passed, 1 failed). ERROR-level log output in test runs is expected — tests for SaveUserFactTool, ToolRegistryService, OriginAllowlistService, and CreateGuestCartTool intentionally exercise error paths and the NestJS Logger emits them to stderr. These are not test failures.

M1 baseline (before M2): 11 suites, 114 tests passing.
M2 added: create-guest-cart.tool.spec.ts (new suite, 24 cases); list-services.tool.spec.ts and shopping-assistant.agent.spec.ts updated.

Known failure at end of M2 step 4 (1 test — implementation bug):
1. `src/tools/create-guest-cart.tool.spec.ts > 5. New visitor — GSI returns zero; customer PutCommand issued with condition > issues customer put with attribute_not_exists(PK) and correct record shape`
   Root cause: source code uses the CART ULID (3rd ulid() call) instead of the CUSTOMER ULID (1st call) when building PK/SK for the customer PutCommand. Expected `C#01CUSTOMERULID0000000000000`, received `C#01CARTULID0000000000000000`. The ulid mock sequence is: customer (1st), guest (2nd), cart (3rd) — the implementation is pulling index 2 instead of index 0.
