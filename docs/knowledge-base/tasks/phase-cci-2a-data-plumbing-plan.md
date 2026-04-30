# Phase CCI-2a — Cross-channel identity: chat-side data plumbing
# Implementation Plan

---

## Overview

This phase makes the chat-side identity flow data-complete. It has four coordinated changes: (1) `collect_contact_info` grows a customer-linking side-effect gated on the TRIO-COMPLETION condition (`first_name + last_name + email` all present in USER_CONTACT_INFO AND `metadata.customer_id` not yet set), calling a new shared `CustomerService.lookupOrCreateCustomer` method and writing `metadata.customer_id` in the prefixed `C#<ulid>` form already used by `verify_code`; (2) `preview-cart.tool.ts` is simplified — the entire `resolveCustomerUlid` method is removed, the bare-ULID METADATA write is removed, and the tool hard-requires `metadata.customer_id` instead of creating it on-the-fly; (3) `CustomerService` gains a `lookupOrCreateCustomer` method that wraps the existing `queryCustomerIdByEmail` query plus the create logic lifted byte-for-byte from `preview-cart.tool.ts:530–632`; (4) `generate-checkout-link.tool.ts` strips the `C#` prefix from `metadata.customer_id` before interpolating into the checkout URL so the frontend's existing bare-ULID contract is preserved exactly. When this phase ships, every session that completes the contact-info trio will have a Customer record and a linked `customer_id` before the visitor ever reaches the cart.

---

## Affected Files and Modules

### Modify

| File | Change |
|------|--------|
| `src/services/customer.service.ts` | Add `lookupOrCreateCustomer` method |
| `src/services/customer.service.spec.ts` | Add 4 test cases for `lookupOrCreateCustomer` |
| `src/tools/collect-contact-info.tool.ts` | Add trio-completion-gated side-effect: two GetCommands (USER_CONTACT_INFO post-write + METADATA), call lookupOrCreateCustomer, UpdateCommand METADATA with if_not_exists; change return shape to JSON-structured result; inject CustomerService |
| `src/tools/preview-cart.tool.ts` | Remove `resolveCustomerUlid` method; remove bare-ULID METADATA customer_id write; read customer_id from METADATA and error if absent; remove CustomerService injection; strip C# prefix for cart record write |
| `src/tools/preview-cart.tool.spec.ts` | Broad fixture update: add `customer_id` to makeMetadataItem per-test overrides; remove tests exercising resolveCustomerUlid paths; add missing-customer_id error test |
| `src/tools/generate-checkout-link.tool.ts` | Strip `C#` prefix from `metadata.customer_id` before URL construction at line 167 |
| `src/tools/generate-checkout-link.tool.spec.ts` | Update existing happy-path fixture to use prefixed customer_id; add strip-prefix assertion test |

### Create

| File | Purpose |
|------|---------|
| `src/tools/collect-contact-info.tool.spec.ts` | New comprehensive spec: covers existing field-save behavior AND the new trio-completion-gated side-effect |

### No Change Needed (type loosening is NOT required)

| File | Reason |
|------|--------|
| `src/types/GuestCart.ts` | `GuestCartCustomerRecord.first_name` and `.last_name` REMAIN non-nullable `string`. The trio-completion gate ensures Customer records are never created with null name fields. No type loosening needed. |

### Review Only (no change)

| File | Reason |
|------|--------|
| `src/services/chat-session.service.ts` | Option-A normalization guard (`customerId.startsWith("C#") ? customerId : "C#" + customerId`) STAYS unchanged — legacy compat for in-flight sessions written by old bare-ULID preview_cart path |
| `src/tools/verify-code.tool.ts` | Reference for `customer_id` write pattern — no change |
| `src/services/identity.service.ts` | Already initializes `customer_id: null` with `if_not_exists` — no change |
| `src/validation/tool.schema.ts` | `collectContactInfoInputSchema` unchanged — the new behavior is triggered by the post-write trio state, not by schema change |
| `src/app.module.ts` | CustomerService already registered from Phase 1 — no change |

---

## Dependencies and Architectural Considerations

- `CustomerService` is already registered in `AppModule` (Phase 1). Adding `lookupOrCreateCustomer` to it requires no module changes.
- `CollectContactInfoTool` currently injects only `DynamoDBDocumentClient` and `DatabaseConfigService`. Phase 2a adds `CustomerService` injection. The tool's `@Injectable()` + `@ChatToolProvider()` pattern matches other tools in the codebase.
- The DDB `ulid` import is required inside `CustomerService.lookupOrCreateCustomer` for generating `newCustomerUlid`. The `ulid` package is already a dependency (used in preview-cart.tool.ts and chat-session.service.ts).
- After removing `CustomerService` from `PreviewCartTool`, the `CustomerService` import in preview-cart.tool.ts is deleted. No other import changes are needed in that file.
- The `GuestCartCustomerResult` type in `src/types/GuestCart.ts` is used only by `preview-cart.tool.ts`'s `resolveCustomerUlid`. After removal, no other file references it. Do NOT delete this type — it is referenced by the type export from GuestCart.ts and its removal is not required by the brief. Leave it in place.
- `PutCommand` is imported in preview-cart.tool.ts today. After the refactor, if no other usage remains in that file, remove it from the import. Audit carefully — `BatchGetCommand`, `GetCommand`, and `UpdateCommand` all remain in use. `PutCommand` is ONLY used inside `resolveCustomerUlid` so it can be removed.

---

## `CustomerService.lookupOrCreateCustomer` Design

### Method signature (locked by brief)

```typescript
async lookupOrCreateCustomer(input: {
  tableName: string;
  accountUlid: string;
  email: string;
  firstName: string;        // non-nullable — caller must enforce trio completion before invoking
  lastName: string;         // non-nullable — caller must enforce trio completion before invoking
  phone: string | null;     // phone stays optional
}): Promise<{ customerUlid: string; created: boolean } | { error: string }>
```

`customerUlid` is the BARE ULID (no `C#` prefix). The caller wraps it as `C#${customerUlid}`.

The method does NOT internally validate trio completeness — the caller (collect_contact_info) gates the call on the trio being complete in USER_CONTACT_INFO. If a future caller passes empty strings, the Customer record gets empty strings (caller's bug, not the service's).

### Flow (byte-equivalent to `preview-cart.tool.ts:530–632`)

**Step A — Query GSI for existing customer.**
Call `this.queryCustomerIdByEmail(input.tableName, input.accountUlid, input.email)`. This is the existing method already in `CustomerService`.

- If lookup succeeds and returns a non-null ULID: return `{ customerUlid: existingUlid, created: false }`.
- If lookup throws: log `[event=lookup_or_create_customer_query_failed errorType=... accountUlid=...]` at `logger.error` and return `{ error: GENERIC_ERROR_STRING }`.

**Step B — Lookup missed. Generate new customer ULID and build customer record.**

```typescript
const newCustomerUlid = ulid();
const now = new Date().toISOString();

const customerRecord: GuestCartCustomerRecord = {
  PK: `C#${newCustomerUlid}`,
  SK: `C#${newCustomerUlid}`,
  entity: "CUSTOMER",
  "GSI1-PK": `ACCOUNT#${input.accountUlid}`,
  "GSI1-SK": `EMAIL#${input.email}`,
  email: input.email,
  first_name: input.firstName,   // non-nullable string — trio gate ensures this is always a real value
  last_name: input.lastName,     // non-nullable string — trio gate ensures this is always a real value
  phone: input.phone,            // may be null — phone is genuinely optional for v1
  billing_address: null,
  is_email_subscribed: false,
  abandoned_carts: [],
  total_abandoned_carts: 0,
  total_orders: 0,
  total_spent: 0,
  latest_session_id: null,
  _createdAt_: now,
  _lastUpdated_: now,
};
```

**Step C — PutCommand with `attribute_not_exists(PK)` ConditionExpression.**

```typescript
await this.dynamoDb.send(
  new PutCommand({
    TableName: input.tableName,
    Item: customerRecord,
    ConditionExpression: "attribute_not_exists(PK)",
  }),
);
```

- If Put succeeds: log `[event=customer_created accountUlid=...]` at `logger.debug` and return `{ customerUlid: newCustomerUlid, created: true }`.
- If Put throws with `name !== "ConditionalCheckFailedException"`: log `[event=customer_put_failed errorType=... accountUlid=...]` at `logger.error` and return `{ error: GENERIC_ERROR_STRING }`.

**Step D — ConditionalCheckFailedException: race recovery.**
Another concurrent writer beat us. Re-query the GSI.

```typescript
// ConditionalCheckFailedException branch
this.logger.debug(`[event=customer_create_race_recovered accountUlid=${input.accountUlid}]`);

let recoveredUlid: string | null;
try {
  recoveredUlid = await this.queryCustomerIdByEmail(input.tableName, input.accountUlid, input.email);
} catch (reQueryError: unknown) {
  const errorName = reQueryError instanceof Error ? reQueryError.name : "UnknownError";
  this.logger.error(
    `[event=customer_race_requery_failed errorType=${errorName} accountUlid=${input.accountUlid}]`,
  );
  return { error: GENERIC_ERROR_STRING };
}

if (recoveredUlid === null) {
  this.logger.error(
    `[event=customer_race_requery_empty errorType=RaceRecoveryFailed accountUlid=${input.accountUlid}]`,
  );
  return { error: GENERIC_ERROR_STRING };
}

return { customerUlid: recoveredUlid, created: false };
```

### Named constants in CustomerService

```typescript
const CUSTOMER_PK_PREFIX = "C#";
const ACCOUNT_PREFIX = "ACCOUNT#";
const EMAIL_PREFIX = "EMAIL#";
const GENERIC_ERROR_STRING = "An unexpected error occurred. Please try again.";
```

Note: `CUSTOMER_PK_PREFIX` should be reused if Phase 1 exported it. If it is private to `verify-code.tool.ts`, define it in `customer.service.ts` as a module-level constant.

---

## `collect_contact_info` Extension — TRIO-COMPLETION-GATED Execute Flow

### New imports required

- `GetCommand` from `@aws-sdk/lib-dynamodb` (may already be imported — verify)
- `CustomerService` from `../services/customer.service`

### New constructor injection

Add `private readonly customerService: CustomerService` to the constructor alongside the existing injections.

### New types

Per the brief's locked return shape, define in `src/types/ChatSession.ts` (or as module-level in the tool if preferred):

```typescript
export type CollectContactInfoTrioCompletedResult = { saved: true; customerFound: boolean };
export type CollectContactInfoSavedResult = { saved: true };
```

These are used with `satisfies` at the JSON.stringify call sites.

### New named constants in collect-contact-info.tool.ts

```typescript
const METADATA_SK = "METADATA";
const CUSTOMER_PK_PREFIX = "C#";
```

(CHAT_SESSION_PK_PREFIX and USER_CONTACT_INFO_SK/CONTACT_INFO_SK already exist in the file — verify and reuse.)

### Execute flow (ordered — replaces the existing execute body)

**Step 1 — Validate input** (existing — unchanged).
`collectContactInfoInputSchema.safeParse(input)`. On failure, return `{ result: "Invalid input: ...", isError: true }`.

**Step 2 — UpdateCommand USER_CONTACT_INFO** (existing behavior, mostly unchanged).
Run the existing UpdateCommand that upserts the provided fields to `USER_CONTACT_INFO`. This runs unconditionally for all valid inputs. On DDB failure, return `{ result: "...", isError: true }`.

**Step 3 — Read USER_CONTACT_INFO POST-WRITE and read metadata.customer_id.**
After the UpdateCommand succeeds, fetch the full merged USER_CONTACT_INFO state with a GetCommand:

```typescript
const contactResult = await this.dynamoDb.send(
  new GetCommand({
    TableName: this.databaseConfig.conversationsTable,
    Key: {
      PK: `${CHAT_SESSION_PK_PREFIX}${context.sessionUlid}`,
      SK: USER_CONTACT_INFO_SK,
    },
  }),
);
```

Separately (or in a second GetCommand), read METADATA to get `customer_id`:

```typescript
const metadataResult = await this.dynamoDb.send(
  new GetCommand({
    TableName: this.databaseConfig.conversationsTable,
    Key: {
      PK: `${CHAT_SESSION_PK_PREFIX}${context.sessionUlid}`,
      SK: METADATA_SK,
    },
  }),
);
```

The two GetCommands can be issued sequentially. The post-write USER_CONTACT_INFO read is authoritative for the trio-state check — it reflects the merged state including the fields just saved.

If either GetCommand throws, log the error at `logger.error` and return `{ result: JSON.stringify({ saved: true } satisfies CollectContactInfoSavedResult) }` (best-effort; the contact info was already saved in Step 2; the linking side-effect is non-fatal).

**Step 4 — Trio-completion gate.**

```typescript
const contactItem = contactResult.Item;
const existingCustomerId = metadataResult.Item?.customer_id;

const firstName = contactItem?.first_name ? String(contactItem.first_name) : null;
const lastName = contactItem?.last_name ? String(contactItem.last_name) : null;
const email = contactItem?.email ? String(contactItem.email) : null;
const phone = contactItem?.phone ? String(contactItem.phone) : null;

const trioComplete =
  firstName !== null && firstName !== "" &&
  lastName !== null && lastName !== "" &&
  email !== null && email !== "";

const customerIdAlreadySet =
  existingCustomerId !== null && existingCustomerId !== undefined;

if (!trioComplete || customerIdAlreadySet) {
  return { result: JSON.stringify({ saved: true } satisfies CollectContactInfoSavedResult) };
}
```

The gate requires ALL of:
- `first_name` is a non-empty string in the post-write USER_CONTACT_INFO
- `last_name` is a non-empty string in the post-write USER_CONTACT_INFO
- `email` is a non-empty string in the post-write USER_CONTACT_INFO
- `metadata.customer_id` is NOT already set

If the gate fails (trio not complete, OR customer_id already set): return `{ saved: true }`. Stop. No lookup-or-create call.

The `customerFound` signal fires AT MOST ONCE per session — on the call that completes the trio for the first time. Subsequent calls short-circuit at the `customerIdAlreadySet` check.

**Step 5 — Call `CustomerService.lookupOrCreateCustomer`.**

```typescript
const customerResult = await this.customerService.lookupOrCreateCustomer({
  tableName: this.databaseConfig.conversationsTable,
  accountUlid: context.accountUlid ?? "",
  email: email,           // non-null — confirmed by gate
  firstName: firstName,   // non-null, non-empty — confirmed by gate
  lastName: lastName,     // non-null, non-empty — confirmed by gate
  phone: phone,           // may be null — genuinely optional
});

if ("error" in customerResult) {
  this.logger.error(
    `[event=collect_contact_info_link_failed sessionUlid=${context.sessionUlid}]`,
  );
  return { result: JSON.stringify({ saved: true } satisfies CollectContactInfoSavedResult) };
}
```

On lookup-or-create error: log, return `{ saved: true }` (no `customerFound`). Best-effort — the contact info was already saved. Non-fatal and recoverable on the next collect_contact_info call that completes the trio (which will pass the gate again since customer_id was not set).

**Step 6 — UpdateCommand METADATA with `if_not_exists` semantics.**

```typescript
const customerId = `${CUSTOMER_PK_PREFIX}${customerResult.customerUlid}`;
try {
  await this.dynamoDb.send(
    new UpdateCommand({
      TableName: this.databaseConfig.conversationsTable,
      Key: {
        PK: `${CHAT_SESSION_PK_PREFIX}${context.sessionUlid}`,
        SK: METADATA_SK,
      },
      UpdateExpression:
        "SET #customer_id = if_not_exists(#customer_id, :customer_id), #lastUpdated = :now",
      ExpressionAttributeNames: {
        "#customer_id": "customer_id",
        "#lastUpdated": "_lastUpdated_",
      },
      ExpressionAttributeValues: {
        ":customer_id": customerId,
        ":now": new Date().toISOString(),
      },
    }),
  );
} catch (metaError: unknown) {
  const errorName = metaError instanceof Error ? metaError.name : "UnknownError";
  this.logger.error(
    `[event=collect_contact_info_link_failed sessionUlid=${context.sessionUlid} errorType=${errorName}]`,
  );
  // Best-effort: contact info was saved; link failure is non-fatal.
  return { result: JSON.stringify({ saved: true } satisfies CollectContactInfoSavedResult) };
}
```

**Step 7 — Return structured result.**

```typescript
const customerFound = !customerResult.created;
return {
  result: JSON.stringify(
    { saved: true, customerFound } satisfies CollectContactInfoTrioCompletedResult,
  ),
};
```

`customerFound: true` means lookup hit an existing record (returning visitor the agent should verify in Phase 2b).
`customerFound: false` means we just created the record OR race-recovered to a fresh one.

### Sequence summary

```
Validate input
→ UpdateCommand USER_CONTACT_INFO (existing, runs unconditionally)
→ GetCommand USER_CONTACT_INFO (post-write read — gets merged state)
→ GetCommand METADATA (read customer_id)
→ Trio-completion gate check (first_name + last_name + email non-empty AND customer_id not set)
  → Gate fails → return { saved: true }
  → Gate passes →
    → CustomerService.lookupOrCreateCustomer
      → Error → log, return { saved: true }
      → Success →
        → UpdateCommand METADATA (if_not_exists customer_id)
          → Error → log, return { saved: true }
          → Success → return { saved: true, customerFound: !created }
```

---

## `if_not_exists` Rationale for METADATA.customer_id Write

The METADATA UpdateCommand in `collect_contact_info` uses:
```
SET #customer_id = if_not_exists(#customer_id, :customer_id)
```

This is first-writer-wins semantics. The rationale:

1. **Verification may have already run.** If the visitor's `verify_code` succeeds before `collect_contact_info` completes the trio (pathological but possible), `verify_code` has already written a fully-trusted `C#<ulid>` to METADATA. The `collect_contact_info` trio-completion might resolve the same email to the same customer (benign, `if_not_exists` is a no-op) or to a different customer record. In the latter case, overwriting a verified-trust customer_id with an unverified one would be a regression. `if_not_exists` prevents this.

2. **Race between concurrent calls.** If two `collect_contact_info` calls race in the same session (unusual but possible in network retries), both will pass the gate (customer_id not yet set), both will call lookup-or-create, and both will attempt to write customer_id. The first writer wins; the second call's `if_not_exists` is a no-op. The `attribute_not_exists(PK)` ConditionExpression + race recovery in `lookupOrCreateCustomer` ensures only one Customer record is created.

3. **Alignment with verify_code's write convention.** `verify_code` uses a plain `SET customer_id = :customerId` (it is the authoritative, trust-elevated write). `collect_contact_info` uses `if_not_exists` (it is the earlier, lower-trust write). This asymmetry is intentional and correct.

---

## METADATA Write Failure Handling

**Decision: best-effort (`isError: false`, log the error, return `{ saved: true }` without `customerFound`).**

Justification:
- The contact save (Step 2 UpdateCommand to USER_CONTACT_INFO) has already succeeded when the METADATA write fails.
- Returning `isError: true` would cause the agent to report a contact-save failure to the visitor, which is misleading — the contact info was saved. The only thing that failed is the session-to-customer link.
- The session-to-customer link failure is a transient DDB issue. On the next `verify_code` success, the link will be set correctly by `verify_code`'s non-`if_not_exists` write. On the next `collect_contact_info` call, the trio-gate will pass again (customer_id still not set), retrying the link.
- The failure is logged at `logger.error` for observability.
- Returning `{ saved: true }` without `customerFound` means Phase 2b's verification flow won't be triggered in this turn. This is graceful degradation, not a data-loss scenario.

The same best-effort policy applies if `lookupOrCreateCustomer` itself returns an error.

---

## `generate-checkout-link.tool.ts` Strip-Prefix Design

### Problem

`generate-checkout-link.tool.ts` at line 167 constructs:
```typescript
const checkout_url = `${baseResult.base}/checkout?email=${encodeURIComponent(customer_email)}&customerId=${customer_id}&guestId=${guest_id}&cartId=${cart_id}&aiSessionId=${encodeURIComponent(sessionUlid)}`;
```

Under old `preview-cart.tool.ts`, `metadata.customer_id` was written as a bare ULID. Under Phase 2a, `collect_contact_info` writes `C#<ulid>`. The frontend has historically received `customerId=<bare-ulid>`. That external contract must be preserved exactly.

### Code change (line 167)

Before the URL construction line, add:

```typescript
const customerUlid = customer_id.startsWith("C#") ? customer_id.slice(2) : customer_id;
```

Then change the URL interpolation from `customerId=${customer_id}` to `customerId=${customerUlid}`:

```typescript
const checkout_url = `${baseResult.base}/checkout?email=${encodeURIComponent(customer_email)}&customerId=${customerUlid}&guestId=${guest_id}&cartId=${cart_id}&aiSessionId=${encodeURIComponent(sessionUlid)}`;
```

The `startsWith("C#") ? ... : ...` guard is belt-and-suspenders for any legacy in-flight session where METADATA.customer_id was written as a bare ULID by the old preview_cart path. It ensures the tool works correctly for both old and new format sessions.

Variable name: `customerUlid`. This clearly communicates that the value is a bare ULID with no prefix.

### Test plan additions (`generate-checkout-link.tool.spec.ts`)

1. **Update existing happy-path fixture:** Change the METADATA mock to return `customer_id: "C#abc123"` (prefixed, matching the new convention). Assert the constructed URL contains `customerId=abc123` (bare ULID — strip-prefix transformation works) and does NOT contain `C#` or the URL-encoded equivalent `C%23`.

2. **New strip-prefix assertion test:** With `metadata.customer_id = "C#<ulid>"`, assert the URL parameter is `customerId=<ulid>` (bare). This is an explicit guard against accidental regression where the prefix is re-introduced into the URL.

---

## `preview-cart.tool.ts` Simplification — Exhaustive Change List

### Removed: `resolveCustomerUlid` method (lines 530–633)

The entire `private async resolveCustomerUlid(...)` method is deleted. This includes:
- Method signature and all parameters
- The `genericError` string local variable inside the method
- The first `queryCustomerIdByEmail` call and its try/catch
- The `existingUlid !== null` early-return branch
- The `newCustomerUlid = ulid()` generation
- The `customerRecord: GuestCartCustomerRecord` object construction
- The `PutCommand` with `ConditionExpression: "attribute_not_exists(PK)"`
- The `ConditionalCheckFailedException` branch and its re-query + race-recovery
- The return statements: `{ isError: false, customerUlid }` and `{ isError: true, error }`

### Removed: Step 5 — resolve customer ULID block (lines ~215–241)

The following block is deleted:

```typescript
// Step 5 — resolve customer ULID
let customerUlid = metadataCustomerId ?? "";

if (metadataCustomerId) {
  this.logger.debug(
    `Customer lookup [sessionUlid=${sessionUlid} outcome=metadata customerUlid=${customerUlid}]`,
  );
}

if (!metadataCustomerId) {
  const customerResult = await this.resolveCustomerUlid(
    tableName, accountUlid, email, firstName, lastName, phone, sessionUlid,
  );
  if (customerResult.isError) {
    return { result: customerResult.error, isError: true };
  }
  customerUlid = customerResult.customerUlid;
}
```

### Replacement for Step 5 (the new hard-require logic)

```typescript
// Step 5 — resolve customer ULID from METADATA (hard requirement)
if (!metadataCustomerId) {
  this.logger.error(
    `[event=preview_cart_no_customer_id sessionUlid=${sessionUlid}]`,
  );
  return {
    result: "This action requires a customer profile. Please collect the visitor's email first.",
    isError: true,
  };
}

// Strip the C# prefix to get the bare ULID for use in the cart record's customer_id field
const customerUlid = metadataCustomerId.startsWith("C#")
  ? metadataCustomerId.slice(2)
  : metadataCustomerId;

this.logger.debug(
  `[event=preview_cart_customer_from_metadata sessionUlid=${sessionUlid}]`,
);
```

Note: the `startsWith("C#") ? ... : ...` fallback is a belt-and-suspenders guard for any in-flight legacy session with bare-ULID METADATA. It is NOT removing the Option-A normalization in `chat-session.service.ts` — that stays. This is a local strip-prefix for the cart record write only.

### Removed: METADATA UpdateCommand's `customer_id` field (lines ~457–469)

The METADATA UpdateCommand in Step 10 currently includes `customer_id` in the `if_not_exists` list. After the simplification, this field is REMOVED from the expression:

Before:
```
"SET #cart_id = if_not_exists(#cart_id, :cart_id), #guest_id = if_not_exists(#guest_id, :guest_id), #customer_id = if_not_exists(#customer_id, :customer_id), #customer_email = if_not_exists(#customer_email, :customer_email)"
```

After:
```
"SET #cart_id = if_not_exists(#cart_id, :cart_id), #guest_id = if_not_exists(#guest_id, :guest_id), #customer_email = if_not_exists(#customer_email, :customer_email)"
```

The `#customer_id` ExpressionAttributeNames entry and `:customer_id` ExpressionAttributeValues entry are also removed.

### Removed: `CustomerService` injection from `PreviewCartTool`

After the simplification, `CustomerService` is no longer referenced in `preview-cart.tool.ts`. Full removal:
- Remove `private readonly customerService: CustomerService` from the constructor parameter list
- Remove `import { CustomerService } from "../services/customer.service"` from the imports
- Remove `CustomerService` from the `@Inject()` decorator chain

### Removed: `PutCommand` import

`PutCommand` was only used in `resolveCustomerUlid`. Remove it from the `@aws-sdk/lib-dynamodb` import line.

### Cart record write — `customer_id` field (line ~428)

The cart UpdateCommand currently writes:
```typescript
":customer_id": `C#${customerUlid}`,
```

After the simplification, `customerUlid` is obtained by stripping the prefix from `metadataCustomerId`. The cart record write expression and values for `customer_id` are UNCHANGED (the `GuestCartRecord` interface requires `customer_id: string` with the `C#` prefix). The implementer must verify that:
- The cart's `"#customer_id": "customer_id"` ExpressionAttributeNames entry STAYS
- `:customer_id` ExpressionAttributeValues STAYS with value `C#${customerUlid}`

### Summary of removed symbols in preview-cart.tool.ts

| Symbol | Type | Reason |
|--------|------|--------|
| `resolveCustomerUlid` | private method | Lifted to CustomerService.lookupOrCreateCustomer |
| `CustomerService` (import + constructor) | dependency | No longer needed |
| `PutCommand` (import) | DDB command | Only used in resolveCustomerUlid |
| METADATA UpdateCommand `customer_id` SET clause | DDB expression field | collect_contact_info is now the sole writer |
| METADATA UpdateCommand `#customer_id` ExpressionAttributeNames | DDB expression name | Removed with the SET clause |
| METADATA UpdateCommand `:customer_id` ExpressionAttributeValues | DDB expression value | Removed with the SET clause |
| Step 5 resolveCustomerUlid call block | code block (~27 lines) | Replaced with hard-require guard |

---

## `metadata.customer_id` Readers — Comprehensive Sweep

The following files read `metadata.customer_id`:

**1. `src/services/chat-session.service.ts` (line 82)**
```typescript
const customerId: string | null = metadataResult.Item?.customer_id ?? null;
```
Then: the `latest_session_id` update block uses `customerKey = customerId.startsWith("C#") ? customerId : "C#" + customerId`. This is the Option-A normalization. It handles both bare-ULID (old preview_cart writes) and prefixed (new writes). STAYS UNCHANGED.

**2. `src/tools/preview-cart.tool.ts` (line 204)**
```typescript
metadataCustomerId = metadataItem.customer_id !== undefined ? String(metadataItem.customer_id) : undefined;
```
After Phase 2a: this read STAYS but the value is now guaranteed to be `C#<ulid>` or `null`/`undefined`. The new Step 5 guard handles both. The `metadataCustomerId.startsWith("C#") ? metadataCustomerId.slice(2) : metadataCustomerId` strip is a belt-and-suspenders guard for the rare legacy case.

**3. `src/tools/generate-checkout-link.tool.ts` (line 111)**
```typescript
customer_id = metadataItem.customer_id !== undefined ? String(metadataItem.customer_id) : undefined;
```
Then at line 167, `customer_id` is interpolated directly into the checkout URL. **Phase 2a adds the strip-prefix transform** so the frontend's `customerId=<bare-ulid>` contract is preserved. This is now in scope (Change 3).

**Conclusion on format assumptions:** No reader of `metadata.customer_id` in this codebase assumes a bare-ULID format in a way that would break with the new prefixed form after Phase 2a's changes. The Option-A normalization in chat-session.service.ts explicitly handles both formats. The generate-checkout-link tool now strips the prefix before URL construction.

---

## Step-by-Step Implementation Sequence

```
1. [src/services/customer.service.ts] Add lookupOrCreateCustomer method
   - Add `import { ulid } from "ulid"` and `PutCommand` to imports
   - Add `import { GuestCartCustomerRecord } from "../types/GuestCart"`
   - Implement the method as specified above — firstName and lastName are non-nullable string parameters
   - Named module-level constants: CUSTOMER_PK_PREFIX, ACCOUNT_PREFIX, EMAIL_PREFIX, GENERIC_ERROR_STRING
   - Why first: collect-contact-info.tool.ts depends on this method
   - Done when: TypeScript compiles; method is exported via the class

2. [src/services/customer.service.spec.ts] Add lookupOrCreateCustomer test cases
   - Add PutCommand to the mock imports
   - 4 new cases under a new `describe("lookupOrCreateCustomer")` block
   - Why here: validates the lifted logic before the dependent tool is changed
   - Done when: all 4 new cases pass; existing queryCustomerIdByEmail cases unaffected

3. [src/tools/collect-contact-info.tool.ts] Add trio-completion-gated side-effect and structured return
   - Add GetCommand import from @aws-sdk/lib-dynamodb (if not already present)
   - Add CustomerService import and constructor injection
   - Add METADATA_SK, CUSTOMER_PK_PREFIX module-level constants (reuse if already defined)
   - Add CollectContactInfoTrioCompletedResult and CollectContactInfoSavedResult types
   - Implement the new execute flow as specified above (Steps 1–7):
     Update USER_CONTACT_INFO → GetCommand USER_CONTACT_INFO post-write → GetCommand METADATA
     → trio-completion gate → lookupOrCreateCustomer → UpdateCommand METADATA if_not_exists
   - Why here: depends on CustomerService (step 1)
   - Done when: TypeScript compiles; execute returns JSON.stringify for all paths; gate logic is correct

4. [src/tools/collect-contact-info.tool.spec.ts] Create comprehensive spec
   - New file from scratch — no prior spec exists
   - Cover all cases enumerated in the Testing Strategy section (11 cases minimum)
   - Why here: validates the new behavior immediately before preview-cart changes
   - Done when: all new spec cases pass

5. [src/tools/preview-cart.tool.ts] Remove resolveCustomerUlid and simplify
   - Remove resolveCustomerUlid method in full
   - Remove CustomerService injection and import
   - Remove PutCommand import
   - Replace Step 5 with hard-require guard (error if no customer_id, strip C# prefix to get customerUlid)
   - Remove customer_id from METADATA UpdateCommand's if_not_exists expression
   - Why here: all customer-create logic is now in CustomerService; this is the clean-up
   - Done when: TypeScript compiles; `resolveCustomerUlid` no longer appears anywhere in the file

6. [src/tools/preview-cart.tool.spec.ts] Update spec fixtures
   - Fixture updates: add customer_id (prefixed C#...) to per-test metadata mocks for all existing happy-path tests
   - Remove tests/mock-setup exercising resolveCustomerUlid paths (QueryCommand, PutCommand mocks)
   - Add new "missing customer_id" error test using default makeMetadataItem() (no customer_id)
   - Remove Test 13 (customer record schema-default test — moved to customer.service.spec.ts)
   - Why here: existing tests will fail against the new code until updated
   - Done when: all tests pass; test count delta matches the Testing Strategy counts

7. [src/tools/generate-checkout-link.tool.ts] Add strip-prefix before URL construction
   - Add `const customerUlid = customer_id.startsWith("C#") ? customer_id.slice(2) : customer_id;`
     immediately before line 167 (the checkout_url construction)
   - Change `customerId=${customer_id}` to `customerId=${customerUlid}` in the URL template
   - Why here: after preview-cart simplification, this tool is the only other reader of metadata.customer_id
     that constructs an external URL from it
   - Done when: TypeScript compiles; the URL interpolation uses customerUlid (bare) not customer_id (prefixed)

8. [src/tools/generate-checkout-link.tool.spec.ts] Update existing tests and add strip-prefix test
   - Update existing happy-path fixture: METADATA mock returns customer_id: "C#abc123"
   - Assert constructed URL contains customerId=abc123 (bare) and NOT C# or C%23
   - Add new test explicitly asserting strip-prefix behavior for the prefixed format
   - Why here: validates the external contract is preserved; guard against regression
   - Done when: both updated test and new test pass
```

---

## Testing Strategy

### `src/services/customer.service.spec.ts` — ADD 4 cases under new describe block

| # | Description | Setup | Assertion |
|---|-------------|-------|-----------|
| 1 | Hit: existing customer found by email | QueryCommand returns `[{ PK: "C#abc123" }]` | Returns `{ customerUlid: "abc123", created: false }`; no PutCommand called |
| 2 | Miss: no existing customer, create succeeds | QueryCommand returns `[]`; PutCommand resolves | Returns `{ customerUlid: "<new>", created: true }`; PutCommand called with `attribute_not_exists(PK)` ConditionExpression; customer record has `first_name: "Jane"`, `last_name: "Doe"` (non-null), `latest_session_id: null` |
| 3 | Race-on-create: PutCommand throws ConditionalCheckFailedException, re-query succeeds | QueryCommand returns `[]` first; PutCommand rejects with `{ name: "ConditionalCheckFailedException" }`; second QueryCommand returns `[{ PK: "C#recovered" }]` | Returns `{ customerUlid: "recovered", created: false }`; QueryCommand called twice |
| 4 | Generic DDB error: QueryCommand throws | QueryCommand rejects with `new Error("DynamoDB unavailable")` | Returns `{ error: <string> }` (the GENERIC_ERROR_STRING) |

Additional edge cases to consider (not required by brief but improve coverage):
- PutCommand throws non-ConditionalCheck error → returns `{ error: GENERIC_ERROR_STRING }`
- Race-on-create where re-query also returns empty → returns `{ error: GENERIC_ERROR_STRING }`

### `src/tools/collect-contact-info.tool.spec.ts` — NEW FILE, 11+ cases

Build module: inject DynamoDBDocumentClient (mocked), DatabaseConfigService, CustomerService (mock — jest.fn() for `lookupOrCreateCustomer`).

| # | Description | Input | DDB Setup | Assertion |
|---|-------------|-------|-----------|-----------|
| 1 | Save firstName only (no email) | `{ firstName: "Jane" }` | UpdateCommand resolves; GetCommands return empty items | Returns `{ saved: true }` (no customerFound); CustomerService NOT called |
| 2 | Save email only — first/last NOT in USER_CONTACT_INFO | `{ email: "j@x.com" }` | GetCommand USER_CONTACT_INFO returns no first_name/last_name | Returns `{ saved: true }` (no customerFound); CustomerService NOT called (trio incomplete — first/last missing) |
| 3 | Save firstName + lastName together, no email yet | `{ firstName: "Jane", lastName: "Doe" }` | GetCommand USER_CONTACT_INFO returns no email | Returns `{ saved: true }` (no customerFound); CustomerService NOT called (trio incomplete — email missing) |
| 4 | Save email when first + last were saved in a prior call (trio completes) — customer HIT | `{ email: "j@x.com" }` | GetCommand USER_CONTACT_INFO returns `{ first_name: "Jane", last_name: "Doe" }`; CustomerService returns `{ customerUlid: "abc", created: false }`; METADATA UpdateCommand resolves | Returns `{ saved: true, customerFound: true }`; CustomerService called with firstName="Jane", lastName="Doe", email="j@x.com"; METADATA UpdateCommand fires with if_not_exists and ":customer_id"="C#abc" |
| 5 | Save email when first + last were saved in a prior call (trio completes) — customer MISS (new) | `{ email: "j@x.com" }` | Same but CustomerService returns `{ customerUlid: "abc", created: true }` | Returns `{ saved: true, customerFound: false }` |
| 6 | Save firstName when email + lastName were saved in prior call (trio completes on firstName-save) | `{ firstName: "Jane" }` | GetCommand USER_CONTACT_INFO returns `{ email: "j@x.com", last_name: "Doe" }`; CustomerService returns `{ customerUlid: "abc", created: false }` | Returns `{ saved: true, customerFound: true }`; CustomerService called |
| 7 | Save lastName when email + firstName were saved in prior call (trio completes on lastName-save) | `{ lastName: "Doe" }` | GetCommand USER_CONTACT_INFO returns `{ email: "j@x.com", first_name: "Jane" }`; CustomerService returns `{ customerUlid: "abc", created: true }` | Returns `{ saved: true, customerFound: false }`; CustomerService called |
| 8 | Save all three in one call (trio completes immediately) | `{ email: "j@x.com", firstName: "Jane", lastName: "Doe" }` | GetCommand USER_CONTACT_INFO returns all three (just written); CustomerService resolves | CustomerService called with correct non-null firstName and lastName; returns `{ saved: true, customerFound: ... }` |
| 9 | Save AGAIN after trio complete and customer_id already set | `{ email: "j@x.com" }` | GetCommand METADATA returns `{ customer_id: "C#abc" }` (already set); GetCommand USER_CONTACT_INFO returns complete trio | Returns `{ saved: true }` (no customerFound); CustomerService NOT called (gate short-circuits on customer_id-already-set); METADATA UpdateCommand NOT called |
| 10 | Save phone only | `{ phone: "555-0100" }` | GetCommand USER_CONTACT_INFO returns no full trio | Returns `{ saved: true }` (no customerFound); CustomerService NOT called |
| 11 | CustomerService.lookupOrCreateCustomer returns error | `{ email: "j@x.com" }` (trio complete) | CustomerService returns `{ error: "..." }` | Returns `{ saved: true }` (no customerFound); METADATA UpdateCommand NOT called; no isError |
| 12 | METADATA UpdateCommand fails (best-effort) | `{ email: "j@x.com" }` (trio complete) | CustomerService returns `{ customerUlid: "abc", created: false }`; METADATA UpdateCommand rejects | Returns `{ saved: true }` (no customerFound); no isError — best-effort degradation |

Additional assertions (can be folded into existing cases or added as separate tests):
- METADATA UpdateCommand uses `if_not_exists(#customer_id` in UpdateExpression
- customer_id written as `C#<ulid>` (`:customer_id` ExpressionAttributeValues === `"C#abc"`)

### `src/tools/preview-cart.tool.spec.ts` — UPDATES

**Test cases needing fixture updates (add `customer_id: "C#${CUSTOMER_ULID}"` to metadata mock):**

- Test 1: "First call happy path" — add `customer_id` to metadata; remove `QueryCommand` and `PutCommand` mock setup
- Test 2: "Second call — METADATA has all 4 IDs" — change customer_id in metadata fixture to `"C#${CUSTOMER_ULID}"` (prefixed); remove QueryCommand mock
- Test 3: "Service with variants" — add `customer_id` to metadata
- Test 4: "Multiple items" — add `customer_id` to metadata
- Test 5: "Unknown service rejected" — remove QueryCommand mock; add `customer_id: "C#${CUSTOMER_ULID}"` to metadata
- Test 6: "Service has variants but no selection" — same as test 5
- Test 9: "DynamoDB error on cart UpdateCommand" — add `customer_id` to metadata
- Test 10: "DynamoDB error on METADATA UpdateCommand" — add `customer_id` to metadata
- Test 11a: "All CartPreviewPayload fields" — add `customer_id` to metadata
- Test 11b: "METADATA UpdateCommand uses if_not_exists on all four ID fields" — add `customer_id` to metadata; remove the assertion that `customer_id` is in the if_not_exists expression (it no longer is)
- Test 12 Slack alert tests (setupHappyPath helper) — add `customer_id` to metadata helper

**Tests needing outright removal:**
- Test 13: "Schema-default — new Customer record includes latest_session_id: null" — OUTRIGHT REMOVE. Customer creation no longer happens in preview_cart. Equivalent coverage is in `customer.service.spec.ts` case #2.

**New test to add:**
```
When: makeMetadataItem() returns no customer_id (the default — do NOT change default)
Expect: result.isError === true
        result.result === "This action requires a customer profile. Please collect the visitor's email first."
        No UpdateCommand called; no BatchGetCommand called
        Logger.error called with event=preview_cart_no_customer_id
```

**Net change count:**
- Tests needing fixture updates: 11 tests
- Tests needing outright removal: 1 test (Test 13)
- New tests to add: 1 test (missing customer_id error)

**Recommend:** Do NOT change the `makeMetadataItem()` default to include `customer_id`. Keep the default as-is (no `customer_id`) and pass `customer_id: "C#${CUSTOMER_ULID}"` explicitly in every test that needs it. This makes the new missing-customer_id error test trivially easy to write with the default helper.

### `src/tools/generate-checkout-link.tool.spec.ts` — UPDATES

**Update existing happy-path fixture:**
- METADATA mock: change `customer_id` from bare ULID (e.g., `"abc123"`) to prefixed (`"C#abc123"`)
- Assert: constructed URL contains `customerId=abc123` (bare ULID)
- Assert: constructed URL does NOT contain `C#` or `C%23`

**New strip-prefix test:**
- METADATA mock returns `customer_id: "C#<ulid>"`
- Assert: the URL parameter is `customerId=<ulid>` (bare)
- Assert: URL does not contain `C#` anywhere in the customerId parameter

---

## Risks and Edge Cases

**HIGH — Race between two parallel `collect_contact_info` calls in the same session that both pass the trio-completion gate.** Both calls read METADATA (customer_id not yet set), both call lookupOrCreateCustomer, both try to write METADATA with if_not_exists. The `lookupOrCreateCustomer` race-recovery handles the customer-create collision (`ConditionalCheckFailedException` → re-query). The METADATA `if_not_exists` handles the customer_id write race — the second call's write is a no-op. At most one Customer record is created. Result is deterministic and correct.

**HIGH — The METADATA UpdateCommand in `preview-cart.tool.spec.ts` (Test 11b) currently asserts that the UpdateExpression contains `if_not_exists(#customer_id`.** This test must be updated to remove that assertion or it will fail after preview-cart.tool.ts is simplified. Explicitly listed in the testing strategy above.

**MEDIUM — Email changed after trio-completion and customer_id already set.** If a visitor changes their email on a subsequent `collect_contact_info` call (after the trio was complete and customer_id was set), the gate short-circuits on `customer_id-already-set`. The new email is saved to USER_CONTACT_INFO but NOT linked to a new or different Customer record. The session remains linked to the original customer. This is intentional — Phase 2a does not redesign the customer record around late email changes. The new email is in USER_CONTACT_INFO but the Customer record reflects values at create time. Future-work item.

**MEDIUM — The `if_not_exists` semantics mean a verify_code-set customer_id from BEFORE the email-save is preserved, even if collect_contact_info's lookup-or-create would resolve a different customer.** This is intended (first-writer-wins), but it means:
- If a visitor verifies with email A, then calls collect_contact_info completing the trio with email B, the METADATA still has customer A's id. The lookup-or-create for email B runs but the if_not_exists write is a no-op.
- The session remains linked to customer A throughout.
- This is correct behavior: the verified trust supersedes the subsequent unverified contact-info save.

**MEDIUM — `account_ulid` may be null/undefined in `collect-contact-info.tool.ts` context.** The `context.accountUlid` field is typed as `string | undefined`. The new trio-completion side-effect calls `lookupOrCreateCustomer` with `context.accountUlid ?? ""`. A blank `accountUlid` means the GSI query uses `ACCOUNT#` as the PK — this will never match a real customer record, effectively always treating the visitor as new. This matches the existing behavior of `verify_code`. For production web-chat sessions, accountUlid is always set. Log a debug warning when accountUlid is absent.

**LOW — `makeCustomerItem` helper in `preview-cart.tool.spec.ts` becomes dead code** after GSI-query mocks are removed (it was used to set up QueryCommand returns in tests that exercised resolveCustomerUlid paths). Delete this helper from the spec file to avoid dead code.

**LOW — `GuestCartCustomerResult` type in `src/types/GuestCart.ts`** is used only by `preview-cart.tool.ts`'s `resolveCustomerUlid`. After removal, it becomes unused. Do NOT delete it — the brief does not require this type to be removed, and its removal could cause unintended churn if any external reference exists. Leave it in place; it becomes dead type documentation.

---

## Out-of-Scope Confirmations

The following items are explicitly NOT part of Phase CCI-2a:

- Updates to `lead_capture` or `shopping_assistant` system prompts — Phase 2b
- Prior-history context loader — Phase 2b
- Agent acting on `customerFound` signal — Phase 2b
- Customer profile loading into agent context — Phase 2b
- Phone GSI for phone-keyed lookup — future work
- Back-updating Customer record's first/last/phone on subsequent collect_contact_info calls — explicit decision: USER_CONTACT_INFO is the current values, Customer record reflects values at create time
- Cross-account customer linking — per-account isolation invariant is non-negotiable
- SendGrid Inbound Parse webhook changes — Phase 3
- `/chat/web/*` changes — out of scope
- Any refactor of existing TS variable names (`sessionUlid`, etc.) — naming convention applies forward only
- Tool-level validation that errors when downstream tools fire without complete first/last/email — Phase 4
- Any new Slack alert — no PII in Slack; customer creation is not a celebration event
- Discord agent changes
- Phase CCI-1's TTL enablement open question — separate from Phase 2a
- Loosening `GuestCartCustomerRecord.first_name` or `.last_name` to `string | null` — NOT needed; the trio-completion gate guarantees non-null, non-empty values at Customer create time

---

## Pre-Implementation Checklist (for orchestrator before dispatching code-implementer)

All design questions are now resolved. No orchestrator approvals are required before dispatching:

1. **`GuestCartCustomerRecord.first_name` and `.last_name` stay non-nullable `string`.** The trio-completion gate (not the type system) enforces this. No type change in `src/types/GuestCart.ts`. This is confirmed by the new brief.

2. **`generate-checkout-link.tool.ts` strip-prefix is in scope.** The one-line `customerUlid` variable + URL template change at line 167 is part of Phase 2a. The test additions in `generate-checkout-link.tool.spec.ts` are also in scope.

3. **No other open questions.** All decisions (trio-completion gate timing, signature nullability, if_not_exists rationale, best-effort error handling, preview_cart hard-require, generate-checkout-link URL contract) are locked in this plan. Implementation can proceed.
