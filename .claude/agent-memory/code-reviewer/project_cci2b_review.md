---
name: CCI Phase 2b review findings
description: Key findings from code review of Phase CCI-2b — prior-history loader, verify_code modification, agent prompt updates
type: project
---

All MUST FIX invariants passed cleanly in CCI-2b. One significant behavioral concern found:

**loader_not_found behavior vs. plan**: When customerResult.Item is undefined (Customer record missing), the plan says to skip the loader entirely and NOT set continuation_loaded_at. The implementation does set continuation_loaded_at in that case (the flag write is outside the `if (customerResult.Item)` block). This means on a missing Customer record, the loader marks itself as "done" and never retries. Plan said "skip, retry next turn". Flagged as SHOULD FIX.

**Test 10 mismatch**: Test 10 asserts `continuation_loaded_at` is NOT set when the loader fails (GetCommand throws). But GetCommand throwing is caught by the outer try/catch, which skips the flag write. The "customer not found" case (no throw, just undefined Item) goes through the inner path and DOES set the flag. Test 10 tests the throw path — correctly matches implementation. The missing test is the no-throw/customer-not-found path.

All review checklist items passed:
- BARE ULID in continuation_from_session_id: confirmed
- Write A atomicity: confirmed (customer_id + continuation_from_session_id in one UpdateCommand)
- Prior latestSessionId captured BEFORE Write B: confirmed
- Null propagation (no prior session): confirmed
- lookupOrCreateCustomer callers unaffected: confirmed (collect-contact-info calls lookupOrCreateCustomer only)
- Both gate conditions checked: confirmed
- dynamicSystemContext lifted out of while loop: confirmed
- Profile+framing in dynamicSystemContext (not messages): confirmed
- Prior messages prepended chronological: confirmed
- continuation_loaded_at uses if_not_exists: confirmed
- RETURNING VISITOR FLOW in both agents, verbatim: confirmed
- No PII in logs: confirmed
- No Slack alerts: confirmed
- Option-A C# normalization unchanged: confirmed
- anthropic.service.ts unchanged: confirmed
