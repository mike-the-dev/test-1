TASK OVERVIEW
Task name: Phase CCI-3 — Cross-channel identity: email-inbound continuation

Objective:
Bring returning-visitor recognition to the email channel. Today, every fresh email arriving via SendGrid Inbound Parse follows Case 1 (extract a session ULID from the recipient's local-part, route the message to that session). Phase 3 adds a dispatcher that runs BEFORE Case 1's session-extraction logic and discriminates on the local-part of the recipient address. Three branches:

1. **`to.localPart matches /^[0-9A-HJKMNP-TV-Z]{26}$/`** — Case 1 (continuation; existing flow, unchanged). The visitor replied to one of our outbound encoded-address emails. Extract the ULID, route to that session.

2. **`to.localPart === "assistant"`** — Case 2/3 (entry/re-entry). The visitor sent a fresh email to the global `assistant@reply.<merchant>.com` entry address. Look up the sender's email against the Customer GSI:
   - **Case 2 (unknown sender):** create a new session under this account, treat as new visitor. Existing new-session behavior on the chat side; just plumbed into the email path.
   - **Case 3 (known customer):** apply the 7-day freshness check against the customer's `latest_session_id`:
     - **Fresh (`< 7 days old`):** append the email as a new turn in that existing session. Agent already has full session history (it IS the same session) — replies in-line. No history loading needed.
     - **Stale or null (`≥ 7 days old or null`):** create a NEW chat session under this account. Set `metadata.customer_id = "C#" + customerUlid` immediately (channel-level trust via SPF/DKIM — no verification flow needed). Set `metadata.continuation_from_session_id = <prior latest_session_id>` so the Phase 2b prior-history loader fires on the agent's first response turn. Update `customer.latest_session_id` to the new session.

3. **`to.localPart` anything else** — reject/log a warning. Unrecognised entry pattern. No session created. No reply sent.

Outbound replies from any of the above paths use the existing encoded address `<sessionUlid>@reply.<merchant>.com`. The visitor's next reply naturally routes via Case 1.

When this phase is done:
- A new dispatcher method (or new service — arch-planner picks the cleanest pattern) sits at the front of the existing inbound-parse handler in `src/services/email-reply.service.ts`. It reads the recipient's local-part, classifies as ULID / assistant / other, and routes to the appropriate handler. Existing Case 1 logic is preserved verbatim — just moved one layer down.
- The literal entry-word constant is `ASSISTANT_ENTRY_LOCAL_PART = "assistant"`. Globally identical across all merchants. The reply subdomain `reply.<merchantDomain>` continues to vary per merchant (configured during onboarding; the existing infrastructure already handles per-merchant routing).
- Account scoping for Case 2/3 lookup: the recipient's domain part (`reply.<merchantDomain>`) maps to an `accountUlid`. The existing email-reply infrastructure already does this lookup for Case 1 — Phase 3 reuses the same path. Confirm during arch-planner.
- Case 2 (unknown sender): a new session is created with no `customer_id` set. The visitor flows through the standard onboarding path on first agent reply.
- Case 3 fresh: the inbound email is appended as a new turn under the existing session's PK. The session's last-active timestamp updates (via the existing `_lastUpdated_` write that every turn already does). `customer.latest_session_id` is already pointing at this session by construction — no change. No prior-history loading (it IS the same session).
- Case 3 stale: a new session is created with `metadata.customer_id` set immediately to the prefixed `C#<customerUlid>` form, `metadata.continuation_from_session_id` set to the customer's CURRENT `latest_session_id` value (the prior session — captured BEFORE the per-turn write moves the pointer to the new session), and `metadata.continuation_loaded_at` initialised null. Phase 2b's existing prior-history loader fires on the agent's first response turn for this session — no new loader code needed.
- The 7-day freshness check uses the session's `_lastUpdated_` timestamp (every turn writes this; covered by existing infrastructure). Fetch the prior session's METADATA, parse `_lastUpdated_`, compare to `Date.now()`. If `(now - _lastUpdated_) < 7 days` → fresh; else stale. The exact constant: `EMAIL_CONTINUATION_FRESHNESS_WINDOW_MS = 7 * 24 * 60 * 60 * 1000`.
- Outbound replies from agent turns continue to use the encoded address `<sessionUlid>@reply.<merchant>.com`. Phase 3 verifies this happens for new-session-from-Case-3 paths but does NOT modify the outbound infrastructure.
- 25–35 new tests cover: webhook discriminator (ULID match → Case 1 routed unchanged; "assistant" match → Case 2/3 routed; other → rejected), Case 2 (unknown sender, new session created without customer_id), Case 3 fresh (inbound appended to existing session, no continuation fields touched), Case 3 stale (new session with all three METADATA fields set correctly, continuation_from_session_id captures prior latest_session_id BEFORE the per-turn write), the freshness boundary case (exactly 7 days old → boundary picked one way, document which), the customer-not-found path within "assistant" branch (treats as Case 2), and the rejected-local-part path.
- Build clean. Existing email-reply tests pass unchanged.

Relevant context:
- The full design spec is `docs/cross-channel-identity/design.md`. Re-read sections "Email-inbound flow" and "Email addressing — entry vs continuation" — the locked decisions on freshness window, entry word, and per-merchant subdomain are all there.
- CCI-1 plan covers `verify_code`'s METADATA writes. Phase 3 reuses the same field formats (prefixed `C#<customerUlid>` for customer_id, bare ULID for continuation_from_session_id).
- CCI-2a plan covers `CustomerService.queryCustomerIdByEmail` (returns `{ customerUlid, latestSessionId } | null`). Phase 3 calls it directly to look up senders.
- CCI-2b plan covers the prior-history loader. Phase 3 does NOT modify the loader — it just sets the METADATA fields the loader reads from.
- `src/services/email-reply.service.ts` is the file with the largest change. It currently handles Case 1 (extract session ULID from local-part, route to session). Phase 3 inserts a dispatcher in front. Read every line — every existing test must continue to pass.
- The existing email-reply path:
  - SendGrid Inbound Parse webhook hits a controller endpoint
  - Controller calls `EmailReplyService.handleInboundEmail(formFields)` (or similar — confirm name)
  - The service extracts the To address, parses out the local-part, looks up the session by ULID
  - Persists the email body as a new turn under that session
  - Triggers the agent to generate a reply
- Phase 3's dispatcher inserts before the session-by-ULID lookup. After the dispatcher routes to Case 1, the existing logic runs unchanged.
- Per-account isolation invariant unchanged. Customer-by-email lookup is account-scoped via GSI1 (existing). Sessions remain account-scoped. No cross-account paths.

Key contracts (locked from the design and brief):

**Local-part discrimination — locked:**
- ULID-shaped (regex `/^[0-9A-HJKMNP-TV-Z]{26}$/`, Crockford's base32) → Case 1.
- Literal string `"assistant"` (case-sensitive — confirm with arch-planner; recommend case-insensitive for safety) → Case 2/3 dispatch.
- Anything else → reject + log `[event=email_inbound_unrecognized_local_part to=<full>... ]`. No session created. No outbound reply.

**Entry word — locked:**
- Single global string `"assistant"` for v1. Per-merchant custom entry addresses (e.g., `chat@<merchant>.com`) are deferred to v2.

**Freshness window — locked:**
- 7 days, measured from the prior session's `_lastUpdated_` timestamp.
- Boundary case: exactly 7 days = stale (fresh requires strictly less than 7 days). Document the choice in the plan; cite the rationale (no real difference, just need a single side of the boundary).

**Case 2 (unknown sender) — locked:**
- Existing new-session creation pattern (use the existing chat-side path). No `customer_id` set on creation. The visitor goes through normal onboarding on first agent reply.
- The sender's email is captured into `USER_CONTACT_INFO` for the new session (so the trio-completion gate from CCI-2a can fire when first/last names also arrive).

**Case 3 fresh — locked:**
- Append the inbound message to the existing session. PK = `CHAT_SESSION#<latest_session_id>`, SK = `MESSAGE#<...>` (matching the existing per-turn persistence pattern). The existing per-turn `_lastUpdated_` write covers everything.
- No continuation fields written — it's the same session, no history loading needed.

**Case 3 stale — locked:**
- New session creation. ALL of the following set in the same UpdateCommand on METADATA at session-creation time (or the closest equivalent — arch-planner picks the cleanest atomic shape):
  - `customer_id = "C#" + customerUlid`
  - `continuation_from_session_id = <captured prior latest_session_id BEFORE any per-turn write>`
  - `continuation_loaded_at = null`
- The captured `prior latest_session_id` is the value `customer.latest_session_id` held at the moment the dispatcher decided "stale" — read it once, hold the value through the new-session creation, write it into METADATA.
- `customer.latest_session_id` is updated to the new session ID via the existing per-turn write infrastructure on the FIRST assistant response turn (the same write Phase 1 added; it fires whenever `customer_id` is non-null on METADATA).
- The Phase 2b prior-history loader fires on the agent's first response turn. NO loader code changes in Phase 3.

**Outbound reply addressing — verify, no change:**
- Agent replies use `<sessionUlid>@reply.<merchant>.com` (existing). Phase 3 verifies this works for new-session-from-Case-3 paths (it should; the outbound infrastructure doesn't care which path created the session). No code changes to the outbound path.

**Out of scope for Phase CCI-3 (do not add):**
- Per-merchant custom entry addresses (e.g., `chat@<merchant>.com`) — v2.
- DNS / SendGrid Inbound Parse configuration changes — operational, not code-side. Document the required DNS/SendGrid setup in the plan as a deployment note, not as code work.
- Outbound email infrastructure changes — Phase 3 verifies but does not modify.
- Phone-keyed identity for SMS — future work.
- USER_FACT loading from prior sessions — explicitly deferred (Phase 4 polish or beyond).
- Branded merchant-aware verification email templates — Phase 4.
- Tool-level Zod validation hardening — Phase 4.
- Any change to `/chat/web/*`, the iframe auth model, or the conversation runtime path beyond the scope above.
- Refactor of existing TS variable names — naming convention applies forward only.
- New Slack alerts. Customer-recognition-via-email is not a celebration event worth surfacing; the locked rule from Phase 8b-followup (no PII in Slack) applies absolutely.


STEP 1 — ARCHITECTURE PLANNING
Use the arch-planner agent to analyze the codebase and produce a structured implementation plan.

Task specifics for this plan:

1. Read this brief in full. Read `docs/cross-channel-identity/design.md` end-to-end (the email-inbound section is the authoritative spec). Read all three prior CCI plans to understand the conventions and field formats Phase 3 reuses.

2. Study the existing patterns the new code must mirror or extend:
   - `src/services/email-reply.service.ts` — the existing inbound-parse handler. The dispatcher inserts before the session-by-ULID lookup. Read every line. Identify the exact entry method, the exact line where the local-part is extracted today, the exact downstream logic that becomes Case 1.
   - `src/services/customer.service.ts` — `queryCustomerIdByEmail` is the lookup Phase 3 calls in the "assistant" branch. Returns `{ customerUlid, latestSessionId } | null`.
   - `src/services/identity.service.ts` — new-session creation logic. Phase 3's Case 2 and Case 3-stale both create new sessions. Confirm the existing path supports passing in `customer_id` and `continuation_from_session_id` at creation time, OR identify where to add the option. The existing METADATA-creation UpdateCommand should accept these fields as part of the initial write.
   - `src/services/chat-session.service.ts` — the prior-history loader from Phase 2b. Confirm Phase 3's METADATA writes (continuation_from_session_id, continuation_loaded_at) trigger the loader correctly on the first assistant response turn.
   - The existing email-reply controller / webhook entrypoint (find via grep) — Phase 3 does NOT modify the controller; the dispatcher lives one level deeper in the service.

3. Verify against current code:
   - **Where exactly does the existing email-reply path extract the local-part today?** Identify the line and the variable.
   - **Where does the existing path look up the session by ULID?** Identify the function and the failure path (what happens when no session is found today — does it reject/error, or fall through?). Phase 3's "anything else" branch should match the existing reject/log pattern.
   - **How does the existing path map `reply.<merchantDomain>` to `accountUlid`?** Critical for Case 2/3 — we need the accountUlid to scope the customer-by-email lookup. If the existing path does this lookup, Phase 3 reuses it. If not, we need to add it.
   - **Does the existing new-session creation path support setting `customer_id` and `continuation_from_session_id` at creation time?** Phase 3 wants to write all three METADATA fields atomically (customer_id, continuation_from_session_id, continuation_loaded_at) at the moment a Case 3-stale session is created. Identify the cleanest extension point.
   - **What does the existing inbound-message-persistence path look like (the code that writes the email body as a new turn)?** Confirm the pattern (PK, SK shape, role assignment for inbound visitor messages). Phase 3 reuses this pattern directly for Case 3 fresh; it ALSO drives the new-session-then-add-first-message flow for Case 2 and Case 3 stale.
   - **What's the SendGrid webhook signature / verification mechanism in the controller?** Confirm Phase 3 doesn't bypass it. The dispatcher runs AFTER signature verification.

4. Produce a detailed implementation plan covering ALL of these sections:
   - **Overview** — one paragraph.
   - **Affected files / modules** — comprehensive list (created vs modified vs review-only).
   - **Local-part dispatcher design** — exact location (top of `handleInboundEmail` or a new method `dispatchInboundEmail`?), exact regex for ULID match, exact case-sensitivity decision for the "assistant" string, exact reject log format. Show the dispatch shape — switch/case, if/else chain, or returning an enum from a classifier. Recommend a `LocalPartClassification` enum (`SESSION_ULID | ASSISTANT_ENTRY | UNRECOGNIZED`) and a small classifier method, then the main handler routes on it.
   - **Case 2 handler design** — exact method name, exact new-session-creation call path, exact USER_CONTACT_INFO write shape (capture sender's email).
   - **Case 3 handler design** — exact method name. Three sub-steps: (a) call `CustomerService.queryCustomerIdByEmail(accountUlid, sender.email)`, (b) on null return → fall through to Case 2 logic; on hit → continue, (c) freshness check against prior session's `_lastUpdated_`. Two sub-handlers: `attachToExistingSessionFresh` and `createNewSessionLinkedToCustomer`.
   - **Freshness check mechanic** — exact GetCommand on prior session's METADATA, exact ISO parsing, exact comparison constant `EMAIL_CONTINUATION_FRESHNESS_WINDOW_MS = 7 * 24 * 60 * 60 * 1000`. Document the boundary decision (exactly 7 days = stale).
   - **`createNewSessionLinkedToCustomer` design** — exact METADATA UpdateCommand shape that writes customer_id, continuation_from_session_id, continuation_loaded_at, and other initial-session fields atomically. The captured `prior latestSessionId` is the value held when the dispatcher chose "stale" — pass it through.
   - **`attachToExistingSessionFresh` design** — appends the inbound message to the existing session as a new turn. Reuses the existing per-turn persistence pattern. No customer_id or continuation_* writes (they're already set on that session OR they're not relevant for same-session continuation).
   - **Step-by-step implementation order** — file-by-file. Suggested:
     1. Constants + types (regex, freshness window, classification enum) in the appropriate types file.
     2. Local-part classifier method.
     3. Dispatcher entry point in `email-reply.service.ts`.
     4. Case 2 handler (unknown / new session).
     5. Case 3 handlers (fresh-attach and new-linked).
     6. Freshness check helper.
     7. Reject branch (logging + metric).
     8. Tests for each branch.
   - **Testing strategy** — exact test cases per branch:
     - Local-part classifier: ULID match (26 Crockford chars), "assistant" exact match (case sensitivity per arch-planner's call), "ASSISTANT" (verify decision), "" (empty), "<garbage>", "<26 chars but not Crockford>".
     - Dispatcher routing: ULID → calls Case 1 handler; "assistant" → calls Case 2/3 handler; unrecognized → reject path.
     - Case 2: unknown sender → new session created without customer_id; sender's email saved to USER_CONTACT_INFO; agent gets normal onboarding flow.
     - Case 3 fresh: known sender, latest_session_id < 7 days old → message appended to existing session; no new session created; no continuation_* writes.
     - Case 3 stale: known sender, latest_session_id ≥ 7 days old → new session created; metadata.customer_id = "C#abc123" (prefixed); metadata.continuation_from_session_id = prior session ULID (bare); metadata.continuation_loaded_at = null; Phase 2b loader will fire on agent's first reply (verify via integration-style test or document as integration-tested).
     - Case 3 customer-not-found edge: "assistant" entry but sender's email isn't in Customer GSI for this account → falls back to Case 2 (new session, no customer link). Verify path.
     - Boundary: exactly 7 days old → stale (or fresh; document choice and assert).
     - Reject path: random local-part → no session created, no DB writes, warning logged.
   - **Risks and edge cases:**
     - Race between two simultaneous inbound emails for the same customer (rare but possible): both read same `latest_session_id`, both decide stale, both create new sessions. The customer ends up with two sessions linked to them. The customer.latest_session_id ends up pointing at one of them (last writer wins). Acceptable per design's "minor latest ambiguity is fine for v1." Document.
     - Visitor sends fresh email exactly at the 7-day boundary mark — the boundary decision is documented; the test asserts the documented behavior.
     - Visitor sends fresh email but their `customer.latest_session_id` was pointing at a session that has since been deleted/expired. The freshness check would error on the GetCommand. Treat as stale and fall through to new-session-linked path. Document.
     - Visitor's account has been disabled/deleted between sessions. The accountUlid lookup fails. Reject the email. Log. (Existing Case 1 likely already handles this; verify.)
     - The SendGrid webhook payload may have multiple recipients in `to` (CC, BCC, multiple). Document how the dispatcher handles this. Recommend: only the first/primary `to` address is used for routing; CC/BCC ignored.
     - The "assistant" entry word arrives with surrounding whitespace or capitalization — the classifier handles it (recommend `.trim().toLowerCase() === ASSISTANT_ENTRY_LOCAL_PART`).
   - **Out-of-scope confirmations** — recap from this brief.
   - **Deployment note** — DNS / SendGrid Inbound Parse configuration required to receive emails at `assistant@reply.<merchantDomain>`. Per-merchant onboarding already configures the reply subdomain MX records pointing at SendGrid; the new "assistant" local-part doesn't require any per-merchant DNS change (it's just another local-part on the same domain). Document so operators have a checklist.

5. Write your plan to `docs/knowledge-base/tasks/phase-cci-3-email-inbound-continuation-plan.md`.

6. Return a concise summary (under 800 words) covering:
   - Plan file path.
   - 6–8 key decisions you made — the dispatcher shape, case sensitivity of "assistant", boundary decision on the 7-day check, fallback when customer-not-found inside the "assistant" branch, where the accountUlid mapping comes from, atomicity of the Case 3-stale METADATA writes.
   - Risks/unknowns/orchestrator-decision items.

Hard rules for this agent:
- DO NOT commit. DO NOT push. DO NOT run any `git` write command.
- DO NOT read `.env`, `.env.local`, or any `.env.*` file. Only `.env.example` if it exists.
- Pause after producing the plan so the orchestrator can get user approval before Step 2.


STEP 2 — IMPLEMENTATION
Use the code-implementer agent to implement the approved plan.

Implementation details for this task:
- Follow the plan to the letter. The plan locks the dispatcher shape, the classifier behavior, the freshness check constant, and the Case 3-stale METADATA write atomicity.
- Existing Case 1 logic must be preserved exactly. Existing email-reply tests must pass unchanged.
- The captured `prior latestSessionId` for Case 3-stale must be the value held at decision time — passed through to the new-session creation. Do NOT re-fetch the customer record after the per-turn write fires (which would return the new session's ID, not the prior one).
- Run `npm run build` and `npm test` before returning. Report total test count delta.

Implementation requirements:
- follow the plan produced by the arch-planner agent
- modify or create only the necessary files
- respect existing architecture and coding patterns
- focus on correctness first (style will be handled later)

Hard rules for this agent:
- DO NOT commit. DO NOT push. DO NOT run any `git` write command.
- DO NOT read `.env`, `.env.local`, or any `.env.*` file.


STEP 3 — STYLE REFACTOR
Use the style-refactor agent per `.claude/instructions/style-enforcer.md`.

Style refactor specifics:
- Bracketed `[key=value]` log format.
- Named constants: `ASSISTANT_ENTRY_LOCAL_PART`, `EMAIL_CONTINUATION_FRESHNESS_WINDOW_MS`, ULID regex if not already a shared constant.
- Domain-prefixed type names for any new types in `src/types/EmailReply.ts` or wherever email-reply types live.
- TypeScript-side variables use camelCase. New DDB field names (none new in this phase) would use snake_case.
- No `any`, no inline type annotations TypeScript can infer, no dead code, no placeholder comments.

Standing style rules apply.

Hard rules: DO NOT commit/push/git, DO NOT read .env*, DO NOT change functionality.


STEP 4 — TEST EXECUTION
Use the test-suite-runner agent.

Testing context:
- Run `npm run build` first.
- Run `npm test`. Baseline: 579 tests. Phase CCI-3 adds an estimated 25–35 cases. Estimated new total: ~605–615.
- Mock all external services (SendGrid webhook payloads, DDB, etc.). No real network calls.

Hard rules: DO NOT modify source/test, DO NOT commit/push, DO NOT read .env*.


STEP 5 — CODE REVIEW
Use the code-reviewer agent.

Review focus:
- **Local-part classifier handles the three branches correctly.** ULID regex matches exactly the Crockford-base32 26-character format. "assistant" string match matches per the chosen case-sensitivity decision. Anything else falls into the reject branch.
- **Existing Case 1 logic is preserved exactly.** The dispatcher inserts before the session-by-ULID lookup; once it routes to Case 1, the existing path runs unchanged. Existing email-reply tests pass.
- **Case 3-stale METADATA writes are ATOMIC.** customer_id (prefixed `C#<ulid>`), continuation_from_session_id (bare ULID of prior session), and continuation_loaded_at (null) all written in the same UpdateCommand or the same logical creation step. Confirm.
- **The captured prior latestSessionId is held through to the new-session creation** — not re-fetched after the per-turn write would have updated it. Race: the per-turn write fires AFTER the new session's first agent reply, not at session creation. So the captured value is safe. Verify the implementer didn't accidentally re-read.
- **Customer-not-found inside "assistant" branch falls through to Case 2.** Returns null from queryCustomerIdByEmail → new session created without customer_id. No partial writes.
- **Freshness check uses the prior session's `_lastUpdated_` field correctly.** The boundary decision (exactly 7 days = stale or fresh) is consistent with what the test asserts and what the plan documented.
- **The Phase 2b prior-history loader still fires correctly for Case 3-stale sessions.** This requires no Phase 3 code change to chat-session.service.ts — the loader fires whenever continuation_from_session_id is non-null on the next assistant turn. Verify by reading the relevant test.
- **Outbound reply addressing unchanged.** New sessions from Case 3 use the encoded `<sessionUlid>@reply.<merchant>.com` exactly like every other session. No special case in the outbound path.
- **Per-account isolation is unaffected.** Customer-by-email lookup is account-scoped via GSI1. Sessions remain account-scoped. The accountUlid mapping from the recipient domain is reused from the existing email-reply path.
- **No PII in logs.** New code logs sessionUlid, accountUlid, errorType, event categories. Sender email, customer name — none in logs.
- **No new Slack alerts.** Search for SlackAlertService imports in new code; flag if found.
- **Out-of-scope respected** — no per-merchant custom entry addresses, no DNS config changes (deployment note only), no outbound email infrastructure changes, no SMS/phone primitives, no USER_FACT loading, no branded templates, no `/chat/web/*` changes.

Review requirements: verify correctness, alignment with the plan, maintainability/security/performance, ensure style refactor didn't alter functionality.

Hard rules: DO NOT commit/push/git, DO NOT read .env*, DO NOT modify source.
