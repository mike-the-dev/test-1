TASK OVERVIEW
Task name: Phase CCI-2b — Cross-channel identity: chat-side agent flow

Objective:
Compose the substrate shipped in CCI-1 + CCI-2a into the actual chat-side returning-visitor experience. Three connected pieces:

1. **Capture the prior-session pointer at verification time.** Modify `verify_code` so it records the customer's PRIOR `latest_session_id` into a new METADATA field on the current session (`continuation_from_session_id`) BEFORE the existing per-turn write moves the pointer to the current session. Without this capture, the prior-session pointer is overwritten before the loader can use it.

2. **Build the prior-history context loader.** On every assistant turn for a verified session, if `metadata.continuation_from_session_id` is set AND the loader hasn't yet fired for this session, load: (a) the customer's profile from the Customer record (first_name, last_name, email, phone), (b) the last 20 messages from the captured prior session. **Profile + framing context get appended to the agent's `system` prompt for this Anthropic API call** (the dedicated parameter Anthropic provides for visitor/situation context — not a workaround). **Prior session messages get prepended to the messages array** as their real user/assistant pairs. The messages array stays clean — only actual conversation turns, no synthetic role:user injections of metadata. Mark the load as done so it doesn't fire twice.

3. **Update agent system prompts** (`lead_capture` and `shopping_assistant`) with the verification flow instructions: soft welcome on `customerFound: true` → `request_verification_code` → handle code paste → `verify_code` → on success do a brief "where we left off" reference + answer current question naturally, on failure gracefully give up ("No worries, let's keep going from here") — no history exposure on failure.

When this phase is done:
- A new METADATA field `continuation_from_session_id: string | null` exists on the session record. Initialised as `null` at session creation. Set to the visitor's prior session ULID by `verify_code` on successful verification — the value is whatever was in `customer.latest_session_id` at the moment verify_code looked up the customer (i.e., the visitor's session BEFORE this one).
- A new METADATA field `continuation_loaded_at: string | null` exists on the session record. Initialised as `null` at session creation. Set to an ISO 8601 timestamp by the prior-history loader on the first turn it fires. Subsequent turns short-circuit when this field is non-null.
- `verify_code` is modified: BEFORE Write B (the existing `latest_session_id` update on Customer), it reads the customer record (or extracts from the existing email-GSI query result) the current `latest_session_id` value. It writes that captured value into `metadata.continuation_from_session_id` as part of the same UpdateCommand that sets `metadata.customer_id` (Write A). If the captured value is `null` (visitor has no prior session — first-ever return after registration), `continuation_from_session_id` is also `null` and the loader will skip on subsequent turns.
- A new prior-history loader runs in `chat-session.service.ts handleMessage`, before the Anthropic API call. The loader reads `metadata.continuation_from_session_id` and `metadata.continuation_loaded_at`. If both conditions hold (continuation field non-null AND loaded_at IS null), it fires:
  - Reads the Customer record (PK/SK = `C#<customerUlid>`/`C#<customerUlid>`) for profile fields.
  - Queries the prior session's last 20 messages (PK = `CHAT_SESSION#<priorSessionUlid>`, SK begins with `MESSAGE#` — confirm exact prefix in the codebase) by `_createdAt_` descending, then reversed to chronological order for injection.
  - **Builds an augmented `system` prompt for this Anthropic call** by concatenating: the agent's static `systemPrompt` + a dynamic context block containing visitor profile (name, email, phone) and a brief framing line ("The visitor was just verified. The conversation messages below begin with their prior session, then continue with today's session. Briefly acknowledge what you were working on together before answering their current question."). The static base prompt and the dynamic block are passed as separate text content blocks with `cache_control: { type: "ephemeral" }` on the static base so prompt caching keeps working for the unchanged prefix.
  - Prepends prior session messages to the messages array (in chronological order), followed by the existing current-session messages, then the new user message. Messages array contains ONLY real visitor/agent turns — no synthetic role:user metadata injections.
  - Writes `metadata.continuation_loaded_at = now` so the loader doesn't fire on subsequent turns.
- `lead_capture.agent.ts` and `shopping_assistant.agent.ts` system prompts get a new "RETURNING VISITOR FLOW" section (text shape locked below) that instructs the agent on the verification handoff and the failure-path graceful recovery.
- 25–35 new tests cover: verify_code capture-and-write, the loader's gate logic, the loader's prior-session message injection, the framing system message, the loaded_at flag, the failure path (verify_code failure → no loader fires → no history exposure), the no-prior-session case (continuation_from_session_id stays null), and the agent allowlist+prompt smoke checks.
- Existing tests pass. Build clean.

Relevant context:
- The full design spec is `docs/cross-channel-identity/design.md`. Re-read sections "Chat-side continuation flow" steps 6–7, "What 'full continuation' loads (continuation-content option B)", and "Failure & edge cases."
- CCI-1 plan (`docs/knowledge-base/tasks/phase-cci-1-data-model-and-verification-plan.md`) covers `verify_code`'s current execute flow, including Write A/B/C. Phase 2b modifies Write A to also write `continuation_from_session_id`.
- CCI-2a plan (`docs/knowledge-base/tasks/phase-cci-2a-data-plumbing-plan.md`) covers `collect_contact_info`'s trio-completion gate which produces the `customerFound` signal the new prompts will key off of.
- `src/services/chat-session.service.ts handleMessage` is where the loader plugs in. Read every line — the existing context-build path (METADATA fetch, message-history fetch, Claude call) is what the loader extends.
- CHAT_TURN records exist today (the format used to persist agent/visitor turns). Their schema (PK, SK, fields) needs to be confirmed against the existing message-history fetch logic; arch-planner identifies the exact query shape.
- The Customer record schema has profile fields: `first_name` (non-null string), `last_name` (non-null string), `email` (string), `phone` (string | null). All four are pulled into the loader's profile injection.
- Per-account isolation is unchanged. The prior session referenced by `continuation_from_session_id` is always under the SAME account as the current session (by construction — the customer-by-email lookup that produced `customer_id` is account-scoped via GSI1).

Key contracts (locked by the user during pre-brief alignment — do not relitigate):

**`continuation_from_session_id` and `continuation_loaded_at` — locked:**
- New METADATA fields. Both default to `null` at session creation in `identity.service.ts` (alongside the existing `customer_id: null` initialization).
- `continuation_from_session_id` stores a BARE session ULID (no `CHAT_SESSION#` prefix), matching how `latest_session_id` is stored on the Customer record (per CCI-1 convention).
- Set ONCE per session, by `verify_code` on success. If `verify_code` is never called (visitor isn't a returning customer or never verifies), the field stays `null` and the loader never fires.
- `continuation_loaded_at` is set ONCE per session, by the loader on its first fire. ISO 8601 timestamp.

**`verify_code` modification — locked:**
- The existing CustomerService email-GSI lookup at verify_code success returns the bare `customerUlid`. To also get `latest_session_id`, either: (a) extend the CustomerService method to also return that field (change return type to `{ customerUlid: string; latestSessionId: string | null }`), OR (b) issue a separate `GetCommand` on the Customer record after the email lookup. Pick (a) — one round-trip, cleanest, matches the precedent of the trio-completion-gate implementation that does post-write reads in the same beat.
- The captured value is written into `metadata.continuation_from_session_id` AS PART OF Write A (the `customer_id` UpdateCommand). Single UpdateCommand updates both fields atomically. No new round-trip.
- If `customer.latest_session_id` is `null` (this customer has no prior session — they registered but never returned), `continuation_from_session_id` is also `null`. The loader on the next turn will short-circuit naturally.

**Prior-history loader — locked behavior (Option B — system prompt augmentation):**
- Fires in `chat-session.service.ts handleMessage`, AFTER the existing METADATA fetch and BEFORE the Anthropic API call. Exact wiring point identified by arch-planner.
- Gate: `metadata.continuation_from_session_id !== null` AND `metadata.continuation_loaded_at === null`. Both must hold.
- Loads in order: Customer record (for profile), prior session's last 20 messages.
- **Visitor profile + framing context go into the Anthropic `system` parameter, NOT into the messages array.** The Anthropic SDK accepts `system` as either a single string OR an array of text content blocks. We use the array form: first block is the agent's static `systemPrompt` with `cache_control: { type: "ephemeral" }` (so the static prefix stays cached); second block is the dynamic per-conversation context with no cache marker. This keeps prompt caching effective on the static portion while letting the dynamic visitor context vary per call.
- The dynamic context block contents (arch-planner refines wording, locks structure):
  ```
  The visitor you're talking to is a returning customer:
  - Name: <first_name> <last_name>
  - Email: <email>
  - Phone: <phone or "not provided">

  They were just verified. The conversation messages below begin with their prior session, then continue with today's session. Briefly acknowledge what you were working on together before answering their current question.
  ```
- **Prior session messages go into the messages array** as their real `role: "user"` and `role: "assistant"` pairs (whatever role they were originally persisted under). Prepended to the current session's messages in chronological order. No synthetic role:user metadata injections — the messages array contains ONLY actual visitor/agent turns.
- After successful load: write `metadata.continuation_loaded_at = now` via UpdateCommand. Use `if_not_exists(continuation_loaded_at, ...)` to avoid races between parallel turns.

**System prompt edits — locked structure:**
Both `lead_capture.agent.ts` and `shopping_assistant.agent.ts` get a new section. arch-planner writes the literal text in the plan; the implementer copies verbatim. The section MUST cover:

- **On `customerFound: true` from `collect_contact_info`:** soft-welcome the visitor by first name, indicate that you'll send a quick verification code, then immediately call `request_verification_code()`. Do NOT proceed with normal conversation flow until verification completes.
- **When the visitor pastes a code:** call `verify_code(code)`. The visitor's submission may have surrounding text ("here's the code: 123456" or "1 2 3 4 5 6") — extract the 6 digits. If the visitor types a code that's clearly not 6 digits, ask them to try again.
- **On `verify_code` returning `verified: true`:** acknowledge the visitor briefly. The system has loaded the prior conversation into your context — review it and reference one specific thing from it ("Last time we were looking at the dog-walking package — want to pick up there?"). Then answer the visitor's current question naturally. Do NOT recite the entire prior conversation.
- **On `verify_code` returning `verified: false` reason `wrong_code` (under attempt cap):** ask the visitor to double-check the code and try again. Re-call `verify_code` with the new attempt.
- **On `verify_code` returning `verified: false` reason `expired`:** apologize briefly and call `request_verification_code()` again to send a fresh code. Inform the visitor that a new code is on its way.
- **On `verify_code` returning `verified: false` reason `max_attempts`:** call `request_verification_code()` once for a fresh code and ask the visitor to try once more. (The Phase 1 rate limit caps this at 3 codes per session per hour, so spam is bounded.)
- **On `verify_code` returning `verified: false` reason `no_pending_code`:** unusual — likely the code expired or was already used. Call `request_verification_code()` and continue.
- **On repeat failure (visitor exhausts attempts on a fresh code, OR ignores verification entirely for >2 turns):** gracefully give up. Say something natural like "No worries, let's keep going from here." Do NOT mention prior history. Do NOT re-attempt verification. Treat the visitor as new for the rest of the session.
- **Privacy guard:** never echo the verification code in your reply. Never tell the visitor "the code on file is 123456." The code lives in the email; the agent doesn't know it.

**Out of scope for Phase CCI-2b (do not add):**
- Changes to the SendGrid Inbound Parse webhook — Phase 3.
- Email-inbound flow (Case 2/3 dispatch) — Phase 3.
- Per-merchant branded verification email templates — Phase 4.
- Tool-level validation that errors when downstream tools fire without contact-complete data — Phase 4.
- USER_FACT loading from prior sessions into context — explicitly deferred. Profile + last-20-messages is the locked scope.
- USER_CONTACT_INFO loading from prior sessions — current session has its own copy via `collect_contact_info`; no need to load.
- Per-session conversation summarization for long-term memory — deferred to v2.
- Phone-keyed identity (no phone GSI) — future work.
- Re-architecting the cart-handoff URL flow — preserved exactly as today.
- Any changes to `/chat/web/*`, the iframe auth model, or kickoff/onboarding state machines.
- Refactor of existing TS variable names — naming convention applies forward only.
- New Slack alerts. Returning-visitor verification is not a celebration event worth surfacing; the locked rule from Phase 8b-followup (no PII in Slack) applies absolutely.


STEP 1 — ARCHITECTURE PLANNING
Use the arch-planner agent to analyze the codebase and produce a structured implementation plan.

Task specifics for this plan:

1. Read this brief in full. Read `docs/cross-channel-identity/design.md` end-to-end. Read both prior CCI plans (`phase-cci-1-data-model-and-verification-plan.md`, `phase-cci-2a-data-plumbing-plan.md`).

2. Study the existing patterns the new code must mirror or extend:
   - `src/services/chat-session.service.ts handleMessage` — the existing message-array build path. The loader plugs in BEFORE the Claude call. Identify exactly where the message array is assembled today and where to splice the loader.
   - `src/tools/verify-code.tool.ts` — Phase 1's verify_code. Modify to capture the customer's `latest_session_id` BEFORE Write B fires, write it into `metadata.continuation_from_session_id` as part of Write A.
   - `src/services/customer.service.ts` — extend `queryCustomerIdByEmail` to also return `latest_session_id` (change return type to `{ customerUlid: string; latestSessionId: string | null } | null`). Both callers (`verify_code` and `collect_contact_info`) need to keep working — `collect_contact_info` ignores the new field, `verify_code` consumes it.
   - `src/services/identity.service.ts` — initialise `continuation_from_session_id: null` and `continuation_loaded_at: null` in the METADATA write at session creation, alongside the existing `customer_id: null` initialisation.
   - `src/types/ChatSession.ts` — add the two new fields to `ChatSessionMetadataRecord`.
   - `src/agents/lead-capture.agent.ts`, `src/agents/shopping-assistant.agent.ts` — system prompt edits. Add the "RETURNING VISITOR FLOW" section.
   - The CHAT_TURN record schema — confirm via codebase read. Look for whatever service/utility loads the existing session's chat history; the loader follows the same pattern for the prior session's PK.

3. Verify against current code:
   - **Where exactly in `handleMessage` is the message array built?** Identify the exact function/helper. The loader inserts AFTER that function returns the current-session messages and BEFORE Claude is called. Or restructure into `loadCurrentMessages() + loadPriorMessages() + buildMessageArray()`.
   - **Does the existing CHAT_TURN-loading code paginate, or read all at once?** Confirm. The prior-session loader reads at most 20 messages — match the existing semantics or use a `Limit: 20` Query.
   - **What does CustomerService.queryCustomerIdByEmail currently return?** Confirm and design the extension. Both callers must keep working: `collect_contact_info` (Phase 2a) ignores the new latestSessionId; `verify_code` (modified in Phase 2b) reads it.
   - **The framing system message and profile injection — how are system messages structured in the existing message array?** Confirm the pattern. The loader's framing message follows the same shape as any other system message.
   - **The 'continuation_loaded_at' write — does the existing post-turn write block in handleMessage already update METADATA, and can the loader's flag-set be folded in?** If yes, fold; if not, the loader writes its own UpdateCommand.

4. Produce a detailed implementation plan covering ALL of these sections:
   - **Overview** — one paragraph.
   - **Affected files / modules** — comprehensive list.
   - **`continuation_from_session_id` and `continuation_loaded_at` schema additions** — exact field types, initialisation site in identity.service.ts, exact UpdateExpression shape.
   - **`verify_code` modification** — exact change to the Write A UpdateCommand to also write `continuation_from_session_id`. Exact change to `CustomerService.queryCustomerIdByEmail` return type. Confirm `collect_contact_info`'s call site still compiles.
   - **Prior-history loader design** — exact wiring point in handleMessage, exact gate logic, exact prior-session Query (PK, SK, Limit), exact message-array splice order (prior turns → framing system message → profile system message → current turns). Exact text of the framing system message.
   - **Profile injection format** — system message vs. user-context message; exact text template.
   - **System prompt edits** — write the literal "RETURNING VISITOR FLOW" section text. arch-planner authors it; implementer copies verbatim. Include the exact failure-path branching matrix from the locked-contracts section above.
   - **Step-by-step implementation order** — file-by-file. Suggested:
     1. `src/types/ChatSession.ts` — add the two new fields.
     2. `src/services/identity.service.ts` — initialise both as null at creation.
     3. `src/services/customer.service.ts` — extend queryCustomerIdByEmail return type.
     4. `src/services/customer.service.spec.ts` — update tests for the new return shape.
     5. `src/tools/collect-contact-info.tool.ts` — update the queryCustomerIdByEmail call site to ignore the new field (it only needs customerUlid).
     6. `src/tools/collect-contact-info.tool.spec.ts` — update mock returns.
     7. `src/tools/verify-code.tool.ts` — modify Write A to include `continuation_from_session_id` set to captured prior latestSessionId.
     8. `src/tools/verify-code.tool.spec.ts` — update tests to assert the new field write.
     9. `src/services/chat-session.service.ts` — wire the prior-history loader.
     10. `src/services/chat-session.service.spec.ts` — extensive new tests for the loader.
     11. `src/agents/lead-capture.agent.ts`, `src/agents/shopping-assistant.agent.ts` — append the RETURNING VISITOR FLOW section.
     12. Agent spec files — smoke-test that the new section exists and tools are still allowlisted.
   - **Testing strategy:**
     - verify_code: new field writes correctly when customer.latest_session_id is non-null; writes null when prior is null; existing flows still pass.
     - identity.service: METADATA init has both new fields as null.
     - Loader gate: fires when continuation_from_session_id is set AND loaded_at is null; does NOT fire when either condition is unmet.
     - Loader output: prior turns prepended in correct order, framing system message inserted at the correct boundary, profile system message inserted, current turns follow, loaded_at flag is set after fire.
     - Failure path: verify_code returning verified:false → no loader-relevant state changes → next turn loader doesn't fire (continuation_from_session_id is still null).
     - No-prior-session case: customer.latest_session_id was null at verify time → continuation_from_session_id is null → loader never fires.
     - Idempotency: parallel turns don't double-fire the loader (the if_not_exists on continuation_loaded_at catches it; verify via test).
   - **Risks and edge cases:**
     - Race between two parallel verifications in the same session — extremely rare (the agent calls verify_code on a single visitor message), but document.
     - Prior session has fewer than 20 messages — Query returns what's there; loader injects what's available; no padding.
     - Prior session has more than 20 messages — only the last 20; the visitor may have had a long prior conversation but only the recent context is loaded.
     - The framing system message + profile injection adds ~2-3k tokens; the prior 20 turns add up to ~5-7k. Total ~8-10k tokens on the verification turn. Bounded.
     - Customer record was created with profile fields, but the prior session may have had different USER_CONTACT_INFO values (pre-CCI-2a sessions had bare-ULID customer_id; profile may differ). Acceptable per design's "Customer record reflects values at create time."
   - **Out-of-scope confirmations.**

5. Write your plan to `docs/knowledge-base/tasks/phase-cci-2b-chat-side-agent-flow-plan.md`.

6. Return a concise summary (under 800 words) including:
   - Path to the plan file.
   - 6–8 key decisions you made — particularly around (a) the exact wiring point in handleMessage for the loader, (b) profile injection format (system vs. user-context message), (c) handling of the CustomerService return-type change at all call sites, (d) whether continuation_loaded_at uses if_not_exists or a separate post-turn write, (e) the exact text of the framing system message, (f) any CHAT_TURN-schema details that affect the prior-session Query.
   - Risks/unknowns/orchestrator-decision items.

Hard rules for this agent:
- DO NOT commit. DO NOT push. DO NOT run any `git` write command.
- DO NOT read `.env`, `.env.local`, or any `.env.*` file. Only `.env.example` if it exists.
- Pause after producing the plan so the orchestrator can get user approval before Step 2.


STEP 2 — IMPLEMENTATION
Use the code-implementer agent to implement the approved plan.

Implementation details for this task:
- Follow the plan to the letter. The plan locks the exact gate logic, the exact framing system message text, the exact RETURNING VISITOR FLOW prompt section, and the exact field-write semantics on verify_code.
- The CustomerService return-type change is a refactor: BOTH callers must keep working. Verify each call site.
- The loader's wiring in handleMessage must NOT change the existing message-array build for non-continuation turns. Sessions where continuation_from_session_id is null see zero behavior change.
- Run `npm run build` and `npm test` before returning. Report total test count delta.

Implementation requirements:
- follow the plan produced by the arch-planner agent
- modify or create only the necessary files
- respect existing architecture and coding patterns
- focus on correctness first (style will be handled later)

Hard rules for this agent:
- DO NOT commit. DO NOT push. DO NOT run any `git` write command.
- DO NOT read `.env`, `.env.local`, or any `.env.*` file. Only `.env.example` if it exists.


STEP 3 — STYLE REFACTOR
Use the style-refactor agent to refactor per `.claude/instructions/style-enforcer.md`.

Style refactor specifics:
- Bracketed `[key=value]` log format.
- Named constants for: the prior-message Limit (`PRIOR_HISTORY_MESSAGE_LIMIT = 20`), the framing system message text, the profile system message format string.
- TypeScript-side variables use camelCase. New DDB field names use snake_case (`continuation_from_session_id`, `continuation_loaded_at`).
- No `any`, no inline type annotations TypeScript can infer, no dead code, no placeholder comments.
- Result types and the new METADATA fields use the existing domain-prefix convention.

Standing style rules apply (see prior phases' STEP 3 sections).

Hard rules: DO NOT commit/push/git, DO NOT read .env*, DO NOT change functionality.


STEP 4 — TEST EXECUTION
Use the test-suite-runner agent.

Testing context:
- Run `npm run build` first.
- Run `npm test`. Baseline: 545 tests. Phase CCI-2b adds an estimated 25–35 cases. Estimated new total: 570–580.
- Mock all external services. No real network calls.

Hard rules: DO NOT modify source/test, DO NOT commit/push, DO NOT read .env*.


STEP 5 — CODE REVIEW
Use the code-reviewer agent.

Review focus:
- **`continuation_from_session_id` is BARE ULID** (no `CHAT_SESSION#` prefix). Matches the convention for `latest_session_id` on the Customer record.
- **`verify_code` writes `continuation_from_session_id` ATOMICALLY with `customer_id`** in the same UpdateCommand. Confirm.
- **The loader gate has BOTH conditions** (`continuation_from_session_id !== null` AND `continuation_loaded_at === null`). Confirm both checked.
- **`continuation_loaded_at` write uses `if_not_exists`** to handle race between parallel turns. Confirm.
- **Visitor profile + framing context appear in the Anthropic `system` parameter, NOT in the messages array.** The system parameter is passed as an array of two text content blocks: static base prompt (with `cache_control: { type: "ephemeral" }`) + dynamic visitor-context block. Confirm by reading the Anthropic SDK call site.
- **Messages array contains ONLY real visitor/agent turns.** No synthetic role:user metadata injections. No "VISITOR PROFILE:" or "The visitor returned today..." strings appear as user-role messages. Confirm.
- **Prior session messages prepended in chronological order** (oldest first, newest last) ahead of the current-session history. Confirm by reading the spliced array order.
- **System prompt RETURNING VISITOR FLOW section** is present in BOTH agents and contains the locked failure-path branching matrix. Confirm by reading both prompts.
- **No PII in logs.** New code logs sessionUlid, accountUlid, errorType, event categories. Email, plaintext code, customer name — none in logs.
- **No new Slack alerts.** Search for SlackAlertService imports in new code; flag if found.
- **Per-account isolation unaffected.** The prior session referenced is always under the same account as the current session.
- **CustomerService.queryCustomerIdByEmail return-type change does not break collect_contact_info.** The trio-completion gate and lookupOrCreateCustomer logic are unchanged.
- **Out-of-scope respected:** no SendGrid Inbound Parse changes, no email-inbound flow changes, no per-merchant branded templates, no tool-level Phase 4 validation, no USER_FACT loading, no /chat/web/* changes, no new Slack alerts.

Hard rules: DO NOT commit/push/git, DO NOT read .env*, DO NOT modify source.
