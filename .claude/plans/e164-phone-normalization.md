TASK OVERVIEW
Task name: E.164 phone normalization for collect_contact_info tool

Objective:
Normalize any phone number passed by the LLM to `collect_contact_info` into canonical E.164 form before the value is written to DynamoDB or used to build the customer GSI2 lookup key. The current behavior writes the raw LLM-supplied string (e.g. "(415) 555-1234"), which will not match the Twilio-supplied E.164 form (e.g. "+14155551234") on a subsequent inbound SMS — that mismatch causes a duplicate customer record and a broken cross-channel identity link.

Relevant context:
- Affected tool: src/tools/collect-contact-info.tool.ts
- Tool spec: src/tools/collect-contact-info.tool.spec.ts
- Phone consumer: src/services/customer.service.ts — `lookupOrCreateCustomer` keys GSI2-SK as `PHONE#<phone>` and writes `phone: input.phone` directly onto the customer record (lines 182, 195). It also exposes `queryCustomerIdByPhone` (line 93) which keys the same way.
- Twilio inbound delivers phones as E.164 already — see comments in src/types/Sms.ts and src/types/SmsReply.ts. So the canonical write path is E.164 and the only divergence is the LLM path.
- No phone normalization helper exists anywhere in src/ today. No `libphonenumber-js` (or similar) is in package.json.
- Validation entry point: src/validation/tool.schema.ts holds `collectContactInfoInputSchema`. Worth checking whether normalization belongs in the Zod schema (transform) or in the tool body itself.
- Project conventions: utils live under src/utils/<topic>/, types live in src/types/, validation in src/validation/. Pure helpers go in utils. See CLAUDE.md.
- DDB record convention: mutable docs carry `_createdAt_` + `_lastUpdated_`. Already in place on this tool.
- Recently shipped multi-tenant routing (commit 1d535c65) makes per-account inbound SMS routing real, so the duplicate-customer cost is now actually visible in production. See docs/journal.md May 6 entry.

Open decision points the arch-planner must resolve:
1. Library choice — `libphonenumber-js` (Google data, ~145KB min full / ~10KB min "min" build) is the de-facto standard. Confirm the dep choice and which build (full vs. min vs. mobile) and document the bundle/runtime impact.
2. Default region — phones supplied without a country code must assume a region. Default "US" is the safe pick given the current account base, but state it explicitly and surface where to override later (per-account config? env var? hardcoded constant for now?).
3. Failure mode — if the LLM passes a string libphonenumber cannot parse to a valid number, what does the tool do? Options: (a) drop the phone field silently and continue saving the rest, (b) return `isError: true` so the LLM retries. The user wants a sensible default — recommend (a) with a structured log so operations can grep for it, since the trio gate (firstName/lastName/email) is what unblocks customer linking, not phone.
4. Where normalization happens — Zod transform in the schema, or in the tool body before the DDB write. Prefer the schema (single chokepoint, pure transformation) but the implementer should call out any reason against it.
5. Backfill scope — there may already be unnormalized phones in production DDB customer records and GSI2 keys. The arch-planner must explicitly DECIDE whether this task includes a backfill or whether backfill is a separate operational item to be tracked. Default recommendation: NO backfill in this task — production has not yet had any LLM-collected phone reach the customer record because the trio gate requires first/last/email and only THEN attaches phone, so historical exposure is small. State this assumption and surface it for user confirmation.
6. Test coverage — the existing 15-case spec covers trio behavior thoroughly. New cases must include: valid US 10-digit input ("4155551234" → "+14155551234"), pretty-formatted input ("(415) 555-1234" → "+14155551234"), already-E.164 input ("+14155551234" passes through), and unparseable input (decision per #3 above).


STEP 1 — ARCHITECTURE PLANNING
Use the arch-planner agent to analyze the codebase and produce a structured implementation plan.

Task specifics for this plan:
Resolve every open decision point above and produce a step-by-step implementation order. The plan must answer:
- Which library and which exact import (e.g. `parsePhoneNumberFromString` from `libphonenumber-js`).
- Where the new helper lives (proposed path: `src/utils/phone/normalizeToE164.ts`) and its exact signature (e.g. `normalizeToE164(input: string, defaultRegion?: CountryCode): string | null`).
- Where the helper is called: in the Zod schema as a transform, OR in the tool body before the DDB write. Pick one and justify in one sentence.
- The behavior when normalization returns null (drop the field vs. error). Pick one.
- Whether `customer.service.ts` and `queryCustomerIdByPhone` need any changes (recommendation: no — they should stay dumb pass-throughs and trust callers to pass canonical E.164, with one short comment at the GSI2-SK build site documenting the contract).
- Backfill decision (in scope / out of scope, with reasoning).
- The list of new spec cases to add to collect-contact-info.tool.spec.ts.

Requirements for the plan:
- identify affected files/modules
- outline step-by-step implementation order
- note dependencies and architectural considerations
- list risks or edge cases
- define testing strategy

Pause after producing the plan so I can review and approve it.


STEP 2 — IMPLEMENTATION
Use the code-implementer agent to implement the approved plan.

Implementation details for this task:
Follow the plan exactly. Add the dependency, write the normalization util with one short doc comment explaining the WHY (cross-channel identity match against Twilio E.164), wire it into the chosen call site, update the validation schema if that's where the plan lands the transform, and add the new spec cases.

Implementation requirements:
- follow the plan produced by the arch-planner agent
- modify or create only the necessary files
- respect existing architecture and coding patterns
- focus on correctness first (style will be handled later)


STEP 3 — STYLE REFACTOR
Use the style-refactor agent to refactor the implementation according to the rules defined in `.claude/instructions/style-enforcer.md`.

Style refactor specifics:
Standard pass. The new helper should look and feel like every other helper in src/utils/ — single responsibility, no logging, no DI, no comments beyond the WHY-comment described above.

Style requirements:
- apply all rules from style-enforcer.md
- improve readability, structure, and consistency
- align code with project conventions and standards
- do not change functionality or logic
- do not introduce new behavior


STEP 4 — TEST EXECUTION
Use the test-suite-runner agent to execute the project's test suite.

Testing context for this task:
Baseline before this task: 667/667 passing across 43 suites. The new spec cases will push both numbers up. Run the full suite, not just the affected file.

Testing requirements:
- run the project's standard test command
- report all failing tests clearly
- summarize results
- do not modify code or attempt fixes


STEP 5 — CODE REVIEW
Use the code-reviewer agent to review the implementation.

Review focus for this task:
- Does the helper correctly produce the canonical E.164 form for the documented inputs (US 10-digit, US pretty-formatted, already-E.164, intl)?
- Is the failure-mode behavior implemented as the plan specified, and consistent across the schema/tool/customer-service boundary?
- Is the GSI2-SK key built from the normalized form on every write path that touches phone?
- Are there any cross-channel identity edge cases the implementation missed (e.g., a phone supplied via collect_contact_info before the trio completes still being stored in USER_CONTACT_INFO un-normalized — is that OK or does it need fixing too)?
- Is the bundle-size impact of the chosen libphonenumber-js build documented somewhere reasonable?
- Are the new spec cases sufficient and free of redundancy with the existing 15 cases?

Review requirements:
- verify correctness of the implementation
- confirm alignment with the architectural plan
- evaluate maintainability, security, and performance
- ensure style refactor did not alter functionality
- report issues using structured review feedback
