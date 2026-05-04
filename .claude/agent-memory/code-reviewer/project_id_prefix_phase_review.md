---
name: ID-prefix consistency phase review
description: Key findings and patterns from the 7-field DynamoDB ID-prefix consistency review (2026-04-30)
type: project
---

This phase aligned 7 DynamoDB fields to use prefixed IDs (CHAT_SESSION#, A#, C#, G#) consistently with the ecommerce-side DB schema.

**Why:** Cross-app DynamoDB consistency — ecommerce side uses prefixes everywhere; API side was storing bare ULIDs.

**How to apply:** Future field alignment work should follow the same defensive normalization pattern (startsWith guard → strip on read, prefix on write). All prefix strips must be defensive (handle both bare and prefixed values during transition window).

Key patterns established in this phase:
- Double-prefix prevention guards: `startsWith(prefix) ? value : prefix + value` on the read path in `chat-session.service.ts` (account_id) and `customer.service.ts` (latest_session_id)
- SK construction divergence in `preview-cart.tool.ts`: hasBothIds branch concatenates already-prefixed values; !hasBothIds branch adds explicit prefixes to fresh ULIDs. Both branches verified correct.
- `EmailReplyRecord.sessionUlid` → renamed to `sessionId` (field rename + value prefix, write-only field).
- The `GATE_OPEN_METADATA` test constant in `chat-session.service.spec.ts` uses a bare PRIOR_SESSION_ULID in continuation_from_session_id — this is the "legacy bare" case. A separate test uses the prefixed form to verify the double-prefix guard.
- Pre-existing Crockford-invalid test constants (containing I/O) are intentionally out of scope for this phase.
