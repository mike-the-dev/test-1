---
name: check_active_cart tool review findings
description: Review findings for check-active-cart.tool.ts and related files — returning visitor cart detection feature
type: project
---

Approved with one SHOULD FIX and one NIT. All invariants passed.

SHOULD FIX: Line 91 in check-active-cart.tool.ts logs event `check_active_cart_prior_metadata_missing` when the *current* session METADATA is absent (not the prior session). Should be `check_active_cart_current_metadata_missing` or similar.

NIT: Prompt ordering tension in shopping-assistant.agent.ts — the `On verify_code returning { verified: true }` block (lines 129-133) instructs the LLM to "acknowledge warmly" before the POST-VERIFICATION CART CHECK section (line 137) says "before saying anything else, call check_active_cart." The `has_cart: false` cross-reference on line 148 correctly defers to the original block, so the LLM can reason it out — but the ordering creates a potential ambiguity. Low-risk given LLM reasoning, but worth a reorder in a future prompt pass.

No test coverage for accountUlid-missing early-exit path (lines 60-65). Minor gap; all other early exits are covered.

**Why:** Recurring logging event-name correctness issue; previously seen in CCI phases.
**How to apply:** Always check that the log event label matches which *layer* the early exit is actually on (current vs prior session, customer vs verification, etc.).
