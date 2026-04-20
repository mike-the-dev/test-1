// Attribution records are the source of truth for AI-driven revenue. They are
// written into the shared conversations table by the ecommerce backend's Stripe
// webhook handler whenever a completed payment carries `ai_session_id` in its
// Stripe metadata. This service does not write these records — it only defines
// their shape and will query them later for analytics dashboards.
//
// Attribution model is strict last-touch: a record exists if and only if a
// completed payment carried the ai_session_id end-to-end (checkout URL →
// Stripe Checkout Session metadata → payment webhook). No AI-influenced
// tracking is captured in v1.
//
// Key patterns:
//   Primary (session-scoped):  PK=CHAT_SESSION#<ulid>, SK=ATTRIBUTION#<paymentIntentId>
//   Pointer (account-scoped):  PK=A#<ulid>,            SK=ATTRIBUTION#<iso>#<paymentIntentId>
//
// Reserved namespaces for future extensions (do not collide):
//   ATTRIBUTION_EVENT#<stage>#<ts>       — funnel-stage events (deferred)
//   ATTRIBUTION_INFLUENCED#<orderId>     — AI-influenced secondary attribution (deferred)

export interface AttributionRecord {
  PK: string;
  SK: string;
  entity: "ATTRIBUTION";

  session_id: string;
  account_id: string;
  agent_name: string;

  stripe_payment_intent_id: string;
  stripe_checkout_session_id: string;
  order_id: string;
  cart_id: string;

  amount_cents: number;
  currency: string;
  status: "paid" | "refunded";

  _createdAt_: string;
}

export interface AttributionPointerRecord {
  PK: string;
  SK: string;
  entity: "ATTRIBUTION_POINTER";

  session_id: string;
  stripe_payment_intent_id: string;
  amount_cents: number;
  currency: string;

  _createdAt_: string;
}
