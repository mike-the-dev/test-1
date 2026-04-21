/**
 * Shared contract between the `preview_cart` tool and the frontend cart-card
 * renderer. Field names mirror `GuestCartItem` where equivalent so that mapping
 * is 1-to-1. Note that `line_id` is generated fresh on every call to
 * `preview_cart` — it is a preview-time-only identifier used to key React list
 * rendering and is NOT persisted to the cart record in DynamoDB. The frontend
 * must NOT cache items by `line_id` across separate previews; use `service_id`
 * + `variant` if stable identity across calls is needed.
 */

export interface CartPreviewLine {
  line_id: string;
  service_id: string;
  name: string;
  category: string;
  image_url: string;
  variant: string | null;
  variant_label: string | null;
  quantity: number;
  price: number;
  total: number;
}

export interface CartPreviewPayload {
  cart_id: string;
  item_count: number;
  currency: string;
  cart_total: number;
  lines: CartPreviewLine[];
}
