TASK OVERVIEW
Task name: Phase CCI-1 — Cross-channel identity: data model + verification primitives

Objective:
Lay the structural foundation for cross-channel identity & session continuation by adding the two linkage fields, the new `VERIFICATION_CODE` record type, and the two agent-callable primitives (`request_verification_code`, `verify_code`) that future phases will compose into the chat-side verification flow. This phase ships the moving parts in isolation. No agent system prompts change. No `collect_contact_info` lookup side-effect. No SendGrid Inbound Parse webhook discrimination. No prior-history context loader. Those each ship in later phases.

When this phase is done:
- A new `customer_id` field exists on the `CHAT_SESSION#<ulid> / METADATA` record. Initialised as `null` on session creation. Set to a non-null `C#<customerUlid>` value by the new `verify_code` tool on successful verification. No other code path writes it in Phase 1.
- A new `latest_session_id` field exists on the `C#<customerUlid>` Customer record. Initialised as `null` when a Customer is first created. Updated to point at the active session whenever an assistant turn is produced FOR a session whose `customer_id` is non-null. Sessions with no linked customer do not touch this field.
- A new `VERIFICATION_CODE` record type lives at `CHAT_SESSION#<ulid> / VERIFICATION_CODE`, holding `code_hash` (SHA-256 of the 6-digit numeric), `email` (the address being verified), `expires_at` (ISO 8601, 10 minutes from issuance), `attempts` (counter, locks at 5), `request_count_in_window` and `request_window_start_at` (rate-limit counters; see below), `ttl` (DDB TTL epoch seconds), and `_createdAt_` / `_lastUpdated_`.
- Two new agent-callable tools follow the existing `ChatTool` pattern, are wired into the tool registry, and are reachable by both `lead_capture` and `shopping_assistant` agents (allowlisted in their agent configs but NOT yet referenced by their system prompts — that's Phase 2).
- One new outbound email goes through `EmailService.send` with a plain (non-branded, non-merchant-customised) HTML template containing the 6-digit code and the 10-minute expiry. Branded per-merchant templating is deferred to Phase 4.
- Existing tests pass. New tests cover: hashing/storage, expiry, attempts cap, single-use deletion, rate-limit enforcement, email send failure path, customer-id linkage on verification success, latest-session-id update path, and the tool I/O contracts.

Relevant context:
- The full design spec is `docs/cross-channel-identity/design.md` (366 lines, authoritative). Read it in full before planning.
- The Customer record + GSI1 already exist (`src/tools/preview-cart.tool.ts:580–625`). Customer creation today happens at cart-preview time. **Phase 1 does NOT lift Customer creation upstream.** That's deferred to Phase 2 alongside the `collect_contact_info` lookup side-effect, which is the natural carrier for that change. Phase 1 only adds the `latest_session_id` field to the existing schema.
- Session METADATA writes happen in `src/services/identity.service.ts` (creation + updates) and `src/services/chat-session.service.ts` (kickoff/onboarding state, accountUlid backfill). The `customer_id` field needs to be: (a) initialised as `null` at the creation site in `identity.service.ts`, (b) updated to a non-null value by the new `verify_code` tool, (c) read by whichever assistant-turn path drives the `latest_session_id` update on the Customer record.
- `EmailService.send` (`src/services/email.service.ts`) is the single outbound sender. Signature: `{ to, subject, body, sessionUlid }`; `body` is HTML; `from` is auto-set to `<sessionUlid>@<SENDGRID_REPLY_DOMAIN>` per the existing reply-routing convention. The verification email reuses this exact send path — no new infra. If the visitor replies to a verification email, the reply naturally routes via the existing Case 1 mechanism. That's desirable, not a bug.
- Tool pattern reference: `src/tools/save-user-fact.tool.ts` is the closest shape — small, single-responsibility, DDB-backed, returns a structured result. Tool input schemas live in `src/validation/tool.schema.ts`. Tool types live in `src/types/Tool.ts`.
- Tools are registered via the `@ChatToolProvider()` decorator and discovered through `tool-registry.service.ts`. The two new tools must be discoverable through the same path. Per-agent allowlists live in the agent definitions (`src/services/*-agent.ts` or equivalent — arch-planner confirms the exact location); both new tools go on `lead_capture` and `shopping_assistant` allowlists.
- Per-account isolation invariant is unchanged. Verification codes are scoped to a single session under `CHAT_SESSION#<ulid>`; the customer-id set on verification success references the same account-scoped Customer record (via `C#<customerUlid>`); no cross-account paths.
- DDB TTL: confirm whether the conversations table has TTL enabled and what the field name is (likely `ttl`, but verify against the existing schema definition in `src/entities/` or `src/providers/dynamodb.provider.ts`). If not enabled, arch-planner flags it as a question to resolve before implementation. Application logic ALWAYS validates `expires_at` independently — `ttl` is a reaper, never the authoritative check.

Key contracts (locked by the user during design — do not relitigate):

**Naming convention — locked:**
- New DDB fields and new typed tool inputs use `_id` / `Id`. Never `_ulid` / `Ulid`.
- Existing TS variable names (`sessionUlid`, etc.) are not refactored — naming convention applies forward only.

**Verification code mechanics — locked:**
| Property | Value |
|---|---|
| Format | 6-digit numeric (zero-padded, range `000000`–`999999`) |
| TTL | 10 minutes from issuance |
| At-rest | SHA-256 hash only — plaintext never written to DDB |
| Storage | `CHAT_SESSION#<ulid> / VERIFICATION_CODE` (single record per session) |
| Attempts cap | 5 wrong attempts per code; record locks (no further verifies accepted) |
| On new request (latest-wins) | Overwrites prior pending VERIFICATION_CODE for the session in place |
| On success | Record is deleted (single-use; prevents replay) |
| Auto-cleanup | DDB TTL field; epoch seconds; application logic still validates `expires_at` |

**Re-request rate limit — baked into Phase 1:**
- 3 successful `request_verification_code` calls per session per rolling 1-hour window.
- Implemented as two counter fields on the same `VERIFICATION_CODE` record: `request_count_in_window` (integer) and `request_window_start_at` (ISO 8601). On each `request_verification_code` call: if `now - request_window_start_at > 1 hour`, reset window and counter to 1. Else increment; if increment would exceed 3, return `{ sent: false, reason: "rate_limited" }` WITHOUT sending an email or overwriting the existing code.
- Edge case: when the prior VERIFICATION_CODE record was deleted by a successful `verify_code` (single-use), the next `request_verification_code` for the session has no record to read — the rate-limit window starts fresh. This is acceptable: a successful verify is a "good" event; the cap protects against repeated FAILED rounds. arch-planner: confirm and document this semantics in the plan.

**Tool contracts — locked:**

```ts
// request_verification_code
// Input: {} (the email being verified comes from session context — read from CHAT_SESSION#<ulid> / USER_CONTACT_INFO,
//             which is already populated by collect_contact_info before this tool is called)
// Output:
//   | { sent: true }
//   | { sent: false, reason: "no_email_in_session" }   // USER_CONTACT_INFO has no email field saved
//   | { sent: false, reason: "rate_limited" }          // 3 requests in last hour for this session
//   | { sent: false, reason: "send_failed" }           // EmailService threw; record NOT written
request_verification_code(): RequestVerificationCodeResult

// verify_code
// Input: { code: string } — the 6-digit numeric the visitor pasted
// Output:
//   | { verified: true, customerId: string }            // hash matched; record deleted; session.customer_id set;
//                                                        // customer.latest_session_id set; lookup-by-email returns the customerId
//   | { verified: false, reason: "no_pending_code" }    // no VERIFICATION_CODE record exists for this session
//   | { verified: false, reason: "expired" }            // record exists but expires_at < now
//   | { verified: false, reason: "max_attempts" }       // attempts >= 5; record stays in place but is locked
//   | { verified: false, reason: "wrong_code" }         // hash mismatch; attempts incremented; record stays
verify_code(code: string): VerifyCodeResult
```

**Verification email template — Phase 1 (plain, non-branded):**
- From: `<sessionUlid>@<SENDGRID_REPLY_DOMAIN>` (auto-set by `EmailService.send`).
- Subject: `"Your verification code"`.
- Body (HTML): a minimal greeting line, the 6-digit code rendered prominently (e.g., `<h2>` with monospace styling), an expiry line ("This code expires in 10 minutes"), and a single line of plain text disclaiming "If you didn't request this, ignore this email." No merchant logo, no merchant name, no per-merchant copy. Branded templates pulled from the account record are explicitly Phase 4.
- arch-planner: write the exact HTML in the plan; the implementer copies verbatim.

**Customer record `latest_session_id` write path — locked:**
- Updated whenever an assistant turn is produced FOR a session whose `metadata.customer_id` is non-null.
- arch-planner identifies the exact write site (likely a method on `chat-session.service.ts` or an equivalent assistant-turn persistence path; confirm by reading the codebase).
- The update is idempotent (same value re-written is a no-op) and last-writer-wins (per the design's accepted "minor latest ambiguity is fine for v1").
- Sessions with `customer_id === null` do NOT trigger this write. Verify by guard at the call site, not by upstream assumption.

**Out of scope for Phase CCI-1 (do not add):**
- The `collect_contact_info` email-lookup side-effect — Phase 2.
- Updates to `lead_capture` or `shopping_assistant` system prompts to instruct WHEN to call the new tools — Phase 2.
- The prior-history context loader (loads last 20–30 messages from `customer.latest_session_id` into the agent's context post-verification) — Phase 2.
- Any change to the SendGrid Inbound Parse webhook — Phase 3.
- Per-merchant branded verification email templates — Phase 4.
- Lifting Customer creation upstream from `preview_cart` to email-capture — Phase 2.
- Any new GSI on the Customer record — explicitly deferred (v1 needs only the most-recent-session lookup, which is O(1) via the new field).
- SMS / phone verification primitives — future work, architectural readiness only.
- Any change to `/chat/web/*`, the iframe auth model, or the conversation runtime path beyond the field additions specified above.
- Any change to existing TS variable names (no refactor of `sessionUlid` and friends).
- Any Slack alert touching customer PII — locked rule from Phase 8b-followup; the new tools must not fire any Slack alert that includes the email, code, customer name, or any other PII. If alerts are wanted at all in Phase 1 (probably not), they go to Sentry as breadcrumbs only.


STEP 1 — ARCHITECTURE PLANNING
Use the arch-planner agent to analyze the codebase and produce a structured implementation plan.

Task specifics for this plan:

1. Read this brief in full. Read `docs/cross-channel-identity/design.md` end-to-end (it is the authoritative spec). Read `docs/knowledge-base/HANDOFF.md` for the orchestration contract. Skim `docs/journal.md` 2026-04-29 entry for context on how the design was reached.

2. Study the existing patterns the new code must mirror or extend:
   - `src/tools/save-user-fact.tool.ts` — closest shape for the two new tools (DDB-backed, single-responsibility, uses `ChatToolProvider`, returns structured `ChatToolExecutionResult`).
   - `src/tools/preview-cart.tool.ts:580–625` — existing Customer record creation. The `latest_session_id` field is added to the schema produced here AND must default to `null` for newly created customers.
   - `src/services/identity.service.ts` — session METADATA creation + updates. The `customer_id` field is initialised here.
   - `src/services/chat-session.service.ts` — session METADATA mutation paths and (most likely) the assistant-turn persistence path that drives the `latest_session_id` update on the Customer record. Confirm the exact write site.
   - `src/services/email.service.ts` — outbound email sender used by the verification email path.
   - `src/validation/tool.schema.ts` — where the input schemas for both new tools land.
   - `src/types/Tool.ts` — the `ChatTool` / `ChatToolExecutionContext` / `ChatToolExecutionResult` interfaces the tools implement.
   - `src/types/` — new types file(s) for `RequestVerificationCodeResult`, `VerifyCodeResult`, `VerificationCodeRecord`, etc. Suggest a single `src/types/Verification.ts`.
   - `src/tools/tool-registry.service.ts` — tool discovery; confirm the `@ChatToolProvider()` decorator wires tools in automatically and whether any per-agent allowlist file needs updating.
   - `src/providers/dynamodb.provider.ts` (or `src/entities/`) — confirm the conversations table's TTL configuration (field name, whether enabled).

3. Verify against current docs:
   - **DDB TTL semantics**: confirm field name, epoch-seconds format, and that records past TTL are eventually deleted (typically within 48h). Source: AWS DDB docs.
   - **`@sendgrid/mail` `sgMail.send` contract**: confirm the existing call shape is sufficient; no new fields needed for verification emails. Source: `@sendgrid/mail` package (already a dependency).
   - **Node `crypto` SHA-256 helper**: confirm `createHash("sha256").update(code).digest("hex")` is the standard pattern in this codebase (yes — used in `email-reply.service.ts:118`).

4. Produce a detailed implementation plan covering ALL of these sections:
   - **Overview** — one paragraph.
   - **Affected files / modules** — comprehensive list with one-line note per file (created vs modified).
   - **DDB schema changes** — exact field names + types added to METADATA, exact field added to Customer record, exact full shape of the new `VERIFICATION_CODE` record. Show the TS interface for each in the plan.
   - **`request_verification_code` tool design** — exact file path (`src/tools/request-verification-code.tool.ts`), exact `name` / `description` strings, exact input schema (`{}` — no params), exact `execute` flow (read `USER_CONTACT_INFO` for email, evaluate rate-limit window, generate 6-digit code via `crypto.randomInt(0, 1_000_000)` zero-padded to 6 digits, hash, write VERIFICATION_CODE record, send email — all with explicit error paths). The plan should specify the exact ordering of DDB-write vs email-send to handle the failure case cleanly (recommend: write VERIFICATION_CODE record first with a temporary state, send email, on send failure delete the record; OR: send email first, write record only on success, accept the small risk of email-sent-but-record-missing as benign because verify_code returns `no_pending_code` cleanly. Pick one in the plan and justify).
   - **`verify_code` tool design** — exact file path, exact name/description, exact input schema (`{ code: string }` with min/max length 6 numeric-only validation), exact `execute` flow (read VERIFICATION_CODE record, check `expires_at`, check `attempts < 5`, hash input and compare, on match: set `metadata.customer_id`, update `customer.latest_session_id`, delete VERIFICATION_CODE record, return verified:true; on mismatch: increment attempts, return verified:false). Specify whether the three writes (set customer_id, update latest_session_id, delete VERIFICATION_CODE) run as a DDB `TransactWriteItems` or as separate writes; recommend separate writes for v1 (simpler; idempotent on retry) unless arch-planner finds a concrete reason to favour the transaction.
   - **Customer-by-id lookup helper** — `verify_code` returns `customerId` and links the session. The customerId is read from the VERIFICATION_CODE record's `email` field via the existing `(ACCOUNT, EMAIL)` GSI1 lookup. arch-planner confirms whether the existing `queryCustomerUlidByEmail` helper in `preview-cart.tool.ts` should be lifted to a shared service for reuse, or whether a small duplicate is fine for Phase 1. Recommend lifting it to `src/services/customer.service.ts` (new) so Phase 2 can reuse it from `collect_contact_info`. Justify the decision in the plan.
   - **Latest-session-id update path** — exact file, exact method, exact guard (only fires when `metadata.customer_id` is non-null), exact write call. arch-planner identifies the assistant-turn persistence site by reading the codebase.
   - **Verification email template** — exact HTML (compact; no external CSS; inline styles only), exact subject string. Plan includes the literal HTML for the implementer to copy.
   - **Step-by-step implementation order** — file-by-file. Suggested order: (1) types (`src/types/Verification.ts`), (2) validation schemas (`src/validation/tool.schema.ts`), (3) shared customer service if lifting the helper (`src/services/customer.service.ts`), (4) METADATA + Customer record schema additions (no behavioural change yet), (5) `request_verification_code` tool, (6) `verify_code` tool, (7) latest-session-id write at the assistant-turn site, (8) tool registration / agent allowlist updates, (9) tests.
   - **Testing strategy:**
     - `request_verification_code` spec: happy path (record written, email sent, returns sent:true); no-email-in-session path (returns reason:"no_email_in_session", no email, no record); rate-limit path (3 successful requests in window → 4th returns reason:"rate_limited", no new email/record); email-send-failure path (EmailService throws → returns reason:"send_failed"; verify the chosen ordering's cleanup behaviour); window-rolloff path (>1h since `request_window_start_at` resets the counter to 1).
     - `verify_code` spec: happy path (correct code → record deleted, customer_id set on session, latest_session_id set on customer, returns verified:true with the customerId); wrong-code path (hash mismatch → attempts incremented, record stays, returns reason:"wrong_code"); expired path (expires_at < now → returns reason:"expired", record stays as-is); max-attempts path (attempts already 5 → returns reason:"max_attempts" without checking the submitted code); no-pending-code path (no record → returns reason:"no_pending_code"); customer-not-found-by-email path (record exists but the GSI lookup fails — should be rare since the record was written from a known-customer flow, but verify graceful handling).
     - Schema spec: METADATA initialised with `customer_id: null` on session creation; Customer record initialised with `latest_session_id: null` on first creation.
     - Mock all external services (SendGrid via `EmailService` mock; DDB via the existing test patterns). No real network calls in tests.
   - **Risks and edge cases:**
     - Race between two parallel `request_verification_code` calls in the same session: latest-wins overwrite is safe; counter logic must read-then-write atomically (use a DDB conditional update or accept last-writer-wins with explicit acknowledgement in the plan).
     - The `latest_session_id` update path firing on EVERY assistant turn for a verified session — confirm this is cheap (one DDB UpdateItem) and idempotent. Document the cost.
     - DDB TTL not enabled on the conversations table — if so, the plan flags it as a pre-implementation question for the orchestrator.
     - Visitor pastes a code that's correct but for a DIFFERENT email than what's currently in their session (e.g., they typed a new email after requesting the code) — the VERIFICATION_CODE record's `email` field is the source of truth; verify against THAT email's customer, not whatever's in `USER_CONTACT_INFO` at verify time.
     - The 6-digit code occasionally has a leading zero — make sure zero-padding is preserved end-to-end (DDB string field, email body string, hash input string). Off-by-one bugs here have bitten teams before.
   - **Out-of-scope confirmations.**

5. Write your plan to `docs/knowledge-base/tasks/phase-cci-1-data-model-and-verification-plan.md`.

6. Return a concise summary (under 700 words) including:
   - Path to the plan file.
   - 6–8 key decisions or clarifications you made — particularly around (a) where the `latest_session_id` write is wired in, (b) whether to lift `queryCustomerUlidByEmail` to a shared service or duplicate, (c) DDB-write vs email-send ordering for `request_verification_code`, (d) whether the conversations table has TTL enabled (and what to do if not), (e) whether tool registration is automatic via the decorator or needs an explicit allowlist edit per agent, (f) the exact agent allowlist file paths.
   - Any risks, unknowns, or "needs orchestrator decision" items the user should resolve before approval.

Hard rules for this agent:
- DO NOT commit. DO NOT push. DO NOT run any `git` write command.
- DO NOT read `.env`, `.env.local`, or any `.env.*` file. Only `.env.example` if it exists.
- Pause after producing the plan so the orchestrator can get user approval before Step 2.


STEP 2 — IMPLEMENTATION
Use the code-implementer agent to implement the approved plan.

Implementation details for this task:
- Follow the plan to the letter, including the exact verification email HTML, the exact tool name/description strings, the exact 6-digit zero-padded code generation (`crypto.randomInt(0, 1_000_000).toString().padStart(6, "0")`), and the exact rate-limit window logic.
- Both new tools use the existing `@ChatToolProvider()` + `ChatTool` interface pattern. Follow `src/tools/save-user-fact.tool.ts` as the shape reference.
- Validation schemas land in `src/validation/tool.schema.ts` alongside the existing schemas.
- Types land in `src/types/Verification.ts`. No inline types in the tool/service files.
- The latest-session-id write fires at the assistant-turn persistence site identified by arch-planner. Guard: only when `metadata.customer_id` is non-null. The guard is on the call site, not deferred to the helper.
- The `email` field in the VERIFICATION_CODE record is the authoritative input to the customer-id lookup at verify time — NOT the live `USER_CONTACT_INFO` email at verify time (in case the visitor changed it mid-flow).
- Add tests per the plan's testing strategy. Mock SendGrid via the `EmailService` (or use a dedicated mock of `EmailService.send`). Mock DDB via the existing test patterns. No real network calls.
- Run `npm run build` and `npm test` before returning. Report total test count delta.

Implementation requirements:
- follow the plan produced by the arch-planner agent
- modify or create only the necessary files
- respect existing architecture and coding patterns
- focus on correctness first (style will be handled later)

Hard rules for this agent:
- DO NOT commit. DO NOT push. DO NOT run any `git` write command. The orchestrator commits at the sub-phase boundary, only after explicit user approval.
- DO NOT read `.env`, `.env.local`, or any `.env.*` file. Only `.env.example` if it exists.


STEP 3 — STYLE REFACTOR
Use the style-refactor agent to refactor the implementation according to the rules defined in `.claude/instructions/style-enforcer.md`.

Style refactor specifics:
- Bracketed `[key=value]` log format throughout the new tools and any logging in the latest-session-id write path. Match the convention used by `preview-cart.tool.ts` and `save-user-fact.tool.ts`.
- Named constants for: the 6-digit code length, the 10-minute TTL, the 5-attempt cap, the 1-hour rate-limit window, the 3-request rate-limit cap, the SHA-256 algorithm string. No magic numbers or strings.
- The verification email HTML is one named constant (or a small builder function) in the tool file or a co-located helper. No inline HTML soup.
- TypeScript-side variables use camelCase. New DDB field names use snake_case (`customer_id`, `latest_session_id`, `code_hash`, `email`, `expires_at`, `attempts`, `request_count_in_window`, `request_window_start_at`, `ttl`, `_createdAt_`, `_lastUpdated_`). NEVER `_ulid` / `Ulid` on new fields or new typed inputs.
- No `any`, no inline type annotations TypeScript can infer, no dead code, no placeholder comments.
- Error messages returned from tools to the agent are stable, terse, human-readable (the agent uses them to drive its next reply); use named constants for the user-facing strings if they are likely to be reused or wrapped later.
- Do NOT undo any change made by the implementer that resolves a previous-round style finding (consistent with the Phase 8c lesson — re-removing reviewer-approved changes is a regression).

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
- Run `npm test`. Baseline before this phase: 498 tests (per the 2026-04-28 journal entry on the Phase 8b-followup alert enrichment). Phase CCI-1 adds: ~6 cases for `request_verification_code`, ~6 cases for `verify_code`, ~2–3 for the latest-session-id write guard, ~2 for schema-default initialisation, ~1–2 for the customer-by-email lookup helper if lifted to a shared service. Estimated new total: ~515–520.
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
- **`code_hash` is SHA-256 of the 6-digit code, NEVER plaintext.** Search for any code path that writes the plaintext code into DDB or any log. If found, that's a critical bug.
- **The 6-digit code is zero-padded.** Confirm `padStart(6, "0")` is applied consistently — at generation, at hash input, and (visibly) in the email body. A code generated as `42` and rendered to the visitor as `000042` but hashed as `42` will fail to verify forever.
- **The VERIFICATION_CODE record's `email` field is the authority at verify time** for the customer lookup, NOT the live `USER_CONTACT_INFO` email. Verify the verify_code tool reads from the record, not from session contact-info.
- **Rate-limit window logic is correct.** A new request resets the counter only when `now - request_window_start_at > 1 hour`; otherwise increments. The 4th request in the window returns `reason:"rate_limited"` WITHOUT writing a new VERIFICATION_CODE record AND WITHOUT sending an email.
- **Attempts cap is enforced before hashing the submitted code.** A submitted code that arrives at attempts:5 returns `reason:"max_attempts"` immediately; the code is NOT hashed and compared (defense in depth — no extra information leak via timing).
- **Latest-session-id is written ONLY when `metadata.customer_id` is non-null.** Verify the guard at the call site. Sessions without a linked customer must not touch the field.
- **The new fields default to `null` at creation sites** — `customer_id` on METADATA in `identity.service.ts`; `latest_session_id` on Customer record in `preview-cart.tool.ts`. Both must be present in the initial item shape; absent fields would surface as `undefined` and cause downstream guard failures.
- **Per-account isolation is unaffected.** This phase doesn't touch account filtering; the Customer record stays scoped to its account; the customer-by-email lookup uses the existing `(ACCOUNT, EMAIL)` GSI1.
- **No PII in logs.** Verify the new tools log session ULIDs, error categories, and outcome reasons, but NEVER the email, the plaintext code, or the customer name. (Hashes and IDs are fine.)
- **No PII in any new Slack alert path.** This phase should add zero Slack alerts; if any were added, confirm they contain no email, no name, no plaintext code. Slack-PII-zero is a locked rule from Phase 8b-followup.
- **Tools are reachable by `lead_capture` and `shopping_assistant` agents.** Confirm via the agent allowlist or registry. Other agents should NOT have access yet.
- **Naming convention** — verify new DDB fields and tool inputs use `_id`/`Id`, never `_ulid`/`Ulid`. Confirm.
- **Out-of-scope respected** — no `collect_contact_info` lookup side-effect, no system-prompt edits, no prior-history loader, no SendGrid Inbound Parse webhook changes, no per-merchant branded templates, no GSI changes, no upstream Customer creation, no SMS primitives, no `/chat/web/*` changes.

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
