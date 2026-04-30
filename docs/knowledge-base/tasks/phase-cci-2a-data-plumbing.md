TASK OVERVIEW
Task name: Phase CCI-2a — Cross-channel identity: chat-side data plumbing

Objective:
Make the chat-side identity flow data-complete by extending `collect_contact_info` with the customer-lookup-and-create side-effect on email-save, lifting Customer creation upstream from `preview_cart` into a shared `CustomerService` method, and tightening `preview_cart` to a hard `customer_id` requirement (no defensive in-line lookup-or-create fallback). No agent system prompts change. No prior-history loader. No "where we left off" copy. CCI-2b ships those.

When this phase is done:
- `collect_contact_info` returns a structured result. When the call results in the contact-info trio (`first_name + last_name + email`) being complete in `USER_CONTACT_INFO` for the first time: `{ saved: true, customerFound: true | false }`. Otherwise (trio not yet complete, OR trio was already complete on a prior call and customer_id is already set): `{ saved: true }`. The agent system prompts are NOT updated to act on `customerFound` in this phase — Phase 2b owns that. Phase 2a just exposes the signal.
- On every `collect_contact_info` call, the tool: (a) saves the provided fields to `USER_CONTACT_INFO` (existing behavior), (b) reads `USER_CONTACT_INFO` post-write to check trio state, (c) **only if `first_name + last_name + email` are ALL present in `USER_CONTACT_INFO` AND `metadata.customer_id` is not yet set**: calls `CustomerService.lookupOrCreateCustomer({ accountUlid, email, firstName, lastName, phone })` to either find an existing Customer record or create one with the complete trio, then (d) writes `metadata.customer_id` as the prefixed `C#<customerUlid>` form (matching `verify_code`'s convention shipped in Phase 1) via DDB `UpdateCommand` with `if_not_exists` semantics. The lookup precedes the create; the create runs only if the lookup misses. **The customer record is NEVER created with null name fields.**
- A new `CustomerService.lookupOrCreateCustomer` method wraps the existing `queryCustomerIdByEmail` (added in Phase 1) plus a new create path lifted from `preview-cart.tool.ts:580–625`. Race-on-create is recovered via `ConditionalCheckFailedException` → re-query, identical to the existing logic.
- `preview-cart.tool.ts` is simplified: the entire `resolveCustomerUlid` path is removed. The tool reads `metadata.customer_id` from the existing METADATA fetch already in scope. If `metadata.customer_id` is null/undefined, the tool returns an error (`"This action requires a customer profile. Please collect the visitor's email first."`). The tool no longer creates Customer records, no longer queries the email GSI, no longer needs `CustomerService` for create-or-lookup (it's not injected for that purpose anymore — but it still injects nothing customer-related; the customer is already linked).
- The `metadata.customer_id` write site that previously lived in `preview-cart.tool.ts:458–468` (the `if_not_exists(#customer_id, :customer_id)` UpdateCommand on METADATA, with bare-ULID value) is REMOVED. New metadata.customer_id writes are exclusively from `collect_contact_info` (Phase 2a) and `verify_code` (Phase 1). Both new writers use the prefixed `C#<ulid>` form.
- **`generate-checkout-link.tool.ts` strips the `C#` prefix when constructing the checkout URL parameter.** The frontend has historically received bare ULID via `customerId=<ulid>` (because the previous `preview_cart` writer stored bare). Phase 2a's switch to prefixed METADATA storage MUST NOT change that external contract. The tool reads `metadata.customer_id` (prefixed under the new convention), slices the `C#` prefix off, and inserts the bare ULID into the URL. One-line change at the URL-construction site, plus a new test asserting the URL never contains `C#` or `C%23`.
- The Option-A consumer-side normalization in `chat-session.service.ts` (`customerKey = customerId.startsWith("C#") ? customerId : "C#" + customerId`) STAYS IN PLACE as legacy compat for in-flight sessions whose METADATA was written by the old preview_cart bare-ULID path. New writes are uniformly prefixed; the normalization handles the long tail.
- Existing tests pass. New tests cover:
  - `collect_contact_info` email side-effect (lookup-hit, lookup-miss-then-create, race-recovery on create).
  - `collect_contact_info` non-email-field calls (unchanged behavior; no customer-related side-effect fires).
  - `preview_cart` with `customer_id` set in METADATA (happy path; uses the linked customer).
  - `preview_cart` with `customer_id` absent (returns error; no DDB writes; no email side-effects).
  - `CustomerService.lookupOrCreateCustomer` (lookup-hit, lookup-miss-then-create, race-recovery, GSI/Put error propagation).
- `collect_contact_info` had no `.spec.ts` file before this phase. Phase 2a creates one with comprehensive coverage of both the existing field-save behavior AND the new email side-effect.

Relevant context:
- The full design spec is `docs/cross-channel-identity/design.md` — read sections "Chat-side continuation flow" (steps 1–3 are Phase 2a's scope) and "Open implementation questions" (Q1 is being resolved here as "lift Customer creation upstream").
- Phase CCI-1 plan is `docs/knowledge-base/tasks/phase-cci-1-data-model-and-verification-plan.md`. The conventions, types, and `CustomerService` shape established in Phase 1 are extended here.
- `src/tools/collect-contact-info.tool.ts` is the existing tool. It accepts MULTIPLE fields per call (firstName, lastName, email, phone, company — see lines 14–20). The existing behavior is one DDB `UpdateCommand` to `USER_CONTACT_INFO` with whatever fields were provided. Returns `{ result: "Contact info saved successfully." }` (string-based, no structured payload). Phase 2a changes the return to JSON.stringify of the structured shape (`{ saved: true, customerFound?: bool }`), consistent with how `request_verification_code` and `verify_code` return results.
- `src/tools/preview-cart.tool.ts` is the file with the largest behavioral change. The current `resolveCustomerUlid` method (lines ~545–660+) does: query `metadata.customer_id` first; if missing, query email GSI; if not found, create Customer; handle race-recovery. Phase 2a removes ALL of that. The tool reads `metadata.customer_id` directly; uses it; errors if absent.
- `src/services/customer.service.ts` (created in Phase 1) currently exposes `queryCustomerIdByEmail`. Phase 2a adds a second method `lookupOrCreateCustomer({ accountUlid, email, firstName, lastName, phone })` that wraps the existing query + the lifted create logic. The existing `queryCustomerIdByEmail` stays (used internally by the new method and externally by `verify_code`).
- The customer record schema (`GuestCartCustomerRecord` in `src/types/GuestCart.ts`) gained `latest_session_id` in Phase 1. Phase 2a does NOT touch the schema; it only changes who creates the records.
- DDB tables: `conversations` table holds session METADATA, USER_CONTACT_INFO, VERIFICATION_CODE, etc. Customer records (`C#<ulid>`) live in the SAME table. The `(ACCOUNT, EMAIL)` GSI1 lookup is unchanged; the Phase 1 `CustomerService` already abstracts it.
- Per-account isolation invariant is unchanged. Customer creation uses `ACCOUNT#<accountUlid>` in GSI1-PK; customer-by-email lookup is account-scoped.

Key contracts (locked by the user during pre-brief alignment — do not relitigate):

**Customer creation policy — locked (TRIO-COMPLETION GATE):**
- Customer creation fires ONLY when `first_name + last_name + email` are all present in `USER_CONTACT_INFO` AND `metadata.customer_id` is not yet set. The trigger field is whichever collect_contact_info call completes the trio (could be email, could be the last name field, depending on collection order). Until the trio is complete, NO Customer record is created and NO `customerFound` signal is returned.
- **`first_name` and `last_name` on `GuestCartCustomerRecord` remain non-nullable `string`.** The Customer record is NEVER created with null name fields. `phone` stays `string | null` (already nullable; passed if collected, null otherwise — phone is genuinely optional for v1, no GSI yet).
- Subsequent `collect_contact_info` calls after Customer creation update `USER_CONTACT_INFO` only — they do NOT back-update the Customer record. Customer record reflects "values at create time" (now always complete). Session-scoped USER_CONTACT_INFO reflects "current values." Phase 2b's prior-history loader can read USER_CONTACT_INFO for any freshest-profile needs.
- The agent prompt already requires first/last/email collection before cart actions. Phase 2a does NOT add tool-level validation that errors when downstream tools fire without contact-complete data — that's a Phase 4 polish candidate per user direction. The trio-completion gate at the customer-creation step IS the de-facto enforcement: if the agent skips name collection, no Customer record exists, no `customerFound` signal exists, the verification flow can't trigger, and `preview_cart` (which hard-requires `customer_id`) errors out.

**`metadata.customer_id` format — locked:**
- New writers use the prefixed form `C#<customerUlid>`.
- The Option-A consumer-side normalization in `chat-session.service.ts` STAYS as legacy compat. Do not remove it.
- The bare-ULID write at the old `preview-cart.tool.ts:468` is REMOVED in this phase (preview_cart no longer writes customer_id at all — collect_contact_info is the sole writer).

**`preview_cart` hard requirement — locked:**
- If `metadata.customer_id` is null or undefined when `preview_cart` runs, the tool returns an error: `{ result: "This action requires a customer profile. Please collect the visitor's email first.", isError: true }`. No defensive in-line create. No fallback. Logs at `logger.error` with `[event=preview_cart_no_customer_id sessionUlid=...]`.
- This is intentionally strict: the agent's prompt already gates cart actions on contact collection. If preview_cart fires without customer_id, that's a programming or prompt-drift bug; surface it.
- Deploy-time concern (in-flight sessions started under old code): user has confirmed there's no live deployment to break. Phase CCI-1 + CCI-2a will ship together as one atomic deploy if needed; no mid-deploy in-flight sessions to migrate.

**`collect_contact_info` return shape — locked:**

```ts
// Tool result.result is JSON.stringify of one of:
type CollectContactInfoTrioCompletedResult = { saved: true; customerFound: boolean };  // trio just completed AND lookupOrCreate ran successfully
type CollectContactInfoSavedResult = { saved: true };                                    // trio not yet complete, OR already complete (customer_id already set), OR link was best-effort skipped

// On error (DDB save failure, validation error, etc.):
// returns ChatToolExecutionResult with isError: true and a human-readable result string
```

The `customerFound` signal fires AT MOST ONCE per session — on the call that completes the trio for the first time. Subsequent calls return `{ saved: true }` because `metadata.customer_id` is already set (the gate prevents repeat lookup-or-create).

The agent's existing system prompt does not key off the new structured shape in Phase 2a. The shape exists for Phase 2b's prompt edits to consume. Returning the new shape NOW (instead of waiting for Phase 2b) ensures the Phase 2a-shipped tool matches the contract Phase 2b's prompts will rely on.

**`CustomerService.lookupOrCreateCustomer` signature — locked:**

```ts
lookupOrCreateCustomer(input: {
  tableName: string;
  accountUlid: string;
  email: string;
  firstName: string;        // non-nullable — caller must enforce trio completion before invoking
  lastName: string;         // non-nullable — caller must enforce trio completion before invoking
  phone: string | null;     // phone stays optional
}): Promise<{ customerUlid: string; created: boolean } | { error: string }>;
```

- `customerUlid` is the BARE ULID (no `C#` prefix). The caller (`collect-contact-info.tool.ts`) wraps it as `C#${customerUlid}` when writing to METADATA.
- `created: true` if a new record was just written; `created: false` if the lookup found an existing record (or race-recovered to one).
- The method does NOT internally validate trio completeness — the caller (collect_contact_info) gates the call on the trio being complete in USER_CONTACT_INFO. If a future caller passes empty strings, the Customer record gets empty strings (caller's bug, not the service's).
- On unrecoverable DDB error: returns `{ error: <generic-error-string> }`. Propagation up to the tool's `execute` is handled cleanly.
- The race-recovery semantics are identical to the existing `preview-cart.tool.ts:640–680` logic (Put with `attribute_not_exists(PK)`; on `ConditionalCheckFailedException` re-query the GSI; if still missing, return error).

**Out of scope for Phase CCI-2a (do not add):**
- Updates to `lead_capture` or `shopping_assistant` system prompts — Phase 2b.
- Prior-history context loader (last 20 messages from `customer.latest_session_id` injected as prior turns) — Phase 2b.
- Customer profile loading from the Customer record into agent context — Phase 2b.
- Loading `USER_FACT` or `USER_CONTACT_INFO` records from prior sessions into agent context — Phase 2b.
- Verification flow prompt instructions ("when customerFound is true, soft-welcome and request_verification_code") — Phase 2b.
- Failure-path graceful-recovery copy ("No worries, let's keep going from here") — Phase 2b.
- Tool-level validation that errors when downstream tools fire without complete first/last/email — Phase 4 polish candidate.
- Phone GSI for phone-keyed customer lookup — future work.
- Back-updating the Customer record's first/last/phone when later `collect_contact_info` calls save those fields — explicit decision: Customer record reflects values at create time, USER_CONTACT_INFO reflects current values.
- Cross-account customer linking (per-account isolation is the load-bearing invariant).
- Any change to the SendGrid Inbound Parse webhook — Phase 3.
- Any change to `/chat/web/*`, the iframe auth model, or the conversation runtime path beyond the scope above.
- Any refactor of existing TS variable names (`sessionUlid`, etc.) — naming convention applies forward only.
- Any new Slack alert. The locked rule from Phase 8b-followup (no PII in Slack) applies absolutely. Customer creation is not a celebration event worth surfacing; do not add an alert.


STEP 1 — ARCHITECTURE PLANNING
Use the arch-planner agent to analyze the codebase and produce a structured implementation plan.

Task specifics for this plan:

1. Read this brief in full. Read `docs/cross-channel-identity/design.md` end-to-end (it is the authoritative design spec). Read `docs/knowledge-base/tasks/phase-cci-1-data-model-and-verification-plan.md` to understand the conventions and `CustomerService` shape established in Phase 1.

2. Study the existing patterns the new code must mirror or extend:
   - `src/tools/collect-contact-info.tool.ts` — the existing tool. Phase 2a extends it with the email side-effect and changes the return shape from a plain string to JSON.stringify of the structured result. Read every line.
   - `src/tools/preview-cart.tool.ts` — the file with the largest change. Pay particular attention to: (a) the customer-id read at the top of `execute()` (the existing METADATA fetch around line 200), (b) the entire `resolveCustomerUlid` method (lines ~545–660+) which is being REMOVED, (c) the bare-ULID `customer_id` write at lines ~458–468 in the cart-record UpdateCommand which is also being REMOVED, (d) every place the resolveCustomerUlid result is consumed (cart record write, metadata write).
   - `src/services/customer.service.ts` — Phase 1's shared service. Extend with `lookupOrCreateCustomer`. Existing `queryCustomerIdByEmail` stays.
   - `src/tools/verify-code.tool.ts` — reference for how `metadata.customer_id` is written in the prefixed `C#<ulid>` form. `collect_contact_info` matches this pattern.
   - `src/services/identity.service.ts` (specifically the METADATA UpdateCommand patterns) — reference for ExpressionAttributeNames/Values shape.
   - `src/services/chat-session.service.ts handleMessage` — confirm the Option-A normalization at the `latest_session_id` write block stays untouched.

3. Verify against current code (specific facts the plan must establish before implementation):
   - **Where exactly in `preview-cart.tool.ts` is `customer_id` currently read from METADATA, and where is the resolveCustomerUlid call wired?** Identify the line numbers and the variable that holds the result. Phase 2a's simplified version reads the same field but errors on null/undefined.
   - **What downstream calls in `preview-cart.tool.ts` consume the customer_ulid result?** The cart record's `customer_id` field (line ~428 — `C#${customerUlid}`) and the METADATA write (lines ~458–468 — `customer_id = customerUlid` bare). Both must be updated: the cart write keeps using the customerUlid value (extracted from `metadata.customer_id` by stripping the `C#` prefix); the METADATA write is REMOVED entirely (collect_contact_info is now the sole writer).
   - **Does `collect-contact-info.tool.ts` currently fetch USER_CONTACT_INFO?** No — it only writes. The new email-side-effect needs to fetch USER_CONTACT_INFO to read first/last/phone for the Customer create call. Add a `GetCommand` before the existing `UpdateCommand`. Sequence: Get → Update USER_CONTACT_INFO → Lookup-or-create Customer → Update METADATA.customer_id.
   - **Does the existing `collect-contact-info.tool.ts` have a spec file?** No (`src/tools/` has no `collect-contact-info.tool.spec.ts`). Phase 2a creates it with comprehensive coverage of BOTH the existing field-save behavior AND the new email side-effect.
   - **Are there any other readers of `metadata.customer_id` besides the `latest_session_id` guard in chat-session.service.ts?** Identify and list them. Phase 2a's customer_id format change (write-side standardization on prefixed) must not break any reader that assumed bare-ULID.
   - **What's the `CollectContactInfoToolResult` type today?** Check the existing types — likely just a string. Phase 2a defines a new type for the structured shape.

4. Produce a detailed implementation plan covering ALL of these sections:
   - **Overview** — one paragraph.
   - **Affected files / modules** — comprehensive list with one-line note per file (created vs modified vs removed-from).
   - **`CustomerService.lookupOrCreateCustomer` design** — exact method signature, exact lookup-then-create flow, exact race-recovery handling (lifted from `preview-cart.tool.ts`), exact error-propagation shape. Show the TypeScript type for the input and return.
   - **`collect_contact_info` extension — TRIO-COMPLETION-GATED execute flow:**
     1. Validate input (existing).
     2. Update `USER_CONTACT_INFO` with the new fields (existing behavior).
     3. Read `USER_CONTACT_INFO` POST-WRITE to get the merged state (NEW). Read `metadata.customer_id` from METADATA (NEW; can be combined with the same GetCommand on METADATA OR a separate fetch — arch-planner picks the cleanest pattern). The post-write read is the authoritative trio-state check.
     4. **Trio-completion gate:** check whether `first_name`, `last_name`, AND `email` are ALL non-empty strings in the merged USER_CONTACT_INFO state AND `metadata.customer_id` is null/undefined. If gate fails (trio not complete OR customer_id already set): return `{ saved: true }`. Stop.
     5. If gate passes: call `CustomerService.lookupOrCreateCustomer` with the trio fields (firstName, lastName non-nullable strings; phone passed if present in USER_CONTACT_INFO else null).
     6. If lookup-or-create succeeded: Update METADATA with `customer_id = "C#" + customerUlid` via DDB UpdateCommand. Use `if_not_exists(customer_id, ...)` semantics so a verify_code-set customer_id from a prior turn is NOT overwritten.
     7. Build the structured result. Return JSON.stringify of `{ saved: true, customerFound: !created }`. (`customerFound: true` means the lookup hit an existing record; `customerFound: false` means we just created the record OR race-recovered to a fresh one. From the agent's perspective in Phase 2b: `customerFound: true` means "this is a returning visitor we should verify before exposing prior history.")
     8. If lookup-or-create returned `{ error: ... }` OR the METADATA UpdateCommand throws: log at `logger.error` with `[event=collect_contact_info_link_failed sessionUlid=...]` and return `{ saved: true }` (best-effort — the user-visible contact-info save succeeded; the link failure is non-fatal and recoverable on the next collect_contact_info call).
   - **`preview-cart.tool.ts` simplification** — exact list of changes:
     - Remove the `resolveCustomerUlid` method entirely.
     - Remove the bare-ULID METADATA `customer_id` write (the `if_not_exists(#customer_id, :customer_id)` UpdateCommand around lines 458–468).
     - Read `metadata.customer_id` from the existing METADATA fetch. Strip the `C#` prefix to get `customerUlid` (matching the format the cart record needs at line ~428).
     - If `metadata.customer_id` is null/undefined, return error per the locked contract.
     - Remove the `CustomerService` injection from PreviewCartTool's constructor IF it's no longer used. (Phase 1 added `CustomerService` to the constructor for `queryCustomerIdByEmail` — verify whether it's still needed after the simplification.)
   - **`generate-checkout-link.tool.ts` strip-prefix on URL construction** — read `metadata.customer_id` (which is now consistently prefixed `C#<ulid>` after Phase 2a), slice the `C#` prefix off, then interpolate the bare ULID into the `customerId=` URL parameter at the existing line ~167 site. The frontend's URL contract has historically received bare ULID; this preserves it exactly. Document the exact slice (`customer_id.startsWith("C#") ? customer_id.slice(2) : customer_id`) so a future stored format change doesn't silently break the URL.
   - **The `if_not_exists` semantics for collect_contact_info's METADATA.customer_id write** — design rationale. If a `verify_code` succeeds before `collect_contact_info` saves email (pathological but possible), `verify_code` already set `customer_id`. The next `collect_contact_info` email-save shouldn't overwrite it (the lookup-or-create might find a different customer for a typo'd email, etc.). `if_not_exists` is the right semantic: first-writer-wins. Document this decision in the plan.
   - **Removed code list** — exhaustive: every line/method/variable being deleted from `preview-cart.tool.ts`. The reviewer will check this list against the actual diff.
   - **Step-by-step implementation order** — file-by-file. Suggested:
     1. Add `lookupOrCreateCustomer` to `CustomerService`.
     2. Add `CustomerService.lookupOrCreateCustomer` spec coverage.
     3. Refactor `collect-contact-info.tool.ts` to add the email side-effect.
     4. Create `collect-contact-info.tool.spec.ts` with comprehensive coverage.
     5. Refactor `preview-cart.tool.ts` (remove resolveCustomerUlid, remove bare-ULID write, hard-require customer_id).
     6. Update `preview-cart.tool.spec.ts` to set up `metadata.customer_id` in test fixtures (existing tests assumed preview_cart created the customer; new tests assume it's pre-set).
     7. Sweep for any other consumers of preview_cart's customer-create behavior (e.g., e2e tests, integration fixtures).
   - **Testing strategy:**
     - `customer.service.spec.ts` (existing — ADD cases for `lookupOrCreateCustomer`):
       - Hit case: existing customer → returns `{ customerUlid: "abc123", created: false }`.
       - Miss case: no existing customer → creates → returns `{ customerUlid: "<new>", created: true }`.
       - Race-on-create: Put returns `ConditionalCheckFailedException` → re-query → returns `{ customerUlid: "<recovered>", created: false }`.
       - Generic DDB error → returns `{ error: <string> }`.
     - `collect-contact-info.tool.spec.ts` (NEW file) — TRIO-COMPLETION-GATED tests:
       - Save firstName only: returns `{ saved: true }`. No customer-related side-effect. No lookup-or-create call.
       - Save email only (no first/last yet on file): returns `{ saved: true }`. No customer side-effect — trio incomplete.
       - Save firstName + lastName together (no email yet on file): returns `{ saved: true }`. No customer side-effect — email missing.
       - Save email when firstName + lastName were saved in a prior call (trio completes on email-save): triggers lookup-or-create with all three. Customer hit case → returns `{ saved: true, customerFound: true }`; customer miss case → returns `{ saved: true, customerFound: false }`. METADATA UpdateCommand fires with `if_not_exists(customer_id, ...) = "C#<ulid>"`.
       - Save firstName when email + lastName were saved in a prior call (trio completes on firstName-save): same trio-completion behavior.
       - Save lastName when email + firstName were saved in a prior call (trio completes on lastName-save): same trio-completion behavior.
       - Save firstName + lastName + email all in one call: trio completes on this single call → triggers lookup-or-create immediately.
       - Save email AGAIN after the trio was already complete and customer_id is already set: returns `{ saved: true }` (no `customerFound`). No second lookup-or-create. No METADATA write. The gate check on customer_id-already-set short-circuits.
       - Save phone only (trio not complete because email/firstName/lastName not all on file): returns `{ saved: true }`. No customer side-effect.
       - DDB error during lookup-or-create: log, return `{ saved: true }` (best-effort link; user-visible contact save succeeded; recoverable on next call).
       - METADATA UpdateCommand failure: log, return `{ saved: true }` (best-effort).
     - `preview-cart.tool.spec.ts` (existing — extensive UPDATES):
       - All existing tests need their fixtures to set `metadata.customer_id` so preview_cart finds it. The existing tests mocked the resolveCustomerUlid path; after the refactor, the customer is assumed pre-linked.
       - New test: missing `metadata.customer_id` returns error with the locked message; no DDB writes; no email side-effects.
       - Removed tests: anything that exercised resolveCustomerUlid's create-or-lookup-or-race paths (now covered by `customer.service.spec.ts`'s `lookupOrCreateCustomer` cases).
     - `generate-checkout-link.tool.spec.ts` (existing — UPDATE one test, ADD one):
       - Existing happy-path test: update fixture so METADATA returns `customer_id: "C#abc123"` (prefixed, matching the new convention). Assert the constructed URL contains `customerId=abc123` (BARE — the strip-prefix transformation works) and does NOT contain `C#` or `C%23`.
       - New negative-assertion test: METADATA returns prefixed customer_id; assert the URL parameter is bare. Explicit guard against accidental regression.
     - Mock all external services (SendGrid via `EmailService` mock; DDB via existing test patterns). No real network calls.
   - **Risks and edge cases:**
     - Existing `preview-cart.tool.spec.ts` may have many tests that assumed customer-create-on-the-fly. The plan must enumerate which existing tests need fixture updates vs. removal.
     - The `if_not_exists` semantics on METADATA.customer_id mean a verify_code-set customer_id is preserved even if collect_contact_info tries to set a different one later (e.g., visitor types a typo'd email after verifying the correct one). The plan must explicitly call out this is intended behavior.
     - The customer-by-email lookup is account-scoped via GSI1. A visitor who shops at two merchants on the platform would create two Customer records (one per account). Confirm the `lookupOrCreateCustomer` honors this.
     - Race between two parallel `collect_contact_info` email-save calls in the same session: both Get USER_CONTACT_INFO, both call lookup-or-create. The lookup-or-create's race-recovery handles the create collision; the METADATA `if_not_exists` handles the customer_id write race.
     - Customer record's `latest_session_id` field: created with `null` per Phase 1's schema change. Phase 2a does NOT modify it; the `chat-session.service.ts handleMessage` post-turn write fills it in on the first verified-session assistant turn.
     - A `verify_code` success that fires BEFORE `collect_contact_info` saves email — pathological since the verification flow requires email to be on file, but: the `verify_code` Phase 1 flow looks up customer by the VERIFICATION_CODE record's email and writes prefixed customer_id. If `collect_contact_info` then runs with that same email, the `if_not_exists` keeps the verified link in place. Good.
   - **Out-of-scope confirmations** — recap from this brief.

5. Write your plan to `docs/knowledge-base/tasks/phase-cci-2a-data-plumbing-plan.md`.

6. Return a concise summary (under 800 words) including:
   - Path to the plan file.
   - 6–8 key decisions or clarifications you made — particularly around (a) the exact ordering of GetCommand-USER_CONTACT_INFO vs. the existing UpdateCommand in collect_contact_info, (b) whether `if_not_exists` is the right semantic for the METADATA customer_id write, (c) METADATA write failure handling (saved-but-not-linked surfaced as isError: true or isError: false), (d) whether `CustomerService` stays injected in `PreviewCartTool` after simplification, (e) whether the existing `preview-cart.tool.spec.ts` test fixtures need broad updates or only targeted ones, (f) any consumers of `metadata.customer_id` you found that assume bare-ULID format.
   - Any risks, unknowns, or "needs orchestrator decision" items the user should resolve before approval.

Hard rules for this agent:
- DO NOT commit. DO NOT push. DO NOT run any `git` write command.
- DO NOT read `.env`, `.env.local`, or any `.env.*` file. Only `.env.example` if it exists.
- Pause after producing the plan so the orchestrator can get user approval before Step 2.


STEP 2 — IMPLEMENTATION
Use the code-implementer agent to implement the approved plan.

Implementation details for this task:
- Follow the plan to the letter. The plan locks the exact ordering of operations in `collect_contact_info`'s execute flow, the `if_not_exists` semantics for the METADATA write, the error-message text for the preview_cart hard-require, and the `lookupOrCreateCustomer` signature.
- The lift of customer-create logic from `preview-cart.tool.ts` to `CustomerService` is a refactor: behavior must be IDENTICAL on the create path. Use the same `attribute_not_exists(PK)` ConditionExpression, same race-recovery sequence, same field defaults. The only thing that changes is the home of the code.
- The tool result payloads are JSON.stringify of structured types. Match the pattern from `request_verification_code` and `verify_code` (Phase 1).
- The METADATA `customer_id` write in `collect_contact_info` uses `if_not_exists(#customer_id, :customer_id)` — first-writer-wins, so a verify_code-set customer_id is preserved.
- Run `npm run build` and `npm test` before returning. Report total test count delta.
- Existing test fixtures in `preview-cart.tool.spec.ts` may need broad updates (set `metadata.customer_id` in mocked GetCommand returns). Do this carefully — a sweep of the spec, not a one-liner.

Implementation requirements:
- follow the plan produced by the arch-planner agent
- modify or create only the necessary files
- respect existing architecture and coding patterns
- focus on correctness first (style will be handled later)

Hard rules for this agent:
- DO NOT commit. DO NOT push. DO NOT run any `git` write command.
- DO NOT read `.env`, `.env.local`, or any `.env.*` file. Only `.env.example` if it exists.


STEP 3 — STYLE REFACTOR
Use the style-refactor agent to refactor the implementation according to the rules defined in `.claude/instructions/style-enforcer.md`.

Style refactor specifics:
- Bracketed `[key=value]` log format throughout. Match the convention in `preview-cart.tool.ts`, `save-user-fact.tool.ts`, and Phase 1's two new tools.
- Named constants (no magic strings):
  - `CUSTOMER_PK_PREFIX = "C#"` (or reuse if Phase 1 already defines it).
  - `METADATA_SK = "METADATA"`, `USER_CONTACT_INFO_SK = "USER_CONTACT_INFO"` (these likely already exist; reuse).
  - `MISSING_CUSTOMER_ERROR = "This action requires a customer profile. Please collect the visitor's email first."` — exported from a co-located constant or the tool file.
- The `lookupOrCreateCustomer` method stays terse, side-effect-explicit, and uses the same `Logger` debug/error patterns established in Phase 1.
- TypeScript-side variables use camelCase. New DDB field names (none in this phase) would use snake_case. NEVER `_ulid` / `Ulid` on new fields or new typed inputs.
- No `any`, no inline type annotations TypeScript can infer, no dead code, no placeholder comments.
- Result-payload JSON.stringify shapes use `satisfies <ResultType>` for compile-time completeness checks.
- Do NOT undo any change made by the implementer that resolves a previous-round style finding.

Style requirements:
- apply all rules from style-enforcer.md
- improve readability, structure, and consistency
- align code with project conventions and standards
- do not change functionality or logic
- do not introduce new behavior

Hard rules for this agent:
- DO NOT commit. DO NOT push. DO NOT run any `git` write command.
- DO NOT read `.env`, `.env.local`, or any `.env.*` file. Only `.env.example` if it exists.


STEP 4 — TEST EXECUTION
Use the test-suite-runner agent to execute the project's test suite.

Testing context for this task:
- Run `npm run build` first.
- Run `npm test`. Baseline before this phase: 523 tests (per the Phase CCI-1 close-out). Phase CCI-2a adds:
  - ~4 cases for `CustomerService.lookupOrCreateCustomer` (added to existing customer.service.spec.ts).
  - ~8–10 cases for `collect_contact_info` (NEW spec file — fully covers both existing field-save behavior and the new email side-effect).
  - ~3 new cases for `preview-cart.tool.spec.ts` (hard-require error path; missing customer_id; logging).
  - REMOVES tests that exercised the deleted resolveCustomerUlid create-or-lookup paths from `preview-cart.tool.spec.ts` — the remaining customer-create coverage moves to `customer.service.spec.ts`.
- Estimated new total: ~530–540 (the test count delta is partly net-new and partly reshuffling).
- Mock all external services (SendGrid, DDB). Tests must NOT make real network calls.

Testing requirements:
- run the project's standard test command
- report all failing tests clearly
- summarize results
- do not modify code or attempt fixes

Hard rules for this agent:
- DO NOT commit. DO NOT push. DO NOT run any `git` write command.
- DO NOT read `.env`, `.env.local`, or any `.env.*` file.
- DO NOT modify any source or test file.


STEP 5 — CODE REVIEW
Use the code-reviewer agent to review the implementation.

Review focus for this task:
- **`collect_contact_info` lookup-or-create fires ONLY when the trio (`first_name + last_name + email`) is complete in `USER_CONTACT_INFO` AND `metadata.customer_id` is not already set.** Saving firstName-only must not trigger lookup-or-create. Saving email-only when names are missing must not trigger lookup-or-create. Saving any field when customer_id is already set must not trigger lookup-or-create. The `customerFound` signal in the result fires AT MOST ONCE per session.
- **`first_name` and `last_name` on `GuestCartCustomerRecord` remain non-nullable `string`.** No null defaults at create time. The trio-completion gate enforces this — if the gate ever fires with empty/missing names, that's a bug at the gate, not at the type.
- **The METADATA `customer_id` write uses `if_not_exists`.** A verify_code-set customer_id from a prior turn must NOT be overwritten by a later collect_contact_info trio-completion. Search for any code path that uses raw SET on customer_id; if found, it's a bug.
- **`generate-checkout-link.tool.ts` URL parameter is BARE ULID, NEVER prefixed.** Test that with `metadata.customer_id = "C#<ulid>"`, the constructed URL contains `customerId=<ulid>` (no `C#`, no `C%23`). The frontend contract is the authoritative external surface.
- **The customer_id format is consistently prefixed `C#<ulid>` at every new write site.** Both verify_code (Phase 1, unchanged) and collect_contact_info (Phase 2a, new) write the prefixed form. The Option-A normalization in chat-session.service.ts STAYS — verify it wasn't accidentally removed.
- **`preview_cart` has no remaining customer-create or customer-by-email-lookup code.** The entire `resolveCustomerUlid` method must be gone. The bare-ULID METADATA write at the cart UpdateCommand must be gone. Search the file for any remaining reference to `queryCustomerUlidByEmail` (the old method name from Phase 1's lift), `attribute_not_exists(PK)` on Customer records, or the `:customer_id` expression value being assigned to a bare ULID.
- **`preview_cart` returns the locked error string when `metadata.customer_id` is missing.** Exact text. Logs at `logger.error` with `[event=preview_cart_no_customer_id ...]`. No DDB writes attempted; no email side-effects.
- **`CustomerService.lookupOrCreateCustomer` race-recovery is identical to the lifted code.** The Put with ConditionExpression + the re-query on ConditionalCheckFailedException + the error path on re-query failure must all match the original semantics. Behavioral parity is the load-bearing invariant of the refactor.
- **`collect_contact_info` GetCommand-USER_CONTACT_INFO + GetCommand-METADATA fire on every successful save** — required for the trio-completion gate, since any field could be the trigger that completes the trio if the others were saved earlier. (The original brief had a stale optimization clause from the eager-on-email-save design saying "only fire when email is in input"; that clause was wrong for trio-completion and is removed here.)
- **Per-account isolation is unaffected.** `lookupOrCreateCustomer` uses `accountUlid` in GSI1-PK and Customer record creation. No cross-account paths.
- **No PII in logs.** New code logs sessionUlid, errorType, event categories. Email, plaintext code, customer name, customer ID — none of these in any logger call.
- **No new Slack alerts.** Customer creation is not a celebration event. Search the new code for any SlackAlertService import; flag if found.
- **Naming convention** — new DDB writes use snake_case; new TS variables/types use camelCase. Reuse existing constants (METADATA_SK, USER_CONTACT_INFO_SK, CHAT_SESSION_PK_PREFIX, CUSTOMER_PK_PREFIX) instead of redefining them.
- **Out-of-scope respected** — no system-prompt edits, no prior-history loader, no profile-into-context loading, no Phase 4 contact-completeness validation, no SendGrid Inbound Parse webhook changes, no phone GSI, no back-update of Customer record's name fields, no `/chat/web/*` changes.

Review requirements:
- verify correctness of the implementation
- confirm alignment with the architectural plan
- evaluate maintainability, security, and performance
- ensure style refactor did not alter functionality
- report issues using structured review feedback

Hard rules for this agent:
- DO NOT commit. DO NOT push. DO NOT run any `git` write command.
- DO NOT read `.env`, `.env.local`, or any `.env.*` file.
- DO NOT modify any source file.
