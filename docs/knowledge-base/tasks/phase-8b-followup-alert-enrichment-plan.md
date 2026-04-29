# Phase 8b-followup — Slack Alert Enrichment with Cart Details: Implementation Plan

---

## Overview

This phase enriches two of the three existing Slack business-signal alerts — `cart_created` and `checkout_link_generated` — with a guest cart ID and a per-item breakdown so the team has actionable business context without leaving the channel. Both call sites already have the required data in scope: `PreviewCartTool.execute()` constructs `cartItems` and `cartUlid` before the alert fires; `GenerateCheckoutLinkTool.execute()` reads the METADATA record (which contains `cart_id`) in Step 3, well before the alert fires in Step 7. No new DynamoDB reads are introduced. The only new files are one type addition (`CartItemAlertEntry` in `src/types/Slack.ts`) and the updated spec tests; all other changes are modifications to four existing files (`slack-alert.service.ts`, `slack-alert.service.spec.ts`, `preview-cart.tool.ts`, `generate-checkout-link.tool.ts`) and one supporting types file. The `conversation_started` alert and its tests are byte-for-byte unchanged.

---

## Affected Files and Modules

### Modify

| File | Change |
|------|--------|
| `src/types/Slack.ts` | Add `CartItemAlertEntry` type; extend `SlackAlertCartCreatedInput` and `SlackAlertCheckoutLinkGeneratedInput` with `guestCartId` and `items` fields |
| `src/services/slack-alert.service.ts` | Add `formatCentsAsUsd` private method; update `notifyCartCreated` and `notifyCheckoutLinkGenerated` destructuring and block-builder calls; update `buildCartCreatedBlocks` and `buildCheckoutLinkBlocks` signatures and bodies to render the items list and cart ID |
| `src/services/slack-alert.service.spec.ts` | Update existing `notifyCartCreated` and `notifyCheckoutLinkGenerated` test fixtures to include `guestCartId` and `items`; add new test groups for items rendering, cart ID rendering, and `formatCentsAsUsd` |
| `src/tools/preview-cart.tool.ts` | Update the `notifyCartCreated` call at Step 12 to include `guestCartId: cartUlid` and `items` (mapped from `cartItems`) |
| `src/tools/generate-checkout-link.tool.ts` | Update the `notifyCheckoutLinkGenerated` call at Step 7 to include `guestCartId: cart_id` and `items` (cart items loaded from the cart record — see threading mechanism below) |

### Review Only (no change)

| File | Reason |
|------|--------|
| `src/controllers/web-chat.controller.ts` | `notifyConversationStarted` is unchanged; no touch required |
| `src/services/slack-alert-config.service.ts` | No change to webhook config |
| `src/config/env.schema.ts` | No new env vars |
| `src/config/configuration.ts` | No new config namespaces |
| `src/app.module.ts` | No new providers or imports |

---

## Critical Pre-Analysis Findings

### Finding 1 — `guestCartId` field mapping (confirmed)

In `PreviewCartTool`, the cart ULID is `cartUlid` (a raw 26-char ULID without any prefix, generated at Step 8 or reused from METADATA). The payload returned to the agent is `{ cart_id: cartUlid, ... }`. The `guestCartId` in the alert is this same `cartUlid` — the raw ULID with no `G#` or `C#` prefix. The SK of the cart record in DDB is `G#${guestUlid}C#${cartUlid}`, but the cart ID to surface in the alert is only `cartUlid`.

In `GenerateCheckoutLinkTool`, `cart_id` is read from METADATA at Step 3 (`metadataResult.Item.cart_id`) and stored as the local variable `cart_id` (type `string | undefined`). After the guard at line 108, `cart_id` is guaranteed to be a non-empty string. This is the `guestCartId` to pass to the alert — no prefix stripping required (METADATA stores the raw ULID, not the `G#...C#...` SK).

### Finding 2 — Items data at the `GenerateCheckoutLinkTool` call site (critical: new DDB read required)

**This is the most important finding in the plan.** The `GenerateCheckoutLinkTool` METADATA read (Step 3) only retrieves: `cart_id`, `guest_id`, `customer_id`, `customer_email`. The actual cart items (`cart_items` array) are stored on the **cart record** at `PK = A#<accountUlid>`, `SK = G#<guestUlid>C#<cartUlid>` — not on the METADATA record. The brief states "no new DDB reads," but the tool does not currently load the cart record; it only reads METADATA. Therefore:

**The items data is NOT already in memory at the `GenerateCheckoutLinkTool` call site.**

**Recommended resolution (two options — orchestrator must choose one before approval):**

**Option A (recommended) — Pass items from the agent tool result, not from DDB.** Since `GenerateCheckoutLinkTool` fires after `PreviewCartTool` has already returned a confirmed cart preview to the agent, the orchestrator or agent session does not maintain shared in-memory state between tool calls. Tools are stateless NestJS providers — there is no shared in-memory session state. This option is not viable as written.

**Option B — Add a single cart record GetCommand inside `GenerateCheckoutLinkTool` (technically a new DDB read).** After the existing METADATA read succeeds and `cart_id` and `guest_id` are known, add one `GetCommand` to fetch the cart record at `PK = A#<accountUlid>`, `SK = G#<guest_id>C#<cart_id>`. Read `cart_items` from the result. This is a single extra read and is idiomatic in this codebase. The brief says "the tool already loads the cart to generate the URL" — this appears to be an inaccurate assumption in the brief. The tool does **not** load the cart record; it loads METADATA only. The arch-planner flags this as a discrepancy.

**Option C — Omit items from the checkout_link_generated alert, include only `guestCartId`.** This would mean partially enriching only `notifyCheckoutLinkGenerated` (adding `guestCartId` but not `items`). The brief's locked contract includes `items` on this method. This violates the locked contract.

**Option D — Accept the brief's intent and add the cart record read, treating it as an implicit step already present in the design.** The brief says "no new DDB reads added" as a constraint, but the design assumption behind that constraint is wrong. The cleanest solution that delivers the full locked contract without a PII-unsafe workaround is Option B.

**Recommendation: Option B.** Add a single `GetCommand` for the cart record in `GenerateCheckoutLinkTool` after the METADATA guard passes. The cart record get uses `PK = A#<accountUlid>`, `SK = G#${guest_id}C#${cart_id}`. If the cart record is missing or its `cart_items` is empty, fall back to `items: []` in the alert (do not error — the checkout URL can still be generated). This matches the fire-and-forget design philosophy of the alerts. The implementer must add this read, document it with a comment, and add a mock in the tool spec to prevent a real DDB call.

### Finding 3 — `GuestCartItem.price` and `.total` are in cents (confirmed)

The `GuestCartItem` type comment at `src/types/GuestCart.ts` line 5: `price: number; // cents` and line 8: `total: number; // price * quantity, cents`. The `makeServiceItem` fixture in the spec uses `price: 10000` (= $100.00 in cents). The `formatCentsAsUsd` helper divides by 100. The `subtotalCents` in `CartItemAlertEntry` maps directly from `cartItem.total` (no multiplication required).

### Finding 4 — `items` field extraction at `PreviewCartTool`

At Step 12, after `cartItems` is built and totals are computed, the following fields are available on each `GuestCartItem`:
- `name: string` — maps to `CartItemAlertEntry.name`
- `quantity: number` — maps to `CartItemAlertEntry.quantity`
- `total: number` — in cents; maps to `CartItemAlertEntry.subtotalCents`

The mapping expression at the call site:
```typescript
items: cartItems.map((cartItem) => ({
  name: cartItem.name,
  quantity: cartItem.quantity,
  subtotalCents: cartItem.total,
})),
```

### Finding 5 — `items` field extraction at `GenerateCheckoutLinkTool` (Option B)

After the new cart record GetCommand, `cartRecordItem.cart_items` contains `GuestCartItem[]`. The mapping is identical to PreviewCartTool:
```typescript
const rawItems = Array.isArray(cartRecordItem?.cart_items) ? cartRecordItem.cart_items : [];
const alertItems = rawItems.map((ci: GuestCartItem) => ({
  name: String(ci.name ?? ""),
  quantity: Number(ci.quantity ?? 0),
  subtotalCents: Number(ci.total ?? 0),
}));
```

### Finding 6 — Existing `buildCheckoutLinkBlocks` uses `section` with mrkdwn link (not `actions` block)

The actual implementation in `slack-alert.service.ts` (line 200-228) already uses a `section` block with `text: { type: "mrkdwn", text: "<${checkoutUrl}|Open checkout>" }` — not the `actions` block that the Phase 8b plan originally proposed. This is the correct pattern (avoids interactive callback issues). The enriched `checkout_link_generated` alert should keep this pattern and add items rendering alongside it.

---

## Slack Block JSON Design

### Design Decisions

**Bullet-list format:** Slack mrkdwn does not have a native list syntax. The `•` character followed by text and `\n` line breaks inside a single `section` block `text` field renders as a visual bullet list in the Slack client. This is the correct approach — confirmed by Slack's own documentation ("There's no specific list syntax in app-published text, but you can mimic list formatting with regular text and line breaks"). The `•` is a Unicode character (U+2022), not a Slack control character, so it requires no escaping.

**Single section block for the body:** The section block `text` field supports up to 3000 characters. A cart with 20 items (the maximum per the tool's `inputSchema.maxItems`) at long names (~50 chars each) would use approximately `20 × (2 + 50 + 4 + 8 + 4 + 8) = 1520` characters — safely under the 3000-char limit. No truncation strategy is needed for the expected cart size, but see the edge-case truncation note below.

**Block layout for enriched alerts:** Use two section blocks: one for the IDs (Account, Session, Cart — as an mrkdwn text body, not a fields array, because the existing fields-array pattern renders 2 columns and a Cart ID field would be orphaned) plus one for the items list and total. For `checkout_link_generated`, a third section block renders the mrkdwn link (preserving the existing pattern).

**ID block choice — switch from fields array to mrkdwn text:** The current Phase 8b implementation uses a `fields` array for the ID section (renders as a 2-column grid). Adding `guestCartId` would result in 3 label fields and 3 value fields (6 total), which renders awkwardly in the 2-column grid (the 6th field wraps to a 3rd row but is left-aligned alone). Switching the IDs section to a single `section` block with an mrkdwn text body renders more cleanly and is already consistent with the checkout-link section. However, to minimize diff surface, **keep the fields array for the IDs section** and add the `guestCartId` as two additional fields (a label field `"*Cart ID*"` and a value field). Six fields in the grid renders as three rows of two — this is clean. Add `guestCartId` as the third label/value pair.

**mrkdwn escape behavior for item names:** Per Slack's documentation, only `&`, `<`, and `>` require escaping in mrkdwn (`&amp;`, `&lt;`, `&gt;`). Characters `*` and `_` are formatting characters but do not need escaping inside `plain_text` contexts — however, since the items list renders inside a `mrkdwn` text field, an item name containing `*` or `_` would be bold/italic. The implementer must apply a minimal escape function to each item name that replaces `&` → `&amp;`, `<` → `&lt;`, `>` → `&gt;` before inserting into the mrkdwn string. The `*` and `_` characters in item names are unlikely in a pet-services catalog (no service is named `*Deluxe*`), but for correctness escape them too: `*` → no-op (acceptable for v1 since it's low-risk catalog data) or `\*` if the implementer wants belt-and-suspenders. **Recommendation for v1:** escape only `&`, `<`, `>` (the three Slack control characters). Document this as the decision in a code comment. Item names with `*` or `_` would render as bold/italic but the data would still be correct.

### Exact Block JSON — `cart_created` (enriched)

The existing block JSON structure is reproduced from `buildCartCreatedBlocks`. The enrichment adds: `guestCartId` in the fields array, and a new section block for the items list.

```json
[
  {
    "type": "header",
    "text": {
      "type": "plain_text",
      "text": "🛒 Cart created by AI agent"
    }
  },
  {
    "type": "section",
    "fields": [
      { "type": "mrkdwn", "text": "*Account ID*" },
      { "type": "mrkdwn", "text": "*Session ID*" },
      { "type": "plain_text", "text": "<accountId>" },
      { "type": "plain_text", "text": "<sessionUlid>" },
      { "type": "mrkdwn", "text": "*Cart ID*" },
      { "type": "mrkdwn", "text": "*Items*" },
      { "type": "plain_text", "text": "<guestCartId>" },
      { "type": "plain_text", "text": "<itemCount>" }
    ]
  },
  {
    "type": "section",
    "text": {
      "type": "mrkdwn",
      "text": "• <qty>× <name> — $<subtotal>\n• <qty>× <name> — $<subtotal>\n*Total: $<cartTotal>*"
    }
  },
  {
    "type": "divider"
  }
]
```

Note: The items section `text` body is constructed by the `buildCartCreatedBlocks` helper by mapping over the `items` array, joining with `\n`, then appending `\n*Total: $<cartTotal>*`.

### Exact Block JSON — `checkout_link_generated` (enriched)

```json
[
  {
    "type": "header",
    "text": {
      "type": "plain_text",
      "text": "🔗 Checkout link generated"
    }
  },
  {
    "type": "section",
    "fields": [
      { "type": "mrkdwn", "text": "*Account ID*" },
      { "type": "mrkdwn", "text": "*Session ID*" },
      { "type": "plain_text", "text": "<accountId>" },
      { "type": "plain_text", "text": "<sessionUlid>" },
      { "type": "mrkdwn", "text": "*Cart ID*" },
      { "type": "mrkdwn", "text": "" },
      { "type": "plain_text", "text": "<guestCartId>" },
      { "type": "plain_text", "text": "" }
    ]
  },
  {
    "type": "section",
    "text": {
      "type": "mrkdwn",
      "text": "• <qty>× <name> — $<subtotal>\n• <qty>× <name> — $<subtotal>\n*Total: $<cartTotal>*"
    }
  },
  {
    "type": "section",
    "text": {
      "type": "mrkdwn",
      "text": "<checkoutUrl|Open checkout>"
    }
  },
  {
    "type": "divider"
  }
]
```

Note on the empty fields in the checkout_link IDs block: The fields array for `checkout_link_generated` only has Account ID and Session ID as meaningful rows (3 label+value pairs would need a 6-field array). Since there's only one extra ID (`guestCartId`) with no clean pair, use the approach of adding a `*Cart ID*` label + empty placeholder in column 2 (`""`), then `guestCartId` value + empty value. This renders as a 3-row grid: row 1 has Account + Session, row 2 has Cart ID label + empty, row 3 has Cart ID value + empty. This is not ideal visually.

**Revised recommendation for `checkout_link_generated` IDs block:** Use `mrkdwn` `text` instead of `fields` for the IDs on the checkout_link alert, since it already uses the `text` pattern for the checkout URL section. This is more readable:

```json
{
  "type": "section",
  "text": {
    "type": "mrkdwn",
    "text": "*Account:* <accountId>\n*Session:* <sessionUlid>\n*Cart:* <guestCartId>"
  }
}
```

And for `cart_created`, continue using the existing `fields` array but add the `guestCartId` and keep `itemCount` as the 4th column-2 entry (Account/Session/CartID as three rows, Items as the 4th with no pair — or drop `itemCount` from the fields since the items list in the next section makes it redundant).

**Final decision on block layout** (implementer follows this exactly):

For `cart_created`:
1. `header` block — unchanged
2. `section` with `fields` array containing 6 items: `[*Account ID*, *Session ID*, <accountId>, <sessionUlid>, *Cart ID*, <guestCartId>]` — the existing `*Items*` / `<itemCount>` fields are **removed** because the next block renders the full item list (making itemCount redundant)
3. `section` with mrkdwn `text` containing the per-item bullet lines + total
4. `divider`

For `checkout_link_generated`:
1. `header` block — unchanged
2. `section` with mrkdwn `text`: `"*Account:* <accountId>\n*Session:* <sessionUlid>\n*Cart:* <guestCartId>"`
3. `section` with mrkdwn `text` containing the per-item bullet lines + total
4. `section` with mrkdwn `text`: `"<checkoutUrl|Open checkout>"` — unchanged from existing implementation
5. `divider`

This is clean, avoids orphaned fields, and is the most readable layout in Slack.

---

## `SlackAlertService` Design Changes

### Updated types in `src/types/Slack.ts`

Add `CartItemAlertEntry`:

```typescript
export interface CartItemAlertEntry {
  name: string;
  quantity: number;
  subtotalCents: number;
}
```

Extend `SlackAlertCartCreatedInput`:

```typescript
export interface SlackAlertCartCreatedInput {
  accountId: string;
  sessionUlid: string;
  guestCartId: string;
  cartTotalCents: number;
  itemCount: number;
  items: readonly CartItemAlertEntry[];
}
```

Extend `SlackAlertCheckoutLinkGeneratedInput`:

```typescript
export interface SlackAlertCheckoutLinkGeneratedInput {
  accountId: string;
  sessionUlid: string;
  guestCartId: string;
  cartTotalCents: number;
  items: readonly CartItemAlertEntry[];
  checkoutUrl: string;
}
```

Note: `itemCount` is retained in `SlackAlertCartCreatedInput` for backward compatibility with the existing call in `notifyCartCreated`, even though it is no longer displayed in the block (the items list renders it implicitly). The implementer may remove it from the type and the call site if the brief confirms it is no longer needed — however, since it was in the original locked contract type, it is retained here.

### `formatCentsAsUsd` helper — location and shape

**Location:** Private method on `SlackAlertService`. Rationale: it is a display-layer concern scoped to Slack message rendering. Making it a module-scope unexported helper function would be equally valid, but the existing Phase 8b implementation already puts the formatting logic inline in `buildCartCreatedBlocks` (`const formattedTotal = \`$${(cartTotalCents / 100).toFixed(2)}\``). Extract this inline expression into a private method so it is testable by calling it indirectly through the block-builder output.

**Shape:**

```typescript
private formatCentsAsUsd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}
```

This replaces the current inline `(cartTotalCents / 100).toFixed(2)` expression in `buildCartCreatedBlocks`.

**Test coverage:** The spec tests `formatCentsAsUsd` indirectly by asserting the formatted string in the block JSON output. Add explicit cases: `0` → `"$0.00"`, `100` → `"$1.00"`, `1234` → `"$12.34"`, `100000` → `"$1000.00"`. Since `formatCentsAsUsd` is private, test it via the `notifyCartCreated` block output (parse the body, find the items section text, assert formatting). Alternatively, the implementer can expose it as a package-internal method for direct unit testing — but the private approach is preferred for encapsulation.

### `escapeSlackMrkdwn` helper

**Location:** Module-scope unexported function in `slack-alert.service.ts`. Not a private method because it is a pure string utility with no dependency on service state.

**Shape:**

```typescript
function escapeSlackMrkdwn(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
```

Applied to each `item.name` when building the items bullet string.

### Updated `buildCartCreatedBlocks` signature and body

Updated signature:

```typescript
private buildCartCreatedBlocks(
  accountId: string,
  sessionUlid: string,
  guestCartId: string,
  cartTotalCents: number,
  items: readonly CartItemAlertEntry[],
): SlackAlertBlock[]
```

Updated body constructs the items text:

```typescript
const itemsText = items
  .map((item) => `• ${item.quantity}× ${escapeSlackMrkdwn(item.name)} — ${this.formatCentsAsUsd(item.subtotalCents)}`)
  .join("\n")
  .concat(`\n*Total: ${this.formatCentsAsUsd(cartTotalCents)}*`);
```

Block array per the Final Decision above (header, fields with 6 items, items section, divider).

### Updated `buildCheckoutLinkBlocks` signature and body

Updated signature:

```typescript
private buildCheckoutLinkBlocks(
  accountId: string,
  sessionUlid: string,
  guestCartId: string,
  cartTotalCents: number,
  items: readonly CartItemAlertEntry[],
  checkoutUrl: string,
): SlackAlertBlock[]
```

Block array per the Final Decision above (header, mrkdwn IDs section, items section, mrkdwn checkout link section, divider).

### Updated `notifyCartCreated` destructuring

```typescript
const { accountId, sessionUlid, guestCartId, cartTotalCents, itemCount, items } = input;
// Pass guestCartId and items to the block builder
this.buildCartCreatedBlocks(accountId, sessionUlid, guestCartId, cartTotalCents, items)
```

### Updated `notifyCheckoutLinkGenerated` destructuring

```typescript
const { accountId, sessionUlid, guestCartId, cartTotalCents, items, checkoutUrl } = input;
this.buildCheckoutLinkBlocks(accountId, sessionUlid, guestCartId, cartTotalCents, items, checkoutUrl)
```

---

## `PreviewCartTool` Changes

### Field extraction and updated call (Step 12, line ~515)

The existing call at Step 12 is:

```typescript
if (itemCount > 0) {
  this.slackAlertService.notifyCartCreated({
    accountId: accountUlid,
    sessionUlid,
    cartTotalCents: cartTotal,
    itemCount,
  }).catch(() => undefined);
}
```

Replace with:

```typescript
if (itemCount > 0) {
  this.slackAlertService.notifyCartCreated({
    accountId: accountUlid,
    sessionUlid,
    guestCartId: cartUlid,
    cartTotalCents: cartTotal,
    itemCount,
    items: cartItems.map((cartItem) => ({
      name: cartItem.name,
      quantity: cartItem.quantity,
      subtotalCents: cartItem.total,
    })),
  }).catch(() => undefined);
}
```

**Field sources (all available at this point in the code, no new reads):**
- `cartUlid` — set at Step 8 (line ~401), in scope at Step 12
- `cartTotal` — computed at line 503 (already cents per the GuestCart contract)
- `cartItems` — array of `GuestCartItem`, built at Step 7; `name`, `quantity`, and `total` are all populated fields
- `subtotalCents: cartItem.total` — `GuestCartItem.total` is `price * quantity` in cents (per type comment)

No new imports required.

---

## `GenerateCheckoutLinkTool` Changes

### Threading mechanism (Option B — new cart record GetCommand)

The METADATA read (Step 3) provides `cart_id` and `guest_id`. After the guard at line 108 (`if (!cart_id || !guest_id || !customer_id || !customer_email)`), add Step 5b: fetch the cart record to extract `cart_items`.

**Insert after line 108 (the guard), before Step 5 (resolveCheckoutBase):**

```typescript
// Step 5b — load cart items for Slack alert (no business-logic dependency)
let alertItems: CartItemAlertEntry[] = [];

try {
  const cartSk = `G#${guest_id}C#${cart_id}`;
  const cartResult = await this.dynamoDb.send(
    new GetCommand({
      TableName: tableName,
      Key: {
        PK: `A#${accountUlid}`,
        SK: cartSk,
      },
    }),
  );

  const rawItems = Array.isArray(cartResult.Item?.cart_items) ? cartResult.Item.cart_items : [];
  alertItems = rawItems.map((ci: GuestCartItem) => ({
    name: String(ci.name ?? ""),
    quantity: Number(ci.quantity ?? 0),
    subtotalCents: Number(ci.total ?? 0),
  }));
} catch {
  // Cart items fetch failure is non-fatal — alert fires with empty items list
  this.logger.debug(
    `[action=generate_checkout_link_alert_items_fetch_failed sessionUlid=${sessionUlid}]`,
  );
}
```

**Updated alert call (Step 7, replacing the current call at line 126):**

```typescript
// Step 7 — fire Slack alert
const cartTotal = alertItems.reduce((sum, item) => sum + item.subtotalCents, 0);
this.slackAlertService.notifyCheckoutLinkGenerated({
  accountId: accountUlid,
  sessionUlid,
  guestCartId: cart_id,
  cartTotalCents: cartTotal,
  items: alertItems,
  checkoutUrl: checkout_url,
}).catch(() => undefined);
```

**Imports to add:**

```typescript
import { GuestCartItem, CartItemAlertEntry } from "../types/GuestCart";
```

Wait — `CartItemAlertEntry` is defined in `src/types/Slack.ts`, not `GuestCart.ts`. The import would be:

```typescript
import { GuestCartItem } from "../types/GuestCart";
import { CartItemAlertEntry } from "../types/Slack";
```

But note: the `alertItems` mapping uses `GuestCartItem` type as a casting hint for the raw DynamoDB array. The `CartItemAlertEntry` type annotation on `alertItems` is inferred from the map return — the explicit `CartItemAlertEntry[]` annotation is needed on the `let alertItems` declaration.

**Spec impact — mock the new GetCommand:**

In `generate-checkout-link.tool.spec.ts`, the `ddbMock.on(GetCommand)` pattern already catches all GetCommand calls. The happy-path test (`describe("1. Happy path...")`) must be updated to add a second `GetCommand` mock for the cart record:

```typescript
ddbMock
  .on(GetCommand, { Key: { PK: `CHAT_SESSION#${SESSION_ULID}`, SK: "METADATA" } })
  .resolves({ Item: makeMetadataItem() });
ddbMock
  .on(GetCommand, { Key: { PK: `A#${ACCOUNT_ULID}`, SK: `G#${GUEST_ULID}C#${CART_ULID}` } })
  .resolves({ Item: makeCartItem() });
```

A new `makeCartItem()` fixture must be added to the spec.

**Verify NO new DDB read from the tool's critical path:** The cart record read is wrapped in a `try/catch` with a no-op catch — if the read fails, `alertItems` is `[]` and the tool continues. The checkout URL generation (Steps 5 and 6) is unaffected. The test must verify that the tool still returns a valid checkout URL even when the cart record GetCommand throws.

---

## Step-by-Step Implementation Sequence

```
1. [File: src/types/Slack.ts]
   Add `CartItemAlertEntry` interface; extend `SlackAlertCartCreatedInput` and
   `SlackAlertCheckoutLinkGeneratedInput` with `guestCartId` and `items`.
   - Why first: downstream service and call-site files depend on these types. TypeScript
     will fail to compile until the types exist.
   - Done when: `npm run build` compiles without errors on this file alone.

2. [File: src/services/slack-alert.service.ts]
   a. Add module-scope `escapeSlackMrkdwn` function.
   b. Add `private formatCentsAsUsd(cents: number): string` method.
   c. Update `buildCartCreatedBlocks` signature and block array per the Final Decision.
   d. Update `buildCheckoutLinkBlocks` signature and block array per the Final Decision.
   e. Update `notifyCartCreated` and `notifyCheckoutLinkGenerated` destructuring to
      include `guestCartId` and `items`, and update the block-builder calls.
   - Why here: depends on types from Step 1; no other files need to change first.
   - Done when: `npm run build` passes; the two enriched method signatures accept the
     new fields and the block-builder helpers include the items section.

3. [File: src/tools/preview-cart.tool.ts]
   Update the `notifyCartCreated` call at Step 12 to include `guestCartId: cartUlid`
   and the `items` array mapped from `cartItems`.
   - Why here: depends on the updated service type from Step 1 (TypeScript will error on
     the old call shape).
   - Done when: `npm run build` passes; the call includes the new fields.

4. [File: src/tools/generate-checkout-link.tool.ts]
   a. Add `GuestCartItem` import from `../types/GuestCart` and `CartItemAlertEntry`
      import from `../types/Slack`.
   b. Add the cart record GetCommand (Step 5b) and `alertItems` mapping.
   c. Update the `notifyCheckoutLinkGenerated` call to include `guestCartId: cart_id`,
      `cartTotalCents: cartTotal`, and `items: alertItems`.
   - Why here: depends on the updated service type from Step 1.
   - Done when: `npm run build` passes; the tool fetches cart items and passes them to
     the alert.

5. [File: src/services/slack-alert.service.spec.ts]
   a. Update existing `notifyCartCreated` test fixtures to include `guestCartId` and
      `items`.
   b. Update existing `notifyCheckoutLinkGenerated` test fixtures similarly.
   c. Add test group: "cart created — items rendering" (see Testing Strategy).
   d. Add test group: "checkout link generated — items rendering".
   e. Add test group: "formatCentsAsUsd — currency formatting".
   - Why here: depends on Step 2 (the new service behavior).
   - Done when: `npm test` passes for this spec file with all new test cases.

6. [File: src/tools/preview-cart.tool.spec.ts]
   Update the existing Slack alert assertion to verify `guestCartId` and `items` fields
   are passed to `notifyCartCreated`.
   - Why here: depends on Step 3.
   - Done when: the updated assertion passes.

7. [File: src/tools/generate-checkout-link.tool.spec.ts]
   a. Add `makeCartItem()` fixture function.
   b. Update the happy-path test to mock the new cart record GetCommand.
   c. Add test: "Slack alert fires with guestCartId and items when cart record is
      present".
   d. Add test: "Slack alert fires with empty items when cart record GetCommand throws
      (non-fatal)".
   e. Verify DDB mock call count: the tool now makes 2 GetCommand calls in the happy
      path (METADATA + cart record) — assert this in the happy-path test.
   - Why here: depends on Step 4.
   - Done when: all new and existing tests pass.

8. Run `npm run build` and `npm test`
   - Done when: build clean, all tests pass; test count increases by 8–12 from the
     baseline of 482.
```

---

## Testing Strategy

### `SlackAlertService` spec updates and additions

**Update existing fixtures** — every call to `notifyCartCreated` and `notifyCheckoutLinkGenerated` in the spec must add `guestCartId` and `items`. Suggested fixture constant:

```typescript
const CART_ID = "01CARTULID0000000000000000";
const SAMPLE_ITEMS: CartItemAlertEntry[] = [
  { name: "Dog Walking", quantity: 2, subtotalCents: 8000 },
  { name: "Bath & Groom", quantity: 1, subtotalCents: 6000 },
];
```

**New test group: "cart created — items rendering"**

- Items list renders in the body text: assert that the mrkdwn text in the items section block contains `• 2× Dog Walking — $80.00` and `• 1× Bath & Groom — $60.00`
- Cart ID appears in the blocks
- Total is formatted correctly: assert `*Total: $140.00*` appears in the items section text
- Single item renders without a trailing `\n` artifact
- Empty items array renders only the total line (no bullets): `*Total: $0.00*`

**New test group: "checkout link generated — items rendering"**

- Items list and Cart ID render similarly to `cart_created`
- Cart total renders from the `cartTotalCents` field
- `checkoutUrl` appears as an mrkdwn link

**New test group: "formatCentsAsUsd — currency formatting" (via block output)**

Test via `notifyCartCreated` with specific `cartTotalCents` values; parse the block body and assert the total line:

| `cartTotalCents` | Expected total line |
|---|---|
| `0` | `*Total: $0.00*` |
| `100` | `*Total: $1.00*` |
| `1234` | `*Total: $12.34*` |
| `100000` | `*Total: $1000.00*` |

**New test: "escapeSlackMrkdwn — item names with Slack control characters"**

Pass an item with `name: "Bath & Groom <VIP>"`. Assert the block body contains `Bath &amp; Groom &lt;VIP&gt;`.

### `PreviewCartTool` spec additions

In the existing happy-path test (`describe("1. First call happy path...")`), add assertions after `tool.execute()` returns:

```typescript
expect(mockSlackAlertService.notifyCartCreated).toHaveBeenCalledWith(
  expect.objectContaining({
    guestCartId: CART_ULID,
    items: expect.arrayContaining([
      expect.objectContaining({ name: "Test Service", quantity: 1, subtotalCents: 10000 }),
    ]),
  }),
);
```

The service price in `makeServiceItem` is `10000` (cents). One item with quantity 1 → `subtotalCents = 10000 * 1 = 10000`.

### `GenerateCheckoutLinkTool` spec additions

**Add `makeCartItem` fixture:**

```typescript
function makeCartItem(): Record<string, unknown> {
  return {
    PK: `A#${ACCOUNT_ULID}`,
    SK: `G#${GUEST_ULID}C#${CART_ULID}`,
    cart_items: [
      { name: "Dog Walking", quantity: 2, total: 8000, price: 4000, category: "walking",
        image_url: "", service_id: "S#01", variant: null, variant_label: null },
    ],
    _createdAt_: "2024-01-01T00:00:00.000Z",
    _lastUpdated_: "2024-01-01T00:00:00.000Z",
  };
}
```

**Update happy-path test:** Mock both GetCommand calls. Assert the checkout URL is returned. Assert `mockSlackAlertService.notifyCheckoutLinkGenerated` is called with `guestCartId: CART_ULID` and `items` containing the mapped cart item.

**Add test: "cart record fetch failure is non-fatal":** Mock the METADATA GetCommand to resolve; mock the cart record GetCommand to reject with a `new Error("DDB error")`. Assert: (1) the tool still returns a valid checkout URL; (2) `notifyCheckoutLinkGenerated` is called with `items: []`.

**Verify DDB call count:** In the happy-path test, assert `ddbMock.calls()` length is 2 (METADATA + cart record). This is the explicit DDB-read audit the code reviewer will check.

### Unchanged tests

All tests for `notifyConversationStarted`, `SlackAlertConfigService`, and `WebChatController` are byte-for-byte unchanged.

---

## Risks and Edge Cases

### HIGH: `GenerateCheckoutLinkTool` does not already have cart items in memory

As documented in Finding 2, the brief's assertion that "the tool already loads the cart to generate the URL" is incorrect. The tool loads only METADATA. A new `GetCommand` is required. **The orchestrator must approve Option B before implementation begins.** If the user wants to avoid any new DDB read even in the alert path, the only alternative is to omit `items` from `notifyCheckoutLinkGenerated` — but this violates the locked contract.

**Mitigation:** Option B as described above. The read is non-fatal (wrapped in try/catch), so it cannot break checkout URL generation.

### HIGH: `GuestCartItem` cast from raw DynamoDB `NativeAttributeValue`

In the cart record GetCommand result, `cart_items` is stored as a DynamoDB `NativeAttributeValue[]`. The mapping code uses `String(ci.name ?? "")` and `Number(ci.total ?? 0)` to safely coerce values. Do not cast directly to `GuestCartItem[]` without the defensive coercions — a malformed record in DDB would cause a silent `NaN` subtotal rather than a runtime error.

**Mitigation:** Use the explicit defensive coercion pattern shown in the `alertItems` mapping code above.

### MEDIUM: Slack section text length for large carts

Maximum cart size is 20 items (enforced by `inputSchema.maxItems`). Worst-case text length with 50-char item names: `20 × (2 + 50 + 4 + 8 + 4 + 8) = 1520` characters — well under the 3000-char limit. No truncation needed. However, if the `maxItems` constraint is ever raised, revisit this calculation.

**Mitigation:** Add a single comment in `buildCartCreatedBlocks` noting the character budget assumption.

### MEDIUM: `cartTotalCents` in `notifyCheckoutLinkGenerated` is derived from `alertItems`, not from the service input

In the current locked contract, `SlackAlertCheckoutLinkGeneratedInput` includes `cartTotalCents`. In the `GenerateCheckoutLinkTool`, the cart total is not available directly — it must be summed from `alertItems.reduce((sum, item) => sum + item.subtotalCents, 0)`. If the cart record fetch fails and `alertItems` is `[]`, the alert will show `Total: $0.00`. This is acceptable for a fire-and-forget alert (the operator can look up the actual cart in DDB using `guestCartId`). Document in a comment.

### MEDIUM: Item name escaping scope

The `escapeSlackMrkdwn` function escapes `&`, `<`, `>`. Characters `*` and `_` in item names will render as Slack formatting (bold, italic). In a pet-services catalog, these characters are extremely unlikely in service names. If needed in a future iteration, extend the escape function to replace `*` → `\*` and `_` → `\_`.

### LOW: `itemCount` field retained in `SlackAlertCartCreatedInput` but not displayed

The `itemCount` field remains in the type for backward compatibility. The block builder now renders the items list instead of an `itemCount` number. The implementer must ensure `itemCount` is still destructured (or omitted with `_itemCount`) in `notifyCartCreated` without a TypeScript unused-variable error. Use `const { accountId, sessionUlid, guestCartId, cartTotalCents, items } = input;` and simply do not destructure `itemCount` if it's not used in the block builder. TypeScript will not error on unused object properties during destructuring (only unused variables).

### LOW: Empty items array defensive behavior

The `buildCartCreatedBlocks` and `buildCheckoutLinkBlocks` helpers should handle an empty `items` array gracefully. When `items` is empty, `items.map(...).join("\n")` returns `""`, and the items section text becomes `"\n*Total: $0.00*"` (leading newline). Add a guard: if `items.length === 0`, use `"*Total: ${this.formatCentsAsUsd(cartTotalCents)}*"` without a preceding bullet list. This situation should not occur in production (the `itemCount > 0` gate in `PreviewCartTool` prevents a cart_created alert with no items, and `GenerateCheckoutLinkTool` requires a prior `preview_cart` with at least 1 item), but defensiveness is appropriate.

---

## Out-of-Scope Confirmations

Per the brief, the following are explicitly NOT implemented:
- Customer PII (first name, last name, email, phone) — zero occurrence in all new code
- `conversation_started` alert changes — byte-for-byte unchanged
- Customer ID in alerts — `guestCartId` (cart ULID) is the sole operator-lookup path
- ID prefixes (`A#`, `G#`, `S#`, `C#`) — all alert IDs are raw ULIDs
- New alert types — no new events
- Slack interactive features — no slash commands, modals, or threading
- Item-level discounts or `compare_price` display — name + quantity + subtotal only
- `lookup_knowledge_base` retrieval or agent prompt changes — unrelated concern
- New DDB reads that are business-logic-critical — the cart record read in `GenerateCheckoutLinkTool` is alert-path-only and non-fatal

---

## Implementation Recommendations

1. **Resolve the `GenerateCheckoutLinkTool` items data question with the user before dispatching `code-implementer`.** Option B (one new GetCommand) is the only path that delivers the full locked contract. The brief's assumption that the cart is "already in memory" is incorrect based on code inspection.

2. **In `buildCartCreatedBlocks`, remove `itemCount` from the block.** The items list makes the count redundant. Update the block to 6 fields (Account/Session/CartID) instead of 8. The type still carries `itemCount` for the call-site API but the block builder does not render it.

3. **Use `escapeSlackMrkdwn` consistently** — apply it only to `item.name`, not to IDs (ULIDs contain no Slack control characters). IDs passed to `plain_text` fields never need escaping.

4. **Preserve existing spec patterns** — the spec uses `jest.clearAllMocks()` in `beforeEach` and restores spies in `afterEach`. New test groups should follow the same `buildModule(WEBHOOK_URL)` + `module.get<SlackAlertService>()` pattern as existing groups.

5. **Do not scatter `(cents / 100).toFixed(2)` expressions.** The refactor from inline to `this.formatCentsAsUsd()` must be complete — the reviewer explicitly checks for scattered currency expressions.

6. **The `cart_id` from METADATA is already the raw ULID** (no prefix stripping needed in `GenerateCheckoutLinkTool`). The METADATA record stores the raw ULID, not the prefixed SK. Confirmed at `preview-cart.tool.ts` line 470: `":cart_id": cartUlid` (raw ULID, no prefix).
