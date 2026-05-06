export interface GuestCartItem {
  category: string;
  image_url: string;
  name: string;
  price: number; // cents
  quantity: number;
  service_id: string; // includes "S#" prefix
  total: number; // price * quantity, cents
  variant: string | null; // "<variantId>:<optionId>" or null
  variant_label: string | null; // option.value or null
}

export interface GuestCartRecord {
  PK: string; // "A#<accountUlid>"
  SK: string; // "G#<guestUlid>C#<cartUlid>"
  customer_id: string; // "C#<customerUlid>" (PREFIXED)
  email: string;
  cart_items: GuestCartItem[];
  _createdAt_: string;
  _lastUpdated_: string;
  // NO entity field — intentional to match real sample
}

export interface GuestCartCustomerRecord {
  PK: string; // "C#<customerUlid>"
  SK: string; // "C#<customerUlid>"
  entity: "CUSTOMER";
  "GSI1-PK": string; // "ACCOUNT#<accountUlid>"
  "GSI1-SK": string; // "EMAIL#<email>"
  "GSI2-PK"?: string; // "ACCOUNT#<accountUlid>" — set only when phone is non-null
  "GSI2-SK"?: string; // "PHONE#<E.164phone>" — set only when phone is non-null
  email: string;
  first_name: string;
  last_name: string;
  phone: string | null;
  billing_address: null;
  is_email_subscribed: boolean;
  abandoned_carts: string[];
  total_abandoned_carts: number;
  total_orders: number;
  total_spent: number;
  latest_session_id: string | null; // "CHAT_SESSION#<sessionUlid>" or null
  _createdAt_: string;
  _lastUpdated_: string;
}

export type GuestCartCheckoutBaseResolved = { isError: false; base: string };
export type GuestCartCheckoutBaseError = { isError: true; error: string };
export type GuestCartCheckoutBaseResult = GuestCartCheckoutBaseResolved | GuestCartCheckoutBaseError;

export type GuestCartCustomerResolved = { isError: false; customerUlid: string };
export type GuestCartCustomerError = { isError: true; error: string };
export type GuestCartCustomerResult = GuestCartCustomerResolved | GuestCartCustomerError;

/** Result from CustomerService.lookupOrCreateCustomer — success includes bare customerUlid and created flag. */
export type GuestCartLookupOrCreateResolved = { isError: false; customerUlid: string; created: boolean };
/** Error result from CustomerService.lookupOrCreateCustomer — error string is generic (no PII). */
export type GuestCartLookupOrCreateError = { isError: true; error: string };
export type GuestCartLookupOrCreateResult = GuestCartLookupOrCreateResolved | GuestCartLookupOrCreateError;

export type GuestCartCheckActiveCartHit = {
  has_cart: true;
  items: {
    name: string;
    quantity: number;
    price: number;
    total: number;
    variant_label: string | null;
  }[];
  cart_total_cents: number;
  last_updated_at: string;
  was_link_generated_at: string | null;
};

export type GuestCartCheckActiveCartMiss = {
  has_cart: false;
};

export type GuestCartCheckActiveCartResult = GuestCartCheckActiveCartHit | GuestCartCheckActiveCartMiss;
