# Plan: SMS Channel via Twilio (third channel — parallel to email)

## Objective

Add SMS as a third inbound conversation channel alongside web and email. A visitor can text the deployment's Twilio phone number; the message routes to a chat session (cold entry, fresh continuation, or stale-session reset based on the sender's phone number) and the agent's reply is sent back via SMS. Phone number becomes a parallel identity key on the customer record (mirroring email today via a new GSI2). The SMS stack is fully self-contained — its own webhook controller, reply service, transport service, and config service — exactly the way the email stack stands today. No abstraction is extracted between email and SMS; each channel owns its own domain end-to-end. When a fourth channel arrives, it gets its own stack the same way.

This plan respects the project's guiding principles:
- **LLM drives intent, code enforces invariants** — the inbound phone number is stamped by the controller into `USER_CONTACT_INFO`; the LLM never receives or routes raw phone PII.
- **Defense-in-depth** — Twilio webhook signature is verified at the controller before any DDB read; sender-phone GSI lookup is the source of truth for routing decisions.
- **Single-responsibility services** — SMS-specific logic lives in its own files. Shared logic (session creation, agent dispatch) reuses existing services.
- **Scalability is the guiding star** — the customer record is extended with GSI2 keys (PHONE-by-account); future channels can add their own GSIs without disturbing existing ones.

---

## Affected Files

**Create:**
- `src/controllers/twilio-webhook.controller.ts` — owns the `POST /webhooks/twilio/inbound` route, signature verification, form parsing
- `src/controllers/twilio-webhook.controller.spec.ts` — controller tests
- `src/services/twilio-config.service.ts` — env-var wrapper for Twilio credentials and the deployment's owned phone number
- `src/services/sms.service.ts` — thin Twilio SDK wrapper (single `send` method)
- `src/services/sms.service.spec.ts` — service tests
- `src/services/sms-reply.service.ts` — owns inbound classification, 3-case routing (cold entry / fresh continuation / stale reset), agent dispatch, outbound reply
- `src/services/sms-reply.service.spec.ts` — service tests
- `src/types/SmsReply.ts` — `SmsReplyTwilioInboundFormFields`, `SmsReplyInboundProcessOutcome`, `SmsReplyRecord`

**Modify:**
- `src/services/customer.service.ts` — add `queryCustomerIdByPhone(tableName, accountUlid, phone)` mirroring `queryCustomerIdByEmail`; extend `lookupOrCreateCustomer` to write `GSI2-PK` and `GSI2-SK` when phone is non-null
- `src/services/customer.service.spec.ts` — add tests for `queryCustomerIdByPhone`; assert GSI2 key writes in `lookupOrCreateCustomer`
- `src/types/GuestCart.ts` — add `GSI2-PK?: string` and `GSI2-SK?: string` to `GuestCartCustomerRecord`
- `src/app.module.ts` — register the four new providers + new controller

**Review only (no changes):**
- `src/services/email.service.ts`, `src/services/email-reply.service.ts`, `src/services/sendgrid-config.service.ts`, `src/controllers/sendgrid-webhook.controller.ts` — referenced as the parallel pattern; **must not be modified**
- `src/services/session.service.ts` — `lookupOrCreateSession` accepts the new `"sms"` source value; the field type is already `string`, so no type change is needed
- `src/services/chat-session.service.ts` — agent dispatch is channel-agnostic; the SMS path calls `handleMessage` like email does
- `src/tools/collect-contact-info.tool.ts` — already reads `USER_CONTACT_INFO` post-write to assemble the full contact record before customer creation; the SMS controller stamping phone on `USER_CONTACT_INFO` at session creation is sufficient — **no changes inside this tool**

**Infrastructure (out of code scope, called out for awareness):**
- DynamoDB GSI2 must be provisioned on the conversations table:
  - Index name: `GSI2`
  - Hash key (`GSI2-PK`): `String`
  - Range key (`GSI2-SK`): `String`
  - Projection: ALL (matching GSI1's projection convention so customer records are fully readable from the index)
- Whoever owns the table provisioning (Terraform, CDK, or manual) must add this index before this code is deployed. The plan assumes GSI2 will be in place at deploy time.

---

## Architectural Notes

### SMS routing has 3 cases, not 4

Email's local-part classification has four routes (`SESSION_ULID`, `ASSISTANT_ENTRY`, `UNRECOGNIZED`). SMS does not have a per-session phone number equivalent — every inbound message goes to the same Twilio number — so SMS classification is purely by sender phone via GSI2:

1. **Case 2 (cold entry):** Sender's phone is not in GSI2 for this account → mint a fresh session with `source: "sms"`, default agent `lead_capture`, stamp the phone on `USER_CONTACT_INFO`.
2. **Case 3 fresh:** Sender's phone is in GSI2; their `latest_session_id` resolves to a session whose `_lastUpdated_` is < 7 days old → attach to that session.
3. **Case 3 stale:** Sender's phone is in GSI2 but `latest_session_id` is null, missing, or > 7 days old → mint a new session, link via `continuation_from_session_id` to the prior session ULID (so the continuation loader fires on the next turn, exactly like email).

The 7-day staleness window is identical to email's `EMAIL_CONTINUATION_FRESHNESS_WINDOW_MS`. SMS gets its own constant `SMS_CONTINUATION_FRESHNESS_WINDOW_MS = 7 * 24 * 60 * 60 * 1000` so future tuning of one channel's window does not silently affect the other.

### Phone normalization must be E.164 always

Twilio always sends sender phone in E.164 format (e.g., `+15551234567`). All writes to GSI2 (`PHONE#<E.164>`) and to the customer record's `phone` field must store this exact format. No spaces, no dashes, no parentheses. If the controller ever receives a non-E.164 value (manual test, malformed webhook), it logs a warning and rejects with `"rejected_malformed"`. Never normalize silently — that would create lookup divergence between writers (controller vs. tool).

### Twilio webhook signature verification is mandatory and at the controller layer

Twilio signs every webhook with HMAC SHA1 over the full URL + sorted form parameters, base64-encoded, in the `X-Twilio-Signature` header. The controller verifies this signature using `TWILIO_AUTH_TOKEN` BEFORE any DDB read or business logic. A missing or invalid signature returns HTTP 200 with no body (Twilio's recommendation: don't reveal verification state to potential attackers) and logs an `[event=twilio_signature_invalid]` warning at the warn level.

The Twilio SDK exposes `twilio.validateRequest(authToken, signature, url, params)` — use it. Do not roll a custom HMAC implementation. (The SendGrid webhook does not currently verify signatures; that is a separate gap and is **out of scope** for this phase. Adding signature verification here for SMS is the right thing to do because Twilio makes it cheap; the SendGrid hardening is queued as a future phase.)

### Phone PII must never reach the LLM

The sender's phone arrives at the controller. The controller stamps it on `USER_CONTACT_INFO` at session creation. The agent's tools (`collect_contact_info`, etc.) read `USER_CONTACT_INFO` from DDB when they need contact details. The phone is never injected into the agent's `messages[]` content, never appears in the system prompt, never appears in tool input/output schemas exposed to the LLM. This matches the May 2 architectural rule: *the LLM drives intent; the code enforces invariants*.

For Case 3 fresh-attach, the SMS controller does NOT re-stamp the phone if `USER_CONTACT_INFO` already has it (phone was captured in a prior session). The `if_not_exists`-style write semantics on the contact-info update prevent overwriting a manually-entered phone.

### Dedupe: Twilio MessageSid, not Message-ID

Email dedupes on the SHA-256 hash of the `Message-ID:` header (with a fallback hash of `from + subject + text` if the header is missing). SMS dedupes on Twilio's `MessageSid` (a unique 34-char identifier Twilio attaches to every message — `SM` + 32 alphanumeric chars). Because `MessageSid` is already unique and uniformly present, no fallback hashing is needed.

The dedupe record is stored as:
- `PK = SMS_INBOUND#<MessageSid>`
- `SK = METADATA`
- `processedAt: ISO 8601`
- `sessionId: CHAT_SESSION#<ulid> | null`

Written via `PutCommand` with `ConditionExpression: "attribute_not_exists(PK)"`; `ConditionalCheckFailedException` is converted to outcome `"duplicate"`.

### `lookupOrCreateCustomer` writes BOTH GSI1 and GSI2

When a customer record is created and `phone` is non-null, the customer record now carries:
- `GSI1-PK = ACCOUNT#<accountUlid>`, `GSI1-SK = EMAIL#<email>` (existing)
- `GSI2-PK = ACCOUNT#<accountUlid>`, `GSI2-SK = PHONE#<phone>` (new)

When phone is null at customer creation time (e.g., a web visitor who only shared email), the customer record carries only GSI1 keys. A later session in which the same customer shares their phone via `collect_contact_info` does NOT currently retroactively add GSI2 keys (that would be a separate feature). For SMS-cold-entry visitors, phone is always present at customer creation time because the SMS controller stamped it on `USER_CONTACT_INFO` before `collect_contact_info` ran. So GSI2 will be populated for every SMS-originated customer.

### One Twilio number per deployment for v1

The deployment owns one phone number, configured via `TWILIO_PHONE_NUMBER` env var. That number maps to one account via `TWILIO_REPLY_ACCOUNT_ID`. This mirrors email's `SENDGRID_REPLY_ACCOUNT_ID` shape exactly. Multi-tenant routing (a lookup table mapping inbound phone numbers to accounts) is a future phase, not v1.

### `collect_contact_info` is unchanged

The tool already queries `USER_CONTACT_INFO` post-write to gather all fields (including phone) before calling `lookupOrCreateCustomer`. As long as the SMS controller writes phone to `USER_CONTACT_INFO` before the agent runs, the existing flow works untouched. The tool's input schema still accepts `phone` as an optional LLM-passed field; for SMS sessions it's redundant (controller has already stamped it) but harmless.

---

## Step-by-Step Implementation Sequence

### Step 1 — Create `src/services/twilio-config.service.ts`

**What:** A NestJS `@Injectable()` config wrapper that exposes Twilio credentials and the deployment's owned phone number from `ConfigService`. Mirrors `SendGridConfigService` exactly.

**Why first:** Every downstream Twilio component (SmsService, SmsReplyService, TwilioWebhookController) depends on this. Build the config layer before anything that consumes it.

**Implementation details:**
- Constructor injects `ConfigService`.
- Getters:
  - `accountSid: string` ← `twilio.accountSid` config key
  - `authToken: string` ← `twilio.authToken` config key
  - `phoneNumber: string` ← `twilio.phoneNumber` config key (the deployment's own E.164 number, e.g., `+15558675309`)
  - `replyAccountId: string` ← `twilio.replyAccountId` config key
- All getters return `?? ""` to match `SendGridConfigService` style.
- Add the corresponding entries to `src/config/configuration.ts` (or wherever the project's config schema lives — the implementer must locate this file and follow the existing pattern; SendGrid's config keys are the model).
- Env vars (documented in the file's JSDoc): `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER`, `TWILIO_REPLY_ACCOUNT_ID`.
- Do NOT log auth tokens or any redacted form of them. The auth token is for signature verification only.

**Done when:** File compiles; the four getters return values from `ConfigService`; the config schema exposes the four corresponding keys.

---

### Step 2 — Create `src/types/SmsReply.ts`

**What:** Type definitions for the Twilio inbound webhook form fields, the process-outcome union, and the dedupe record shape. Mirror `src/types/EmailReply.ts`.

**Why here:** Types must exist before services that consume them.

**Implementation details:**

```ts
export interface SmsReplyTwilioInboundFormFields {
  MessageSid: string;
  AccountSid: string;
  From: string;             // E.164 sender, e.g., "+15551234567"
  To: string;               // E.164 deployment number, e.g., "+15558675309"
  Body: string;             // raw message body
  NumMedia?: string;        // count of attachments (digits as string); 0 expected for v1
  FromCity?: string;
  FromState?: string;
  FromCountry?: string;
  // ... other Twilio fields are accepted via index but not typed here
}

export type SmsReplyInboundProcessOutcome =
  | "processed"
  | "duplicate"
  | "rejected_unknown_account"
  | "rejected_signature_invalid"
  | "rejected_malformed";

export interface SmsReplyRecord {
  PK: string;               // "SMS_INBOUND#<MessageSid>"
  SK: string;               // "METADATA"
  processedAt: string;      // ISO 8601
  sessionId: string | null; // "CHAT_SESSION#<sessionUlid>" or null
}
```

- `MessageSid`, `AccountSid`, `From`, `To`, `Body` are required because they always come from Twilio. Optional fields are typed as `?: string` to keep the contract honest.
- The outcome union deliberately omits `"rejected_sender_mismatch"` because SMS has no "session-aware" routing equivalent of email's Case 1 (no per-session phone number). There is no path where the sender mismatches stored contact info.
- Crockford-valid 26-char ULIDs only in any test fixtures that cite this type.

**Done when:** File compiles; types are importable from sibling files.

---

### Step 3 — Create `src/services/sms.service.ts`

**What:** A thin `@Injectable()` wrapper around the Twilio SDK with one public method: `send({ to, body, sessionUlid? })` returning `{ messageSid }`. Mirrors `EmailService` in shape.

**Why here:** Depends on `TwilioConfigService` (Step 1) and the types (Step 2).

**Implementation details:**
- Import: `import twilio from "twilio";` (default import, matches the SDK's documented usage).
- Constructor instantiates the Twilio client lazily: `this.client = twilio(this.twilioConfig.accountSid, this.twilioConfig.authToken)`.
- Public method:
  ```
  async send(params: SmsSendParams): Promise<SmsSendResult> {
    const fromNumber = this.twilioConfig.phoneNumber;
    if (!fromNumber) {
      this.logger.error("TWILIO_PHONE_NUMBER not set — cannot send SMS [sessionUlid=...]");
      throw new Error("TWILIO_PHONE_NUMBER not configured");
    }
    try {
      const message = await this.client.messages.create({
        from: fromNumber,
        to: params.to,
        body: params.body,
      });
      this.logger.log(`SMS sent successfully [messageSid=${message.sid} sessionUlid=${params.sessionUlid ?? "n/a"}]`);
      return { messageSid: message.sid };
    } catch (error) {
      // mirror EmailService error-extraction pattern: pull error.name, error.code, error.moreInfo
      const errorRecord: { name?: unknown; code?: unknown; moreInfo?: unknown } =
        error !== null && error !== undefined ? error : {};
      const errorName = String(errorRecord.name ?? "unknown");
      const errorCode = String(errorRecord.code ?? "unknown");
      const moreInfo = String(errorRecord.moreInfo ?? "none");
      this.logger.error(`SMS send failed [errorType=${errorName} code=${errorCode} moreInfo=${moreInfo}]`);
      throw error;
    }
  }
  ```
- Types `SmsSendParams` and `SmsSendResult` go in `src/types/Sms.ts` (a new file); follow the same pattern as `src/types/Email.ts`.
- No header/threading metadata equivalent to email's `In-Reply-To` — SMS has no threading concept. The send method is intentionally narrower than email's.

**Done when:** File compiles; calling `.send({ to, body })` against a Twilio sandbox account from a unit test (or an integration probe) returns a valid `messageSid`.

---

### Step 4 — Modify `src/services/customer.service.ts` and `src/types/GuestCart.ts`

**What:**
1. Add `queryCustomerIdByPhone(tableName, accountUlid, phone)` mirroring `queryCustomerIdByEmail`. Same return shape: `{ customerUlid, latestSessionId } | null`.
2. Extend `lookupOrCreateCustomer` to write `GSI2-PK` and `GSI2-SK` to the customer record when `phone` is non-null.
3. Extend `GuestCartCustomerRecord` with optional `GSI2-PK?: string` and `GSI2-SK?: string` fields.

**Why here:** Required by SmsReplyService (Step 5) for sender lookup. Required by `lookupOrCreateCustomer`'s GSI2 writes so that SMS-originated customers are findable on subsequent inbound messages.

**Implementation details:**

For `queryCustomerIdByPhone`:
- Add `PHONE_PREFIX = "PHONE#"` to the local constants block at the top of `customer.service.ts`.
- Add a private field `phoneGsiName: string` populated from `webChat.phoneGsiName` config key (default `"GSI2"`). Mirror the existing `gsiName` (GSI1) field.
- The new method's body is structurally identical to `queryCustomerIdByEmail` with three substitutions: `IndexName` → `phoneGsiName`, `GSI1-PK`/`GSI1-SK` → `GSI2-PK`/`GSI2-SK`, `EMAIL#` → `PHONE#`.
- The `latest_session_id` defensive-prefix-strip block is duplicated verbatim from `queryCustomerIdByEmail` (it's per-customer logic, not per-key-pattern logic). The existing helper code path is correct; do not extract a shared helper in this phase.

For `lookupOrCreateCustomer`:
- In Step B (build customer record), when `input.phone !== null`, set:
  - `record["GSI2-PK"] = ${ACCOUNT_PREFIX}${input.accountUlid}`
  - `record["GSI2-SK"] = ${PHONE_PREFIX}${input.phone}`
- When `input.phone === null`, omit both keys (DynamoDB stores them as absent attributes; the GSI2 sparsely indexes only customers with a phone).

For `GuestCartCustomerRecord`:
- Add `"GSI2-PK"?: string` and `"GSI2-SK"?: string` to the interface alongside the existing `"GSI1-PK"` and `"GSI1-SK"`.

**Done when:**
- `queryCustomerIdByPhone` returns the same shape as `queryCustomerIdByEmail` for an existing phone-keyed customer.
- A customer created via `lookupOrCreateCustomer` with a non-null phone has `GSI2-PK` and `GSI2-SK` attributes in the DDB record (verifiable in spec via mock assertion).
- A customer created with `phone: null` has neither GSI2 attribute.
- `customer.service.spec.ts` has at least 4 new test cases:
  - `queryCustomerIdByPhone` happy path
  - `queryCustomerIdByPhone` returns null when no item matches
  - `lookupOrCreateCustomer` writes GSI2 keys when phone is non-null
  - `lookupOrCreateCustomer` omits GSI2 keys when phone is null

---

### Step 5 — Create `src/services/sms-reply.service.ts`

**What:** The core inbound routing service. Owns classification (3-case) + agent dispatch + outbound reply. Structurally parallels `EmailReplyService` but is shorter (no Case 1 equivalent, no quoted-reply stripping, simpler dedupe).

**Why here:** Depends on `TwilioConfigService`, `SmsService`, `CustomerService` (extended), `SessionService`, `ChatSessionService`. Last service to build before the controller.

**Implementation details:**

Module-level constants:
```
const SMS_INBOUND_PK_PREFIX = "SMS_INBOUND#";
const METADATA_SK = "METADATA";
const CONTACT_INFO_SK = "USER_CONTACT_INFO";
const CHAT_SESSION_PK_PREFIX = "CHAT_SESSION#";
const CONDITIONAL_CHECK_FAILED = "ConditionalCheckFailedException";
const SMS_CONTINUATION_FRESHNESS_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const E164_REGEX = /^\+[1-9]\d{1,14}$/;  // E.164 spec
```

Module-level helpers:
- `isConditionalCheckFailed(error: unknown): boolean` — copy verbatim from email-reply.service.ts (each service owns its own copy; do NOT extract a shared helper in this phase).
- `buildRedactedPhone(phone: string): string` — returns `"+1***1234"` style (country code + last 4 digits + asterisks middle). Used in log lines for sender info; never logs the full phone.

Constructor injects:
- `@Inject(DYNAMO_DB_CLIENT) dynamoDb: DynamoDBDocumentClient`
- `databaseConfig: DatabaseConfigService`
- `twilioConfig: TwilioConfigService`
- `smsService: SmsService`
- `chatSessionService: ChatSessionService`
- `customerService: CustomerService`
- `sessionService: SessionService`

Public method `processInboundMessage(formFields: SmsReplyTwilioInboundFormFields): Promise<SmsReplyInboundProcessOutcome>`:

Phase 1 — Account guard:
- Read `accountId = this.twilioConfig.replyAccountId`.
- If empty/missing, log `[event=sms_inbound_no_account outcome=rejected_unknown_account]` warn, return `"rejected_unknown_account"`.

Phase 2 — Phone format guard:
- Validate `formFields.From` against `E164_REGEX`. On mismatch, log warn `[event=sms_inbound_bad_phone_format outcome=rejected_malformed]` and return `"rejected_malformed"`.
- Validate `formFields.Body` is a non-empty string after trim. On empty, log warn `[event=sms_inbound_empty_body outcome=rejected_malformed]` and return `"rejected_malformed"`.

Phase 3 — Dedupe:
- Build `dedupeRecord: SmsReplyRecord` with `PK = SMS_INBOUND#${formFields.MessageSid}`, `SK = METADATA`, `processedAt = new Date().toISOString()`, `sessionId = null` (filled in later via UpdateCommand if/when we know the session).
- Issue `PutCommand` with `ConditionExpression: "attribute_not_exists(PK)"`. On `ConditionalCheckFailedException`, log `[event=sms_inbound_duplicate messageSid=...]` debug, return `"duplicate"`. Re-throw any other error.

Phase 4 — Sender lookup:
- `customerResult = await this.customerService.queryCustomerIdByPhone(table, accountId, formFields.From)`.

Phase 5 — Route:

If `customerResult === null` → **Case 2 (cold entry):**
- Mint session: `sessionResult = await this.sessionService.lookupOrCreateSession("sms", null, "lead_capture", accountId)`.
- Stamp phone on `USER_CONTACT_INFO`: UpdateCommand on `PK = CHAT_SESSION#<sessionUlid>`, `SK = USER_CONTACT_INFO`, `SET phone = if_not_exists(phone, :phone), _createdAt_ = if_not_exists(_createdAt_, :now), _lastUpdated_ = :now`. (`if_not_exists` ensures we don't overwrite a phone the LLM already captured if there's any race.)
- Update the dedupe record with `sessionId = CHAT_SESSION#<sessionUlid>` for traceability.
- Call `this.chatSessionService.handleMessage(sessionUlid, formFields.Body)`.
- Send the reply: `this.smsService.send({ to: formFields.From, body: assistantText, sessionUlid })`.
- Log `[event=sms_assistant_entry_case2 sessionUlid=... outcome=processed]`.
- Return `"processed"`.

Else (`customerResult` is non-null):
- Capture `priorLatestSessionId = customerResult.latestSessionId`.
- If `priorLatestSessionId === null` → **Case 3 stale (no prior session pointer):** call private helper `handleCase3StaleNewSession(customerUlid, null, formFields, accountId, table)`.
- Else, GetItem on `PK = CHAT_SESSION#<priorLatestSessionId>`, `SK = METADATA`.
  - If item missing → Case 3 stale: `handleCase3StaleNewSession(customerUlid, priorLatestSessionId, formFields, accountId, table)`.
  - Else parse `_lastUpdated_`. On NaN → Case 3 stale.
  - Else compute `ageMs = Date.now() - lastUpdated`. If `ageMs < SMS_CONTINUATION_FRESHNESS_WINDOW_MS` → Case 3 fresh: `handleCase3FreshAttach(priorLatestSessionId, formFields, table)`. Else → Case 3 stale.

Private method `handleCase3FreshAttach(existingSessionUlid, formFields, table)`:
- Stamp phone on `USER_CONTACT_INFO` with `if_not_exists` (in case the prior session has phone absent — defensive).
- Update dedupe record with `sessionId = CHAT_SESSION#<existingSessionUlid>`.
- Call `this.chatSessionService.handleMessage(existingSessionUlid, formFields.Body)`.
- Send the SMS reply.
- Log `[event=sms_assistant_entry_case3_fresh sessionUlid=... outcome=processed]`.
- Return `"processed"`.

Private method `handleCase3StaleNewSession(customerUlid, priorLatestSessionId, formFields, accountId, table)`:
- Mint a new session: `sessionResult = await this.sessionService.lookupOrCreateSession("sms", null, "lead_capture", accountId)`.
- Write METADATA via single `UpdateCommand` with plain `SET` — three clauses: `customer_id = :customerId`, `continuation_from_session_id = :contFrom`, `_lastUpdated_ = :now`. Values: `:customerId = C#${customerUlid}` (always set, never null in this path), `:contFrom = priorLatestSessionId !== null ? CHAT_SESSION#${priorLatestSessionId} : null` (writing literal null when no prior session ULID is known is correct — `continuation_from_session_id` has no downstream `if_not_exists` writer, so null is the safe sentinel), `:now = new Date().toISOString()`. **The `UpdateExpression` does NOT include `continuation_loaded_at`** — that field stays absent so the continuation loader's `if_not_exists` write at `chat-session.service.ts:329` succeeds on first fire. This is the May 5 email-path null-init fix mirrored exactly for SMS.
- Stamp phone on `USER_CONTACT_INFO` with `if_not_exists`.
- Update dedupe record with `sessionId = CHAT_SESSION#<newSessionUlid>`.
- Call `this.chatSessionService.handleMessage(newSessionUlid, formFields.Body)`.
- Send the SMS reply.
- Log `[event=sms_assistant_entry_case3_stale sessionUlid=... outcome=processed]`.
- Return `"processed"`.

**Done when:**
- All 3 routes are exercised by spec tests.
- Spec asserts: dedupe record is written with `attribute_not_exists`; phone is stamped on `USER_CONTACT_INFO` with `if_not_exists`; the staleness branch correctly does NOT write `continuation_loaded_at`.

---

### Step 6 — Create `src/controllers/twilio-webhook.controller.ts`

**What:** The HTTP entry point. Verifies the Twilio webhook signature, parses the form-encoded body, hands off to `SmsReplyService.processInboundMessage`. Returns 200 OK with empty body in all paths (Twilio convention).

**Why last among new files:** Depends on `SmsReplyService` (Step 5) and `TwilioConfigService` (Step 1).

**Implementation details:**

Decorator: `@Controller("webhooks/twilio")`.

Route handler:
```
@Post("inbound")
@HttpCode(200)
async handleInbound(
  @Body() body: SmsReplyTwilioInboundFormFields,
  @Headers("x-twilio-signature") signature: string | undefined,
  @Req() req: Request,
): Promise<void> {
  // Phase 1 — Signature verification
  const url = `${this.twilioConfig.publicWebhookUrl}/webhooks/twilio/inbound`;
  // OR derive from req.protocol + req.get('host') + req.originalUrl if publicWebhookUrl is not configured
  const isValid = this.verifySignature(signature, url, body);
  if (!isValid) {
    this.logger.warn("[event=twilio_signature_invalid outcome=rejected_signature_invalid]");
    // Respond 200 with no body — do not reveal verification state
    return;
  }
  // Phase 2 — Hand off
  const outcome = await this.smsReplyService.processInboundMessage(body);
  this.logger.log(`Twilio inbound webhook handled [outcome=${outcome}]`);
}
```

Private helper:
```
private verifySignature(signature: string | undefined, url: string, params: Record<string, string>): boolean {
  if (!signature) return false;
  const authToken = this.twilioConfig.authToken;
  if (!authToken) {
    this.logger.error("TWILIO_AUTH_TOKEN not configured — cannot verify webhook signature");
    return false;
  }
  return twilio.validateRequest(authToken, signature, url, params);
}
```

- The full URL passed to `validateRequest` MUST exactly match the URL Twilio used to POST (including protocol, host, path, and any trailing slashes). This is a notorious source of "signature mismatch" failures during local development. Document this in the JSDoc comment above `verifySignature`.
- Add a config getter `TwilioConfigService.publicWebhookUrl` (env var `PUBLIC_WEBHOOK_URL` or similar — check whether the project already exposes a public URL config; if yes, reuse it; if no, add one). The controller derives the verification URL from this.
- For local development with ngrok or similar tunnels, the env var should match the tunnel URL. The plan assumes the production deployment exposes a stable HTTPS URL.
- The route uses `application/x-www-form-urlencoded` — Twilio's default content type. NestJS parses this automatically when the global `URLEncodedParser` is enabled. The implementer must verify the project's `main.ts` enables `app.use(express.urlencoded({ extended: true }))` (or equivalent); add it if missing.

**Done when:**
- Sending a valid Twilio webhook (with correct signature) routes to `processInboundMessage` and returns 200.
- Sending an invalid-signature webhook returns 200 with no body and logs the warn event without invoking `processInboundMessage`.
- Spec covers: valid signature happy path; invalid signature short-circuit; missing signature header; missing auth token config.

---

### Step 7 — Modify `src/app.module.ts`

**What:** Register the four new providers (`TwilioConfigService`, `SmsService`, `SmsReplyService`) and the new controller (`TwilioWebhookController`).

**Why last in the code path:** Depends on all prior steps. Until this is done, NestJS's DI graph cannot wire up the SMS stack.

**Implementation details:**
- Add imports at the top of the file alongside the existing `SendGridConfigService`, `EmailService`, `EmailReplyService`, `SendgridWebhookController` imports:
  ```
  import { TwilioConfigService } from "./services/twilio-config.service";
  import { SmsService } from "./services/sms.service";
  import { SmsReplyService } from "./services/sms-reply.service";
  import { TwilioWebhookController } from "./controllers/twilio-webhook.controller";
  ```
- Add to the `providers` array (ordered alphabetically with the rest, OR colocated with the SendGrid trio — match whichever ordering is in the file):
  ```
  TwilioConfigService,
  SmsService,
  SmsReplyService,
  ```
- Add to the `controllers` array:
  ```
  TwilioWebhookController,
  ```
- The implementer must locate the existing `controllers` and `providers` array layout in `app.module.ts` and slot the new entries to match existing conventions exactly. Do NOT reorganize unrelated entries.

**Done when:** `npm run build` succeeds; the application boots without dependency-resolution errors; a smoke-test request to `POST /webhooks/twilio/inbound` returns 200.

---

### Step 8 — Test coverage

**What:** Spec tests for every new file plus the modified `customer.service.spec.ts`.

**Why now (and not earlier):** The TDD-vs-implementation-first ordering is the implementer's call. The expected outcome is full coverage; the order of writing is theirs to choose.

**Test files:**

`src/services/twilio-config.service.spec.ts` — 4 tests, one per getter, asserting it returns the value from `ConfigService` and `""` when missing.

`src/services/sms.service.spec.ts` — 3 tests:
- `send` happy path: client.messages.create called with correct `from`/`to`/`body`; returns `{ messageSid }`.
- `send` throws when `TWILIO_PHONE_NUMBER` is missing.
- `send` re-throws and logs when Twilio API rejects.

`src/services/sms-reply.service.spec.ts` — at least 8 tests:
- Account missing → `rejected_unknown_account`.
- Bad phone format → `rejected_malformed`.
- Empty body → `rejected_malformed`.
- Duplicate `MessageSid` → `duplicate`, no further DDB calls beyond the `PutCommand`.
- Case 2 (cold entry, GSI miss) → mints session, stamps phone with `if_not_exists`, calls `handleMessage`, sends SMS, returns `"processed"`.
- Case 3 fresh → attaches to existing session, stamps phone with `if_not_exists`, calls `handleMessage`, returns `"processed"`.
- Case 3 stale (prior session > 7 days old or missing METADATA) → mints new session, writes `customer_id` and `continuation_from_session_id` to METADATA, **does NOT write `continuation_loaded_at`** (assert with `expect(updateExpression).not.toContain("continuation_loaded_at")` — mirrors the May 5 inverse-assertion pattern).
- Case 3 stale with `priorLatestSessionId === null` → `handleCase3StaleNewSession` is called with `null`.

`src/controllers/twilio-webhook.controller.spec.ts` — at least 4 tests:
- Valid signature → routes to `processInboundMessage`.
- Invalid signature → does NOT call `processInboundMessage`, returns 200.
- Missing signature header → returns 200, logs warn.
- Missing auth token → returns 200, logs error.

`src/services/customer.service.spec.ts` (additions to existing file) — 4 new tests as described in Step 4.

**Crockford-valid 26-char ULIDs in all fixtures.** Phone numbers must be E.164 (e.g., `+15558675309`).

---

## Risks and Edge Cases

### High — GSI2 not provisioned at deploy time

If the DynamoDB GSI2 is not provisioned before code deploy, `queryCustomerIdByPhone` will throw `ResourceNotFoundException` on first call. Detection: the SmsReplyService catches the error, logs `[event=sms_inbound_gsi2_missing]` at error level, and returns `"rejected_unknown_account"` (conservative degradation — visitor sees no reply, but no data corruption). Mitigation: confirm GSI2 is live before merging the SMS code. The implementer should add a one-line note to the deployment runbook.

### High — Twilio webhook URL mismatch in signature verification

Twilio's `validateRequest` requires the EXACT URL Twilio used to POST, including protocol, host, port, path, and trailing slash behavior. Behind a load balancer, `req.protocol` may be `http` while the public-facing URL is `https`. Behind ngrok during local development, the host header may differ from the configured public URL. Mitigation: the controller derives the verification URL from `TwilioConfigService.publicWebhookUrl` (a configured value), not from the request headers. Document this constraint in the controller's JSDoc. Spec tests use a fixed URL constant.

### High — E.164 normalization divergence

If two writers store the same phone in different formats (`+15551234567` vs `15551234567` vs `(555) 123-4567`), GSI2 queries will silently miss the customer. Mitigation: the controller validates against `E164_REGEX` BEFORE any DDB write; any non-E.164 input is rejected with `"rejected_malformed"`. The customer record's `phone` field is written exactly as Twilio sent it (E.164 by Twilio's contract). The `collect_contact_info` tool currently stores phone as-the-LLM-passed-it; this is a pre-existing gap and is **out of scope** for this phase, but should be flagged for a future hardening pass (the LLM may pass non-E.164 phones, which would write to GSI2 in a divergent format). For now, SMS-cold-entry visitors are protected because the controller's E.164 validation runs before any write.

### Medium — Race between SMS controller phone stamp and `collect_contact_info` phone stamp

Hypothetical race: SMS controller stamps phone on `USER_CONTACT_INFO` at session creation; `collect_contact_info` (running in `handleMessage`) tries to write `phone` from an LLM-passed value at the same moment. The `if_not_exists(phone, :phone)` write semantics on the controller's stamp ensure the controller's value wins (it wrote first). The tool's later `phone` value is silently ignored if the field already exists. This is the desired behavior: the channel-derived phone is more trustworthy than an LLM-derived one.

### Medium — Empty-body inbound from carrier-level retries

Some carriers send "STOP" / "HELP" / empty messages as control commands. Twilio SDK exposes auto-handlers for STOP/HELP that respond on Twilio's side; we do not need to handle these in our webhook (they never reach us). But if an empty-body message slips through, the Phase 2 empty-body guard returns `"rejected_malformed"` — no session is created, no DDB writes happen, no cost incurred. Acceptable degradation.

### Medium — Twilio webhook retries on processing errors

If `processInboundMessage` throws an unhandled error after the dedupe record is written, Twilio will retry the webhook (Twilio retries on non-2xx responses). On retry, the dedupe record blocks reprocessing → returns `"duplicate"` → no double-charge for the visitor, but the visitor never gets a reply. Mitigation: the dedupe record is deliberately written FIRST (before any business logic) so retry-after-partial-failure is detected as duplicate. Long-term: a follow-up phase could add a "stuck-session" detector that retries the agent dispatch on duplicates where `sessionId` was never filled in. **Out of scope for v1.** Operational mitigation: monitor `[event=sms_assistant_entry_*]` log volumes.

### Medium — Multi-segment outbound replies cost more

A long agent reply gets split by Twilio into multiple SMS segments at 160-char boundaries (or 70-char for non-GSM-7 chars like emoji). Each segment bills separately. The user has explicitly accepted this for v1 (no reply-length tuning) and will monitor real customer behavior to decide whether to add Approach (b) or (c) reply shaping later. Plan note: monitor SMS segment counts in Twilio's billing dashboard during the first weeks.

### Low — `MessageSid` collision (theoretical only)

Twilio's `MessageSid` is a 34-char unique identifier. Collision probability is effectively zero. No mitigation needed.

### Low — Customer with phone but no email

A customer record where `email` is null (rare today; not produced by any current flow) but `phone` is non-null would still be findable via GSI2. No correctness impact. The `collect_contact_info` flow always collects email before creating the customer, so this state is not reachable through normal operation.

### Low — Future SMS-aware reply length tuning

If/when reply-length tuning is added (Approach (b) — channel hint passed to the agent), the change is local to `ChatSessionService.handleMessage`'s dynamic-context construction. No SMS-side files need to change. Already a clean seam for future work.

---

## Testing Strategy

### Unit tests
- **Per the file list in Step 8.** Total new tests: ~23 across 5 spec files (4 new + 1 modified).
- All new tests use `aws-sdk-client-mock` for DDB, `jest.fn()` for SDK methods, `Test.createTestingModule` for NestJS DI.
- Crockford-valid 26-char ULIDs in fixtures.
- E.164 phones in fixtures.
- All `.not.toContain` and `.not.toHaveProperty` inverse assertions use the May 5 pattern (no `in` operator, no `as Record<string, string>` casts).

### Full test suite
- `npm test` must pass after all 7 implementation steps. Pre-phase baseline: 607 tests, 37 suites. Expected post-phase: ~630 tests, ~41 suites (5 new spec files; some may add 0 net new suites if test counts are folded into describe blocks).
- `npm run build` must succeed.

### Manual / e2e verification
- Deploy to a dev environment with a real Twilio sandbox account.
- Provision GSI2 on the conversations table.
- Send an SMS from a personal phone to the deployment's Twilio number.
- Verify in CloudWatch (or local DynamoDB):
  - A `SMS_INBOUND#<MessageSid>` dedupe record exists.
  - A `CHAT_SESSION#<ulid>` METADATA record exists with `source: "sms"` and `agent_name: "lead_capture"`.
  - A `USER_CONTACT_INFO` record exists with the sender's phone.
- Verify the response SMS arrives on the personal phone.
- Repeat from the same phone within < 7 days → expect Case 3 fresh attach (same `sessionUlid` from prior step's response).
- Wait 7+ days OR manually delete the prior session METADATA → repeat → expect Case 3 stale (new session with `continuation_from_session_id` set).
- Send the same `MessageSid` twice (manual webhook replay) → expect `"duplicate"` outcome.

### Regression areas to re-test
- Email channel: send an inbound email via the SendGrid webhook → expect identical behavior to before (no regression).
- Web chat: send a web message → expect identical behavior.
- `collect_contact_info` for a web visitor sharing phone for the first time → verify the customer record now has GSI2 keys.

---

## Implementation Recommendations

### Follow the step order strictly
The dependency chain is: Step 1 (config) → Step 2 (types) → Step 3 (sms.service) → Step 4 (customer.service extension) → Step 5 (sms-reply.service) → Step 6 (controller) → Step 7 (app.module) → Step 8 (tests, optionally interleaved with implementation per implementer's preference).

### Verify compilation after each step
Run `npx tsc --noEmit` after each step. Catches import/type errors before they compound.

### Match the email pattern exactly where structurally identical
The `EmailReplyService` and `SmsReplyService` will look very similar in shape. That is correct — the conversational lifecycle is the same. Where they differ (no Case 1, simpler dedupe, no quoted-reply stripping, no email-headers handling), call out the difference in a brief inline comment so future readers understand it's intentional.

### Do not extract a shared base class
Even where code looks structurally identical between services, do not extract a base class or shared helper module in this phase. The user has explicitly chosen to keep each channel as its own self-contained domain. When a fourth channel arrives, the question of abstraction can be revisited with three concrete implementations to validate the abstraction's shape — not before.

### Phone PII never reaches the LLM
The phone is stamped on `USER_CONTACT_INFO` by the controller. The agent's tools read `USER_CONTACT_INFO` from DDB when they need contact details. The phone never appears in `messages[]` content, system prompt, tool input/output schemas, or log lines (except via `buildRedactedPhone`).

### Use the Twilio SDK's `validateRequest`
Do not roll a custom HMAC implementation for signature verification. The SDK's `twilio.validateRequest(authToken, signature, url, params)` is the canonical implementation; replicating it manually invites subtle bugs.

### Out-of-scope reminder
The following are **deliberately not in this plan** and are queued as future phases:
1. SMS-aware reply length tuning (Approach (b) channel-hint or (c) post-processor).
2. Multi-tenant Twilio number → account mapping.
3. Proactive outbound SMS (e.g., abandoned-cart text, checkout-link delivery).
4. SMS verification flow (`request_sms_verification_code` tool); currently SMS is treated as carrier-validated, mirroring email's cold-entry trust model.
5. SendGrid webhook signature verification (existing gap; Twilio gets it for free in this phase).
6. `collect_contact_info` E.164 normalization for LLM-passed phones (existing gap; flagged for hardening).

### `grep` checks before declaring done
After implementation, run:
```
grep -r "EmailReplyService\|SendGridConfigService\|EmailService" src/services/sms-reply.service.ts src/services/sms.service.ts src/services/twilio-config.service.ts src/controllers/twilio-webhook.controller.ts
```
Result must be zero matches. The SMS stack must NOT import from the email stack — they are independent domains.

### Commit/push gates
Per the project's standing rules:
- Sub-agents stage changes but do NOT commit.
- The orchestrator surfaces the diff to the user and asks for explicit approval before every commit.
- The orchestrator pushes only after the user has explicitly approved the push.
- All five sub-agents (arch-planner → code-implementer → style-refactor → test-suite-runner → code-reviewer) run in sequence. Style-refactor is non-negotiable.
- A close-out cycle runs if the code-reviewer flags any SHOULD FIX items.
