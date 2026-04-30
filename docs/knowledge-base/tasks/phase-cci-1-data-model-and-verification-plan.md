# Phase CCI-1 — Data Model + Verification Primitives: Implementation Plan

---

## Overview

This phase lays the structural foundation for cross-channel identity and session continuation. It adds two linkage fields (`customer_id` on the session METADATA record; `latest_session_id` on the Customer record), defines a new `VERIFICATION_CODE` DDB record type, and ships two agent-callable tools (`request_verification_code`, `verify_code`) that together form the verification primitive. An outbound verification email is sent via the existing `EmailService.send` path using a minimal plain HTML template. No agent system prompts change. No `collect_contact_info` lookup side-effect. No prior-history context loader. These ship in Phase 2. What ships here is the complete mechanical substrate that Phase 2 will compose into the chat-side verification flow.

---

## Affected Files and Modules

### Create

| File | Purpose |
|------|---------|
| `src/types/Verification.ts` | All new TypeScript interfaces and result union types for this phase |
| `src/tools/request-verification-code.tool.ts` | New tool: generates code, stores hash, sends email |
| `src/tools/request-verification-code.tool.spec.ts` | Unit tests for the tool |
| `src/tools/verify-code.tool.ts` | New tool: validates code, links session to customer |
| `src/tools/verify-code.tool.spec.ts` | Unit tests for the tool |
| `src/services/customer.service.ts` | New shared service: `queryCustomerIdByEmail` lifted from `preview-cart.tool.ts` |
| `src/services/customer.service.spec.ts` | Unit tests for the service |

### Modify

| File | Change |
|------|--------|
| `src/types/ChatSession.ts` | Add `customer_id: string \| null` field to `ChatSessionMetadataRecord` interface |
| `src/types/GuestCart.ts` | Add `latest_session_id: string \| null` field to `GuestCartCustomerRecord` interface |
| `src/services/identity.service.ts` | Initialise `customer_id: null` in METADATA record at session creation |
| `src/tools/preview-cart.tool.ts` | Add `latest_session_id: null` to new Customer records at creation |
| `src/services/chat-session.service.ts` | Wire `latest_session_id` update in the post-turn METADATA update block, guarded by `customer_id !== null` |
| `src/validation/tool.schema.ts` | Add `requestVerificationCodeInputSchema` and `verifyCodeInputSchema` |
| `src/agents/lead-capture.agent.ts` | Add `"request_verification_code"` and `"verify_code"` to `allowedToolNames` |
| `src/agents/shopping-assistant.agent.ts` | Add `"request_verification_code"` and `"verify_code"` to `allowedToolNames` |
| `src/app.module.ts` | Import and register `RequestVerificationCodeTool`, `VerifyCodeTool`, `CustomerService` |

### Review Only (no change)

| File | Reason |
|------|--------|
| `src/tools/tool-registry.service.ts` | `@ChatToolProvider()` auto-discovery is sufficient; no change needed |
| `src/services/email.service.ts` | Existing `send()` signature handles verification email without modification |
| `src/tools/chat-tool.decorator.ts` | Existing decorator applied to both new tools unchanged |

---

## DDB Schema Changes

### A. `CHAT_SESSION#<ulid> / METADATA` — two additions

```typescript
// Addition to ChatSessionMetadataRecord in src/types/ChatSession.ts
// customer_id already exists in the interface as optional — change to explicit null default:
customer_id: string | null;  // "C#<customerUlid>" on verification success; null on creation
```

**Note:** Inspecting `src/types/ChatSession.ts` line 75 shows `customer_id?: string` is already declared as an OPTIONAL field. For Phase CCI-1 the semantics must be sharpened to `string | null` (not optional), so that: (a) `identity.service.ts` explicitly initialises it to `null` in every new METADATA write, and (b) `chat-session.service.ts` can reliably read the field and guard against undefined. The interface change from `customer_id?: string` to `customer_id: string | null` is a tightening of the existing declaration, not a new field.

The `ChatSessionMetadataRecord` interface already contains `customer_email?: string` (line 76). That field is unchanged by this phase.

### B. `C#<customerUlid> / C#<customerUlid>` (Customer record) — one addition

```typescript
// Addition to GuestCartCustomerRecord in src/types/GuestCart.ts
latest_session_id: string | null;  // bare session ULID (no CHAT_SESSION# prefix); null on creation
```

The session ULID stored here has no `CHAT_SESSION#` prefix — consistent with how `session_id` is stored in the IDENTITY record (also a bare ULID).

### C. New record type: `CHAT_SESSION#<ulid> / VERIFICATION_CODE`

```typescript
// New interface in src/types/Verification.ts
export interface VerificationCodeRecord {
  PK: string;                        // "CHAT_SESSION#<sessionUlid>"
  SK: "VERIFICATION_CODE";           // literal string constant
  entity: "VERIFICATION_CODE";
  code_hash: string;                 // SHA-256 hex digest of the zero-padded 6-digit code string
  email: string;                     // the email address being verified (authority at verify time)
  expires_at: string;                // ISO 8601, 10 minutes from issuance
  attempts: number;                  // count of wrong verify_code calls; locked at 5
  request_count_in_window: number;   // count of request_verification_code calls in current window
  request_window_start_at: string;   // ISO 8601 start of the current rate-limit window
  ttl: number;                       // DDB TTL epoch seconds (reaper only; app validates expires_at)
  _createdAt_: string;               // ISO 8601
  _lastUpdated_: string;             // ISO 8601
}
```

**TTL field decision:** The `dynamodb.provider.ts` and `configuration.ts` files do not configure or reference a TTL field name — the DynamoDB client is created with only `region` and `endpoint`. There is no existing code path that sets a `ttl` field on any record. This means TTL enablement on the conversations table is an AWS-console/IaC setting, not a code setting. **This is a "needs orchestrator decision" item** (see section below). The code will write `ttl` as epoch seconds regardless; the field is inert until TTL is enabled on the table in AWS. Application logic ALWAYS validates `expires_at` independently, so correctness is not affected by whether DDB reaping is active.

---

## TypeScript Types — `src/types/Verification.ts` (new file, full content)

```typescript
export interface VerificationCodeRecord {
  PK: string;
  SK: "VERIFICATION_CODE";
  entity: "VERIFICATION_CODE";
  code_hash: string;
  email: string;
  expires_at: string;
  attempts: number;
  request_count_in_window: number;
  request_window_start_at: string;
  ttl: number;
  _createdAt_: string;
  _lastUpdated_: string;
}

export type RequestVerificationCodeResult =
  | { sent: true }
  | { sent: false; reason: "no_email_in_session" }
  | { sent: false; reason: "rate_limited" }
  | { sent: false; reason: "send_failed" };

export type VerifyCodeResult =
  | { verified: true; customerId: string }
  | { verified: false; reason: "no_pending_code" }
  | { verified: false; reason: "expired" }
  | { verified: false; reason: "max_attempts" }
  | { verified: false; reason: "wrong_code" };
```

---

## `request_verification_code` Tool Design

**File:** `src/tools/request-verification-code.tool.ts`

**Tool name:** `"request_verification_code"`

**Description:** `"Send a 6-digit email verification code to the email address on file for this session. Call this when you need to verify the visitor's identity before linking their session to an existing customer account. The email address must already be saved via collect_contact_info. Returns { sent: true } on success, or { sent: false, reason } if the email is missing, the visitor has already requested too many codes recently, or delivery failed."`

**Input schema:** `{}` (no parameters — the email address is read from session context)

**Zod schema in `src/validation/tool.schema.ts`:**
```typescript
export const requestVerificationCodeInputSchema = z.object({}).strict();
export type RequestVerificationCodeInput = z.infer<typeof requestVerificationCodeInputSchema>;
```

### Execute flow (ordered steps):

**Step 1 — Read `USER_CONTACT_INFO` for the session's email.**
DDB `GetCommand` on `{ PK: "CHAT_SESSION#<sessionUlid>", SK: "USER_CONTACT_INFO" }`. Read the `email` attribute. If absent or empty, return `{ sent: false, reason: "no_email_in_session" }`. Stop.

**Step 2 — Read the existing `VERIFICATION_CODE` record (if any) for rate-limit state.**
DDB `GetCommand` on `{ PK: "CHAT_SESSION#<sessionUlid>", SK: "VERIFICATION_CODE" }`. Three cases:

- **No existing record (or record was deleted by a successful verify):** Start a fresh window. `request_count_in_window = 1`, `request_window_start_at = now`. Proceed to Step 3.
- **Existing record, window expired (`now - request_window_start_at > 1 hour`):** Reset window. `request_count_in_window = 1`, `request_window_start_at = now`. Proceed to Step 3.
- **Existing record, window active, count already at 3:** Return `{ sent: false, reason: "rate_limited" }`. Stop. Do NOT overwrite the existing VERIFICATION_CODE record. Do NOT send an email.
- **Existing record, window active, count < 3:** Increment to `request_count_in_window + 1`. Proceed to Step 3.

**Rate-limit semantics note (confirmed):** When the prior VERIFICATION_CODE record was deleted by a successful `verify_code`, the next `request_verification_code` call has no record to read and treats this as a fresh window (counter starts at 1). This is the intended semantics: a successful verification is a "good" event; the rate cap protects against repeated failed rounds, not against legitimate re-engagement after a successful flow.

**Step 3 — Generate the 6-digit code.**
```typescript
const code = crypto.randomInt(0, 1_000_000).toString().padStart(6, "0");
```
This is the SINGLE source of the plaintext code. It is used exactly twice: as input to the SHA-256 hash, and in the email body. It is never written to DDB.

**Step 4 — Hash the code.**
```typescript
import { createHash } from "crypto";
const codeHash = createHash("sha256").update(code).digest("hex");
```
The `code` string passed to `.update()` MUST be the zero-padded string, not a numeric. If `code === "000042"`, then `update("000042")` must be called. This is the consistency invariant: same zero-padded string generated, hashed, and verified.

**Step 5 — Send the email FIRST (ordering decision — see justification below).**
Call `EmailService.send({ to: email, subject: VERIFICATION_EMAIL_SUBJECT, body: buildVerificationEmailBody(code), sessionUlid })`.

If `EmailService.send` throws:
- Return `{ sent: false, reason: "send_failed" }`.
- Do NOT write or overwrite any VERIFICATION_CODE record.
- Log the failure at `logger.error` with `[event=verification_email_failed sessionUlid=... errorType=...]`. Do NOT log the email address or the code.

**Ordering justification (email-first, write-on-success):**
The brief presents two options:
- Option A: Write DDB record first, send email, on failure delete the record.
- Option B: Send email first, write record only on success; if email succeeds but write fails, `verify_code` returns `no_pending_code` (benign).

**Decision: Option B (email-first).** Reasoning: Option A requires a compensating delete, which introduces a second failure mode (the delete itself can fail, leaving a stale record). Option B has one failure mode: email sent but record not written — the visitor receives a code they can never use, and the agent gets `no_pending_code` on the next `verify_code` call. That is a recoverable UX situation (visitor requests another code). Option A's "stale locked record" failure is harder to recover from. Option B is simpler, has fewer code paths, and fails more gracefully.

**Step 6 — Write the `VERIFICATION_CODE` record to DDB.**
Use DDB `PutCommand` (full overwrite — latest-wins semantics). Set all fields including the rate-limit counters determined in Step 2, `code_hash`, `email`, `expires_at` (now + 10 minutes ISO 8601), `attempts: 0`, `ttl` (epoch seconds: `Math.floor((Date.now() + 10 * 60 * 1000) / 1000)` + a small buffer, e.g. `+ 60` seconds to give DDB's eventual reaper headroom), `_createdAt_: now`, `_lastUpdated_: now`.

If this write fails: log error, return `{ sent: false, reason: "send_failed" }`. (The email has already been sent. This failure is logged. The visitor received a code they cannot use — functionally equivalent to the "email sent but record missing" case in Option B above.)

**Step 7 — Return `{ sent: true }`.**

---

## `verify_code` Tool Design

**File:** `src/tools/verify-code.tool.ts`

**Tool name:** `"verify_code"`

**Description:** `"Verify the 6-digit code the visitor just entered against the pending verification code for this session. Call this immediately after the visitor provides the code. Returns { verified: true, customerId } on success, or { verified: false, reason } if the code is wrong, expired, or the maximum number of attempts has been reached."`

**Input schema in Anthropic format:**
```typescript
{
  type: "object",
  properties: {
    code: {
      type: "string",
      description: "The 6-digit verification code the visitor entered.",
    },
  },
  required: ["code"],
}
```

**Zod schema in `src/validation/tool.schema.ts`:**
```typescript
export const verifyCodeInputSchema = z.object({
  code: z.string().length(6).regex(/^\d{6}$/, "code must be a 6-digit numeric string"),
});
export type VerifyCodeInput = z.infer<typeof verifyCodeInputSchema>;
```

### Execute flow (ordered steps):

**Step 1 — Validate input.** Call `verifyCodeInputSchema.safeParse(input)`. If invalid, return `{ result: "Invalid input: ...", isError: true }` in the `ChatToolExecutionResult` wrapper.

**Step 2 — Read the VERIFICATION_CODE record.**
DDB `GetCommand` on `{ PK: "CHAT_SESSION#<sessionUlid>", SK: "VERIFICATION_CODE" }`.

If no record: return `{ verified: false, reason: "no_pending_code" }`. Stop.

**Step 3 — Check expiry.**
If `new Date(record.expires_at) < new Date()`: return `{ verified: false, reason: "expired" }`. Stop. (Do NOT increment attempts on an expired code.)

**Step 4 — Check attempts cap BEFORE hashing.**
If `record.attempts >= 5`: return `{ verified: false, reason: "max_attempts" }`. Stop. The submitted code string is never hashed or compared. This prevents any timing-side-channel information leak about code format.

**Step 5 — Hash the submitted code and compare.**
```typescript
const submittedHash = createHash("sha256").update(parsed.code).digest("hex");
```
The `parsed.code` string is the zero-padded 6-digit string validated by the Zod schema.

If hashes differ: increment `record.attempts` by 1 via DDB `UpdateCommand`. Return `{ verified: false, reason: "wrong_code" }`. Stop.

**Step 6 — Verification success: three sequential writes.**

**Decision on TransactWriteItems vs. separate writes:** Use separate writes. Reasoning: The three writes are logically independent (set customer_id on session, update latest_session_id on customer, delete the VERIFICATION_CODE record). `TransactWriteItems` across three non-contiguous keys adds complexity, an extra DDB consumed capacity tier, and harder error-handling (the transaction error gives no per-item reason). If any individual write fails, the partially-completed state is safe: `customer_id` without `latest_session_id` updated means the customer gets a slightly stale pointer (acceptable per design's "last-writer-wins, minor ambiguity fine for v1"). VERIFICATION_CODE deletion failing means the record eventually expires via TTL and the attempts counter would prevent re-use anyway. Each write is independently logged for observability. Separate writes are simpler and sufficient.

**Write A — Set `customer_id` on session METADATA:**
First, look up the customer ID by the email stored in the VERIFICATION_CODE record (NOT the live `USER_CONTACT_INFO` email — the record's `email` is the authority). Call `CustomerService.queryCustomerIdByEmail(tableName, accountUlid, record.email)`.

If the GSI lookup returns `null` (no customer found for that email under this account): log error `[event=verify_customer_not_found sessionUlid=... errorType=CustomerNotFound]`. Return `{ verified: false, reason: "no_pending_code" }`. (This should be extremely rare since the code was issued from a session that had a known email; "no_pending_code" is the cleanest way to signal "something went wrong" without exposing internal state.)

If the lookup succeeds: `customerId = "C#" + customerUlid` (the full prefixed form stored in the VERIFICATION_CODE write context). Then call DDB `UpdateCommand` on the METADATA record:
```
Key: { PK: "CHAT_SESSION#<sessionUlid>", SK: "METADATA" }
UpdateExpression: "SET customer_id = :customerId, #lastUpdated = :now"
```

**Write B — Update `latest_session_id` on the Customer record:**
```
Key: { PK: "C#<customerUlid>", SK: "C#<customerUlid>" }
UpdateExpression: "SET latest_session_id = :sessionUlid, #lastUpdated = :now"
ExpressionAttributeValues: { ":sessionUlid": sessionUlid }  // bare ULID, no prefix
```
This write is idempotent (same value re-written is a no-op in practice) and last-writer-wins.

**Write C — Delete the VERIFICATION_CODE record (single-use):**
```
DDB DeleteCommand: { PK: "CHAT_SESSION#<sessionUlid>", SK: "VERIFICATION_CODE" }
```

**Step 7 — Return `{ verified: true, customerId: "C#<customerUlid>" }`.**

The `customerId` in the result is the full prefixed form `"C#<customerUlid>"`. This is what the agent receives and can surface to Phase 2's context loader.

---

## Customer-by-Email Lookup Helper — Decision

**Decision: Lift `queryCustomerUlidByEmail` from `preview-cart.tool.ts` into a new `src/services/customer.service.ts`.**

Justification:
1. `verify_code` needs the same GSI lookup that `preview_cart` already does. Duplicating the method in the new tool creates two divergence points for the same critical query.
2. Phase 2 will add the `collect_contact_info` email-lookup side-effect, which requires the same GSI query from a third tool. A shared service is the correct home.
3. The refactor is small: extract the private method, inject `DynamoDBDocumentClient` and `DatabaseConfigService` into the service, update `preview-cart.tool.ts` to inject and call `CustomerService` instead of the private method.
4. The service name in the method is changed from `queryCustomerUlidByEmail` to `queryCustomerIdByEmail` to match the new `_id` naming convention (the returned value is a bare ULID, and the method conceptually returns a "customer id").

`src/services/customer.service.ts` will have one public method:
```typescript
async queryCustomerIdByEmail(
  tableName: string,
  accountUlid: string,
  email: string,
): Promise<string | null>  // returns bare customerUlid (no C# prefix), or null if not found
```

The `gsiName` is read via the injected `ConfigService` (same as `preview-cart.tool.ts` reads it today: `configService.get("webChat.domainGsiName", { infer: true }) ?? "GSI1"`).

---

## Latest-Session-ID Update Path

**Exact location:** `src/services/chat-session.service.ts`, in the `handleMessage` method, in the post-turn METADATA update block.

**Current structure of that block (lines 271–342 approximately):** After the tool loop ends and all `newMessages` are persisted to DDB, `handleMessage` runs two `UpdateCommand` calls: one to update the session METADATA `_lastUpdated_`, and one (best-effort) to update the account-scoped session pointer `_lastUpdated_`. The `latest_session_id` update on the Customer record is added as a third best-effort block immediately after the account-pointer update.

**Why here:** This is the only code path that produces an assistant turn. Every time an assistant reply is persisted, this block runs. Adding the `latest_session_id` write here ensures it fires on every turn — not just at verification time — which is the correct semantics (the customer's "latest active session" is kept current throughout the conversation, not just at the moment of verification).

**Exact guard:**
```typescript
const customerId: string | null = metadataResult.Item?.customer_id ?? null;

if (customerId !== null) {
  // fire latest_session_id update — best-effort, same pattern as account-pointer update
}
```

The `metadataResult` is already read at the top of `handleMessage` (line 71). The `customer_id` field is read from it. The guard is explicitly at this call site — not inside a helper function — so it is visible to the reviewer.

**Implementation detail:** The METADATA GetCommand at the start of `handleMessage` reads the current metadata but does NOT currently read `customer_id`. The implementer must add `customer_id` to the fields read from `metadataResult.Item`. The variable `customerId` is scoped to `handleMessage`, lives alongside `accountUlid`, `budgetCents`, etc.

**The write:**
```typescript
// Best-effort: latest_session_id update failure does not break message handling
if (customerId !== null) {
  const customerUlid = customerId.startsWith("C#") ? customerId.slice(2) : customerId;
  try {
    await this.dynamoDb.send(
      new UpdateCommand({
        TableName: table,
        Key: { PK: customerId, SK: customerId },
        UpdateExpression: "SET latest_session_id = :sessionUlid, #lastUpdated = :now",
        ConditionExpression: "attribute_exists(PK)",
        ExpressionAttributeNames: { "#lastUpdated": "_lastUpdated_" },
        ExpressionAttributeValues: { ":sessionUlid": sessionUlid, ":now": now },
      }),
    );
  } catch (latestSessionError) {
    const errorName = latestSessionError instanceof Error ? latestSessionError.name : "UnknownError";
    if (errorName !== "ConditionalCheckFailedException") {
      this.logger.warn(
        `latest_session_id update failed [errorType=${errorName} sessionUlid=${sessionUlid}]`,
      );
    }
  }
}
```

Note: `customerId` is stored as `"C#<ulid>"` in METADATA. The Customer record's PK and SK are both `"C#<ulid>"`. So the Key uses `customerId` directly.

**Cost:** One DDB `UpdateItem` per assistant turn for verified sessions. This is cheap and idempotent (same ULID re-written is a no-op at the storage layer). For unverified sessions (`customer_id === null`), there is zero additional cost.

---

## Verification Email Template

**Subject constant:** `"Your verification code"`

**Body builder function** (place as a named function or constant in the tool file, not inline):

```html
<!DOCTYPE html>
<html lang="en">
<body style="font-family: Arial, sans-serif; color: #333; max-width: 480px; margin: 0 auto; padding: 24px;">
  <p style="margin: 0 0 16px;">Hi,</p>
  <p style="margin: 0 0 16px;">Here is your verification code:</p>
  <h2 style="font-family: 'Courier New', Courier, monospace; font-size: 36px; letter-spacing: 8px; margin: 0 0 16px; color: #111;">${code}</h2>
  <p style="margin: 0 0 16px;">This code expires in <strong>10 minutes</strong>.</p>
  <p style="margin: 0; color: #888; font-size: 13px;">If you didn't request this, you can safely ignore this email.</p>
</body>
</html>
```

The function signature:
```typescript
function buildVerificationEmailBody(code: string): string
```

`code` is the zero-padded 6-digit string. It is placed directly in the `<h2>` via template literal. The plaintext code exists only in this email body — it is never written to DDB or any log.

---

## Step-by-Step Implementation Sequence

```
1. [src/types/Verification.ts] Create new types file
   - Define VerificationCodeRecord, RequestVerificationCodeResult, VerifyCodeResult
   - Why first: all downstream files import from here
   - Done when: TypeScript compiles; all three types are exported

2. [src/types/ChatSession.ts] Tighten customer_id declaration
   - Change `customer_id?: string` to `customer_id: string | null` in ChatSessionMetadataRecord
   - Why here: must be in place before identity.service.ts change adds the explicit null initialisation
   - Done when: no TypeScript errors; existing code that reads customer_id as optional still compiles
     (optional chaining `?.` on a `string | null` field works without change)

3. [src/types/GuestCart.ts] Add latest_session_id to GuestCartCustomerRecord
   - Add `latest_session_id: string | null` field
   - Why here: must be in place before preview-cart.tool.ts writes it at customer creation
   - Done when: TypeScript compiles; existing GuestCartCustomerRecord usages still satisfy the type
     (the new field is required — all existing `satisfies GuestCartCustomerRecord` expressions
     must add `latest_session_id: null`)

4. [src/validation/tool.schema.ts] Add Zod schemas for the two new tools
   - Add requestVerificationCodeInputSchema, verifyCodeInputSchema and their inferred types
   - Why here: tools import from here; schemas must exist before tool files are created
   - Done when: TypeScript compiles; schemas are exported

5. [src/services/customer.service.ts] Create CustomerService with queryCustomerIdByEmail
   - Inject DynamoDBDocumentClient, DatabaseConfigService, ConfigService
   - Extract the GSI query logic from preview-cart.tool.ts (private method queryCustomerUlidByEmail)
   - Rename the method to queryCustomerIdByEmail (new _id convention)
   - Return type: Promise<string | null> — bare customerUlid (no C# prefix)
   - Why here: verify-code.tool.ts depends on this service; preview-cart.tool.ts will be updated
     to call it in step 8
   - Done when: TypeScript compiles; service is @Injectable()

6. [src/services/identity.service.ts] Initialise customer_id: null in METADATA creation
   - In the UpdateCommand that writes the METADATA record during new-session creation
     (the setClauses / UpdateExpression block, lines ~126–158), add:
     "customer_id = if_not_exists(customer_id, :customerIdNull)"
     with expressionValues[":customerIdNull"] = null
   - Also update the ChatSessionMetadataRecord satisfies object (metadataItem) to include
     customer_id: null if it is still used as a satisfies check
   - Why here: ensures every new session gets customer_id: null from the start
   - Done when: TypeScript compiles; new sessions have explicit customer_id: null

7. [src/tools/preview-cart.tool.ts] Add latest_session_id: null to new Customer records
   - In the customerRecord object (satisfies GuestCartCustomerRecord, line ~607),
     add `latest_session_id: null`
   - Also update the injection list to include CustomerService; remove the private
     queryCustomerUlidByEmail method; replace its call sites with this.customerService.queryCustomerIdByEmail(...)
   - Why here: new Customer records must have the field from creation; also migrates the
     shared lookup to CustomerService
   - Done when: TypeScript compiles; GuestCartCustomerRecord satisfies check passes;
     existing preview_cart behaviour is unchanged

8. [src/tools/request-verification-code.tool.ts] Create the tool
   - Follows save-user-fact.tool.ts shape: @ChatToolProvider() @Injectable(), implements ChatTool
   - Injects: DynamoDBDocumentClient, DatabaseConfigService, EmailService
   - Execute flow as specified in this plan
   - Constants (named, not magic): CODE_LENGTH = 6, CODE_TTL_MINUTES = 10,
     RATE_LIMIT_WINDOW_HOURS = 1, RATE_LIMIT_MAX_REQUESTS = 3,
     VERIFICATION_CODE_SK = "VERIFICATION_CODE", USER_CONTACT_INFO_SK = "USER_CONTACT_INFO",
     METADATA_SK = "METADATA", CHAT_SESSION_PK_PREFIX = "CHAT_SESSION#",
     HASH_ALGORITHM = "sha256", VERIFICATION_EMAIL_SUBJECT = "Your verification code"
   - buildVerificationEmailBody(code: string): string — named function, returns the literal HTML
   - Done when: TypeScript compiles; tool implements ChatTool interface

9. [src/tools/verify-code.tool.ts] Create the tool
   - Follows same shape
   - Injects: DynamoDBDocumentClient, DatabaseConfigService, CustomerService
   - Execute flow as specified in this plan
   - Named constants: VERIFICATION_CODE_SK, METADATA_SK, CHAT_SESSION_PK_PREFIX,
     MAX_ATTEMPTS = 5, HASH_ALGORITHM = "sha256"
   - Done when: TypeScript compiles; tool implements ChatTool interface

10. [src/services/chat-session.service.ts] Wire latest_session_id update in handleMessage
    - Add `const customerId: string | null = metadataResult.Item?.customer_id ?? null;`
      alongside the existing accountUlid / budgetCents reads
    - Add the best-effort latest_session_id UpdateCommand block after the account-pointer
      update, guarded by `if (customerId !== null)`
    - Done when: TypeScript compiles; guard is at the call site; no change to method signature

11. [src/agents/lead-capture.agent.ts] Add new tools to allowedToolNames
    - Add "request_verification_code" and "verify_code" to the allowedToolNames array
    - Done when: TypeScript compiles

12. [src/agents/shopping-assistant.agent.ts] Add new tools to allowedToolNames
    - Add "request_verification_code" and "verify_code" to the allowedToolNames array
    - Done when: TypeScript compiles

13. [src/app.module.ts] Register new providers
    - Import RequestVerificationCodeTool, VerifyCodeTool, CustomerService
    - Add all three to the providers array
    - Done when: AppModule compiles; app.get() resolves all three

14. [Tests — see Testing Strategy section] Write all spec files
    - src/services/customer.service.spec.ts
    - src/tools/request-verification-code.tool.spec.ts
    - src/tools/verify-code.tool.spec.ts
    - Additional cases in existing specs for latest_session_id guard and schema defaults
    - Done when: all new tests pass; existing suite baseline unchanged
```

---

## Testing Strategy

### `src/services/customer.service.spec.ts` (new)

Use `Test.createTestingModule` with mocked `DynamoDBDocumentClient` and `ConfigService`.

| # | Test | Assertion |
|---|------|-----------|
| 1 | Returns bare customerUlid when GSI match found | Mock QueryCommand returns `[{ PK: "C#abc123" }]`; assert returns `"abc123"` |
| 2 | Returns null when GSI returns empty items | Mock QueryCommand returns `[]`; assert returns `null` |
| 3 | Returns null when item PK does not start with `C#` | Mock returns `[{ PK: "BAD#abc" }]`; assert returns `null` |
| 4 | Propagates DDB errors (does not swallow) | Mock QueryCommand rejects; assert `queryCustomerIdByEmail` rejects |

### `src/tools/request-verification-code.tool.spec.ts` (new)

Mock `DynamoDBDocumentClient` (GetCommand, PutCommand), `EmailService.send`, `DatabaseConfigService`. All external calls mocked — no network.

| # | Test | Setup | Assertion |
|---|------|-------|-----------|
| 1 | Happy path | USER_CONTACT_INFO has email; no prior VERIFICATION_CODE record; EmailService resolves; PutCommand resolves | Returns `{ sent: true }`; PutCommand called with correct hash/email/expires_at; EmailService.send called with correct subject and code in body |
| 2 | No email in session | USER_CONTACT_INFO GetCommand returns item with no email field | Returns `{ sent: false, reason: "no_email_in_session" }`; no PutCommand; no EmailService.send |
| 3 | Rate-limited (4th request in window) | VERIFICATION_CODE record exists with request_count_in_window=3, request_window_start_at=10 minutes ago | Returns `{ sent: false, reason: "rate_limited" }`; no PutCommand overwrite; no EmailService.send |
| 4 | Window expired (>1h ago), counter resets | VERIFICATION_CODE record exists with request_count_in_window=3, request_window_start_at=2 hours ago | Returns `{ sent: true }`; new record written with request_count_in_window=1 |
| 5 | Email send failure | EmailService.send rejects | Returns `{ sent: false, reason: "send_failed" }`; PutCommand NOT called |
| 6 | Zero-padding preserved | Mock resolves happy path | Assert the code written to DDB (via PutCommand call capture) and the code in the email body are the SAME zero-padded string; assert SHA-256 of that string equals the stored code_hash |

### `src/tools/verify-code.tool.spec.ts` (new)

Mock `DynamoDBDocumentClient` (GetCommand, UpdateCommand, DeleteCommand), `CustomerService`.

| # | Test | Setup | Assertion |
|---|------|-------|-----------|
| 1 | Happy path | Valid VERIFICATION_CODE record; attempts=0; not expired; correct code; CustomerService returns "abc123" | Returns `{ verified: true, customerId: "C#abc123" }`; METADATA UpdateCommand called with customer_id; Customer UpdateCommand called with latest_session_id=sessionUlid; DeleteCommand called on VERIFICATION_CODE |
| 2 | Wrong code | VERIFICATION_CODE exists; hash mismatch | Returns `{ verified: false, reason: "wrong_code" }`; UpdateCommand increments attempts; no customer_id write; no delete |
| 3 | Expired code | expires_at is 1 minute in the past | Returns `{ verified: false, reason: "expired" }`; no attempts increment; no writes |
| 4 | Max attempts reached | attempts=5 | Returns `{ verified: false, reason: "max_attempts" }`; code is never hashed; no writes |
| 5 | No pending code | GetCommand returns no item | Returns `{ verified: false, reason: "no_pending_code" }` |
| 6 | Customer not found by email | VERIFICATION_CODE exists; CustomerService returns null | Returns `{ verified: false, reason: "no_pending_code" }`; error logged; no customer_id write |
| 7 | Attempts checked BEFORE hash | Spy on createHash | With attempts=5, assert createHash is never called |
| 8 | Authority email used | VERIFICATION_CODE record has email="a@b.com"; session USER_CONTACT_INFO has different email | CustomerService called with the record's email ("a@b.com"), not the live contact-info email |

### Schema default tests (add to existing or create small integration-style spec)

| # | Test | Assertion |
|---|------|-----------|
| 1 | identity.service.ts new-session METADATA write includes customer_id: null | Capture UpdateCommand args; assert `:customerIdNull` is `null` in ExpressionAttributeValues |
| 2 | preview-cart.tool.ts new Customer creation includes latest_session_id: null | Capture PutCommand args for the customer record; assert `latest_session_id === null` |

### latest_session_id guard test (add to `chat-session.service.spec.ts` if it exists, or a new spec)

| # | Test | Assertion |
|---|------|-----------|
| 1 | latest_session_id UpdateCommand fires when customer_id is non-null | Mock METADATA GetCommand to return `customer_id: "C#abc123"`; assert UpdateCommand called on the Customer record |
| 2 | latest_session_id UpdateCommand does NOT fire when customer_id is null | Mock METADATA GetCommand to return `customer_id: null`; assert no UpdateCommand on the Customer PK |
| 3 | latest_session_id update failure does not propagate | Mock Customer UpdateCommand to reject; assert handleMessage resolves normally |

---

## Risks and Edge Cases

**High — Zero-padding consistency.**
The 6-digit code MUST be zero-padded at generation, at hash input, and in the email body. If `crypto.randomInt(0, 1_000_000)` returns `42`, the string `"000042"` must be used in all three places. A hash of `"42"` and a comparison against the hash of `"000042"` will never match — the verification flow silently fails for any code with leading zeros. The Zod schema for `verify_code` input (`z.string().length(6).regex(/^\d{6}$/)`) enforces that the visitor's submitted code is always 6 characters, which means the browser/chat UX must also preserve leading zeros. The spec test #6 above explicitly asserts this invariant.

**High — DDB TTL not yet confirmed enabled.**
The conversations table TTL configuration is an AWS-level setting not visible in this codebase. If TTL is not enabled, the `ttl` field written to VERIFICATION_CODE records is inert — records will not be auto-deleted by DDB. Application logic validates `expires_at` independently, so correctness is unaffected. But stale locked records (attempts=5, code expired) accumulate in the table. See "Needs Orchestrator Decision" below.

**Medium — Race between two parallel `request_verification_code` calls in the same session.**
Two simultaneous calls both read the rate-limit counter and both get count=2, then both write a new VERIFICATION_CODE record. The last writer wins (latest `code_hash` survives). The rate-limit window counter written by the second write reflects +1 from the value that write read — not accounting for the first write. In the worst case, a single extra code is emitted (3 requested, rate-limit detects 3, but a race allows a 4th). This is acceptable for v1: the rate-limit is a spam-protection heuristic, not a hard security boundary. A DDB conditional expression could enforce strict atomicity but the added complexity is not justified at this scale (human-paced chat interactions; simultaneous calls are not a real attack surface). Document this explicitly in the code.

**Medium — `customer_id` field already declared as `customer_id?: string` in `ChatSessionMetadataRecord`.**
The existing declaration is optional (undefined). The change to `string | null` is a tightening. All code that currently reads `metadataResult.Item?.customer_id` will continue to work — `?.` still handles both `null` and `undefined`. The satisfies expressions at new-session creation in identity.service.ts must include the field explicitly. Review all existing satisfies/type assertions against `ChatSessionMetadataRecord` and update them.

**Medium — preview-cart.tool.ts `satisfies GuestCartCustomerRecord` will fail to compile after step 3.**
The `GuestCartCustomerRecord` interface gains a required `latest_session_id: string | null` field. The `customerRecord` object in `resolveCustomerUlid` uses a `satisfies` check (line ~607–625). The implementer must add `latest_session_id: null` to that object or TypeScript will error. This is intentional — the satisfies check is the guard that enforces the field is always written.

**Low — `customerId` format in `verify_code` return value.**
The tool returns `customerId: "C#<customerUlid>"` (prefixed). Phase 2 will need to strip the prefix when using this value to look up the Customer record for context loading. Document the format in the type definition. Alternatively, the return type could be the bare ULID. **Decision: return the full `"C#<customerUlid>"` form**, matching how `customer_id` is stored on the METADATA record. Phase 2 agents receive the full form; stripping is a one-liner when needed.

**Low — `gsiName` configuration needed in `CustomerService`.**
The GSI name (`"GSI1"` by default, overridable via `DYNAMODB_ACCOUNTS_DOMAIN_GSI_NAME`) is currently read from `ConfigService` inside `PreviewCartTool`'s constructor. `CustomerService` needs to read the same value. Inject `ConfigService` into `CustomerService` and read it the same way. No new environment variable.

**Low — No Slack alerts for verification events.**
Phase 1 adds zero Slack alerts. The locked rule from Phase 8b-followup (no PII in Slack) applies here absolutely — the email, code, customer name, and customer ID must never appear in any Slack alert. Verification events, if ever surfaced, would go to Sentry as breadcrumbs only. Phase 1 does not add any Sentry breadcrumbs either.

---

## Out-of-Scope Confirmations

The following items are explicitly NOT included in Phase CCI-1:

- `collect_contact_info` email-lookup side-effect — Phase 2.
- Updates to `lead_capture` or `shopping_assistant` system prompts — Phase 2.
- Prior-history context loader (loads 20–30 messages post-verification) — Phase 2.
- SendGrid Inbound Parse webhook discrimination (Case 2/Case 3 logic) — Phase 3.
- Per-merchant branded verification email templates — Phase 4.
- Lifting Customer creation upstream from `preview_cart` to email-capture — Phase 2.
- New GSI on the Customer record — explicitly deferred.
- SMS / phone verification primitives — future work.
- Any change to `/chat/web/*` controllers or iframe auth model.
- Any refactor of existing TS variable names (`sessionUlid`, etc.).
- Any new Slack alert with customer PII — locked rule.
- Discord agent changes.
- Any change to the email-reply inbound flow (`email-reply.service.ts`).

---

## Needs Orchestrator Decision (before code-implementer is dispatched)

**1. DDB TTL on the conversations table — confirm it is enabled and field name is `ttl`.**

The implementation plan writes `ttl` (epoch seconds) to every `VERIFICATION_CODE` record. This is the standard DDB TTL field name convention and the name specified by the design. However, TTL must be explicitly enabled on the table in AWS (via the console, AWS CLI, or Terraform/CDK). If it is not enabled:

- VERIFICATION_CODE records will not be automatically deleted after expiry.
- Application logic still validates `expires_at`, so verification correctness is unaffected.
- But stale records accumulate indefinitely.

**Action needed:** Confirm that the conversations table has DDB TTL enabled and that the TTL attribute name is `ttl`. If not enabled, enable it (one AWS API call; zero code change; zero downtime). If the attribute name differs from `ttl`, update the plan accordingly before implementation begins.
