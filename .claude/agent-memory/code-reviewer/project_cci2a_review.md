---
name: CCI Phase 2a review findings
description: Key non-obvious findings from Phase CCI-2a code review — GetCommand gating gap, spec-13 weakness, and all confirmations
type: project
---

The GetCommand pair (USER_CONTACT_INFO + METADATA) in collect-contact-info.tool.ts fires unconditionally after every UpdateCommand, even for firstName-only or phone-only saves. The approved plan does not include the "only-on-email" optimization noted in the brief's review checklist — so this is a plan/brief divergence, not an implementation error. Flag it as SHOULD FIX in future reviews if the optimization is re-added.

Spec case 13 ("Invalid input") only asserts `typeof result.result === "string"` — it does not assert the result is valid JSON or that no DDB writes occurred. Weak test but not a correctness issue.

All MUST FIX invariants passed: trio-gate logic, if_not_exists on METADATA write, strip-prefix on checkout URL, resolveCustomerUlid fully removed, no PII in logs, no Slack alert, per-account isolation intact, Option-A normalization in chat-session.service.ts present.

**Why:** This context helps evaluate future CCI-2b or similar phases against what was already validated.
**How to apply:** When reviewing CCI-2b, verify GetCommand gating is still in place and check whether the optimization was intentionally deferred or added.
