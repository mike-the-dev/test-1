---
name: SMS channel phase review findings
description: Code review of SMS/Twilio channel integration — architecture, correctness, and style findings
type: project
---

SMS channel integration reviewed 2026-05-06. All 7 architectural commitments honored.

SHOULD-FIX items found:
1. `sms.service.ts` line 44: `const sdkError: SmsTwilioSdkError = error` is an inline type annotation on a const — prohibited by project style. Fix: use `(error as unknown as SmsTwilioSdkError)` or restructure to access properties via `(error as SmsTwilioSdkError)` or use `satisfies`.
2. `sms-reply.service.ts`: dedupe record `sessionId` field stays `null` forever — never updated with actual session ULID after routing. The plan (lines 313, 329, 337) says to update it for traceability. Functional correctness is unaffected (dedupe PK is what matters), but the record is less debuggable.
3. `twilio-webhook.controller.ts` line 35: double-slash risk if `PUBLIC_WEBHOOK_URL` is configured with a trailing slash (`"https://api.example.com/"` → `"https://api.example.com//webhooks/twilio/inbound"`). Recommend trimming trailing slash in `TwilioConfigService.publicWebhookUrl` getter.

NIT:
- `SmsReplyRecord.sessionId` field name matches `EmailReplyRecord` (intentional) but diverges from the project-wide `sessionUlid` naming convention. Consistent with the email pattern; acceptable.

**Why:** Documenting for close-out agent awareness.
**How to apply:** If a close-out agent is dispatched, these are the items to fix.
