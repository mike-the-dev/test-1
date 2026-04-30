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
  latest_session_id: string | null;
  _createdAt_: string;
  _lastUpdated_: string;
}

export type GuestCartCheckoutBaseResolved = { isError: false; base: string };
export type GuestCartCheckoutBaseError = { isError: true; error: string };
export type GuestCartCheckoutBaseResult = GuestCartCheckoutBaseResolved | GuestCartCheckoutBaseError;

export type GuestCartCustomerResolved = { isError: false; customerUlid: string };
export type GuestCartCustomerError = { isError: true; error: string };
export type GuestCartCustomerResult = GuestCartCustomerResolved | GuestCartCustomerError;
