---
name: CCI Phase 3 review findings
description: Key findings from the CCI Phase 3 email-inbound continuation code review — dedup record sessionUlid placeholder, isConditionalCheckFailed scope, all invariants passed
type: project
---

deduplicateInboundEmail helper stores the string literal "assistant-entry" in the EmailReplyRecord.sessionUlid field when called from handleAssistantEntry. The session ULID doesn't exist yet at dedup time. This is a SHOULD FIX — the field is semantically misleading for operational debugging.

isConditionalCheckFailed in identity.service.ts (lines 17-25) still uses the old unsafe type-cast pattern (error as { name?: unknown }). The style refactor Round 2 only fixed the NEW copy of this function in email-reply.service.ts. The identity.service.ts function is pre-existing and was not in scope to fix in Phase 3.

All critical invariants (ULID regex correctness, Case 1 preserved, Case 3-stale atomicity, captured prior latestSessionId not re-fetched, no PII in logs, no Slack alerts, no IDENTITY writes) confirmed passing.

**Why:** Pattern to remember for future phases — deduplication records must store something meaningful in the sessionUlid field even when the session hasn't been created yet at dedup time.

**How to apply:** When reviewing dedup/idempotency patterns in email-reply.service.ts, check that the sessionUlid field in EMAIL_INBOUND records is either a real ULID or explicitly typed to allow sentinel values.
