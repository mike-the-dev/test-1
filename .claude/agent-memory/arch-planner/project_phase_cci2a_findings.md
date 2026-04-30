---
name: Phase CCI-2a data-plumbing — codebase findings
description: Key facts discovered during Phase CCI-2a arch-planning — CustomerService shape, preview-cart current state, customer_id readers, type gaps
type: project
---

Phase CCI-2a (collect_contact_info email side-effect + preview-cart hard-require) findings:

- `preview-cart.tool.ts` resolveCustomerUlid lives at lines 530–633. It uses CustomerService.queryCustomerIdByEmail (already shared from Phase 1). The METADATA UpdateCommand's customer_id write (lines ~457–469) uses bare ULID — being removed in Phase 2a.
- `CustomerService` is already injected into `PreviewCartTool`. After Phase 2a it is removed from PreviewCartTool entirely (no more use after resolveCustomerUlid is deleted).
- `GuestCartCustomerRecord.first_name` and `first_name` are typed as `string` (not nullable). Phase 2a must change them to `string | null` because lookupOrCreateCustomer may be called with null names.
- `generate-checkout-link.tool.ts` reads `customer_id` from METADATA and passes it directly into the checkout URL as `?customerId=`. Under Phase 1 preview-cart wrote bare ULIDs; under Phase 2a collect_contact_info writes `C#<ulid>`. The ecommerce backend must be checked to confirm it handles the prefixed form.
- `chat-session.service.ts` already has the Option-A normalization at lines 349–370 (`customerId.startsWith("C#") ? customerId : "C#" + customerId`). STAYS.
- `preview-cart.tool.spec.ts` has 13 describe blocks. Test 13 ("Schema-default — new Customer record includes latest_session_id: null") must be removed outright. Tests 1,3,4,9,10,11a,11b,12-setup all need `customer_id: "C#<ULID>"` added to metadata fixture.
- `collect-contact-info.tool.ts` has no spec file. Phase 2a creates one from scratch.
- `CustomerService` currently has only `queryCustomerIdByEmail`. Phase 2a adds `lookupOrCreateCustomer` — the create logic is byte-lifted from preview-cart:530–633.
- `Verification.ts` exports `VerificationRequestCodeResult` and `VerificationVerifyCodeResult` (not `RequestVerificationCodeResult` / `VerifyCodeResult` as the Phase 1 plan stated — minor naming delta, actual shipped names confirmed by reading the file).

**Why:** Needed to produce a correct implementation plan for Phase CCI-2a.
**How to apply:** Use these line numbers and type details when reviewing Phase 2a implementation diffs.
