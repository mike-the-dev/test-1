---
name: Multi-tenant channel routing phase review
description: Review findings for the multi-tenant channel routing phase — ChannelAddressService, email/SMS per-account lookup, env-var removal
type: project
---

SHIPPED — all three should-fix items resolved in close-out; close-out review passed clean (2026-05-06).

**Why:** Phase replaces six single-tenant env vars with dynamic per-account channel config via new ChannelAddressService. All architectural commitments honored.

**Close-out resolutions:**
1. SF-1 (inline const annotation): Replaced with module-level type predicate `isTransactionCanceledError(value): value is AccountChannelTransactionCanceledError`. Old `isTransactionCanceledException` boolean helper removed. Type predicate used at all call sites including `getTransactionCancellationReasons`.
2. SF-2 (hardcoded array[0]): GetItem-then-TransactWrite implemented. Phase 1 reads account record and calls `indexOf` to find real index. Phase 2 REMOVE uses computed index; ExpressionAttributeNames conditionally excludes `#channel`/`#addressArray` when no REMOVE. Non-atomicity trade-off documented in JSDoc. 4 new tests added.
3. SF-3 (dead UNRECOGNIZED enum value): Removed from `EmailReplyLocalPartClassification`.
4. SF-4 (bad_pk branch test, out-of-scope for close-out): Still no test for the bad_pk guard path — carry forward for future review.

**How to apply:** Flag these patterns in future reviews of this codebase.
