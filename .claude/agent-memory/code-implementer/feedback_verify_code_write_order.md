---
name: verify_code Write A/B capture order
description: continuation_from_session_id must be captured from queryCustomerIdByEmail BEFORE Write B overwrites customer.latest_session_id
type: feedback
---

In `verify-code.tool.ts`, Write A (METADATA update) and Write B (Customer update) must fire in this order:
1. `queryCustomerIdByEmail` — captures `latestSessionId` (the PRIOR session ULID before this one)
2. Write A — writes `customer_id` AND `continuation_from_session_id = latestSessionId` atomically into METADATA
3. Write B — writes `latest_session_id = sessionUlid` on the Customer record (overwrites prior session pointer)

**Why:** If Write B fires first, `customer.latest_session_id` is updated to the CURRENT session — permanently losing the prior session pointer. The loader in `chat-session.service.ts` then has nothing to load from.

**How to apply:** When reviewing or modifying `verify-code.tool.ts`, always verify the query-then-Write-A-then-Write-B sequence is preserved. Any reordering silently breaks continuation.
