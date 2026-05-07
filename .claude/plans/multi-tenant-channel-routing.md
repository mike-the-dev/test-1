# Plan: Multi-tenant channel routing (account-aware email + SMS)

## Objective

Replace the single-tenant static env vars (`SENDGRID_REPLY_ACCOUNT_ID`, `SENDGRID_REPLY_DOMAIN`, `SENDGRID_FROM_EMAIL`, `SENDGRID_FROM_NAME`, `TWILIO_REPLY_ACCOUNT_ID`, `TWILIO_PHONE_NUMBER`) with dynamic per-account channel configuration. Inbound traffic is routed to the right account by looking up the inbound channel address (Twilio number for SMS, reply domain for email) against a new index record type that lives under the account's primary key. Outbound traffic uses the per-account brand attributes from the account record. After this phase, the system supports any number of customer accounts on both channels concurrently — the architectural foundation required to scale beyond one production tenant.

This phase is the critical prerequisite to deploying the SMS channel for more than one customer account. It also retroactively unblocks email cold-entry (`assistant@<reply-domain>`), which was deployed but functionally unreachable because `SENDGRID_REPLY_ACCOUNT_ID` was never set.

The architectural commitments (locked during the brainstorming session):
- **Account record is the source of truth for channel config.** A nested `channels: { email: {...}, sms: {...} }` block lives on the account record alongside existing fields like `status: { is_active }`, `allowed_embed_origins`, etc.
- **Index records sit UNDER the account's primary key** at `PK: A#<accountUlid>, SK: <CHANNEL_TYPE>#<address>`. Cleanup, listing, and relational integrity are native main-table operations.
- **Inbound routing uses GSI1** with `GSI1-PK: <CHANNEL_TYPE>#<address>` and `GSI1-SK: ACCOUNT`. Multiplexed alongside the existing `DOMAIN#<host>` (account itself) and `ACCOUNT#<accountUlid>+EMAIL#<email>` (customer record) GSI1 patterns. No new GSI required.
- **Each channel owns its own service end-to-end.** The shared concept (channel address lookup) lives in a new `ChannelAddressService`; SMS and email each use it but otherwise remain independent.
- **No regression of cold-entry trust.** SMS continues to treat carrier-validated phone as implicit identity (no SMS verification flow). Email continues to validate sender-email-matches-stored-contact-info on Case 1 paths. The trust model is unchanged; only the account-routing mechanism changes.

---

## Affected Files

**Create:**
- `src/services/channel-address.service.ts` — owns `getAccountByChannelAddress(channelType, address)`, `provisionChannelAddress(...)`, `deprovisionChannelAddress(...)`. Single responsibility: address ↔ account mapping via index records.
- `src/services/channel-address.service.spec.ts` — tests for lookup, provisioning, deprovisioning, and the TransactWriteItems atomicity guarantees.
- `src/types/AccountChannel.ts` — `AccountChannelsConfig`, `AccountEmailChannelConfig`, `AccountSmsChannelConfig`, `AccountChannelAddressRecord`, `ChannelAddressType` enum.
- `.claude/plans/multi-tenant-channel-routing.md` — this file.

**Modify:**
- `src/services/sms-reply.service.ts` — Phase 1 of `processInboundMessage` replaces `this.twilioConfig.replyAccountId` with `this.channelAddressService.getAccountByChannelAddress("twilio_number", formFields.To)`. Outbound reply uses the looked-up account's `from_phone_number` (which equals `formFields.To` by construction; see Implementation Recommendations).
- `src/services/sms-reply.service.spec.ts` — update the account-resolution test paths; add a test for `unknown_twilio_number`.
- `src/services/sms.service.ts` — `send` accepts an explicit `from` parameter (the account-owned Twilio number) instead of reading `this.twilioConfig.phoneNumber`.
- `src/services/sms.service.spec.ts` — update tests to pass `from`.
- `src/services/twilio-config.service.ts` — REMOVE `phoneNumber` and `replyAccountId` getters. Keep `accountSid`, `authToken`, `publicWebhookUrl` (these are deployment-level Twilio credentials/URL, not per-account).
- `src/services/twilio-config.service.spec.ts` — remove tests for the dropped getters.
- `src/services/email-reply.service.ts` — `processInboundReply` and `handleAssistantEntry` are restructured: the inbound `To:` address's domain is looked up via `ChannelAddressService` to find the account, the local-part is then validated against that account's `channels.email.reply_local_part` config (replacing the hardcoded `"assistant"` constant). Subsequent handling is unchanged.
- `src/services/email-reply.service.spec.ts` — update account-resolution paths; add tests for unknown-domain rejection and local-part mismatch.
- `src/services/email.service.ts` — `send` accepts explicit `replyDomain` and `fromName` parameters (sourced from the account at call sites). The `if (!replyDomain)` warning path is removed (it's now mandatory; absent reply-domain means we couldn't have routed the inbound that triggered the reply).
- `src/services/email.service.spec.ts` — update tests for the new signature.
- `src/services/sendgrid-config.service.ts` — REMOVE `fromEmail`, `fromName`, `replyDomain`, `replyAccountId` getters. Keep `apiKey` (deployment-level SendGrid credential).
- `src/services/sendgrid-config.service.spec.ts` — remove tests for the dropped getters.
- `src/config/configuration.ts` — REMOVE `sendgrid.fromEmail`, `sendgrid.fromName`, `sendgrid.replyDomain`, `sendgrid.replyAccountId`, `twilio.phoneNumber`, `twilio.replyAccountId` from the config tree. Keep `sendgrid.apiKey`, `twilio.accountSid`, `twilio.authToken`, `twilio.publicWebhookUrl`.
- `src/config/env.schema.ts` — REMOVE `SENDGRID_FROM_EMAIL`, `SENDGRID_FROM_NAME`, `SENDGRID_REPLY_DOMAIN`, `SENDGRID_REPLY_ACCOUNT_ID`, `TWILIO_PHONE_NUMBER`, `TWILIO_REPLY_ACCOUNT_ID` Zod entries.
- `src/app.module.ts` — register `ChannelAddressService` as a provider; inject it into `SmsReplyService` and `EmailReplyService`.
- `src/types/Account.ts` — extend the existing account-record interface with `channels?: AccountChannelsConfig` (optional during transition; required logically per account that uses any channel).
- `src/types/Email.ts` — add `replyDomain` and `fromName` to `EmailSendParams`.
- `src/types/Sms.ts` — add `from` to `SmsSendParams`.

**Out of scope (do NOT touch):**
- `src/services/chat-session.service.ts` — agent dispatch is already channel-agnostic; account ULID flows through unchanged.
- `src/services/session.service.ts` — `lookupOrCreateSession` accepts `accountUlid` already.
- `src/services/customer.service.ts` — already uses GSI1 with its own `ACCOUNT#<accountUlid>+EMAIL#<email>` PK pattern. Not affected.
- `src/services/origin-allowlist.service.ts` — uses GSI1 with `DOMAIN#<host>` for e-commerce store identity. Not affected.
- `src/tools/*` — tools receive `accountUlid` via execution context; that flow is unchanged.
- `src/services/email-reply.service.ts:handleCase1SessionUlid` — Case 1 (visitor replies to `<sessionUlid>@reply.domain`) does NOT use account-routing; the session ULID encodes the account via its METADATA. This handler is unchanged.

**Out of scope as deferred follow-ups:**
- Caching layer (DAX or app-level) for the channel-address lookup. The architecture is cache-friendly (rarely-changing mapping, ~99% hit ratio expected); add when scale demands.
- Migration tooling for existing data. The migration is small (one account currently uses `reply.instapaytient.com`) and is performed manually as part of the deploy steps, not via automated migration code.
- Admin UI for provisioning channel addresses. Out of scope; provisioning is performed via direct service-method invocation or DDB writes for v1.

---

## Architectural Notes

### Account record extension

The account record at `PK: A#<accountUlid>, SK: A#<accountUlid>, entity: "ACCOUNT"` gains a nested `channels` config block. Mirrors the existing `status: { is_active }` nested-object precedent.

```ts
{
  PK: "A#<accountUlid>",
  SK: "A#<accountUlid>",
  entity: "ACCOUNT",
  status: { is_active: true },
  allowed_embed_origins: [...],
  GSI1-PK: "DOMAIN#<host>",          // unchanged
  GSI1-SK: "...",                     // unchanged
  channels: {                         // NEW nested block
    email: {
      reply_domains: ["reply.acmestore.com"],
      reply_local_part: "assistant",
      from_name: "Acme Concierge"
    },
    sms: {
      phone_numbers: ["+15551234567"]
    }
  }
}
```

`reply_domains` and `phone_numbers` are arrays. An account can own multiple email reply domains or multiple Twilio numbers if their plan permits. For v1, most accounts will have one of each. The arrays are the source-of-truth for which addresses belong to the account; index records (described next) are the inverse-lookup mechanism for inbound routing.

`reply_local_part` defaults to `"assistant"` for backward compatibility but is per-account configurable. An account that wants its reply address to be `concierge@reply.acmestore.com` sets `reply_local_part: "concierge"`.

### Channel address index record (new record type)

```ts
{
  PK: "A#<accountUlid>",                                        // account PK — relational
  SK: "<CHANNEL_TYPE>#<address>",                               // channel + address
  entity: "ACCOUNT_CHANNEL_ADDRESS",
  channel_type: "twilio_number" | "email_reply_domain",
  address: "<the address as a bare string>",
  GSI1-PK: "<CHANNEL_TYPE>#<address>",                          // for inbound routing
  GSI1-SK: "ACCOUNT",
  _createdAt_: ISO 8601
}
```

Concrete examples:

```ts
// SMS index record:
{
  PK: "A#01HX...",
  SK: "TWILIO_NUMBER#+15551234567",
  entity: "ACCOUNT_CHANNEL_ADDRESS",
  channel_type: "twilio_number",
  address: "+15551234567",
  GSI1-PK: "TWILIO_NUMBER#+15551234567",
  GSI1-SK: "ACCOUNT",
  _createdAt_: "..."
}

// Email index record:
{
  PK: "A#01HX...",
  SK: "EMAIL_REPLY_DOMAIN#reply.acmestore.com",
  entity: "ACCOUNT_CHANNEL_ADDRESS",
  channel_type: "email_reply_domain",
  address: "reply.acmestore.com",
  GSI1-PK: "EMAIL_REPLY_DOMAIN#reply.acmestore.com",
  GSI1-SK: "ACCOUNT",
  _createdAt_: "..."
}
```

### GSI1 multiplexing

GSI1 now carries three coexisting PK patterns:

| GSI1-PK | GSI1-SK | Item type | Purpose |
|---|---|---|---|
| `DOMAIN#<host>` | (existing) | ACCOUNT | E-commerce store identity (existing) |
| `ACCOUNT#<accountUlid>` | `EMAIL#<email>` | CUSTOMER | Customer-by-email lookup (existing) |
| `EMAIL_REPLY_DOMAIN#<domain>` | `ACCOUNT` | ACCOUNT_CHANNEL_ADDRESS | Inbound email routing (new) |
| `TWILIO_NUMBER#<E.164>` | `ACCOUNT` | ACCOUNT_CHANNEL_ADDRESS | Inbound SMS routing (new) |

Each query targets a unique PK pattern. No collisions. High cardinality of the new patterns (one PK per address) ensures load distribution across many partitions. Each lookup is a `Query(GSI1, GSI1-PK = <unique address PK>, Limit: 1)` returning a single item — RCU and latency cost essentially equivalent to a `GetItem`.

### `ChannelAddressService` — single responsibility

```ts
class ChannelAddressService {
  // Inbound routing: given an address, find the account
  async getAccountByChannelAddress(
    channelType: ChannelAddressType,
    address: string
  ): Promise<{ accountUlid: string } | null>;

  // Provisioning: write the account-record's channels.* + the index record atomically
  async provisionChannelAddress(input: {
    accountUlid: string;
    channelType: ChannelAddressType;
    address: string;
  }): Promise<{ provisioned: true } | { error: string }>;

  // Deprovisioning: remove the index record + remove from account-record's channels.* atomically
  async deprovisionChannelAddress(input: {
    accountUlid: string;
    channelType: ChannelAddressType;
    address: string;
  }): Promise<{ deprovisioned: true } | { error: string }>;
}
```

**Lookup is a single GSI1 Query with `Limit: 1`** filtered by `entity = "ACCOUNT_CHANNEL_ADDRESS"` (defensive — the PK pattern alone is unique to this record type). Returns the resolved `accountUlid` (extracted from the index record's `PK` field, which is `A#<accountUlid>`).

**Provisioning is a `TransactWriteItems`** that BOTH (a) updates the account record's `channels.<channel>.<addresses-array>` to include the new address (idempotent — the address is added only if absent) AND (b) puts the index record (`ConditionExpression: attribute_not_exists(PK)`). Either both succeed or both fail. No drift.

**Deprovisioning is the reverse `TransactWriteItems`** — remove the address from the account's array and delete the index record. Atomic.

### Inbound flow changes

**Email — `EmailReplyService.processInboundReply`:**

The existing flow extracts the local-part from the inbound `To:` address (e.g., `assistant` from `assistant@reply.acmestore.com`). The local-part is classified:
- Crockford ULID → SESSION_ULID (Case 1, unchanged)
- Anything else → goes to the new `handleAssistantEntry` flow

In the new `handleAssistantEntry`:
1. Parse the domain from `To:` (e.g., `reply.acmestore.com`).
2. `channelAddressService.getAccountByChannelAddress("email_reply_domain", domain)` → resolve account.
3. If no account → `rejected_unknown_account`.
4. GetItem the account record → read `channels.email.reply_local_part` (default `"assistant"` if absent).
5. If the inbound local-part doesn't match → `rejected_unknown_local_part`.
6. Otherwise, route to `handleCase2NewSession` / `handleCase3FreshAttach` / `handleCase3StaleNewSession` as before, with the resolved `accountUlid`.

**Crucially: the existing classification enum (`SESSION_ULID | ASSISTANT_ENTRY | UNRECOGNIZED`) is replaced with `SESSION_ULID | DOMAIN_ROUTED | UNRECOGNIZED`.** `DOMAIN_ROUTED` covers any local-part that isn't a session ULID and lets the domain-then-local-part validation happen inside `handleAssistantEntry` (renamed in the spec; see Step 3.5).

**SMS — `SmsReplyService.processInboundMessage`:**

Phase 1 (account guard) is rewritten:
1. `channelAddressService.getAccountByChannelAddress("twilio_number", formFields.To)` → resolve account.
2. If no account → log `[event=sms_inbound_unknown_number outcome=rejected_unknown_account]`, return `rejected_unknown_account`.

Phases 2-5 (phone format guard, body guard, dedupe, customer lookup, route) are unchanged except they now use the resolved `accountUlid` rather than the env-var-derived one.

### Outbound flow changes

**Email — `EmailService.send`:**

Signature changes from:
```ts
send(params: { to, subject, body, sessionUlid, ... }): Promise<{ messageId }>
```

To:
```ts
send(params: { to, subject, body, sessionUlid, replyDomain, fromName, ... }): Promise<{ messageId }>
```

`replyDomain` and `fromName` are sourced from the account record at the call site — `EmailReplyService` and any other caller GetItems the account, reads `channels.email.reply_domains[0]` and `channels.email.from_name`, and passes them to `send`. The `if (!replyDomain)` fallback warning is removed: in multi-tenant mode, an absent reply-domain on an account record means the account is misconfigured, not a graceful degradation.

**SMS — `SmsService.send`:**

Signature changes from:
```ts
send(params: { to, body, sessionUlid }): Promise<{ messageSid }>
```

To:
```ts
send(params: { to, body, sessionUlid, from }): Promise<{ messageSid }>
```

`from` is sourced from the resolved account's `channels.sms.phone_numbers[0]` (or — more precisely — the same number the inbound `To:` carried, since by definition that's the number this account owns and the visitor texted). The env var read is removed.

### Migration plan for the existing tenant

Today, one production account uses `assistant@reply.instapaytient.com`. Migration steps (executed once, by hand or via a one-off script, NOT in the application code):

1. Identify the production account ULID: `A#<existing-account>`.
2. Update its account record: set `channels.email = { reply_domains: ["reply.instapaytient.com"], reply_local_part: "assistant", from_name: "<existing FROM_NAME>" }`. The `from_name` value comes from the current `SENDGRID_FROM_NAME` env var.
3. Write the email index record: `PK: A#<existing-account>, SK: EMAIL_REPLY_DOMAIN#reply.instapaytient.com, entity: ACCOUNT_CHANNEL_ADDRESS, channel_type: email_reply_domain, address: reply.instapaytient.com, GSI1-PK: EMAIL_REPLY_DOMAIN#reply.instapaytient.com, GSI1-SK: ACCOUNT`.
4. After deploy, send one test email to `assistant@reply.instapaytient.com` to confirm Case 2/3 routing works for that account.

For SMS: since the SMS cold-entry path was never deployed (`TWILIO_REPLY_ACCOUNT_ID` was effectively unused), there is no SMS migration. Each new account that wants SMS gets provisioned freshly via `ChannelAddressService.provisionChannelAddress`.

### Why the chosen patterns hold up at scale

(Locked during the brainstorming session — preserving the reasoning here for the implementer's context.)

- **Cardinality:** GSI1-PK uses `EMAIL_REPLY_DOMAIN#<domain>` and `TWILIO_NUMBER#<phone>` — one unique PK per address. At any practical scale (1M+ accounts), each PK is its own GSI partition; load distributes naturally; no hot partition.
- **Query shape:** `Query(GSI1, GSI1-PK = <address PK>, Limit: 1)` is a point lookup, not a range scan. RCU and latency identical to a `GetItem` per item returned.
- **Workload:** SMS inbound is bounded by carrier rate limits and visitor texting behavior (peak ~10-50K RPS at 1M accounts). Well within DDB on-demand and provisioned-with-autoscaling capabilities.
- **Email cold-entry routing is rare:** Case 1 replies (the common path) bypass the GSI entirely because the session ULID is in the local-part; only `assistant@`-style cold-entry inbound triggers the GSI lookup.
- **Future cache layer is additive:** if extreme scale eventually demands sub-10ms account routing, an app-level cache (Redis) or DAX can sit in front of `ChannelAddressService.getAccountByChannelAddress` without changing the data model.

---

## Step-by-Step Implementation Sequence

Strict ordering. Each step compiles independently and the test suite is run after each.

### Step 1 — Create `src/types/AccountChannel.ts`

**What:** Type definitions for the account's `channels` config block, the new `ACCOUNT_CHANNEL_ADDRESS` record, and the `ChannelAddressType` enum.

**Why first:** Types must exist before services that consume them.

**Implementation details:**
- `enum ChannelAddressType` with members `EMAIL_REPLY_DOMAIN = "email_reply_domain"` and `TWILIO_NUMBER = "twilio_number"`. Snake_case values to match the codebase's DDB attribute naming convention.
- `AccountEmailChannelConfig`: `{ reply_domains: string[]; reply_local_part: string; from_name: string }`.
- `AccountSmsChannelConfig`: `{ phone_numbers: string[] }`.
- `AccountChannelsConfig`: `{ email?: AccountEmailChannelConfig; sms?: AccountSmsChannelConfig }`. Both nested keys optional — an account using only one channel doesn't carry the other.
- `AccountChannelAddressRecord`: `{ PK: string; SK: string; entity: "ACCOUNT_CHANNEL_ADDRESS"; channel_type: string; address: string; "GSI1-PK": string; "GSI1-SK": "ACCOUNT"; _createdAt_: string }`.

**Done when:** File compiles; types are importable from sibling files.

---

### Step 2 — Extend `src/types/Account.ts`

**What:** Add optional `channels?: AccountChannelsConfig` to the existing account-record interface.

**Implementation details:**
- Locate the existing account interface (verify the file path; the implementer must inspect the codebase to find it).
- Add the optional `channels` field via type-extension. Existing account records without `channels` are still valid (backward compatible at the type level).
- No schema changes elsewhere — DDB reads/writes are untyped at the SDK boundary.

**Done when:** Account interface includes `channels?: AccountChannelsConfig`; no type errors at consumer sites.

---

### Step 3 — Create `src/services/channel-address.service.ts` + spec

**What:** The new `@Injectable()` service that owns the address ↔ account mapping.

**Implementation details:**

Public methods (all returning structured results, NO thrown errors except for genuine programming bugs):

`getAccountByChannelAddress(channelType: ChannelAddressType, address: string): Promise<{ accountUlid: string } | null>`
- Build `gsi1Pk = ${channelType.toUpperCase()}#${address}` (e.g., `EMAIL_REPLY_DOMAIN#reply.acmestore.com`).
- Wait — the SK pattern uses uppercase channel-type; double-check the type-value-vs-key-prefix mapping. Use a small helper `formatGsi1PkForChannel(channelType, address)` to produce `EMAIL_REPLY_DOMAIN#...` or `TWILIO_NUMBER#...`. Defined at the top of the file.
- Issue `Query` against GSI1 with `KeyConditionExpression: "GSI1-PK = :pk", FilterExpression: "entity = :entity"`, `:pk = gsi1Pk`, `:entity = "ACCOUNT_CHANNEL_ADDRESS"`, `Limit: 1`.
- If no items returned → return `null`.
- Otherwise, extract the resolved `accountUlid` from the item's `PK` field (strip the `A#` prefix).
- Return `{ accountUlid }`.
- On any DynamoDB error: log warn, return `null`. The caller (SMS/email reply service) treats `null` as `rejected_unknown_account`.

`provisionChannelAddress(input: { accountUlid, channelType, address })`
- Build the index record's PK/SK and GSI1 keys.
- Build a `TransactWriteItems` with two operations:
  1. `Put` the new index record with `ConditionExpression: attribute_not_exists(PK) AND attribute_not_exists(SK)`. Fails if the address is already provisioned for this account.
  2. `Update` the account record with `SET channels.<channel-key>.<address-array-key> = list_append(if_not_exists(channels.<channel-key>.<address-array-key>, :empty_list), :new_address_list), _lastUpdated_ = :now`. The `if_not_exists(...)` initializes the array if absent. The list_append idempotency note below applies.
- Return `{ provisioned: true }` on success.
- On `TransactionCanceledException` from DDB: inspect cancellation reasons. If the index record's condition failed → return `{ error: "address_already_provisioned" }`. Otherwise → log error, return `{ error: "provisioning_failed" }`.

**Idempotency consideration on `list_append`:** if `provisionChannelAddress` is called twice for the same address, the first call writes the index record and adds to the array. The second call's index record `ConditionExpression` fails → the whole transaction aborts → the array is NOT double-appended. Correct behavior.

`deprovisionChannelAddress(input: { accountUlid, channelType, address })`
- Build a `TransactWriteItems` with two operations:
  1. `Delete` the index record at the provisioned address with `ConditionExpression: attribute_exists(PK)`.
  2. `Update` the account record removing the address from `channels.<channel-key>.<address-array-key>` via a `REMOVE channels.<channel-key>.<address-array-key>[<index>]` expression. The list-index has to be looked up first (since DDB doesn't support filter-based array removal directly) — so this operation is actually two ops: `GetItem` the account record, find the index of the address, build the REMOVE expression. NOT atomic with the index-record delete in that case.
  
  **Better approach:** instead of REMOVE-by-index, store the addresses as a string SET (`SS` attribute type) in DDB, which supports `DELETE channels.<channel-key>.<address-set-key> :address_set` for atomic single-element removal. But that complicates the array vs set choice.
  
  **Simpler approach for v1:** the deprovisioning workflow is admin-only and infrequent. Accept the minor non-atomicity: index record deletion is the source-of-truth for routing (after delete, no inbound traffic resolves to the account); the account record's array cleanup is best-effort and can be reconciled by an admin if it ever drifts. Document this trade-off in the service's JSDoc.

  Implementation chooses: use a string SET (`Set<string>`) for `phone_numbers` and `reply_domains` from the start, and use DDB SET operations (`ADD`, `DELETE`) for atomic single-element changes. Store as `Set<string>` at the type level.

**Note for the implementer:** the `Set<string>` choice is at the DDB-attribute-level, not the TS-type-level. The TS interface still says `reply_domains: string[]` for ease of use; the conversion to/from DDB SS happens at the read/write boundary. This matches the codebase's pattern for `allowed_embed_origins` (which is also stored as a list in DDB but typed as `string[]` in TS).

Actually, simpler still: store as a regular DDB `L` (list). For deprovisioning, use the dedicated `REMOVE` operator on the specific list index after a small `GetItem`. Two-step but still well-bounded. Consistent with how `allowed_embed_origins` works elsewhere in the codebase.

**The implementer should make a final call between SS (string set) and L (list) based on the existing pattern in the codebase**. If `allowed_embed_origins` is stored as L → use L. If it's SS → use SS. Maintain consistency.

**Done when:** All three methods are implemented; spec covers happy paths and error paths for each; tests for the TransactWriteItems atomicity behavior pass.

---

### Step 4 — Modify `src/services/twilio-config.service.ts` and `src/services/sendgrid-config.service.ts`

**What:** Remove the per-account getters from both config services. Keep only deployment-level credentials and URLs.

**Implementation details:**

`TwilioConfigService`:
- KEEP: `accountSid`, `authToken`, `publicWebhookUrl`.
- REMOVE: `phoneNumber`, `replyAccountId` getters.

`SendGridConfigService`:
- KEEP: `apiKey`.
- REMOVE: `fromEmail`, `fromName`, `replyDomain`, `replyAccountId` getters.

**Spec updates:** remove tests for the dropped getters.

**Done when:** Build passes; remaining getters are unchanged.

---

### Step 5 — Modify `src/config/configuration.ts` and `src/config/env.schema.ts`

**What:** Drop the env vars that the config services no longer expose.

**Implementation details:**

`configuration.ts` — remove from the `sendgrid` and `twilio` blocks:
- `sendgrid.fromEmail`
- `sendgrid.fromName`
- `sendgrid.replyDomain`
- `sendgrid.replyAccountId`
- `twilio.phoneNumber`
- `twilio.replyAccountId`

Keep the rest of both blocks intact.

`env.schema.ts` — remove from the Zod schema:
- `SENDGRID_FROM_EMAIL`
- `SENDGRID_FROM_NAME`
- `SENDGRID_REPLY_DOMAIN` (including its transform/refine)
- `SENDGRID_REPLY_ACCOUNT_ID` (which was never present in the schema; pre-existing gap — also out-of-scope to add and remove in the same phase)
- `TWILIO_PHONE_NUMBER`
- `TWILIO_REPLY_ACCOUNT_ID`

`SENDGRID_REPLY_ACCOUNT_ID` was never in `env.schema.ts` (pre-existing gap, called out in the SMS-channel review). It can be left absent — there's nothing to remove. This is correct.

**Done when:** Build passes; the env vars are gone from both files; no other env vars are touched.

---

### Step 6 — Modify `src/services/email.service.ts` + spec

**What:** Update `send` signature to accept `replyDomain` and `fromName` from the caller. Remove the env-var fallbacks.

**Implementation details:**

`EmailSendParams` (in `src/types/Email.ts`) gains required fields:
- `replyDomain: string`
- `fromName: string`

`EmailService.send` body:
- Remove the `if (!replyDomain) { ... fallback ... }` block — the parameter is now required and trusted.
- Construct `from: ${sessionUlid}@${replyDomain}`, `name: fromName`.
- Everything else unchanged.

**Spec updates:** test fixtures pass the new fields; remove tests for the now-removed fallback path.

**Done when:** `EmailService.send` compiles with the new signature; tests pass.

---

### Step 7 — Modify `src/services/sms.service.ts` + spec

**What:** Update `send` signature to accept `from` from the caller.

**Implementation details:**

`SmsSendParams` gains:
- `from: string` (the E.164 Twilio number this account owns)

`SmsService.send` body:
- Remove the `const fromNumber = this.twilioConfig.phoneNumber` line and the corresponding `if (!fromNumber)` check.
- Use `params.from` directly in the `messages.create({ from, to, body })` call.

**Spec updates:** tests pass `from` explicitly.

**Done when:** Compiles; tests pass.

---

### Step 8 — Modify `src/services/sms-reply.service.ts` + spec

**What:** Replace Phase 1 env-var-account-read with `ChannelAddressService.getAccountByChannelAddress`. Wire the looked-up `accountUlid` through the rest of the existing flow. Pass the resolved phone number to `SmsService.send` as the new `from` parameter.

**Implementation details:**

Constructor: inject `ChannelAddressService`.

`processInboundMessage` Phase 1 rewrite:

```ts
// Phase 1 — Resolve account by inbound Twilio number (replaces env-var read)
const lookup = await this.channelAddressService.getAccountByChannelAddress(
  ChannelAddressType.TWILIO_NUMBER,
  formFields.To,
);

if (lookup === null) {
  this.logger.warn(
    `[event=sms_inbound_unknown_number twilioNumber=${redactedTwilioNumber} outcome=rejected_unknown_account]`,
  );
  return "rejected_unknown_account";
}

const accountId = lookup.accountUlid;
```

Use `buildRedactedPhone(formFields.To)` for the log line — same redaction helper used elsewhere in the file.

Outbound `smsService.send(...)` call sites (Case 2, Case 3 fresh, Case 3 stale) now pass `from: formFields.To` — by definition this is the account's number that the visitor texted; the response goes back from the same number.

**Spec updates:**
- The test for `rejected_unknown_account` now uses an `unknown_twilio_number` scenario (mock `channelAddressService.getAccountByChannelAddress` to return `null`).
- All happy-path tests now mock `channelAddressService.getAccountByChannelAddress` to return `{ accountUlid: TEST_ACCOUNT_ULID }`.
- All `smsService.send` call assertions verify `from: formFields.To` is passed.
- Drop the test for the env-var-empty-string case (no longer reachable).

**Done when:** Compiles; tests pass; `processInboundMessage` no longer reads `this.twilioConfig.replyAccountId`.

---

### Step 9 — Modify `src/services/email-reply.service.ts` + spec

**What:** This is the biggest change. Restructure the local-part classification + account routing to use `ChannelAddressService` for domain-based lookup and validate the local-part against the resolved account's `reply_local_part` config.

**Implementation details:**

Update the classification enum (in `src/types/EmailReply.ts`):
- Replace `ASSISTANT_ENTRY` with `DOMAIN_ROUTED` (more accurate name — the local-part is no longer the hardcoded "assistant").
- The full enum becomes: `SESSION_ULID | DOMAIN_ROUTED | UNRECOGNIZED`.
- `classifyLocalPart` only returns `SESSION_ULID` or `UNRECOGNIZED` based on whether the local-part is a valid Crockford ULID. The "is it the assistant string" check is gone — it's done later, after account resolution.
- `processInboundReply` flow becomes: if local-part is `SESSION_ULID` → `handleCase1SessionUlid` (unchanged). Otherwise → `handleDomainRoutedEntry` (renamed from `handleAssistantEntry`).

`handleDomainRoutedEntry(formFields, table)`:

```ts
private async handleDomainRoutedEntry(
  formFields: EmailReplySendGridInboundFormFields,
  localPart: string,
  domain: string,
  table: string,
): Promise<EmailReplyInboundProcessOutcome> {
  // Step 1 — Resolve account by inbound reply domain
  const lookup = await this.channelAddressService.getAccountByChannelAddress(
    ChannelAddressType.EMAIL_REPLY_DOMAIN,
    domain,
  );

  if (lookup === null) {
    this.logger.warn(
      `[event=email_inbound_unknown_domain domain=${domain} outcome=rejected_unknown_account]`,
    );
    return "rejected_unknown_account";
  }

  const accountUlid = lookup.accountUlid;

  // Step 2 — GetItem the account record to read channels.email config
  const accountResult = await this.dynamoDb.send(
    new GetCommand({
      TableName: table,
      Key: { PK: `A#${accountUlid}`, SK: `A#${accountUlid}` },
    }),
  );

  const account = accountResult.Item;

  if (!account || account.entity !== "ACCOUNT" || account.status?.is_active !== true) {
    this.logger.warn(
      `[event=email_inbound_account_inactive accountUlid=${accountUlid} outcome=rejected_unknown_account]`,
    );
    return "rejected_unknown_account";
  }

  const expectedLocalPart = account.channels?.email?.reply_local_part ?? "assistant";

  if (localPart !== expectedLocalPart) {
    this.logger.warn(
      `[event=email_inbound_unknown_local_part outcome=rejected_unknown_local_part]`,
    );
    return "rejected_unknown_local_part";  // new outcome — see EmailReplyInboundProcessOutcome update below
  }

  // Step 3 — Existing Case 2/3 routing (sender lookup → fresh attach or stale-replacement)
  // The rest of the existing handleAssistantEntry body, with `accountUlid` and the
  // resolved account's per-account brand attributes (reply_domain, from_name) plumbed through.
  // ...
}
```

Update `EmailReplyInboundProcessOutcome` to include `"rejected_unknown_local_part"` as a new outcome variant.

Outbound `emailService.send(...)` call sites pass `replyDomain: domain` (the same domain we resolved on inbound) and `fromName: account.channels.email.from_name`.

**Spec updates:**
- Tests for SESSION_ULID local-part path are unchanged.
- Tests for the old `ASSISTANT_ENTRY` path get rewritten with `DOMAIN_ROUTED` semantics:
  - Account resolution success + matching local-part → existing Case 2/3 paths.
  - Account resolution failure → `rejected_unknown_account`.
  - Account inactive → `rejected_unknown_account`.
  - Local-part mismatch → `rejected_unknown_local_part`.
- Tests assert `emailService.send` is called with the per-account `replyDomain` and `fromName`.

**Done when:** Compiles; all email-reply tests pass; the env-var-derived account-id is no longer referenced anywhere in this service.

---

### Step 10 — Modify `src/app.module.ts`

**What:** Register `ChannelAddressService` as a provider; ensure `SmsReplyService` and `EmailReplyService` constructors receive it via DI.

**Implementation details:**
- Import `ChannelAddressService` at the top of the file.
- Add to the `providers` array.
- The constructor changes in steps 8 and 9 already declare the dependency; NestJS auto-wires it once the provider is registered.

**Done when:** Application boots without DI errors; integration tests pass.

---

### Step 11 — Migration of the existing `reply.instapaytient.com` account

**What:** The actual data migration is performed by the user (manually or via one-off script), NOT in application code. The plan calls for:

1. **User-side action:** identify the production account ULID currently using `reply.instapaytient.com`.
2. **User-side action:** update its account record:
   - Set `channels.email = { reply_domains: ["reply.instapaytient.com"], reply_local_part: "assistant", from_name: "<existing SENDGRID_FROM_NAME>" }`.
3. **User-side action:** write the email index record at `PK: A#<existing-account>, SK: EMAIL_REPLY_DOMAIN#reply.instapaytient.com, ...` per the schema in this plan.
4. **User-side action:** verify by sending one test email to `assistant@reply.instapaytient.com` after deploy.

The implementer does NOT script this migration; it is documented in this plan and reproduced in `docs/journal.md` after the phase ships.

---

## Risks and Edge Cases

### High — Migration timing

The migration of the existing production account from env-var-driven to account-record-driven config MUST happen BEFORE deploy. If deployed first without the account record updated, every inbound email to `assistant@reply.instapaytient.com` would resolve to `null` and reject. Mitigation: surface this clearly in the deploy runbook; the user has explicitly acknowledged the user-side migration responsibility.

### High — `channels` field absent on legacy account records

Legacy accounts that don't have the `channels` field (because they predate this phase) will fail email cold-entry routing — `account.channels?.email?.reply_local_part` will be undefined, falling back to `"assistant"`, but the account also has no provisioned email domain index record, so the lookup at the inbound-domain layer will return `null` first. Net effect: unmigrated accounts can't receive cold inbound email — but they couldn't before either (because of the env-var single-tenancy). Web-only and Case-1-email-reply paths are unaffected. Acceptable.

### High — Race during `provisionChannelAddress` if address is reused across accounts

If two accounts somehow attempt to provision the same Twilio number concurrently, the index record's `attribute_not_exists(PK)` ConditionExpression in the TransactWriteItems will fail for the second writer. Returns `{ error: "address_already_provisioned" }`. Correct behavior.

### Medium — `_lastUpdated_` on account record during provisioning

The TransactWriteItems updates the account record's `channels.*` array AND its `_lastUpdated_` timestamp. Other writers to the account record (e.g., status updates) may race. Acceptable: TransactWriteItems uses optimistic concurrency at the item level; if both writers conflict on the same account, one retries.

### Medium — `EmailReplyInboundProcessOutcome` enum extension

Adding `"rejected_unknown_local_part"` is a backward-compatible extension to the existing enum. No callers consume this enum exhaustively (they only check specific outcomes), so the addition won't break exhaustiveness checks. Verify by grep.

### Medium — `from` parameter mismatch on `SmsService.send`

If `formFields.To` is somehow wrong (e.g., Twilio sends a malformed webhook), the controller's signature verification short-circuits the request. By the time `SmsService.send` runs, `from` has been validated. Defensive: `SmsService.send` could log a warning if `from` doesn't match a configured pattern, but this is over-defensive for v1.

### Low — Index record `_createdAt_` drift if the same address is deprovisioned and reprovisioned

If an account deprovisions and reprovisions the same address, the index record's `_createdAt_` resets. Acceptable — the field is informational; routing behavior is unaffected.

### Low — Search ergonomics for "all accounts using a given reply domain"

`Query(GSI1, GSI1-PK = EMAIL_REPLY_DOMAIN#<domain>)` returns at most one account by design (each domain belongs to one account). If two accounts attempt to share a domain, the second's provisioning fails per the High risk above. So the cardinality is enforced.

### Low — Future caching layer compatibility

`ChannelAddressService.getAccountByChannelAddress` is a pure function of (channelType, address) → accountUlid. Adding DAX or a Redis cache in front of it is a wrap-the-method-in-cache transformation, no signature changes. Confirms forward compatibility.

---

## Testing Strategy

### Unit tests

**`channel-address.service.spec.ts`** — at least 12 tests:
- `getAccountByChannelAddress` happy path (returns accountUlid).
- `getAccountByChannelAddress` returns null when GSI1 query is empty.
- `getAccountByChannelAddress` returns null when DDB throws.
- `getAccountByChannelAddress` constructs the correct GSI1-PK for each `ChannelAddressType`.
- `provisionChannelAddress` happy path (writes index record + updates account array via TransactWriteItems).
- `provisionChannelAddress` returns `address_already_provisioned` on TransactionCanceledException with index-record-condition reason.
- `provisionChannelAddress` returns `provisioning_failed` on other DDB errors.
- `provisionChannelAddress` is idempotent for already-provisioned addresses (second call fails on the index record condition; the array is NOT double-appended).
- `deprovisionChannelAddress` happy path (deletes index record + removes from account array).
- `deprovisionChannelAddress` returns appropriate error if the index record doesn't exist.
- Each method's TransactWriteItems input is verified for correct shape (PK/SK, ConditionExpression, UpdateExpression).

**`sms-reply.service.spec.ts`** — update existing tests + add 2:
- Replace mock for `twilioConfig.replyAccountId` with mock for `channelAddressService.getAccountByChannelAddress` returning `{ accountUlid: TEST_ACCOUNT_ULID }`.
- All happy-path tests still pass with the new mock.
- New test: `rejected_unknown_account` when `getAccountByChannelAddress` returns `null`.
- All `smsService.send` call assertions verify `from: formFields.To` is included.

**`email-reply.service.spec.ts`** — significant restructure:
- Existing Case 1 (SESSION_ULID local-part) tests unchanged.
- Replace existing ASSISTANT_ENTRY tests with DOMAIN_ROUTED tests:
  - Mock `channelAddressService.getAccountByChannelAddress` to return `{ accountUlid }` for happy paths.
  - Mock `dynamoDb.send` to return the account record with `channels.email.reply_local_part: "assistant"`.
  - All Case 2/3 paths still pass.
- New test: `rejected_unknown_account` when `getAccountByChannelAddress` returns `null` for the inbound domain.
- New test: `rejected_unknown_account` when account record exists but `status.is_active === false`.
- New test: `rejected_unknown_local_part` when local-part doesn't match the account's `reply_local_part`.
- Verify `emailService.send` is called with the per-account `replyDomain` and `fromName`.

**`sms.service.spec.ts`** — update tests to pass `from: TEST_TWILIO_NUMBER` explicitly. Drop the `TWILIO_PHONE_NUMBER not configured` test (no longer reachable).

**`email.service.spec.ts`** — update tests to pass `replyDomain` and `fromName`. Drop the fallback-warning test.

**`twilio-config.service.spec.ts`** and **`sendgrid-config.service.spec.ts`** — drop tests for the removed getters; keep the rest.

### Integration / e2e

After deploy, the user-side migration steps include sending one test email and one test SMS to confirm the new routing. Documented in the plan; not automated.

### Full test suite

- Pre-phase: 635/635, 41 suites.
- Estimated post-phase: ~660 / 43 suites (+25-ish tests across the new spec + modified specs).
- `npm run build` and `npm test` clean before reporting done.

---

## Implementation Recommendations

### Strict step ordering

The dependency chain: types → channel-address.service → config-service edits → email/sms transport changes → reply-service rewrites → app.module wiring → migration step (user-side, last).

Steps 1, 2, and 3 must compile before any of the rewrites in steps 6-9. Step 4 (config-service trims) must happen before step 5 (env-schema trims) so the build doesn't fail on missing imports between them. The implementer should verify build after each step.

### Verify after each step

`npx tsc --noEmit` after every file change.

### Account-record source-of-truth principle

The account record's `channels.<channel>.<addresses-array>` is the source-of-truth for "what addresses does this account own." Index records are the inverse-lookup mechanism. Provisioning and deprovisioning MUST update both atomically (TransactWriteItems). The implementer should resist the temptation to introduce a separate "address registry" service — `ChannelAddressService` is the single owner.

### Defensive `entity` filter in GSI queries

Even though the GSI1-PK pattern uniquely identifies `ACCOUNT_CHANNEL_ADDRESS` records, every Query should still include `FilterExpression: entity = :entity` for defense-in-depth (matches the existing pattern in `OriginAllowlistService`).

### Migration is user-driven

The implementer does NOT write a migration script. The plan documents the exact data-shape transformation; the user performs it manually or via one-off ops tooling outside the application code.

### Out-of-scope reminders

- DAX or Redis caching for the lookup → future phase.
- Admin UI for provisioning → future phase.
- Pre-existing `SENDGRID_REPLY_ACCOUNT_ID`-not-in-env-schema gap → leave alone (the env var goes away anyway).

### Commit/push gates

Per the project's standing rules:
- Sub-agents stage changes; do NOT commit.
- The orchestrator surfaces the diff to the user for explicit approval before every commit.
- The orchestrator pushes only after the user has explicitly approved the push.
- All five sub-agents (arch-planner → code-implementer → style-refactor → test-suite-runner → code-reviewer) run in sequence. Style-refactor is non-negotiable.
- A close-out cycle runs if the code-reviewer flags any SHOULD FIX items.
