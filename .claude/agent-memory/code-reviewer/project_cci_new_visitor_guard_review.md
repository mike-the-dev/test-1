---
name: New Visitor Guard + collect_contact_info field rename review
description: Review findings for the verification-code tool guard, collect_contact_info isReturningVisitor rename, and agent prompt tightening phase
type: project
---

Phase implemented defense-in-depth against LLM hallucinating "Welcome back!" for new visitors. Guard lives in request-verification-code.tool.ts as Step 2.5, between rate-limit (Step 2) and code generation (Step 3).

**Approved with one SHOULD-FIX:** Test 5 in request-verification-code.tool.spec.ts (email send failure path) is missing METADATA and customer GetCommand mocks. The guard's METADATA-missing branch triggers first and returns `send_failed` — correct result shape but wrong execution path. Email send rejection is never exercised.

**CUSTOMER_ULID in request-verification-code.tool.spec.ts:** `01ARZ3NDEKTSV4RRFFQ69G5FAV` — valid 26-char Crockford ULID (no I/L/O/U). The new fixture constant is correct; the pre-existing ones in collect-contact-info.tool.spec.ts (CUSTOMER_ULID, SESSION_ULID, ACCOUNT_ULID) retain invalid chars but were pre-existing and out of scope.

**Guard ordering confirmed correct:** Step 1 (no_email_in_session) → Step 2 (rate_limited) → Step 2.5 (no_existing_customer_to_verify). Session-with-no-email-but-new-customer hits the pre-guard exit.

**Edge case noted (theoretical only):** If METADATA exists but lacks `_createdAt_`, `String(undefined)` = `"undefined"`, and `new Date("undefined")` is `NaN`. The >= comparison returns false (NaN comparison), silently passing the guard. Not a realistic production scenario since all code paths stamp `_createdAt_`.

**Type cleanup confirmed clean:** CollectContactInfoTrioCompletedResult fully removed; new `no_existing_customer_to_verify` arm properly in VerificationRequestCodeResult union; all `satisfies VerificationRequestCodeResult` on new return statements.

**Why:** The bug was observed in live Playwright testing — LLM hallucinating welcome-back framing and calling request_verification_code even when collect_contact_info returned customerFound: false (now isReturningVisitor absent).

**How to apply:** When reviewing future changes to request-verification-code.tool.ts, verify that any test reaching the email-send step properly mocks all three pre-send GetCommands: USER_CONTACT_INFO, VERIFICATION_CODE, METADATA, and customer record.
