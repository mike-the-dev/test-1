# Phase 4 — SendGrid Inbound Reply Loop: Implementation Plan

## Objective

Enable email-based conversation continuation by rewriting outbound `From:` addresses to per-session reply addresses (`<sessionUlid>@<replyDomain>`), then receiving replies via a new `POST /webhooks/sendgrid/inbound` endpoint. That endpoint extracts the session ULID from the `To:` address, validates the sender, strips quoted history, dispatches through `ChatSessionService.handleMessage`, and sends the LLM response back as a threaded reply email. The webhook controller is the email transport layer — exactly analogous to `DiscordService` for Discord — and the LLM has no awareness of which transport it is on.

---

## Open Question: EmailService Extension vs EmailReplyService

**Recommendation: introduce a thin `EmailReplyService` in `src/services/email-reply.service.ts` that contains all inbound processing logic and calls `EmailService.send()` for both the initial send path and the reply path.**

Rationale:
- `EmailService` is already responsible for one thing: constructing and dispatching an outbound SendGrid message. It should not take on session-lookup, idempotency checking, sender validation, and quoted-reply stripping.
- The inbound flow is complex (5+ sequential DynamoDB + parsing steps). Stuffing it into `EmailService` would violate the single-responsibility principle and make the unit test surface awkward.
- `DiscordService` (the analog) is its own injectable service even though it also sends replies via an external API. Staying parallel to that pattern is cleaner.
- `EmailService.send()` gains `sessionUlid` to derive the per-session `From:` address — that is a targeted, minimal change to the send path. `EmailReplyService` wraps the full inbound processing loop and calls `emailService.send()` at the end.

---

## USER_CONTACT_INFO Record Shape (verified from `collect-contact-info.tool.ts`)

The `collect_contact_info` tool writes to DynamoDB using:
- `PK: CHAT_SESSION#<sessionUlid>`
- `SK: USER_CONTACT_INFO`

The attribute names stored are the full camelCase JavaScript property names (not the two-letter aliases):
- `firstName`, `lastName`, `email`, `phone`, `company`, `updatedAt`, `createdAt`

The spec's wording `Item.email` is correct. No translation needed.

---

## Affected Files and Modules

### Create (new files)

| File | Purpose |
|------|---------|
| `src/types/EmailReply.ts` | `SendGridInboundFormFields`, `ParsedInboundReply`, `InboundProcessOutcome`, `EmailReplyRecord` types |
| `src/utils/email/strip-quoted-reply.ts` | Pure `stripQuotedReply(rawText: string): string` utility |
| `src/utils/email/strip-quoted-reply.spec.ts` | Unit tests for the strip utility |
| `src/services/email-reply.service.ts` | Full inbound processing logic |
| `src/services/email-reply.service.spec.ts` | Unit tests for `EmailReplyService` |
| `src/controllers/sendgrid-webhook.controller.ts` | Thin `POST /webhooks/sendgrid/inbound` handler |

### Modify (existing files)

| File | Change |
|------|--------|
| `src/types/Email.ts` | Add `sessionUlid: string`, `inReplyToMessageId?: string`, `referencesMessageId?: string` to `EmailSendParams` |
| `src/services/email.service.ts` | Use `${params.sessionUlid}@${this.sendGridConfig.replyDomain}` as `from.email`; add threading headers when `inReplyToMessageId` is set |
| `src/tools/send-email.tool.ts` | Pass `sessionUlid: context.sessionUlid` in the `emailService.send({...})` call |
| `src/services/sendgrid-config.service.ts` | Add `replyDomain` getter reading `sendgrid.replyDomain` from config |
| `src/config/env.schema.ts` | Add required `SENDGRID_REPLY_DOMAIN: z.string().min(1).refine(...)` with domain validation |
| `src/config/configuration.ts` | Add `replyDomain: process.env.SENDGRID_REPLY_DOMAIN \|\| ""` to the `sendgrid` block |
| `src/app.module.ts` | Register `EmailReplyService` in providers, `SendgridWebhookController` in controllers |

### Review Only (no changes)

| File | Why read |
|------|---------|
| `src/services/identity.service.ts` | Reference for `isConditionalCheckFailed` helper pattern and `PutCommand` with `ConditionExpression` |
| `src/services/chat-session.service.ts` | Confirm `handleMessage(sessionUlid, userMessage): Promise<string>` signature |
| `src/services/discord.service.ts` | Reference for thin transport-layer pattern |
| `src/app.controller.ts` | Reference for controller decorator style |

---

## Dependencies and Architectural Considerations

- **No new npm packages.** `multer` is a transitive dependency of `@nestjs/platform-express` (already installed). `AnyFilesInterceptor` is from `@nestjs/platform-express`.
- **DynamoDB table:** all new records write to the same `DYNAMODB_TABLE_CONVERSATIONS` table used by existing services. No schema migrations needed — DynamoDB is schemaless.
- **New DynamoDB record type:** `EMAIL_INBOUND#<messageId>` / `METADATA` for idempotency. The `EmailReplyRecord` interface captures this shape.
- **New env var:** `SENDGRID_REPLY_DOMAIN` — required at startup, validated by Zod refinement (must contain `.`, no whitespace, strip leading `@` if present). App must fail fast if missing.
- **Backward compatibility:** `EmailService.send()` signature changes (gains required `sessionUlid`). The one existing caller (`SendEmailTool`) already has `context.sessionUlid` and just needs to pass it through. No other callers exist.
- **`from.email` rewrite:** every outbound email now uses `<sessionUlid>@<replyDomain>` as the From. The legacy `fromEmail` getter on `SendGridConfigService` remains available for potential future non-session sends but is no longer used by `EmailService.send()`.
- **Multipart form parsing:** the webhook controller must use `@UseInterceptors(AnyFilesInterceptor())` so Express/multer handles the `multipart/form-data` body that SendGrid Inbound Parse sends. The global JSON body parser does not apply to this route when multer intercepts it.
- **HTTP contract for non-retryable outcomes:** any business-level rejection (malformed, unknown session, sender mismatch, duplicate) must return `200 OK`. Only thrown exceptions propagate as 5xx — this triggers SendGrid retries. The controller delegates and does NOT catch business outcomes.
- **Privacy logging:** never log message bodies, contact info, system prompts, or full email addresses. Log session ULIDs, message IDs, sender domains (for rejections, redact local-part to `<firstChar>***@<domain>`), outcome labels, timings.

---

## Step-by-Step Implementation Sequence

### Step 1 — `src/types/EmailReply.ts`
Define all new types before any implementation code.

- Export `SendGridInboundFormFields` interface: fields `to: string`, `from: string`, `text: string` (required); `subject?: string`, `html?: string`, `headers?: string`, `envelope?: string`, `dkim?: string`, `SPF?: string`, `sender_ip?: string`, `spam_score?: string`, `charsets?: string` (optional).
- Export `ParsedInboundReply` interface: `sessionUlid: string`, `senderEmail: string`, `subject: string`, `bodyText: string`, `inboundMessageId: string`.
- Export `InboundProcessOutcome` string-literal union: `"processed" | "duplicate" | "rejected_unknown_session" | "rejected_sender_mismatch" | "rejected_malformed"`.
- Export `EmailReplyRecord` interface: `PK: string`, `SK: string`, `processedAt: string`, `sessionUlid: string`.

**Done when:** `npx tsc --noEmit` compiles this file without errors.

### Step 2 — `src/types/Email.ts`
Extend `EmailSendParams` for the session-aware send path.

- Add `sessionUlid: string` as a required field.
- Add `inReplyToMessageId?: string` and `referencesMessageId?: string` as optional fields.
- `EmailSendResult` is unchanged.

**Done when:** `npx tsc --noEmit` compiles cleanly; `SendEmailTool` will temporarily fail to compile until Step 5 — that is expected.

### Step 3 — `src/utils/email/strip-quoted-reply.ts` and its spec

**`strip-quoted-reply.ts`:**
- Export `stripQuotedReply(rawText: string): string`.
- Build an ordered array of regex patterns to try (multiline flag on all):
  1. `/^On .+ wrote:$/m` — Gmail, Apple Mail, Outlook Web
  2. `/^-----Original Message-----/m` — Outlook desktop
  3. `/^>/m` — any `>`-quoted line
  4. `/^From: .+$/m` followed within 3 lines by `^Sent:` or `^To:` — conservative Outlook variant. Implement this as: match `From: ` on its own line, then check the next 3 lines for `Sent:` or `To:` line; if found, use the `From:` line's index as the cut point.
- Find the minimum `index` among all pattern matches. Slice `rawText` at that index, trim trailing whitespace. If no match, return `rawText.trim()`.
- No imports, no class, no logger — pure function only.

**`strip-quoted-reply.spec.ts`** (colocated):
- Case 1: Gmail-style `On Mon, Apr 7 2026 at 12:00 PM, Bob wrote:` — verifies everything before the marker is returned.
- Case 2: Outlook desktop `-----Original Message-----` — verifies the cut.
- Case 3: `>` quoted line — verifies the cut.
- Case 4: No quote marker at all — verifies original text returned trimmed.
- Case 5: Empty string input — verifies empty string returned.
- Case 6: Outlook `From:` followed by `Sent:` within 3 lines — verifies the cut at the `From:` line.

**Done when:** `npx tsc --noEmit` passes and Jest runs the spec with all cases green.

### Step 4 — `src/config/env.schema.ts`
Add the required `SENDGRID_REPLY_DOMAIN` env var.

```
SENDGRID_REPLY_DOMAIN: z
  .string()
  .min(1)
  .transform((value) => value.replace(/^@/, ""))
  .refine((value) => /^[^\s]+\.[^\s]+$/.test(value), {
    message: "SENDGRID_REPLY_DOMAIN must be a valid domain (e.g. reply.example.com)",
  }),
```

No `as` cast. Use `.transform()` before `.refine()` so the leading-`@` strip happens before validation.

**Done when:** `npx tsc --noEmit` passes; `Env` type includes `SENDGRID_REPLY_DOMAIN: string`.

### Step 5 — `src/config/configuration.ts`
Add `replyDomain: process.env.SENDGRID_REPLY_DOMAIN || ""` to the `sendgrid` block, matching the existing pattern for `apiKey`, `fromEmail`, `fromName`.

**Done when:** `npx tsc --noEmit` passes.

### Step 6 — `src/services/sendgrid-config.service.ts`
Add a `replyDomain` getter:

```ts
get replyDomain(): string {
  return this.configService.get<string>("sendgrid.replyDomain", { infer: true }) ?? "";
}
```

Follows the exact same pattern as the three existing getters.

**Done when:** `npx tsc --noEmit` passes.

### Step 7 — `src/services/email.service.ts`
Update `send()` to use per-session `From:` and support threading headers.

- `from.email` becomes `${params.sessionUlid}@${this.sendGridConfig.replyDomain}`.
- `from.name` stays `this.sendGridConfig.fromName`.
- After building `message`, if `params.inReplyToMessageId` is defined, add a `headers` property:
  ```
  headers: {
    "In-Reply-To": `<${params.inReplyToMessageId}>`,
    "References": `<${params.referencesMessageId ?? params.inReplyToMessageId}>`,
  }
  ```
  Per RFC 5322, wrap the message-ID value in `<>` here (the caller passes the bare ID without brackets).
- No other changes. Log line stays unchanged.

**Done when:** `npx tsc --noEmit` passes; `SendEmailTool` will still fail to compile until Step 8.

### Step 8 — `src/tools/send-email.tool.ts`
Pass `sessionUlid` through to `emailService.send()`.

Change:
```ts
const result = await this.emailService.send({
  to: parseResult.data.to,
  subject: parseResult.data.subject,
  body: parseResult.data.body,
});
```
To:
```ts
const result = await this.emailService.send({
  to: parseResult.data.to,
  subject: parseResult.data.subject,
  body: parseResult.data.body,
  sessionUlid: context.sessionUlid,
});
```

No other changes. `context.sessionUlid` is already available.

**Done when:** `npx tsc --noEmit` passes with zero errors across the whole project.

### Step 9 — `src/services/email-reply.service.ts`
Implement the full inbound processing service. Constructor injects: `DynamoDBDocumentClient` (via `@Inject(DYNAMO_DB_CLIENT)`), `DatabaseConfigService`, `SendGridConfigService`, `EmailService`, `ChatSessionService`, and `Logger`.

Define module-level constants:
```
const ULID_REGEX = /^[0-9A-HJKMNP-TV-Z]{26}$/
const MESSAGE_ID_HEADER_REGEX = /^Message-ID:\s*<(.+?)>$/m
const EMAIL_ADDRESS_REGEX = /<([^>]+)>/
const CONDITIONAL_CHECK_FAILED = "ConditionalCheckFailedException"
const CHAT_SESSION_PK_PREFIX = "CHAT_SESSION#"
const EMAIL_INBOUND_PK_PREFIX = "EMAIL_INBOUND#"
const CONTACT_INFO_SK = "USER_CONTACT_INFO"
const METADATA_SK = "METADATA"
```

Define module-level `isConditionalCheckFailed(error: unknown): boolean` — mirror the exact pattern from `identity.service.ts`:
```ts
function isConditionalCheckFailed(error: unknown): boolean {
  if (error !== null && error !== undefined) {
    const record: { name?: unknown } = error as { name?: unknown };
    return record.name === CONDITIONAL_CHECK_FAILED;
  }
  return false;
}
```
Note: the existing codebase uses this `as` cast inside `isConditionalCheckFailed` — mirror it identically. The style enforcer is aware this is an established pattern.

Public method `async processInboundReply(formFields: SendGridInboundFormFields): Promise<InboundProcessOutcome>`:

**Step 9.1 — Parse session ULID from `to` field:**
- Split `formFields.to` on `,` to handle multiple recipients.
- For each address, strip display name (regex `EMAIL_ADDRESS_REGEX` or use the bare address if no `<>`).
- Find the first address whose domain part matches `this.sendGridConfig.replyDomain`.
- Extract the local-part (everything before `@`).
- If no matching address found: `this.logger.warn(...)` (no local-part in log), return `"rejected_malformed"`.

**Step 9.2 — Validate ULID format:**
- `if (!ULID_REGEX.test(localPart))`: warn (do NOT log the local-part), return `"rejected_malformed"`.
- `const sessionUlid = localPart`.

**Step 9.3 — Parse inbound Message-ID:**
- Match `MESSAGE_ID_HEADER_REGEX` against `formFields.headers ?? ""`.
- If match found, `messageId = match[1]`.
- If not found: compute stable fallback `messageId` — use Node built-in `crypto.createHash("sha256").update(formFields.from + formFields.subject + formFields.text).digest("hex")`. Log a debug noting the fallback.

**Step 9.4 — Idempotency check (MUST run before LLM dispatch):**
- `PutCommand` to table with `Item: { PK: EMAIL_INBOUND#<messageId>, SK: METADATA, processedAt: now, sessionUlid } satisfies EmailReplyRecord`.
- `ConditionExpression: "attribute_not_exists(PK)"`.
- Catch via `isConditionalCheckFailed`: log debug `[messageId=...]`, return `"duplicate"`.
- Any other error: re-throw.

**Step 9.5 — Parse sender email from `from` field:**
- Match `EMAIL_ADDRESS_REGEX` against `formFields.from`. If match, `senderEmail = match[1]`. Else treat the whole field as the email address.
- Lowercase the result.

**Step 9.6 — Sender validation:**
- `GetCommand` on `PK: CHAT_SESSION#<sessionUlid>`, `SK: USER_CONTACT_INFO`.
- If no `Item`: warn `[sessionUlid=... outcome=rejected_unknown_session]`, return `"rejected_unknown_session"`.
- If `Item.email.toLowerCase() !== senderEmail`: warn with redacted sender (e.g. `${senderEmail[0]}***@${senderEmail.split("@")[1]}`), return `"rejected_sender_mismatch"`.

**Step 9.7 — Strip quoted history:**
- `const cleanBody = stripQuotedReply(formFields.text)`.
- If `cleanBody === ""`: warn `[sessionUlid=... outcome=rejected_malformed reason=empty_after_strip]`, return `"rejected_malformed"`.

**Step 9.8 — Dispatch to ChatSessionService (re-throw on failure):**
- `const assistantText = await this.chatSessionService.handleMessage(sessionUlid, cleanBody)`.
- Do NOT catch — any throw bubbles up to the controller, which returns 5xx and triggers SendGrid retry.

**Step 9.9 — Build and send outbound reply:**
- Build subject: if `(formFields.subject ?? "").startsWith("Re:")`, use it as-is; else prepend `"Re: "`.
- Call `this.emailService.send({ to: senderEmail, subject: replySubject, body: wrapInHtml(assistantText), sessionUlid, inReplyToMessageId: messageId, referencesMessageId: messageId })`.
- `wrapInHtml`: split `assistantText` on `\n\n`, map each chunk to `<p>...</p>`, join with `\n`.

**Step 9.10 — Log and return:**
- `this.logger.log(\`Inbound reply processed [sessionUlid=... outcome=processed]\`)`.
- Return `"processed"`.

**Done when:** `npx tsc --noEmit` passes.

### Step 10 — `src/controllers/sendgrid-webhook.controller.ts`
Thin controller, no business logic.

```ts
import { Controller, Post, Body, UseInterceptors, UploadedFiles, Logger } from "@nestjs/common";
import { AnyFilesInterceptor } from "@nestjs/platform-express";

import { SendGridInboundFormFields } from "../types/EmailReply";
import { EmailReplyService } from "../services/email-reply.service";

@Controller("webhooks/sendgrid")
export class SendgridWebhookController {
  private readonly logger = new Logger(SendgridWebhookController.name);

  constructor(private readonly emailReplyService: EmailReplyService) {}

  @Post("inbound")
  @UseInterceptors(AnyFilesInterceptor())
  async handleInbound(
    @Body() body: SendGridInboundFormFields,
    @UploadedFiles() _files: unknown[],
  ): Promise<void> {
    this.logger.debug(`Received inbound webhook [contentLength=${JSON.stringify(body).length}]`);

    const outcome = await this.emailReplyService.processInboundReply(body);

    this.logger.log(`Inbound webhook handled [outcome=${outcome}]`);
  }
}
```

If `processInboundReply` throws, NestJS default exception handler returns 500 (triggers SendGrid retry). Do NOT wrap in try/catch — let it propagate.

**Done when:** `npx tsc --noEmit` passes.

### Step 11 — `src/app.module.ts`
Register the new provider and controller.

- Add `EmailReplyService` to `providers` array.
- Add `SendgridWebhookController` to `controllers` array.
- Add the two new imports at the top.

**Done when:** `npx tsc --noEmit` passes; app boots without error.

### Step 12 — `src/services/email-reply.service.spec.ts`
Unit tests covering all outcome paths. Mock: `DynamoDBDocumentClient`, `DatabaseConfigService`, `SendGridConfigService`, `EmailService`, `ChatSessionService`.

Required test cases:
1. **Happy path** — valid ULID in `to`, known session, sender matches, `processInboundReply` returns `"processed"`, `ChatSessionService.handleMessage` is called once, `EmailService.send` is called once with correct threading headers and `sessionUlid`.
2. **Duplicate** — second call with same `Message-ID` header hits conditional check failure, returns `"duplicate"`, `handleMessage` NOT called.
3. **`rejected_unknown_session`** — DynamoDB returns no item for `USER_CONTACT_INFO`, returns `"rejected_unknown_session"`, `handleMessage` NOT called.
4. **`rejected_sender_mismatch`** — `Item.email` does not match inbound `from`, returns `"rejected_sender_mismatch"`, `handleMessage` NOT called.
5. **`rejected_malformed` — bad ULID** — `to` address local-part is not a 26-char ULID, returns `"rejected_malformed"`, no DynamoDB calls.
6. **`rejected_malformed` — no matching reply domain** — `to` address has no address matching `replyDomain`, returns `"rejected_malformed"`.
7. **`rejected_malformed` — empty after strip** — inbound text is entirely quoted (stripped to empty), returns `"rejected_malformed"`, `handleMessage` NOT called.
8. **ChatSessionService throw propagates** — `handleMessage` throws, `processInboundReply` propagates the throw (do not catch).
9. **Display-name `from` field** — `from` is `"John Smith" <john@example.com>`, sender validation uses `john@example.com`.
10. **Missing Message-ID header** — falls back to SHA-256 hash; idempotency still works on second call.

### Step 13 — Touch existing specs that broke due to signature changes

- Check for `src/services/email.service.spec.ts` — if it exists, update mocked `send()` calls to include `sessionUlid`. If it does not exist, do not create it.
- Check for any spec that calls `SendEmailTool` or `emailService.send()` directly and update accordingly.

**Done when:** `npm test` passes with zero failures, count is 40 + (new test cases).

---

## Risks and Edge Cases

### High

**1. Idempotency check MUST precede LLM dispatch.**
If the `PutCommand` conditional check runs after `ChatSessionService.handleMessage`, a SendGrid retry on a transient 5xx would send a second LLM response to the user. The implementation plan places Step 9.4 (idempotency) before Step 9.8 (dispatch) — the implementer must not reorder these.
Mitigation: code review step explicitly checks ordering.

**2. `EmailService.send()` signature break.**
Adding required `sessionUlid` to `EmailSendParams` will cause a TypeScript compile error in `SendEmailTool` until Step 8. The implementer must complete Steps 7 and 8 together before running `tsc --noEmit` as a passing gate.
Mitigation: spec says to run `tsc --noEmit` after each meaningful chunk — "meaningful chunk" here is Steps 7+8 together.

**3. Sender validation is the security boundary.**
Without it, anyone who guesses or harvests a session ULID can converse with the LLM as the original lead. The case-insensitive email comparison must happen every time, not be skippable.
Mitigation: test case 4 explicitly asserts the rejection path.

### Medium

**4. Multiple `to` addresses.**
SendGrid may populate the `to` field with multiple addresses (e.g., if the user has email aliases or CC'd themselves). The implementation must find the first address whose domain matches `replyDomain`, not assume only one address exists.
Mitigation: Step 9.1 explicitly splits on `,` and iterates.

**5. Display-name `from` field formatting.**
`"John Smith" <john@example.com>` vs `john@example.com` — sender email extraction must handle both. Regex `/<([^>]+)>/` extracts the bare address from the angle-bracket form; fall back to the raw field if no `<>` present.
Mitigation: test case 9 covers this.

**6. Missing Message-ID header.**
Some mail servers or forwarded emails may not include `Message-ID`. The SHA-256 hash fallback ensures idempotency still works, but the hash key is deterministic only if the three input fields are identical between retries — they will be for SendGrid retries of the same parsed payload.
Mitigation: test case 10 covers this; a debug log notes the fallback.

**7. Double `Re:` subject prefix.**
If the user's reply has `Re: Re: <original subject>`, the implementation must not prepend another `Re:`. The check is `if subject already starts with "Re:"`, use it verbatim.
Mitigation: covered by Step 9.9 logic.

### Low

**8. Empty `assistantText` from `ChatSessionService`.**
`handleMessage` can return `""` in edge cases (no text blocks in final assistant message). Sending an empty email reply is technically valid but poor UX. The implementer may choose to log a warning before sending but should still send — do not reject or throw.

**9. `SENDGRID_REPLY_DOMAIN` present but misconfigured (wrong domain in MX).**
The app starts successfully but replies route nowhere. This is an infrastructure concern, not an app concern — fail-fast on missing var only.

**10. SendGrid Inbound Parse hostname not configured in the SendGrid dashboard.**
The webhook will never receive calls. Out of scope for the pipeline; covered in the manual verification checklist in the spec.

---

## Testing Strategy

### Unit tests (automated, in-pipeline)

- `src/utils/email/strip-quoted-reply.spec.ts` — 6 pure-function cases covering all quote marker variants and edge cases. No mocks needed.
- `src/services/email-reply.service.spec.ts` — 10 cases covering all `InboundProcessOutcome` values, happy path, throw propagation, and edge cases. Mock: `DynamoDBDocumentClient` (send method), `DatabaseConfigService`, `SendGridConfigService`, `EmailService`, `ChatSessionService`. Follow the DynamoDB mock pattern established in `identity.service.spec.ts` (if it exists) or replicate the pattern from `code-implementer` memory (`feedback_dynamodb_test_client.md`).

### Regression tests (existing, must remain green)

- All 40 existing tests must still pass after the signature change to `EmailService.send()`.
- The only existing caller of `emailService.send()` is `SendEmailTool` — its spec (if any) needs `sessionUlid` added to the mock call.

### Manual end-to-end (post-pipeline, user-run)

Per the spec's POST-TASK MANUAL VERIFICATION section:
- DNS MX record on `SENDGRID_REPLY_DOMAIN` subdomain pointing to `mx.sendgrid.net`
- SendGrid dashboard Inbound Parse config pointing to `https://<public-url>/webhooks/sendgrid/inbound`
- ngrok or deployed environment for the HTTPS endpoint
- Verify outbound `From:` address is `<26-char-ULID>@<replyDomain>`
- Verify threaded email reply from the LLM
- Verify sender guardrail rejects replies from a different address (200, `rejected_sender_mismatch` in logs)
- Verify idempotency via replayed curl payload (200, `duplicate` in logs, no second outbound email)

---

## Implementation Recommendations

- **Mirror `isConditionalCheckFailed` exactly from `identity.service.ts`.** The function uses an `as` cast internally — this is an established pattern that the style enforcer is aware of. Do not redesign it.

- **`satisfies EmailReplyRecord`** on the `PutCommand` Item in Step 9.4. This is the established pattern for DynamoDB writes in this codebase (see `identity.service.ts` and `chat-session.service.ts`) and acts as a compile-time completeness check. The style enforcer explicitly preserves `satisfies` on DynamoDB writes.

- **No `else` statements.** Use early returns for every rejection path in `processInboundReply`. The service method is a sequence of guard clauses — each returns early on failure, falls through on success.

- **No inline type annotations on `const`/`let`.** Let TypeScript infer. Do not write `const sessionUlid: string = localPart`.

- **`wrapInHtml` as a module-level function.** Extract the HTML wrapping logic to a named function at the top of `email-reply.service.ts` to keep the method body clean. It is a pure transform (no side effects) so it does not need to be in a separate utility file.

- **`crypto` import.** Node's `crypto` module is a built-in — import as `import { createHash } from "crypto"`. No npm install needed.

- **`AnyFilesInterceptor` placement.** The `@UseInterceptors(AnyFilesInterceptor())` decorator must be on the handler method, not the controller class, so it only applies to the inbound route and does not interfere with any future JSON routes on the same controller.

- **`_files` parameter.** The `@UploadedFiles()` decorated parameter is required by `AnyFilesInterceptor` but unused in Phase 4. Prefix with `_` to satisfy the no-unused-vars rule without disabling the lint rule.
