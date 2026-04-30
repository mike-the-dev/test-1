---
name: Phase CCI-3 email-inbound continuation — codebase findings
description: Key findings from planning Phase CCI-3 dispatcher; email-reply service structure, accountUlid gap, and IDENTITY record re-use risk
type: project
---

Email-reply path is single-tenant today: `SENDGRID_REPLY_DOMAIN` is one global env var. `processInboundReply` never resolves an `accountUlid` — it routes entirely on the ULID local-part and looks up USER_CONTACT_INFO by session PK. For Case 2/3 (`assistant@`) a new env var `SENDGRID_REPLY_ACCOUNT_ULID` must be added via `SendGridConfigService.replyAccountUlid`.

`UpdateCommand` is NOT currently imported in `email-reply.service.ts` — only `GetCommand` and `PutCommand` are. Must add it.

`IdentityService.lookupOrCreateSession` always initialises `customer_id`, `continuation_from_session_id`, `continuation_loaded_at` to null via `if_not_exists`. No way to pass these at creation. Case 3 stale requires a separate follow-up UpdateCommand immediately after creation to set all three fields atomically (before `handleMessage` fires).

IDENTITY externalId for email-inbound sessions = sender's email address (lowercased). IDENTITY PK = `IDENTITY#email#<senderEmail>`. Risk: second stale entry from same sender returns existing session rather than creating a new one (`lookupOrCreateSession` is idempotent on PK). V1 limitation; document with a warning log on `wasCreated === false` in Case 3 stale.

Existing test `"returns 'rejected_malformed' when local-part is not a 26-char ULID"` uses `"notaulid"` → after Phase 3, UNRECOGNIZED branch still returns `"rejected_malformed"` (same string). Test passes unchanged.

The `processInboundReply` `to` field parsing loop (lines 81–103) already handles multiple recipients by picking the first address matching `replyDomain`. Phase 3 inherits this unchanged.

**Why:** Forms the basis for dispatching all 5-step sub-agent CCI-3 planning. **How to apply:** when reviewing or extending the email-inbound path, understand that per-merchant accountUlid routing is a v2 concern.
