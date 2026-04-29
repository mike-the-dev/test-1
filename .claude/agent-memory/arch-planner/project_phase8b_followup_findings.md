---
name: Phase 8b-followup alert enrichment — codebase findings
description: Key findings from inspecting PreviewCartTool, GenerateCheckoutLinkTool, and SlackAlertService for the Phase 8b-followup cart-details enrichment task
type: project
---

Key findings from the Phase 8b-followup arch-planning pass:

**GenerateCheckoutLinkTool does NOT load cart items.** The brief's assumption that "the tool already loads the cart to generate the URL" is wrong. The tool reads only the METADATA record (cart_id, guest_id, customer_id, customer_email). The actual cart_items array lives on the cart record at PK=A#<accountUlid>, SK=G#<guestUlid>C#<cartUlid>. A new GetCommand is required to fetch cart items for the Slack alert.

**Why:** The locked contract requires items on notifyCheckoutLinkGenerated. The brief assumed in-memory availability that doesn't exist.

**How to apply:** In future tasks touching GenerateCheckoutLinkTool, know that it only reads METADATA in Step 3; it does not read the cart record at all. If cart item data is needed, a separate GetCommand is required.

---

**GuestCartItem.price and .total are in cents.** Confirmed by type comment (`// cents`) and spec fixture (`price: 10000` = $100.00). The cart_total passed to notifyCartCreated is already in cents (no multiply-by-100 needed). The comment at line 514 of preview-cart.tool.ts explicitly says so.

---

**guestCartId = cartUlid (raw, no prefix).** METADATA stores `cart_id` as the raw 26-char ULID (no G# or C# prefix). The SK of the cart record is G#<guestUlid>C#<cartUlid> but the individual cart ID exposed in the alert is just cartUlid.

---

**Existing buildCheckoutLinkBlocks uses section+mrkdwn link, not actions block.** The Phase 8b plan originally proposed an actions block with a URL button, but the actual implementation uses a section block with `<url|label>` mrkdwn syntax. This avoids Slack interactive callback issues.

---

**Slack mrkdwn escaping rules:** Only &, <, > need escaping (&amp;, &lt;, &gt;). The * and _ characters render as bold/italic but do not break rendering and are low-risk in pet-services catalog data. No native bullet-list syntax — use • character + \n line breaks inside a single section block text field.

**Section block text limit:** 3000 chars. Max 20 items × ~76 chars each = ~1520 chars — safely within limit.
