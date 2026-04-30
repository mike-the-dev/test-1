# Cross-channel identity & session continuation — design

**Date:** 2026-04-29
**Status:** Brainstormed and approved; pending implementation planning.
**Spec author:** orchestrator + user pair-design via brainstorming session
**Implementation status:** Design approved, awaiting decomposition into phase briefs under `docs/knowledge-base/tasks/` per the standard PROMPT_DISCOVERY_SERVICE workflow.

---

## Summary

Today, every channel (web iframe chat, Discord, email) creates its own isolated session per visit. A returning visitor who emails in fresh from their own client, or who reopens the chat widget on a different browser, becomes a "new visitor" — even if we already have their identity (email) on file from a prior session.

This design adds **cross-channel identity recognition** keyed on email (and later phone), so that when a known person re-engages — through any channel — their conversation continues with their existing customer profile and prior context, instead of starting from zero.

The data foundation already exists: a `C#<customerUlid>` Customer record with a `(ACCOUNT, EMAIL)` GSI is created today by the `preview_cart` tool. This design extends that foundation upstream to the email-capture moment, adds a verification flow for chat (where the trust signal is weaker), and links chat sessions to customers so prior conversation history can be loaded into the agent's context on continuation.

---

## Goals

1. **Returning-visitor recognition** — when an existing Customer's email is captured (chat) or matched (email-inbound), the system identifies them and links the active session to the customer.
2. **Verified continuation on chat** — chat-side identity claims pass through a short email-code verification before any prior history is exposed.
3. **Trusted continuation on email** — email-inbound from a known sender is naturally trusted (the channel itself authenticates) and links to the customer without an additional code step.
4. **Conversational continuity** — the agent loads the customer's profile and recent prior-session messages so the next conversation can pick up from where the last one left off.
5. **Architectural readiness for SMS/voice** — the design generalises to phone-keyed lookups; adding a third channel later should be additive, not a refactor.

---

## Non-goals

- Building the SMS or voice channels themselves (architecture only — channels remain future work).
- Implementing per-merchant custom entry email addresses (a global entry word is used for v1; per-merchant addresses are deferred).
- Adding a new GSI for "all sessions by customer" bulk queries (the v1 use case only needs the most-recent-session lookup, which is O(1) via a single field on the customer record).
- Per-session conversation summarization for long-term memory compression (deferred to v2; the v1 design loads recent message history directly).
- Magic-link verification (using a 6-digit code only).
- Reworking the existing reply-to-our-confirmation-email flow (already works via session-ULID-encoded address; this design is additive).

---

## Background — what exists today

**Customer record** (`src/tools/preview-cart.tool.ts:604–625`):
- Created by `preview_cart` for first-time visitors at the moment of cart creation.
- PK / SK: `C#<customerUlid>` / `C#<customerUlid>`
- `entity: "CUSTOMER"`
- GSI1: `(ACCOUNT#<accountUlid>, EMAIL#<email>)` — gives account-scoped email lookup
- Fields: `email`, `first_name`, `last_name`, `phone`, billing/order tracking
- Lookup-or-create: if a customer with the same email already exists for the account, the existing record is reused

**Session-side identity** (`src/services/identity.service.ts`):
- IDENTITY records map `(source, externalId, agentName) → sessionUlid`
- Session METADATA records hold per-session state (agent name, timestamps, kickoff/onboarding state)
- Today, no field links a session to a customer

**Contact info collection** (`src/tools/collect-contact-info.tool.ts`):
- The `collect_contact_info` tool incrementally upserts contact fields under `CHAT_SESSION#<ulid> / USER_CONTACT_INFO`
- Used by the `lead_capture` and `shopping_assistant` agents to gather first name, last name, email, phone, company

**Email reply loop** (`src/services/email-reply.service.ts`):
- Outbound emails go FROM `<sessionUlid>@<replyDomain>` (today: `reply.instapaytient.com`)
- Visitor replies are caught by SendGrid Inbound Parse, the session ULID extracted from the To address, and the reply routed to that exact session
- This is the existing "Case 1" continuation mechanism — it stays unchanged

---

## Design

### Data model changes

**Existing — no changes:**
- The `C#<customerUlid>` Customer record and its GSI1 `(ACCOUNT, EMAIL)` index are reused as the canonical identity store.

**New fields:**

```
CHAT_SESSION#<sessionUlid> / METADATA gains:
  customer_id    string | null   // set when verification succeeds (chat) OR
                                  // when email-inbound matches a known customer

C#<customerUlid> gains:
  latest_session_id  string | null  // updated on every assistant turn of a known-customer session;
                                     // tracks the most recent session in any channel
```

**New record type — verification code (per-session, short-lived):**

```
PK: CHAT_SESSION#<sessionUlid>
SK: VERIFICATION_CODE
entity: "VERIFICATION_CODE"
code_hash: string         // SHA-256 of the 6-digit code (defense in depth — no plaintext at rest)
email: string             // the email this code is verifying (matches what's about to be linked)
expires_at: string        // ISO 8601, 10 minutes from issuance
attempts: number          // increments on each verify_code call; locked at 5
ttl: number               // DDB TTL field (epoch seconds); auto-cleanup
_createdAt_: string
```

**Naming convention — locked:** New DDB fields and new typed tool inputs use `_id` / `Id`. Never `_ulid` / `Ulid`. Existing TS variable names like `sessionUlid` are not refactored.

---

### New tools (agent-callable)

Two new tools follow the existing tool-driven pattern in this codebase. Each has a single responsibility, deterministic behaviour, and returns a structured signal the agent's system prompt instructs it to act on.

```ts
// In: nothing (the email being verified comes from session context — most recently saved by collect_contact_info)
// Out: { sent: true } | { sent: false, reason: "rate_limited" | "send_failed" | "no_email_in_session" }
request_verification_code(): RequestVerificationCodeResult

// In: code (the 6-digit numeric the visitor pasted)
// Out: { verified: true, customerId: string } | { verified: false, reason: "wrong_code" | "expired" | "max_attempts" | "no_pending_code" }
verify_code(code: string): VerifyCodeResult
```

**Extended existing tool — `collect_contact_info`:**

When the email field is the one being saved on a given call, the tool performs a customer-lookup side-effect using the existing GSI1 `(ACCOUNT, EMAIL)` index. The lookup result is included in the response:

```ts
// In: same as today — (field, value)
// Out (for email field): { saved: true, customerFound: true | false }
// Out (for other fields): { saved: true } — unchanged
```

**Why this shape:**
- The lookup is mechanical (always run when an email is captured), not a decision the agent should make.
- Tying it to `collect_contact_info` ensures it always fires — no "did the agent remember to call lookup?" failure mode.
- The agent's system prompt instructs: when `customerFound: true`, do the soft-welcome + `request_verification_code` flow before proceeding to anything else.

---

### Chat-side continuation flow

```
1. Visitor types email in chat
   ↓
2. collect_contact_info(email=...) → returns { saved: true, customerFound: true|false }
   ↓ (customerFound: true)
3. Agent: soft welcome ("Welcome back, Sam — let me send a quick verification code to confirm it's really you.")
   ↓
4. Agent calls request_verification_code() → tool generates 6-digit code, hashes + stores under
   CHAT_SESSION#<ulid> / VERIFICATION_CODE, emails the plaintext code via SendGrid
   ↓
5. Visitor pastes code → agent calls verify_code(code)
   ↓ (verified: true)
6. Backend: session.customer_id ← customerId; customer.latest_session_id ← current sessionUlid;
   delete the VERIFICATION_CODE record (single-use); load customer profile + last 20–30 messages
   from the customer's prior latest_session_id into the agent's context for the next turn
   ↓
7. Agent's next reply: brief "where we left off" summary + answers the visitor's current question
   in one natural-language turn

Failure path (wrong code, expired, max attempts exhausted):
   verify_code returns { verified: false, reason: ... }
   Agent gracefully recovers ("No worries, let's keep going from here") — treats the visitor as
   new, no history exposure, no automatic retry. Customer record is NOT linked to the session.
```

**If `customerFound: false` at step 2:** flow skips verification entirely. The session continues as new. A new Customer record will be created later (at the moment `preview_cart` runs, per existing behaviour), or — if we want to lift Customer creation upstream too — at the point of email capture itself. This is a small implementation choice; either keeps the data model consistent.

---

### Email-inbound flow

The SendGrid Inbound Parse webhook discriminates by the local part of the recipient address:

```
to.localPart matches /^[0-9A-HJKMNP-TV-Z]{26}$/  →  Case 1 (continuation, existing flow)
                                                     extract ULID, route to that session

to.localPart equals "assistant"                  →  Case 2 / 3 (entry / re-entry)
                                                     look up sender email in Customer GSI

to.localPart anything else                       →  reject / log warning (unrecognised)
```

**Case 2 — unknown sender** (`assistant@reply.<merchant>.com`, no Customer match): existing behaviour — start a new session, treat as new visitor.

**Case 3 — known customer** (`assistant@reply.<merchant>.com`, sender matches a Customer record):
- If `customer.latest_session_id` is < 7 days old → append the email as a new turn in that existing session. Agent gets full session history (it's the same session) and replies in-line.
- If `customer.latest_session_id` is ≥ 7 days old (or `null`) → start a NEW chat session. Set `session.customer_id` immediately (no verification needed — channel-level trust). Load customer profile + last 20–30 messages from the prior `latest_session_id` into the agent's context (continuation-content option B). Agent replies as usual.

**Either way:** `customer.latest_session_id` updates to point at whichever session is now active.

**Outbound from any agent reply:** uses the encoded address `<sessionUlid>@reply.<merchant>.com` (existing pattern). Visitor's replies to our reply naturally route via Case 1.

**Edge case — visitor digs up an old reply email and hits reply on it:** that reply still routes to the original session via Case 1, even past the 7-day freshness window. This is desirable, not a bug — visitors aren't punished for using their inbox naturally.

---

### Verification code mechanics

| Property | Value | Reasoning |
|---|---|---|
| Storage | DDB `CHAT_SESSION#<ulid> / VERIFICATION_CODE` | Consolidates state in DDB; no Redis dependency in the verification path |
| Format | 6-digit numeric (000000–999999) | Easy to type from email into chat; single context-switch |
| TTL | 10 minutes | Long enough for visitor to switch to email and back; short enough to expire abandoned attempts |
| At-rest | SHA-256 hashed | Defense in depth — no plaintext code in DDB |
| Attempts cap | 5 per code | Brute-force protection (1M space × 5 attempts = 0.0005% chance of guess in window) |
| On new request | Overwrites prior pending code for the session | Simple "latest wins" semantics |
| On success | Record deleted (single-use) | Prevents replay |
| Auto-cleanup | DDB TTL field (epoch seconds) | Reaper — application logic always validates `expires_at` independently |

**Why DDB over Redis:** Redis is technically faster for simple key reads, but the difference is meaningless at chat-scale (one verify per session, human-paced interaction). DDB consolidates state and avoids drift risk between two stores.

---

### What "full continuation" loads (continuation-content option B)

When verification succeeds (chat) or known-customer email-inbound is matched, the agent's context is populated with:

1. **Customer profile** — `first_name`, `last_name`, `email`, `phone` from the Customer record. Plus any `USER_FACT` and `USER_CONTACT_INFO` records associated with the customer's prior sessions.
2. **Recent message history** — the last 20–30 messages from `customer.latest_session_id` (the customer's most recent prior session, regardless of channel — chat or email). Skipped if the prior session IS the current session (e.g., email-inbound that attached to the existing latest_session).

**Not loaded (intentionally):**
- Messages across ALL prior sessions — token-expensive and privacy-heavy. Per-session summaries (deferred to v2) would be the right way to compress this.
- Cart history, order history, abandoned-cart records — already on the Customer record as fields; surfaced through the existing tools (`preview_cart`, `list_services`) as needed.

**Token budget:** ~5–10k tokens for a typical 20–30 message history. Predictable and bounded.

---

### Email addressing — entry vs continuation

| Address pattern | Purpose | Handler behaviour |
|---|---|---|
| `assistant@reply.<merchant>.com` | Entry / re-entry — fresh email from any visitor | Lookup sender email in Customer GSI; apply Case 2 (unknown) or Case 3 (known) |
| `<26-char ULID>@reply.<merchant>.com` | Continuation — visitor replied to one of our outbound emails | Existing flow: extract ULID, route to that session (Case 1) |

**Globals vs per-merchant:**
- The entry word `"assistant"` is a single global string used identically across all merchants.
- The reply subdomain `reply.<merchantDomain>` varies per merchant (configured during onboarding — MX records + SendGrid Inbound Parse pointed at the same webhook regardless of which merchant's domain it came in on).

**Why a single entry word:** simplest infra (one webhook, one local-part pattern check). Per-merchant custom entry addresses (e.g., `chat@merchantA.com` for white-label branding) are deferred to v2 — premature for v1, especially before any merchant has explicitly asked for it.

---

### Failure & edge cases

| Scenario | Behaviour |
|---|---|
| Verification code wrong | `verify_code` returns `{ verified: false, reason: "wrong_code" }`. Agent informs visitor, can resend (counts toward `attempts` cap) |
| 5 wrong attempts | Code is locked. Agent says "let me start over" and can call `request_verification_code` for a fresh code |
| Code expired (> 10 min) | `verify_code` returns `{ verified: false, reason: "expired" }`. Agent offers to send a new one |
| Visitor abandons mid-verification | Pending code expires via TTL. No state cleanup needed. Next chat treats them as new |
| Known customer emails fresh while a recent session is active | Case 3 attaches the email as a turn in the existing session (within 7-day freshness) |
| Two sessions racing for the same customer (rare) | `customer.latest_session_id` is last-writer-wins. Both sessions are linked via `customer_id` — no data loss, just minor "which one is latest" ambiguity. Acceptable for v1 |
| Customer record exists but with stale name (e.g., changed last name) | Continuation uses whatever's on the Customer record at lookup time. Agent can update via `collect_contact_info` if visitor corrects |
| Voyage / Anthropic outage during continuation | Continuation flow is independent of those services — it loads pre-existing message records. Agent's reply may degrade if those services are down, but identity continuity is unaffected |

---

### Privacy considerations

- **No customer PII in Slack alerts** — covered by the existing Phase 8b-followup design (locked rule). Continuation events do not generate new alert types.
- **Verification codes are never logged in plaintext** — only hashes stored at rest; the plaintext exists only in transit (SendGrid email + visitor's chat input).
- **Sender-email-based recognition is account-scoped** — the Customer GSI is keyed on `(ACCOUNT, EMAIL)`, so the same email associated with two different accounts (e.g., the same human shopping at two different merchants on the platform) yields two separate Customer records. No cross-tenant leakage.
- **Failed verification means zero history exposure** — the agent gracefully treats the visitor as new. The prior customer's history is never visible to a failed-verification attempt.
- **The 7-day email freshness window is a UX choice, not a security boundary** — a visitor can always reach an old conversation via reply-to-encoded-address (Case 1).

---

### Architectural readiness for SMS / phone (preview only — not building)

The design naturally extends to phone-keyed identity:

- The Customer record already has a `phone` field.
- A future GSI2 on `(ACCOUNT, PHONE)` (parallel to the existing email GSI) would give phone-keyed lookup.
- The webhook discrimination pattern generalises: SMS messages from a known phone follow the Case 3 logic (lookup by phone → attach to recent session or start new linked session).
- No verification-code flow is needed for SMS-inbound from a known phone (the channel authenticates the number, same as email-inbound's SPF/DKIM signal).
- Web-chat verification could optionally use SMS instead of email if the visitor provides a phone first (parallel `request_sms_verification_code` tool).

The data model and flow shapes designed in this spec do not need to change to add SMS later. New code only.

---

## Out of scope (deferred)

- **SMS / voice channels** — preview only, not building.
- **Per-merchant custom entry addresses** — global `"assistant"` entry word for v1.
- **GSI for "all sessions by customer"** — defer until a use case demands it.
- **Per-session summaries / sophisticated long-term memory** — v2 enhancement; v1 loads recent messages directly.
- **Magic link verification** — using 6-digit code only.
- **Voice / phone channel** — future work.
- **Refactoring existing TS variable names** (`sessionUlid`, etc.) — naming convention applies to NEW fields only.
- **Cross-account customer linking** — the Customer record is per-account by design (per-account isolation is the load-bearing invariant). If the same human shops at two merchants, they are two separate Customers.

---

## Open implementation questions (to resolve in phase-brief planning)

These don't change the design but need decisions during implementation:

1. **Where does Customer creation move to?** Today, `preview_cart` creates the Customer at cart-preview time. We could lift that upstream to email-capture time (in the new `collect_contact_info` side-effect) so a Customer exists earlier in the funnel. Trade-off: more Customer records (some who never check out) vs. earlier identity.
2. **Verification code re-request rate-limit** — separate from per-code attempts. Should we cap how many times an agent can call `request_verification_code` per session in a short window? Probably yes (e.g., 3 per session per hour) to prevent spam-via-AI.
3. **What does the "where we left off" summary look like in practice?** The system prompt should include guidance on how to summarise gracefully without sounding scripted. Worth iterating on real example transcripts during implementation.
4. **Email template for verification code** — branded? plain? include the merchant's name? Probably yes; pull from the account record.
5. **Continuation context loading mechanism** — does the agent's context include prior messages as a system message ("Here's relevant history: …") or as actual prior turns in the message array? The latter is more native to how Claude handles history but inflates token count differently.

---

## Decisions log (key choices made during brainstorming)

| Decision | Choice | Reasoning |
|---|---|---|
| Trust model on chat | Verify via 6-digit email code, then full continuation, with soft-welcome touch in between | Best of: A (full continuation), B (email-code verification), C (welcome touch). User wanted "feels like account without being one." |
| Trust model on email-inbound | Naturally trusted via channel auth (SPF/DKIM); no code | Sender authenticated themselves to their own provider; no need for additional friction |
| Lookup mechanism | Reuse existing GSI1 `(ACCOUNT, EMAIL)` on Customer record | Already in place; no new infra |
| Lookup trigger | Side-effect of `collect_contact_info` when email field is saved | Mechanical, not an agent decision; ensures it always fires |
| Verification flow control | Agent-driven via two new tools (`request_verification_code`, `verify_code`) + prompt instructions | Consistent with codebase pattern; tools are deterministic primitives, prompt drives WHEN to call |
| Code storage | DDB `CHAT_SESSION#<ulid> / VERIFICATION_CODE` | Consolidates state; speed difference vs Redis is irrelevant at chat scale |
| Code format / TTL / attempts | 6-digit numeric / 10 min / 5 attempts max | Conservative; tunable from real data later |
| Continuation content | Profile + last 20–30 messages from `latest_session_id` (most recent prior session, ANY channel) | Bounded tokens; sufficient memory for "small summary + answer current question" UX |
| Session-customer linkage | Two new fields (`session.customer_id`, `customer.latest_session_id`); no new GSI | O(1) lookup for v1 needs; GSI deferred until bulk-query use case appears |
| Naming convention | New DDB fields and tool inputs use `_id` / `Id`, never `_ulid` / `Ulid` | User preference — explicit |
| Email-inbound continuation freshness | Attach if `latest_session` < 7 days old, else start new session linked to customer | Matches typical "still actively shopping" window |
| Email entry address | `assistant@reply.<merchant>.com` (global word, per-merchant subdomain) | Reuses existing reply subdomain infra; one webhook handler, local-part discrimination |
| Webhook discrimination | Local-part regex for ULID → Case 1, literal `"assistant"` → Case 2/3, anything else rejected | Stateless dispatch at the gateway |

---

## Implementation decomposition (sketch — to be refined into phase briefs)

This feature is too large for a single phase. Suggested decomposition:

**Phase 1 — Data model + verification primitives**
- Add `customer_id` field to session METADATA + write paths
- Add `latest_session_id` field to Customer record + write paths
- Add `VERIFICATION_CODE` record type
- Build `request_verification_code` and `verify_code` tools
- Email template for verification code
- Tests

**Phase 2 — Chat-side continuation**
- Extend `collect_contact_info` with the customer-lookup side-effect
- Update `lead_capture` and `shopping_assistant` system prompts with the verification flow instructions
- Build the prior-history loader (loads last 20–30 messages from `latest_session_id` into agent context post-verification)
- Handle the failure path (graceful "treat as new")
- Tests

**Phase 3 — Email-inbound continuation**
- Extend the SendGrid Inbound Parse webhook to discriminate by local-part
- Build the Case 2 / Case 3 dispatch logic
- Configure SendGrid Inbound Parse + DNS for the `assistant@reply.<merchant>.com` address
- Update email-reply outbound to use the encoded address (already does this — verify)
- Tests

**Phase 4 — Polish & operational items (optional v1.1)**
- Verification re-request rate-limiting
- Branded email templates pulled from account record
- Slack alert tweaks (if any new business signals worth surfacing)

Each phase gets its own PROMPT_DISCOVERY_SERVICE-formatted task brief in `docs/knowledge-base/tasks/` and runs through the standard 5-step sub-agent workflow.

---

## References

- Brainstorming session log: this document was produced via interactive design conversation between user and orchestrator on 2026-04-29 using the `superpowers:brainstorming` skill with visual companion.
- Existing customer record: `src/tools/preview-cart.tool.ts:604–625`
- Existing email reply loop: `src/services/email-reply.service.ts`
- Existing identity service: `src/services/identity.service.ts`
- Project journal: `docs/journal.md` — see entries from 2026-04-21 onward for recent KB / iframe / observability work that preceded this design.
