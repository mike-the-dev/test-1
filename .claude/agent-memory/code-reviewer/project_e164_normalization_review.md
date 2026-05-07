---
name: E.164 phone normalization review
description: Review findings from the E.164 phone normalization phase (collect_contact_info tool, libphonenumber-js/min, Zod transform)
type: project
---

E.164 phone normalization shipped via Zod schema transform in `collectContactInfoInputSchema`. Normalization is isolated to `src/utils/phone/normalizeToE164.ts` using `parsePhoneNumberFromString` from `libphonenumber-js/min` (default region US). All `PHONE#` key construction paths in `customer.service.ts` are safe: only two callsites exist (lines 111 and 184), both are pass-throughs that trust callers to supply E.164. The SMS inbound path already enforces E.164 at intake (E164_REGEX guard in sms-reply.service.ts line 84), so cross-channel divergence is fully closed by this change.

**Why:** Cross-channel identity bug where LLM-supplied raw phones never matched Twilio E.164 GSI2 keys, creating duplicate customer records. Now critical to verify no un-normalized phone ever reaches `lookupOrCreateCustomer`.

**Known test failure:** Case 10 (`"555-0100"` — 7-digit number, not normalizable) now returns `isError: true` because the refine guard fires when the only field (phone) is dropped to undefined. Fix: change fixture to `"5555550100"` or add a second field.

**How to apply:** If reviewing future phases that touch phone storage, confirm all inputs flow through the Zod schema transform or explicitly through `normalizeToE164` before reaching any DDB write or GSI2 key construction.
