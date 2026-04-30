# Phase CCI-3 — Email-inbound continuation: Implementation Plan

---

## Overview

This phase extends the SendGrid Inbound Parse webhook handler in `src/services/email-reply.service.ts` with a dispatcher that sits in front of the existing Case 1 (session-by-ULID) logic. The dispatcher classifies the recipient's local-part into one of three categories via a small enum-backed classifier method, then routes to the appropriate handler. Case 1 (ULID local-part) routes the existing path entirely unchanged. Case 2/3 ("assistant" local-part) looks up the sender's email in the Customer GSI, performs a 7-day freshness check on the customer's `latest_session_id`, and either appends the email to the existing session (Case 3 fresh), creates a new session linked to the customer with all three METADATA continuation fields set atomically (Case 3 stale), or creates a new session with no customer link (Case 2 — unknown sender). Case 3 stale sessions immediately benefit from the Phase 2b prior-history loader, which fires on the agent's first response turn without any new loader code. Email-inbound sessions do NOT write IDENTITY records — routing is driven entirely by the recipient local-part classification and, for the "assistant" branch, the Customer GSI lookup plus the freshness check on `customer.latest_session_id`. All existing email-reply tests pass unchanged.

---

## Critical architectural finding — accountUlid mapping

**The existing `processInboundReply` method does NOT resolve an `accountUlid` at all.** The current v1 deployment is single-tenant: `SENDGRID_REPLY_DOMAIN` is a single global env var, and the existing email path never reads an `accountUlid` from the session METADATA. Case 1 works without it because `ChatSessionService.handleMessage` reads `account_id` from the METADATA record internally.

For Case 2/3, the `accountUlid` IS needed to scope the `CustomerService.queryCustomerIdByEmail` GSI lookup — without it the query uses `ACCOUNT#` as the GSI-PK and returns null for everyone.

**Decision: Add a new `SENDGRID_REPLY_ACCOUNT_ID` environment variable** (accessed via a new getter `replyAccountId` on `SendGridConfigService`) that maps the single global reply domain to its owning `accountUlid`. This is the correct v1 approach:

- v1 is single-tenant (one merchant, one reply domain). The account ID is known at deploy time.
- The `processInboundReply` method already reads `replyDomain` from `SendGridConfigService`. Adding `replyAccountId` there follows the exact same pattern.
- Per-merchant multi-tenant routing (different subdomains → different accountUlid lookups) is a v2 concern explicitly deferred out of scope.
- Case 1 is unaffected — it passes `accountUlid` from METADATA to `handleMessage` (which already handles it internally) rather than needing it for a customer lookup.
- The new env var defaults to `""` (same pattern as `replyDomain`). If absent, the "assistant" branch treats the customer-lookup as returning null (falls to Case 2). No breakage.

This is noted as a deployment configuration requirement in the deployment note section.

---

## Note on IDENTITY records — deliberate omission

**Email-inbound sessions do NOT write IDENTITY records. Routing for inbound email is driven entirely by (a) the recipient's local-part — ULID for Case 1, "assistant" for Case 2/3 — and (b) for the "assistant" branch, the customer-by-email lookup against the Customer GSI plus the freshness check on `customer.latest_session_id`.**

This is a deliberate departure from the existing IDENTITY pattern used by other channels (Discord, web). Those channels write IDENTITY records to find returning visitors across sessions. Email-inbound under the "assistant" entry word does not need them because the Customer record already provides the cross-channel identity link: the sender's email address is matched against the Customer GSI directly, and the Customer record's `latest_session_id` is the source of truth for session routing decisions.

Writing IDENTITY records for email-inbound sessions would create a known re-use problem: a customer's second stale email arrives 30+ days later, the IDENTITY lookup finds the original stale-session, and the email gets routed there instead of creating a fresh new session as the dispatcher logic intends.

This asymmetry is intentional for v1. Future work (post-v1) may consolidate the channel-coupled IDENTITY model into a unified identity that lives on the Customer record — but that refactor is out of scope for Phase 3.

---

## Affected Files and Modules

### Modify

| File | Change |
|------|--------|
| `src/types/EmailReply.ts` | Add `LocalPartClassification` enum; add new outcome variants to `EmailReplyInboundProcessOutcome` union; add `EmailReplyAssistantEntryMetadata` interface for Case 2/3 session create context |
| `src/services/email-reply.service.ts` | Add `ASSISTANT_ENTRY_LOCAL_PART` constant, `EMAIL_CONTINUATION_FRESHNESS_WINDOW_MS` constant; add `classifyLocalPart()` method; refactor `processInboundReply` to route on classification; add Case 2/3 handler methods; inject `CustomerService` |
| `src/services/sendgrid-config.service.ts` | Add `replyAccountId` getter reading `SENDGRID_REPLY_ACCOUNT_ID` env var |
| `src/services/email-reply.service.spec.ts` | Add 25–35 new test cases covering all new branches; update module setup to include `CustomerService` mock |
| `src/app.module.ts` | Verify `CustomerService` is already in providers; no new provider registration needed |

### Review Only (no change)

| File | Reason |
|------|--------|
| `src/services/customer.service.ts` | Phase 3 calls `queryCustomerIdByEmail` directly; service is already registered in AppModule; no change needed |
| `src/services/identity.service.ts` | Phase 3 does NOT call `lookupOrCreateSession` for Case 2 or Case 3-stale. New sessions are created via the existing direct session-creation path (without IDENTITY writes). Review to confirm the direct new-session creation path (used in the chat-side for non-IDENTITY flows) and identify the correct call for Case 2/Case 3-stale that creates a session without touching the IDENTITY table. |
| `src/services/chat-session.service.ts` | Prior-history loader already reads `continuation_from_session_id` and `continuation_loaded_at` from METADATA; no change needed. The loader gates on both fields as established in Phase 2b. |
| `src/controllers/sendgrid-webhook.controller.ts` | Phase 3 does NOT modify the controller. The dispatcher lives in the service layer, after the existing webhook signature/body parsing. |
| `src/types/ChatSession.ts` | `ChatSessionMetadataRecord` already has `customer_id`, `continuation_from_session_id`, and `continuation_loaded_at` fields from Phases 1 and 2b. No change needed. |

---

## Dependencies and Architectural Considerations

- `CustomerService` is already registered in `AppModule`. Phase 3 injects it into `EmailReplyService`.
- `IdentityService` is NOT called for Case 2 or Case 3-stale sessions. Sessions are created via the direct session-creation path that does not write IDENTITY records. The implementer must confirm which existing method creates a session without an IDENTITY write — this is the call to use for all new-session creation in the "assistant" branch.
- `SendGridConfigService` needs one new getter (`replyAccountId`). It is already injected into `EmailReplyService`.
- `DatabaseConfigService` is already injected into `EmailReplyService` and provides `conversationsTable`.
- The new `SENDGRID_REPLY_ACCOUNT_ID` env var is the only environment change. It is optional (defaults to `""`) so existing deployments without it still work (Case 2/3 customer lookup returns null → falls to Case 2 new session).
- The Case 3-stale METADATA fields (`customer_id`, `continuation_from_session_id`, `continuation_loaded_at`) are written in a single follow-up `UpdateCommand` immediately after new-session creation — before `handleMessage` is called. Because IDENTITY records are not written, there is no `wasCreated` check and no IDENTITY-reuse concern.
- The `continuation_from_session_id` and `customer_id` METADATA fields for Case 3-stale require a follow-up UpdateCommand AFTER new-session creation because the session-creation path initialises both to `null`. See the Case 3-stale design section for the atomic UpdateCommand.
- No new Slack alerts in Phase 3.
- No PII in logs.

---

## Local-Part Dispatcher Design

### Constants (module-level in `email-reply.service.ts`)

```typescript
const ASSISTANT_ENTRY_LOCAL_PART = "assistant";
const EMAIL_CONTINUATION_FRESHNESS_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
```

`ULID_REGEX` is already defined at the top of `email-reply.service.ts` as `/^[0-9A-HJKMNP-TV-Z]{26}$/` — reuse it unchanged.

### `LocalPartClassification` enum (in `src/types/EmailReply.ts`)

```typescript
export enum LocalPartClassification {
  SESSION_ULID = "SESSION_ULID",
  ASSISTANT_ENTRY = "ASSISTANT_ENTRY",
  UNRECOGNIZED = "UNRECOGNIZED",
}
```

### Classifier method (new private method on `EmailReplyService`)

```typescript
private classifyLocalPart(localPart: string): LocalPartClassification {
  if (ULID_REGEX.test(localPart)) {
    return LocalPartClassification.SESSION_ULID;
  }
  if (localPart.trim().toLowerCase() === ASSISTANT_ENTRY_LOCAL_PART) {
    return LocalPartClassification.ASSISTANT_ENTRY;
  }
  return LocalPartClassification.UNRECOGNIZED;
}
```

**Case sensitivity decision:** The classifier uses `.trim().toLowerCase() === ASSISTANT_ENTRY_LOCAL_PART`. This means `"ASSISTANT"`, `"Assistant"`, `" assistant "` all classify as `ASSISTANT_ENTRY`. Rationale: email local-parts can be case-folded by mail servers or clients; accepting case-insensitive input is defensive and matches the design intent of recognizing a known entry word. The ULID check correctly comes first (all ULIDs are uppercase Crockford; "assistant" is not a valid 26-char ULID anyway, but ordering is explicit).

### Dispatcher location

The dispatcher replaces the existing ULID check inside `processInboundReply`. The `localPart` extraction loop (lines 81–103) runs first — it finds the first address matching `replyDomain` and extracts `localPart`. This logic is UNCHANGED. After the loop:

- If `localPart` is undefined: existing `rejected_malformed` return. Unchanged.
- NEW: `const classification = this.classifyLocalPart(localPart);`
- Route on `classification`:
  - `SESSION_ULID` → existing Case 1 logic (runs unchanged from the current code path starting at `const sessionUlid = localPart`)
  - `ASSISTANT_ENTRY` → new `handleAssistantEntry(formFields, table)` method
  - `UNRECOGNIZED` → log warning + return `"rejected_malformed"`

The ULID regex check that previously returned `"rejected_malformed"` for non-ULID local-parts is REMOVED and replaced by the dispatcher. The unrecognized branch maps to `"rejected_malformed"` (same string) so existing test assertions are preserved without change.

**Outcome strategy:**
- `SESSION_ULID` → existing Case 1 code path. Existing outcomes (`processed`, `duplicate`, `rejected_unknown_session`, `rejected_sender_mismatch`, `rejected_malformed`) are all preserved.
- `ASSISTANT_ENTRY` → new outcomes: `"processed"` (same as Case 1 success), `"duplicate"` (for dedup), and new: `"rejected_unknown_account"` (if `replyAccountId` is absent/empty).
- `UNRECOGNIZED` → `"rejected_malformed"` (same string as before — no change to existing test expectations).

`EmailReplyInboundProcessOutcome` gains one new variant: `"rejected_unknown_account"`.

### Reject log format (UNRECOGNIZED branch)

```
this.logger.warn(`[event=email_inbound_unrecognized_local_part outcome=rejected_malformed]`);
return "rejected_malformed";
```

No `to` address or local-part value in the log (no PII).

---

## Case 2/3 Dispatcher Entry (`handleAssistantEntry`)

### Method signature

```typescript
private async handleAssistantEntry(
  formFields: EmailReplySendGridInboundFormFields,
  table: string,
): Promise<EmailReplyInboundProcessOutcome>
```

### Step 1 — Validate accountId

```typescript
const accountId = this.sendGridConfig.replyAccountId;
if (!accountId) {
  this.logger.warn("[event=email_assistant_entry_no_account outcome=rejected_unknown_account]");
  return "rejected_unknown_account";
}
```

### Step 2 — Parse and deduplicate

Identical dedup logic as Case 1: extract `messageId` from headers (or SHA-256 fallback), then `PutCommand` on `EMAIL_INBOUND#<messageId>` with `attribute_not_exists(PK)`. If `ConditionalCheckFailedException` → return `"duplicate"`. This ensures even "assistant" entry emails are idempotent.

### Step 3 — Parse sender

```typescript
const senderEmail = parseSenderEmail(formFields.from);
```

Reuses the existing `parseSenderEmail` helper (already in the file).

### Step 4 — Customer lookup

```typescript
const customerResult = await this.customerService.queryCustomerIdByEmail(table, accountId, senderEmail);
```

- If `customerResult === null` → fall through to Case 2 (new session, no customer link). See `handleCase2NewSession`.
- If `customerResult` non-null → continue to freshness check (Case 3).

**Customer-not-found fallback:** Returns `null` from `queryCustomerIdByEmail`. The handler falls through to `handleCase2NewSession` directly. No partial writes. No log of the sender's email (PII guard). Log: `[event=email_assistant_entry_new_visitor outcome=case2]`.

---

## Case 2 Handler (`handleCase2NewSession`)

### Method signature

```typescript
private async handleCase2NewSession(
  formFields: EmailReplySendGridInboundFormFields,
  senderEmail: string,
  accountId: string,
  table: string,
): Promise<EmailReplyInboundProcessOutcome>
```

### Flow

1. Create a new session using the existing direct session-creation path (not `lookupOrCreateSession` — no IDENTITY record is written). The session is created with `customer_id: null`. Confirm the correct call during implementation by reading `identity.service.ts` for a session-creation method that does not touch the IDENTITY table, or by using `ChatSessionService`'s session-creation path directly if one exists.

2. Write the sender's email to `USER_CONTACT_INFO` under the new session so the trio-completion gate in `collect_contact_info` can eventually fire when first/last names arrive. Use `UpdateCommand` on `CHAT_SESSION#<sessionUlid> / USER_CONTACT_INFO` with `SET email = if_not_exists(email, :email)`.

3. Strip quoted reply from `formFields.text`. If empty → return `"rejected_malformed"`.

4. Call `this.chatSessionService.handleMessage(sessionUlid, cleanBody)`.

5. Send outbound reply via `this.emailService.send(...)` with `sessionUlid` encoded in the `from` address (existing pattern).

6. Log `[event=email_assistant_entry_case2 sessionUlid=... outcome=processed]`. Return `"processed"`.

**Note on outbound from-address:** The existing `EmailService.send` uses the `sessionUlid` parameter to construct the reply-from address as `<sessionUlid>@reply.<merchant>.com`. This is unchanged. New sessions from Case 2 get the correct encoded address automatically.

---

## Case 3 Handler Design

### Freshness check mechanic

After `queryCustomerIdByEmail` returns a non-null result with `latestSessionId`:

```typescript
const { customerUlid, latestSessionId } = customerResult;

if (!latestSessionId) {
  // null latest_session_id → treat as stale; create new linked session
  return this.handleCase3StaleNewSession(...);
}

// Fetch prior session METADATA to read _lastUpdated_
const priorMetadata = await this.dynamoDb.send(
  new GetCommand({
    TableName: table,
    Key: {
      PK: `${CHAT_SESSION_PK_PREFIX}${latestSessionId}`,
      SK: METADATA_SK,
    },
  }),
);

if (!priorMetadata.Item) {
  // Prior session METADATA not found (deleted/expired) → treat as stale
  this.logger.warn("[event=email_case3_prior_session_not_found outcome=stale]");
  return this.handleCase3StaleNewSession(...);
}

const lastUpdatedStr: string = priorMetadata.Item._lastUpdated_ ?? "";
const lastUpdated = new Date(lastUpdatedStr).getTime();

if (isNaN(lastUpdated)) {
  // Unparseable timestamp → treat as stale
  this.logger.warn("[event=email_case3_prior_session_bad_timestamp outcome=stale]");
  return this.handleCase3StaleNewSession(...);
}

const ageMs = Date.now() - lastUpdated;

if (ageMs < EMAIL_CONTINUATION_FRESHNESS_WINDOW_MS) {
  return this.handleCase3FreshAttach(latestSessionId, formFields, senderEmail, table);
} else {
  return this.handleCase3StaleNewSession(customerUlid, latestSessionId, formFields, senderEmail, accountId, table);
}
```

**Boundary decision:** `ageMs < EMAIL_CONTINUATION_FRESHNESS_WINDOW_MS` means strictly LESS than 7 days is fresh. Exactly 7 days (`ageMs === EMAIL_CONTINUATION_FRESHNESS_WINDOW_MS`) is stale. Rationale: the brief says "fresh requires strictly less than 7 days" and "exactly 7 days = stale." This is documented in the constant name and a code comment.

**Deleted/expired prior session handling:** If `priorMetadata.Item` is undefined, the freshness check cannot run. Treat as stale — the visitor gets a new session with `continuation_from_session_id` pointing at the missing session. The Phase 2b prior-history loader will fire, the `QueryCommand` on that PK will return zero items (empty array), and the loader will still set `continuation_loaded_at` and pass the customer profile context. Graceful degradation.

---

## `handleCase3FreshAttach` Design

### Method signature

```typescript
private async handleCase3FreshAttach(
  existingSessionUlid: string,
  formFields: EmailReplySendGridInboundFormFields,
  senderEmail: string,
  table: string,
): Promise<EmailReplyInboundProcessOutcome>
```

### Flow

1. Verify sender matches stored email on the existing session. Read `USER_CONTACT_INFO` for `CHAT_SESSION#<existingSessionUlid>`. If `storedEmail !== senderEmail` → return `"rejected_sender_mismatch"`. (Same check as Case 1's sender validation, reused here.)

2. Strip quoted reply from `formFields.text`. If empty → return `"rejected_malformed"`.

3. Call `this.chatSessionService.handleMessage(existingSessionUlid, cleanBody)`. This routes the email body through the existing session — the agent has full session history, no continuation loading needed (same session).

4. Send outbound reply via `this.emailService.send(...)` with `existingSessionUlid`.

5. Log `[event=email_assistant_entry_case3_fresh sessionUlid=... outcome=processed]`. Return `"processed"`.

**No continuation_from_session_id or continuation_loaded_at writes.** The existing session already has `customer_id` set (it was linked at verify_code or collect_contact_info time, or from a prior stale session creation). No METADATA changes needed — the per-turn `_lastUpdated_` write in `handleMessage` covers the timestamp update.

**Note:** `customer.latest_session_id` is already pointing at this session (by construction — it was the customer's `latest_session_id` at decision time). The `latest_session_id` update in `chat-session.service.ts` fires on the agent's reply turn, keeping it current.

---

## `handleCase3StaleNewSession` Design

**Atomicity of METADATA writes:** The session-creation call (no IDENTITY write) initialises `customer_id = null` and `continuation_from_session_id = null`. A separate follow-up `UpdateCommand` is issued immediately after session creation to set all three continuation fields atomically. This follow-up write runs before any `handleMessage` call, so no turn can fire between creation and the field set.

**Captured prior `latestSessionId`:** The value of `customerResult.latestSessionId` (captured when `queryCustomerIdByEmail` returned) is held in a local variable through the entire Case 3 stale flow. This value is passed directly into the METADATA UpdateCommand. It is NOT re-fetched. The `customer.latest_session_id` field is only updated AFTER the agent's first reply turn (via `chat-session.service.ts`'s post-turn write), so the captured value is stable through new-session creation.

### Method signature

```typescript
private async handleCase3StaleNewSession(
  customerUlid: string,
  priorLatestSessionId: string | null,
  formFields: EmailReplySendGridInboundFormFields,
  senderEmail: string,
  accountId: string,
  table: string,
): Promise<EmailReplyInboundProcessOutcome>
```

### Flow

1. Create a new session using the existing direct session-creation path (no IDENTITY record written). The session is created with `customer_id: null`, `continuation_from_session_id: null`, `continuation_loaded_at: null`.

2. Immediately after session creation, issue the atomically-grouped METADATA UpdateCommand that sets all three continuation fields:

```typescript
const customerId = `C#${customerUlid}`;
await this.dynamoDb.send(
  new UpdateCommand({
    TableName: table,
    Key: { PK: `${CHAT_SESSION_PK_PREFIX}${newSessionUlid}`, SK: METADATA_SK },
    UpdateExpression:
      "SET customer_id = :customerId, continuation_from_session_id = :contFrom, continuation_loaded_at = :contAt, #lastUpdated = :now",
    ExpressionAttributeNames: { "#lastUpdated": "_lastUpdated_" },
    ExpressionAttributeValues: {
      ":customerId": customerId,
      ":contFrom": priorLatestSessionId,  // bare ULID of prior session, or null
      ":contAt": null,
      ":now": new Date().toISOString(),
    },
  }),
);
```

This single UpdateCommand sets `customer_id = "C#<customerUlid>"`, `continuation_from_session_id = <prior latestSessionId>` (bare ULID, or null if customer had no prior session), and `continuation_loaded_at = null` — all in one DDB round-trip. The `priorLatestSessionId` is the value captured at `queryCustomerIdByEmail` call time.

3. Write sender's email to `USER_CONTACT_INFO` under the new session (same as Case 2 — `if_not_exists`).

4. Strip quoted reply. If empty → return `"rejected_malformed"`.

5. Call `this.chatSessionService.handleMessage(newSessionUlid, cleanBody)`. On the agent's first response turn:
   - The loader in `chat-session.service.ts` reads METADATA and finds `continuation_from_session_id` non-null and `continuation_loaded_at` null → the loader FIRES.
   - The loader reads the Customer profile and the prior session's last 20 messages, prepends them to `messages`, builds `dynamicSystemContext` with profile + framing, stamps `continuation_loaded_at`.
   - The agent sees the continuation context and crafts a warm returning-visitor greeting.
   - The post-turn write updates `customer.latest_session_id` to `newSessionUlid` (via the `customerId !== null` guard in `chat-session.service.ts`).

6. Send outbound reply with `newSessionUlid` encoded in the reply-to address.

7. Log `[event=email_assistant_entry_case3_stale sessionUlid=... outcome=processed]`. Return `"processed"`.

**No loader code changes.** The loader's gate condition (`continuationFromSessionId !== null && continuationLoadedAt === null`) is already wired in `chat-session.service.ts`. Writing these fields before the first `handleMessage` call is all that is needed.

---

## `SendGridConfigService` Addition

Add one getter:

```typescript
get replyAccountId(): string {
  return this.configService.get<string>("sendgrid.replyAccountId", { infer: true }) ?? "";
}
```

Add to `configuration.ts` under the `sendgrid` key:

```typescript
replyAccountId: process.env.SENDGRID_REPLY_ACCOUNT_ID || "",
```

---

## `EmailReplyService` — New Injections

Add to constructor:

```typescript
private readonly customerService: CustomerService,
```

`CustomerService` is already registered in `AppModule`. `IdentityService` is NOT injected — it is not called in the email-inbound path. If the session-creation call (from review of `identity.service.ts` or `chat-session.service.ts`) requires a different service injection, the implementer should add only what is needed to support a session creation that does not write an IDENTITY record.

---

## Step-by-Step Implementation Sequence

```
1. [src/types/EmailReply.ts] Add LocalPartClassification enum and new outcome variant
   - Add LocalPartClassification enum with three values: SESSION_ULID, ASSISTANT_ENTRY, UNRECOGNIZED
   - Add "rejected_unknown_account" to EmailReplyInboundProcessOutcome union
   - Why first: downstream service imports the enum and the outcome type
   - Done when: TypeScript compiles; enum and updated union are exported

2. [src/config/configuration.ts] Add replyAccountId to sendgrid config key
   - Add: replyAccountId: process.env.SENDGRID_REPLY_ACCOUNT_ID || ""
   - Why second: SendGridConfigService getter reads from this config key
   - Done when: TypeScript compiles; the key is present in the sendgrid config block

3. [src/services/sendgrid-config.service.ts] Add replyAccountId getter
   - Add getter reading "sendgrid.replyAccountId" with ?? "" fallback
   - Why third: EmailReplyService reads this in the handleAssistantEntry dispatcher
   - Done when: TypeScript compiles; getter is public

4. [src/services/email-reply.service.ts] Add constants, classifier, and inject CustomerService
   - Add ASSISTANT_ENTRY_LOCAL_PART = "assistant" at module level
   - Add EMAIL_CONTINUATION_FRESHNESS_WINDOW_MS = 7 * 24 * 60 * 60 * 1000 at module level
   - Add CustomerService import
   - Add CustomerService to constructor parameter list
   - Add UpdateCommand to @aws-sdk/lib-dynamodb import (not currently imported)
   - Add private classifyLocalPart(localPart: string): LocalPartClassification method
   - Confirm which existing method creates a session WITHOUT writing an IDENTITY record
     (read identity.service.ts and chat-session.service.ts before implementing Cases 2/3)
   - Why fourth: all type and config dependencies are in place
   - Done when: TypeScript compiles; classifier method is present and uses ULID_REGEX + ASSISTANT_ENTRY_LOCAL_PART

5. [src/services/email-reply.service.ts] Replace ULID check with dispatcher in processInboundReply
   - Remove the existing if (!ULID_REGEX.test(localPart)) { ... return "rejected_malformed"; } block
   - Replace with: const classification = this.classifyLocalPart(localPart);
   - Add routing:
     - SESSION_ULID → const sessionUlid = localPart; (existing code continues unchanged from here)
     - ASSISTANT_ENTRY → return this.handleAssistantEntry(formFields, table);
     - UNRECOGNIZED → log warning; return "rejected_malformed";
   - Why fifth: the dispatcher is the critical path change; Case 1 code below it is untouched
   - Done when: TypeScript compiles; existing tests still pass (UNRECOGNIZED still returns "rejected_malformed")

6. [src/services/email-reply.service.ts] Add handleAssistantEntry method
   - Validates replyAccountId (returns "rejected_unknown_account" if absent)
   - Runs dedup PutCommand (same logic as Case 1's dedup)
   - Parses senderEmail
   - Calls customerService.queryCustomerIdByEmail
   - Routes to handleCase2NewSession (null result) or freshness check (non-null result)
   - Freshness check reads prior session METADATA, computes ageMs, routes to fresh or stale handler
   - Why sixth: depends on the classifier (step 5) and new service injections (step 4)
   - Done when: TypeScript compiles; method handles all branches

7. [src/services/email-reply.service.ts] Add handleCase2NewSession method
   - Creates new session via direct session-creation path (no IDENTITY record written)
   - Writes sender email to USER_CONTACT_INFO (if_not_exists)
   - Strips quoted reply; returns "rejected_malformed" if empty
   - Calls chatSessionService.handleMessage
   - Calls emailService.send with encoded sessionUlid
   - Returns "processed"
   - Why seventh: used by handleAssistantEntry (step 6)
   - Done when: TypeScript compiles; no IDENTITY table writes

8. [src/services/email-reply.service.ts] Add handleCase3FreshAttach method
   - Verifies sender email against USER_CONTACT_INFO of existing session
   - Strips quoted reply; returns "rejected_malformed" if empty
   - Calls chatSessionService.handleMessage on existingSessionUlid
   - Calls emailService.send with existingSessionUlid
   - Returns "processed"
   - Why eighth: used by handleAssistantEntry (step 6)
   - Done when: TypeScript compiles

9. [src/services/email-reply.service.ts] Add handleCase3StaleNewSession method
   - Creates new session via direct session-creation path (no IDENTITY record written)
   - Issues METADATA UpdateCommand setting customer_id, continuation_from_session_id (captured priorLatestSessionId), continuation_loaded_at: null
   - Writes sender email to USER_CONTACT_INFO (if_not_exists)
   - Strips quoted reply; returns "rejected_malformed" if empty
   - Calls chatSessionService.handleMessage (loader fires on first agent turn)
   - Calls emailService.send with newSessionUlid
   - Returns "processed"
   - Why ninth: uses the captured priorLatestSessionId which must not be re-fetched
   - Done when: TypeScript compiles; UpdateCommand contains all three METADATA fields; no IDENTITY table writes

10. [src/services/email-reply.service.spec.ts] Add tests — see Testing Strategy
    - Add CustomerService mock to module setup
    - Add 25–35 new test cases
    - Why tenth: all implementation is in place before validation
    - Done when: npm test passes; all new cases pass; all existing cases pass unchanged
```

---

## Testing Strategy

### Setup changes to `email-reply.service.spec.ts`

Add to the test module providers:
- `mockCustomerService = { queryCustomerIdByEmail: jest.fn() }`

Injected via `useValue`. Existing mock constants and the `VALID_FORM_FIELDS` fixture remain unchanged. Add new constants:

```typescript
const ASSISTANT_TO = `assistant@${REPLY_DOMAIN}`;
const ACCOUNT_ID = "01ACCOUNTID00000000000000000";
const CUSTOMER_ULID = "01CUSTOMERULID000000000000";
const PRIOR_SESSION_ULID = "01PRIORSESSION0000000000000";
const NEW_SESSION_ULID = "01NEWSESSIONULID00000000000";
```

### Existing test cases — NO changes needed (all pass unchanged)

The existing tests use `VALID_FORM_FIELDS` with `to: '${SESSION_ULID}@${REPLY_DOMAIN}'` where `SESSION_ULID` is a 26-char Crockford ULID. The dispatcher classifies this as `SESSION_ULID` and routes to the unchanged Case 1 path. All existing assertions remain valid.

The test `"returns 'rejected_malformed' when local-part is not a 26-char ULID"` uses `to: 'notaulid@${REPLY_DOMAIN}'`. After Phase 3: `"notaulid"` → `UNRECOGNIZED` → `"rejected_malformed"`. The outcome string is unchanged. Test passes unchanged.

### New test cases

#### Local-part classifier (unit tests on `classifyLocalPart` via the service — or via `processInboundReply` routing behavior)

| # | Test | Input | Expected classification / outcome |
|---|------|-------|----------------------------------|
| 1 | 26-char Crockford ULID → SESSION_ULID | `"01ARZ3NDEKTSV4RRFFQ69G5FAV"` | `SESSION_ULID` |
| 2 | Lowercase "assistant" → ASSISTANT_ENTRY | `"assistant"` | `ASSISTANT_ENTRY` |
| 3 | Uppercase "ASSISTANT" → ASSISTANT_ENTRY (case-insensitive) | `"ASSISTANT"` | `ASSISTANT_ENTRY` |
| 4 | Mixed case "Assistant" → ASSISTANT_ENTRY | `"Assistant"` | `ASSISTANT_ENTRY` |
| 5 | "assistant" with surrounding spaces → ASSISTANT_ENTRY | `" assistant "` | `ASSISTANT_ENTRY` |
| 6 | Empty string → UNRECOGNIZED | `""` | `UNRECOGNIZED` |
| 7 | Arbitrary garbage → UNRECOGNIZED | `"garbage123"` | `UNRECOGNIZED` |
| 8 | 26 non-Crockford chars → UNRECOGNIZED | `"OOOOOOOOOOOOOOOOOOOOOOOOOO"` (26 'O's — 'O' is excluded from Crockford) | `UNRECOGNIZED` |

#### Dispatcher routing (via `processInboundReply` with `to: ASSISTANT_TO`)

| # | Test | Setup | Expected outcome |
|---|------|-------|-----------------|
| 9 | ULID local-part → routes Case 1 (unchanged) | `to: '${SESSION_ULID}@${REPLY_DOMAIN}'`, happy path mocks | `"processed"`, `handleMessage` called with SESSION_ULID |
| 10 | "assistant" local-part, no replyAccountId → rejected_unknown_account | `mockSendGridConfig.replyAccountId = ""` | `"rejected_unknown_account"` |
| 11 | Unrecognized local-part → rejected_malformed | `to: 'garbage@${REPLY_DOMAIN}'` | `"rejected_malformed"` |

#### Case 2 — unknown sender

| # | Test | Setup | Assertion |
|---|------|-------|-----------|
| 12 | Unknown sender → new session, no customer_id | `to: ASSISTANT_TO`; `queryCustomerIdByEmail` returns `null`; session-creation resolves `NEW_SESSION_ULID`; `handleMessage` resolves; `emailService.send` resolves | Returns `"processed"`; session created without customer_id; USER_CONTACT_INFO UpdateCommand called with `if_not_exists(email)`; no METADATA customer_id UpdateCommand; no IDENTITY table write |
| 13 | Dedup: second identical "assistant" email → duplicate | `to: ASSISTANT_TO`; PutCommand throws `ConditionalCheckFailedException` | Returns `"duplicate"` |
| 14 | Case 2 empty body after strip → rejected_malformed | `to: ASSISTANT_TO`; `queryCustomerIdByEmail` returns `null`; body is all quoted | Returns `"rejected_malformed"`; `handleMessage` NOT called |

#### Case 3 fresh — known sender, recent session

| # | Test | Setup | Assertion |
|---|------|-------|-----------|
| 15 | Known sender, session < 7 days old → appended to existing session | `to: ASSISTANT_TO`; `queryCustomerIdByEmail` returns `{ customerUlid, latestSessionId: PRIOR_SESSION_ULID }`; prior METADATA GetCommand returns `{ _lastUpdated_: <2 hours ago ISO> }`; USER_CONTACT_INFO for prior session returns `{ email: senderEmail }`; `handleMessage` resolves | Returns `"processed"`; `handleMessage` called with `PRIOR_SESSION_ULID`; session-creation NOT called; no METADATA customer_id UpdateCommand |
| 16 | Case 3 fresh: sender mismatch on existing session → rejected_sender_mismatch | USER_CONTACT_INFO for PRIOR_SESSION_ULID returns `{ email: "different@example.com" }` | Returns `"rejected_sender_mismatch"` |
| 17 | Case 3 fresh: empty body after strip → rejected_malformed | Body is all quoted | Returns `"rejected_malformed"`; `handleMessage` NOT called |

#### Case 3 stale — known sender, old session

| # | Test | Setup | Assertion |
|---|------|-------|-----------|
| 18 | Known sender, session >= 7 days old → new linked session | `to: ASSISTANT_TO`; `queryCustomerIdByEmail` returns `{ customerUlid, latestSessionId: PRIOR_SESSION_ULID }`; prior METADATA `_lastUpdated_` = 8 days ago; session-creation resolves `NEW_SESSION_ULID`; `handleMessage` resolves | Returns `"processed"`; METADATA UpdateCommand called on `CHAT_SESSION#${NEW_SESSION_ULID}` with `customer_id = "C#${CUSTOMER_ULID}"`, `continuation_from_session_id = PRIOR_SESSION_ULID`, `continuation_loaded_at = null`; `handleMessage` called with NEW_SESSION_ULID; no IDENTITY table write |
| 19 | Case 3 stale: `continuation_from_session_id` is the CAPTURED prior latestSessionId, not re-fetched | Same as #18; verify the UpdateCommand `:contFrom` value equals the `latestSessionId` returned from `queryCustomerIdByEmail` | `:contFrom === PRIOR_SESSION_ULID` |
| 20 | Case 3 stale: customer has null latestSessionId → new session with continuation_from_session_id = null | `queryCustomerIdByEmail` returns `{ customerUlid, latestSessionId: null }` | METADATA UpdateCommand called with `continuation_from_session_id = null`; `customer_id = "C#${CUSTOMER_ULID}"` |
| 21 | Case 3 stale: prior session METADATA not found (GetCommand returns no Item) → treat as stale, create new linked session | `priorMetadata.Item = undefined` | session-creation called; METADATA UpdateCommand called; returns `"processed"` |
| 22 | Case 3 stale: USER_CONTACT_INFO email write uses if_not_exists | Happy path Case 3 stale | USER_CONTACT_INFO UpdateCommand contains `if_not_exists(email` in UpdateExpression |

#### Boundary case

| # | Test | Setup | Assertion |
|---|------|-------|-----------|
| 23 | Exactly 7 days old → STALE (not fresh) | `_lastUpdated_` = exactly `EMAIL_CONTINUATION_FRESHNESS_WINDOW_MS` ms ago | session-creation called (stale path); `handleMessage` called with NEW_SESSION_ULID, not PRIOR_SESSION_ULID |
| 24 | One millisecond under 7 days → FRESH | `_lastUpdated_` = `EMAIL_CONTINUATION_FRESHNESS_WINDOW_MS - 1` ms ago | `handleMessage` called with PRIOR_SESSION_ULID (fresh path); session-creation NOT called |

#### Customer-not-found inside "assistant" branch

| # | Test | Setup | Assertion |
|---|------|-------|-----------|
| 25 | "assistant" entry but customer not in GSI → falls to Case 2 | `queryCustomerIdByEmail` returns `null` | session-creation called; no METADATA customer_id UpdateCommand; no IDENTITY table write; returns `"processed"` |

#### Phase 2b loader integration (document-only — verified by reading existing tests)

The Phase 2b loader fires when `continuation_from_session_id` is non-null and `continuation_loaded_at` is null. The Case 3 stale METADATA write sets these fields before `handleMessage` is called. The `chat-session.service.spec.ts` loader tests already cover gate logic. No new loader test is needed in Phase 3. Document that Phase 3's Case 3 stale write is the email-inbound trigger for the Phase 2b loader.

---

## Risks and Edge Cases

**High — Race between two simultaneous inbound "assistant" emails from the same customer.**

Both read the same `customer.latest_session_id`, both decide stale, both call the session-creation path. Because IDENTITY records are not written, both create independent new sessions without conflict (no `ConditionalCheckFailedException` on an IDENTITY PK). The customer ends up with two sessions — both with `customer_id` set and both with `continuation_from_session_id` pointing at the same prior session. `customer.latest_session_id` ends up pointing at one of them (last-writer-wins in the post-turn write). The dedup PutCommand on `EMAIL_INBOUND#<messageId>` ensures the same physical email is not processed twice. Two emails arriving simultaneously will each create a session; this is acceptable per design's "minor latest ambiguity is fine for v1." Document in code.

**Medium — `_lastUpdated_` on METADATA vs. message-level timestamps.**

The freshness check reads `_lastUpdated_` from the prior session's METADATA record. The METADATA `_lastUpdated_` is updated by `chat-session.service.ts`'s post-turn UpdateCommand (after every assistant reply). This is the same field used throughout the system as the "last active" marker. This is the correct field to check — it reflects actual conversation activity.

**Medium — Implementer must confirm the session-creation path used for Cases 2/3.**

The prior plan called `identityService.lookupOrCreateSession`. This plan explicitly removes that call. The implementer must read `identity.service.ts` and `chat-session.service.ts` to identify the correct method that creates a new chat session WITHOUT writing to the IDENTITY table. If no such direct path exists, the implementer has two options: (a) add a new `createSessionDirect` method to the relevant service, or (b) call the DynamoDB session-creation logic directly from `EmailReplyService`. The implementer should flag this to the orchestrator if neither option is a clean fit. This is the one area where the plan cannot be fully pinned without a deeper read of `identity.service.ts`.

**Medium — Multiple recipients in the `to` field (CC, BCC).**

`processInboundReply` already handles this: it iterates `formFields.to.split(",")` and picks the FIRST address matching `replyDomain`. Phase 3 inherits this behavior unchanged. Only the primary recipient's local-part determines routing. CC/BCC addresses are ignored. Document in a code comment.

**Low — `UpdateCommand` import missing from `email-reply.service.ts`.**

Current imports: `GetCommand, PutCommand` from `@aws-sdk/lib-dynamodb`. Phase 3 adds `UpdateCommand` for the METADATA write in Case 3 stale and the USER_CONTACT_INFO write in Case 2/3. Implementer must add `UpdateCommand` to the import.

**Low — Env var absent in production (`SENDGRID_REPLY_ACCOUNT_ID` not set).**

If the env var is missing, `replyAccountId` returns `""`. The `handleAssistantEntry` method checks `if (!accountId)` and returns `"rejected_unknown_account"`. All Case 1 emails continue to work normally. The "assistant" entry address silently rejects. This is the correct fail-safe behavior.

**Low — `priorLatestSessionId` null when customer has no prior session.**

`queryCustomerIdByEmail` returns `{ customerUlid, latestSessionId: null }` if the customer record has `latest_session_id: null` (e.g., they were created by `collect_contact_info` but never completed a chat session). The code skips the freshness check and routes directly to Case 3 stale with `priorLatestSessionId = null`. The METADATA UpdateCommand sets `continuation_from_session_id = null`. The Phase 2b loader's gate sees `continuation_from_session_id === null` and does NOT fire. The agent starts fresh — no continuation context. This is correct behavior.

---

## Out-of-Scope Confirmations

The following items are explicitly NOT part of Phase CCI-3:

- Per-merchant custom entry addresses (e.g., `chat@<merchant>.com`) — v2.
- DNS / SendGrid Inbound Parse configuration changes — deployment operational items only (see Deployment Note).
- Outbound email infrastructure changes — verified working, no code changes.
- Phone-keyed identity for SMS — future work.
- USER_FACT loading from prior sessions — explicitly deferred.
- Branded merchant-aware verification email templates — Phase 4.
- Tool-level Zod validation hardening — Phase 4.
- Any change to `/chat/web/*`, iframe auth model, or conversation runtime beyond stated scope.
- Refactor of existing TS variable names (`sessionUlid`, etc.) — naming convention applies forward only.
- New Slack alerts — customer-recognition-via-email is not a celebration event.
- Changes to `src/services/chat-session.service.ts` — prior-history loader fires correctly with no new code.
- Changes to `src/app.module.ts` — `CustomerService` is already registered; `IdentityService` is not injected into `EmailReplyService` in Phase 3.
- IDENTITY record writes — explicitly omitted for all email-inbound sessions (see IDENTITY records note above).

---

## Deployment Note

**DNS / SendGrid Inbound Parse — no new configuration required for the "assistant" local-part.**

The `assistant@reply.<merchant>.com` address is just another local-part on the domain that MX records already point at SendGrid Inbound Parse. No new MX records, no new SendGrid Inbound Parse rules, and no new parse-to-webhook configuration is required. The existing `POST /webhooks/sendgrid/inbound` webhook receives all mail for `reply.<merchant>.com` regardless of local-part.

**Required: Set `SENDGRID_REPLY_ACCOUNT_ID` environment variable.**

This is the only operational change required to activate Case 2/3 routing. Without it, the "assistant" entry address silently returns `"rejected_unknown_account"` and no sessions are created from it. Set it to the bare account ULID (no `A#` prefix) of the merchant account that owns this reply domain.

**Operator checklist:**
- [ ] Confirm `SENDGRID_REPLY_DOMAIN` is set and MX records for `reply.<merchant>.com` point at SendGrid.
- [ ] Set `SENDGRID_REPLY_ACCOUNT_ID` to the bare ULID of the owning account.
- [ ] Test by sending an email to `assistant@reply.<merchant>.com` from a new address — expect a new session to be created and a reply to arrive.
- [ ] Test with a known-customer email address — expect the continuation flow to activate.

---

## Needs Orchestrator Decision Before Step 2

**One open item:** The implementer must confirm which existing method creates a chat session WITHOUT writing an IDENTITY record. The prior plan used `identityService.lookupOrCreateSession` — that call is now removed. Before the implementer writes Cases 2 and 3-stale, they need to read `src/services/identity.service.ts` in full and identify:

- Is there a `createSession` or `createNewSession` method that does not touch the IDENTITY table?
- Or is session creation always coupled to an IDENTITY write in the existing code?

If session creation is always coupled to IDENTITY writes today, the implementer must either (a) add a `createSessionWithoutIdentity` method to `IdentityService` or `ChatSessionService`, or (b) write the DDB session-creation calls directly in `EmailReplyService`. The orchestrator should make this call before Step 2 begins to avoid the implementer guessing. The arch-planner was unable to make this determination without reading `identity.service.ts`, which is a review-only file in the existing memory. The implementer's first action should be reading that file.

All other decisions are resolved:
- (a) `accountId` source: new `SENDGRID_REPLY_ACCOUNT_ID` env var via `SendGridConfigService.replyAccountId`. Single-tenant v1 approach; per-merchant routing is v2.
- (b) Case sensitivity of "assistant": case-insensitive (`.trim().toLowerCase()`). Rationale: email clients may case-fold local-parts; defensive matching is correct.
- (c) Boundary decision: exactly 7 days = stale (`ageMs < EMAIL_CONTINUATION_FRESHNESS_WINDOW_MS` is fresh; `>=` is stale).
- (d) Dispatcher shape: `LocalPartClassification` enum + `classifyLocalPart()` private method; `processInboundReply` routes on it.
- (e) Customer-not-found fallback: direct fall-through to Case 2 logic (`handleCase2NewSession`). No partial writes.
- (f) Case 3 stale METADATA atomicity: single UpdateCommand issued immediately after session creation. All three fields (`customer_id`, `continuation_from_session_id`, `continuation_loaded_at`) in one write.
- (g) Captured prior `latestSessionId`: value from `queryCustomerIdByEmail` result, held in local variable, passed directly to the METADATA UpdateCommand. Not re-fetched.
- IDENTITY records: not written for any email-inbound session. Email routing uses Customer GSI + `latest_session_id` exclusively.
- Unrecognized local-part outcome: `"rejected_malformed"` (preserves existing test assertions).
- `app.module.ts`: no changes needed (`CustomerService` already registered; `IdentityService` not injected).
