# Feature Spec: Cart Checkout Form

## 1) Goal / Outcome
- Allow shoppers to review their cart and submit a payment to complete a purchase.

## 2) Scope (In / Out)
### In Scope
- Checkout form with customer details and payment method selection.
- Server-side order creation and payment intent initiation.
- Client-side validation with inline errors.
- Success and failure states on submit.

### Out of Scope
- Account creation or saved payment methods.
- Promotional codes and discounts.
- Refunds or post-purchase order edits.

## 3) User Stories
- As a shopper, I want to see my cart total and taxes so that I can confirm the amount before paying.
- As a shopper, I want to enter my contact and shipping details so that my order can be fulfilled.
- As a shopper, I want to submit payment securely so that I can complete my purchase.

## 4) Acceptance Criteria (Must Pass)
- Cart items, subtotal, tax, and total are displayed before payment.
- Required fields block submission with inline error messages.
- A payment intent is created on submit and the UI reflects success or failure.
- Successful checkout redirects to an order confirmation page.

## 5) UX / UI Notes
- Layout: two-column on desktop (form left, order summary right), single-column on mobile.
- Inline validation under fields; submit button disabled while submitting.
- Success state shows order number and estimated delivery window.

## 6) Data / API Contracts
### Frontend Inputs
- Cart items: `[{ id: string, name: string, priceCents: number, quantity: number }]`
- Customer fields: `email`, `fullName`, `phone`
- Shipping fields: `address1`, `address2`, `city`, `state`, `postalCode`, `country`
- Payment method: `card` only (for v1)

### Backend Inputs
- `POST /api/checkout`
  - Body:
    - `cartItems`: array of item ids and quantities
    - `customer`: contact + shipping fields
    - `paymentMethod`: `card`
  - Response:
    - `orderId`: string
    - `clientSecret`: string (payment intent)

### Validation Rules
- Email must be valid and required.
- Phone required, 10-15 digits.
- Shipping fields required except `address2`.
- Cart must have at least 1 item.

## 7) Permissions / Auth
- Public endpoint; no login required.

## 8) Error Handling
- If payment intent fails, show "Payment failed. Try again."
- If cart is empty, show "Your cart is empty."
- Backend returns `400` for validation errors and `500` for unexpected errors.

## 9) Analytics / Logging (if required)
- Event: `checkout_started` with cart total and item count.
- Event: `checkout_completed` with orderId and total.

## 10) Tests Required
- Unit: form validation rules and submit disabled state.
- Integration: successful checkout flow with mocked payment intent.

## 11) Migration / Backfill (if needed)
- None.

## 12) Dependencies / External Services
- Payments provider (Stripe) for payment intent.
- Env vars: `STRIPE_SECRET_KEY`, `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`.

## 13) Edge Cases / Constraints
- Cart item price changes between view and submit.
- Network timeout during payment intent creation.

## 14) Delivery Notes
- Rollout behind `CHECKOUT_V1` feature flag.
- Backend must be deployed before frontend integration.
