TASK OVERVIEW
Task name: Phase 8b-followup — Slack alert enrichment with cart details

Objective:
Enrich two of the three existing Slack business-signal alerts (cart_created, checkout_link_generated) with the guest cart ID and a per-item breakdown so the team has actionable business context without leaving the channel. The conversation_started alert is intentionally NOT changed — pre-onboarding there is nothing meaningful to add. **Zero customer PII enters Slack under any circumstance** — no first name, no last name, no email, no phone. The system uses raw IDs throughout and trusts authorized operators to look up the actual customer record in DDB when needed.

This sub-phase formalizes a strategic decision the user locked in during the design discussion: Slack is a chat tool, not a PII vault. We deliberately scoped Phase 8a's Sentry integration to scrub PII via `beforeSend`. Slack has no equivalent scrubber, so the answer is to never put PII in Slack in the first place. Cart items (catalog data — service names, quantities, prices) and system-generated identifiers (cart ID, session ID, account ID) are explicitly fine; customer-identifying fields are explicitly out.

When this phase is done:
- `SlackAlertService.notifyCartCreated` accepts `guestCartId` and `items` (line items) in addition to the existing fields.
- `SlackAlertService.notifyCheckoutLinkGenerated` accepts `guestCartId` and `items` in addition to the existing fields.
- The two enriched alerts render the new fields in the Slack message in the format shown below ("Locked Slack message format").
- `PreviewCartTool.execute()` passes `guestCartId` and `items` through to the alert from the cart preview response (already in scope at that call site).
- `GenerateCheckoutLinkTool.execute()` performs **one non-fatal DDB read** to fetch the cart record (which contains items + guestCartId) and threads them into the alert. The read is wrapped in a try/catch so a fetch failure can never break checkout URL generation — the alert simply degrades to showing IDs + URL without items if the fetch fails. The tool's existing metadata-only read is unchanged; this is a new, additive read scoped purely to enriching the alert payload.
- Existing tests still pass; new tests cover the two enriched method signatures, the Slack block JSON shape, and the per-call-site additions.
- Conversation_started alert is byte-for-byte unchanged.

Relevant context:
- The original Phase 8b alerts use a fire-and-forget pattern (`.catch(() => undefined)`) and never block business logic. The enrichment preserves this behavior — failure to render the new fields cleanly cannot break a customer's checkout flow.
- All IDs in the alerts are raw 26-char ULIDs without prefixes (`A#`, `G#`, `C#`, `S#`, etc.). This matches the existing Phase 8b convention where `accountId` is sent as the raw ULID. The arch-planner verifies this and the implementer follows it for the new `guestCartId` field too.
- The `lookup_knowledge_base` Phase 8b-followup is enrichment-only — no new alerts, no new event types, no new failure modes, no new dependencies. Just additional structured fields on the two existing celebration events.
- Customer-PII fields (first name, last name, email, phone) MAY exist in DDB at the moment cart_created or checkout_link_generated fire — they are explicitly NOT looked up and NOT included. The reasoning lives in this brief: Slack is not a PII-safe destination and we are choosing accountId/sessionUlid/guestCartId as the operator-lookup path instead.
- Per-item subtotal is the cart item's `quantity × unit_price`, expressed in dollars with two decimal places (cart total units are cents per the existing `GuestCart` contract — same as Phase 8b's `cartTotalCents` handling).

Key contracts (locked by the user before this brief — do not relitigate):

**`SlackAlertService` enriched API (final shape, locked):**

```typescript
type CartItemAlertEntry = {
  name: string;
  quantity: number;
  subtotalCents: number;
};

@Injectable()
class SlackAlertService {
  // notifyConversationStarted — UNCHANGED from Phase 8b
  async notifyConversationStarted(input: {
    accountId: string;
    sessionUlid: string;
    startedAt: Date;
  }): Promise<void>;

  // notifyCartCreated — EXTENDED with guestCartId and items
  async notifyCartCreated(input: {
    accountId: string;
    sessionUlid: string;
    guestCartId: string;
    cartTotalCents: number;
    itemCount: number;
    items: readonly CartItemAlertEntry[];
  }): Promise<void>;

  // notifyCheckoutLinkGenerated — EXTENDED with guestCartId and items
  async notifyCheckoutLinkGenerated(input: {
    accountId: string;
    sessionUlid: string;
    guestCartId: string;
    cartTotalCents: number;
    items: readonly CartItemAlertEntry[];
    checkoutUrl: string;
  }): Promise<void>;
}
```

All three methods retain the Phase 8b guarantees:
- Return `Promise<void>`. No useful return value.
- No-op silently when `SLACK_WEBHOOK_URL` is unset.
- Fire-and-forget: catch any Slack/network failure internally, capture to Sentry with the existing `tags: { category: "slack", alert_type: "..." }` shape, never re-throw.

**Locked Slack message format for `cart_created`:**

```
🛒 Cart created by AI agent
Account: <accountId>
Session: <sessionUlid>
Cart: <guestCartId>
Items:
  • <quantity>× <name> — $<subtotal in dollars, 2 decimal places>
  • <quantity>× <name> — $<subtotal in dollars, 2 decimal places>
  ...
Total: $<cartTotal in dollars, 2 decimal places>
```

**Locked Slack message format for `checkout_link_generated`:**

```
🔗 Checkout link generated
Account: <accountId>
Session: <sessionUlid>
Cart: <guestCartId>
Items:
  • <quantity>× <name> — $<subtotal in dollars, 2 decimal places>
  • <quantity>× <name> — $<subtotal in dollars, 2 decimal places>
  ...
Total: $<cartTotal in dollars, 2 decimal places>
[Open checkout button — clickable link to checkoutUrl]
```

The exact Slack `blocks` JSON (header block, section block with mrkdwn fields, items rendered as a markdown bullet list inside the section, action block with the checkout button for checkout_link_generated only) is finalized at planning time; the implementer pastes the resulting JSON verbatim. Header block emoji + title from Phase 8b stays the same.

**ID format (locked):**
- All IDs (`accountId`, `sessionUlid`, `guestCartId`) are raw 26-char Crockford ULIDs **without any prefix** (no `A#`, `G#`, `S#`). This matches the existing Phase 8b convention. The implementer strips any prefix before passing to the alert service if the source value carries one.

**Currency formatting (locked):**
- `cartTotalCents` and `subtotalCents` are integers in cents (per the existing `GuestCart` contract — Phase 8b documented this convention inline at `preview-cart.tool.ts`).
- Rendered to dollars with 2 decimal places: `$140.00`, not `$140`, not `$140.0`. Use a single named formatter helper inside `SlackAlertService` (e.g., `formatCentsAsUsd`) — do NOT scatter `(cents / 100).toFixed(2)` across the codebase.

**No-op behavior (locked, unchanged from Phase 8b):**
- `SLACK_WEBHOOK_URL` empty/unset → all methods return immediately without any HTTP call.

**Failure-handling (locked, unchanged from Phase 8b):**
- HTTP failure: caught, captured to Sentry with `tags: { category: "slack", alert_type: "cart_created" | "checkout_link" }`, never re-thrown.

**Out of scope for this phase (do not add):**
- Customer PII in any alert (first name, last name, email, phone, etc.) — explicitly excluded after the design discussion.
- Conversation_started alert changes — pre-onboarding there is nothing meaningful to add.
- Customer ID (separate from cart ID) — the `guestCartId` provides the operator-lookup path; the user explicitly chose not to add a redundant customer reference in the alert.
- Prefix on IDs (`A#`, `G#`, `S#`, `C#`) — raw ULIDs only.
- Slack interactive features beyond the existing checkout button (slash commands, threading, replies, modals) — would require a Slack bot user; defer.
- Item-level discount or `compare_price` display — just name + quantity + subtotal for v1; richer item rendering is a future iteration.
- New alert types (lead-captured, conversation-ended, cart-abandoned, etc.) — out of scope; only the two existing alerts get enriched.
- Customer-PII lookups (name/email/phone) at any alert call site — the new DDB read in `GenerateCheckoutLinkTool` is scoped to the cart record only (items + guestCartId), never to the customer record. No PII enrichment under any circumstance.
- Any change to the `lookup_knowledge_base` retrieval system or the agent prompts — entirely separate concern from this enrichment.


STEP 1 — ARCHITECTURE PLANNING
Use the arch-planner agent to analyze the codebase and produce a structured implementation plan.

Task specifics for this plan:

1. Read this brief in full. Read `docs/knowledge-base/tasks/phase-8b-slack-business-alerts.md` and `docs/knowledge-base/tasks/phase-8b-slack-business-alerts-plan.md` to understand the existing Slack integration. Read `docs/knowledge-base/HANDOFF.md` for the orchestration contract.

2. Study the existing patterns the new code must mirror or extend:
   - `src/services/slack-alert.service.ts` — existing `SlackAlertService` with three `notify*` methods. The two methods being extended already exist; you're adding fields to their input types and updating their block-builder helpers.
   - `src/services/slack-alert.service.spec.ts` — existing spec coverage. Update existing tests for the changed method signatures; add new tests for the items rendering, the cart ID rendering, and the currency formatting helper.
   - `src/tools/preview-cart.tool.ts` — `PreviewCartTool.execute()` is the call site for `cart_created`. Inspect what's available in scope today (cart preview response shape) to confirm `guestCartId` and the items are already accessible there. Document the exact field names being passed through.
   - `src/tools/generate-checkout-link.tool.ts` — `GenerateCheckoutLinkTool.execute()` is the call site for `checkout_link_generated`. Inspect what's available in scope (the tool already loads the cart to generate the URL — confirm and document where in the existing flow the cart data is in memory). Recommend the exact mechanism for threading `guestCartId` and `items` through to the alert WITHOUT adding a new DDB read.
   - The cart record DDB shape — to confirm field names for `guestCartId` and the items.

3. Verify the Slack block JSON contract for the new structure:
   - Confirm Slack mrkdwn supports the bullet-list format (`• ` followed by item) inside a section block's `text` field, or whether items should be a separate fields array.
   - Decide between a single section block with a multi-line mrkdwn body vs. multiple section blocks vs. fields array. Pick whichever renders cleanest in the actual Slack channel.
   - Source: Slack Block Kit documentation (`https://api.slack.com/block-kit`).

4. Produce a detailed implementation plan covering ALL of these sections:
   - **Overview** — one paragraph.
   - **Affected files / modules** — comprehensive list with one-line note per file.
   - **Slack block JSON design** — exact JSON for both `cart_created` and `checkout_link_generated` enriched messages. The implementer pastes verbatim. Cover: header block, section block(s) with mrkdwn body containing the IDs + items list + total, and the action block with the checkout button (checkout_link_generated only).
   - **`SlackAlertService` design changes** — exact updated method signatures, exact block-builder helper updates, exact `formatCentsAsUsd` helper shape and location (private method on the service, or unexported helper at module scope — pick the cleaner option for testability).
   - **`PreviewCartTool` changes** — exact code snippet showing how `guestCartId` and `items` are extracted from the existing cart preview response and passed to `notifyCartCreated`.
   - **`GenerateCheckoutLinkTool` changes** — exact code snippet showing how the cart data already loaded by the tool is threaded into the alert call without a new DDB read.
   - **Step-by-step implementation order** — file-by-file.
   - **Testing strategy:**
     - `SlackAlertService` spec extension: update existing `notifyCartCreated` and `notifyCheckoutLinkGenerated` tests for the new signatures; add tests for the items rendering with multiple line items, single line item, and edge cases (long item names, very small or very large totals); add a focused test for `formatCentsAsUsd` covering 0, 100, 1234, 100000 (= $1,000.00).
     - `PreviewCartTool` spec: update the existing alert-fired test to assert the new `guestCartId` and `items` fields are passed.
     - `GenerateCheckoutLinkTool` spec: update similarly. Verify NO new DDB read is introduced by checking the test's mock call counts.
     - The conversation_started alert tests stay byte-for-byte unchanged.
   - **Risks and edge cases:**
     - Slack message length limit (4000 chars per block mrkdwn) — flag if a hypothetical large cart could exceed this; recommend a truncation approach or a "show first N items" approach if so.
     - Item names with Slack-special characters (`*`, `_`, `<`, `>`) need to be escaped for mrkdwn rendering. Recommend the escape approach.
     - Empty items array — should never happen at cart_created (existing `itemCount > 0` gate prevents) or checkout_link_generated, but document the defensive behavior anyway.
     - `cartTotalCents` and `subtotalCents` integer overflow — not a real concern at any reasonable scale, but worth noting the assumption.
   - **Out-of-scope confirmations.**

5. Write your plan to `docs/knowledge-base/tasks/phase-8b-followup-alert-enrichment-plan.md`.

6. Return a concise summary (under 600 words) including:
   - Path to the plan file
   - 5–7 key decisions or clarifications you made — particularly around (a) the exact Slack block JSON layout for the items list, (b) the mechanism for threading `guestCartId` and `items` through the checkout-link tool without adding a DDB read, (c) the location and shape of the `formatCentsAsUsd` helper, (d) Slack mrkdwn escape behavior for item names with special characters
   - Any risks, unknowns, or "needs orchestrator decision" items the user should resolve before approval

Hard rules for this agent:
- DO NOT commit. DO NOT push. DO NOT run any `git` write command.
- DO NOT read `.env`, `.env.local`, or any `.env.*` file. Only `.env.example` if it exists.
- Pause after producing the plan so the orchestrator can get user approval before Step 2.


STEP 2 — IMPLEMENTATION
Use the code-implementer agent to implement the approved plan.

Implementation details for this task:
- Update `SlackAlertService` method signatures and block-builder helpers per the plan exactly.
- Add the `formatCentsAsUsd` helper as the plan specifies.
- Update both call sites (`PreviewCartTool.execute()` and `GenerateCheckoutLinkTool.execute()`) to thread the new fields through.
- Update the affected test files per the plan.
- Run `npm run build` and `npm test` before returning.

Implementation requirements:
- follow the plan produced by the arch-planner agent
- modify or create only the necessary files
- respect existing architecture and coding patterns
- focus on correctness first (style will be handled later)

Hard rules for this agent:
- DO NOT commit. DO NOT push. DO NOT run any `git` write command.
- DO NOT read `.env`, `.env.local`, or any `.env.*` file. Only `.env.example` if it exists.


STEP 3 — STYLE REFACTOR
Use the style-refactor agent to refactor the implementation according to the rules defined in `.claude/instructions/style-enforcer.md`.

Style refactor specifics:
- The new helper (`formatCentsAsUsd`) is a small pure function — keep it terse, well-named, free of side effects.
- Block-building helpers stay private to the file (no exports beyond what already exists).
- Slack message format stays exactly as specified in the brief (do not "simplify" the visual layout).
- TypeScript naming follows existing project conventions (camelCase for variables, no inline type annotations TypeScript can infer).
- No `any`, no dead code, no placeholder comments, no comments explaining WHAT the code does.
- Do NOT undo any change made by the implementer that resolves a reviewer-flagged style finding (consistent with prior phase lessons).

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
- Run `npm test`. Baseline before this phase: 482 tests. Estimated new total: ~492–498 (additional `SlackAlertService` cases for items rendering and currency formatting; updated assertions in two tool specs; possibly 1–2 new edge-case tests).
- Mock all external services (Slack webhook via `fetch`, Sentry, DDB).

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
- **NO customer PII in any alert payload.** Search every block-builder helper, every `notify*` call site, every test fixture. Confirm absence of: first name, last name, email, phone, contact-info field names. The `lookup` of contact info from DDB at the alert call site is explicitly forbidden — verify no such lookup was added.
- **All IDs are raw ULIDs without prefix.** Search the block-builder helpers and the call sites. Confirm `guestCartId`, `accountId`, `sessionUlid` all render without `A#`, `G#`, `S#`, `C#` prefixes. If the source value carries a prefix, confirm the implementer strips it before passing to the alert.
- **Currency formatting uses the named helper** (`formatCentsAsUsd` or whatever name the plan specified). Confirm no scattered `(cents / 100).toFixed(2)` expressions outside the helper.
- **`GenerateCheckoutLinkTool`'s new DDB read is non-fatal.** Verify the new cart-record fetch is wrapped in a try/catch that logs the failure but never re-throws or interrupts checkout URL generation. The catch path must allow the alert to still fire (degraded — IDs + URL without items, total $0.00) without blocking the user-facing return value of the tool.
- **Conversation_started alert is byte-for-byte unchanged.** Diff against the prior commit; confirm no incidental changes.
- **Fire-and-forget guarantee preserved.** Slack failures still never propagate back into the calling tool. Test fixtures still verify this.
- **No-op behavior preserved.** `SLACK_WEBHOOK_URL` unset → no HTTP call attempted.
- **Sentry forwarding correct.** Slack failures still captured with the existing `tags: { category: "slack", alert_type: "..." }` shape.
- **Slack block JSON renders correctly.** Trace the block-builder output for both `cart_created` and `checkout_link_generated` with a representative items list. Confirm the bullet-list format renders as expected in Slack mrkdwn (escaped item names, line breaks, etc.).
- **Out-of-scope respected** — no customer PII, no customer ID, no prefixes, no new alert types, no new DDB reads, no Slack interactive features, no item-level discount display, no `lookup_knowledge_base` changes, no agent prompt changes.

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
